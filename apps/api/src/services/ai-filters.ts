import { AI_FILTER_PREVIEW_POSTS, dropsPost, judgeQuestionKey, newId, parseJudgeQuestionKey } from "@purss/domain";
import type { AiFilterDTO, AiFilterPreview, AiFilterRule, AiFilterScope, AiJudgeInput, AiJudgeRequest, AiJudgeResult, WhenUnsure, WorkflowState } from "@purss/domain";
import { askJevEach, jevKeyFingerprint, JevError } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { HttpError, badRequest, notFound, nowIso } from "../http.ts";
import { aiSettings, keyFor, markKeyRejected, recordUsage, serverKeyReady } from "./ai-access.ts";
import { enqueue } from "./jobs.ts";
import { notifyArrivals } from "./notifications.ts";
import { setWorkflowByFilter } from "./state.ts";

/*
 * Smart filters (plan/36). A filter holds the person's words for which posts of a source, or of every source in a collection, to
 * keep. New posts of those sources are judged in the background (job filter.judge): the worker asks Jev, and a post a filter
 * drops is marked Ignored if it is still Undecided and nobody has opened or kept it. A changed or newly added filter re-checks
 * the recent Undecided posts, and gives back the posts it dropped earlier that it would now keep, unless they were touched since.
 * Filters run on the server's Jev key, which an administrator sets (hosted: for accounts on Pro); without it, posts simply stay as they are.
 */

type Owner = Pick<Principal, "accountId" | "workspaceId">;
type FilterRow = { id: string; workspace_id: string; source_id: string | null; collection_id: string | null; keep_text: string; drop_text: string | null; when_unsure: WhenUnsure; enabled: number; version: number; created_at: string; updated_at: string };

/** Posts per filter.judge job. */
const JUDGE_BATCH = 20;
/** A filter that is added or changed re-checks the Undecided posts of this many days, at most RECHECK_MAX of them. */
const RECHECK_DAYS = 30;
const RECHECK_MAX = 500;
/** How many Jev requests a preview runs at once. */
const PREVIEW_CONCURRENCY = 5;

// ---------- filters ----------

function scopeOf(app: App, p: Owner, scope: AiFilterScope): { column: "source_id" | "collection_id"; id: string } {
  if ("sourceId" in scope) {
    if (!app.db.get("SELECT 1 FROM sources WHERE id = ? AND workspace_id = ? AND kind <> 'manual'", scope.sourceId, p.workspaceId)) throw notFound("That source");
    return { column: "source_id", id: scope.sourceId };
  }
  const c = app.db.get<{ mode: string }>("SELECT mode FROM collections WHERE id = ? AND workspace_id = ?", scope.collectionId, p.workspaceId);
  if (!c) throw notFound("That collection");
  if (c.mode !== "sources") throw badRequest("Only a collection of sources can have a Smart filter.", "not_sources");
  return { column: "collection_id", id: scope.collectionId };
}

function toDTO(app: App, r: FilterRow): AiFilterDTO {
  const counts = app.db.get<{ judged: number; dropped: number }>(
    `SELECT COUNT(*) AS judged, COALESCE(SUM(v.dropped = 1 AND st.workflow = 'ignored' AND ${UNTOUCHED}), 0) AS dropped
     FROM ai_filter_verdicts v JOIN item_state st ON st.item_id = v.item_id WHERE v.filter_id = ?`, r.id)!;
  return {
    id: r.id,
    scope: r.source_id ? { sourceId: r.source_id } : { collectionId: r.collection_id! },
    keep: r.keep_text,
    drop: r.drop_text,
    whenUnsure: r.when_unsure,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    judgedCount: counts.judged,
    droppedCount: counts.dropped,
  };
}

function filterRow(app: App, p: Owner, scope: AiFilterScope): FilterRow | undefined {
  const s = scopeOf(app, p, scope);
  return app.db.get<FilterRow>(`SELECT * FROM ai_filters WHERE ${s.column} = ? AND workspace_id = ?`, s.id, p.workspaceId);
}

