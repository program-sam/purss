import { z } from "zod";
import { assessCapture } from "@purss/connectors";
import type { PartialReason } from "@purss/connectors";
import { measureBytes, newId } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { badRequest, notFound, nowIso } from "../http.ts";
import { admitObject, checkGrowth, markPaused, releaseObject, releaseReservation, reserve, StorageFull } from "./storage.ts";
import { readMinutes, sanitize, toText } from "./content.ts";
import { reindex } from "./items.ts";
import { queueItemImages } from "./images.ts";
import { settledCopy } from "./capture-state.ts";
import { enqueue } from "./jobs.ts";

/** Reserved for a readable-text capture before the job runs; settled to actual bytes. */
export const CAPTURE_RESERVE_BYTES = 1_500_000;

/** Seconds between the automatic captures of one PURSS, so a burst of new items doesn't hammer their sites. */
export const AUTO_CAPTURE_SPACING_SECONDS = 4;

/** Full articles apply to ordinary feeds, followed shared pages included; never to private, video, podcast or hand-kept sources. */
export function fullTextAvailable(source: { kind: string; is_private: number; builtin?: string | null }): boolean {
  // The news source's posts are whole already; their page is this server's.
  return source.is_private === 0 && !source.builtin && (source.kind === "feed" || source.kind === "publication");
}

/** The item has a copy on its way or finished, a partial one included: nothing is fetched by itself again (capture-state.ts). */
const hasCapture = (app: App, itemId: string) => !!app.db.get("SELECT 1 FROM captures WHERE item_id = ? AND status IN ('pending', 'done')", itemId);

/**
 * Queue a readable-text capture of an item's page for Keep, inside the caller's transaction:
 * reserve storage so the copy is sure to fit, record the pending capture and enqueue the job.
 * Returns false when the item already has a capture that is pending or finished (a partial one included, unless `again`: the
 * person tried again, see capture-state.ts), or belongs to a private source (whose pages are never fetched). Throws StorageFull
 * when there is no room. The person asked for this copy, so a failure of it is theirs to hear about.
 */
export function queueCapture(app: App, target: { accountId: string; workspaceId: string; itemId: string; url: string }, opts: { again?: boolean } = {}): boolean {
  if (opts.again ? app.db.get(`SELECT 1 WHERE ${settledCopy("?")}`, target.itemId) : hasCapture(app, target.itemId)) return false;
  if (app.db.get("SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.is_private = 1", target.itemId)) return false;
  const captureId = newId("cap");
  const reservationId = reserve(app, target.accountId, CAPTURE_RESERVE_BYTES, "capture", `capture:${captureId}`);
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, requested, created_at) VALUES (?, ?, ?, 'fulltext', 'pending', 1, ?)", captureId, target.workspaceId, target.itemId, nowIso());
  enqueue(app, "capture.fulltext", { captureId, url: target.url }, { accountId: target.accountId, workspaceId: target.workspaceId, idempotencyKey: `capture:${captureId}:${reservationId}` });
  return true;
}

/**
 * Automatic capture for a full-article source. The copy is optional, so it reserves nothing: a
 * reservation would hold room that the source's own new items need. It is admitted when it
 * completes if there is room then, and dropped otherwise. When the account is already out of room
 * nothing is queued and growth isn't marked paused for it. Each one runs AUTO_CAPTURE_SPACING_SECONDS
 * after the last capture scheduled in the PURSS, so a burst of new items is spread out.
 */
export function queueAutoCapture(app: App, target: { accountId: string; workspaceId: string; itemId: string; url: string | null }): boolean {
  if (!target.url || hasCapture(app, target.itemId)) return false;
  try {
    checkGrowth(app, target.accountId, 1);
  } catch (err) {
    if (err instanceof StorageFull) return false;
    throw err;
  }
  const captureId = newId("cap");
  const last = app.db.get<{ at: string | null }>(
    "SELECT MAX(run_after) AS at FROM jobs WHERE kind = 'capture.fulltext' AND workspace_id = ? AND status IN ('queued', 'leased')", target.workspaceId)!.at;
  const now = Date.now();
  const slot = last && Date.parse(last) > now - AUTO_CAPTURE_SPACING_SECONDS * 1000 ? Date.parse(last) + AUTO_CAPTURE_SPACING_SECONDS * 1000 : now;
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES (?, ?, ?, 'fulltext', 'pending', ?)", captureId, target.workspaceId, target.itemId, nowIso());
  enqueue(app, "capture.fulltext", { captureId, url: target.url }, { accountId: target.accountId, workspaceId: target.workspaceId, idempotencyKey: `capture:${captureId}`, runAfter: new Date(slot).toISOString() });
  return true;
}

