import type { ReactNode } from "react";
import { desktopOffer } from "@purss/domain/app-bundle";
import { plainVersion } from "@purss/domain/version";
import { HtmlMediaBackend } from "../../player/html-backend.ts";
import { browserPage } from "../browser-page.ts";
import { startConnectedApp } from "../connected-app.ts";
import type { ConnectedShell, ShellPlatform } from "../connected-app.ts";
import { purssPolicy } from "../csp.ts";
import { readOpenLink } from "../open-link.ts";
import type { DesktopApp, DesktopUpdate, Intake, Notifier, Platform, WebView } from "../types.ts";
import { parseConnection } from "../native/connect.ts";
import type { Connection } from "../native/connect.ts";
import { ConnectScreen } from "../native/ConnectScreen.tsx";
import type { ConnectShell } from "../native/ConnectScreen.tsx";
import type { Updater } from "../native/live-update.ts";
import { desktop } from "./bridge.ts";
import type { Incoming } from "./bridge.ts";
import { drawBadgeOverlay, wantsOverlay } from "./badge-overlay.ts";
import { feedAddress } from "./feed-link.ts";
import { desktopConnection, desktopFiles } from "./files.ts";
import { app } from "@purss/translations/app";

const t = app.platform.desktop;

/**
 * The desktop app's shell for connected-app.ts: the phone apps' model in a Tauri shell. The interface is the web app's
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
  if (await readConnection()) throw new Error(t.connectionStillStored);
}

/**
 * Everything handed to the app from outside: purss://connect answers, purss://open links, feed links and
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
  deviceName: () => desktop.deviceName().catch(() => t.deviceName),
  save: saveConnection,
  // The page's origin isn't PURSS's, so no passkeys here; the browser's work on PURSS's Connect page.
  passkeys: null,
  browserSignin: t.browserSignin,
};

/** The interfaces Rust keeps. The page fetches PURSS's zip and checks it; Rust unpacks and serves it. */
function desktopUpdater(): Updater {
  return {
    builtinVersion: () => desktop.interfaceBuiltin(),
    current: () => desktop.interfaceCurrent(),
    async download({ url, version, checksum }) {
      const res = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(t.interfaceNotDownloaded(res.status));
      const zip = new Uint8Array(await res.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", zip)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (digest !== checksum) throw new Error(t.interfaceNotTheOffer);
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

/** The app's web view for other sites' pages; Rust checks every address and place. */
function desktopWebView(): WebView {
  const listeners = new Set<(s: { url: string; loading: boolean }) => void>();
  void desktop.onWebState((s) => { for (const l of listeners) l(s); });
  return {
    open: (url, bounds) => desktop.webOpen(url, bounds),
    place: (bounds) => { void desktop.webPlace(bounds).catch(() => undefined); },
    close: () => { void desktop.webClose().catch(() => undefined); },
    go: (action) => { void desktop.webGo(action).catch(() => undefined); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
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

/** What the desktop adds to the platform; `conn` is null while the app isn't connected. */
function desktopPlatform(conn: Connection | null): ShellPlatform {
  return {
    createPlayerBackend: () => new HtmlMediaBackend(),
    passkeys: null,
    async saveFile(data, filename) { await desktop.saveFile(filename, new Uint8Array(await data.arrayBuffer())); },
    onShare: () => () => {},
    widget: null,
    push: null,
    appUpdates: null,
    appVersion: async () => { try { return plainVersion(await desktop.appVersion()); } catch { return null; } },
    onConnectReturn: (listener) => incoming.subscribe((i) => {
      if (i.kind !== "url" || !/^purss:\/\/connect\b/i.test(i.url)) return false;
      listener(i.url);
      return true;
    }),
    onOpen: (listener) => incoming.subscribe((i) => {
      if (i.kind !== "url") return false;
      const target = readOpenLink(i.url);
      if (!target) return false;
      listener(target);
      return true;
    }),
    notifier: desktopNotifier(),
    badge: conn ? (count) => {
      const overlay = count > 0 && wantsOverlay() ? drawBadgeOverlay(count) : null;
      void desktop.setBadge(count, overlay).catch(() => undefined);
    } : null,
    onIntake,
    desktop: desktopApp(),
    webView: desktopWebView(),
    frames: false,
  };
}

const desktopShell: ConnectedShell = {
  device: "computer",
  // This interface started: Rust keeps it instead of going back to the previous one.
  interfaceStarted() { void desktop.interfaceReady().catch(() => undefined); },
  updater: desktopUpdater(),
  storage: { read: readConnection, forget: forgetConnection },
  openExternal(url) { void desktop.openExternal(url).catch(() => undefined); },
  listen() { incoming.start(); },
  readOffer: desktopOffer,
  async attach(conn) {
    const mediaBase = await desktop.mediaBase();
    return {
      platform: desktopPlatform(conn),
      connected: conn ? {
        conn,
        policy: purssPolicy(conn.origin, [], { media: mediaBase }),
        downloads: { files: desktopFiles(mediaBase), connection: desktopConnection },
        forget: {
          stopAudio: async (player) => { player?.pause(); },
          stopBackground: async () => undefined,
          forgetPush: async () => undefined,
          finish: () => { void desktop.setBadge(0).catch(() => undefined); },
        },
      } : null,
    };
  },
  firstScreen: (notice): ReactNode => <ConnectScreen notice={notice} shell={desktopConnectShell} />,
};

export function startDesktop(): Promise<{ platform: Platform; screen: ReactNode | null }> {
  return startConnectedApp(desktopShell, browserPage);
}
