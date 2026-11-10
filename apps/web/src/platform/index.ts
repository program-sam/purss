import type { ReactNode } from "react";
import type { Platform } from "./types.ts";
import { webPlatform } from "./web.ts";

/**
 * The platform the app runs on (see types.ts). The web until initPlatform() finds the phone apps' native shell
 * or the desktop app's (plan/42); their code is loaded only there, so the web app never downloads it on start.
 */
export let platform: Platform = webPlatform;

/** The Android and iOS shells put their bridge on window before the page's scripts run. */
export function inNativeShell(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform();
}

/** The desktop app's Tauri shell puts its bridge on window before the page's scripts run. */
export function inDesktopShell(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "object";
}

/**
 * Pick the platform before anything renders. In the apps, an app that isn't connected to a PURSS
 * yet gets the first-run screen instead of PURSS (`screen`).
 */
export async function initPlatform(): Promise<{ screen: ReactNode | null }> {
  if (inDesktopShell()) {
    const desktop = await import("./desktop/index.tsx");
    const started = await desktop.startDesktop();
    platform = started.platform;
    return { screen: started.screen };
  }
  if (!inNativeShell()) return { screen: null };
  const native = await import("./native/index.tsx");
  const started = await native.startNative();
  platform = started.platform;
  return { screen: started.screen };
}
