import { newId, measureBytes } from "@purss/domain";
import type { StoredObjectKind, TextRef, WorkflowState } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { nowIso } from "../http.ts";
import { StorageFull, admitObject, markPaused, recordObject, releaseObject, releaseReservation } from "./storage.ts";
import { NO_TITLE, contentHash, excerpt, readMinutes, sanitize, toText } from "./content.ts";
import { linkKey, urlKey } from "./url-key.ts";
import { firstImage } from "./first-image.ts";
import { foldForSearch } from "./search-text.ts";
import { forgetPlayback } from "./media.ts";
import { deleteItemAnnotations } from "./annotations.ts";
import { forgetItemVerdicts } from "./ai-access.ts";

/*
 * The item store: the one place an item is made, revised and removed. Whichever way it arrives (an engine sync, an
 * archive import, a news post, a link kept by hand), the same code writes its row, its versions and its state, works out
 * what the row derives from its current version (url_key, link_key, excerpt, read_minutes, source_title), puts it in the
 * search index, and records what it stores in the storage ledger. Removing it undoes all of that. Callers hand in inputs
 * and never write these rows; item-store.test.ts recomputes everything from the current version after each path.
 */

export type NewItem = {
  accountId: string;
  sourceId: string | null;
  kind: string;
  /** Empty when the item has none: it is then headed with the start of its text. */
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
  /** The item's time in lists; its publication date, else its arrival, when not given. */
  listedAt?: string;
  enclosures: { url: string; type: string | null; length?: number | null }[];
  /** The feed's full text was too large to send; the item holds its summary only. */
  contentOmitted?: boolean;
  isNew: boolean;
  /** Backlog of a source followed from now: stored as Ignored, so it is hidden from lists and left out of Home and the counts, and search still finds it. */
  ignored?: boolean;
  reason: string;
};

/** What an upstream edit changes: the new text and attributes of an item (see `updateItem`). */
export type ItemRevision = {
  title: string; url: string | null; author: string | null; summaryHtml: string | null; contentHtml: string | null; imageUrl: string | null;
  enclosures: { url: string; type: string | null; length?: number | null }[]; publishedAt: string | null; contentOmitted?: boolean;
};

/** A version an archive import brings back, its text already sanitised and hashed (see `prepareVersion`). */
export type RestoredVersion = { id: string; title: string; url: string | null; summaryHtml: string | null; contentHtml: string | null; hash: string; createdAt: string; bytes: number };

/** A readable copy an archive import brings back. */
export type RestoredCapture = {
  id: string; kind: "fulltext" | "browser"; status: "done" | "failed"; title: string | null; text: string | null; html: string | null; finalUrl: string | null; error: string | null;
  quality: "full" | "partial" | null; partialReason: "gated" | "references" | "short" | null; createdAt: string; completedAt: string | null; bytes: number;
};

/** An item an archive import brings back, with what it already was: its number, versions, state and readable copies. */
export type RestoredItem = {
  id: string; number: number | null; accountId: string; sourceId: string;
  kind: string; title: string; url: string | null; author: string | null; imageUrl: string | null; durationSeconds: number | null; doi: string | null; curatorNote: string | null;
  publishedAt: string | null; discoveredAt: string; listedAt: string; createdAt: string; enclosures: { url: string; type: string | null; length: number | null }[];
  versions: RestoredVersion[]; currentVersionId: string;
  state: { workflow: WorkflowState; isNew: boolean; progress: number; openedAt: string | null };
  /** What the item's small "state" record is measured at in the ledger; 0 when the state is the default and no record is kept. */
  stateBytes: number;
  captures: RestoredCapture[];
};

// ---------- what an item derives from its current version

/** The plain text of a version, and the excerpt and reading time an item shows for it. Reads the markup, so it is done once and only for a version that is stored. */
function derive(kind: string, summaryHtml: string | null, contentHtml: string | null) {
  const summaryText = toText(summaryHtml);
  const text = contentHtml == null ? summaryText : toText(contentHtml);
  return {
    text,
    excerpt: excerpt(summaryText || text),
    readMinutes: kind === "video" || kind === "podcast" ? null : readMinutes(text),
  };
}

/** The title an item is stored with: the one it arrived with, else the start of its text, else the marker for none. Reads the text only when it has to. */
function headlineOf(title: string, summaryHtml: string | null, contentHtml: string | null): string {
  return title.trim() || excerpt(toText(summaryHtml ?? contentHtml), 80) || NO_TITLE;
}

