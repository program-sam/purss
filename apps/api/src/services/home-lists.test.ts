import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ItemListQuery } from "@purss/domain";
import { Database, migrate } from "../db/database.ts";
import type { App, Principal } from "../app.ts";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { insertItem, listItems } from "./items.ts";
import type { NewItem } from "./items.ts";
import { changeState, keepItem } from "./state.ts";
import { createBasket, createCollection } from "./collections.ts";
import { getPreferences, preferencesPatchSchema, setPreferences } from "./preferences.ts";
import { homeOverview } from "./home.ts";
import { activeMutedWords, mutedScan } from "./muted.ts";
import { matchesMuted, mutedPatterns } from "./muted-match.ts";

/*
 * What Home's sections and lists show (plan/34): items of collections hidden on Home stay out of Recently kept and
 * filter collections; an item is in one section only; the one feed is in strict date order;
 * muted words; type and length filters; hiding one source from a list.
 */

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Owner = Principal & { engineUserId: string };

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  return { app, p, cleanup };
}

let serial = 0;
function addItem(app: App, p: Owner, sourceId: string | null, over: Partial<NewItem> = {}): string {
  serial++;
  return app.db.tx(() => insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId, kind: "article", title: `Item ${serial}`, url: `https://example.org/h/${serial}`, author: null,
    summaryHtml: `<p>About ${serial}</p>`, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: null, discoveredAt: nowIso(), enclosures: [], fresh: false, reason: "test", ...over,
  })).id;
}
const at = (app: App, p: Owner, src: string, iso: string, over: Partial<NewItem> = {}) => addItem(app, p, src, { publishedAt: iso, discoveredAt: iso, ...over });
const revision = (app: App, id: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", id)!.revision;
const workflow = (app: App, p: Owner, id: string, w: "toread" | "inprogress" | "finished" | "ignored") => changeState(app, p, id, { workflow: w, expectedRevision: revision(app, id) });
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

// ---------- Home's sections ----------

function twoCollections(app: App, p: Owner) {
  const work = makeSource(app, p, "Work", "feed/work");
  const fun = makeSource(app, p, "Fun", "feed/fun");
  const workBox = createCollection(app, p, { name: "Work", emoji: null, mode: "sources", sourceIds: [work], query: null, view: "list" });
  const funBox = createCollection(app, p, { name: "Fun", emoji: null, mode: "sources", sourceIds: [fun], query: null, view: "list" });
  return { work, fun, workBox, funBox };
}

test("Recently kept leaves out items of collections hidden on Home, and brings them back when the collection is shown", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun, workBox } = twoCollections(app, p);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const wk = addItem(app, p, work), fk = addItem(app, p, fun);
  keepItem(app, p, wk, basket.id); keepItem(app, p, fk, basket.id);

  assert.deepEqual(new Set(ids(homeOverview(app, p).recentlyKept)), new Set([wk, fk]));

  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", workBox.id);
  assert.deepEqual(ids(homeOverview(app, p).recentlyKept), [fk], "the hidden collection's kept item is not on Home");

  app.db.run("UPDATE collections SET show_on_home = 1 WHERE id = ?", workBox.id);
  assert.equal(homeOverview(app, p).recentlyKept.length, 2);
});

test("an item of a source in no collection follows 'Other sources'; one kept by hand or from an unfollowed source is always on Home", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const loose = makeSource(app, p, "Loose", "feed/loose");
  const gone = makeSource(app, p, "Gone", "feed/gone");
  const manual = makeSource(app, p, "Saved links", "manual/1", { kind: "manual" });
  const a = addItem(app, p, loose), b = addItem(app, p, gone), c = addItem(app, p, manual);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  for (const id of [a, b, c]) keepItem(app, p, id, basket.id);
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", gone);

  assert.deepEqual(new Set(ids(homeOverview(app, p).recentlyKept)), new Set([a, b, c]));
  setPreferences(app, p.workspaceId, { homeOther: false });
  assert.deepEqual(new Set(ids(homeOverview(app, p).recentlyKept)), new Set([b, c]), "Other sources is hidden on Home");
});