export function getFilter(app: App, p: Principal, scope: AiFilterScope): AiFilterDTO | null {
  const r = filterRow(app, p, scope);
  return r ? toDTO(app, r) : null;
}

/** Every filter of the PURSS, for the source and collection lists. */
export function listFilters(app: App, p: Principal): AiFilterDTO[] {
  return app.db.all<FilterRow>("SELECT * FROM ai_filters WHERE workspace_id = ? ORDER BY created_at", p.workspaceId).map((r) => toDTO(app, r));
}

/** Add or change the filter of a source or collection. New words, or turning it on, re-check the recent posts. */
export function saveFilter(app: App, p: Principal, scope: AiFilterScope, rule: AiFilterRule & { enabled: boolean }): AiFilterDTO {
  const saved = app.db.tx(() => {
    const s = scopeOf(app, p, scope);
    const now = nowIso();
    const before = app.db.get<FilterRow>(`SELECT * FROM ai_filters WHERE ${s.column} = ? AND workspace_id = ?`, s.id, p.workspaceId);
    let id: string;
    let recheck: boolean;
    if (!before) {
      id = newId("aif");
      app.db.run(`INSERT INTO ai_filters (id, workspace_id, ${s.column}, keep_text, drop_text, when_unsure, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        id, p.workspaceId, s.id, rule.keep, rule.drop, rule.whenUnsure, rule.enabled ? 1 : 0, now, now);
      recheck = rule.enabled;
    } else {
      id = before.id;
      const changed = before.keep_text !== rule.keep || before.drop_text !== rule.drop || before.when_unsure !== rule.whenUnsure;
      app.db.run("UPDATE ai_filters SET keep_text = ?, drop_text = ?, when_unsure = ?, enabled = ?, version = version + ?, updated_at = ? WHERE id = ?",
        rule.keep, rule.drop, rule.whenUnsure, rule.enabled ? 1 : 0, changed ? 1 : 0, now, id);
      recheck = rule.enabled && (changed || before.enabled === 0);
    }
    if (recheck) queueRecheck(app, p, id);
    return app.db.get<FilterRow>("SELECT * FROM ai_filters WHERE id = ?", id)!;
  });
  emit(app, p.accountId, { type: "jobs" });
  return toDTO(app, saved);
}

/** Remove a filter. The posts it marked Ignored stay Ignored; the person can change them back there. */
export function deleteFilter(app: App, p: Principal, scope: AiFilterScope): void {
  app.db.tx(() => {
    const r = filterRow(app, p, scope);
    if (!r) throw notFound("That filter");
    removeFilterRows(app, r.id);
  });
}

function removeFilterRows(app: App, filterId: string): void {
  app.db.run("DELETE FROM ai_filter_verdicts WHERE filter_id = ?", filterId);
  app.db.run("DELETE FROM ai_filters WHERE id = ?", filterId);
}

/**
 * SQL over `item_state st`: nobody but a filter has changed the post's workflow or progress. The revision moves with every such
 * change; a filter's own change records the revision it left (applied_revision, on all the post's answers), so the post is
 * untouched while its revision is still that, or still 0 when no filter has changed it.
 */
const UNTOUCHED = `st.revision = COALESCE((SELECT MAX(v2.applied_revision) FROM ai_filter_verdicts v2 WHERE v2.item_id = st.item_id), 0)`;

/** The sources a filter covers. */
function filterSourcesSql(): string {
  return `SELECT f.source_id AS source_id FROM ai_filters f WHERE f.id = ? AND f.source_id IS NOT NULL
          UNION SELECT cs.source_id FROM ai_filters f JOIN collection_sources cs ON cs.collection_id = f.collection_id WHERE f.id = ?`;
}

function queueRecheck(app: App, owner: Owner, filterId: string): void {
  if (!keyFor(app, owner)) return;
  const since = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString();
  const undecided = app.db.all<{ id: string }>(
    `SELECT i.id FROM items i JOIN item_state st ON st.item_id = i.id
     WHERE i.workspace_id = ? AND i.source_id IN (${filterSourcesSql()}) AND st.workflow = 'new' AND st.opened_at IS NULL AND ${UNTOUCHED}
       AND i.discovered_at >= ? AND NOT EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id)
     ORDER BY i.discovered_at DESC LIMIT ${RECHECK_MAX}`, owner.workspaceId, filterId, filterId, since).map((r) => r.id);
  // What this filter dropped and nobody has touched since: a looser filter gives it back.
  const dropped = app.db.all<{ id: string }>(
    `SELECT v.item_id AS id FROM ai_filter_verdicts v JOIN item_state st ON st.item_id = v.item_id
     WHERE v.filter_id = ? AND v.dropped = 1 AND st.workflow = 'ignored' AND st.opened_at IS NULL AND ${UNTOUCHED}
       AND NOT EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = v.item_id) ORDER BY v.judged_at DESC LIMIT ${RECHECK_MAX}`, filterId).map((r) => r.id);
  queueJudging(app, owner, [...new Set([...undecided, ...dropped])], false);
}

/** Queue judging for these posts, in jobs of JUDGE_BATCH. `announce`: they arrived just now, and the posts that stay are announced. */
function queueJudging(app: App, owner: Owner, itemIds: readonly string[], announce: boolean): void {
  for (let i = 0; i < itemIds.length; i += JUDGE_BATCH) {
    enqueue(app, "filter.judge", { itemIds: itemIds.slice(i, i + JUDGE_BATCH), announce }, { accountId: owner.accountId, workspaceId: owner.workspaceId, maxAttempts: 4 });
  }
}

/** Sources of the PURSS that an enabled filter covers. */
function filteredSources(app: App, workspaceId: string): Set<string> {
  return new Set(app.db.all<{ source_id: string }>(
    `SELECT source_id FROM ai_filters WHERE workspace_id = ? AND enabled = 1 AND source_id IS NOT NULL
     UNION SELECT cs.source_id FROM ai_filters f JOIN collection_sources cs ON cs.collection_id = f.collection_id WHERE f.workspace_id = ? AND f.enabled = 1`,
    workspaceId, workspaceId).map((r) => r.source_id));
}

/**
 * Called by a sync batch, in its transaction, with the posts it created: the new ones (not a source's back catalogue) of filtered
 * sources are queued for judging. Returns the sources whose arrivals the judging will announce instead of the sync (so a post a
 * filter drops never shows up as a notification).
 */
export function queueNewPosts(app: App, owner: Owner, created: readonly { itemId: string; sourceId: string }[]): Set<string> {
  if (!created.length) return new Set();
  const covered = filteredSources(app, owner.workspaceId);
  if (!covered.size || !keyFor(app, owner)) return new Set();
  const mine = created.filter((c) => covered.has(c.sourceId));
  queueJudging(app, owner, mine.map((c) => c.itemId), true);
  return new Set(mine.map((c) => c.sourceId));
}

// ---------- judging ----------

type PostRow = { id: string; source_id: string | null; title: string; author: string | null; excerpt: string | null; source_title: string | null };

function postState(r: PostRow): AiJudgeRequest["state"] {
  return { source: r.source_title, title: r.title.slice(0, 500), author: r.author?.slice(0, 200) ?? null, summary: r.excerpt?.slice(0, 1500) ?? null };
}

/** The yes/no question Jev answers for one filter: "true" is a post the person keeps. */
export function questionFor(rule: Pick<AiFilterRule, "keep" | "drop">): AiJudgeRequest["questions"][string] {
  return {
    type: "noul",
    instructions: "A reader filters the posts of a feed. Following the reader's description below, should this post stay in their feed?",
    criteria: {
      true: `The reader keeps posts that: ${rule.keep}`,
      false: rule.drop ? `The reader drops posts that: ${rule.drop}` : "The post is not what the reader asked to keep.",
    },
  };
}

/** Enabled filters per source, for the sources of these posts. */
function filtersBySource(app: App, workspaceId: string, sourceIds: readonly string[]): Map<string, FilterRow[]> {
  const out = new Map<string, FilterRow[]>();
  if (!sourceIds.length) return out;
  const rows = app.db.all<FilterRow & { covered: string }>(
    `SELECT f.*, j.value AS covered FROM json_each(?) j JOIN ai_filters f ON f.workspace_id = ? AND f.enabled = 1
       AND (f.source_id = j.value OR f.collection_id IN (SELECT collection_id FROM collection_sources WHERE source_id = j.value))`,
    JSON.stringify([...new Set(sourceIds)]), workspaceId);
  for (const r of rows) out.set(r.covered, [...(out.get(r.covered) ?? []), r]);
  return out;
}

/** What the worker asks Jev for a filter.judge job, as the filters are now. */
export function judgeInput(app: App, job: { account_id: string | null; workspace_id: string | null; payload: string }): AiJudgeInput {
  const model = app.config.jev.model;
  if (!job.account_id || !job.workspace_id) return { route: null, model, requests: [] };
  const owner = { accountId: job.account_id, workspaceId: job.workspace_id };
  if (!keyFor(app, owner)) return { route: null, model, requests: [] };
  const { itemIds } = JSON.parse(job.payload) as { itemIds: string[] };
  const posts = app.db.all<PostRow>(
    `SELECT i.id, i.source_id, i.title, i.author, i.excerpt, s.title AS source_title FROM json_each(?) j JOIN items i ON i.id = j.value
     LEFT JOIN sources s ON s.id = i.source_id WHERE i.workspace_id = ?`, JSON.stringify(itemIds), owner.workspaceId);
  const filters = filtersBySource(app, owner.workspaceId, posts.map((r) => r.source_id).filter((s): s is string => !!s));
  const requests: AiJudgeRequest[] = [];
  for (const post of posts) {
    const applying = post.source_id ? filters.get(post.source_id) ?? [] : [];
    if (!applying.length) continue;
    const questions: AiJudgeRequest["questions"] = {};
    for (const f of applying) questions[judgeQuestionKey(f.id, f.version)] = questionFor({ keep: f.keep_text, drop: f.drop_text });
    requests.push({ itemId: post.id, state: postState(post), questions });
  }
  return { route: "server", model, requests };
}

type ItemNow = { id: string; source_id: string | null; workflow: WorkflowState; revision: number; fresh: number; opened_at: string | null; kept: number };

/**
 * The worker's answers for a filter.judge job. Answers to a filter's older words are left out. Then each post is marked Ignored
 * when a filter drops it and it is still Undecided, unopened and unkept; or given back (Undecided) when no filter drops it any
 * more and it is still as a filter left it. The posts that stay are announced, like a sync announces new posts.
 */
export function completeJudging(app: App, job: { account_id: string | null; workspace_id: string | null; payload: string }, result: AiJudgeResult): void {
  if (!job.account_id || !job.workspace_id) return;
  const owner = { accountId: job.account_id, workspaceId: job.workspace_id };
  const { itemIds } = JSON.parse(job.payload) as { itemIds: string[] };
  if (result.keyRejected && result.route) {
    markKeyRejected(app, result.keyFingerprint);
    console.warn("[api] Jev refused the server's Jev key (Admin → Smart filters); filters that use it are waiting");
  }
  // Posts Jev couldn't be asked about are asked again a minute later (the worker reports some only when others got answers).
  const unfinished = result.unfinished.filter((id) => itemIds.includes(id));
  const announce = (JSON.parse(job.payload) as { announce?: boolean }).announce === true;
  if (unfinished.length && !result.keyRejected) {
    enqueue(app, "filter.judge", { itemIds: unfinished, announce }, { accountId: owner.accountId, workspaceId: owner.workspaceId, maxAttempts: 4, runAfter: new Date(Date.now() + 60_000).toISOString() });
  }
  if (result.route) recordUsage(app, owner.accountId, result.verdicts.reduce((n, v) => n + v.inputTokens, 0), result.verdicts.length);

  const filters = new Map(app.db.all<FilterRow>("SELECT * FROM ai_filters WHERE workspace_id = ?", owner.workspaceId).map((f) => [f.id, f]));
  const now = nowIso();
  for (const v of result.verdicts) {
    if (!itemIds.includes(v.itemId)) continue;
    for (const [key, p] of Object.entries(v.answers)) {
      const k = parseJudgeQuestionKey(key);
      const f = k && filters.get(k.filterId);
      if (!f || f.version !== k.version || !f.enabled) continue;
      app.db.run(
        `INSERT INTO ai_filter_verdicts (filter_id, item_id, workspace_id, version, keep_probability, dropped, applied_revision, judged_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(filter_id, item_id) DO UPDATE SET version = excluded.version, keep_probability = excluded.keep_probability, dropped = excluded.dropped, judged_at = excluded.judged_at`,
        f.id, v.itemId, owner.workspaceId, f.version, p, dropsPost(p, f.when_unsure) ? 1 : 0, now);
    }
  }

  const kept = new Map<string, number>();
  const keptIds: string[] = [];
  const keep = (sourceId: string | null, itemId: string) => {
    if (!sourceId) return;
    kept.set(sourceId, (kept.get(sourceId) ?? 0) + 1);
    keptIds.push(itemId);
  };
  // No key to ask with: the posts stay as they are and are announced as a sync would have.
  const unjudged = result.route === null || result.keyRejected === true;
  let changed = false;
  for (const itemId of itemIds) {
    if (unfinished.includes(itemId) && !result.keyRejected) continue;
    const item = app.db.get<ItemNow>(
      `SELECT i.id, i.source_id, st.workflow, st.revision, st.fresh, st.opened_at, EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id) AS kept
       FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.id = ? AND i.workspace_id = ?`, itemId, owner.workspaceId);
    if (!item) continue;
    const fresh = item.workflow === "new" && item.fresh === 1;
    if (unjudged) {
      if (fresh) keep(item.source_id, itemId);
      continue;
    }
    const applying = item.source_id ? filtersBySource(app, owner.workspaceId, [item.source_id]).get(item.source_id) ?? [] : [];
    const verdicts = app.db.all<{ filter_id: string; version: number; dropped: number; applied_revision: number | null }>(
      "SELECT filter_id, version, dropped, applied_revision FROM ai_filter_verdicts WHERE item_id = ?", itemId);
    const current = verdicts.filter((x) => applying.some((f) => f.id === x.filter_id && f.version === x.version));
    if (!applying.length) {
      // The filter was turned off or removed meanwhile.
      if (fresh) keep(item.source_id, itemId);
      continue;
    }
    // Decided once every filter that applies has answered as it is now; a filter changed meanwhile has queued its own re-check.
    if (current.length < applying.length) continue;
    const dropping = current.some((x) => x.dropped === 1);
    const lastByFilter = verdicts.reduce<number | null>((m, x) => (x.applied_revision !== null && (m === null || x.applied_revision > m) ? x.applied_revision : m), null);
    // The person's own change to the post is their last word on it: a filter changes only posts nobody else has.
    const untouched = item.revision === (lastByFilter ?? 0);
    let to: WorkflowState | null = null;
    if (dropping && untouched && item.workflow === "new" && !item.opened_at && !item.kept) to = "ignored";
    // Opening or keeping a post doesn't move its revision, but it is the person's touch all the same.
    else if (!dropping && untouched && item.workflow === "ignored" && !item.opened_at && !item.kept) to = "new";
    if (to) {
      const revision = setWorkflowByFilter(app, owner, itemId, item.workflow, to);
      app.db.run("UPDATE ai_filter_verdicts SET applied_revision = ? WHERE item_id = ?", revision, itemId);
      changed = true;
    } else if (!dropping && fresh) {
      keep(item.source_id, itemId);
    }
  }
  // The preview title is one of the posts that stayed, never one a later job may still drop.
  if (announce && kept.size) notifyArrivals(app, owner.workspaceId, [...kept.entries()], undefined, keptIds);
  if (changed) emit(app, owner.accountId, { type: "items", sourceIds: [], count: 0 });
}

/** A filter.judge job that failed for good: its posts stay as they are, and new ones are announced as a sync would have. */
export function failJudging(app: App, payload: Record<string, unknown>): void {
  if (payload.announce !== true) return;
  const itemIds = Array.isArray(payload.itemIds) ? payload.itemIds.map(String) : [];
  const rows = app.db.all<{ workspace_id: string; source_id: string; n: number }>(
    `SELECT i.workspace_id, i.source_id, COUNT(*) AS n FROM json_each(?) j JOIN items i ON i.id = j.value JOIN item_state st ON st.item_id = i.id
     WHERE i.source_id IS NOT NULL AND st.fresh = 1 AND st.workflow = 'new' GROUP BY i.workspace_id, i.source_id`, JSON.stringify(itemIds));
  for (const workspaceId of new Set(rows.map((r) => r.workspace_id))) {
    notifyArrivals(app, workspaceId, rows.filter((r) => r.workspace_id === workspaceId).map((r) => [r.source_id, r.n]));
  }
}

// ---------- preview ----------

/**
 * Judge the latest posts of a source or collection with words that aren't saved yet, so the person can see what a filter would
 * do before turning it on. Nothing about the posts changes; the tokens count like any other use of the key.
 */
export async function previewFilter(app: App, p: Principal, scope: AiFilterScope, rule: AiFilterRule): Promise<AiFilterPreview> {
  const s = scopeOf(app, p, scope);
  const key = keyFor(app, p);
  if (!key) {
    throw new HttpError(409, "ai_unavailable", !serverKeyReady(app)
      ? "This server hasn't set up Smart filters yet. Ask your administrator."
      : aiSettings(app, p).allowanceUsedUp
        ? "You've used this week's Smart filter allowance. Contact your administrator to change your limits."
        : "Smart filters are included in the Pro plan. Move to Pro to try a filter.");
  }
  const sources = s.column === "source_id" ? "SELECT ? AS id" : "SELECT source_id AS id FROM collection_sources WHERE collection_id = ?";
  const posts = app.db.all<PostRow & { published_at: string | null }>(
    `SELECT i.id, i.source_id, i.title, i.author, i.excerpt, i.published_at, src.title AS source_title FROM items i
     LEFT JOIN sources src ON src.id = i.source_id
     WHERE i.workspace_id = ? AND i.source_id IN (${sources}) ORDER BY i.discovered_at DESC, i.id DESC LIMIT ${AI_FILTER_PREVIEW_POSTS}`,
    p.workspaceId, s.id);
  if (!posts.length) throw badRequest("There are no posts here yet to try the filter on.", "no_posts");
  const question = questionFor(rule);
  const results = await askJevEach(app.config.jev, key, posts.map((post) => ({ state: postState(post), questions: { keep: question } })), { concurrency: PREVIEW_CONCURRENCY });
  // What Jev answered is billed even when another request failed, so it is counted first.
  const answered = results.filter((r): r is Exclude<typeof r, JevError> => !(r instanceof JevError));
  const inputTokens = answered.reduce((n, a) => n + a.inputTokens, 0);
  recordUsage(app, p.accountId, inputTokens, answered.length);
  const err = results.find((r): r is JevError => r instanceof JevError);
  if (err) {
    if (err.failure === "key_rejected") markKeyRejected(app, jevKeyFingerprint(key));
    throw new HttpError(err.failure === "key_rejected" ? 409 : 502, `ai_${err.failure}`, err.failure === "key_rejected"
      ? "Jev did not accept this server's key. An administrator can replace it."
      : err.failure === "busy" ? "Jev is busy. Try again in a moment." : "Jev could not be reached. Try again in a moment.");
  }
  const answers = answered;
  return {
    inputTokens,
    posts: posts.map((post, i) => {
      const keepProbability = answers[i]!.answers.keep!;
      return { itemId: post.id, title: post.title, sourceTitle: post.source_title, publishedAt: post.published_at, keepProbability, dropped: dropsPost(keepProbability, rule.whenUnsure) };
    }),
  };
}
