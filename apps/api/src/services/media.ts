import { linkIsMediaFile, pickMediaEnclosure } from "@purss/domain";
import type { Enclosure, ItemMedia, PlaybackPosition } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { notFound, nowIso } from "../http.ts";
import { STATE_RECORD_BYTES, admitObject } from "./storage.ts";
import { server } from "@purss/translations/server";

/*
 * Item media and playback. The server only reports the audio or video file an item's feed
 * offers and remembers where playback stopped; it never downloads or stores the file. Players and
 * the apps' device downloads fetch it from the publisher.
 */

/** The item's media as shown to its owner; null for private sources (their file addresses can carry a secret). */
export function itemMedia(enclosuresJson: string | null, isPrivate: boolean): ItemMedia | null {
  if (isPrivate) return null;
  let list: Enclosure[] = [];
  try { list = JSON.parse(enclosuresJson ?? "[]") as Enclosure[]; } catch { /* stored by us; treat as none */ }
  const m = pickMediaEnclosure(Array.isArray(list) ? list : []);
  return m ? { url: m.url, kind: m.kind, type: m.type, length: m.length } : null;
}

/** Whether the item's own link is its audio or video file, from the enclosures as stored: asked of private sources too, whose files `itemMedia` withholds. */
export function itemLinkIsMedia(url: string | null, enclosuresJson: string | null): boolean {
  let list: Enclosure[] = [];
  try { list = JSON.parse(enclosuresJson ?? "[]") as Enclosure[]; } catch { /* stored by us; treat as none */ }
  return linkIsMediaFile(url, Array.isArray(list) ? list : []);
}

// ---------------------------------------------------------------- playback position

export function getPlayback(app: App, accountId: string, itemId: string): PlaybackPosition | null {
  const r = app.db.get<{ position_seconds: number; duration_seconds: number | null; updated_at: string }>(
    "SELECT position_seconds, duration_seconds, updated_at FROM playback_positions WHERE item_id = ? AND account_id = ?", itemId, accountId);
  return r ? { positionSeconds: r.position_seconds, durationSeconds: r.duration_seconds, updatedAt: r.updated_at } : null;
}

/**
 * Save where playback stopped. Separate from reading progress, workflow and baskets. The position
 * recorded last wins: one sent late (`recordedAt`, from a device that played offline) replaces the
 * stored one only if it was recorded after it, so a stale write never overwrites a newer position.
 * A recording time ahead of the server's clock counts as now. Counted as one small record, admitted
 * with the control headroom like other state. Returns the stored position, which is the newer one.
 */
export function savePlayback(app: App, p: Principal, itemId: string, input: { positionSeconds: number; durationSeconds: number | null; recordedAt?: string }, now: Date = new Date()): PlaybackPosition {
  const position = input.durationSeconds !== null ? Math.min(input.positionSeconds, input.durationSeconds) : input.positionSeconds;
  const recorded = input.recordedAt ? new Date(input.recordedAt) : now;
  const at = (Number.isNaN(recorded.getTime()) || recorded > now ? now : recorded).toISOString();
  app.db.tx(() => {
    if (!app.db.get("SELECT 1 FROM items WHERE id = ? AND account_id = ?", itemId, p.accountId)) throw notFound(server.api.shared.thatItem);
    app.db.run(
      `INSERT INTO playback_positions (item_id, account_id, position_seconds, duration_seconds, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET position_seconds = excluded.position_seconds, duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds), updated_at = excluded.updated_at
       WHERE excluded.updated_at >= playback_positions.updated_at`,
      itemId, p.accountId, position, input.durationSeconds, at);
    const key = `playback:${itemId}`;
    if (!app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'record' AND ref_id = ? AND released_at IS NULL", key)) {
      admitObject(app, { accountId: p.accountId, kind: "record", refId: key, itemId, bytes: STATE_RECORD_BYTES, reason: "playback position", control: true });
    }
  });
  return getPlayback(app, p.accountId, itemId)!;
}

/** Called inside deleteItemNow's transaction: drop the item's playback position (its ledger record is released with the item's other objects). */
export function forgetPlayback(app: App, itemId: string): void {
  app.db.run("DELETE FROM playback_positions WHERE item_id = ?", itemId);
}
