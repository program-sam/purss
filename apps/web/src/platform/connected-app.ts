import type { ReactNode } from "react";
import type { AppBundleOffer } from "@purss/domain/app-bundle";
import { OFFICIAL_PURSS_ORIGIN, startingServer } from "@purss/domain";
import { api } from "../api/client.ts";
import { DownloadManager } from "../downloads/manager.ts";
import type { KeyValue, ManagerDeps } from "../downloads/manager.ts";
import { decodePage, readablePage } from "../downloads/readable-page.ts";
import type { PlayerBackend } from "../player/backend.ts";
import { OfflineServiceWorker } from "../sw/offline-worker.ts";
import { IndexedDbCopyBackend, StoredCaches } from "./copies.ts";
import type { Connection } from "./native/connect.ts";
import { forgetDevice } from "./native/forget.ts";
import type { ForgetDeps, ForgetReason } from "./native/forget.ts";
import { BUILTIN, createInterfaceUpdates, forgetQueued, removeDownloads, startQueued } from "./native/live-update.ts";
import type { Updater } from "./native/live-update.ts";
import { createAppTransport } from "./native/transport.ts";
import type { AppConnection, OfflineHost, Platform, Transport } from "./types.ts";
import { app } from "@purss/translations/app";

/*
 * How a connected app starts and stops, once for the phone apps (native/index.tsx) and the desktop app
 * (desktop/index.tsx). A `ConnectedShell` is what differs between them: secure storage, audio, push, the
 * updater, the web view and the icon's badge. Everything else lives here: reading the connection, the
 * offline copies, the transport, downloads and interface updates, disconnecting and losing the device.
 * The page's own surroundings (links, policy, storage, what the page keeps for PURSS) are a `Page`, so the
 * start-up can be tested without a browser or a phone.
 */

/** What the shell adds to the platform; the rest of it is made here. */
export type ShellPlatform = Omit<Platform, "transport" | "offline" | "downloads" | "connection" | "interfaceUpdates" | "openExternal" | "publicOrigin" | "keepsOtherAccountsUnsent">;

/** What the shell does when the app is connected to a PURSS. */
export interface Connected {
  readonly conn: Connection;
  /** The connected PURSS's content policy, added to the page's own before any request. */
  readonly policy: string;
  /** The device's side of downloads; the manager that uses it is made here. */
  readonly downloads: Pick<ManagerDeps, "files" | "connection" | "mirror">;
  /** Look for a new version of the app itself (at start and whenever the app is shown again). */
  readonly appCheck?: () => void;
  /** The background job found, while the app was closed, that PURSS refused this device's token. */
  readonly refusedWhileClosed?: () => Promise<boolean>;
  /** What the shell stops and removes when the device is forgotten (see forget.ts); `finish` runs once the notice is left, just before the restart. */
  readonly forget: Pick<ForgetDeps, "stopBackground" | "forgetPush"> & {
    /** Stop the sound; `player` is the backend the page made, if it made one. */
    stopAudio(player: PlayerBackend | null): Promise<void>;
    finish(): void;
  };
}

export interface Attached {
  readonly platform: ShellPlatform;
  /** Null while the app isn't connected to a PURSS. */
  readonly connected: Connected | null;
}

export interface ConnectedShell {
  readonly device: AppConnection["device"];
  /** This interface started: keep it instead of rolling back to the previous one. Runs before anything else. */
  interfaceStarted(): void;
  readonly updater: Updater;
  /** Secure storage: the device token and the server's address. `forget` rejects when it refuses. */
  readonly storage: { read(): Promise<Connection | null>; forget(): Promise<void> };
  /** Open an address in the system browser. */
  openExternal(url: string): void;
  /** Start the shell's own listeners (the phone's focus and back button, the desktop's incoming links). */
  listen(): void;
  /** How the shell reads PURSS's offer of an interface; null means none fits (the desktop app's level). */
  readonly readOffer?: (offer: AppBundleOffer) => AppBundleOffer | null;
  /** Everything else the shell makes, once it is known whether, and to which PURSS, the app is connected. */
  attach(conn: Connection | null): Promise<Attached>;
  /** The first screen of an app that isn't connected, with the notice a disconnection left. */
  firstScreen(notice: string | null): ReactNode;
}

/** What the page keeps for PURSS and the parts of it that are the browser's. */
export interface Page {
  readonly origin: string;
  /** The page's local storage. */
  readonly store: KeyValue;
  /** Links to other sites go to `open`, never inside the page. */
  sendLinksOut(open: (url: string) => void): void;
  /** Add the connected PURSS's policy to the page's own (both are enforced). */
  limitTo(policy: string): void;
  /** `listener` hears how long the page was hidden each time it is shown again. */
  onShown(listener: (awayMs: number) => void): void;
  readonly notices: {
    /** Leave the first screen's notice, and whether the connection is stuck, for the start after the restart. */
    leave(notice: string, stuck: boolean): void;
    take(): string | null;
    takeStuck(): boolean;
  };
  /** Take the page's address back to the root, where the first screen is. */
  resetAddress(): void;
  /** Load the root afresh, when the installed interface couldn't be restored. */
  replaceWithRoot(): void;
  reload(): void;
  /** Tell PURSS this device is leaving; rejects when it can't be reached in time. */
  revokeDevice(): Promise<void>;
  /** Highlights, notes, offline copies and hints this page keeps (the part of forget.ts that isn't the shell's). */
  readonly data: Pick<ForgetDeps, "wipeCopies" | "unsent" | "clearHints">;
}

