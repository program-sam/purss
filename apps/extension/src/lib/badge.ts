import { isWebPage, withoutFragment } from "./address.ts";

/*
 * The toolbar mark for pages already kept. By default the extension asks the PURSS about a page
 * only when the person opens the popup on it. Marking pages as they open is a setting, off unless
 * turned on, because it sends the address of every page opened in a normal window to the PURSS;
 * private windows are never checked. Answers are kept for a while so going back and forth between
 * tabs doesn't ask again, and a page is only asked about once it has stayed open for a moment.
 */

export const BADGE_DELAY_MS = 1200;
export const BADGE_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

export const KEPT_MARK = "✓";

export class KeptCache {
  #entries = new Map<string, { kept: boolean; at: number }>();

  get(url: string, now: number): boolean | undefined {
    const e = this.#entries.get(withoutFragment(url));
    return e && now - e.at < BADGE_TTL_MS ? e.kept : undefined;
  }

  set(url: string, kept: boolean, now: number): void {
    const key = withoutFragment(url);
    this.#entries.delete(key);
    this.#entries.set(key, { kept, at: now });
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Whether a tab's page may be looked up for the automatic mark. */
export function mayLookUp(tab: { url?: string; incognito: boolean }, workspaceOrigin: string | null): boolean {
  return !tab.incognito && workspaceOrigin !== null && isWebPage(tab.url, workspaceOrigin);
}

/** Runs the last request per key after `delay` of quiet: a tab that keeps navigating is asked about once it settles. */
export class Debouncer<K> {
  #timers = new Map<K, ReturnType<typeof setTimeout>>();
  readonly #delay: number;
  constructor(delay: number) { this.#delay = delay; }

  run(key: K, fn: () => void): void {
    const t = this.#timers.get(key);
    if (t) clearTimeout(t);
    this.#timers.set(key, setTimeout(() => { this.#timers.delete(key); fn(); }, this.#delay));
  }
}
