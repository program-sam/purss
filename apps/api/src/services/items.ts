import { newId, measureBytes, checkQuery } from "@purss/domain";
import type { ItemDTO, ItemDetail, ItemIds, ItemIdsQuery, ItemListQuery, KeptDisplay, QueryNode, CaptureDTO, TextRef, WorkflowState } from "@purss/domain";
import { MAX_BULK_ITEMS, itemIdsQuerySchema, itemListQuerySchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { badRequest, notFound, nowIso } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import type { z } from "zod";
import { admitObject } from "./storage.ts";
import { itemCounts } from "./counts.ts";
import type { CellFilter } from "./counts.ts";
import { contentHash, displayAuthor, displayExcerpt, displayTitle, excerpt, excerptBeyondTitle, readMinutes, sanitize, toText } from "./content.ts";
import { linkKey, urlKey } from "./url-key.ts";
import { getPlayback, itemLinkIsMedia, itemMedia } from "./media.ts";
import { ftsQuery, foldForSearch, indexedWord, searchTerms } from "./search-text.ts";
import { firstImage } from "./first-image.ts";
import { looksLikeSummary } from "./teaser.ts";
import { onHomeItem } from "./home-sources.ts";
import { NOT_MUTED_ROW, countMuted, workspaceMuted } from "./muted.ts";
import { copyOnlyPicture, partialReasonText } from "@purss/connectors";
import type { PartialReason } from "@purss/connectors";
import { pictureUrl, postGallery, storedPictures, withStoredPictures } from "./images.ts";
import { settledCopy } from "./capture-state.ts";
import { keptDisplays } from "./kept-display.ts";

export type NewItem = {
  accountId: string;
  workspaceId: string;
  sourceId: string | null;
  sourceKindForFts?: string;
  kind: string;
  title: string;
  url: string | null;
  author: string | null;
  summaryHtml: string | null;
  contentHtml: string | null;
  imageUrl: string | null;
  durationSeconds: number | null;
  doi: string | null;
  curatorNote: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  /** The item's time in lists (migration 071); its publication date, else its arrival, when not given. */
  listedAt?: string;
  enclosures: { url: string; type: string | null; length?: number | null }[];
  /** The feed's full text was too large to send; the item holds its summary only. */
  contentOmitted?: boolean;
  fresh: boolean;
  /** Back catalogue of a source followed from now: stored as Ignored, so it is hidden from lists and left out of Home and the counts, and search still finds it. */
  ignored?: boolean;
  reason: string;
};

/** Create an item with its first immutable version, state, search entry and storage object. */
export function insertItem(app: App, n: NewItem): { id: string; versionId: string; seq: number } {
  const id = newId("itm");
  const versionId = newId("ver");
  const now = nowIso();
  const summaryHtml = sanitize(n.summaryHtml);
  const contentHtml = sanitize(n.contentHtml);
  const text = toText(contentHtml ?? summaryHtml);
  const ex = excerpt(toText(summaryHtml) || text);
  const r = app.db.run(
    `INSERT INTO items (id, account_id, workspace_id, source_id, source_title, kind, title, url, url_key, link_key, author, excerpt, image_url, duration_seconds,
       read_minutes, doi, curator_note, published_at, discovered_at, listed_at, current_version_id, enclosures, created_at, updated_at)
     VALUES (?, ?, ?, ?, COALESCE((SELECT title FROM sources WHERE id = ?), ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, n.accountId, n.workspaceId, n.sourceId, n.sourceId, n.kind, n.title || "(untitled)", n.url, urlKey(n.url), n.url ? linkKey(n.url) : null, n.author, ex, n.imageUrl ?? firstImage(contentHtml ?? summaryHtml), n.durationSeconds,
    n.kind === "video" || n.kind === "podcast" ? null : readMinutes(text), n.doi, n.curatorNote, n.publishedAt, n.discoveredAt, n.listedAt ?? n.publishedAt ?? n.discoveredAt, versionId,
    JSON.stringify(n.enclosures.slice(0, 10)), now, now,
  );
  app.db.run(
    "INSERT INTO item_versions (id, item_id, workspace_id, title, url, summary_html, content_html, content_hash, content_omitted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    versionId, id, n.workspaceId, n.title, n.url, summaryHtml, contentHtml, contentHash(n.title, n.url, summaryHtml, contentHtml), n.contentOmitted ? 1 : 0, now,
  );
  app.db.run("INSERT INTO item_state (item_id, workspace_id, source_id, workflow, fresh, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, n.workspaceId, n.sourceId, n.ignored ? "ignored" : "new", n.fresh ? 1 : 0, now);
  indexText(app, r.lastInsertRowid, { title: n.title, excerpt: ex ?? "", author: n.author ?? "", body: text });
  admitObject(app, {
    accountId: n.accountId, workspaceId: n.workspaceId, kind: "item_version", refId: versionId, itemId: id, sourceId: n.sourceId,
    bytes: versionBytes({ title: n.title, url: n.url, author: n.author, summaryHtml, contentHtml, imageUrl: n.imageUrl, enclosures: n.enclosures, publishedAt: n.publishedAt }),
    reason: n.reason,
  });
  return { id, versionId, seq: r.lastInsertRowid };
}

export function versionBytes(v: Record<string, unknown>): number {
  return measureBytes(v);
}

/** The text search indexes for an item besides its title: its content (or summary) and any captured readable text. */
function searchBody(app: App, itemId: string, contentHtml: string | null, summaryHtml: string | null): string {
  const captured = app.db.all<{ text: string | null }>("SELECT text FROM captures WHERE item_id = ? AND status = 'done' AND quality IS NOT 'partial'", itemId).map((c) => c.text ?? "").join(" ");
  return `${toText(contentHtml ?? summaryHtml)} ${captured}`.trim();
}

/** Re-index an item's searchable text (after edits or captures). */
export function reindex(app: App, itemId: string): void {
  const row = app.db.get<{ seq: number; title: string; excerpt: string | null; author: string | null; content_html: string | null; summary_html: string | null }>(
    `SELECT i.seq, i.title, i.excerpt, i.author, v.content_html, v.summary_html FROM items i LEFT JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?`, itemId);
  if (!row) return;
  const body = searchBody(app, itemId, row.content_html, row.summary_html);
  app.db.run("DELETE FROM items_fts WHERE rowid = ?", row.seq);
  indexText(app, row.seq, { title: row.title, excerpt: row.excerpt ?? "", author: row.author ?? "", body });
}

/** Put an item's searchable text into the index in its folded form (see search-text.ts). Every writer of the index goes through here. */
export function indexText(app: App, seq: number, t: { title: string; excerpt: string; author: string; body: string }): void {
  app.db.run("INSERT INTO items_fts (rowid, title, excerpt, author, body) VALUES (?, ?, ?, ?, ?)", seq, foldForSearch(t.title), foldForSearch(t.excerpt), foldForSearch(t.author), foldForSearch(t.body));
}

// ---------- listing ----------

export const ITEM_COLUMNS = `i.id, i.number, i.source_id, COALESCE(s.title, 'Saved link') AS source_title, i.kind, i.title, i.url, i.author, i.excerpt, i.image_url,
  i.duration_seconds, i.read_minutes, i.doi, i.published_at, i.discovered_at, i.listed_at, i.curator_note, st.workflow, st.revision, st.workflow_revision, st.playback_workflow_session, st.state_version, st.fresh, st.progress, st.opened_at,
  (SELECT group_concat(b.basket_id) FROM basket_items b WHERE b.item_id = i.id) AS basket_ids,
  i.enclosures, COALESCE(s.is_private, 0) AS is_private,
  (SELECT MAX(a.received_at) FROM annotations a WHERE a.item_id = i.id) AS annotated_at,
  (SELECT g.id FROM item_images g WHERE g.item_id = i.id AND g.url = i.image_url) AS image_kept`;

export type ItemRow = {
  id: string; number: number; source_id: string | null; source_title: string; kind: string; title: string; url: string | null; author: string | null;
  excerpt: string | null; image_url: string | null; duration_seconds: number | null; read_minutes: number | null; doi: string | null;
  published_at: string | null; discovered_at: string; listed_at: string; curator_note: string | null; workflow: WorkflowState; revision: number; workflow_revision: number; playback_workflow_session: string | null; state_version: number; fresh: number;
  progress: number; opened_at: string | null; basket_ids: string | null; enclosures: string | null; is_private: number; annotated_at: string | null;
  /** the stored copy of the item's own picture (item_images), when there is one */
  image_kept: string | null;
};

/** The item's own picture as it is shown: one that can't be shown on another site only from its stored copy (images.ts). */
const shownImage = (r: Pick<ItemRow, "id" | "image_url" | "image_kept">) =>
  !copyOnlyPicture(r.image_url) ? r.image_url : r.image_kept ? pictureUrl(r.id, r.image_kept) : null;

export function toDTO(r: ItemRow, kept?: KeptDisplay): ItemDTO {
  const linkIsMedia = itemLinkIsMedia(r.url, r.enclosures);
  return {
    // A private source's file address can carry its secret: when the item's link is that file, it is not sent (its media is withheld too).
    id: r.id, number: r.number, sourceId: r.source_id, sourceTitle: r.source_title, kind: r.kind as ItemDTO["kind"], title: displayTitle(r.title), url: r.is_private === 1 && linkIsMedia ? null : r.url, author: displayAuthor(r.author),
    excerpt: excerptBeyondTitle(r.title, displayExcerpt(r.excerpt)), imageUrl: shownImage(r), durationSeconds: r.duration_seconds, readMinutes: r.read_minutes, doi: r.doi,
    publishedAt: r.published_at, discoveredAt: r.discovered_at, listedAt: r.listed_at, workflow: r.workflow, revision: r.revision, workflowRevision: r.workflow_revision, playbackWorkflowSessionId: r.playback_workflow_session, stateVersion: r.state_version, fresh: r.fresh === 1,
    progress: r.progress, opened: r.opened_at !== null, basketIds: r.basket_ids ? r.basket_ids.split(",") : [], curatorNote: r.curator_note,
    media: itemMedia(r.enclosures, r.is_private === 1),
    linkIsMedia,
    annotatedAt: r.annotated_at,
    ...(kept ? { kept } : {}),
  };
}

/**
 * The title and link a kept item shows when the feed has changed it since: the kept version's. `shown` is the link the item itself is
 * sent with (null when withheld). For a public source the kept link is a file when it matches the item's files, or when it is the very
 * link the item has and that one is a file. A private source's kept link is sent only when it is the item's own page link: an older link
 * that can't be told apart from a file address (which can carry the source's secret) is withheld and treated as the file.
 */
function keptLink(title: string, url: string | null, enclosuresJson: string | null, shown: string | null, currentIsMedia: boolean, isPrivate: boolean): { title: string; url: string | null; linkIsMedia: boolean } {
  if (isPrivate) return url !== null && url === shown && !currentIsMedia ? { title, url, linkIsMedia: false } : { title, url: null, linkIsMedia: url !== null };
  return { title, url, linkIsMedia: itemLinkIsMedia(url, enclosuresJson) || (url !== null && url === shown && currentIsMedia) };
}

/** Compile a validated query tree to a parameterised WHERE fragment over items i / item_state st. */
/** `itemTextOnly`: a text rule matches the items' own text, never the person's highlights and notes (for shared pages). */
export function compileQuery(node: QueryNode, params: SqlParam[], workspaceId: string, opts: { itemTextOnly?: boolean } = {}): string {
  if ("all" in node) return `(${node.all.map((n) => compileQuery(n, params, workspaceId, opts)).join(" AND ")})`;
  if ("any" in node) return `(${node.any.map((n) => compileQuery(n, params, workspaceId, opts)).join(" OR ")})`;
  if ("not" in node) return `(NOT ${compileQuery(node.not, params, workspaceId, opts)})`;
  const list = (values: readonly string[]) => { params.push(...values); return values.map(() => "?").join(","); };
  switch (node.field) {
    case "text": return opts.itemTextOnly ? itemTextMatch(node.value, params) : textMatch(node.value, params);
    case "source": return `i.source_id IN (${list(node.value)})`;
    case "kind": return `i.kind IN (${list(node.value)})`;
    case "workflow": return `st.workflow IN (${list(node.value)})`;
    case "author": params.push(`%${node.value}%`); return "i.author LIKE ?";
    case "fresh": return node.value ? "st.fresh = 1" : "st.fresh = 0";
    case "opened": return node.value ? "st.opened_at IS NOT NULL" : "st.opened_at IS NULL";
    case "kept": return `${node.value ? "" : "NOT "}EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id)`;
    // Only this PURSS's own baskets and collections count, whatever ids a filter names.
    case "basket": { const ids = list(node.value); params.push(workspaceId); return `EXISTS (SELECT 1 FROM basket_items b JOIN baskets bk ON bk.id = b.basket_id WHERE b.item_id = i.id AND b.basket_id IN (${ids}) AND bk.workspace_id = ?)`; }
    case "collection": { const ids = list(node.value); params.push(workspaceId); return `i.source_id IN (SELECT cs.source_id FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id WHERE cs.collection_id IN (${ids}) AND c.workspace_id = ?)`; }
    case "capture": {
      const parts: string[] = [];
      for (const level of node.value) {
        if (level === "fulltext") parts.push("EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status = 'done' AND c.quality IS NOT 'partial')");
        if (level === "pending") parts.push("EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status = 'pending')");
        if (level === "failed") parts.push("EXISTS (SELECT 1 FROM captures c WHERE c.item_id = i.id AND c.status = 'failed')");
        if (level === "feed") parts.push("EXISTS (SELECT 1 FROM item_versions v WHERE v.id = i.current_version_id AND v.content_html IS NOT NULL)");
        if (level === "metadata") parts.push("EXISTS (SELECT 1 FROM item_versions v WHERE v.id = i.current_version_id AND v.content_html IS NULL)");
      }
      return `(${parts.join(" OR ")})`;
    }
    case "date": {
      const col = node.which === "published" ? "COALESCE(i.published_at, i.discovered_at)" : node.which === "discovered" ? "i.discovered_at"
        : "(SELECT MIN(b.kept_at) FROM basket_items b WHERE b.item_id = i.id)";
      const parts: string[] = [];
      if (node.from) { params.push(node.from); parts.push(`${col} >= ?`); }
      if (node.to) { params.push(node.to + "T23:59:59.999Z"); parts.push(`${col} <= ?`); }
      return `(${parts.join(" AND ")})`;
    }
  }
}

/**
 * Items whose own text matches, or whose annotations do: the person's comments and notes and the
 * passages they highlighted (plan/26). The caller's WHERE scopes it to the PURSS.
 */
/** Items whose own text matches. */
function itemTextMatch(text: string, params: SqlParam[]): string {
  params.push(ftsQuery(text));
  return "i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)";
}

export function textMatch(text: string, params: SqlParam[]): string {
  const q = ftsQuery(text);
  params.push(q, q);
  return `(i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
    OR i.id IN (SELECT a.item_id FROM annotations a WHERE a.deleted_at IS NULL AND a.seq IN (SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?)))`;
}

/** For items a search already found (and scoped): a few words around the first match in their text.
 *  The index is contentless, so this reads the same text the index was built from. Matches are
 *  wrapped in U+0001 … U+0002 so the client can mark them without parsing HTML. A word matches the way
 *  the index matches it: folded the same way, from its start. */
export function searchSnippets(app: App, itemIds: string[], text: string): Record<string, string> {
  const terms = searchTerms(text).map((t) => indexedWord(t));
  if (!itemIds.length || !terms.length) return {};
  const rows = app.db.all<{ id: string; content_html: string | null; summary_html: string | null }>(
    `SELECT i.id, v.content_html, v.summary_html FROM items i LEFT JOIN item_versions v ON v.id = i.current_version_id
      WHERE i.id IN (${itemIds.map(() => "?").join(",")})`, ...itemIds);
  const out: Record<string, string> = {};
  for (const r of rows) {
    const snippet = snippetAround(searchBody(app, r.id, r.content_html, r.summary_html), terms);
    if (snippet !== null) out[r.id] = snippet;
  }
  return out;
}

/** A few words of `body` around the first word that starts with one of `terms` (as the index holds them), the match marked; null when none does. */
export function snippetAround(body: string, terms: string[]): string | null {
  let at = -1, len = 0;
  for (const m of body.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = indexedWord(m[0]);
    const term = terms.find((t) => word.startsWith(t));
    if (term === undefined) continue;
    at = m.index!;
    len = word === term ? m[0].length : rawLength(m[0], term.length);
    break;
  }
  if (at < 0) return null;
  const from = Math.max(0, body.lastIndexOf(" ", Math.max(0, at - 50)) + 1);
  const end = body.indexOf(" ", Math.min(body.length, at + len + 70));
  const to = end < 0 ? body.length : end;
  return `${from > 0 ? "…" : ""}${body.slice(from, at)}\u0001${body.slice(at, at + len)}\u0002${body.slice(at + len, to)}${to < body.length ? "…" : ""}`;
}

/** How many characters of a word, as written, make up the first `folded` characters of its folded form. */
function rawLength(word: string, folded: number): number {
  for (let i = 1; i <= word.length; i++) if (indexedWord(word.slice(0, i)).length >= folded) return i;
  return word.length;
}

/** Followed sources that are in no collection. */
function looseSources(app: App, workspaceId: string): string[] {
  return app.db.all<{ id: string }>(
    `SELECT o.id FROM sources o WHERE o.workspace_id = ? AND o.followed = 1 AND o.kind <> 'manual'
       AND NOT EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.source_id = o.id)`, workspaceId).map((r) => r.id);
}

export function scopeClause(app: App, p: Principal, scope: string, params: SqlParam[]): string {
  const [kind, id] = scope.split(":") as [string, string | undefined];
  switch (kind) {
    case "all":
    case "home":
      return "1";
    case "fresh":
      return "st.fresh = 1";
    case "toread":
      // The queue: what is waiting (To read, To watch, To listen) and what is started (In progress). Looked up by state in the workspace's
      // own item_state index (the states are rare), not found by probing every item.
      params.push(p.workspaceId);
      return `st.workspace_id = ? AND ${QUEUE_STATES_SQL}`;
    case "loose": {
      // Followed sources that are in no collection (Home's "Other sources"). When there are none, say so: the planner can't
      // tell that the set is empty and would otherwise walk every item looking for a match.
      const ids = looseSources(app, p.workspaceId);
      if (!ids.length) return "0";
      params.push(JSON.stringify(ids));
      return "i.source_id IN (SELECT value FROM json_each(?))";
    }
    case "source":
      params.push(id!);
      return "i.source_id = ?";
    case "basket":
      params.push(id!);
      return "EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id AND b.basket_id = ?)";
    case "collection": {
      const c = app.db.get<{ mode: string; query: string | null }>("SELECT mode, query FROM collections WHERE id = ? AND workspace_id = ?", id!, p.workspaceId);
      if (!c) throw notFound("That collection");
      if (c.mode === "sources") { params.push(id!); return "i.source_id IN (SELECT source_id FROM collection_sources WHERE collection_id = ?)"; }
      const q = checkQuery(JSON.parse(c.query ?? "null"));
      return q.ok ? compileQuery(q.query, params, p.workspaceId) : "0";
    }
    default:
      throw badRequest("Unknown view.");
  }
}

/** The queue is what is put aside (To read, To watch, To listen) and what is started (In progress). */
export const QUEUE_STATES_SQL = "st.workflow IN ('toread', 'inprogress')";

/**
 * Items from unfollowed sources leave lists and search unless kept, added by hand, carrying the
 * person's own highlights or notes (all of which must stay findable).
 */
export const VISIBLE_SOURCE = `(i.source_id IS NULL OR s.followed = 1 OR s.kind = 'manual'
  OR EXISTS (SELECT 1 FROM basket_items vb WHERE vb.item_id = i.id)
  OR EXISTS (SELECT 1 FROM annotations va WHERE va.item_id = i.id AND va.deleted_at IS NULL))`;

const SORT_SQL = {
  newest: { key: "i.listed_at", dir: "DESC" },
  oldest: { key: "i.listed_at", dir: "ASC" },
  // The source's title and the kept time are stored with the item (migration 058) and indexed in these orders.
  source: { key: "i.source_title || char(1) || i.listed_at", dir: "ASC" },
  title: { key: "lower(i.title)", dir: "ASC" },
  kept: { key: "i.kept_key", dir: "DESC" },
} as const;

/** A list's order: its key and direction, and whether it is read in that order from an index (see `listTuning.sortFromRowsBelow`). */
type ListSort = { key: string; dir: "ASC" | "DESC"; inOrder: boolean };

/** The ORDER BY of a list's rows over `key` (the sort key or its alias); a `+` keeps the planner from reading it from the index. */
const orderBy = (sort: ListSort, key: string) => `ORDER BY ${sort.inOrder ? key : `+(${key})`} ${sort.dir}, i.id ${sort.dir}`;

function listSort(app: App, p: Principal, q: { scope: string; source?: string; sort: keyof typeof SORT_SQL }): ListSort {
  const sort = SORT_SQL[q.sort];
  const inOrder = { ...sort, inOrder: true };
  // The queue holds a few rare states (what a person put aside or started): found by state and sorted, not looked for along every item's date.
  if (q.scope === "toread") return { ...sort, inOrder: false };
  if (q.sort !== "kept" && q.sort !== "source") return inOrder;
  // The list's sources, if it is limited to some: a source, a collection of sources, those in no collection, the source chips.
  const params: SqlParam[] = [p.workspaceId];
  const where = ["i.workspace_id = ?"];
  const [kind, id] = q.scope.split(":") as [string, string | undefined];
  const ofSources = kind === "source" || kind === "loose"
    || (kind === "collection" && app.db.get<{ mode: string }>("SELECT mode FROM collections WHERE id = ? AND workspace_id = ?", id!, p.workspaceId)?.mode === "sources");
  if (ofSources) where.push(scopeClause(app, p, q.scope, params));
  if (q.source) { const ids = q.source.split(","); where.push(`i.source_id IN (${ids.map(() => "?").join(", ")})`); params.push(...ids); }
  if (where.length === 1) return inOrder;
  const below = listTuning.sortFromRowsBelow;
  const few = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM items i WHERE ${where.join(" AND ")} LIMIT ?)`, ...params, below)!.n < below;
  return few ? { ...sort, inOrder: false } : inOrder;
}

