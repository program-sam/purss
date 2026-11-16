import test from "node:test";
import assert from "node:assert/strict";
import type { ItemListQuery, SyncEntry } from "@purss/domain";
import { newId } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { applySyncBatch, arrivalOf } from "./sync.ts";
import { listItems, listTuning } from "./items.ts";
import { changeState, keepItem } from "./state.ts";
import { createBasket, createCollection, listCollections } from "./collections.ts";
import { followSource, listSources, onSubscribed, unfollowSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { putAnnotation } from "./annotations.ts";
import { homeOverview } from "./home.ts";
import { activityFor } from "./activity.ts";
import { projection } from "./shares.ts";
import { itemCounts } from "./counts.ts";
import { setPreferences } from "./preferences.ts";
import { collectionStats, sourceStats } from "./statistics.ts";

/*
 * Following a source from now (migration 065): what the feed already had stays stored, on the source's own page and in search,
 * and is left out of Home, collection lists, "Only new" and every count of items not looked at. Following with the last week also
 * marks the posts of the 7 days before as New. Whatever the person has done with a post is never left out.
 */

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
  holdCandidate(token, p.workspaceId, { feedUrl: `https://example.org/${stream}.xml`, siteUrl: null, title, kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null });
  const src = followSource(app, p, { token, collectionId, newCollectionName: null, markPrivate: false, fullText: false, ...(startFrom ? { startFrom } : {}) }).id;
  onSubscribed(app, src, stream);
  return src;
}

/** A sync walk, as the worker reports it. */
const walk = (app: App, p: Owner, entries: SyncEntry[] = []) => applySyncBatch(app, p.engineUserId, batch(entries));

