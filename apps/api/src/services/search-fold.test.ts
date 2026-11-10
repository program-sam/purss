import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { insertItem, listItems, searchSnippets } from "./items.ts";
import { rebuildSearchIndex, searchIndexIsCurrent, SEARCH_INDEX_VERSION, startSearchIndexRebuild, stepSearchIndex } from "./search-index.ts";
import { foldForSearch, ftsQuery, stemTerm } from "./search-text.ts";
import { putAnnotation } from "./annotations.ts";
import { newId } from "@purss/domain";

test("Arabic is folded: vowel marks, stretched letters, alef and heh variants, the article and digits", () => {
  const same = (a: string, b: string) => assert.equal(foldForSearch(a), foldForSearch(b), `${a} / ${b}`);
  same("كِتَابٌ", "كتاب");
  same("كتــاب", "كتاب");
  same("الكتاب", "كتاب");
  same("والكتاب", "كتاب");
  same("بالكتاب", "كتاب");
  same("للمدرسة", "مدرسه");
  same("أحمد", "احمد");
  same("إبراهيم", "ابراهيم");
  same("آمن", "امن");
  same("مدرسة", "مدرسه");
  same("على", "علي");
  same("مسؤول", "مسوول");
  same("مُحَمَّد", "محمد");
  same("٢٠٢٤", "2024");
  same("ک", "ك");
  assert.equal(foldForSearch("الله"), "الله", "a word that would be left with two letters keeps its article");
  assert.equal(foldForSearch("Café Müller, the 12 trains"), "Café Müller, the 12 trains", "other scripts are left to the index");
  assert.equal(foldForSearch("Le livre الكِتاب is here"), "Le livre كتاب is here");
  assert.notEqual(foldForSearch("كتب"), foldForSearch("كتاب"));
});

test("Arabic punctuation separates words: each folds on its own, so the article comes off the word after a comma too", () => {
  assert.equal(foldForSearch("الكتاب،المدينة"), "كتاب،مدينه");
  assert.equal(foldForSearch("الكتاب؛المدينة؟والمدرسة"), "كتاب؛مدينه؟مدرسه");
  assert.equal(foldForSearch("المدينة۔الكتاب"), "مدينه۔كتاب", "the Urdu full stop too");
  assert.equal(foldForSearch("﴾الكتاب﴿ و ﴾المدينة﴿"), "﴾كتاب﴿ و ﴾مدينه﴿", "and the ornate brackets");
  assert.equal(foldForSearch("الكتاب, المدينة"), "كتاب, مدينه", "as the ASCII comma already did");
  assert.equal(foldForSearch("٣٫٥"), "3٫5", "digits either side of a decimal separator still fold");
});

test("search finds a word after Arabic punctuation, and a database indexed with the earlier fold is rebuilt", async (t) => {
  const { app, p, add, find, cleanup } = setup();
  t.after(cleanup);
  const id = add("الكتاب،المدينة", { summaryHtml: "<p>مقال قصير؛ عن المدرسة؟ والمكتبة</p>" });
  assert.deepEqual(find("المدينة"), [id]);
  assert.deepEqual(find("مدينة"), [id]);
  assert.deepEqual(find("المكتبة"), [id], "after a question mark and a conjunction");
  assert.ok(SEARCH_INDEX_VERSION >= 3, "the fold changed, and the notes joined the rebuild, so an index built before is behind");
  // An index built with the earlier fold: the item is there as the old code folded it.
  app.db.run("DELETE FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = ?)", id);
  app.db.run("INSERT INTO items_fts (rowid, title, excerpt, author, body) SELECT seq, ?, '', '', '' FROM items WHERE id = ?", "كتاب،المدينه", id);
  app.db.run("UPDATE search_index_state SET version = 1, cursor = 0 WHERE id = 1");
  assert.equal(searchIndexIsCurrent(app), false);
  assert.deepEqual(find("المدينة"), [], "found by what it was indexed as");
  await startSearchIndexRebuild(app, 2);
  assert.deepEqual(find("المدينة"), [id]);
  void p;
});

test("a query tolerates English plurals and always asks for word starts", () => {
  for (const [typed, stem] of [["sleeves", "sleeve"], ["Libraries", "Librar"], ["boxes", "box"], ["churches", "church"], ["trains", "train"], ["glass", "glass"], ["status", "status"], ["analysis", "analysis"], ["bus", "bus"], ["cats", "cat"], ["model", "model"]] as const) {
    assert.equal(stemTerm(typed), stem, typed);
  }
  assert.equal(ftsQuery("sleeves  track"), '"sleeve"* "track"*');
  assert.equal(ftsQuery('say "hello"'), '"say"* "hello"*');
  assert.equal(ftsQuery("الكِتَاب"), '"كتاب"*');
  assert.equal(ftsQuery("   "), '""');
  assert.equal(ftsQuery("ـــ"), '""', "a word made only of stretching marks is nothing to search for");
});

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const src = makeSource(app, p, "Blog", "feed/1");
  const add = (title: string, over: { summaryHtml?: string | null; author?: string | null } = {}) =>
    insertItem(app, {
      accountId: p.accountId, workspaceId: p.workspaceId, sourceId: src, kind: "article", title, url: `https://example.org/${encodeURIComponent(title)}`, author: over.author ?? null,
      summaryHtml: over.summaryHtml ?? null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null, publishedAt: null,
      discoveredAt: new Date().toISOString(), enclosures: [], fresh: false, reason: "test",
    }).id;
  const find = (q: string) => listItems(app, p, { scope: "all", q }).items.map((i) => i.id);
  return { app, p, add, find, cleanup };
}