/**
 * Home's order: New items first, then the rest the filter allows (To read), newest first within each. Listed as two runs, each
 * in the date order, so each reads the date index in order instead of sorting every candidate.
 */
const HOME_RUNS = ["st.workflow = 'new'", "st.workflow <> 'new'"] as const;
/** The queue's order: what is started first, then what is waiting, each in the list's own order. */
const QUEUE_RUNS = ["st.workflow = 'inprogress'", "st.workflow = 'toread'"] as const;
/** The runs a list is read in, or none when it is read in one pass. */
const runsOf = (q: { scope: string; mix?: string }): readonly string[] | null => q.mix === "home" ? HOME_RUNS : q.scope === "toread" ? QUEUE_RUNS : null;

/** Over items `i`: a readable copy failed and none is settled (pending, or finished and passed the checks: capture-state.ts), so the item says so. */
export const CAPTURE_FAILED = `(EXISTS (SELECT 1 FROM captures fc WHERE fc.item_id = i.id AND fc.status = 'failed') AND NOT ${settledCopy("i.id")})`;

/** Item types as the list filter names them, over the items named `a`. */
const TYPE_SQL: Record<string, (a: string) => string> = {
  articles: (a) => `${a}.kind NOT IN ('video', 'podcast')`,
  videos: (a) => `${a}.kind = 'video'`,
  podcasts: (a) => `${a}.kind = 'podcast'`,
};
/** The longest an item can be to count as short, in seconds (reading time for text, playing time for video and audio). */
export const SHORT_SECONDS = 300;
/**
 * How long an item takes: its playing time, or its reading time for text. A text with no reading time has no words to read (items
 * saved before short texts were given one are the same), so it is as short as can be; a video or audio with no length is unknown.
 */