const captureResult = z.object({
  ok: z.literal(true),
  title: z.string().max(2000).nullable(),
  text: z.string().max(5_000_000),
  html: z.string().max(5_000_000),
  finalUrl: z.string().max(4000),
  bytes: z.number().int().min(0),
});

/** Settle a readable-text capture against its reservation, inside the caller's transaction. */
export function completeCapture(app: App, captureId: string, raw: unknown): void {
  const cap = app.db.get<{ id: string; item_id: string; workspace_id: string; status: string }>("SELECT id, item_id, workspace_id, status FROM captures WHERE id = ?", captureId);
  if (!cap || cap.status !== "pending") return; // replay-safe
  const reservation = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ? AND settled_at IS NULL AND released_at IS NULL", `capture:${captureId}`);
  const parsed = captureResult.safeParse(raw);
  if (!parsed.success) {
    failCapture(app, captureId, "The page couldn't be read. Its details and feed content are still kept.");
    return;
  }
  const html = sanitize(parsed.data.html) ?? "";
  const ws = app.db.get<{ account_id: string }>("SELECT account_id FROM workspaces WHERE id = ?", cap.workspace_id)!;
  const bytes = measureBytes({ title: parsed.data.title, text: parsed.data.text, html, finalUrl: parsed.data.finalUrl });
  const verdict = assessCapture({ text: parsed.data.text, feedTextLength: feedTextLength(app, cap.item_id) });
  // A try again replaces the copy it has only with a better one (see `betterThan`).
  const earlier = app.db.all<{ id: string; length: number; partial_reason: PartialReason | null }>(
    "SELECT id, length(text) AS length, partial_reason FROM captures WHERE item_id = ? AND id <> ? AND kind = 'fulltext' AND status = 'done' AND quality = 'partial'", cap.item_id, captureId);
  const complete = !!app.db.get("SELECT 1 FROM captures WHERE item_id = ? AND id <> ? AND status = 'done' AND quality IS NOT 'partial'", cap.item_id, captureId);
  if (!verdict.full && (complete || !earlier.every((e) => betterThan({ reason: verdict.reason, length: parsed.data.text.length }, { reason: e.partial_reason ?? "references", length: e.length })))) {
    rejectCapture(app, captureId, verdict.reason);
    emit(app, ws.account_id, { type: "storage" });
    return;
  }
  try {
    // The copy it replaces goes in the same step: if the new one doesn't fit, the earlier one is still there.
    app.db.tx(() => {
      for (const old of earlier) {
        releaseObject(app, "capture", old.id, "replaced by a better copy");
        app.db.run("DELETE FROM captures WHERE id = ?", old.id);
      }
      admitObject(app, { accountId: ws.account_id, workspaceId: cap.workspace_id, kind: "capture", refId: captureId, itemId: cap.item_id, bytes, reason: "readable text capture", reservationId: reservation?.id });
    });
  } catch (err) {
    if (!(err instanceof StorageFull)) throw err;
    // Only a Keep capture holds a reservation; an automatic copy is optional and doesn't pause growth.
    if (reservation) markPaused(app, err);
    failCapture(app, captureId, "There wasn't enough storage for a readable copy. Details and feed content are still kept.");
    return;
  }
  app.db.run("UPDATE captures SET status = 'done', title = ?, text = ?, html = ?, final_url = ?, quality = ?, partial_reason = ?, completed_at = ? WHERE id = ?",
    parsed.data.title, parsed.data.text, html, parsed.data.finalUrl, verdict.full ? "full" : "partial", verdict.full ? null : verdict.reason, nowIso(), captureId);
  // The reading time followed the feed's summary when the item arrived; the readable copy is the article, unless it is only part of the page.
  if (verdict.full) app.db.run("UPDATE items SET read_minutes = ? WHERE id = ? AND kind NOT IN ('video', 'podcast')", readMinutes(parsed.data.text), cap.item_id);
  reindex(app, cap.item_id);
  queueItemImages(app, cap.item_id);
  emit(app, ws.account_id, { type: "storage" });
}

