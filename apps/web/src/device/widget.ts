import type { ItemDTO } from "@purss/domain";

/**
 * The home-screen widget's snapshot (plan/38): what the page hands the native side to draw, and what
 * the background job refreshes. Titles and ids only: never the device token or the PURSS's address.
 */

/** How many To read items the widget shows at most. */
export const WIDGET_TO_READ = 5;
/** The request for the widget's To read list: the To read page's own order. The background job sends the same. */
/** Never items of private sources: a widget shows on the home screen and, on iOS, the lock screen (as notifications never name them). */
export const WIDGET_TO_READ_QUERY = { scope: "toread", filter: "active", sort: "newest", limit: WIDGET_TO_READ, exceptPrivate: "1" } as const;

export type WidgetAppearance = "system" | "light" | "dark" | "eink";

/** `loaded`: the player has it now, so a play/pause button can act on it; otherwise a tap opens it. */
export type WidgetEpisode = { id: string; title: string; sourceTitle: string; playing: boolean; loaded: boolean; positionSeconds: number; durationSeconds: number | null };

export type WidgetSnapshot = {
  appearance: WidgetAppearance;
  toRead: { id: string; title: string; sourceTitle: string }[];
  /** How many To read items there are in all, when known. */
  toReadTotal: number | null;
  /** What is playing, or was played last on this device. */
  episode: WidgetEpisode | null;
  updatedAt: string;
};

/** Long titles are cut here; the widget truncates again to fit. */
const MAX_TEXT = 200;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

export type WidgetInput = {
  theme: "system" | "light" | "dark";
  eink: boolean;
  /** The To read list as PURSS answered it, or null when it couldn't be read (the last one is kept). */
  toRead: { items: Pick<ItemDTO, "id" | "title" | "sourceTitle">[]; total: number | null } | null;
  /** The player's current item and state, when it has one. */
  now: { itemId: string; title: string; sourceTitle: string; playing: boolean; position: number; duration: number | null } | null;
  previous: WidgetSnapshot | null;
  at: number;
};

export function buildWidgetSnapshot(input: WidgetInput): WidgetSnapshot {
  const prev = input.previous;
  const toRead = input.toRead
    ? input.toRead.items.slice(0, WIDGET_TO_READ).map((i) => ({ id: i.id, title: clip(i.title.trim() || "Untitled"), sourceTitle: clip(i.sourceTitle) }))
    : prev?.toRead ?? [];
  const toReadTotal = input.toRead ? input.toRead.total : prev?.toReadTotal ?? null;
  const n = input.now;
  const episode: WidgetEpisode | null = n
    ? {
      id: n.itemId, title: clip(n.title.trim() || "Untitled"), sourceTitle: clip(n.sourceTitle), playing: n.playing, loaded: true,
      // While playing, to the minute: the widget is redrawn once a minute at most, not every second.
      positionSeconds: Math.max(0, n.playing ? Math.floor(n.position / 60) * 60 : Math.floor(n.position)),
      durationSeconds: n.duration && n.duration > 0 ? Math.floor(n.duration) : null,
    }
    // The last played episode stays, paused, once the player has nothing loaded.
    : prev?.episode ? { ...prev.episode, playing: false, loaded: false } : null;
  return { appearance: input.eink ? "eink" : input.theme, toRead, toReadTotal, episode, updatedAt: new Date(input.at).toISOString() };
}

/** Read a snapshot this page wrote before; null when there is none or it is damaged. */
export function parseWidgetSnapshot(raw: string | null): WidgetSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WidgetSnapshot;
    return v && Array.isArray(v.toRead) && typeof v.updatedAt === "string" ? v : null;
  } catch { return null; }
}

/** Whether two snapshots draw the same widget (the time aside), so an unchanged one isn't sent again. */
export function sameWidget(a: WidgetSnapshot | null, b: WidgetSnapshot): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: "" }) === JSON.stringify({ ...b, updatedAt: "" });
}