const lengthSql = (a: string) => `COALESCE(NULLIF(${a}.duration_seconds, 0), ${a}.read_minutes * 60, CASE WHEN ${a}.kind NOT IN ('video', 'podcast') THEN 0 END)`;

/** Conditions over the items named `a` (`items i` unless said) for the item types and the length a list is limited to. */
export function typeLengthConditions(q: { type?: string; length?: "short" | "long" }, a = "i"): string[] {
  return [
    ...(q.type ? [`(${q.type.split(",").map((t) => TYPE_SQL[t]!(a)).join(" OR ")})`] : []),
    ...(q.length ? [q.length === "short" ? `${lengthSql(a)} <= ${SHORT_SECONDS}` : `${lengthSql(a)} > ${SHORT_SECONDS}`] : []),
  ];
}

/** What `listItems` does beyond the query itself. */
export type ListOptions = {
  /** Leave out what Home leaves out: items of sources whose collections are all hidden on Home (Home's filter collections). */
  homeVisible?: boolean;
};

type ListResult = { items: ItemDTO[]; nextCursor: string | null; total: number | null; mutedHidden?: number; mutedHiddenAtLeast?: boolean };

export function listItems(app: App, p: Principal, input: ItemListQuery, opts: ListOptions = {}): ListResult {
  const q = itemListQuerySchema.parse(input);
  // Muted words leave items out of lists. Search still finds them, and so do baskets: what someone kept is theirs to see.
  const muted = q.q || q.scope.startsWith("basket:") || q.muted === "show" ? null : workspaceMuted(app, p.workspaceId);
  return listPage(app, p, q, opts, muted);
}

