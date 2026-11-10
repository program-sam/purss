import { useSyncExternalStore } from "react";

/**
 * Text size is a setting of this device, like Sounds: a screen that needs larger text is not every screen the person
 * uses. It sets the page's root font size, which every size in the stylesheets follows.
 */
export const TEXT_SIZES = [100, 115, 130, 150] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: TextSize = 100;
const KEY = "purss:text-size";

export function parseTextSize(raw: string | null): TextSize {
  const n = Number(raw);
  return (TEXT_SIZES as readonly number[]).includes(n) ? (n as TextSize) : DEFAULT_TEXT_SIZE;
}

/** The root font size for a setting: nothing at 100, so the browser's own default size still applies. */
export function rootFontSize(size: TextSize): string {
  return size === DEFAULT_TEXT_SIZE ? "" : `${size}%`;
}

/** Puts a size on the page: the root font size, and the scale (`--ts`) that the stylesheet uses for boxes sized in pixels around text. */
function apply(size: TextSize): void {
  const root = document.documentElement;
  root.style.fontSize = rootFontSize(size);
  if (size === DEFAULT_TEXT_SIZE) { root.removeAttribute("data-ts"); root.style.removeProperty("--ts"); }
  else { root.setAttribute("data-ts", String(size)); root.style.setProperty("--ts", String(size / 100)); }
}

function read(): TextSize {
  try { return parseTextSize(localStorage.getItem(KEY)); } catch { return DEFAULT_TEXT_SIZE; }
}

let current: TextSize = DEFAULT_TEXT_SIZE;
const listeners = new Set<() => void>();

/** Apply this device's saved size; call once before the first paint. */
export function initTextSize(): void {
  current = read();
  apply(current);
}

export function setTextSize(size: TextSize): void {
  current = size;
  try { localStorage.setItem(KEY, String(size)); } catch { /* private mode: kept for this visit */ }
  apply(size);
  listeners.forEach((fn) => fn());
}

export function useTextSize(): TextSize {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current, () => DEFAULT_TEXT_SIZE);
}