// ---------- the text the reader shows

/** A stored version of an item, as `shownText` reads it. */
export type ShownVersion = { id: string; title: string; url: string | null; contentHtml: string | null; summaryHtml: string | null; contentOmitted: boolean; createdAt: string };

/** What the reader shows for an item, and the stored texts it chose between. */
export type ShownText = {
  /** The newest finished readable copy that is the whole page and has markup to show, a browser capture included. */
  copy: { id: string; html: string } | null;
  current: ShownVersion;
  /** The version the earliest basket kept, and when; null when no basket keeps the item. */
  kept: (ShownVersion & { keptAt: string }) | null;
  /** A basket's kept version is shown, because the item has been revised since. */
  changedSinceKept: boolean;
  /** What is shown, and which stored text it is. */
  html: string | null;
  ref: TextRef | null;
};

/**
 * The one rule for which text the reader shows for an item: its newest readable copy that is the whole page and has markup to show, else the version the
 * earliest basket kept while an edit has since replaced it as the current version, else the current version. `getItemDetail` shows
 * exactly this, and the item's reading time is that of this text (`refreshReadingTime`).
 */
export function shownText(app: App, itemId: string): ShownText {
  const version = `v.id, v.title, v.url, v.content_html, v.summary_html, v.content_omitted, v.created_at`;
  type Row = { id: string; title: string; url: string | null; content_html: string | null; summary_html: string | null; content_omitted: number; created_at: string };
  const asVersion = (r: Row): ShownVersion => ({ id: r.id, title: r.title, url: r.url, contentHtml: r.content_html, summaryHtml: r.summary_html, contentOmitted: r.content_omitted === 1, createdAt: r.created_at });
  const copy = app.db.get<{ id: string; html: string }>(
    "SELECT id, html FROM captures WHERE item_id = ? AND status = 'done' AND quality IS NOT 'partial' AND html IS NOT NULL ORDER BY completed_at DESC LIMIT 1", itemId) ?? null;
  const current = asVersion(app.db.get<Row>(`SELECT ${version} FROM items i JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?`, itemId)!);
  const keptRow = app.db.get<Row & { kept_at: string }>(
    `SELECT ${version}, b.kept_at FROM basket_items b JOIN item_versions v ON v.id = b.version_id WHERE b.item_id = ? ORDER BY b.kept_at LIMIT 1`, itemId);
  const kept = keptRow ? { ...asVersion(keptRow), keptAt: keptRow.kept_at } : null;
  const changedSinceKept = !!kept && kept.id !== current.id;
  const keptHtml = kept ? kept.contentHtml ?? kept.summaryHtml : null;
  const currentHtml = current.contentHtml ?? current.summaryHtml;
  const ref: TextRef | null = copy ? { kind: "capture", id: copy.id }
    : changedSinceKept && kept ? (keptHtml ? { kind: "version", id: kept.id } : null)
    : currentHtml ? { kind: "version", id: current.id } : null;
  return { copy, current, kept, changedSinceKept, html: copy?.html ?? (changedSinceKept ? keptHtml : currentHtml), ref };
}

/**
 * Set an item's reading time from the text the reader shows for it (`shownText`), the way a complete readable copy sets it: the copy is the
 * article, where the feed's text was a summary. A video or a podcast episode has none. Call it after anything that can change which text is
 * shown or what it says: an edit, a readable copy completed or saved from the browser, an import, a basket kept version removed
 * (`keptVersionsChanged`). `known` is a version's plain text the caller has already read, so it is not read again.
 */
export function refreshReadingTime(app: App, itemId: string, known?: { versionId: string; text: string }): void {
  const item = app.db.get<{ kind: string }>("SELECT kind FROM items WHERE id = ?", itemId);
  if (!item || item.kind === "video" || item.kind === "podcast") return;
  const shown = shownText(app, itemId);
  let text: string;
  if (shown.copy) {
    // The copy's own plain text, where it has any; its markup says the same otherwise.
    text = app.db.get<{ text: string | null }>("SELECT text FROM captures WHERE id = ?", shown.copy.id)?.text || toText(shown.copy.html);
  } else {
    const version = shown.changedSinceKept ? shown.kept! : shown.current;
    text = known?.versionId === version.id ? known.text : toText(version.contentHtml ?? version.summaryHtml);
  }
  app.db.run("UPDATE items SET read_minutes = ? WHERE id = ?", readMinutes(text), itemId);
}

