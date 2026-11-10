import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopUpdate } from "../types.ts";

/*
 * The desktop app's commands (apps/desktop/src-tauri, plan/42), typed. Every power the page has over the
 * computer is one of these, and Rust checks each argument itself: paths stay inside the downloads folder,
 * links out are http(s), interfaces are unpacked only into the app's own folder.
 */

/** Something handed to the app from outside: an address (purss://, feed:, podcast:) or an opened file. */
export type Incoming = { kind: "url"; url: string } | { kind: "file"; name: string; text: string } | { kind: "file-error"; name: string; reason: string };

export type InterfaceRef = { id: string; version: string };

export const desktop = {
  readConnection: () => invoke<string | null>("connection_read"),
  saveConnection: (json: string) => invoke<void>("connection_save", { json }),
  forgetConnection: () => invoke<void>("connection_forget"),
  credentialStore: () => invoke<"system" | "file">("credential_store"),
  deviceName: () => invoke<string>("device_name"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** A save dialog for `name`; false when the person cancelled it. */
  saveFile: (name: string, data: Uint8Array) => invoke<boolean>("save_file", data, { headers: { "x-purss-name": encodeURIComponent(name) } }),
  notify: (tag: string, title: string, body: string | null) => invoke<void>("notify", { tag, title, body }),
  setBadge: (count: number) => invoke<void>("set_badge", { count }),
  /** What is waiting (a link or file that started the app, or arrived since), once. */
  takeIncoming: () => invoke<Incoming[]>("take_incoming"),

  download: (id: string, url: string, path: string, maxBytes: number | null, onProgress: (p: { bytes: number; total: number }) => void) => {
    const channel = new Channel<{ bytes: number; total: number }>();
    channel.onmessage = onProgress;
    return invoke<number>("files_download", { id, url, path, maxBytes, onProgress: channel });
  },
  cancelDownload: (id: string) => invoke<void>("files_cancel", { id }),
  list: (path: string) => invoke<string[]>("files_list", { path }),
  writeText: (path: string, text: string) => invoke<number>("files_write_text", { path, text }),
  readText: (path: string) => invoke<string | null>("files_read_text", { path }),
  /** The file's bytes; null when it isn't there. */
  readBytes: async (path: string) => {
    try { return new Uint8Array(await invoke<ArrayBuffer>("files_read_bytes", { path })); } catch { return null; }
  },
  remove: (path: string) => invoke<void>("files_remove", { path }),
  /** The address the player loads files from: the app's server on 127.0.0.1, with a secret only this run knows. */
  mediaBase: () => invoke<string>("files_media_base"),
  folder: () => invoke<string>("files_folder"),
  chooseFolder: () => invoke<string | null>("files_choose_folder"),
  showFolder: () => invoke<void>("files_show_folder"),

  interfaceBuiltin: () => invoke<string>("interface_builtin"),
  interfaceCurrent: () => invoke<InterfaceRef>("interface_current"),
  interfaceInstall: (version: string, zip: Uint8Array) => invoke<InterfaceRef>("interface_install", zip, { headers: { "x-purss-version": version } }),
  interfaceList: () => invoke<InterfaceRef[]>("interface_list"),
  interfaceRemove: (id: string) => invoke<void>("interface_remove", { id }),
  /** Switch to a downloaded interface, or "builtin"; the page reloads at the root. */
  interfaceApply: (id: string) => invoke<void>("interface_apply", { id }),
  interfaceFailed: () => invoke<string | null>("interface_failed"),
  interfaceReady: () => invoke<void>("interface_ready"),

  appUpdate: () => invoke<DesktopUpdate>("app_update_state"),
  restartToUpdate: () => invoke<void>("app_update_restart"),
  startAtLogin: () => invoke<boolean>("autostart_get"),
  setStartAtLogin: (on: boolean) => invoke<void>("autostart_set", { on }),
  appVersion: () => invoke<string>("app_version"),

  /** Told when something is waiting in takeIncoming(). */
  onIncoming: (listener: () => void) => listen("purss://incoming", () => listener()),
  onNotificationClick: (listener: (tag: string) => void) => listen<{ tag: string }>("purss://notification-click", (e) => listener(e.payload.tag)),
  onAppUpdate: (listener: (u: DesktopUpdate) => void) => listen<DesktopUpdate>("purss://app-update", (e) => listener(e.payload)),
};