test("a filter collection on Home leaves out items of collections hidden on Home; its own page lists them all", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun, workBox } = twoCollections(app, p);
  const w = addItem(app, p, work, { title: "road works" }), f = addItem(app, p, fun, { title: "road trip" });
  const filter = createCollection(app, p, { name: "Roads", emoji: null, mode: "query", sourceIds: [], query: { all: [{ field: "text", value: "road" }] }, view: "list" });
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", workBox.id);
  assert.deepEqual(ids(listItems(app, p, { scope: `collection:${filter.id}`, filter: "open", limit: 10, mix: "home" }).items), [f]);
  assert.deepEqual(new Set(ids(listItems(app, p, { scope: `collection:${filter.id}`, limit: 10 }).items)), new Set([w, f]));
});

test("a new filter collection starts off Home; a collection of sources starts on it", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const filter = createCollection(app, p, { name: "Roads", emoji: null, mode: "query", sourceIds: [], query: { all: [{ field: "text", value: "road" }] }, view: "list" });
  const sources = createCollection(app, p, { name: "News", emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  assert.equal(filter.showOnHome, false);
  assert.equal(sources.showOnHome, true);
});

test("To read lists what was put aside, from any collection", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, workBox } = twoCollections(app, p);
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", workBox.id);
  const a = addItem(app, p, work);
  workflow(app, p, a, "toread");
  const o = homeOverview(app, p);
  assert.deepEqual(ids(o.toRead.items), [a]);
  assert.equal(o.toRead.total, 1);
});

test("an item is in one of To read and Recently kept only: the first", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work } = twoCollections(app, p);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const a = addItem(app, p, work), b = addItem(app, p, work);
  workflow(app, p, a, "toread");
  for (const id of [a, b]) keepItem(app, p, id, basket.id);
  const o = homeOverview(app, p);
  assert.deepEqual(ids(o.toRead.items), [a]);
  assert.deepEqual(ids(o.recentlyKept), [b], "kept, but already shown above");
  assert.equal(o.toRead.total, 1);
});

// ---------- what Home can say about the pile ----------

test("Home counts the older unread items it holds, not the ones in hidden collections or already dealt with", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun, workBox } = twoCollections(app, p);
  addItem(app, p, work); addItem(app, p, work); addItem(app, p, fun);
  const read = addItem(app, p, fun);
  workflow(app, p, read, "finished");
  addItem(app, p, fun, { fresh: true });
  assert.equal(homeOverview(app, p).unread, 3, "undecided and no longer New, on Home");
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", workBox.id);
  assert.equal(homeOverview(app, p).unread, 1);
});

// ---------- Home's lists ----------

test("Home's one feed leaves out hidden collections and what was dealt with, and shows Other sources only while Home does", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun, workBox } = twoCollections(app, p);
  const loose = makeSource(app, p, "Loose", "feed/loose");
  const w = at(app, p, work, ago(1000)), f = at(app, p, fun, ago(2000)), l = at(app, p, loose, ago(3000));
  const done = at(app, p, fun, ago(5000)), dropped = at(app, p, fun, ago(6000)), later = at(app, p, work, ago(7000));
  workflow(app, p, done, "finished");
  workflow(app, p, dropped, "ignored");
  workflow(app, p, later, "toread");
  const feed = () => pageAll(app, p, { scope: "home", limit: 2, mix: "home", filter: "open" });
  assert.deepEqual(feed(), [w, f, l, later], "New newest first, then To read");
  app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", workBox.id);
  assert.deepEqual(feed(), [f, l]);
  setPreferences(app, p.workspaceId, { homeOther: false });
  assert.deepEqual(feed(), [f]);
});

