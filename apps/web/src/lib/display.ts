import { useSyncExternalStore } from "react";

/**
 * The display this device has, saved on the device like sounds (never with the account): an
 * e-ink reader wants pure black on white, nothing that moves, and page buttons
 * instead of smooth scrolling. Not detected automatically: browsers on e-readers don't say so
 * reliably. The look itself lives in the `[data-display="eink"]` rules (packages/ui, apps/web).
 */
export type DisplayMode = "standard" | "eink";

const KEY = "purss:display";

export function parseDisplayMode(raw: string | null): DisplayMode {
  return raw === "eink" ? "eink" : "standard";
}

function read(): DisplayMode {
  try { return parseDisplayMode(localStorage.getItem(KEY)); } catch { return "standard"; }
}

let current: DisplayMode = typeof localStorage === "undefined" ? "standard" : read();
const listeners = new Set<() => void>();

/** Mark the page so the e-ink rules apply; the standard display carries no marker at all. */
export function applyDisplayMode(root: HTMLElement = document.documentElement): void {
  if (current === "eink") root.dataset.display = "eink";
  else delete root.dataset.display;
}

export function displayMode(): DisplayMode {
  return current;
}

export function setDisplayMode(mode: DisplayMode): void {
  current = mode;
  try {
    if (mode === "eink") localStorage.setItem(KEY, mode);
    else localStorage.removeItem(KEY);
  } catch { /* private mode: keep for this visit */ }
  applyDisplayMode();
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDisplayMode(): DisplayMode {
  return useSyncExternalStore(subscribe, displayMode, () => "standard");
}