/** What a list (its page and its "Select all") is narrowed by: its scope, state filter, chips, search and Home's rules. */
function listConditions(app: App, p: Principal, q: Omit<z.infer<typeof itemListQuerySchema>, "cursor" | "limit">, opts: ListOptions, snapshot: number | null): { where: string[]; params: SqlParam[] } {
  const params: SqlParam[] = [p.workspaceId];
  const where: string[] = ["i.workspace_id = ?", scopeClause(app, p, q.scope, params), VISIBLE_SOURCE];
  if (q.filter === "fresh") where.push("st.fresh = 1");
  else if (q.filter === "active") where.push("st.workflow <> 'ignored'");
  else if (q.filter === "open") where.push("st.workflow IN ('new', 'toread')");
  else if (q.filter !== "all") { where.push("st.workflow = ?"); params.push(q.filter); }
  if (q.source) { const ids = q.source.split(","); where.push(`i.source_id IN (${ids.map(() => "?").join(", ")})`); params.push(...ids); }
  if (q.exceptPrivate) where.push("COALESCE(s.is_private, 0) = 0");
  if (q.without) { const ids = q.without.split(","); where.push(`(i.source_id IS NULL OR i.source_id NOT IN (${ids.map(() => "?").join(", ")}))`); params.push(...ids); }
  // the items whose readable copy couldn't be saved (what the bell's "Couldn't save the text of N items" opens).
  if (q.capture === "failed") where.push(CAPTURE_FAILED);
  where.push(...typeLengthConditions(q));
  if (opts.homeVisible || q.mix === "home") where.push(onHomeItem(app, p.workspaceId, params));
  if (snapshot !== null) { where.push("i.seq <= ?"); params.push(snapshot); }
  if (q.q) where.push(textMatch(q.q, params));
  return { where, params };
}