export type Started = { platform: Platform; screen: ReactNode | null };

/** A connected app that isn't connected yet: every request is refused the way a disconnected device's would be. */
const signedOut: Transport = {
  fetch: async () => new Response(JSON.stringify({ error: { code: "device_signed_out", message: app.words.connectTheAppFirst } }), { status: 401, headers: { "content-type": "application/json" } }),
  events: () => () => {},
  picture: () => Promise.reject(new Error(app.words.connectTheAppFirst)),
};

export async function startConnectedApp(shell: ConnectedShell, page: Page): Promise<Started> {
  shell.interfaceStarted();
  // A downloaded interface waiting for this start takes over before anything is shown; the page reloads into it.
  if (await startQueued(shell.updater, page.store)) return new Promise(() => {});
  page.sendLinksOut((url) => shell.openExternal(url));
  shell.listen();
  const stuck = page.notices.takeStuck();
  // A connection that couldn't be removed is tried once more and never used: it would only be refused again.
  if (stuck) await shell.storage.forget().catch(() => undefined);
  const conn = stuck ? null : await shell.storage.read();
  const attached = await shell.attach(conn);
  const connected = attached.connected;
  if (connected) page.limitTo(connected.policy);
  const platform = assemble(shell, page, attached);
  if (connected) {
    // The background job found the token refused while the app was closed: the same as being told so now.
    void connected.refusedWhileClosed?.().then((lost) => { if (lost) platform.connection?.lost(); }).catch(() => undefined);
    return { platform, screen: null };
  }
  void removeDownloads(shell.updater).catch(() => undefined);
  return { platform, screen: shell.firstScreen(page.notices.take()) };
}

function assemble(shell: ConnectedShell, page: Page, attached: Attached): Platform {
  const connected = attached.connected;
  const origin = connected?.conn.origin ?? page.origin;
  const caches = new StoredCaches(new IndexedDbCopyBackend());
  const worker = new OfflineServiceWorker({ caches, fetch: (r) => fetch(r), now: () => Date.now(), origin, build: "app" });

  const downloads = connected ? new DownloadManager({
    ...connected.downloads,
    get: (path, query, headers) => api(path, { query, headers }),
    plan: (request) => api("/api/downloads/plan", { method: "POST", body: request }),
    readPage: (readable, url) => readablePage(decodePage(readable), url),
    store: page.store,
  }) : null;

  let player: PlayerBackend | null = null;
  const official = startingServer(null, OFFICIAL_PURSS_ORIGIN);
  const updates = connected ? createInterfaceUpdates({
    origin: connected.conn.origin,
    official: official.kind === "official" && official.origin === connected.conn.origin,
    updater: shell.updater,
    fetch: (url, init) => fetch(url, init),
    playing: () => player?.state().playing ?? false,
    store: page.store,
    now: () => Date.now(),
    readOffer: shell.readOffer,
  }) : null;
  if (updates) {
    void updates.check();
    connected?.appCheck?.();
    page.onShown((awayMs) => {
      void updates.shown(awayMs);
      connected?.appCheck?.();
    });
  }

  const connection = connected ? connectionTo(connected) : null;

  /** The connected PURSS, in the app: disconnecting, and losing the device. */
  function connectionTo(on: Connected): AppConnection {
    let ending = false;
    /** Remove what this app keeps for PURSS (see forget.ts), then start again at the first screen. */
    async function wipeAndRestart(reason: ForgetReason): Promise<void> {
      if (ending) return;
      ending = true;
      const { notice, stuck } = await forgetDevice({
        stopAudio: () => on.forget.stopAudio(player),
        forgetConnection: shell.storage.forget,
        removeDownloads: async () => { await downloads?.removeAll(); },
        stopBackground: on.forget.stopBackground,
        forgetPush: on.forget.forgetPush,
        ...page.data,
      }, reason);
      page.notices.leave(notice, stuck);
      on.forget.finish();
      // The next PURSS decides on its own interface.
      forgetQueued(page.store);
      page.resetAddress();
      shell.updater.apply(BUILTIN).catch(() => page.replaceWithRoot());
    }
    return {
      origin: on.conn.origin,
      device: shell.device,
      async disconnect() {
        let told = true;
        try { await page.revokeDevice(); } catch { told = false; }
        await wipeAndRestart(told ? "disconnected" : "unreachable");
      },
      lost() {
        void wipeAndRestart("lost");
      },
    };
  }

  const transport: Transport = connected && downloads
    ? createAppTransport({ origin, token: connected.conn.token, worker, downloaded: (path) => downloads.answer(path), fetch: (r) => fetch(r), onLost: () => connection?.lost() })
    : signedOut;

  const offline: OfflineHost = {
    supported: () => true,
    installed: () => true,
    start: async () => true,
    tell: async (message) => { await worker.message(message); return true; },
    whenControlled: async () => true,
    onUpdateReady: () => () => {},
    applyUpdate: () => page.reload(),
    caches: () => caches,
  };

  return {
    ...attached.platform,
    transport,
    offline,
    createPlayerBackend: () => (player = attached.platform.createPlayerBackend()),
    downloads,
    connection,
    interfaceUpdates: updates,
    openExternal: (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); },
    publicOrigin: () => origin,
    keepsOtherAccountsUnsent: true,
  };
}
