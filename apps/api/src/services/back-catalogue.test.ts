import test from "node:test";
import assert from "node:assert/strict";
import { server } from "@purss/translations/server";
import type { ItemListQuery, SyncEntry } from "@purss/domain";
import { newId } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { applySyncBatch, arrivalOf } from "./sync.ts";
import { listItems, listTuning } from "./items.ts";
import { changeState, keepItem } from "./state.ts";
import { createBasket, createCollection, listCollections } from "./collections.ts";
import { followSource, listSources, onSubscribed, patchSource, unfollowSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { putAnnotation } from "./annotations.ts";
import { homeOverview } from "./home.ts";
import { activityFor } from "./activity.ts";
import { projection } from "./shares.ts";
import { itemCounts } from "./counts.ts";
import { setPreferences } from "./preferences.ts";
import { collectionStats, sourceStats } from "./statistics.ts";
import { searchItems } from "./search.ts";

/*
 * Following a source from now (sources.start_from): what the feed already had is stored as Ignored, so it is hidden from lists, left
 * out of Home, "Only new", the digests and every count of items not looked at, and search finds it. Following with the last week also
 * marks the posts of the 7 days before as New. Ignored is the person's to change like any state: nothing else marks these posts.
 */

const { notifications } = server.api;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
type Owner = Principal & { engineUserId: string };

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  return { app, p, cleanup };
}

/** Follow a feed the way the app does (a held candidate, then the engine confirming it). */
function follow(app: App, p: Owner, title: string, stream: string, startFrom?: "now" | "week", collectionId: string | null = null): string {
  const token = newId("dsc");
  holdCandidate(token, p.accountId, { feedUrl: `https://example.org/${stream}.xml`, siteUrl: null, title, kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], route: "feed-address", entry: "paste", summariesOnly: false, privateWarning: null });
  const src = followSource(app, p, { token, collectionId, newCollectionName: null, markPrivate: false, fullText: false, ...(startFrom ? { startFrom } : {}) }).id;
  onSubscribed(app, src, stream);
  return src;
}

/** A sync walk, as the worker reports it. */
const walk = (app: App, p: Owner, entries: SyncEntry[] = []) => applySyncBatch(app, p.engineUserId, batch(entries));

