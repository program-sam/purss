import type { ItemDTO, ItemDetail, ItemIds, ItemIdsQuery, ItemListQuery, KeptDisplay, CaptureDTO, WorkflowState } from "@purss/domain";
import { MAX_BULK_ITEMS, itemIdsQuerySchema, itemListQuerySchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { badRequest, notFound } from "../http.ts";
import type { SqlParam } from "../db/database.ts";
import type { z } from "zod";
import { displayAuthor, displayExcerpt, displayTitle, excerptBeyondTitle } from "./content.ts";
import { getPlayback, itemLinkIsMedia, itemMedia } from "./media.ts";
import { indexedWord, searchTerms } from "./search-text.ts";
import { looksLikeSummary } from "./teaser.ts";
import { searchBody, shownText } from "./item-store.ts";
import { onHomeItem } from "./home-sources.ts";
import { NOT_MUTED_ROW, countMuted, accountMuted } from "./muted.ts";
import { copyOnlyPicture, partialReasonText } from "@purss/connectors";
import type { PartialReason } from "@purss/connectors";
import { pictureUrl, postGallery, storedPictures, withStoredPictures } from "./images.ts";
import { failedCopy } from "./capture-state.ts";
import { VIEW_FROM, scopeClause, textMatch, viewConditions, viewTotal } from "./item-view.ts";
import { keptDisplays } from "./kept-display.ts";
import { server } from "@purss/translations/server";

// ---------- listing ----------

export const ITEM_COLUMNS = `i.id, i.number, i.source_id, s.title AS source_title, s.kind AS source_kind, i.kind, i.title, i.url, i.author, i.excerpt, i.image_url,
  i.duration_seconds, i.read_minutes, i.doi, i.published_at, i.discovered_at, i.listed_at, i.curator_note, st.workflow, st.revision, st.workflow_revision, st.playback_workflow_session, st.state_version, st.is_new, st.progress, st.opened_at,
  (SELECT group_concat(b.basket_id) FROM basket_items b WHERE b.item_id = i.id) AS basket_ids,
  i.enclosures, COALESCE(s.is_private, 0) AS is_private,
  (SELECT MAX(a.received_at) FROM annotations a WHERE a.item_id = i.id) AS annotated_at,
  (SELECT g.id FROM item_images g WHERE g.item_id = i.id AND g.url = i.image_url) AS image_kept`;

export type ItemRow = {
  id: string; number: number; source_id: string | null; source_title: string | null; source_kind: string | null; kind: string; title: string; url: string | null; author: string | null;
  excerpt: string | null; image_url: string | null; duration_seconds: number | null; read_minutes: number | null; doi: string | null;
  published_at: string | null; discovered_at: string; listed_at: string; curator_note: string | null; workflow: WorkflowState; revision: number; workflow_revision: number; playback_workflow_session: string | null; state_version: number; is_new: number;
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
    id: r.id, number: r.number, sourceId: r.source_id, sourceTitle: r.source_title ?? server.api.shared.keptLink, keptByHand: r.source_id === null || r.source_kind === "manual", kind: r.kind as ItemDTO["kind"], title: displayTitle(r.title), url: r.is_private === 1 && linkIsMedia ? null : r.url, author: displayAuthor(r.author),
    excerpt: excerptBeyondTitle(r.title, displayExcerpt(r.excerpt)), imageUrl: shownImage(r), durationSeconds: r.duration_seconds, readMinutes: r.read_minutes, doi: r.doi,
    publishedAt: r.published_at, discoveredAt: r.discovered_at, listedAt: r.listed_at, workflow: r.workflow, revision: r.revision, workflowRevision: r.workflow_revision, playbackWorkflowSessionId: r.playback_workflow_session, stateVersion: r.state_version, isNew: r.is_new === 1,
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

const SORT_SQL = {
  newest: { key: "i.listed_at", dir: "DESC" },
  oldest: { key: "i.listed_at", dir: "ASC" },
  // The source's title and the kept time are stored with the item and indexed in these orders.
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
  const params: SqlParam[] = [p.accountId];
  const where = ["i.account_id = ?"];
  const [kind, id] = q.scope.split(":") as [string, string | undefined];
  const ofSources = kind === "source" || kind === "loose"
    || (kind === "collection" && app.db.get<{ mode: string }>("SELECT mode FROM collections WHERE id = ? AND account_id = ?", id!, p.accountId)?.mode === "sources");
  if (ofSources) where.push(scopeClause(app, p, q.scope, params));
  if (q.source) { const ids = q.source.split(","); where.push(`i.source_id IN (${ids.map(() => "?").join(", ")})`); params.push(...ids); }
  if (where.length === 1) return inOrder;
  const below = listTuning.sortFromRowsBelow;
  const few = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM items i WHERE ${where.join(" AND ")} LIMIT ?)`, ...params, below)!.n < below;
  return few ? { ...sort, inOrder: false } : inOrder;
}

/**
 * Home's order: Undecided items first, then the rest the filter allows (the Only new layout's New items put aside), newest first within each. Listed as two runs, each
 * in the date order, so each reads the date index in order instead of sorting every candidate.
 */
const HOME_RUNS = ["st.workflow = 'undecided'", "st.workflow <> 'undecided'"] as const;
/** The queue's order: what is started first, then what is waiting, each in the list's own order. */
const QUEUE_RUNS = ["st.workflow = 'inprogress'", "st.workflow = 'toread'"] as const;
/** The runs a list is read in, or none when it is read in one pass. */
const runsOf = (q: { scope: string; mix?: string }): readonly string[] | null => q.mix === "home" ? HOME_RUNS : q.scope === "toread" ? QUEUE_RUNS : null;

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
  const muted = q.q || q.scope.startsWith("basket:") || q.muted === "show" ? null : accountMuted(app, p.accountId);
  return listPage(app, p, q, opts, muted);
}

/** What a list (its page and its "Select all") is narrowed by: its scope, state filter, chips, search and Home's rules. */
function listConditions(app: App, p: Principal, q: Omit<z.infer<typeof itemListQuerySchema>, "cursor" | "limit">, opts: ListOptions, snapshot: number | null): { where: string[]; params: SqlParam[] } {
  const { where, params } = viewConditions(app, p, q);
  if (q.source) { const ids = q.source.split(","); where.push(`i.source_id IN (${ids.map(() => "?").join(", ")})`); params.push(...ids); }
  if (q.exceptPrivate) where.push("COALESCE(s.is_private, 0) = 0");
  if (q.without) { const ids = q.without.split(","); where.push(`(i.source_id IS NULL OR i.source_id NOT IN (${ids.map(() => "?").join(", ")}))`); params.push(...ids); }
  // the items whose readable copy couldn't be saved (what the bell's "Couldn't save the text of N items" opens).
  if (q.capture === "failed") where.push(failedCopy("i.id"));
  where.push(...typeLengthConditions(q));
  if (opts.homeVisible || q.mix === "home") where.push(onHomeItem(app, p.accountId, params));
  if (snapshot !== null) { where.push("i.seq <= ?"); params.push(snapshot); }
  if (q.q) where.push(textMatch(q.q, params));
  return { where, params };
}

/**
 * Every item a list shows, in its order, for "Select all": the same conditions and muted words as its pages, at most
 * MAX_BULK_ITEMS, with how many there are in all when that's no more. Past it the total is null: counting the rest would
 * read (and test the muted words against) every item in the list, seconds for a large library.
 */
export function listItemIds(app: App, p: Principal, input: ItemIdsQuery, opts: ListOptions = {}): ItemIds {
  const q = itemIdsQuerySchema.parse(input);
  const muted = q.q || q.scope.startsWith("basket:") || q.muted === "show" ? null : accountMuted(app, p.accountId);
  const { where, params } = listConditions(app, p, q, opts, null);
  const sort = listSort(app, p, q);
  const ordered = `SELECT ${ITEM_COLUMNS}, ${sort.key} AS sort_key ${VIEW_FROM} WHERE ${where.join(" AND ")} ${orderBy(sort, "sort_key")}`;
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
  const ordered = `SELECT ${ITEM_COLUMNS}, ${sort.key} AS sort_key ${VIEW_FROM} WHERE ${w.join(" AND ")} ${orderBy(sort, "sort_key")}`;
  return muted
    ? app.db.all<SortedRow>(`SELECT * FROM (${ordered} LIMIT -1) WHERE ${NOT_MUTED_ROW} LIMIT ?`, ...ps, muted, limit)
    : app.db.all<SortedRow>(`${ordered} LIMIT ?`, ...ps, limit);
}

/** One page of a list; `muted`: the muted words (see `accountMuted`) whose items the list leaves out. */
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
    } catch { throw badRequest(server.api.items.pageLinkExpired); }
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
  const kept = keptDisplays(app, p.accountId, page.filter((r) => r.basket_ids).map((r) => r.id));
  // A list narrowed by more than its scope and state has no total: counting it would read every item the narrowing looks at.
  const narrowed = !!(q.type || q.length || q.without || q.capture || opts.homeVisible || home || muted);
  // Without a search or chips the total is added up from the PURSS's counts when that is the cheaper way (item-view.ts).
  const total = q.cursor || narrowed ? null
    : (q.q || q.source || q.exceptPrivate ? null : viewTotal(app, p, q))
      ?? app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${VIEW_FROM} WHERE ${where.join(" AND ")}`, ...params)!.n;
  const out: ListResult = { items: page.map((r) => toDTO(r, kept.get(r.id))), nextCursor, total };
  if (muted && !q.cursor) {
    // What the list leaves out, counted among the first candidates it would hold without the muted words (see `mutedScan`).
    // In the date order, so the candidates are found the way the page finds them (by its scope's narrowest index).
    const { hidden, atLeast } = countMuted(app, muted, VIEW_FROM, where.join(" AND "), params, orderBy(sort, sort.key));
    out.mutedHidden = hidden;
    if (atLeast) out.mutedHiddenAtLeast = true;
  }
  return out;
}