const urlOf = (e: SyncEntry) => e.url!;
const idOf = (app: App, e: SyncEntry) => app.db.get<{ id: string }>("SELECT id FROM items WHERE url = ?", urlOf(e))!.id;
const flags = (app: App, e: SyncEntry) => {
  const r = app.db.get<{ backlog: number; fresh: number }>("SELECT i.backlog AS backlog, st.fresh AS fresh FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.url = ?", urlOf(e))!;
  return { backlog: r.backlog === 1, fresh: r.fresh === 1 };
};
const revision = (app: App, id: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", id)!.revision;
const backlog = (app: App, id: string) => app.db.get<{ b: number }>("SELECT backlog AS b FROM items WHERE id = ?", id)!.b === 1;
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
const homeFeed = (app: App, p: Owner) => new Set(pageAll(app, p, { scope: "home", limit: 10, mix: "home", filter: "open" }));

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

test("followed from now, the back catalogue is stored but left out of Home, every list but the source's own, and every count", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const box = createCollection(app, p, { name: "Shows", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const filter = createCollection(app, p, { name: "Every article", emoji: null, mode: "query", sourceIds: [], query: { field: "kind", value: ["article"] }, view: "list" });
  const { src, back, brandNew } = followedFromNow(app, p, box.id);
  const newId_ = idOf(app, brandNew);
  assert.equal(app.db.get<{ start_from: string }>("SELECT start_from FROM sources WHERE id = ?", src)!.start_from, "now");

  // Stored, as ever: nothing is dropped, only left out.
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_id = ?", src)!.n, back.length + 1);
  for (const e of back) assert.deepEqual(flags(app, e), { backlog: true, fresh: false });
  assert.deepEqual(flags(app, brandNew), { backlog: false, fresh: true });

  // Home's one feed, its New list, the collection's own list, the filter collection and the plain lists all leave the back catalogue out.
  assert.deepEqual([...homeFeed(app, p)], [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "home", limit: 10, mix: "home", filter: "fresh" }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: `collection:${box.id}`, limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: `collection:${filter.id}`, limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "all", limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "fresh", limit: 10 }), [newId_]);
  assert.deepEqual(pageAll(app, p, { scope: "collection:" + box.id, limit: 10, filter: "all", sort: "oldest" }), [newId_]);

  // The source's own page and a search show all of it.
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 5 }).length, back.length + 1);
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 5, filter: "open" }).length, back.length + 1);
  const found = pageAll(app, p, { scope: "all", q: "tidal", limit: 5 });
  assert.equal(found.length, back.length + 1, "search finds the whole back catalogue (every sample post says 'tidal')");
  assert.deepEqual(pageAll(app, p, { scope: "home", mix: "home", q: "tidal", limit: 5 }).length, back.length + 1);

  // Counts: the source says how much it holds; everything that adds up what is waiting leaves the back catalogue out.
  const source = listSources(app, p).find((s) => s.id === src)!;
  assert.deepEqual([source.itemCount, source.freshCount], [back.length + 1, 1]);
  const collections = listCollections(app, p);
  assert.deepEqual(collections.filter((c) => c.id === box.id || c.id === filter.id).map((c) => [c.name, c.itemCount, c.freshCount]), [["Shows", 1, 1], ["Every article", 1, 1]]);
  assert.equal(listItems(app, p, { scope: `collection:${box.id}`, limit: 5 }).total, 1);
  assert.equal(listItems(app, p, { scope: "all", limit: 5 }).total, 1);
  const was = listTuning.countFromRowsBelowShare;
  try {
    listTuning.countFromRowsBelowShare = 5; // the collection counted from its rows instead of from the counts: the same answer
    assert.equal(listItems(app, p, { scope: `collection:${box.id}`, limit: 5 }).total, 1);
  } finally { listTuning.countFromRowsBelowShare = was; }

  // Statistics follow the lists: the collection's leave the back catalogue out, the source's own count all of it.
  assert.equal(collectionStats(app, p, box.id).totals.totalItems, 1);
  assert.equal(collectionStats(app, p, box.id).totals.workflow.new, 1);
  assert.equal(sourceStats(app, p, src).stats.totalItems, back.length + 1);
  const home = homeOverview(app, p);
  assert.equal(home.unread, 0, "nothing older is waiting: 'up to date', not 'N older items not looked at'");
  assert.equal(home.fresh, 1);
  assert.equal(itemCounts(app, p.workspaceId).items(src), back.length + 1, "the counts keep the whole of it for the source's page");
  assert.deepEqual(notes(app), ["New from Old podcast"], "and it tells no one: only the post that is new does");
  const activity = activityFor(app, p);
  assert.equal(activity.sources.find((s) => s.id === src)!.arrived, 1, "the activity panel does not report it as arrived today");
  assert.deepEqual(activity.events.filter((e) => e.kind === "arrived").map((e) => e.text), ["1 new item from Old podcast"]);
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
  assert.deepEqual(flags(app, posts.yesterday), { backlog: false, fresh: true });
  assert.deepEqual(flags(app, posts.sixDays), { backlog: false, fresh: true });
  assert.deepEqual(flags(app, posts.eightDays), { backlog: true, fresh: false });
  assert.deepEqual(flags(app, posts.old), { backlog: true, fresh: false });
  assert.deepEqual(flags(app, posts.undated), { backlog: true, fresh: false }, "an undated post was there the first time anyone looked");

  // The two New ones are shown like any New post; the other three are only on the source's page.
  assert.deepEqual(new Set(pageAll(app, p, { scope: "home", mix: "home", filter: "fresh", limit: 10 })), new Set([idOf(app, posts.yesterday), idOf(app, posts.sixDays)]));
  assert.deepEqual(homeFeed(app, p), new Set([idOf(app, posts.yesterday), idOf(app, posts.sixDays)]));
  assert.equal(pageAll(app, p, { scope: `source:${src}`, limit: 10 }).length, 5);
  const source = listSources(app, p).find((s) => s.id === src)!;
  assert.deepEqual([source.itemCount, source.freshCount], [5, 2]);
  const home = homeOverview(app, p);
  assert.deepEqual([home.fresh, home.unread], [2, 0]);
  // New like the rest: they are told once, with the others, and later posts are New as ever.
  assert.deepEqual(notes(app), ["2 new from Weekly"]);
  walk(app, p);
  const later = entry("feed/1", { publishedAt: ago(40 * DAY) });
  walk(app, p, [later]);
  assert.deepEqual(flags(app, later), { backlog: false, fresh: true }, "once the source is settled, whatever it brings is New");
});

