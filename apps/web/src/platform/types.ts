import type { PlayerBackend } from "../player/backend.ts";
import type { PageMessage } from "../sw/protocol.ts";
import type { CacheStorageLike } from "../sw/cache-types.ts";
import type { DeviceDownloads } from "../downloads/types.ts";
import type { WidgetSnapshot } from "../device/widget.ts";
import type { OpenTarget } from "./open-link.ts";
import type { NotifyPermission } from "../lib/browser-notify.ts";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

/**
 * The platform layer (plan/31): everything that differs between the web app in a browser and the same
 * app inside the Android and iOS shells and the desktop app (plan/42). Screens never ask which one they run in; they use these parts,
 * and the few capabilities below (`downloads`, `connection`) decide whether a control
 * exists at all.
 */
export interface Platform {
  /** For diagnostics and tests only. */
  readonly kind: "web" | "app";
  readonly transport: Transport;
  readonly offline: OfflineHost;
  /** The player's backend: the browser's media element, or the native audio player in the apps. */
  createPlayerBackend(): PlayerBackend;
  /** Copies on this device ("Downloaded"); null where there are none (the web app). */
  readonly downloads: DeviceDownloads | null;
  /** The PURSS this app is connected to; null on the web, where the page is PURSS itself. */
  readonly connection: AppConnection | null;
  /** Passkeys: the browser's, or the phone's own where PURSS vouches for the app; null where none can be used. */
  readonly passkeys: Passkeys | null;
  /** Hand a file to the person: a download in a browser, the share sheet in the apps (save to Files, Drive, …). */
  saveFile(data: Blob, filename: string): Promise<void>;
  /** Open an address outside PURSS: a new browser tab, or the system browser. */
  openExternal(url: string): void;
  /** PURSS's own address, for links people copy and share. */
  publicOrigin(): string;
  /** Links and text shared into the app from other apps. Returns a function that stops listening. */
  onShare(listener: (shared: SharedContent) => void): () => void;
  /** The home-screen panels (plan/38): their look and episode, and a refresh of their lists; null where there are none (the web app). */
  readonly widget: { update(snapshot: WidgetSnapshot): void; current(): Promise<WidgetSnapshot | null>; refresh(): void } | null;
  /** Notifications on this phone (plan/37); null where there are none (the web app). */
  readonly push: PhonePush | null;
  /** Where a tapped widget row or notification asks the app to go (`purss://open`). Returns a function that stops listening. */
  onOpen(listener: (target: OpenTarget) => void): () => void;
  /** Addresses `purss://connect?…` that reach the connected app: the code the system browser hands back after linking a provider sign-in or confirming it's you with one. Returns a function that stops listening. */
  onConnectReturn(listener: (url: string) => void): () => void;
  /** The installed app's version (plan/40), as its store build says; null on the web, or for a build without one. */
  appVersion(): Promise<string | null>;
  /** Updates of the app's interface from the connected PURSS (plan/39); null where there are none (the web app, an app not connected). */
  readonly interfaceUpdates: InterfaceUpdates | null;
  /** System notifications for the alerts the person chose (Settings → Notifications): the browser's, or the desktop app's. */
  readonly notifier: Notifier;
  /** Show the bell's unread count on the app's icon (dock, launcher, tray); null where there is no such icon. */
  readonly badge: ((count: number) => void) | null;
  /** Feed links and OPML files opened with the desktop app (plan/42). Returns a function that stops listening. */
  onIntake(listener: (intake: Intake) => void): () => void;
  /** What only the desktop app has (plan/42): its own updates, starting at sign-in, the downloads folder; null elsewhere. */
  readonly desktop: DesktopApp | null;
}

/** A feed link (`feed:`, `podcast:`) to add as a source, or an OPML file to import. */
export type Intake = { kind: "source"; url: string } | { kind: "opml"; name: string; text: string };

export interface Notifier {
  /** Whose notifications these are, for the words in Settings: the browser's for this page, or this computer's. */
  readonly kind: "browser" | "computer";
  permission(): NotifyPermission;
  /** Ask for permission. Only ever called from a button the person pressed. */
  request(): Promise<NotifyPermission>;
  /** Show one notification; `onClick` runs when it is clicked (where the system reports clicks). */
  show(note: { tag: string; title: string; body?: string }, onClick: () => void): void;
}

