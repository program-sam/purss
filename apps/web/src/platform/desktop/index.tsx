import type { ReactNode } from "react";
import { desktopOffer } from "@purss/domain/app-bundle";
import { OFFICIAL_WORKSPACE_ORIGIN, startingServer } from "@purss/domain";
import { plainVersion } from "@purss/domain/version";
import { api } from "../../api/client.ts";
import { outbox } from "../../annotations/outbox-store.ts";
import { clearAnnotationOutbox } from "../../annotations/use-annotations.ts";
import { clearLateWrites } from "../../lib/late-writes.ts";
import { DownloadManager } from "../../downloads/manager.ts";
import { decodePage, readablePage } from "../../downloads/readable-page.ts";
import { wipeOfflineCopies } from "../../offline/worker-link.ts";
import { HtmlMediaBackend } from "../../player/html-backend.ts";
import { clearHints } from "../../state/ui-store.ts";
import { OfflineWorker } from "../../sw/offline-worker.ts";
import { IndexedDbCopyBackend, StoredCaches } from "../copies.ts";
import { workspacePolicy } from "../csp.ts";
import { readOpenLink } from "../open-link.ts";
import type { AppConnection, DesktopApp, DesktopUpdate, Intake, Notifier, OfflineHost, Platform, Transport } from "../types.ts";
import { leaveNotice, localKv, sendLinksOut, takeNotice, takeStuck, timeout } from "../native/app-start.ts";
import { parseConnection } from "../native/connect.ts";
import type { Connection } from "../native/connect.ts";
import { ConnectScreen } from "../native/ConnectScreen.tsx";
import type { ConnectShell } from "../native/ConnectScreen.tsx";
import { forgetDevice } from "../native/forget.ts";
import type { ForgetReason } from "../native/forget.ts";
import { BUILTIN, createInterfaceUpdates, forgetQueued, removeDownloads, startQueued } from "../native/live-update.ts";
import type { Updater } from "../native/live-update.ts";
import { createAppTransport } from "../native/transport.ts";
import { desktop } from "./bridge.ts";
import type { Incoming } from "./bridge.ts";
import { feedAddress } from "./feed-link.ts";
import { desktopConnection, desktopFiles } from "./files.ts";

/**
 * The desktop app's platform (plan/42): the phone apps' model in a Tauri shell. The interface is the web app's
 * build, embedded in the app or downloaded from the connected PURSS; it talks to that PURSS with the
 * device token from the system's credential store. The page keeps running while the window is hidden, so the
 * event stream, automatic downloads and notifications go on until the person quits from the tray.
 */

async function readConnection(): Promise<Connection | null> {
  try {
    const raw = await desktop.readConnection();
    return raw ? parseConnection(JSON.parse(raw)) : null;
  } catch { return null; }
}

async function saveConnection(c: Connection): Promise<void> {
  await desktop.saveConnection(JSON.stringify({ origin: c.origin, token: c.token }));
}

async function forgetConnection(): Promise<void> {
  await desktop.forgetConnection();
  if (await readConnection()) throw new Error("The connection is still in the credential store.");
}

/**
 * Everything handed to the app from outside (plan/42): purss://connect answers, purss://open links, feed links and
 * OPML files. Kept until someone listens for its kind, so what started the app reaches the screen that wants it.
 */
const incoming = (() => {
  const waiting: Incoming[] = [];
  const listeners = new Set<(i: Incoming) => boolean>();
  const deliver = (i: Incoming) => {
    for (const l of listeners) if (l(i)) return;
    waiting.push(i);
    if (waiting.length > 20) waiting.shift();
  };
  let started = false;
  return {
    start() {
      if (started) return;
      started = true;
      const take = () => { void desktop.takeIncoming().then((list) => list.forEach(deliver), () => undefined); };
      void desktop.onIncoming(take);
      take();
    },
    /** `take` returns true for what it handled; anything it handles that was waiting is handed over at once. */
    subscribe(take: (i: Incoming) => boolean): () => void {
      for (let i = 0; i < waiting.length;) { if (take(waiting[i]!)) waiting.splice(i, 1); else i++; }
      listeners.add(take);
      return () => { listeners.delete(take); };
    },
  };
})();

