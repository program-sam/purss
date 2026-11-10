import type { ReactNode } from "react";
import { focusManager } from "@tanstack/react-query";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Device } from "@capacitor/device";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import type { BundleInfo } from "@capgo/capacitor-updater";
import { OFFICIAL_WORKSPACE_ORIGIN, startingServer } from "@purss/domain";
import { plainVersion } from "@purss/domain/version";
import { CapacitorShareTarget } from "@capgo/capacitor-share-target";
import { AudioPlayer } from "@mediagrid/capacitor-native-audio";
import { api } from "../../api/client.ts";
import { outbox } from "../../annotations/outbox-store.ts";
import { clearAnnotationOutbox } from "../../annotations/use-annotations.ts";
import { clearLateWrites } from "../../lib/late-writes.ts";
import { DownloadManager } from "../../downloads/manager.ts";
import { decodePage, readablePage } from "../../downloads/readable-page.ts";
import type { KeyValue } from "../../downloads/manager.ts";
import { parseWidgetSnapshot } from "../../device/widget.ts";
import { wipeOfflineCopies } from "../../offline/worker-link.ts";
import { clearHints } from "../../state/ui-store.ts";
import { OfflineWorker } from "../../sw/offline-worker.ts";
import { IndexedDbCopyBackend, StoredCaches } from "../copies.ts";
import { workspacePolicy } from "../csp.ts";
import { readOpenLink } from "../open-link.ts";
import { browserNotifier } from "../web.ts";
import type { AppConnection, OfflineHost, Platform, Transport } from "../types.ts";
import { AppPlayerBackend } from "./audio-backend.ts";
import type { Connection } from "./connect.ts";
import { ConnectScreen } from "./ConnectScreen.tsx";
import type { ConnectShell } from "./ConnectScreen.tsx";
import { forgetConnection, readConnection, saveConnection } from "./connection-store.ts";
import { deviceConnection, deviceFiles } from "./files.ts";
import { forgetDevice } from "./forget.ts";
import { devicePush, pushSetup } from "./push-device.ts";
import type { PushSetup } from "./push-device.ts";
import type { ForgetReason } from "./forget.ts";
import { PurssDevice } from "./device-plugin.ts";
import { createAppTransport } from "./transport.ts";
import { shareFile } from "./files.ts";
import { nativePasskeys } from "./passkeys.ts";
import { BUILTIN, createInterfaceUpdates, forgetQueued, removeDownloads, startQueued } from "./live-update.ts";
import type { BundleRef, Updater } from "./live-update.ts";
import { leaveNotice, localKv, sendLinksOut, takeNotice, takeStuck, timeout } from "./app-start.ts";

/**
 * The Android and iOS apps' platform (plan/31). The interface is the web app's own build, bundled in
 * the app; it talks to the connected PURSS with the device token from secure storage. Offline
 * copies are kept by the same OfflineWorker the web's service worker runs, here in the page, in
 * IndexedDB; downloads add the device copies ("Downloaded") on top.
 */

/** The first screen's parts that are the phone's own: Custom Tabs or SFSafariViewController, purss://connect, the phone's name and passkeys. */
const phoneConnectShell: ConnectShell = {
  openBrowser: async (url) => { await Browser.open({ url }); },
  closeBrowser: () => { void Browser.close().catch(() => undefined); },
  onCallback(listener) {
    const handle = App.addListener("appUrlOpen", (e) => listener(e.url));
    void App.getLaunchUrl().then((launch) => { if (launch?.url) listener(launch.url); }).catch(() => undefined);
    return () => { void handle.then((h) => h.remove()); };
  },
  async deviceName() {
    try {
      const d = await Device.getInfo();
      const name = d.platform === "android" ? [d.manufacturer.replace(/^./, (c) => c.toUpperCase()), d.model].join(" ") : d.name || d.model;
      return name.trim().slice(0, 80) || "Phone or tablet";
    } catch { return "Phone or tablet"; }
  },
  save: saveConnection,
  passkeys: nativePasskeys,
  browserSignin: { withPasskeys: "Sign in with a linked account (opens a sign-in tab)", withoutPasskeys: "Use fingerprint, face or a linked account (opens a sign-in tab)" },
};

/** A bundle as the plugin reports it, or null for its empty answers. */
const ref = (b: BundleInfo | null | undefined): BundleRef | null => (b && typeof b.id === "string" && b.id ? { id: b.id, version: b.version } : null);

/**
 * The updater plugin (plan/39). Its own "next bundle" isn't used: the plugin installs that whenever the app goes to
 * the background, which would stop the player. The page switches itself (live-update.ts).
 */
