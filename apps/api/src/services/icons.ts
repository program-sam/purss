import { createHash } from "node:crypto";
import { z } from "zod";
import { isStoredIcon, MAX_ICON_BYTES } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { addSeconds, notFound, nowIso } from "../http.ts";
import { enqueue } from "./jobs.ts";
import { usableAccountSql } from "./deletion.ts";

/**
 * Source icons. The worker looks for an icon (feed image, YouTube avatar, the site's own icons)
 * and posts back a small WebP it has re-encoded. The API checks the bytes again, stores one per
 * source and serves it to that PURSS only. A new source is looked up within a tick; every
 * source is checked again weekly. A check that finds nothing keeps the icon already stored. The
 * installation's news source is never looked up: it has the app's icon (services/news.ts).
 */

const RECHECK_SECONDS = 7 * 86_400;
const SWEEP_BATCH = 20;

/** Queue icon checks for sources never checked or not checked for a week. */
export function scheduleIconChecks(app: App): void {
  const due = app.db.all<{ id: string; account_id: string; workspace_id: string; kind: string; feed_url: string | null; site_url: string | null; is_private: number }>(
    `SELECT id, account_id, workspace_id, kind, feed_url, site_url, is_private FROM sources
     WHERE followed = 1 AND kind <> 'manual' AND builtin IS NULL AND (icon_checked_at IS NULL OR icon_checked_at < ?)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'icon:' || sources.id AND j.status IN ('queued', 'leased'))
       AND ${usableAccountSql("sources.account_id")}
     ORDER BY icon_checked_at IS NOT NULL, icon_checked_at LIMIT ?`, addSeconds(-RECHECK_SECONDS), SWEEP_BATCH);
  for (const s of due) {
    enqueue(app, "source.icon", { sourceId: s.id, kind: s.kind, feedUrl: s.is_private || s.feed_url?.startsWith("bridge:") ? null : s.feed_url, siteUrl: s.site_url },
      { accountId: s.account_id, workspaceId: s.workspace_id, idempotencyKey: `icon:${s.id}`, maxAttempts: 2 });
  }
}

const iconResultSchema = z.union([
  z.object({ found: z.literal(true), data: z.string().max(Math.ceil(MAX_ICON_BYTES / 3) * 4), from: z.string().max(4000) }).passthrough(),
  z.object({ found: z.literal(false) }).passthrough(),
]);

/** Store the worker's answer. Bytes that aren't a small WebP are dropped, never stored or served. */
export function completeIconCheck(app: App, sourceId: string, result: unknown): void {
  // The installation's news source has the app's icon (services/news.ts); nothing found elsewhere replaces it.
  const s = app.db.get<{ account_id: string; workspace_id: string }>("SELECT account_id, workspace_id FROM sources WHERE id = ? AND builtin IS NULL", sourceId);
  if (!s) return;
  const now = nowIso();
  app.db.run("UPDATE sources SET icon_checked_at = ? WHERE id = ?", now, sourceId);
  const parsed = iconResultSchema.safeParse(result);
  if (!parsed.success || !parsed.data.found) return;
  const bytes = Buffer.from(parsed.data.data, "base64");
  if (!isStoredIcon(bytes)) return;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const current = app.db.get<{ digest: string }>("SELECT digest FROM source_icons WHERE source_id = ?", sourceId);
  if (current?.digest === digest) {
    app.db.run("UPDATE source_icons SET updated_at = ? WHERE source_id = ?", now, sourceId);
    return;
  }
  app.db.run(
    `INSERT INTO source_icons (source_id, account_id, workspace_id, bytes, digest, found_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET bytes = excluded.bytes, digest = excluded.digest, found_url = excluded.found_url, updated_at = excluded.updated_at`,
    sourceId, s.account_id, s.workspace_id, bytes, digest, parsed.data.from, now);
  emit(app, s.account_id, { type: "source", sourceId });
}

/** The lookup failed outright (after its retry): wait a week like any other check. */
export function failIconCheck(app: App, sourceId: string): void {
  app.db.run("UPDATE sources SET icon_checked_at = ? WHERE id = ?", nowIso(), sourceId);
}

/** Address of a source's icon, versioned by its digest so browsers may cache it for good. */
export function iconUrl(sourceId: string, digest: string | null): string | null {
  return digest ? `/api/sources/${encodeURIComponent(sourceId)}/icon?v=${digest.slice(0, 16)}` : null;
}

export function readIcon(app: App, p: Principal, sourceId: string): { bytes: Uint8Array; digest: string } {
  const row = app.db.get<{ bytes: Uint8Array; digest: string }>("SELECT bytes, digest FROM source_icons WHERE source_id = ? AND workspace_id = ?", sourceId, p.workspaceId);
  if (!row) throw notFound("That icon");
  return row;
}