const desktopConnectShell: ConnectShell = {
  openBrowser: (url) => desktop.openExternal(url),
  // The browser is the person's own: nothing to close.
  closeBrowser: () => undefined,
  onCallback: (listener) => incoming.subscribe((i) => {
    if (i.kind !== "url" || !/^purss:\/\/connect\b/i.test(i.url)) return false;
    listener(i.url);
    return true;
  }),
  deviceName: () => desktop.deviceName().catch(() => "Computer"),
  save: saveConnection,
  // The page's origin isn't PURSS's, so no passkeys here; the browser's work on PURSS's Connect page.
  passkeys: null,
  browserSignin: { withPasskeys: "Sign in in your browser (passkey or linked account)", withoutPasskeys: "Sign in in your browser (passkey or linked account)" },
};

/** The interfaces Rust keeps (plan/39, plan/42). The page fetches PURSS's zip and checks it; Rust unpacks and serves it. */
function desktopUpdater(): Updater {
  return {
    builtinVersion: () => desktop.interfaceBuiltin(),
    current: () => desktop.interfaceCurrent(),
    async download({ url, version, checksum }) {
      const res = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`The interface couldn't be downloaded (${res.status}).`);
      const zip = new Uint8Array(await res.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", zip)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (digest !== checksum) throw new Error("The downloaded interface isn't the one on offer.");
      return desktop.interfaceInstall(version, zip);
    },
    downloaded: () => desktop.interfaceList(),
    remove: (id) => desktop.interfaceRemove(id),
    apply: (id) => desktop.interfaceApply(id),
    failed: () => desktop.interfaceFailed(),
  };
}

/** This computer's notifications; a click shows the window (Rust) and runs the note's action here. */
function desktopNotifier(): Notifier {
  const actions = new Map<string, () => void>();
  void desktop.onNotificationClick((tag) => { actions.get(tag)?.(); actions.delete(tag); });
  return {
    kind: "computer",
    permission: () => "granted",
    request: async () => "granted",
    show(note, onClick) {
      actions.set(note.tag, onClick);
      if (actions.size > 50) actions.delete(actions.keys().next().value!);
      void desktop.notify(note.tag, note.title, note.body ?? null).catch(() => undefined);
    },
  };
}

function desktopApp(): DesktopApp {
  let update: DesktopUpdate = { state: "none" };
  const listeners = new Set<() => void>();
  const set = (u: DesktopUpdate) => { update = u; for (const l of listeners) l(); };
  void desktop.onAppUpdate(set);
  void desktop.appUpdate().then(set, () => undefined);
  return {
    update: () => update,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restartToUpdate: () => desktop.restartToUpdate(),
    startAtLogin: () => desktop.startAtLogin(),
    setStartAtLogin: (on) => desktop.setStartAtLogin(on),
    downloadsFolder: () => desktop.folder(),
    chooseDownloadsFolder: () => desktop.chooseFolder(),
    showDownloadsFolder: () => desktop.showFolder(),
    credentialStore: () => desktop.credentialStore(),
  };
}

function onIntake(listener: (intake: Intake) => void): () => void {
  return incoming.subscribe((i) => {
    if (i.kind === "file") { listener({ kind: "opml", name: i.name, text: i.text }); return true; }
    if (i.kind !== "url") return false;
    const url = feedAddress(i.url);
    if (!url) return false;
    listener({ kind: "source", url });
    return true;
  });
}

/** Back to the interface the app was installed with, at the first screen (the page reloads). */
function restartInstalled(): void {
  forgetQueued(localKv);
  try { history.replaceState(null, "", "/"); } catch { /* reloads at the root anyway */ }
  desktop.interfaceApply(BUILTIN).catch(() => location.replace("/"));
}

