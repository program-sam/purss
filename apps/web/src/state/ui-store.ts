import { useSyncExternalStore } from "react";

/**
 * Layout hints that belong to this browser, not to the account: sidebar width mode, collapsed
 * groups, the detail panel's width. Product settings (theme, density, Home layout) are saved on the
 * server with the account; only a tiny copy of the visual ones is kept here so the first paint
 * after a reload does not flash the wrong theme.
 */
export type UiHints = {
  sidebar: "full" | "rail" | null;
  collapsed: string[];
  /** Sidebar groups showing all their sources instead of the first few. */
  showAll: string[];
  /** Reader panel width the user dragged to; null follows the window (see .panel in app.css). */
  readerWidth: number | null;
  boardColumn: string;
};
export type VisualHint = { theme: "system" | "light" | "dark"; skin: string; density: string };

const KEY = "purss-ui";
const VISUAL_KEY = "purss-visual";
const DEFAULTS: UiHints = { sidebar: null, collapsed: [], showAll: [], readerWidth: null, boardColumn: "new" };

let state: UiHints = read();
const listeners = new Set<() => void>();

function read(): UiHints {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UiHints>) } : DEFAULTS;
  } catch { return DEFAULTS; }
}

export function setHints(patch: Partial<UiHints>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable: keep in memory */ }
  listeners.forEach((l) => l());
}

export function useHints(): UiHints {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state, () => DEFAULTS);
}

export function readVisualHint(): VisualHint | null {
  try {
    const raw = localStorage.getItem(VISUAL_KEY);
    return raw ? (JSON.parse(raw) as VisualHint) : null;
  } catch { return null; }
}

export function writeVisualHint(h: VisualHint): void {
  try { localStorage.setItem(VISUAL_KEY, JSON.stringify(h)); } catch { /* ignore */ }
}

export function clearHints(): void {
  try { localStorage.removeItem(KEY); localStorage.removeItem(VISUAL_KEY); } catch { /* ignore */ }
  state = DEFAULTS;
  listeners.forEach((l) => l());
}
