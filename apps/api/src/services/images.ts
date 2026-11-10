import { createHash } from "node:crypto";
import { z } from "zod";
import { newId } from "@purss/domain";
import { pictureType } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { notFound, nowIso } from "../http.ts";
import { isAccountUsable } from "./deletion.ts";
import { enqueue } from "./jobs.ts";
import { admitObject, checkGrowth, StorageFull } from "./storage.ts";

/*
 * Pictures in kept copies (plan/34). A basket that keeps readable text also keeps the item's own picture and the
 * pictures in its text: the worker fetches them under the same address rules as every other fetch, and each is
 * stored whole in `item_images` and counted in the account's storage as an 'image' object. They belong to the item,
 * so an item in two baskets has one set, counted once; unkeeping it from one basket changes nothing, and from the
 * last it joins the readable copies of items no basket keeps (storage categories). Nothing is evicted to make room:
 * a picture that does not fit is not stored, and the reader keeps showing the original address for it.
 */

/** The longest address a picture job carries (the job's own limit, and no address longer is fetched anyway). */
const MAX_ADDRESS = 2048;

/** What one item may keep. */
export const IMAGES_PER_ITEM = 20;
export const IMAGE_BYTES_PER_ITEM = 10 * 1024 * 1024;

/** Only these are worth keeping: not a tracking pixel, an emoji or an avatar. */
const NOT_A_PICTURE = /\/(?:emoji|smilies|gravatar|avatar)s?\/|s\.w\.org|(?:pixel|spacer|blank|beacon|tracking)\b|[?&/_-]1x1\b/i;

/** A web address a picture job can carry. */
const askable = (address: string) => address.length <= MAX_ADDRESS && /^https?:\/\//i.test(address);

/** The addresses of the pictures in sanitised HTML, in order, each once, as the HTML names them. */
export function pictureAddresses(html: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of html?.matchAll(/<img\b[^>]*>/gi) ?? []) {
    const raw = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
    if (!raw) continue;
    const src = raw.replace(/&amp;/g, "&");
    if (!askable(src) || NOT_A_PICTURE.test(src)) continue;
    const w = Number(/\bwidth="(\d+)"/i.exec(m[0])?.[1] ?? 0);
    const h = Number(/\bheight="(\d+)"/i.exec(m[0])?.[1] ?? 0);
    if ((w && w < 32) || (h && h < 32)) continue;
    if (!out.includes(src)) out.push(src);
  }
  return out;
}

const keepsText = (app: App, itemId: string) =>
  !!app.db.get("SELECT 1 FROM basket_items b JOIN baskets k ON k.id = b.basket_id WHERE b.item_id = ? AND k.capture_mode = 'text'", itemId);

/**
 * Ask for the pictures an item kept with its readable text is still missing, in the caller's transaction: its own
 * picture, the ones in its readable copy and, while it has no complete one, in the text its feed gave. Nothing is queued
 * for an item no text basket keeps, for a private source, when it already has all it may keep, or when storage is full.
 * Returns whether a job was queued. Called when an item is kept, when its readable copy completes or fails, and when
 * the person's browser sends replacement text.
 *
 * The pictures are optional, so asking for them can never break what called: keeping, a copy completing or failing,
 * and the pass that recovers expired leases all run this inside their own transaction. An ordinary error here is undone
 * (the work is its own savepoint) and written to the log, and the caller carries on. If SQLite ended the whole transaction,
 * the error is rethrown: there is nothing left to carry on in.
 */
export function queueItemImages(app: App, itemId: string): boolean {
  const inside = app.db.inTransaction;
  try {
    return app.db.tx(() => queue(app, itemId));
  } catch (err) {
    // SQLite ended the caller's transaction itself (a full disk, I/O trouble): the caller can't carry on, so it must hear of it.
    if (inside && !app.db.inTransaction) throw err;
    console.error(`[api] the pictures of item ${itemId} weren't asked for:`, err);
    return false;
  }
}

function queue(app: App, itemId: string): boolean {
  const item = app.db.get<{ workspace_id: string; image_url: string | null; account_id: string; is_private: number | null }>(
    `SELECT i.workspace_id, i.image_url, w.account_id, s.is_private FROM items i JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`, itemId);
  if (!item || item.is_private || !isAccountUsable(app, item.account_id) || !keepsText(app, itemId)) return false;
  const held = app.db.get<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM item_images WHERE item_id = ?", itemId)!;
  const roomBytes = IMAGE_BYTES_PER_ITEM - held.bytes;
  if (held.n >= IMAGES_PER_ITEM || roomBytes <= 0) return false;

  const copy = app.db.get<{ html: string | null }>(
    "SELECT html FROM captures WHERE item_id = ? AND status = 'done' AND quality IS NOT 'partial' ORDER BY completed_at DESC LIMIT 1", itemId);
  // The reader shows the kept version's text until a complete readable copy takes its place.
  const feed = copy ? null : app.db.get<{ content_html: string | null; summary_html: string | null }>(
    `SELECT v.content_html, v.summary_html FROM basket_items b JOIN item_versions v ON v.id = b.version_id WHERE b.item_id = ? ORDER BY b.kept_at LIMIT 1`, itemId);
  const wanted = [...new Set([...(item.image_url && askable(item.image_url) ? [item.image_url] : []),
    ...pictureAddresses(copy?.html), ...pictureAddresses(feed?.content_html ?? feed?.summary_html)])];
  const have = new Set(app.db.all<{ url: string }>("SELECT url FROM item_images WHERE item_id = ?", itemId).map((r) => r.url));
  const urls = wanted.filter((u) => !have.has(u)).slice(0, IMAGES_PER_ITEM - held.n);
  if (!urls.length) return false;
  try {
    checkGrowth(app, item.account_id, 1);
  } catch (err) {
    if (err instanceof StorageFull) return false;
    throw err;
  }
  const key = createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 16);
  enqueue(app, "capture.images", { itemId, urls, maxBytes: roomBytes },
    { accountId: item.account_id, workspaceId: item.workspace_id, idempotencyKey: `images:${itemId}:${key}`, maxAttempts: 3 });
  return true;
}

