import { useSyncExternalStore } from "react";
import { isInstalledApp } from "./device.ts";

/**
 * Installing the app: Chromium browsers offer it through an event we hold until the person presses
 * Install in Settings; Safari on iPhone and iPad has no such event, only Share → Add to Home Screen.
 */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPrompt | null = null;
let installed = false;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((fn) => fn()); };

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallPrompt; bump(); });
  window.addEventListener("appinstalled", () => { deferred = null; installed = true; bump(); });
}

export function isAppleTouchBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export type InstallState = { canInstall: boolean; showAppleHint: boolean; installedApp: boolean };

export function useInstallState(): InstallState {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => version, () => 0);
  const installedApp = installed || isInstalledApp();
  return { canInstall: deferred !== null && !installedApp, showAppleHint: isAppleTouchBrowser() && !installedApp, installedApp };
}

/** Show the browser's own install prompt. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  bump();
  await event.prompt();
  await event.userChoice.catch(() => undefined);
}