const updater: Updater = {
  builtinVersion: async () => (await CapacitorUpdater.getBuiltinVersion()).version,
  current: async () => ref((await CapacitorUpdater.current()).bundle) ?? { id: BUILTIN, version: "" },
  download: async (o) => ref(await CapacitorUpdater.download(o))!,
  downloaded: async () => (await CapacitorUpdater.list()).bundles.flatMap((b) => ref(b) ?? []),
  remove: async (id) => { await CapacitorUpdater.delete({ id }); },
  apply: (id) => (id === BUILTIN ? CapacitorUpdater.reset() : CapacitorUpdater.set({ id })),
  failed: async () => ref((await CapacitorUpdater.getFailedUpdate())?.bundle)?.version ?? null,
};

/** Back to the interface the app was installed with, at the first screen (the page reloads). */
function restartInstalled(): void {
  forgetQueued(localKv);
  try { history.replaceState(null, "", "/"); } catch { /* the plugin's reload starts at the root anyway */ }
  CapacitorUpdater.reset().catch(() => location.replace("/"));
}

function appPlatform(conn: Connection | null, pushConfig: PushSetup | null): Platform {
  const caches = new StoredCaches(new IndexedDbCopyBackend());
  const origin = conn?.origin ?? location.origin;
  const worker = new OfflineWorker({ caches, fetch: (r) => fetch(r), now: () => Date.now(), origin, build: "app" });

  const downloads = conn ? new DownloadManager({
    files: deviceFiles,
    get: (path, query, headers) => api(path, { query, headers }),
    plan: (request) => api("/api/downloads/plan", { method: "POST", body: request }),
    connection: deviceConnection,
    readPage: (page, url) => readablePage(decodePage(page), url),
    store: localKv,
    // The background job (plan/38) needs the same server the token belongs to; it reads the token itself.
    mirror: (state) => { void PurssDevice.setBackground({ state: state ? JSON.stringify({ ...state, origin }) : null }).catch(() => undefined); },
  }) : null;

  const phone = conn && pushConfig ? devicePush(conn.origin, pushConfig) : null;

  let player: AppPlayerBackend | null = null;
  const official = startingServer(null, OFFICIAL_WORKSPACE_ORIGIN);
  const updates = conn ? createInterfaceUpdates({
    origin: conn.origin,
    official: official.kind === "official" && official.origin === conn.origin,
    updater,
    fetch: (url, init) => fetch(url, init),
    playing: () => player?.state().playing ?? false,
    store: localKv,
    now: () => Date.now(),
  }) : null;
  if (updates) {
    void updates.check();
    let hiddenAt: number | null = null;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      void updates.shown(away);
    });
  }

  let ending = false;
  /** Remove what this app keeps for PURSS (see forget.ts), then start again at the first screen. */
  async function wipeAndRestart(reason: ForgetReason): Promise<void> {
    if (ending) return;
    ending = true;
    const { notice, stuck } = await forgetDevice({
      stopAudio: () => AudioPlayer.destroy({ audioId: "purss-player" }),
      forgetConnection,
      wipeCopies: wipeOfflineCopies,
      clearOutbox: async () => { clearLateWrites(); await clearAnnotationOutbox(); },
      removeDownloads: async () => { await downloads?.removeAll(); },
      stopBackground: () => PurssDevice.reset(),
      forgetPush: async () => { await phone?.forget(); },
      clearHints,
      unsent: async () => { await outbox.load(); return outbox.snapshot().length; },
    }, reason);
    leaveNotice(notice, stuck);
    // The next PURSS decides on its own interface (plan/39).
    restartInstalled();
  }

  const connection: AppConnection | null = conn ? {
    origin: conn.origin,
    async disconnect() {
      let told = true;
      try { await timeout(api("/api/connect/device", { method: "DELETE" }), 8000); } catch { told = false; }
      await wipeAndRestart(told ? "disconnected" : "unreachable");
    },
    lost() {
      void wipeAndRestart("lost");
    },
  } : null;

  const transport: Transport = conn
    ? createAppTransport({ origin, token: conn.token, worker, downloaded: (path) => downloads!.answer(path), fetch: (r) => fetch(r), onLost: () => connection?.lost() })
    : {
      fetch: async () => new Response(JSON.stringify({ error: { code: "device_signed_out", message: "Connect the app first." } }), { status: 401, headers: { "content-type": "application/json" } }),
      events: () => () => {},
    };

  const offline: OfflineHost = {
    supported: () => true,
    installed: () => true,
    start: async () => true,
    tell: async (message) => { await worker.message(message); return true; },
    whenControlled: async () => true,
    onUpdateReady: () => () => {},
    applyUpdate: () => location.reload(),
    caches: () => caches,
  };

  return {
    kind: "app",
    transport,
    offline,
    createPlayerBackend: () => (player = new AppPlayerBackend()),
    downloads,
    connection,
    passkeys: conn?.passkeys ? nativePasskeys : null,
    saveFile: shareFile,
    openExternal: (url) => { if (/^https?:\/\//i.test(url)) void Browser.open({ url }); },
    publicOrigin: () => origin,
    onShare(listener) {
      const handle = CapacitorShareTarget.addListener("shareReceived", (e) => listener({ title: e.title ?? "", texts: e.texts ?? [] }));
      return () => { void handle.then((h) => h.remove()); };
    },
    widget: conn ? {
      update(snapshot) {
        void PurssDevice.setWidget({ snapshot: JSON.stringify(snapshot) }).catch(() => undefined);
      },
      async current() {
        try { return parseWidgetSnapshot((await PurssDevice.getWidget()).snapshot); } catch { return null; }
      },
    } : null,
    push: phone?.push ?? null,
    interfaceUpdates: updates,
    // The phones show notifications through the relay (plan/37); Settings doesn't offer alerts there.
    notifier: browserNotifier,
    badge: null,
    onIntake: () => () => {},
    desktop: null,
    appVersion: async () => { try { return plainVersion((await App.getInfo()).version); } catch { return null; } },
    onOpen(listener) {
      const open = (url: unknown) => {
        if (typeof url !== "string") return;
        const target = readOpenLink(url);
        if (target) listener(target);
      };
      // A widget's tap and, on Android, a tapped notification open purss://open?…; on iOS a notification's tap
      // arrives through the push plugin with the link its extension put in it.
      const handle = App.addListener("appUrlOpen", (e) => open(e.url));
      const stopTaps = phone?.onTap(open);
      // A link that started the app: taken once per start, and not again when the page reloads.
      if (!launchTaken) {
        launchTaken = true;
        void App.getLaunchUrl().then((launch) => {
          if (!launch?.url || !readOpenLink(launch.url)) return;
          try { if (sessionStorage.getItem(LAUNCH_KEY) === launch.url) return; sessionStorage.setItem(LAUNCH_KEY, launch.url); } catch { /* opened anyway */ }
          open(launch.url);
        }).catch(() => undefined);
      }
      return () => { void handle.then((h) => h.remove()); stopTaps?.(); };
    },
  };
}

let launchTaken = false;
/** The launch link already opened, so reloading the page doesn't open the same item again. */
const LAUNCH_KEY = "purss:launch-opened";

/** Add the connected PURSS's policy to the page's own (both are enforced), before any request. The push relay is the only other origin it calls. */
function limitPageTo(origin: string, relay: string): void {
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = workspacePolicy(origin, [relay]);
  document.head.prepend(meta);
}

export async function startNative(): Promise<{ platform: Platform; screen: ReactNode | null }> {
  // This interface started: the updater plugin keeps it instead of rolling back to the previous one (plan/39).
  void CapacitorUpdater.notifyAppReady().catch(() => undefined);
  // A downloaded interface waiting for this start takes over before anything is shown; the page reloads into it.
  if (await startQueued(updater, localKv)) return new Promise(() => {});
  // Links to other sites open in the system browser (an in-app browser tab).
  sendLinksOut((url) => void Browser.open({ url }));
  // The app going to the background and coming back is the page losing and regaining focus, so what is open refreshes then.
  void App.addListener("pause", () => focusManager.setFocused(false));
  void App.addListener("resume", () => focusManager.setFocused(true));
  const stuck = takeStuck();
  // A connection that couldn't be removed is tried once more and never used: it would only be refused again.
  if (stuck) await forgetConnection().catch(() => undefined);
  const conn = stuck ? null : await readConnection();
  if (conn) {
    const pushConfig = await pushSetup();
    limitPageTo(conn.origin, pushConfig.relay);
    const platform = appPlatform(conn, pushConfig);
    // The background job found the token refused while the app was closed: the same as being told so now.
    void PurssDevice.takeBackgroundReport().then((r) => { if (r.lost) platform.connection?.lost(); }).catch(() => undefined);
    return { platform, screen: null };
  }
  void removeDownloads(updater).catch(() => undefined);
  const notice = takeNotice();
  return { platform: appPlatform(null, null), screen: <ConnectScreen notice={notice} shell={phoneConnectShell} /> };
}
