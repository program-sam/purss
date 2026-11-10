import { useSyncExternalStore } from "react";
import { platform } from "../platform/index.ts";

/**
 * "Offline reading on this device": a choice that belongs to this browser, like Sounds, not to the
 * account. Until it is chosen it follows how the app is running: on when installed as an app, off in an
 * ordinary browser tab, so a shared computer's browser doesn't quietly keep a copy of someone's reading.
 */
export type OfflineChoice = "on" | "off" | null;
const KEY = "purss:offline-reading";

export function parseChoice(raw: string | null): OfflineChoice {
  return raw === "on" || raw === "off" ? raw : null;
}

export function resolveEnabled(choice: OfflineChoice, installed: boolean, supported: boolean): boolean {
  if (!supported) return false;
  return choice === null ? installed : choice === "on";
}

/** Running as an installed app (its own window, or one of the phone apps), not in a browser tab. */
export function isInstalledApp(): boolean {
  return platform.offline.installed();
}

/** Copies can be kept here: on the web that needs a service worker, which browsers allow only over HTTPS (or localhost). */
export function offlineSupported(): boolean {
  return platform.offline.supported();
}

function read(): OfflineChoice {
  try { return parseChoice(localStorage.getItem(KEY)); } catch { return null; }
}

let choice: OfflineChoice = read();
const listeners = new Set<() => void>();

export function offlineReadingEnabled(): boolean {
  return resolveEnabled(choice, isInstalledApp(), offlineSupported());
}

export function subscribeOfflineReading(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setOfflineReading(on: boolean): void {
  choice = on ? "on" : "off";
  try { localStorage.setItem(KEY, choice); } catch { /* private mode: keep for this visit */ }
  listeners.forEach((fn) => fn());
}

export function useOfflineReading(): boolean {
  return useSyncExternalStore(subscribeOfflineReading, offlineReadingEnabled, () => false);
}