test("the rule per start choice, and what the source just followed has no say in", () => {
  const source = (start_from: "all" | "now" | "week", settled = false) => ({ created_at: "2026-11-10T12:00:00.000Z", backlog_settled_at: settled ? "2026-11-11T00:00:00.000Z" : null, start_from });
  const at = (publishedAt: string | null) => ({ publishedAt });
  const monday = "2026-11-10T12:00:00.000Z";
  const dayBefore = (d: number) => new Date(Date.parse(monday) - d * DAY).toISOString();
  // A post after the follow, and anything once the source is settled, is New whatever was chosen.
  for (const start of ["all", "now", "week"] as const) {
    assert.deepEqual(arrivalOf(source(start), at("2026-11-10T12:00:01.000Z")), { fresh: true, backlog: false }, start);
    assert.deepEqual(arrivalOf(source(start, true), at(dayBefore(400))), { fresh: true, backlog: false }, start);
  }
  // Before the follow: "all" is how sources followed before the choice behave.
  assert.deepEqual(arrivalOf(source("all"), at(dayBefore(2))), { fresh: false, backlog: false });
  assert.deepEqual(arrivalOf(source("now"), at(dayBefore(2))), { fresh: false, backlog: true });
  assert.deepEqual(arrivalOf(source("now"), at(null)), { fresh: false, backlog: true });
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(2))), { fresh: true, backlog: false });
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(7))), { fresh: true, backlog: false }, "exactly 7 days before is the last week");
  assert.deepEqual(arrivalOf(source("week"), at(dayBefore(7.01))), { fresh: false, backlog: true });
  assert.deepEqual(arrivalOf(source("week"), at(null)), { fresh: false, backlog: true });
});

test("a source followed before the choice existed keeps today's behaviour: its back catalogue is shown, counted, and not marked", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, p, "Established", "feed/1", { settled: false }); // start_from is the column's default
  assert.equal(app.db.get<{ s: string }>("SELECT start_from AS s FROM sources WHERE id = ?", src)!.s, "all");
  const old = Array.from({ length: 4 }, (_, i) => entry("feed/1", { publishedAt: ago((i + 2) * 30 * DAY) }));
  walk(app, p, old);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE backlog = 1")!.n, 0);
  assert.equal(homeFeed(app, p).size, 4, "shown on Home as older items");
  assert.equal(homeOverview(app, p).unread, 4, "and counted as not looked at");
  assert.equal(listItems(app, p, { scope: "all", limit: 10 }).total, 4);
});