const urlOf = (e: SyncEntry) => e.url!;
const idOf = (app: App, e: SyncEntry) => app.db.get<{ id: string }>("SELECT id FROM items WHERE url = ?", urlOf(e))!.id;
const flags = (app: App, e: SyncEntry) => {
  const r = app.db.get<{ workflow: string; fresh: number }>("SELECT st.workflow AS workflow, st.fresh AS fresh FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.url = ?", urlOf(e))!;
  return { ignored: r.workflow === "ignored", fresh: r.fresh === 1 };
};
const revision = (app: App, id: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", id)!.revision;
const workflowOf = (app: App, id: string) => app.db.get<{ w: string }>("SELECT workflow AS w FROM item_state WHERE item_id = ?", id)!.w;
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const pageAll = (app: App, p: Owner, q: ItemListQuery): string[] => {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 200; n++) {
    const page = listItems(app, p, { ...q, cursor });
    out.push(...ids(page.items));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
};
/** Home's one feed, with Only new off: New items first, then what is left undecided or put aside. */
const homeFeed = (app: App, p: Owner) => new Set(pageAll(app, p, { scope: "home", limit: 10, mix: "home", filter: "new" }));

/** A source followed from now, its back catalogue stored (`size` posts) and the source settled, then one post that really is new. */
function followedFromNow(app: App, p: Owner, collectionId: string | null = null, size = 7) {
  const src = follow(app, p, "Old podcast", "feed/1", "now", collectionId);
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", src);
  // The engine collected all of it just now, whatever the posts' own dates.
  const old = Array.from({ length: size }, (_, i) => entry("feed/1", { title: `Back catalogue ${i}`, publishedAt: ago((i + 1) * 30 * DAY), crawledAt: nowIso() }));
  const undated = entry("feed/1", { title: "Back catalogue undated", publishedAt: null, crawledAt: nowIso() });
  walk(app, p, [...old, undated]);
  walk(app, p); // a walk that began after the engine confirmed the subscription: from here on a post is New
  const brandNew = entry("feed/1", { title: "Brand new post", publishedAt: ahead(60_000), crawledAt: nowIso() });
  walk(app, p, [brandNew]);
  return { src, back: [...old, undated], brandNew };
}
const notes = (app: App) => app.db.all<{ title: string }>("SELECT title FROM notifications ORDER BY created_at, id").map((n) => n.title);

test("followed from now, the back catalogue arrives Ignored: hidden from lists, left out of Home and every count, and search finds it", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const box = createCollection(app, p, { name: "Shows", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const filter = createCollection(app, p, { name: "Every article", emoji: null, mode: "query", sourceIds: [], query: { field: "kind", value: ["article"] }, view: "list" });
  const { src, back, brandNew } = followedFromNow(app, p, box.id);
  const newId_ = idOf(app, brandNew);
  assert.equal(app.db.get<{ start_from: string }>("SELECT start_from FROM sources WHERE id = ?", src)!.start_from, "now");

  // Stored, as ever: nothing is dropped, only Ignored.
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_id = ?", src)!.n, back.length + 1);
  for (const e of back) assert.deepEqual(flags(app, e), { ignored: true, fresh: false });
  assert.deepEqual(flags(app, brandNew), { ignored: false, fresh: true });
  // Nothing the person did: no entry in their workflow log, nothing told to the engine as read, the state as new as any.
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_log")!.n, 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.mark_read'")!.n, 0);
  assert.deepEqual(app.db.all<{ r: number; v: number }>("SELECT DISTINCT revision AS r, state_version AS v FROM item_state").map((r) => ({ ...r })), [{ r: 0, v: 0 }]);

  // Home's one feed, its New list, the collection's own list, the filter collection and the plain lists all hide it.
  assert.deepEqual([...homeFeed(app, p)], [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "home", limit: 10, mix: "home", filter: "fresh" }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: `collection:${box.id}`, limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: `collection:${filter.id}`, limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "all", limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "fresh", limit: 10 }), [newId_]);
  // So does the source's own page, like any list of it: "Show ignored" has all of it.
  assert.deepEqual(pageAll(app, p, { scope: `source:${src}`, limit: 5 }), [newId_]);
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 5, filter: "all" }).length, back.length + 1);
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 5, filter: "ignored" }).length, back.length);
  assert.equal(pageAll(app, p, { scope: `collection:${box.id}`, limit: 5, filter: "all", sort: "oldest" }).length, back.length + 1);

  // Search finds the whole of it, from anywhere (every sample post says 'tidal').
  assert.equal(searchItems(app, p, "tidal", 50).length, back.length + 1);
  assert.equal(pageAll(app, p, { scope: "all", filter: "all", q: "tidal", limit: 5 }).length, back.length + 1);

  // Counts: the source says how much it holds; everything that adds up what is waiting leaves the Ignored posts out.
  const source = listSources(app, p).find((s) => s.id === src)!;
  assert.deepEqual([source.itemCount, source.freshCount], [back.length + 1, 1]);
  const collections = listCollections(app, p);
  assert.deepEqual(collections.filter((c) => c.id === box.id || c.id === filter.id).map((c) => [c.name, c.itemCount, c.freshCount]), [["Shows", 1, 1], ["Every article", 1, 1]]);
  assert.equal(listItems(app, p, { scope: `collection:${box.id}`, limit: 5 }).total, 1);
  assert.equal(listItems(app, p, { scope: "all", limit: 5 }).total, 1);
  assert.equal(listItems(app, p, { scope: "all", limit: 5, filter: "ignored" }).total, back.length);
  const was = listTuning.countFromRowsBelowShare;
  try {
    listTuning.countFromRowsBelowShare = 5; // the collection counted from its rows instead of from the counts: the same answer
    assert.equal(listItems(app, p, { scope: `collection:${box.id}`, limit: 5 }).total, 1);
  } finally { listTuning.countFromRowsBelowShare = was; }

  // Statistics count what the PURSS holds, by state: the Ignored posts are there as Ignored, and nothing the person did is claimed.
  const stats = collectionStats(app, p, box.id).totals;
  assert.deepEqual([stats.totalItems, stats.workflow.new, stats.workflow.ignored, stats.ignoredLast30Days], [back.length + 1, 1, back.length, 0]);
  assert.equal(sourceStats(app, p, src).stats.totalItems, back.length + 1);
  const home = homeOverview(app, p);
  assert.equal(home.unread, 0, "nothing older is waiting: 'up to date', not 'N older items not looked at'");
  assert.equal(home.fresh, 1);
  assert.equal(itemCounts(app, p.accountId).items(src), back.length + 1, "the counts keep the whole of it for the source's page");
  assert.equal(itemCounts(app, p.accountId).sum([src], (w) => w === "ignored"), back.length);
  assert.deepEqual(notes(app), [notifications.newFrom("Old podcast")], "and it tells no one: only the post that is new does");
  const activity = activityFor(app, p);
  assert.equal(activity.sources.find((s) => s.id === src)!.arrived, 1, "the activity panel does not report it as arrived today");
  assert.deepEqual(activity.events.filter((e) => e.kind === "arrived").map((e) => e.text), [server.api.activity.arrived(1, "Old podcast")]);
});