/**
 * Which version the reader shows depends on which versions the baskets kept, which matters only once an item has more than one. Call after a
 * basket's kept version is added or removed (`markMembershipChanged` does).
 */
export function keptVersionsChanged(app: App, itemId: string): void {
  if (app.db.all("SELECT 1 FROM item_versions WHERE item_id = ? LIMIT 2", itemId).length < 2) return;
  refreshReadingTime(app, itemId);
}

/** A version's text as it is stored: sanitised, with the hash that tells a later delivery whether it changed. */
export function prepareVersion(v: { title: string; url: string | null; summaryHtml: string | null; contentHtml: string | null }): { summaryHtml: string | null; contentHtml: string | null; hash: string } {
  const summaryHtml = sanitize(v.summaryHtml);
  const contentHtml = sanitize(v.contentHtml);
  return { summaryHtml, contentHtml, hash: contentHash(v.title, v.url, summaryHtml, contentHtml) };
}

/** What a version is measured at in the storage ledger: its text and the attributes the item shows with it. */
export function versionBytes(v: { title: string; url: string | null; author: string | null; summaryHtml: string | null; contentHtml: string | null; imageUrl: string | null; enclosures: readonly unknown[]; publishedAt: string | null }): number {
  return measureBytes(v);
}

type ItemColumns = {
  id: string; number: number | null; accountId: string; sourceId: string | null; kind: string; title: string; url: string | null; author: string | null; excerpt: string | null; imageUrl: string | null;
  durationSeconds: number | null; readMinutes: number | null; doi: string | null; curatorNote: string | null; publishedAt: string | null; discoveredAt: string; listedAt: string;
  currentVersionId: string; enclosures: unknown[]; createdAt: string; updatedAt: string;
};