test("a post the person has acted on is never left out: To read, any state, opened, read partway, kept, highlighted, noted, New again", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { src, back } = followedFromNow(app, p, null, 8);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const [toread, finished, opened, partway, kept, highlighted, noted, markedNew, untouched] = back.map((e) => idOf(app, e)) as [string, string, string, string, string, string, string, string, string];
  const todo = { toread, finished, opened, partway, kept, highlighted, noted, markedNew };
  for (const id of [...Object.values(todo), untouched]) assert.equal(backlog(app, id), true);
  assert.equal(itemCounts(app, p.workspaceId).backCatalogue.get(src), 9);

  changeState(app, p, toread, { workflow: "toread", expectedRevision: revision(app, toread) });
  changeState(app, p, finished, { workflow: "finished", expectedRevision: revision(app, finished) });
  changeState(app, p, opened, { opened: true, expectedRevision: revision(app, opened) });
  changeState(app, p, partway, { progress: 0.4, expectedRevision: revision(app, partway) });
  keepItem(app, p, kept, basket.id);
  putAnnotation(app, p, highlighted, newId("ann"), { kind: "highlight", quote: { exact: "tidal flats", prefix: "", suffix: "" }, position: { start: 0, end: 11 }, target: null, body: null, updatedAt: nowIso() });
  putAnnotation(app, p, noted, newId("ann"), { kind: "note", body: "Compare with the delta paper.", updatedAt: nowIso() });
  app.db.run("UPDATE item_state SET fresh = 1 WHERE item_id = ?", markedNew); // however the New marker came back
  for (const [what, id] of Object.entries(todo)) assert.equal(backlog(app, id), false, `${what}: no longer left out`);
  assert.equal(backlog(app, untouched), true, "the one nobody touched still is");

  // Where they show: Home's To read, Home's feed, every list, and the counts, all but the one nobody touched.
  assert.deepEqual(ids(homeOverview(app, p).toRead.items), [toread]);
  const feed = homeFeed(app, p);
  for (const id of [toread, opened, partway, kept, highlighted, noted, markedNew]) assert.ok(feed.has(id), `${id} is on Home`);
  assert.ok(!feed.has(finished), "Finished leaves the open lists, as it does for any post");
  assert.ok(!feed.has(untouched));
  assert.deepEqual(pageAll(app, p, { scope: "all", limit: 10, filter: "finished" }), [finished]);
  assert.equal(listItems(app, p, { scope: "all", limit: 10, filter: "all" }).total, 9, "eight touched and the brand new post; the ninth stays out");
  assert.equal(itemCounts(app, p.workspaceId).backCatalogue.get(src), 1);
  assert.equal(homeOverview(app, p).unread, 5, "opened, read partway, kept, highlighted and noted are Undecided and no longer New, like any older post; the one nobody touched is not counted");
  // Putting it back, or taking the basket away, does not hide it again: it was looked at.
  changeState(app, p, toread, { workflow: "new", expectedRevision: revision(app, toread) });
  assert.equal(backlog(app, toread), false);
});

test("an item with its source in the default state is the only kind that is left out; every other write keeps that true", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  followedFromNow(app, p);
  // Whatever path writes the state (the player's progress, an import, the engine's read state), the mark goes with it.
  const [a, b, c] = app.db.all<{ id: string }>("SELECT id FROM items WHERE backlog = 1 ORDER BY seq").map((r) => r.id) as [string, string, string];
  app.db.run("UPDATE item_state SET progress = 0.5 WHERE item_id = ?", a);
  app.db.run("UPDATE item_state SET opened_at = ? WHERE item_id = ?", nowIso(), b);
  app.db.run("UPDATE item_state SET workflow = 'inprogress' WHERE item_id = ?", c);
  for (const id of [a, b, c]) assert.equal(backlog(app, id), false);
  // An item stored with a state that is not the default (an import) is not left out.
  const stored = app.db.get<{ id: string }>("SELECT id FROM items WHERE backlog = 1 LIMIT 1")!.id;
  app.db.run("DELETE FROM item_state WHERE item_id = ?", stored);
  app.db.run("INSERT INTO item_state (item_id, workspace_id, workflow, fresh, updated_at) VALUES (?, ?, 'toread', 0, ?)", stored, p.workspaceId, nowIso());
  assert.equal(backlog(app, stored), false);
  // A change that leaves the item in the default state does not clear the mark: the bookkeeping columns move on their own.
  const rest = app.db.get<{ id: string }>("SELECT id FROM items WHERE backlog = 1 LIMIT 1")!.id;
  app.db.run("UPDATE item_state SET state_version = state_version + 1, updated_at = ? WHERE item_id = ?", nowIso(), rest);
  assert.equal(backlog(app, rest), true);
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

test("a shared collection shows what its owner's list of it shows: the back catalogue is not published until it has been acted on", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const box = createCollection(app, p, { name: "Shows", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const filter = createCollection(app, p, { name: "Every article", emoji: null, mode: "query", sourceIds: [], query: { field: "kind", value: ["article"] }, view: "list" });
  const { back, brandNew } = followedFromNow(app, p, box.id);
  const published = (collection: string) => projection(app, { id: "shr_test", target_kind: "collection", target_id: collection, workspace_id: p.workspaceId })!.map((i) => i.url);
  for (const c of [box.id, filter.id]) assert.deepEqual(published(c), [urlOf(brandNew)]);
  changeState(app, p, idOf(app, back[0]!), { workflow: "toread", expectedRevision: revision(app, idOf(app, back[0]!)) });
  for (const c of [box.id, filter.id]) assert.deepEqual(new Set(published(c)), new Set([urlOf(brandNew), urlOf(back[0]!)]), "a post the owner put aside is theirs to publish");
});

test("one PURSS's back catalogue never reaches another's counts or lists", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app);
  const mine = followedFromNow(app, p);
  const theirs = follow(app, other, "Theirs", "feed/9", "now");
  walk(app, other, [entry("feed/9", { publishedAt: ago(40 * DAY) }), entry("feed/9", { publishedAt: ago(41 * DAY) })]);
  const counts = (o: Owner) => itemCounts(app, o.workspaceId).backCatalogue;
  assert.deepEqual([...counts(p)], [[mine.src, mine.back.length]]);
  assert.deepEqual([...counts(other)], [[theirs, 2]]);
  assert.equal(homeOverview(app, other).unread, 0);
  assert.deepEqual(pageAll(app, other, { scope: "all", limit: 10 }), []);
  assert.equal(pageAll(app, other, { scope: `source:${theirs}`, limit: 10 }).length, 2);
});