/** The length of the plain text the feed itself gave for an item (its current version), 0 when it gave none. */
function feedTextLength(app: App, itemId: string): number {
  const v = app.db.get<{ content_html: string | null; summary_html: string | null }>(
    "SELECT v.content_html, v.summary_html FROM items i JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?", itemId);
  return toText(v?.content_html || v?.summary_html).length;
}

/** Captures to check per step of the start-up check of earlier captures. */
const CHECK_STEP = 50;

/**
 * Check readable copies saved before captures were checked: one step of up to `size`, returning whether none are left.
 * Each gets the verdict a new capture would get now. Reading time is left as it was.
 */
export function stepCaptureCheck(app: App, size = CHECK_STEP): boolean {
  const rows = app.db.all<{ id: string; item_id: string; text: string | null }>(
    "SELECT id, item_id, text FROM captures WHERE quality IS NULL AND kind = 'fulltext' AND status = 'done' LIMIT ?", size);
  for (const c of rows) {
    const verdict = assessCapture({ text: c.text ?? "", feedTextLength: feedTextLength(app, c.item_id) });
    app.db.run("UPDATE captures SET quality = ?, partial_reason = ? WHERE id = ?", verdict.full ? "full" : "partial", verdict.full ? null : verdict.reason, c.id);
    if (!verdict.full) reindex(app, c.item_id);
  }
  return rows.length < size;
}

/** Check earlier readable copies in the background, a step per turn of the event loop, so the server keeps answering. */
export function startCaptureCheck(app: App): Promise<void> {
  return new Promise((resolve) => {
    const next = () => {
      try {
        if (stepCaptureCheck(app)) return resolve();
      } catch (err) {
        if (!/not open/i.test(String((err as Error)?.message))) console.error("[api] check of earlier captures stopped:", err);
        return resolve();
      }
      setImmediate(next);
    };
    next();
  });
}

/**
 * How much a copy that is only part of the page is worth: a fragment of the article (`short`), then a bibliography (`references`: page
 * content, but not the article), then a wall (`gated`). The reason ranks first and the length only breaks a tie between the same
 * reason, so real text is never replaced by a wall however long the wall is. A full copy beats every partial one.
 */
const PARTIAL_RANK: Record<PartialReason, number> = { short: 3, references: 2, gated: 1 };

/** Whether a new partial copy is better than the earlier one it would replace: a higher rank, or the same reason and a longer body. */
function betterThan(next: { reason: PartialReason; length: number }, earlier: { reason: PartialReason; length: number }): boolean {
  return PARTIAL_RANK[next.reason] > PARTIAL_RANK[earlier.reason] || (next.reason === earlier.reason && next.length > earlier.length);
}

/**
 * A try again that came back no better than the copy the item has. The earlier copy stays, the new text is not kept and the room held
 * for it is given back, but the try is recorded as a failed one (with the reason the page was still partial): the item stays listed
 * and told about as failed to improve, and says so in its panel.
 */
function rejectCapture(app: App, captureId: string, reason: PartialReason): void {
  app.db.run("UPDATE captures SET status = 'failed', error = ?, partial_reason = ?, completed_at = ? WHERE id = ? AND status = 'pending'",
    "The page gave no more than the copy already saved, so that copy stays.", reason, nowIso(), captureId);
  const reservation = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ?", `capture:${captureId}`);
  if (reservation) releaseReservation(app, reservation.id);
}

export function failCapture(app: App, captureId: string, message: string): void {
  const failed = app.db.run("UPDATE captures SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'", message, nowIso(), captureId).changes;
  const reservation = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ?", `capture:${captureId}`);
  if (reservation) releaseReservation(app, reservation.id);
  // Without a readable copy the picture and the feed's own text are what the kept copy has; their pictures are kept too.
  const itemId = failed ? app.db.get<{ item_id: string }>("SELECT item_id FROM captures WHERE id = ?", captureId)?.item_id : undefined;
  if (itemId) queueItemImages(app, itemId);
}

