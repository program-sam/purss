import type { ActivityDTO, ActivityEvent, ActivitySource, SourceHealth } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { syncDelaySeconds } from "./failures.ts";

/*
 * What the engine has been doing for this PURSS, in plain words: checking sources, setting new ones up,
 * saving readable copies, what arrived and what went wrong. Built from the job queue, the sync checkpoint and the
 * items themselves; nothing here is stored for the purpose. The web app refreshes it on events and at most
 * every 30 seconds.
 */

const DAY_MS = 86_400_000;
const MAX_EVENTS = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type SourceRow = {
  id: string; title: string; health: SourceHealth; health_text: string | null; paused: number; paused_until: string | null;
  engine_stream_id: string | null; last_item_at: string | null; created_at: string;
};

export function activityFor(app: App, p: Principal, now: Date = new Date()): ActivityDTO {
  const ws = p.workspaceId;
  const iso = now.toISOString();
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const jobs = (kind: string) => app.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND kind = ? AND (status = 'leased' OR (status = 'queued' AND run_after <= ?))", p.accountId, kind, iso)!.n;
  const cp = app.db.get<{ last_success_at: string | null; last_attempt_at: string | null; last_error: string | null; consecutive_failures: number }>(
    `SELECT c.last_success_at, c.last_attempt_at, c.last_error, c.consecutive_failures FROM sync_checkpoints c JOIN engine_users e ON e.id = c.engine_user_id WHERE e.account_id = ?`, p.accountId);
  const sources = app.db.all<SourceRow>(
    `SELECT id, title, health, health_text, paused, paused_until, engine_stream_id, last_item_at, created_at FROM sources
     WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual' ORDER BY lower(title)`, ws);
  const arrived = new Map(app.db.all<{ source_id: string; n: number; at: string }>(
    "SELECT source_id, COUNT(*) AS n, MAX(discovered_at) AS at FROM items WHERE workspace_id = ? AND discovered_at >= ? AND source_id IS NOT NULL GROUP BY source_id", ws, since)
    .map((r) => [r.source_id, r]));
  const titles = new Map(sources.map((s) => [s.id, s.title]));

  const savingText = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ? AND status = 'pending'", ws)!.n;
  const lastChecked = cp?.last_success_at ?? null;

  const rows: ActivitySource[] = sources.map((s) => {
    let note: string | null = null;
    if (s.paused) note = s.paused_until ? `Paused until ${new Date(s.paused_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}` : "Paused";
    else if (s.health === "error" || s.health === "reconnect" || s.health === "login") note = s.health_text;
    else if (!s.engine_stream_id) note = "Setting up…";
    else if (s.health === "pending") note = "Waiting for its first items";
    const checkable = !!s.engine_stream_id && !s.paused && s.health !== "error";
    return { id: s.id, title: s.title, health: s.health, note, lastCheckedAt: checkable ? lastChecked : null, lastItemAt: s.last_item_at, arrived: arrived.get(s.id)?.n ?? 0 };
  });

  const events: ActivityEvent[] = [];
  for (const [sourceId, a] of arrived) {
    const title = titles.get(sourceId);
    if (title) events.push({ at: a.at, kind: "arrived", sourceId, text: `${plural(a.n, "new item")} from ${title}` });
  }
  for (const s of sources) {
    if (s.created_at >= since && s.engine_stream_id) events.push({ at: s.created_at, kind: "subscribed", sourceId: s.id, text: `Started following ${s.title}` });
    if (s.health === "error" || s.health === "reconnect") events.push({ at: lastChecked ?? s.created_at, kind: "problem", sourceId: s.id, text: `${s.title}: ${s.health_text ?? "couldn't be collected"}` });
  }
  for (const c of app.db.all<{ status: string; n: number; at: string }>(
    "SELECT status, COUNT(*) AS n, MAX(completed_at) AS at FROM captures WHERE workspace_id = ? AND completed_at >= ? AND status IN ('done', 'failed') GROUP BY status", ws, since)) {
    if (c.status === "done") events.push({ at: c.at, kind: "saved", sourceId: null, text: `Saved the text of ${plural(c.n, "item")}` });
    else events.push({ at: c.at, kind: "save_failed", sourceId: null, text: `Couldn't save the text of ${plural(c.n, "item")}` });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1));

  const next = cp?.last_attempt_at
    ? new Date(Date.parse(cp.last_attempt_at) + syncDelaySeconds(app.config.syncIntervalSeconds, cp.consecutive_failures ?? 0) * 1000).toISOString()
    : null;
  return {
    checking: jobs("engine.sync") > 0,
    sourceCount: sources.filter((s) => s.engine_stream_id && !s.paused).length,
    subscribing: jobs("engine.subscribe"),
    savingText,
    lastCheckedAt: lastChecked,
    nextCheckAt: next,
    problem: cp?.last_error ?? null,
    sources: rows,
    events: events.slice(0, MAX_EVENTS),
  };
}