function desktopPlatform(conn: Connection | null, mediaBase: string): Platform {
  const caches = new StoredCaches(new IndexedDbCopyBackend());
  const origin = conn?.origin ?? location.origin;
  const worker = new OfflineWorker({ caches, fetch: (r) => fetch(r), now: () => Date.now(), origin, build: "app" });
  const updater = desktopUpdater();

  const downloads = conn ? new DownloadManager({
    files: desktopFiles(mediaBase),
    get: (path, query, headers) => api(path, { query, headers }),
    plan: (request) => api("/api/downloads/plan", { method: "POST", body: request }),
    connection: desktopConnection,
    readPage: (page, url) => readablePage(decodePage(page), url),
    store: localKv,
  }) : null;

  let player: HtmlMediaBackend | null = null;
  const official = startingServer(null, OFFICIAL_WORKSPACE_ORIGIN);
  const updates = conn ? createInterfaceUpdates({
    origin: conn.origin,
    official: official.kind === "official" && official.origin === conn.origin,
    updater,
    fetch: (url, init) => fetch(url, init),
    playing: () => player?.state().playing ?? false,
    store: localKv,
    now: () => Date.now(),
    readOffer: desktopOffer,
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
  async function wipeAndRestart(reason: ForgetReason): Promise<void> {
    if (ending) return;
    ending = true;
    const { notice, stuck } = await forgetDevice({
      stopAudio: async () => { player?.pause(); },
      forgetConnection,
      wipeCopies: wipeOfflineCopies,
      clearOutbox: async () => { clearLateWrites(); await clearAnnotationOutbox(); },
      removeDownloads: async () => { await downloads?.removeAll(); },
      stopBackground: async () => undefined,
      forgetPush: async () => undefined,
      clearHints,
      unsent: async () => { await outbox.load(); return outbox.snapshot().length; },
    }, reason);
    leaveNotice(notice, stuck);
    void desktop.setBadge(0).catch(() => undefined);
    restartInstalled();
  }

  const connection: AppConnection | null = conn ? {
    origin: conn.origin,
    async disconnect() {
      let told = true;
      try { await timeout(api("/api/connect/device", { method: "DELETE" }), 8000); } catch { told = false; }
      await wipeAndRestart(told ? "disconnected" : "unreachable");
    },
    lost() { void wipeAndRestart("lost"); },
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
    createPlayerBackend: () => (player = new HtmlMediaBackend()),
    downloads,
    connection,
    passkeys: null,
    async saveFile(data, filename) { await desktop.saveFile(filename, new Uint8Array(await data.arrayBuffer())); },
    openExternal: (url) => { if (/^https?:\/\//i.test(url)) void desktop.openExternal(url); },
    publicOrigin: () => origin,
    onShare: () => () => {},
    widget: null,
    push: null,
    interfaceUpdates: updates,
    appVersion: async () => { try { return plainVersion(await desktop.appVersion()); } catch { return null; } },
    onOpen: (listener) => incoming.subscribe((i) => {
      if (i.kind !== "url") return false;
      const target = readOpenLink(i.url);
      if (!target) return false;
      listener(target);
      return true;
    }),
    notifier: desktopNotifier(),
    badge: conn ? (count) => { void desktop.setBadge(count).catch(() => undefined); } : null,
    onIntake,
    desktop: desktopApp(),
  };
}

/** Add the connected PURSS's policy to the page's own (both are enforced), before any request. */
function limitPageTo(origin: string, mediaBase: string): void {
  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = workspacePolicy(origin, [], { media: mediaBase });
  document.head.prepend(meta);
}

export async function startDesktop(): Promise<{ platform: Platform; screen: ReactNode | null }> {
  // This interface started: Rust keeps it instead of going back to the previous one (plan/39).
  void desktop.interfaceReady().catch(() => undefined);
  const updater = desktopUpdater();
  if (await startQueued(updater, localKv)) return new Promise(() => {});
  sendLinksOut((url) => void desktop.openExternal(url).catch(() => undefined));
  incoming.start();
  const stuck = takeStuck();
  if (stuck) await forgetConnection().catch(() => undefined);
  const conn = stuck ? null : await readConnection();
  const mediaBase = await desktop.mediaBase();
  if (conn) {
    limitPageTo(conn.origin, mediaBase);
    return { platform: desktopPlatform(conn, mediaBase), screen: null };
  }
  void removeDownloads(updater).catch(() => undefined);
  return { platform: desktopPlatform(null, mediaBase), screen: <ConnectScreen notice={takeNotice()} shell={desktopConnectShell} /> };
}