function writeItem(app: App, c: ItemColumns): number {
  return app.db.run(
    `INSERT INTO items (id, number, account_id, source_id, source_title, kind, title, url, url_key, link_key, author, excerpt, image_url, duration_seconds,
       read_minutes, doi, curator_note, published_at, discovered_at, listed_at, current_version_id, enclosures, created_at, updated_at)
     VALUES (?, ?, ?, ?, COALESCE((SELECT title FROM sources WHERE id = ?), ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id, c.number, c.accountId, c.sourceId, c.sourceId, c.kind, c.title, c.url, urlKey(c.url), c.url ? linkKey(c.url) : null, c.author, c.excerpt, c.imageUrl, c.durationSeconds,
    c.readMinutes, c.doi, c.curatorNote, c.publishedAt, c.discoveredAt, c.listedAt, c.currentVersionId, JSON.stringify(c.enclosures.slice(0, 10)), c.createdAt, c.updatedAt,
  ).lastInsertRowid;
}

function writeVersion(app: App, v: { id: string; itemId: string; accountId: string; title: string; url: string | null; summaryHtml: string | null; contentHtml: string | null; hash: string; contentOmitted: boolean; createdAt: string }): void {
  app.db.run(
    "INSERT INTO item_versions (id, item_id, account_id, title, url, summary_html, content_html, content_hash, content_omitted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    v.id, v.itemId, v.accountId, v.title, v.url, v.summaryHtml, v.contentHtml, v.hash, v.contentOmitted ? 1 : 0, v.createdAt);
}

function writeState(app: App, s: { itemId: string; accountId: string; sourceId: string | null; workflow: WorkflowState; isNew: boolean; progress: number; openedAt: string | null; at: string }): void {
  app.db.run("INSERT INTO item_state (item_id, account_id, source_id, workflow, is_new, progress, opened_at, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
    s.itemId, s.accountId, s.sourceId, s.workflow, s.isNew ? 1 : 0, s.progress, s.openedAt, s.at);
}

// ---------- the search index

/** The text search indexes for an item besides its title: its content (or summary) and any captured readable text. */
export function searchBody(app: App, itemId: string, contentHtml: string | null, summaryHtml: string | null): string {
  return indexBody(app, itemId, toText(contentHtml ?? summaryHtml));
}

function indexBody(app: App, itemId: string, text: string): string {
  const captured = app.db.all<{ text: string | null }>("SELECT text FROM captures WHERE item_id = ? AND status = 'done' AND quality IS NOT 'partial'", itemId).map((c) => c.text ?? "").join(" ");
  return `${text} ${captured}`.trim();
}

/** Re-index an item's searchable text (after edits or captures). */
export function reindex(app: App, itemId: string): void {
  const row = app.db.get<{ seq: number; title: string; excerpt: string | null; author: string | null; content_html: string | null; summary_html: string | null }>(
    `SELECT i.seq, i.title, i.excerpt, i.author, v.content_html, v.summary_html FROM items i LEFT JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?`, itemId);
  if (!row) return;
  indexItem(app, itemId, row.seq, { title: row.title, excerpt: row.excerpt, author: row.author }, toText(row.content_html ?? row.summary_html));
}

/** An item's search entry made, or made again, from text already read: the text of its current version and any readable copies. */
function indexItem(app: App, itemId: string, seq: number, f: { title: string; excerpt: string | null; author: string | null }, text: string): void {
  app.db.run("DELETE FROM items_fts WHERE rowid = ?", seq);
  indexText(app, seq, { title: f.title, excerpt: f.excerpt ?? "", author: f.author ?? "", body: indexBody(app, itemId, text) });
}

/** Put an item's searchable text into the index in its folded form (see search-text.ts). Every writer of the index goes through here. */
export function indexText(app: App, seq: number, t: { title: string; excerpt: string; author: string; body: string }): void {
  app.db.run("INSERT INTO items_fts (rowid, title, excerpt, author, body) VALUES (?, ?, ?, ?, ?)", seq, foldForSearch(t.title), foldForSearch(t.excerpt), foldForSearch(t.author), foldForSearch(t.body));
}

// ---------- making an item

/** Create an item with its first immutable version, state, search entry and storage object. */
export function insertItem(app: App, n: NewItem): { id: string; versionId: string; seq: number } {
  const id = newId("itm");
  const versionId = newId("ver");
  const now = nowIso();
  const summaryHtml = sanitize(n.summaryHtml);
  const contentHtml = sanitize(n.contentHtml);
  const title = headlineOf(n.title, summaryHtml, contentHtml);
  const d = derive(n.kind, summaryHtml, contentHtml);
  const seq = writeItem(app, {
    id, number: null, accountId: n.accountId, sourceId: n.sourceId, kind: n.kind, title, url: n.url, author: n.author, excerpt: d.excerpt,
    imageUrl: n.imageUrl ?? firstImage(contentHtml ?? summaryHtml), durationSeconds: n.durationSeconds, readMinutes: d.readMinutes, doi: n.doi, curatorNote: n.curatorNote,
    publishedAt: n.publishedAt, discoveredAt: n.discoveredAt, listedAt: n.listedAt ?? n.publishedAt ?? n.discoveredAt, currentVersionId: versionId, enclosures: n.enclosures, createdAt: now, updatedAt: now,
  });
  writeVersion(app, { id: versionId, itemId: id, accountId: n.accountId, title, url: n.url, summaryHtml, contentHtml, hash: contentHash(title, n.url, summaryHtml, contentHtml), contentOmitted: n.contentOmitted === true, createdAt: now });
  writeState(app, { itemId: id, accountId: n.accountId, sourceId: n.sourceId, workflow: n.ignored ? "ignored" : "undecided", isNew: n.isNew, progress: 0, openedAt: null, at: now });
  indexText(app, seq, { title, excerpt: d.excerpt ?? "", author: n.author ?? "", body: d.text });
  admitObject(app, {
    accountId: n.accountId, kind: "item_version", refId: versionId, itemId: id, sourceId: n.sourceId,
    bytes: versionBytes({ title, url: n.url, author: n.author, summaryHtml, contentHtml, imageUrl: n.imageUrl, enclosures: n.enclosures, publishedAt: n.publishedAt }),
    reason: n.reason,
  });
  return { id, versionId, seq };
}

/**
 * Put an item back as an archive import found it. Its growth was admitted once, for the whole import, so what it stores is
 * recorded in the ledger without another check. Returns how many finished readable copies it brought.
 */
export function restoreItem(app: App, r: RestoredItem): number {
  const now = nowIso();
  const current = r.versions.find((v) => v.id === r.currentVersionId)!;
  const d = derive(r.kind, current.summaryHtml, current.contentHtml);
  const seq = writeItem(app, {
    id: r.id, number: r.number, accountId: r.accountId, sourceId: r.sourceId, kind: r.kind, title: r.title, url: r.url, author: r.author, excerpt: d.excerpt,
    imageUrl: r.imageUrl, durationSeconds: r.durationSeconds, readMinutes: d.readMinutes, doi: r.doi, curatorNote: r.curatorNote, publishedAt: r.publishedAt,
    discoveredAt: r.discoveredAt, listedAt: r.listedAt, currentVersionId: r.currentVersionId, enclosures: r.enclosures, createdAt: r.createdAt, updatedAt: now,
  });
  for (const v of r.versions) restoreVersion(app, r.accountId, r.id, r.sourceId, v);
  writeState(app, { itemId: r.id, accountId: r.accountId, sourceId: r.sourceId, ...r.state, at: now });
  if (r.stateBytes) recordObject(app, { accountId: r.accountId, kind: "record", refId: `state:${r.id}`, bytes: r.stateBytes, reason: "import" });
  let copies = 0;
  for (const c of r.captures) {
    app.db.run("INSERT INTO captures (id, account_id, item_id, kind, status, title, text, html, final_url, error, quality, partial_reason, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.id, r.accountId, r.id, c.kind, c.status, c.title, c.text, c.html, c.finalUrl, c.error, c.quality, c.partialReason, c.createdAt, c.completedAt);
    if (c.status === "done") { recordObject(app, { accountId: r.accountId, kind: "capture", refId: c.id, itemId: r.id, bytes: c.bytes, reason: "import" }); copies++; }
  }
  // Without a readable copy the current version is what is shown (and its reading time is set), until a basket keeps another one.
  if (r.captures.length) refreshReadingTime(app, r.id, { versionId: r.currentVersionId, text: d.text });
  indexItem(app, r.id, seq, { title: r.title, excerpt: d.excerpt, author: r.author }, d.text);
  return copies;
}

/** Add a version an archive import brings back to an item (see `restoreItem`). */
export function restoreVersion(app: App, accountId: string, itemId: string, sourceId: string | null, v: RestoredVersion): void {
  writeVersion(app, { id: v.id, itemId, accountId, title: v.title, url: v.url, summaryHtml: v.summaryHtml, contentHtml: v.contentHtml, hash: v.hash, contentOmitted: false, createdAt: v.createdAt });
  recordObject(app, { accountId, kind: "item_version", refId: v.id, itemId, sourceId, bytes: v.bytes, reason: "import" });
}

// ---------- revising an item

/**
 * Apply an upstream edit. A kept (pinned) version is never modified: the edit becomes
 * a new current version, admitted as feed growth. When growth is paused the edit is
 * deferred (the batch still commits; the next edit or resync can apply it).
 */
export function updateItem(app: App, accountId: string, itemId: string, entry: ItemRevision): boolean {
  const cur = app.db.get<{ seq: number; current_version_id: string; content_hash: string; source_id: string | null; kind: string }>(
    "SELECT i.seq, i.current_version_id, v.content_hash, i.source_id, i.kind FROM items i JOIN item_versions v ON v.id = i.current_version_id WHERE i.id = ?", itemId);
  if (!cur) return false;
  // An update whose text was too large to send must not replace text the item already has: that stays as it is.
  const held = entry.contentOmitted
    ? app.db.get<{ summary_html: string | null; content_html: string | null; content_omitted: number }>("SELECT summary_html, content_html, content_omitted FROM item_versions WHERE id = ?", cur.current_version_id)
    : undefined;
  const keepText = !!held?.content_html;
  const summaryHtml = keepText ? held!.summary_html : sanitize(entry.summaryHtml);
  const contentHtml = keepText ? held!.content_html : sanitize(entry.contentHtml);
  const contentOmitted = entry.contentOmitted === true && !keepText;
  const title = headlineOf(entry.title, summaryHtml, contentHtml);
  const hash = contentHash(title, entry.url, summaryHtml, contentHtml);
  if (hash === cur.content_hash) return false;
  const d = derive(cur.kind, summaryHtml, contentHtml);
  const versionId = newId("ver");
  const now = nowIso();
  try {
    app.db.tx(() => {
      writeVersion(app, { id: versionId, itemId, accountId, title, url: entry.url, summaryHtml, contentHtml, hash, contentOmitted, createdAt: now });
      admitObject(app, {
        accountId, kind: "item_version", refId: versionId, itemId, sourceId: cur.source_id,
        bytes: versionBytes({ title, url: entry.url, author: entry.author, summaryHtml, contentHtml, imageUrl: entry.imageUrl, enclosures: entry.enclosures, publishedAt: entry.publishedAt }),
        reason: "feed item update",
      });
      // The files come with the revision: a rotated file address (a private feed's new token) must stay recognisable as the item's file.
      app.db.run("UPDATE items SET title = ?, url = ?, url_key = ?, link_key = ?, author = ?, excerpt = ?, image_url = COALESCE(?, image_url), enclosures = ?, current_version_id = ?, updated_at = ? WHERE id = ?",
        title, entry.url, urlKey(entry.url), entry.url ? linkKey(entry.url) : null, entry.author, d.excerpt, entry.imageUrl, JSON.stringify((entry.enclosures ?? []).slice(0, 10)), versionId, now, itemId);
      const pinned = app.db.get("SELECT 1 FROM basket_items WHERE version_id = ?", cur.current_version_id);
      if (!pinned) {
        // The superseded version was never kept: it is replaced, not retained.
        releaseObject(app, "item_version", cur.current_version_id, "replaced by upstream edit");
        app.db.run("DELETE FROM item_versions WHERE id = ?", cur.current_version_id);
      }
      indexItem(app, itemId, cur.seq, { title, excerpt: d.excerpt, author: entry.author }, d.text);
      // The new text is what the reader shows unless a readable copy or a kept version is: the reading time follows what is shown.
      refreshReadingTime(app, itemId, { versionId, text: d.text });
    });
    return true;
  } catch (err) {
    if (err instanceof StorageFull) { markPaused(app, err); return false; } // deferred while growth is paused
    throw err;
  }
}

// ---------- removing an item

/**
 * Permanently delete one item inside the caller's transaction (no confirmation here; callers
 * confirm first). Returns the bytes released, or null when the item isn't in this PURSS.
 */
export function deleteItemNow(app: App, p: Pick<Principal, "accountId">, id: string): number | null {
  let released = 0;
  const item = app.db.get<{ seq: number }>("SELECT seq FROM items WHERE id = ? AND account_id = ?", id, p.accountId);
  if (!item) return null;
  for (const o of app.db.all<{ kind: StoredObjectKind; ref_id: string }>("SELECT kind, ref_id FROM stored_objects WHERE item_id = ? AND released_at IS NULL", id)) {
    released += releaseObject(app, o.kind, o.ref_id, "deleted");
  }
  for (const m of app.db.all<{ basket_id: string }>("SELECT basket_id FROM basket_items WHERE item_id = ?", id)) {
    released += releaseObject(app, "record", `basket:${m.basket_id}:${id}`, "deleted");
  }
  released += releaseObject(app, "record", `state:${id}`, "deleted");
  for (const e of app.db.all<{ engine_user_id: string; external_id: string }>("SELECT engine_user_id, external_id FROM external_ids WHERE item_id = ?", id)) {
    app.db.run("INSERT OR IGNORE INTO item_tombstones (engine_user_id, external_id, deleted_at) VALUES (?, ?, ?)", e.engine_user_id, e.external_id, nowIso());
  }
  for (const c of app.db.all<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", id)) {
    const r = app.db.get<{ id: string }>("SELECT id FROM reservations WHERE idempotency_key = ?", `capture:${c.id}`);
    if (r) releaseReservation(app, r.id);
  }
  forgetPlayback(app, id);
  app.db.run("DELETE FROM items_fts WHERE rowid = ?", item.seq);
  deleteItemAnnotations(app, id);
  forgetItemVerdicts(app, id);
  for (const table of ["basket_items", "captures", "item_images", "external_ids", "item_state", "state_log", "reminders"]) {
    app.db.run(`DELETE FROM ${table} WHERE item_id = ?`, id);
  }
  app.db.run("DELETE FROM share_notes WHERE item_id = ?", id);
  app.db.run("UPDATE items SET current_version_id = NULL WHERE id = ?", id);
  app.db.run("DELETE FROM item_versions WHERE item_id = ?", id);
  app.db.run("DELETE FROM notifications WHERE item_id = ?", id);
  app.db.run("DELETE FROM items WHERE id = ?", id);
  return released;
}