test("with the last week, the posts of the 7 days before the follow are New and the older ones are left out", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = follow(app, p, "Weekly", "feed/1", "week");
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", src);
  const posts = {
    yesterday: entry("feed/1", { publishedAt: ago(DAY) }),
    sixDays: entry("feed/1", { publishedAt: ago(6 * DAY + 23 * HOUR) }),
    eightDays: entry("feed/1", { publishedAt: ago(8 * DAY) }),
    old: entry("feed/1", { publishedAt: ago(200 * DAY) }),
    undated: entry("feed/1", { publishedAt: null }),
  };
  walk(app, p, Object.values(posts));
  assert.deepEqual(flags(app, posts.yesterday), { ignored: false, fresh: true });
  assert.deepEqual(flags(app, posts.sixDays), { ignored: false, fresh: true });
  assert.deepEqual(flags(app, posts.eightDays), { ignored: true, fresh: false });
  assert.deepEqual(flags(app, posts.old), { ignored: true, fresh: false });
  assert.deepEqual(flags(app, posts.undated), { ignored: true, fresh: false }, "an undated post was there the first time anyone looked");

  // The two New ones are shown like any New post; the other three are Ignored, hidden and found by search.
  assert.deepEqual(new Set(pageAll(app, p, { scope: "home", mix: "home", filter: "fresh", limit: 10 })), new Set([idOf(app, posts.yesterday), idOf(app, posts.sixDays)]));
  assert.deepEqual(homeFeed(app, p), new Set([idOf(app, posts.yesterday), idOf(app, posts.sixDays)]));
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 10 }).length, 2);
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 10, filter: "ignored" }).length, 3);
  assert.equal(searchItems(app, p, "tidal", 50).length, 5);
  const source = listSources(app, p).find((s) => s.id === src)!;
  assert.deepEqual([source.itemCount, source.freshCount], [5, 2]);
  const home = homeOverview(app, p);
  assert.deepEqual([home.fresh, home.unread], [2, 0]);
  // New like the rest: they are told once, with the others, and later posts are New as ever.
  assert.deepEqual(notes(app), [notifications.newCountFrom(2, "Weekly")]);
  walk(app, p);
  const later = entry("feed/1", { publishedAt: ago(40 * DAY) });
  walk(app, p, [later]);
  assert.deepEqual(flags(app, later), { ignored: false, fresh: true }, "once the source is settled, whatever it brings is New");
});

test("the rule per start choice, and what the source just followed has no say in", () => {
  const source = (start_from: "all" | "now" | "week", settled = false) => ({ created_at: "2026-11-10T12:00:00.000Z", backlog_settled_at: settled ? "2026-11-11T00:00:00.000Z" : null, start_from });
  const at = (publishedAt: string | null) => ({ publishedAt });
  const monday = "2026-11-10T12:00:00.000Z";
  const dayBefore = (d: number) => new Date(Date.parse(monday) - d * DAY).toISOString();
  // A post after the follow, and anything once the source is settled, is New whatever was chosen.
  for (const start of ["all", "now", "week"] as const) {
    assert.deepEqual(arrivalOf(source(start), at("2026-11-10T12:00:01.000Z")), { fresh: true, ignored: false }, start);
    assert.deepEqual(arrivalOf(source(start, true), at(dayBefore(400))), { fresh: true, ignored: false }, start);
  }
  // Before the follow: "all" is how sources followed before the choice behave.
  assert.deepEqual(arrivalOf(source("all"), at(dayBefore(2))), { fresh: false, ignored: false });
  assert.deepEqual(arrivalOf(source("now"), at(dayBefore(2))), { fresh: false, ignored: true });
  assert.deepEqual(arrivalOf(source("now"), at(null)), { fresh: false, ignored: true });
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(2))), { fresh: true, ignored: false });
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(7))), { fresh: true, ignored: false }, "exactly 7 days before is the last week");
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(7.01))), { fresh: false, ignored: true });
  assert.deepEqual(arrivalOf(source("week"), at(null)), { fresh: false, ignored: true });
});