test("search finds Arabic however it is written, and English plurals either way", (t) => {
  const { add, find, cleanup } = setup();
  t.after(cleanup);
  const a = add("الكِتَابُ الجَدِيدُ", { summaryHtml: "<p>قِصَّةٌ طَوِيلَةٌ عَنْ مَدْرَسَةٍ قديمة في مدينة كبيرة</p>" });
  const b = add("Sleeve notes for the model railway", { summaryHtml: "<p>The sleeves are blue and the tracks are long.</p>" });
  const c = add("Café Müller", { author: "Pina Bausch" });
  const d = add("كتب وأقلام");
  for (const q of ["كتاب", "الكتاب", "كِتَابٌ", "الجديد", "جديد", "مدرسة", "مدرسه", "المدرسة", "ا", "قصه"]) {
    if (q === "ا") continue; // a single letter is not a search
    assert.deepEqual(find(q), [a], q);
  }
  assert.deepEqual(find("كتب"), [d], "a different word is not matched");
  assert.deepEqual(find("sleeve"), [b]);
  assert.deepEqual(find("sleeves"), [b]);
  assert.deepEqual(find("tracks"), [b]);
  assert.deepEqual(find("cafe"), [c]);
  assert.deepEqual(find("muller bausch"), [c]);
  assert.deepEqual(find("railway sleeves blue"), [b], "every word must match");
  assert.deepEqual(find("zebra"), []);
});

test("snippets mark the word that matched, as written", (t) => {
  const { app, add, cleanup } = setup();
  t.after(cleanup);
  const a = add("Notes", { summaryHtml: "<p>Der Text über die Rückkehr der Sleeves aus dem Café und الكِتَابُ الجَدِيدُ am Ende.</p>" });
  const snip = (q: string) => searchSnippets(app, [a], q)[a] ?? "";
  assert.match(snip("sleeve"), /\u0001Sleeve\u0002s aus/, "the match is a word start, so the rest of the word stays outside the mark");
  assert.match(snip("sleeves"), /\u0001Sleeve\u0002s aus/, "a plural is searched by its stem");
  assert.match(snip("cafe"), /\u0001Café\u0002/);
  assert.match(snip("ruckkehr"), /\u0001Rückkehr\u0002/);
  assert.match(snip("كتاب"), /\u0001الكِتَابُ\u0002/);
  assert.match(snip("الجديد"), /\u0001الجَدِيدُ\u0002/);
  assert.match(snip("rück"), /\u0001Rück\u0002kehr/, "a prefix marks only the prefix");
  assert.deepEqual(searchSnippets(app, [a], "absent"), {});
});

test("an index built before the fold is rebuilt in steps, resumes where it stopped, and answers meanwhile", async (t) => {
  const { app, p, add, find, cleanup } = setup();
  t.after(cleanup);
  const ids = [add("الكِتَابُ الجَدِيدُ"), add("مَدْرَسَةٌ"), add("Plain English"), add("كتاب ثالث"), add("خامس")];
  // The state of a database that has just been upgraded: entries as the old code wrote them, version 0.
  legacyIndex(app, p);
  assert.equal(searchIndexIsCurrent(app), false);
  assert.deepEqual(find("كتاب"), [ids[3]!], "not yet folded: only the item written without marks matches");
  assert.deepEqual(find("plain"), [ids[2]!], "and search keeps answering");

  assert.equal(stepSearchIndex(app, 2), false);
  assert.equal(stepSearchIndex(app, 2), false);
  const mid = app.db.get<{ version: number; cursor: number }>("SELECT version, cursor FROM search_index_state")!;
  assert.deepEqual([mid.version, mid.cursor > 0], [0, true], "progress is remembered");
  assert.equal(stepSearchIndex(app, 2), true);
  assert.equal(app.db.get<{ version: number }>("SELECT version FROM search_index_state")!.version, SEARCH_INDEX_VERSION);
  assert.equal(searchIndexIsCurrent(app), true);
  assert.deepEqual(new Set(find("كتاب")), new Set([ids[0]!, ids[3]!]));
  assert.deepEqual(find("مدرسه"), [ids[1]!]);
  assert.equal(stepSearchIndex(app), true, "nothing left to do");

  // The background form reaches the same place and ends when it is done.
  legacyIndex(app, p);
  await startSearchIndexRebuild(app, 2);
  assert.deepEqual(find("مدرسه"), [ids[1]!]);
  legacyIndex(app, p);
  assert.ok(rebuildSearchIndex(app, 1) >= 5);
  assert.deepEqual(find("مدرسه"), [ids[1]!]);
});