const resultSchema = z.object({
  images: z.array(z.object({
    url: z.string().max(2048),
    contentType: z.string().max(100),
    data: z.string().max(Math.ceil(IMAGE_BYTES_PER_ITEM / 3) * 4 + 4),
  })).max(IMAGES_PER_ITEM),
});

/**
 * Store what the worker fetched, in the job's completion transaction. Only the addresses asked for are taken, and each
 * picture is checked again: it must really be a kept format, and the item may not end up with more than
 * IMAGES_PER_ITEM pictures or IMAGE_BYTES_PER_ITEM bytes whatever the worker sent. When one does not fit the account's
 * storage, it and the rest are left out.
 */
export function completeImages(app: App, payload: { itemId: string; urls: string[] }, raw: unknown): void {
  const parsed = resultSchema.safeParse(raw);
  const item = app.db.get<{ workspace_id: string; source_id: string | null; image_url: string | null; account_id: string }>(
    "SELECT i.workspace_id, i.source_id, i.image_url, w.account_id FROM items i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ?", payload.itemId);
  if (!parsed.success || !item) return;
  const asked = new Set(payload.urls);
  let { n, bytes } = app.db.get<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM item_images WHERE item_id = ?", payload.itemId)!;
  let saved = 0;
  for (const image of parsed.data.images) {
    const data = Buffer.from(image.data, "base64");
    const contentType = pictureType(data);
    if (!asked.has(image.url) || !contentType || n >= IMAGES_PER_ITEM || bytes + data.length > IMAGE_BYTES_PER_ITEM) continue;
    if (app.db.get("SELECT 1 FROM item_images WHERE item_id = ? AND url = ?", payload.itemId, image.url)) continue;
    const id = newId("img");
    try {
      admitObject(app, { accountId: item.account_id, workspaceId: item.workspace_id, kind: "image", refId: id, itemId: payload.itemId, sourceId: item.source_id, bytes: data.length, reason: "kept picture" });
    } catch (err) {
      if (!(err instanceof StorageFull)) throw err;
      break; // optional, like an automatic readable copy: it doesn't pause new items
    }
    app.db.run("INSERT INTO item_images (id, item_id, workspace_id, url, role, content_type, bytes, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, payload.itemId, item.workspace_id, image.url, image.url === item.image_url ? "cover" : "inline", contentType, data.length, createHash("sha256").update(data).digest("hex"), data, nowIso());
    n++; bytes += data.length; saved++;
  }
  if (saved) emit(app, item.account_id, { type: "storage" });
}

/** An item's stored pictures by the address they were saved from. */
export function storedPictures(app: App, itemId: string): Map<string, string> {
  return new Map(app.db.all<{ id: string; url: string }>("SELECT id, url FROM item_images WHERE item_id = ?", itemId).map((r) => [r.url, r.id]));
}

export const pictureUrl = (itemId: string, imageId: string) => `/api/items/${encodeURIComponent(itemId)}/images/${encodeURIComponent(imageId)}`;

/** HTML with the pictures that are stored pointing at their stored copies; any other keeps its original address. */
export function withStoredPictures(html: string | null, stored: Map<string, string>, itemId: string): string | null {
  if (!html || !stored.size) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/\bsrc="([^"]+)"/i, (whole, raw: string) => {
    const id = stored.get(raw.replace(/&amp;/g, "&"));
    return id ? `src="${pictureUrl(itemId, id)}"` : whole;
  }));
}

/** One stored picture, for the item's owner. */
export function readPicture(app: App, p: Principal, itemId: string, imageId: string): { data: Uint8Array; contentType: string; sha256: string } {
  const row = app.db.get<{ data: Uint8Array; content_type: string; sha256: string }>(
    "SELECT data, content_type, sha256 FROM item_images WHERE id = ? AND item_id = ? AND workspace_id = ?", imageId, itemId, p.workspaceId);
  if (!row) throw notFound("That picture");
  return { data: row.data, contentType: row.content_type, sha256: row.sha256 };
}