test("a source followed before the choice existed keeps today's behaviour: its back catalogue is shown and counted, not Ignored", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Established", "feed/1", { settled: false }); // start_from is the column's default
  assert.equal(app.db.get<{ s: string }>("SELECT start_from AS s FROM sources WHERE id = ?", src)!.s, "all");
  const old = Array.from({ length: 4 }, (_, i) => entry("feed/1", { publishedAt: ago((i + 2) * 30 * DAY) }));
  walk(app, p, old);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE workflow = 'ignored'")!.n, 0);
  assert.equal(homeFeed(app, p).size, 4, "shown on Home as older items");
  assert.equal(homeOverview(app, p).unread, 4, "and counted as not looked at");
  assert.equal(listItems(app, p, { scope: "all", limit: 10 }).total, 4);
});

test("an Ignored back-catalogue post is the person's to change: To read or Undecided puts it back; opening, keeping, highlighting and noting leave it Ignored", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { src, back } = followedFromNow(app, p, null, 8);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const [toread, undecided, opened, partway, kept, highlighted, noted, untouched] = back.map((e) => idOf(app, e)) as [string, string, string, string, string, string, string, string, string];
  for (const id of [toread, undecided, opened, partway, kept, highlighted, noted, untouched]) assert.equal(workflowOf(app, id), "ignored");

  changeState(app, p, toread, { workflow: "toread", expectedRevision: revision(app, toread) });
  changeState(app, p, undecided, { workflow: "new", expectedRevision: revision(app, undecided) });
  changeState(app, p, opened, { opened: true, expectedRevision: revision(app, opened) });
  changeState(app, p, partway, { progress: 0.4, expectedRevision: revision(app, partway) });
  keepItem(app, p, kept, basket.id);
  putAnnotation(app, p, highlighted, newId("ann"), { kind: "highlight", quote: { exact: "tidal flats", prefix: "", suffix: "" }, position: { start: 0, end: 11 }, target: null, body: null, updatedAt: nowIso() });
  putAnnotation(app, p, noted, newId("ann"), { kind: "note", body: "Compare with the delta paper.", updatedAt: nowIso() });
  assert.deepEqual([toread, undecided].map((id) => workflowOf(app, id)), ["toread", "new"]);
  for (const id of [opened, partway, kept, highlighted, noted, untouched]) assert.equal(workflowOf(app, id), "ignored", "what the person does with the post does not change its state; they do");
  assert.deepEqual(app.db.all<{ t: string }>("SELECT to_state AS t FROM state_log ORDER BY seq").map((r) => r.t), ["toread", "new"], "and the log has what they did");

  // Where they show: Home's To read row for the one put aside and Home's feed for the Undecided one; every list but a basket and search hides the rest.
  assert.deepEqual(ids(homeOverview(app, p).toRead.items), [toread]);
  const feed = homeFeed(app, p);
  assert.ok(!feed.has(toread) && feed.has(undecided));
  for (const id of [opened, partway, kept, highlighted, noted, untouched]) assert.ok(!feed.has(id));
  assert.equal(listItems(app, p, { scope: "all", limit: 10 }).total, 3, "the two it was moved to and the brand new post");
  assert.equal(listItems(app, p, { scope: "all", limit: 10, filter: "all" }).total, 10, "all nine of the back catalogue and the brand new post");
  assert.deepEqual(pageAll(app, p, { scope: `basket:${basket.id}`, limit: 10, filter: "all" }), [kept], "a basket shows what is kept in it, Ignored or not");
  assert.equal(homeOverview(app, p).unread, 1, "Undecided and no longer New, like any older post; the Ignored ones are not counted");
  assert.equal(itemCounts(app, p.accountId).sum([src], (w) => w === "ignored"), 7);
  // Search finds the posts that were highlighted or noted, and the one that is kept.
  const found = new Set(searchItems(app, p, "tidal", 50).map((i) => i.id));
  for (const id of [kept, highlighted, noted, untouched]) assert.ok(found.has(id));
});