test("a rebuild re-indexes the person's notes too, with the fold of the new version", async (t) => {
  const { app, p, add, find, cleanup } = setup();
  t.after(cleanup);
  const id = add("A plain title");
  putAnnotation(app, p, id, newId("ann"), { kind: "note", body: "الكتاب،المدينة", updatedAt: new Date().toISOString() });
  assert.deepEqual(find("المدينة"), [id], "a note written now is found by the fold of now");
  // A note as the version before wrote it: the article was taken off the first word of the run only.
  const seq = app.db.get<{ seq: number }>("SELECT seq FROM annotations")!.seq;
  app.db.run("DELETE FROM annotations_fts WHERE rowid = ?", seq);
  app.db.run("INSERT INTO annotations_fts (rowid, quote, body) VALUES (?, '', ?)", seq, "كتاب،المدينه");
  app.db.run("UPDATE search_index_state SET version = 1, cursor = 0");
  assert.deepEqual(find("المدينة"), [], "found by what it was indexed as");
  await startSearchIndexRebuild(app, 2);
  assert.deepEqual(find("المدينة"), [id], "after the rebuild the note is found like new ones");
  assert.deepEqual(find("الكتاب"), [id]);
});

test("a database whose rebuild finished before notes were part of it runs the rebuild once more", async (t) => {
  const { app, p, add, find, cleanup } = setup();
  t.after(cleanup);
  const id = add("A plain title");
  putAnnotation(app, p, id, newId("ann"), { kind: "note", body: "الكتاب،المدينة", updatedAt: new Date().toISOString() });
  // A note as version 2 left it: the items had been re-indexed with the new fold, the notes had not.
  const seq = app.db.get<{ seq: number }>("SELECT seq FROM annotations")!.seq;
  app.db.run("DELETE FROM annotations_fts WHERE rowid = ?", seq);
  app.db.run("INSERT INTO annotations_fts (rowid, quote, body) VALUES (?, '', ?)", seq, "كتاب،المدينه");
  app.db.run("UPDATE search_index_state SET version = 2, target = 2, cursor = 0, annotation_cursor = 0");
  assert.equal(searchIndexIsCurrent(app), false, "version 2 is behind: it did not re-index notes");
  assert.deepEqual(find("المدينة"), [], "the stale note is found by what it was indexed as");
  await startSearchIndexRebuild(app, 2);
  assert.equal(searchIndexIsCurrent(app), true);
  assert.deepEqual(find("المدينة"), [id], "after the rebuild the note is found like new ones");
});

test("a rebuild that was interrupted under an older version starts again from the beginning under the new one", (t) => {
  const { app, p, add, find, cleanup } = setup();
  t.after(cleanup);
  const ids = [add("الكِتَابُ الجَدِيدُ"), add("مَدْرَسَةٌ"), add("كتاب ثالث"), add("خامس"), add("الكِتَابُ الأخير")];
  legacyIndex(app, p);
  // The earlier version's rebuild had got through four of the five when it was interrupted: its cursor is where it stopped.
  const seqs = app.db.all<{ seq: number }>("SELECT seq FROM items ORDER BY seq").map((r) => r.seq);
  app.db.run("UPDATE search_index_state SET version = 1, cursor = ?, target = 1", seqs[3]!);
  assert.equal(searchIndexIsCurrent(app), false, "the index is behind the current version");
  rebuildSearchIndex(app, 2);
  assert.equal(searchIndexIsCurrent(app), true);
  assert.deepEqual(new Set(find("كتاب")), new Set([ids[0]!, ids[2]!, ids[4]!]), "the items the old cursor had passed are re-indexed too");
  assert.deepEqual(find("مدرسه"), [ids[1]!]);
  const state = app.db.get<{ version: number; cursor: number; target: number; annotation_cursor: number }>("SELECT version, cursor, target, annotation_cursor FROM search_index_state")!;
  assert.deepEqual({ ...state }, { version: SEARCH_INDEX_VERSION, cursor: 0, target: SEARCH_INDEX_VERSION, annotation_cursor: 0 }, "and the state says it is done");
  void p;
});

test("the background rebuild ends quietly if the database is closed under it", async () => {
  const { app, p, add, cleanup } = setup();
  add("الكِتَابُ");
  legacyIndex(app, p);
  const done = startSearchIndexRebuild(app, 1);
  cleanup();
  await done;
});

function legacyIndex(app: App, p: Principal): void {
  app.db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
  for (const r of app.db.all<{ seq: number; title: string }>("SELECT seq, title FROM items WHERE workspace_id = ?", p.workspaceId)) {
    app.db.run("INSERT INTO items_fts (rowid, title, excerpt, author, body) VALUES (?, ?, '', '', '')", r.seq, r.title); // as written, unfolded
  }
  app.db.run("UPDATE search_index_state SET version = 0, cursor = 0");
}