/** Sanitized HTML and plain text of readable HTML a browser sent; null when nothing readable is left. */
export function cleanBrowserHtml(raw: string): { html: string; text: string } | null {
  const html = sanitize(raw) ?? "";
  const text = toText(html);
  return text ? { html, text } : null;
}

/**
 * Store the readable text the person's browser extracted from an item's page (plan/32), inside the
 * caller's transaction. One browser capture per item: a new one replaces the earlier one's text in
 * place (keeping its id, so highlights made on it still name it). It is measured and admitted
 * against storage like a server capture, in its own savepoint: when it doesn't fit, nothing changes
 * (the earlier capture stays) and the reason is returned. It is optional, so a refusal doesn't pause
 * growth. The server fetches nothing.
 */
export function saveBrowserCapture(app: App, target: { accountId: string; workspaceId: string; itemId: string; url: string; title: string | null; html: string; text: string }):
  { saved: boolean; replaced: boolean; note: string | null } {
  const earlier = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND kind = 'browser'", target.itemId);
  const bytes = measureBytes({ title: target.title, text: target.text, html: target.html, finalUrl: target.url });
  try {
    app.db.tx(() => {
      const id = earlier?.id ?? newId("cap");
      if (earlier) releaseObject(app, "capture", id, "browser capture replaced");
      admitObject(app, { accountId: target.accountId, workspaceId: target.workspaceId, kind: "capture", refId: id, itemId: target.itemId, bytes, reason: "browser capture" });
      const now = nowIso();
      if (earlier) {
        app.db.run("UPDATE captures SET status = 'done', title = ?, text = ?, html = ?, final_url = ?, error = NULL, created_at = ?, completed_at = ? WHERE id = ?",
          target.title, target.text, target.html, target.url, now, now, id);
      } else {
        app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, title, text, html, final_url, created_at, completed_at) VALUES (?, ?, ?, 'browser', 'done', ?, ?, ?, ?, ?, ?)",
          id, target.workspaceId, target.itemId, target.title, target.text, target.html, target.url, now, now);
      }
      reindex(app, target.itemId);
      // The replacement text may name pictures the kept copy doesn't have yet, whether or not the item was kept just now.
      queueItemImages(app, target.itemId);
    });
  } catch (err) {
    if (!(err instanceof StorageFull)) throw err;
    return { saved: false, replaced: false, note: earlier
      ? "There isn't enough storage for the new text, so the text captured earlier is kept."
      : "There isn't enough storage for the text, so only the link was kept." };
  }
  emit(app, target.accountId, { type: "storage" });
  return { saved: true, replaced: !!earlier, note: null };
}

/**
 * Try the readable copy of an item again after it failed, or when it is only part of the page. A failed attempt is replaced by
 * the new one, which reserves its storage like any other; a partial copy stays until the new copy completes and takes its
 * place, so a try that fails loses nothing. Nothing is queued when a copy is already pending or complete.
 */
export function retryCapture(app: App, p: Principal, itemId: string): { queued: boolean } {
  return app.db.tx(() => {
    const item = app.db.get<{ id: string; url: string | null; is_private: number | null }>(
      "SELECT i.id, i.url, s.is_private FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.workspace_id = ?", itemId, p.workspaceId);
    if (!item) throw notFound("That item");
    if (app.db.get(`SELECT 1 WHERE ${settledCopy("?")}`, itemId)) return { queued: false };
    if (!app.db.get("SELECT 1 FROM captures WHERE item_id = ? AND (status = 'failed' OR (status = 'done' AND quality = 'partial'))", itemId)) throw badRequest("There is no failed or incomplete copy to try again.");
    if (!item.url) throw badRequest("This item has no page to read.");
    if (item.is_private) throw badRequest("Readable copies aren't made for items from private sources.");
    const queued = queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId, url: item.url }, { again: true });
    // The new attempt takes the failed one's place in "What was kept".
    app.db.run("DELETE FROM captures WHERE item_id = ? AND status = 'failed'", itemId);
    return { queued };
  });
}
