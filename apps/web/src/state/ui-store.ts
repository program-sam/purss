import { useSyncExternalStore } from "react";

/**
 * Layout hints that belong to this browser, not to the account: sidebar width mode, collapsed
 * Home boxes, the detail panel's width. Product settings (theme, density, Home layout) are saved on the
 * server with the account; only a tiny copy of the visual ones is kept here so the first paint
 * after a reload does not flash the wrong theme.
 */
export type UiHints = {
  sidebar: "full" | "rail" | null;
  /** Home collection boxes the user collapsed; they start open. */
  collapsed: string[];
  /** Home's To read, To listen, Recently kept and Needs attention rows the user opened; they start closed. */
  opened: string[];
  /** Sidebar groups showing all their sources instead of the first few. */
  showAll: string[];
  /** Reader panel width the user dragged to; null follows the window (see .panel in app.css). */
  readerWidth: number | null;
  boardColumn: string;
};
export type VisualHint = { theme: "system" | "light" | "dark"; skin: string; density: string };

const KEY = "purss-ui";
const VISUAL_KEY = "purss-visual";
const DEFAULTS: UiHints = { sidebar: null, collapsed: [], opened: [], showAll: [], readerWidth: null, boardColumn: "new" };

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

/**
 * Sidebar collections opened during this page load. Not saved: every load starts with all of them
 * closed, so the sidebar stays short.
 */
let openGroups: readonly string[] = [];
const groupListeners = new Set<() => void>();
const NO_GROUPS: readonly string[] = [];

export function toggleGroup(id: string): void {
  openGroups = openGroups.includes(id) ? openGroups.filter((x) => x !== id) : [...openGroups, id];
  groupListeners.forEach((l) => l());
}

export function useOpenGroups(): readonly string[] {
  return useSyncExternalStore((cb) => { groupListeners.add(cb); return () => groupListeners.delete(cb); }, () => openGroups, () => NO_GROUPS);
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
