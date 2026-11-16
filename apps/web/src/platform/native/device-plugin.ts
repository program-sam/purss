import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/**
 * The app's own native plugin (plan/38): Android `app.purss.device.PurssDevicePlugin`, iOS
 * `App/PurssDevice/PurssDevicePlugin.swift`. Downloads that can really be stopped, the state the background
 * job needs, and the home-screen panels' look, episode and refresh. Paths are relative to the downloads folder (the
 * same one `@capacitor/filesystem` reaches as `downloads/` in `Directory.LibraryNoCloud`).
 */
export type DownloadFailure = { code: "http" | "network" | "too_large" | "cancelled" | "io" | "insecure"; status?: number };

export interface PurssDevicePlugin {
  /**
   * Fetch `url` into `path` (written as `<path>.part`, renamed when complete). Rejects with `code`
   * (see DownloadFailure; `data.status` for "http"). Stops with "too_large" as soon as the declared or
   * received size passes `maxBytes`. The plugin enforces its own rules too: only https addresses ("insecure"
   * otherwise), and never more than 4 GB, the default when `maxBytes` is left out.
   *
   * The transfer goes on when the app is closed (Android: a foreground job with a notification; iOS: a
   * background URLSession), and a cut-off one keeps its partial file. Asked again for the same `path`,
   * the plugin answers at once with a file finished meanwhile, joins a transfer under way, or continues
   * the partial file.
   */
  download(options: { id: string; url: string; path: string; maxBytes?: number }): Promise<{ bytes: number }>;
  /**
   * Stop a download by its id, or every download into `id` as a path or a folder under it ("" for all):
   * the connection is closed and the partial file removed. Unknown ids are fine.
   */
  cancel(options: { id: string }): Promise<void>;
  addListener(event: "progress", listener: (p: { id: string; bytes: number; total: number }) => void): Promise<PluginListenerHandle>;
  /** The background job's state (JSON of BackgroundState plus `origin`), or null to stop it. Schedules or cancels the job. */
  setBackground(options: { state: string | null }): Promise<void>;
  /** The panels' look and episode (JSON of WidgetSnapshot), or null for "not connected". Redraws the panels. */
  setWidget(options: { snapshot: string | null }): Promise<void>;
  /** The snapshot as stored now (the page's last), or null. */
  getWidget(): Promise<{ snapshot: string | null }>;
  /** Fetch the placed panels' lists again soon (the native side knows which lists they show). */
  refreshWidgets(): Promise<void>;
  /**
   * The new items on the app's icon (0 clears it). iOS shows the number on the icon once notifications are allowed;
   * Android has no badge of its own, so the number goes on PURSS's notifications in the shade, which launchers draw
   * as a dot or add up. Apps built before this method reject the call.
   */
  setBadge(options: { count: number }): Promise<void>;
  /** Whether the background job found the token refused since last asked (the flag is cleared). */
  takeBackgroundReport(): Promise<{ lost: boolean }>;
  /**
   * Android only: the build's flavor ("full" or "foss") and the package that installed the app (null when installed by
   * hand or with adb). Apps built before this method reject the call.
   */
  installSource(): Promise<{ flavor: string; installer: string | null }>;
  /** Disconnect: stop and unschedule the job, delete its unfinished files, its state, and everything the home-screen panels kept (lists, chosen collections and sources, snapshot); the count on the icon goes. */
  reset(): Promise<void>;
}

export const PurssDevice = registerPlugin<PurssDevicePlugin>("PurssDevice");
