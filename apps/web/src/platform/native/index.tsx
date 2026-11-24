import type { ReactNode } from "react";
import { focusManager } from "@tanstack/react-query";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Device } from "@capacitor/device";
import { CapacitorUpdater } from "@capgo/capacitor-updater";
import type { BundleInfo } from "@capgo/capacitor-updater";
import { APPS_RELEASE_MANIFEST } from "@purss/domain";
import { plainVersion } from "@purss/domain/version";
import { CapacitorShareTarget } from "@capgo/capacitor-share-target";
import { AudioPlayer } from "@mediagrid/capacitor-native-audio";
import { parseWidgetSnapshot } from "../../device/widget.ts";
import { browserPage } from "../browser-page.ts";
import { startConnectedApp } from "../connected-app.ts";
import type { ConnectedShell, ShellPlatform } from "../connected-app.ts";
import { purssPolicy } from "../csp.ts";
import { readOpenLink } from "../open-link.ts";
import { browserNotifier } from "../web.ts";
import type { Platform } from "../types.ts";
import { AppPlayerBackend } from "./audio-backend.ts";
import { goUpOneLevel, pressEscape } from "./back-button.ts";
import type { Connection } from "./connect.ts";
import { ConnectScreen } from "./ConnectScreen.tsx";
import type { ConnectShell } from "./ConnectScreen.tsx";
import { forgetConnection, readConnection, saveConnection } from "./connection-store.ts";
import { deviceConnection, deviceFiles, shareFile } from "./files.ts";
import { devicePush, pushSetup } from "./push-device.ts";
import { PurssDevice } from "./device-plugin.ts";
import { nativePasskeys } from "./passkeys.ts";
import { BUILTIN } from "./live-update.ts";
import type { BundleRef, Updater } from "./live-update.ts";
import { createAppUpdates, manifestVersion, sourceOf } from "./app-updates.ts";
import { localKv } from "./app-start.ts";
import { app } from "@purss/translations/app";

const t = app.platform.native;

/**
 * The Android and iOS apps' shell for connected-app.ts. The interface is the web app's own build, bundled in
 * the app; it talks to the connected PURSS with the device token from secure storage. Offline
 * copies are kept by the same OfflineServiceWorker the web's service worker runs, here in the page, in
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
      return name.trim().slice(0, 80) || t.deviceName;
    } catch { return t.deviceName; }
  },
  save: saveConnection,
  passkeys: nativePasskeys,
  browserSignin: t.browserSignin,
};

/** A bundle as the plugin reports it, or null for its empty answers. */
const ref = (b: BundleInfo | null | undefined): BundleRef | null => (b && typeof b.id === "string" && b.id ? { id: b.id, version: b.version } : null);

/**
 * The updater plugin. Its own "next bundle" isn't used: the plugin installs that whenever the app goes to
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

/** The installed app's version, as its store build says; null for a build without one. */
async function installedVersion(): Promise<string | null> {
  try { return plainVersion((await App.getInfo()).version); } catch { return null; }
}

/**
 * New versions of the app itself (app-updates.ts). The releases are read through Capacitor's native HTTP: the page's
 * own policy allows only the connected PURSS and the push relay.
 */
const appUpdates = createAppUpdates({
  async source() {
    const platform = Capacitor.getPlatform();
    if (platform !== "android") return sourceOf({ platform });
    try { return sourceOf({ platform, ...(await PurssDevice.installSource()) }); } catch { return null; }
  },
  installed: installedVersion,
  async latest() {
    const res = await CapacitorHttp.get({ url: APPS_RELEASE_MANIFEST, responseType: "text", connectTimeout: 15_000, readTimeout: 15_000 });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return manifestVersion(typeof res.data === "string" ? JSON.parse(res.data) : res.data);
  },
  store: localKv,
  now: () => Date.now(),
});

/** What the phone adds to the platform; `phone` is where this PURSS's notifications arrive, null while the app isn't connected. */
function phonePlatform(conn: Connection | null, phone: ReturnType<typeof devicePush> | null): ShellPlatform {
  return {
    createPlayerBackend: () => new AppPlayerBackend(),
    passkeys: conn?.passkeys ? nativePasskeys : null,
    saveFile: shareFile,
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
      refresh() {
        void PurssDevice.refreshWidgets().catch(() => undefined);
      },
    } : null,
    push: phone?.push ?? null,
    appUpdates: conn ? appUpdates : null,
    // The phones show notifications through the relay; Settings doesn't offer alerts there.
    notifier: browserNotifier,
    // On Android the count goes on PURSS's notifications, the only badge launchers draw; on iOS on the icon itself.
    badge: conn ? (count) => { void PurssDevice.setBadge({ count }).catch(() => undefined); } : null,
    onIntake: () => () => {},
    desktop: null,
    webView: null,
    frames: false,
    appVersion: installedVersion,
    onConnectReturn(listener) {
      const handle = App.addListener("appUrlOpen", (e) => { if (/^purss:\/\/connect\b/i.test(e.url)) listener(e.url); });
      return () => { void handle.then((h) => h.remove()); };
    },
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

const phoneShell: ConnectedShell = {
  device: "phone",
  // This interface started: the updater plugin keeps it instead of rolling back to the previous one.
  interfaceStarted() { void CapacitorUpdater.notifyAppReady().catch(() => undefined); },
  updater,
  storage: { read: readConnection, forget: forgetConnection },
  // Links to other sites open in the system browser (an in-app browser tab).
  openExternal(url) { void Browser.open({ url }); },
  listen() {
    // The app going to the background and coming back is the page losing and regaining focus, so what is open refreshes then.
    void App.addListener("pause", () => focusManager.setFocused(false));
    void App.addListener("resume", () => focusManager.setFocused(true));
    void App.addListener("backButton", ({ canGoBack }) => {
      goUpOneLevel({ escape: pressEscape, canGoBack, previousPage: () => history.back(), leave: () => void App.minimizeApp() });
    });
  },
  async attach(conn) {
    if (!conn) return { platform: phonePlatform(null, null), connected: null };
    const pushConfig = await pushSetup();
    const phone = devicePush(conn.origin, pushConfig);
    return {
      platform: phonePlatform(conn, phone),
      connected: {
        conn,
        // The push relay is the only other origin the page calls.
        policy: purssPolicy(conn.origin, [pushConfig.relay]),
        downloads: {
          files: deviceFiles,
          connection: deviceConnection,
          // The background job needs the same server the token belongs to; it reads the token itself.
          mirror: (state) => { void PurssDevice.setBackground({ state: state ? JSON.stringify({ ...state, origin: conn.origin }) : null }).catch(() => undefined); },
        },
        appCheck: () => { void appUpdates.check(); },
        refusedWhileClosed: async () => (await PurssDevice.takeBackgroundReport()).lost,
        forget: {
          stopAudio: () => AudioPlayer.destroy({ audioId: "purss-player" }),
          stopBackground: () => PurssDevice.reset(),
          forgetPush: async () => { await phone.forget(); },
          finish: () => undefined,
        },
      },
    };
  },
  firstScreen: (notice): ReactNode => <ConnectScreen notice={notice} shell={phoneConnectShell} />,
};

export function startNative(): Promise<{ platform: Platform; screen: ReactNode | null }> {
  return startConnectedApp(phoneShell, browserPage);
}