const LIST_FROM = "FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id";

/**
 * Every item a list shows, in its order, for "Select all": the same conditions and muted words as its pages, at most
 * MAX_BULK_ITEMS, with how many there are in all when that's no more. Past it the total is null: counting the rest would
 * read (and test the muted words against) every item in the list, seconds for a large library.
 */
export function listItemIds(app: App, p: Principal, input: ItemIdsQuery, opts: ListOptions = {}): ItemIds {
  const q = itemIdsQuerySchema.parse(input);
  const muted = q.q || q.scope.startsWith("basket:") || q.muted === "show" ? null : workspaceMuted(app, p.workspaceId);
  const { where, params } = listConditions(app, p, q, opts, null);
  const sort = listSort(app, p, q);
  const ordered = `SELECT ${ITEM_COLUMNS}, ${sort.key} AS sort_key ${LIST_FROM} WHERE ${where.join(" AND ")} ${orderBy(sort, "sort_key")}`;
  const shown = muted ? `SELECT id FROM (${ordered} LIMIT -1) WHERE ${NOT_MUTED_ROW}` : `SELECT id FROM (${ordered} LIMIT -1)`;
  const args = muted ? [...params, muted] : params;
  const rows = app.db.all<{ id: string }>(`${shown} LIMIT ?`, ...args, MAX_BULK_ITEMS + 1);
  return { ids: rows.slice(0, MAX_BULK_ITEMS).map((r) => r.id), total: rows.length > MAX_BULK_ITEMS ? null : rows.length };
}