test("a Home list reads the items that existed when paging began: a backdated arrival waits for a refresh", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun } = twoCollections(app, p);
  const day = (hour: number) => `2026-05-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const early = at(app, p, work, day(1)), five = at(app, p, work, day(5));
  const late = at(app, p, fun, day(20)), mid = at(app, p, fun, day(10));
  const query = { scope: "home", mix: "home", filter: "open", limit: 1 } as const;
  const first = listItems(app, p, query);
  assert.deepEqual(ids(first.items), [late]);
  // Between the pages an item arrives dated after the item the next page starts from.
  const arrival = at(app, p, work, day(15));
  const rest: string[] = [];
  let cursor = first.nextCursor ?? undefined;
  while (cursor) {
    const page = listItems(app, p, { ...query, cursor });
    rest.push(...ids(page.items));
    cursor = page.nextCursor ?? undefined;
  }
  assert.deepEqual(rest, [mid, five, early], "every item the first page promised is still there, in order");
  assert.ok(!rest.includes(arrival), "and the arrival waits for a refresh");
  assert.deepEqual(pageAll(app, p, { ...query, limit: 10 }), [late, arrival, mid, five, early], "a refresh shows it in its place");
  assert.throws(() => listItems(app, p, { ...query, cursor: Buffer.from(JSON.stringify(["2026-05-01T05:00:00.000Z", "itm_x"])).toString("base64url") }), /expired/, "a Home cursor without its snapshot is an old one");
});

// ---------- hide one source ----------

test("a list can leave one source out", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun, workBox } = twoCollections(app, p);
  const w = addItem(app, p, work), f = addItem(app, p, fun);
  const both = createCollection(app, p, { name: "Both", emoji: null, mode: "sources", sourceIds: [work, fun], query: null, view: "list" });
  void workBox;
  const without = listItems(app, p, { scope: `collection:${both.id}`, without: work, limit: 10 });
  assert.deepEqual(ids(without.items), [f]);
  assert.equal(without.total, null, "a narrowed list has no total");
  assert.deepEqual(new Set(ids(listItems(app, p, { scope: `collection:${both.id}`, limit: 10 }).items)), new Set([w, f]));
});

// ---------- type and length ----------

test("lists can be limited to articles, videos or podcasts, and to short or long items", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work } = twoCollections(app, p);
  const words = (n: number) => `<p>${"word ".repeat(n)}</p>`;
  const short = addItem(app, p, work, { summaryHtml: words(100) });
  const teaser = addItem(app, p, work, { summaryHtml: "<p>A few words.</p>" });
  const long = addItem(app, p, work, { summaryHtml: words(2000) });
  const clip = addItem(app, p, work, { kind: "video", durationSeconds: 240 });
  const film = addItem(app, p, work, { kind: "video", durationSeconds: 3600 });
  const show = addItem(app, p, work, { kind: "podcast", durationSeconds: 300 });
  const unknown = addItem(app, p, work, { kind: "podcast", durationSeconds: null });
  const post = addItem(app, p, work, { kind: "post", summaryHtml: words(150) });
  const q = (extra: Partial<ItemListQuery>) => new Set(ids(listItems(app, p, { scope: "all", limit: 50, ...extra }).items));
  assert.deepEqual(q({ type: "articles" }), new Set([short, teaser, long, post]));
  assert.deepEqual(q({ type: "videos" }), new Set([clip, film]));
  assert.deepEqual(q({ type: "podcasts" }), new Set([show, unknown]));
  assert.deepEqual(q({ type: "videos,podcasts" }), new Set([clip, film, show, unknown]));
  assert.deepEqual(q({ length: "short" }), new Set([short, clip, show, post]), "up to five minutes, reading or playing");
  assert.deepEqual(q({ length: "long" }), new Set([long, film]), "items of unknown length (a teaser, an episode with no duration) are in neither");
  assert.deepEqual(q({ type: "videos", length: "short" }), new Set([clip]));
  assert.equal(listItems(app, p, { scope: "all", limit: 50, type: "videos" }).total, null, "a narrowed list has no total");
  assert.throws(() => listItems(app, p, { scope: "all", type: "books" as never }), /./);
});

// ---------- muted words ----------

test("muted words last for the time chosen, are listed once each, and a word with nothing to match is left out", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const words = [{ text: "a", until: null }, { text: "b", until: "2026-05-02T00:00:00.000Z" }, { text: "c", until: "2026-04-30T00:00:00.000Z" }];
  assert.deepEqual(activeMutedWords(words, now).map((w) => w.text), ["a", "b"]);
  assert.equal(mutedPatterns(["???", " "]), null, "no letters or digits, nothing to match");
  assert.equal(mutedPatterns(["Café  Racer", "???"]), JSON.stringify([["cafe", "racer"]]));
  assert.ok(preferencesPatchSchema.safeParse({ mutedWords: [{ text: "Football", until: null }, { text: "football", until: null }] }).error, "each word once");
  assert.ok(preferencesPatchSchema.safeParse({ mutedWords: [{ text: "Football", until: "2026-12-01T00:00:00.000Z" }] }).success);
  assert.ok(preferencesPatchSchema.safeParse({ mutedWords: [{ text: " ", until: null }] }).error);
});

test("items that match a muted word stay stored but are left out of Home and lists, with a count and a way to show them", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work, fun } = twoCollections(app, p);
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  const title = addItem(app, p, work, { title: "Football transfer news", summaryHtml: "<p>Nothing else.</p>" });
  const summary = addItem(app, p, work, { title: "Match report", summaryHtml: "<p>A long FOOTBALL weekend.</p>" });
  const accent = addItem(app, p, fun, { title: "Café culture", summaryHtml: "<p>Coffee.</p>" });
  const phrase = addItem(app, p, fun, { title: "The great bake off recap", summaryHtml: "<p>Cake.</p>" });
  const stays = addItem(app, p, fun, { title: "Footballers' wives", summaryHtml: "<p>Not the same word.</p>" });
  const bakeSeparate = addItem(app, p, fun, { title: "Bake sale off the high street", summaryHtml: "<p>Words apart.</p>" });
  const kept = addItem(app, p, work, { title: "Football history", summaryHtml: "<p>Kept.</p>" });
  keepItem(app, p, kept, basket.id);
  workflow(app, p, title, "toread"); workflow(app, p, stays, "toread");
  const lists = () => new Set(ids(listItems(app, p, { scope: "all", limit: 50 }).items));
  const everything = new Set([title, summary, accent, phrase, stays, bakeSeparate, kept]);
  assert.deepEqual(lists(), everything);
  assert.equal(listItems(app, p, { scope: "all", limit: 50 }).mutedHidden, undefined, "nothing muted, nothing to say");

  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }, { text: "CAFE", until: null }, { text: "bake off", until: ago(-7 * DAY) }] });
  assert.deepEqual(lists(), new Set([stays, bakeSeparate]), "title, summary, accents, a phrase; not other words nor the same words apart");
  const page = listItems(app, p, { scope: "all", limit: 50 });
  assert.equal(page.mutedHidden, 5);
  assert.equal(page.total, null);
  const one = listItems(app, p, { scope: "all", limit: 1 });
  assert.equal(listItems(app, p, { scope: "all", limit: 1, cursor: one.nextCursor! }).mutedHidden, undefined, "said once, with the first page");
  assert.deepEqual(new Set(ids(listItems(app, p, { scope: "all", limit: 50, muted: "show" }).items)), everything, "shown on request");
  assert.deepEqual(new Set(ids(listItems(app, p, { scope: "all", limit: 50, q: "football" }).items)), new Set([title, summary, stays, kept]), "search still finds them (and, as always, words that start with it)");
  assert.deepEqual(ids(listItems(app, p, { scope: `basket:${basket.id}`, limit: 50 }).items), [kept], "so does a basket: what was kept is yours to see");
  assert.deepEqual(listItems(app, p, { scope: `source:${work}`, limit: 50 }).items.length, 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 7, "all stored");

  // Home: a box, the one feed, and the sections above them.
  const box = pageAll(app, p, { scope: `collection:${app.db.get<{ id: string }>("SELECT id FROM collections WHERE name = 'Fun'")!.id}`, limit: 10, mix: "home", filter: "open" });
  assert.deepEqual(new Set(box), new Set([stays, bakeSeparate]));
  assert.deepEqual(new Set(pageAll(app, p, { scope: "home", limit: 10, mix: "home", filter: "open" })), new Set([stays, bakeSeparate]));
  const o = homeOverview(app, p);
  assert.deepEqual(ids(o.toRead.items), [stays], "To read leaves out a To read item that matches too");
  assert.equal(o.toRead.total, 1);
  assert.equal(o.mutedHidden, 5 - 0, "Home says how many it left out");

  // A word that has ended no longer mutes, and is dropped the next time the list is saved.
  app.db.run("UPDATE preferences SET value = ? WHERE workspace_id = ?", JSON.stringify({ ...getPreferences(app, p.workspaceId), mutedWords: [{ text: "football", until: ago(1000) }] }), p.workspaceId);
  assert.deepEqual(lists(), everything);
  setPreferences(app, p.workspaceId, { theme: "dark" });
  assert.deepEqual(getPreferences(app, p.workspaceId).mutedWords, []);
});

test("a muted Arabic word matches after Arabic punctuation, with or without its article", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work } = twoCollections(app, p);
  const hit = addItem(app, p, work, { title: "الكتاب،المدينة", summaryHtml: "<p>نص</p>" });
  const summary = addItem(app, p, work, { title: "مقال", summaryHtml: "<p>عن المدرسة؛ والمكتبة</p>" });
  const keep = addItem(app, p, work, { title: "حديقة", summaryHtml: "<p>زهور</p>" });
  for (const word of ["المدينة", "مدينة", "المكتبة"]) {
    setPreferences(app, p.workspaceId, { mutedWords: [{ text: word, until: null }] });
    const shown = new Set(ids(listItems(app, p, { scope: "all", limit: 10 }).items));
    assert.ok(!shown.has(word === "المكتبة" ? summary : hit), `${word} is left out`);
    assert.ok(shown.has(keep));
  }
});

test("the count of items muted words left out looks at a bounded number of candidates, and says when it stopped early", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work } = twoCollections(app, p);
  const garden = addItem(app, p, work, { title: "Garden" });
  for (let i = 0; i < 8; i++) addItem(app, p, work, { title: `Football ${i}`, summaryHtml: "<p>x</p>" });
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }] });
  const whole = listItems(app, p, { scope: "all", limit: 10 });
  assert.deepEqual([ids(whole.items), whole.mutedHidden, whole.mutedHiddenAtLeast], [[garden], 8, undefined], "a list within the bound is counted whole");
  assert.deepEqual([homeOverview(app, p).mutedHidden, homeOverview(app, p).mutedHiddenAtLeast], [8, false]);
  const before = mutedScan.rows;
  mutedScan.rows = 4;
  try {
    const part = listItems(app, p, { scope: "all", limit: 10 });
    assert.ok(part.mutedHidden! >= 1 && part.mutedHidden! <= 5, `counted among the first candidates (${part.mutedHidden})`);
    assert.equal(part.mutedHiddenAtLeast, true, "and says there may be more");
    const home = homeOverview(app, p);
    assert.equal(home.mutedHiddenAtLeast, true);
    assert.ok(home.mutedHidden >= 1 && home.mutedHidden <= 5);
  } finally { mutedScan.rows = before; }
});

test("Home's To read neither asks the muted words about every To read item nor counts them all", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const { work } = twoCollections(app, p);
  const read: string[] = [];
  for (let i = 0; i < 120; i++) {
    const id = at(app, p, work, ago((200 - i) * 60_000), { title: i % 4 === 0 ? `Football ${i}` : `Garden ${i}` });
    workflow(app, p, id, "toread");
    read.push(id);
  }
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }] });
  // Every question put to the muted words, counted where the database asks it.
  let asked = 0;
  app.db.raw.function("purss_muted", { deterministic: true }, (patterns, title, excerpt) => { asked++; return matchesMuted(String(patterns), title, excerpt) ? 1 : 0; });
  const before = mutedScan.rows;
  mutedScan.rows = 20;
  try {
    const o = homeOverview(app, p);
    assert.deepEqual(ids(o.toRead.items), read.filter((_, i) => i % 4 !== 0).slice(0, 6), "the oldest To read items the words do not match");
    assert.ok(asked <= 80, `${asked} questions put to the muted words for 120 To read items`);
    assert.equal(o.toRead.totalAtMost, true, "the total was made in part: it may be too high");
    assert.ok(o.toRead.total >= 90 - 5 && o.toRead.total <= 120, `a total near the truth (${o.toRead.total})`);
    mutedScan.rows = 1000;
    asked = 0;
    const whole = homeOverview(app, p);
    assert.deepEqual([whole.toRead.total, whole.toRead.totalAtMost], [90, false], "a short list is counted whole");
    assert.ok(asked >= 120, "and then every item was looked at");
  } finally { mutedScan.rows = before; }
});

test("muted words are the PURSS's own", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  const mine = makeSource(app, p, "Mine", "feed/mine");
  const theirs = makeSource(app, other, "Theirs", "feed/theirs");
  addItem(app, p, mine, { title: "football" });
  const t2 = addItem(app, other, theirs, { title: "football" });
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }] });
  assert.deepEqual(listItems(app, p, { scope: "all", limit: 10 }).items, []);
  assert.deepEqual(ids(listItems(app, other, { scope: "all", limit: 10 }).items), [t2]);
});

// ---------- plans ----------

/** The statements a function runs, with their parameters. */
function statements(app: App, fn: () => void): { sql: string; params: unknown[] }[] {
  const db = app.db as unknown as Record<"all" | "get" | "run", (sql: string, ...params: unknown[]) => unknown>;
  const original = { all: db.all, get: db.get, run: db.run };
  const seen: { sql: string; params: unknown[] }[] = [];
  for (const k of ["all", "get", "run"] as const) db[k] = (sql, ...params) => { seen.push({ sql, params }); return original[k].call(app.db, sql, ...params); };
  try { fn(); } finally { Object.assign(db, original); }
  return seen;
}

test("Home's one feed and a list that leaves out muted items read the date index, and ask nothing of the search index or of other PURSSes", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  twoCollections(app, p);
  setPreferences(app, p.workspaceId, { mutedWords: [{ text: "football", until: null }] });
  const seen = statements(app, () => {
    listItems(app, p, { scope: "home", mix: "home", filter: "open", limit: 50 });
    listItems(app, p, { scope: "all", limit: 50 });
    homeOverview(app, p);
  });
  assert.ok(!seen.some((q) => /items_fts|temp\./.test(q.sql)), "the text index and temporary tables are not used");
  assert.ok(!seen.some((q) => /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(q.sql)), "and nothing is written: there is nothing to keep up to date");
  const pages = seen.filter((q) => /ORDER BY sort_key/.test(q.sql));
  assert.equal(pages.length, 3, "Home's two runs (New, then To read) and the other list");
  for (const q of pages) {
    const plan = app.db.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as never[])).map((r) => String(r.detail));
    assert.ok(plan.some((l) => /^SEARCH i USING (COVERING )?INDEX items_ws_sortkey/.test(l)), `the page reads the date index in order:\n${plan.join("\n")}`);
    assert.ok(!plan.some((l) => /TEMP B-TREE FOR ORDER BY/.test(l)), plan.join("\n"));
    assert.ok(!plan.some((l) => /^SCAN (i|st|s|items|item_state)\b/.test(l) && !/USING (COVERING )?INDEX/.test(l)), plan.join("\n"));
  }
});