test("following the same feed again starts a new follow: its own choice applies from then on", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = follow(app, p, "Back again", "feed/1", "week");
  assert.equal(app.db.get<{ s: string }>("SELECT start_from AS s FROM sources WHERE id = ?", src)!.s, "week");
  unfollowSource(app, p, src);
  const again = follow(app, p, "Back again", "feed/1", "now");
  assert.equal(again, src, "the same source is taken up again");
  assert.equal(app.db.get<{ s: string }>("SELECT start_from AS s FROM sources WHERE id = ?", src)!.s, "now");
  const unspecified = follow(app, p, "Other", "feed/2");
  assert.equal(app.db.get<{ s: string }>("SELECT start_from AS s FROM sources WHERE id = ?", unspecified)!.s, "now", "from now is the default");
});

test("a shared collection shows what its owner's list of it shows: the Ignored back catalogue is not published until the owner moves a post; a basket shows what is kept", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const box = createCollection(app, p, { name: "Shows", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const filter = createCollection(app, p, { name: "Every article", emoji: null, mode: "query", sourceIds: [], query: { field: "kind", value: ["article"] }, view: "list" });
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const { back, brandNew } = followedFromNow(app, p, box.id);
  const published = (kind: "collection" | "basket", target: string) => projection(app, { id: "shr_test", target_kind: kind, target_id: target, account_id: p.accountId })!.map((i) => i.url);
  for (const c of [box.id, filter.id]) assert.deepEqual(published("collection", c), [urlOf(brandNew)]);
  changeState(app, p, idOf(app, back[0]!), { workflow: "toread", expectedRevision: revision(app, idOf(app, back[0]!)) });
  for (const c of [box.id, filter.id]) assert.deepEqual(new Set(published("collection", c)), new Set([urlOf(brandNew), urlOf(back[0]!)]), "a post the owner put aside is theirs to publish");
  keepItem(app, p, idOf(app, back[1]!), basket.id);
  assert.deepEqual(published("basket", basket.id), [urlOf(back[1]!)], "a basket publishes what is kept in it, as its owner sees it");
  assert.ok(!published("collection", box.id).includes(urlOf(back[1]!)), "the kept post is still Ignored, so the collection does not publish it");
});

test("one PURSS's back catalogue never reaches another's counts or lists", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app);
  const mine = followedFromNow(app, p);
  const theirs = follow(app, other, "Theirs", "feed/9", "now");
  walk(app, other, [entry("feed/9", { publishedAt: ago(40 * DAY) }), entry("feed/9", { publishedAt: ago(41 * DAY) })]);
  const ignored = (o: Owner, source: string) => itemCounts(app, o.accountId).sum([source], (w) => w === "ignored");
  assert.deepEqual([ignored(p, mine.src), ignored(p, theirs), ignored(other, theirs), ignored(other, mine.src)], [mine.back.length, 0, 2, 0]);
  assert.equal(homeOverview(app, other).unread, 0);
  assert.deepEqual(pageAll(app, other, { scope: "all", limit: 10 }), []);
  assert.equal(pageAll(app, other, { scope: `source:${theirs}`, limit: 10, filter: "all" }).length, 2);
});

test("the queries that hide the Ignored posts and count what is left read their indexes in order, and nothing is written to keep anything up to date", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  followedFromNow(app, p);
  setPreferences(app, p.accountId, { mutedWords: [{ text: "football", until: null }] });
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = app.db as unknown as Record<"all" | "get" | "run", (sql: string, ...params: unknown[]) => unknown>;
  const original = { all: db.all, get: db.get, run: db.run };
  for (const k of ["all", "get", "run"] as const) db[k] = (sql, ...params) => { seen.push({ sql, params }); return original[k].call(app.db, sql, ...params); };
  try {
    listItems(app, p, { scope: "home", mix: "home", filter: "new", limit: 50 });
    listItems(app, p, { scope: "all", limit: 50 });
    homeOverview(app, p);
    listSources(app, p);
  } finally { Object.assign(db, original); }
  const plan = (q: { sql: string; params: unknown[] }) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
  assert.ok(!seen.some((q) => /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(q.sql)), "reading writes nothing");

  const pages = seen.filter((q) => /ORDER BY sort_key/.test(q.sql));
  assert.ok(pages.length >= 3, "Home's two runs and the plain list hide them");
  for (const q of pages) {
    const lines = plan(q);
    assert.ok(lines.some((l) => /^SEARCH i USING (COVERING )?INDEX items_account_sortkey/.test(l)), `read in date order from the date index:\n${lines.join("\n")}`);
    assert.ok(!lines.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /^SCAN (i|items)\b/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /^SEARCH st USING INDEX/.test(l)), `a row's state is one probe, as for any other state:\n${lines.join("\n")}`);
  }
  const counting = seen.find((q) => /FROM item_state\s+WHERE account_id = \?/.test(q.sql) && /GROUP BY source_id, workflow, fresh/.test(q.sql));
  assert.ok(counting, "the counts ask for the Ignored items like any other state that is not the default");
  const counted = plan(counting);
  assert.ok(counted.some((l) => /COVERING INDEX item_state_rare/.test(l)) && !counted.some((l) => /^SCAN/.test(l) && !/INDEX/.test(l)) && !counted.some((l) => /items/.test(l)), `counted from the partial index alone, with no visit to the items however many are Ignored:\n${counted.join("\n")}`);
  const muted = seen.find((q) => /purss_muted/.test(q.sql) && /st\.workflow IN \('new', 'toread'\)/.test(q.sql));
  assert.ok(muted, "what the muted words left out of Home is counted among the items that show");
});