type SortedRow = ItemRow & { sort_key: string };

/**
 * Up to `limit` rows in the order `sort`, after the position `cur` (a sort key and an id) when given. Muted items are left out
 * after the rows are in order, not before: the words are then asked about only as many rows as it takes to fill the page. (A
 * subquery with a LIMIT is not folded into the query around it, so its WHERE does not run on every candidate.)
 */
function sortedRows(app: App, where: string[], params: SqlParam[], sort: ListSort, cur: [string, string] | null, limit: number, muted: string | null): SortedRow[] {
  const w = [...where];
  const ps = [...params];
  if (cur) {
    const op = sort.dir === "DESC" ? "<" : ">";
    w.push(`(${sort.key} ${op} ? OR (${sort.key} = ? AND i.id ${op} ?))`);
    ps.push(cur[0], cur[0], cur[1]);
  }
  const ordered = `SELECT ${ITEM_COLUMNS}, ${sort.key} AS sort_key ${LIST_FROM} WHERE ${w.join(" AND ")} ${orderBy(sort, "sort_key")}`;
  return muted
    ? app.db.all<SortedRow>(`SELECT * FROM (${ordered} LIMIT -1) WHERE ${NOT_MUTED_ROW} LIMIT ?`, ...ps, muted, limit)
    : app.db.all<SortedRow>(`${ordered} LIMIT ?`, ...ps, limit);
}

/** One page of a list; `muted`: the muted words (see `workspaceMuted`) whose items the list leaves out. */
function listPage(app: App, p: Principal, q: z.infer<typeof itemListQuerySchema>, opts: ListOptions, muted: string | null): ListResult {
  // Home's lists and the queue come in runs (see HOME_RUNS, QUEUE_RUNS). Home's also read the items that existed when paging began
  // (a sequence number), so an arrival, even a backdated one, cannot join a page already past its place.
  const home = q.mix === "home";
  const runs = runsOf(q);
  // The cursor is the last row's sort key and id; a list in runs has its run too, and Home's the snapshot its pages read.
  let cur: [string, string] | null = null;
  let run = 0;
  let snapshot: number | null = null;
  if (q.cursor) {
    try {
      const c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")) as unknown[];
      if (!Array.isArray(c) || typeof c[0] !== "string" || typeof c[1] !== "string") throw new Error("shape");
      if (runs && (!Number.isInteger(c[3]) || (c[3] as number) < 0 || (c[3] as number) >= runs.length || (home && !Number.isInteger(c[2])))) throw new Error("shape");
      cur = [c[0], c[1]];
      if (runs) { run = c[3] as number; if (home) snapshot = c[2] as number; }
    } catch { throw badRequest("That page link has expired."); }
  } else if (home) {
    snapshot = app.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM items")?.m ?? 0;
  }
  const { where, params } = listConditions(app, p, q, opts, snapshot);
  const sort = listSort(app, p, q);
  const want = q.limit + 1;
  let rows: (SortedRow & { run?: number })[] = [];
  if (runs) {
    for (let r = run; r < runs.length && rows.length < want; r++) {
      rows.push(...sortedRows(app, [...where, runs[r]!], params, sort, r === run ? cur : null, want - rows.length, muted).map((row) => ({ ...row, run: r })));
    }
  } else {
    rows = sortedRows(app, where, params, sort, cur, want, muted);
  }
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > q.limit && last ? Buffer.from(JSON.stringify(runs ? [last.sort_key, last.id, snapshot, last.run] : [last.sort_key, last.id])).toString("base64url") : null;
  const kept = keptDisplays(app, p.workspaceId, page.filter((r) => r.basket_ids).map((r) => r.id));
  // A list narrowed by more than its scope and state has no total: counting it would read every item the narrowing looks at.
  const narrowed = !!(q.type || q.length || q.without || q.capture || opts.homeVisible || home || muted);
  const total = q.cursor || narrowed ? null
    : totalFromCounts(app, p, q)
      ?? app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${LIST_FROM} WHERE ${where.join(" AND ")}`, ...params)!.n;
  const out: ListResult = { items: page.map((r) => toDTO(r, kept.get(r.id))), nextCursor, total };
  if (muted && !q.cursor) {
    // What the list leaves out, counted among the first candidates it would hold without the muted words (see `mutedScan`).
    // In the date order, so the candidates are found the way the page finds them (by its scope's narrowest index).
    const { hidden, atLeast } = countMuted(app, muted, LIST_FROM, where.join(" AND "), params, orderBy(sort, sort.key));
    out.mutedHidden = hidden;
    if (atLeast) out.mutedHiddenAtLeast = true;
  }
  return out;
}

/**
 * `countFromRowsBelowShare`: a collection that holds less than this share of the followed sources is counted from its rows; the
 * rest from the PURSS's counts. Adding up the counts costs the same whatever the collection (about 90 ms at 100,000 items);
 * counting rows costs in proportion (about 70 ms for a tenth of them). Sources are a cheap stand-in for items here: asking for
 * the items themselves costs about a quarter of the saving.
 *
 * `sortFromRowsBelow`: a list sorted by kept time or by source is read in order from its PURSS-wide index (migration 058) and
 * stops once the page is full; a list of a few sources' items would walk most of the PURSS to find them that way (a source of
 * 80 items took 65 to 180 ms instead of 2 at 100,000 items), so one with fewer items than this sorts them instead, as every such
 * list did before the keys were stored. Finding out reads at most this many entries of a source index.
 *
 * Test hooks, so the tests can take either way with few items.
 */
export const listTuning = { countFromRowsBelowShare: 0.2, sortFromRowsBelow: 2000 };

/** The part of a list's scope that depends on an item's state rather than on its source. */
const SCOPE_STATE: Record<string, { sql: string; keep: CellFilter }> = {
  fresh: { sql: "st.fresh = 1", keep: (_w, fresh) => fresh },
  toread: { sql: QUEUE_STATES_SQL, keep: (w) => w === "toread" || w === "inprogress" },
};

/**
 * How many items a list holds, added up from the PURSS's counts instead of from a probe per item. Applies to the
 * lists a person opens most (everything, New, To read, a large collection of sources, sources in no collection) when no text is
 * searched; for the rest, null: counting the rows is cheap (one source, a basket) or the only way (a query, a search).
 * The result is what counting the rows gives: items of sources that are no longer followed are in the list only while a
 * basket keeps them, which is looked up for those items alone.
 */
function totalFromCounts(app: App, p: Principal, q: z.infer<typeof itemListQuerySchema>): number | null {
  if (q.q || q.source || q.exceptPrivate) return null;
  const [kind, id] = q.scope.split(":") as [string, string | undefined];
  const scopeState = SCOPE_STATE[kind];
  let scopeSources: Set<string | null> | null = null; // null: every source
  if (kind === "collection") {
    const c = app.db.get<{ mode: string }>("SELECT mode FROM collections WHERE id = ? AND workspace_id = ?", id!, p.workspaceId);
    if (c?.mode !== "sources") return null;
    scopeSources = new Set(app.db.all<{ source_id: string }>("SELECT source_id FROM collection_sources WHERE collection_id = ?", id!).map((r) => r.source_id));
    const followed = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual'", p.workspaceId)!.n;
    if (scopeSources.size < followed * listTuning.countFromRowsBelowShare) return null;
  } else if (kind === "loose") {
    scopeSources = new Set(looseSources(app, p.workspaceId));
  } else if (kind !== "all" && kind !== "home" && !scopeState) return null;

  const filterSql = q.filter === "fresh" ? "st.fresh = 1" : q.filter === "active" ? "st.workflow <> 'ignored'" : q.filter === "open" ? "st.workflow IN ('new', 'toread')" : q.filter === "all" ? "1" : "st.workflow = ?";
  const filterKeep: CellFilter = q.filter === "fresh" ? (_w, fresh) => fresh : q.filter === "active" ? (w) => w !== "ignored" : q.filter === "open" ? (w) => w === "new" || w === "toread" : q.filter === "all" ? () => true : (w) => w === q.filter;
  const keep: CellFilter = (w, fresh) => filterKeep(w, fresh) && (!scopeState || scopeState.keep(w, fresh));

  const counts = itemCounts(app, p.workspaceId);
  const followed = new Set(app.db.all<{ id: string }>("SELECT id FROM sources WHERE workspace_id = ? AND (followed = 1 OR kind = 'manual')", p.workspaceId).map((r) => r.id));
  const inScope = [...counts.bySource.keys()].filter((k) => !scopeSources || scopeSources.has(k));
  const shown = inScope.filter((k) => k === null || followed.has(k));
  const hidden = inScope.filter((k): k is string => k !== null && !followed.has(k));
  let total = counts.sum(shown, keep);
  if (hidden.length) {
    total += app.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items i JOIN item_state st ON st.item_id = i.id
       WHERE i.workspace_id = ? AND i.source_id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM basket_items vb WHERE vb.item_id = i.id)
         AND ${scopeState ? scopeState.sql : "1"} AND ${filterSql}`,
      p.workspaceId, JSON.stringify(hidden), ...(filterSql.endsWith("?") ? [q.filter] : []))!.n;
  }
  return total;
}