/**
 * `sortFromRowsBelow`: a list sorted by kept time or by source is read in order from its PURSS-wide index and
 * stops once the page is full; a list of a few sources' items would walk most of the PURSS to find them that way (a source of
 * 80 items took 65 to 180 ms instead of 2 at 100,000 items), so one with fewer items than this sorts them instead, as every such
 * list did before the keys were stored. Finding out reads at most this many entries of a source index.
 *
 * A test hook, so the tests can take either way with few items.
 */
export const listTuning = { sortFromRowsBelow: 2000 };

/** The item with this number in the person's account (its short link, /app/i/<number>). */
export function itemIdByNumber(app: App, p: Principal, number: number): { id: string } {
  const row = app.db.get<{ id: string }>("SELECT id FROM items WHERE account_id = ? AND number = ?", p.accountId, number);
  if (!row) throw notFound(server.api.shared.thatItem);
  return { id: row.id };
}

export function getItem(app: App, p: Principal, id: string): ItemDTO {
  const row = app.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.account_id = ?`, id, p.accountId);
  if (!row) throw notFound(server.api.shared.thatItem);
  return toDTO(row, keptDisplays(app, p.accountId, row.basket_ids ? [id] : []).get(id));
}

const CAPTURE_LABELS = {
  metadata: server.api.shared.labelMetadata,
  feed: server.api.shared.labelFeed,
  fulltext: server.api.shared.labelFulltext,
  partial: server.api.items.labelPartial,
  browser: server.api.items.labelBrowser,
  pending: server.api.items.labelPending,
  failed: server.api.items.labelFailed,
} as const;

/** Shown with a browser capture: where its text came from and what that means. */
export const BROWSER_CAPTURE_NOTE = server.api.items.browserCaptureNote;

export function getItemDetail(app: App, p: Principal, id: string): ItemDetail {
  const dto = getItem(app, p, id);
  const extra = app.db.get<{ enclosures: string | null; image_url: string | null; is_private: number | null }>(
    "SELECT i.enclosures, i.image_url, s.is_private FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?", id)!;
  // Which text is shown is the item store's rule, the one the reading time follows too.
  const shown = shownText(app, id);
  const keptVersion = shown.kept;
  const captures: CaptureDTO[] = [];
  const base = keptVersion ?? { keptAt: shown.current.createdAt, contentHtml: shown.current.contentHtml };
  if (dto.basketIds.length) {
    const level = base.contentHtml ? "feed" : "metadata";
    captures.push({ id: `snapshot:${id}`, level, label: CAPTURE_LABELS[level], createdAt: keptVersion?.keptAt ?? shown.current.createdAt, note: null });
  }
  for (const c of app.db.all<{ id: string; kind: "fulltext" | "browser"; status: "pending" | "done" | "failed"; quality: string | null; partial_reason: PartialReason | null; error: string | null; created_at: string; completed_at: string | null }>(
    "SELECT id, kind, status, quality, partial_reason, error, created_at, completed_at FROM captures WHERE item_id = ? ORDER BY created_at", id)) {
    const level = c.status !== "done" ? c.status : c.kind === "browser" ? "browser" : c.quality === "partial" ? "partial" : "fulltext";
    // A failed try that carries a reason is a try again whose page was still only part of it: the copy saved earlier stays (captures.ts).
    const noBetter = c.status === "failed" && c.partial_reason !== null;
    captures.push({ id: c.id, level, label: noBetter ? server.api.items.triedAgainNothingBetter : CAPTURE_LABELS[level], createdAt: c.completed_at ?? c.created_at,
      note: noBetter ? server.api.items.stillPartial(partialReasonText(c.partial_reason!).split(": ").slice(1).join(": "))
        : c.status === "failed" ? c.error : level === "browser" ? BROWSER_CAPTURE_NOTE : level === "partial" ? partialReasonText(c.partial_reason ?? "short") : null });
  }
  // Only a copy that passed the checks is the article; one that is only part of the page waits behind a toggle.
  const fulltext = shown.copy ?? undefined;
  const partial = fulltext ? undefined : app.db.get<{ id: string; html: string | null; partial_reason: PartialReason | null }>(
    "SELECT id, html, partial_reason FROM captures WHERE item_id = ? AND status = 'done' AND quality = 'partial' ORDER BY completed_at DESC LIMIT 1", id);
  const stored = storedPictures(app, id);
  const pictures = (html: string | null) => withStoredPictures(html, stored, id);
  const current = shown.current.contentHtml ?? shown.current.summaryHtml;
  // A kept item shows the copy that was kept; an upstream edit never silently replaces it.
  const changedSinceKept = shown.changedSinceKept;
  const keptHtml = keptVersion ? keptVersion.contentHtml ?? keptVersion.summaryHtml : null;
  const collections = app.db.all<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM collections c WHERE c.account_id = ? AND c.mode = 'sources'
       AND EXISTS (SELECT 1 FROM collection_sources cs WHERE cs.collection_id = c.id AND cs.source_id = ?) ORDER BY c.position`,
    p.accountId, dto.sourceId ?? "");
  // Pictures that can't be shown on another site are sent only as their stored copies.
  const enclosures = (JSON.parse(extra.enclosures ?? "[]") as { url: string; type: string | null }[]).filter((e) => !copyOnlyPicture(e.url)).map((e) => ({ url: e.url, type: e.type }));
  return {
    ...dto,
    // A kept item reads as it was kept; the latest version is available alongside.
    ...(changedSinceKept && keptVersion ? keptLink(keptVersion.title, keptVersion.url, extra.enclosures, dto.url, dto.linkIsMedia === true, extra.is_private === 1) : {}),
    contentHtml: pictures(shown.html),
    keptPicture: extra.image_url && stored.has(extra.image_url) ? pictureUrl(id, stored.get(extra.image_url)!) : null,
    gallery: postGallery(app, id, stored),
    partialCopy: partial?.html ? { html: pictures(partial.html)!, reason: partial.partial_reason ?? "short", note: partialReasonText(partial.partial_reason ?? "short"), ref: { kind: "capture", id: partial.id } } : null,
    contentOmitted: !fulltext && (changedSinceKept && keptVersion ? keptVersion.contentOmitted : shown.current.contentOmitted),
    // A readable copy is the article. Without one, what the feed sent is only a summary when it is short or cut off.
    // A post (Bluesky's, Instagram's) and the installation's own news posts (services/news.ts) are whole, however short.
    summaryOnly: !fulltext && dto.kind !== "post" && looksLikeSummary(changedSinceKept ? keptHtml : current)
      && !app.db.get("SELECT 1 FROM sources WHERE id = ? AND builtin IS NOT NULL", dto.sourceId ?? ""),
    changedSinceKept,
    latestHtml: changedSinceKept ? pictures(current) : null,
    contentRef: shown.ref,
    latestRef: changedSinceKept && current ? { kind: "version", id: shown.current.id } : null,
    captures,
    keptVersionAt: keptVersion?.keptAt ?? null,
    enclosures: extra.is_private ? [] : enclosures,
    collections,
    playback: getPlayback(app, p.accountId, id),
    renamable: !!app.db.get("SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.kind = 'manual'", id),
  };
}