/** The desktop app's own update, as Settings → This device shows it. */
export type DesktopUpdate = { state: "none" } | { state: "downloading"; version: string } | { state: "ready"; version: string } | { state: "failed"; detail: string };

export interface DesktopApp {
  update(): DesktopUpdate;
  subscribe(listener: () => void): () => void;
  /** Install the downloaded update and start the new version. */
  restartToUpdate(): Promise<void>;
  startAtLogin(): Promise<boolean>;
  setStartAtLogin(on: boolean): Promise<void>;
  /** The folder downloads are kept in, as the person sees it. */
  downloadsFolder(): Promise<string>;
  /** Let the person choose another folder (a system dialog); downloads are moved there. The new folder, or null when nothing changed. */
  chooseDownloadsFolder(): Promise<string | null>;
  showDownloadsFolder(): Promise<void>;
  /** Where the connection is kept: the system's credential store, or (a Linux desktop without one) a file only this user can read. */
  credentialStore(): Promise<"system" | "file">;
}

/**
 * Whether the connected PURSS may update the app's interface. The official server may; any other is asked
 * about once, the first time it offers an update (`asking`), and the answer can be changed in Settings → This device.
 */
export type InterfaceUpdateState = { official: boolean; consent: "yes" | "no" | null; asking: boolean };

export interface InterfaceUpdates {
  state(): InterfaceUpdateState;
  subscribe(listener: () => void): () => void;
  /** Allow or refuse updates from this server; an update it offers is then fetched, or the installed interface comes back. */
  answer(allow: boolean): Promise<void>;
}

/**
 * What Settings shows about notifications on this phone:
 * - on / off: as the person chose (on means this phone is registered with PURSS);
 * - denied: the system blocks notifications for the app;
 * - unavailable: this build of the app can't receive them, or PURSS doesn't send them (`detail` says which).
 */
export type PushStatus = { state: "on" | "off" | "denied" | "unavailable"; detail: string | null };

export interface PhonePush {
  status(): Promise<PushStatus>;
  /** Ask the system for permission (its prompt appears once), then register this phone with PURSS. */
  enable(): Promise<PushStatus>;
  /** Stop notifications on this phone: unregister it from PURSS and the relay. */
  disable(): Promise<PushStatus>;
}

/** How requests reach the API: same-origin cookies on the web, the connected server with a device token in the apps. */
export interface Transport {
  /** fetch() for an API path; adds the credentials. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** Server-sent events from /api/events, one call per message's data. Returns a function that stops them. */
  events(onMessage: (data: string) => void): () => void;
}

/** Where copies of API answers for offline reading are kept, and who keeps them. */
export interface OfflineHost {
  /** Copies can be kept here at all. */
  supported(): boolean;
  /** Running as an installed app (offline reading starts on there). */
  installed(): boolean;
  /** Start whatever keeps the copies (the service worker on the web). False where nothing could start. */
  start(): Promise<boolean>;
  /** Tell the keeper about the account and setting, or to wipe. Resolves true once it has acted. */
  tell(message: PageMessage): Promise<boolean>;
  /** Resolves true once requests from this page pass through the keeper. */
  whenControlled(timeoutMs: number): Promise<boolean>;
  /** Call back when a new build of the app is waiting. Returns a function that stops watching. */
  onUpdateReady(callback: () => void): () => void;
  applyUpdate(): void;
  /** The storage the copies live in, for counting and wiping them from the page. */
  caches(): CacheStorageLike | null;
}

/** Making and using passkeys with PURSS's WebAuthn options; errors carry the WebAuthn name (NotAllowedError, …). */
export interface Passkeys {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  get(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

/** The connected PURSS, in the apps. */
export interface AppConnection {
  /** The server's address, e.g. https://purss.example. */
  readonly origin: string;
  /** Revoke this device's token on the server (when reachable), then remove everything this app keeps and go back to the first screen. */
  disconnect(): Promise<void>;
  /** The server said this device is no longer connected: remove everything and go back to the first screen. */
  lost(): void;
}

/** What another app shared: a title and texts (a link is usually one of the texts). */
export type SharedContent = { title: string; texts: string[] };