test("the queries that leave the back catalogue out and count it read their indexes", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  followedFromNow(app, p);
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }] });
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = app.db as unknown as Record<"all" | "get" | "run", (sql: string, ...params: unknown[]) => unknown>;
  const original = { all: db.all, get: db.get, run: db.run };
  for (const k of ["all", "get", "run"] as const) db[k] = (sql, ...params) => { seen.push({ sql, params }); return original[k].call(app.db, sql, ...params); };
  try {
    listItems(app, p, { scope: "home", mix: "home", filter: "open", limit: 50 });
    listItems(app, p, { scope: "all", limit: 50 });
    homeOverview(app, p);
    listSources(app, p);
  } finally { Object.assign(db, original); }
  const plan = (q: { sql: string; params: unknown[] }) => app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));

  const counting = seen.find((q) => /backlog = 1/.test(q.sql) && /GROUP BY source_id/.test(q.sql))!;
  assert.ok(counting, "the counts ask for the left-out items");
  assert.ok(plan(counting).some((l) => /COVERING INDEX items_backlog/.test(l)) && !plan(counting).some((l) => /^SCAN/.test(l) && !/INDEX/.test(l)), `counted from the partial index alone:\n${plan(counting).join("\n")}`);

  const pages = seen.filter((q) => /ORDER BY sort_key/.test(q.sql) && /i\.backlog = 0/.test(q.sql));
  assert.ok(pages.length >= 3, "Home's two runs and the plain list leave them out");
  for (const q of pages) {
    const lines = plan(q);
    assert.ok(lines.some((l) => /^SEARCH i USING (COVERING )?INDEX items_ws_visible_sortkey/.test(l)), `read in date order from the index of the items that can show, so the left-out ones are not walked past:\n${lines.join("\n")}`);
    assert.ok(!lines.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /^SCAN (i|items)\b/.test(l)), lines.join("\n"));
  }
  const muted = seen.find((q) => /purss_muted/.test(q.sql) && /st\.workflow IN \('new', 'toread'\)/.test(q.sql) && /i\.backlog = 0/.test(q.sql));
  assert.ok(muted, "what the muted words left out of Home is counted without the back catalogue too");
});