/** The item with this number in the person's workspace (its short link, /app/i/<number>). */
export function itemIdByNumber(app: App, p: Principal, number: number): { id: string } {
  const row = app.db.get<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? AND number = ?", p.workspaceId, number);
  if (!row) throw notFound("That item");
  return { id: row.id };
}

export function getItem(app: App, p: Principal, id: string): ItemDTO {
  const row = app.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.workspace_id = ?`, id, p.workspaceId);
  if (!row) throw notFound("That item");
  return toDTO(row, keptDisplays(app, p.workspaceId, row.basket_ids ? [id] : []).get(id));
}

const CAPTURE_LABELS = {
  metadata: "Saved details (title, link and summary)",
  feed: "Saved the feed's text",
  fulltext: "Full text saved",
  partial: "Only part of the page was saved",
  browser: "Saved from your browser",
  pending: "Saving readable text…",
  failed: "Couldn't save the text",
} as const;

/** Shown with a browser capture (plan/32): where its text came from and what that means. */
export const BROWSER_CAPTURE_NOTE = "The text as your browser showed it. PURSS didn't fetch the page, so it can't confirm that this matches the original.";

export function getItemDetail(app: App, p: Principal, id: string): ItemDetail {
  const dto = getItem(app, p, id);
  const extra = app.db.get<{ version_id: string; content_html: string | null; summary_html: string | null; content_omitted: number; enclosures: string | null; image_url: string | null; version_created: string; is_private: number | null }>(
    `SELECT v.id AS version_id, v.content_html, v.summary_html, v.content_omitted, i.enclosures, i.image_url, v.created_at AS version_created, s.is_private FROM items i
     JOIN item_versions v ON v.id = i.current_version_id LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`, id)!;
  const keptVersion = app.db.get<{ kept_at: string; version_id: string; content_html: string | null; summary_html: string | null; content_omitted: number; title: string; url: string | null }>(
    `SELECT b.kept_at, b.version_id, v.content_html, v.summary_html, v.content_omitted, v.title, v.url FROM basket_items b JOIN item_versions v ON v.id = b.version_id
     WHERE b.item_id = ? ORDER BY b.kept_at LIMIT 1`, id);
  const captures: CaptureDTO[] = [];
  const base = keptVersion ?? { kept_at: extra.version_created, content_html: extra.content_html };
  if (dto.basketIds.length) {
    const level = base.content_html ? "feed" : "metadata";
    captures.push({ id: `snapshot:${id}`, level, label: CAPTURE_LABELS[level], createdAt: keptVersion?.kept_at ?? extra.version_created, note: null });
  }
  for (const c of app.db.all<{ id: string; kind: "fulltext" | "browser"; status: "pending" | "done" | "failed"; quality: string | null; partial_reason: PartialReason | null; error: string | null; created_at: string; completed_at: string | null }>(
    "SELECT id, kind, status, quality, partial_reason, error, created_at, completed_at FROM captures WHERE item_id = ? ORDER BY created_at", id)) {
    const level = c.status !== "done" ? c.status : c.kind === "browser" ? "browser" : c.quality === "partial" ? "partial" : "fulltext";
    // A failed try that carries a reason is a try again whose page was still only part of it: the copy saved earlier stays (captures.ts).
    const noBetter = c.status === "failed" && c.partial_reason !== null;
    captures.push({ id: c.id, level, label: noBetter ? "Tried again, nothing better" : CAPTURE_LABELS[level], createdAt: c.completed_at ?? c.created_at,
      note: noBetter ? `The page still gave only part of its text: ${partialReasonText(c.partial_reason!).split(": ").slice(1).join(": ")} The copy saved earlier stays.`
        : c.status === "failed" ? c.error : level === "browser" ? BROWSER_CAPTURE_NOTE : level === "partial" ? partialReasonText(c.partial_reason ?? "short") : null });
  }
  // Only a copy that passed the checks is the article; one that is only part of the page waits behind a toggle.
  const fulltext = app.db.get<{ id: string; html: string | null }>("SELECT id, html FROM captures WHERE item_id = ? AND status = 'done' AND quality IS NOT 'partial' ORDER BY completed_at DESC LIMIT 1", id);
  const partial = fulltext ? undefined : app.db.get<{ id: string; html: string | null; partial_reason: PartialReason | null }>(
    "SELECT id, html, partial_reason FROM captures WHERE item_id = ? AND status = 'done' AND quality = 'partial' ORDER BY completed_at DESC LIMIT 1", id);
  const stored = storedPictures(app, id);
  const pictures = (html: string | null) => withStoredPictures(html, stored, id);
  const current = extra.content_html ?? extra.summary_html;
  // A kept item shows the copy that was kept; an upstream edit never silently replaces it (plan/07).
  const changedSinceKept = !!keptVersion && keptVersion.version_id !== extra.version_id;
  const keptHtml = keptVersion ? keptVersion.content_html ?? keptVersion.summary_html : null;
  // Which stored text the reader shows, so a highlight can record what it was made on (plan/26).
  const contentRef: TextRef | null = fulltext && fulltext.html !== null ? { kind: "capture", id: fulltext.id }
    : changedSinceKept && keptVersion ? (keptHtml ? { kind: "version", id: keptVersion.version_id } : null)
    : current ? { kind: "version", id: extra.version_id } : null;
  const collections = app.db.all<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM collections c WHERE c.workspace_id = ? AND c.mode = 'sources'
       AND EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.collection_id = c.id AND cs.source_id = ?) ORDER BY c.position`,
    p.workspaceId, dto.sourceId ?? "");
  // Pictures that can't be shown on another site are sent only as their stored copies.
  const enclosures = (JSON.parse(extra.enclosures ?? "[]") as { url: string; type: string | null }[]).filter((e) => !copyOnlyPicture(e.url)).map((e) => ({ url: e.url, type: e.type }));
  return {
    ...dto,
    // A kept item reads as it was kept; the latest version is available alongside (plan/07).
    ...(changedSinceKept && keptVersion ? keptLink(keptVersion.title, keptVersion.url, extra.enclosures, dto.url, dto.linkIsMedia === true, extra.is_private === 1) : {}),
    contentHtml: pictures(fulltext?.html ?? (changedSinceKept ? keptHtml : current)),
    keptPicture: extra.image_url && stored.has(extra.image_url) ? pictureUrl(id, stored.get(extra.image_url)!) : null,
    gallery: postGallery(app, id, stored),
    partialCopy: partial?.html ? { html: pictures(partial.html)!, reason: partial.partial_reason ?? "short", note: partialReasonText(partial.partial_reason ?? "short"), ref: { kind: "capture", id: partial.id } } : null,
    contentOmitted: !fulltext && (changedSinceKept && keptVersion ? keptVersion.content_omitted : extra.content_omitted) === 1,
    // A readable copy is the article. Without one, what the feed sent is only a summary when it is short or cut off.
    // A post (Bluesky's, Instagram's) and the installation's own news posts (services/news.ts) are whole, however short.
    summaryOnly: !fulltext && dto.kind !== "post" && looksLikeSummary(changedSinceKept ? keptHtml : current)
      && !app.db.get("SELECT 1 FROM sources WHERE id = ? AND builtin IS NOT NULL", dto.sourceId ?? ""),
    changedSinceKept,
    latestHtml: changedSinceKept ? pictures(current) : null,
    contentRef,
    latestRef: changedSinceKept && current ? { kind: "version", id: extra.version_id } : null,
    captures,
    keptVersionAt: keptVersion?.kept_at ?? null,
    enclosures: extra.is_private ? [] : enclosures,
    collections,
    playback: getPlayback(app, p.workspaceId, id),
    renamable: !!app.db.get("SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.kind = 'manual'", id),
  };
}