const pendingCaptures = (app: App, src: string) => app.db.all<{ title: string }>(
  "SELECT i.title FROM captures c JOIN items i ON i.id = c.item_id WHERE i.source_id = ? AND c.status = 'pending' ORDER BY i.title", src).map((r) => r.title);

test("full articles are fetched by themselves only for posts the person will see: the Ignored back catalogue of a source followed from now stays as it came", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = follow(app, p, "Journal of Tides", "feed/1", "now");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", src);
  const old = Array.from({ length: 4 }, (_, i) => entry("feed/1", { title: `Old paper ${i}`, publishedAt: ago((i + 1) * 30 * DAY), crawledAt: nowIso() }));
  const undated = entry("feed/1", { title: "Old undated paper", publishedAt: null, crawledAt: nowIso() });
  walk(app, p, [...old, undated]);
  assert.deepEqual(pendingCaptures(app, src), [], "the back catalogue gets no automatic copies");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'capture.fulltext'")!.n, 0, "and no jobs that would fail one by one");
  walk(app, p); // a walk that began after the engine confirmed the subscription: from here on a post is New
  const brandNew = entry("feed/1", { title: "Brand new paper", publishedAt: ahead(60_000), crawledAt: nowIso() });
  walk(app, p, [brandNew]);
  assert.deepEqual(pendingCaptures(app, src), ["Brand new paper"], "a post that comes after the follow gets its copy");
  for (const e of old) assert.equal(flags(app, e).ignored, true);

  // Turning the setting off and on again fetches the newest unfinished items, still not the back catalogue.
  patchSource(app, p, src, { fullText: false });
  app.db.run("DELETE FROM captures WHERE item_id IN (SELECT id FROM items WHERE source_id = ?)", src);
  patchSource(app, p, src, { fullText: true });
  assert.deepEqual(pendingCaptures(app, src), ["Brand new paper"]);

  // A person's own keep of a back-catalogue item still asks for its copy, and so does Try again.
  const basket = createBasket(app, p, { name: "Papers", captureMode: "text" });
  const target = idOf(app, old[0]!);
  assert.equal(keepItem(app, p, target, basket.id).captureQueued, true, "an explicit keep with a readable copy is eligible");
  assert.deepEqual(pendingCaptures(app, src), ["Brand new paper", "Old paper 0"]);
  assert.equal(workflowOf(app, target), "ignored", "keeping it does not change its state");
});

test("a source followed with its last week, or before the choice existed, gets copies of what it brings as New or as ordinary older items", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const week = follow(app, p, "Weekly", "feed/1", "week");
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", week);
  walk(app, p, [entry("feed/1", { title: "Three days ago", publishedAt: ago(3 * DAY), crawledAt: nowIso() }), entry("feed/1", { title: "A month ago", publishedAt: ago(30 * DAY), crawledAt: nowIso() })]);
  assert.deepEqual(pendingCaptures(app, week), ["Three days ago"], "the last week is New and gets a copy; the older post is back catalogue and gets none");
  const all = follow(app, p, "Everything", "feed/2");
  app.db.run("UPDATE sources SET full_text = 1, start_from = 'all' WHERE id = ?", all);
  walk(app, p, [entry("feed/2", { title: "Old but shown", publishedAt: ago(30 * DAY), crawledAt: nowIso() })]);
  assert.deepEqual(pendingCaptures(app, all), ["Old but shown"], "a source whose older posts are ordinary items still gets a copy of each");
});
