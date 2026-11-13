import type { ListSearch, Place } from "../nav.ts";

/**
 * The home-screen panels (plan/38). Their lists (To read, To listen, New, a chosen collection or source) are
 * fetched by the native side, which knows which panels are placed; the page hands it only what it alone knows:
 * the look and the episode the player has. Titles and ids only: never the device token or the PURSS's address.
 */

export type WidgetAppearance = "system" | "light" | "dark" | "eink";

/** `loaded`: the player has it now, so a play/pause button can act on it; otherwise a tap opens it. */
export type WidgetEpisode = { id: string; title: string; sourceTitle: string; playing: boolean; loaded: boolean; positionSeconds: number; durationSeconds: number | null };

export type WidgetSnapshot = {
  appearance: WidgetAppearance;
  /** What is playing, or was played last on this device (the To listen panel). */
  episode: WidgetEpisode | null;
  updatedAt: string;
};

/** Long titles are cut here; the panel truncates again to fit. */
const MAX_TEXT = 200;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

export type WidgetInput = {
  theme: "system" | "light" | "dark";
  eink: boolean;
  /** The player's current item and state, when it has one. */
  now: { itemId: string; title: string; sourceTitle: string; playing: boolean; position: number; duration: number | null } | null;
  previous: WidgetSnapshot | null;
  at: number;
};

export function buildWidgetSnapshot(input: WidgetInput): WidgetSnapshot {
  const prev = input.previous;
  const n = input.now;
  const episode: WidgetEpisode | null = n
    ? {
      id: n.itemId, title: clip(n.title.trim() || "Untitled"), sourceTitle: clip(n.sourceTitle), playing: n.playing, loaded: true,
      // While playing, to the minute: the panel is redrawn once a minute at most, not every second.
      positionSeconds: Math.max(0, n.playing ? Math.floor(n.position / 60) * 60 : Math.floor(n.position)),
      durationSeconds: n.duration && n.duration > 0 ? Math.floor(n.duration) : null,
    }
    // The last played episode stays, paused, once the player has nothing loaded.
    : prev?.episode ? { ...prev.episode, playing: false, loaded: false } : null;
  return { appearance: input.eink ? "eink" : input.theme, episode, updatedAt: new Date(input.at).toISOString() };
}

/** Read a snapshot this page wrote before; null when there is none or it is damaged. */
export function parseWidgetSnapshot(raw: string | null): WidgetSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WidgetSnapshot;
    return v && typeof v.appearance === "string" && typeof v.updatedAt === "string" && (v.episode === null || typeof v.episode === "object") ? v : null;
  } catch { return null; }
}

/** Whether two snapshots draw the same panels (the time aside), so an unchanged one isn't sent again. */
export function sameWidget(a: WidgetSnapshot | null, b: WidgetSnapshot): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: "" }) === JSON.stringify({ ...b, updatedAt: "" });
}

/** A panel's list: `toread`, `tolisten`, `new`, `collection:<id>` or `source:<id>` (apps/mobile/widget-lists.json). */
const LIST_KEY = /^(toread|tolisten|new|(collection|source):[a-z0-9_]{1,64})$/;

export function isWidgetList(key: string | null | undefined): key is string {
  return !!key && LIST_KEY.test(key);
}

/**
 * Where a panel's heading leads: the list it shows, with the same items. To read and To listen are the
 * reading list limited to their item types (To listen oldest first, as Home's row); a collection or source
 * its Active list. New has no page of its own: it opens Home.
 */
export function widgetListPlace(key: string): { place: Place; search?: ListSearch } | null {
  if (!isWidgetList(key)) return null;
  if (key === "toread") return { place: { t: "r", id: "toread" }, search: { type: "articles,videos" } };
  if (key === "tolisten") return { place: { t: "r", id: "toread" }, search: { type: "podcasts", sort: "oldest" } };
  if (key === "new") return { place: { t: "home" } };
  const [kind, id] = key.split(":") as [string, string];
  return { place: { t: kind === "collection" ? "c" : "s", id }, search: { filter: "active" } };
}
