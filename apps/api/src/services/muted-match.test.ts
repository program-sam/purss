import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { matchesMuted, mutedPatterns, plainWords } from "./muted-match.ts";
import { foldForSearch } from "./search-text.ts";

const matches = (words: string[], title: string, excerpt = "") => matchesMuted(mutedPatterns(words)!, title, excerpt);

test("muted words match whole words, in any case or accent, in the title or the summary", () => {
  assert.equal(matches(["football"], "Football transfer news"), true);
  assert.equal(matches(["football"], "Match report", "A long FOOTBALL weekend"), true);
  assert.equal(matches(["café"], "Cafe culture"), true, "accents either way");
  assert.equal(matches(["cafe"], "Café culture"), true);
  assert.equal(matches(["football"], "Footballers' wives"), false, "not the start of a longer word");
  assert.equal(matches(["foot"], "Football"), false);
  assert.equal(matches(["football"], "Gardening", "Plants"), false);
  assert.equal(matches(["сегодня"], "СЕГОДНЯ в городе"), true, "case in other scripts");
  assert.equal(matches(["don"], "Don't"), true, "an apostrophe ends a word, as in search");
  assert.equal(matches(["2024"], "Budget 2024"), true);
  assert.equal(matches(["٢٠٢٤"], "Budget 2024"), true, "Arabic-Indic digits fold to digits");
});

test("a phrase matches its words next to each other, within the title or within the summary, and any muted word is enough", () => {
  assert.equal(matches(["bake off"], "The great Bake Off recap"), true);
  assert.equal(matches(["bake off"], "Bake sale off the high street"), false, "not the same words apart");
  assert.equal(matches(["bake off"], "Great bake", "off we go"), false, "nor across the title and the summary");
  assert.equal(matches(["bake off"], "Great", "the bake off again"), true);
  assert.equal(matches(["tennis", "bake off"], "Wimbledon tennis"), true);
  assert.equal(matches(["tennis", "bake off"], "Chess"), false);
  assert.equal(matchesMuted(mutedPatterns(["x"])!, null, undefined), false, "an item with no text");
});

test("accents are dropped from Latin letters only: other scripts keep the marks that tell words apart", () => {
  assert.equal(matches(["мой"], "Мои друзья"), false, "Cyrillic short i (й) is a letter of its own");
  assert.equal(matches(["мой"], "Мой город"), true);
  assert.equal(matches(["край"], "Краи"), false);
  assert.equal(matches(["ελλάδα"], "Ελλαδα"), false, "the Greek tonos is not dropped");
  assert.equal(matches(["ελλάδα"], "ΕΛΛΆΔΑ"), true, "but case is");
  assert.equal(matches(["κυριακή"], "Κυριακη"), false);
  assert.equal(matches(["कल"], "किल"), false, "Devanagari vowel signs end a word, as in the index");
  assert.equal(matches(["कल"], "काला"), false);
  assert.equal(matches(["कल"], "कल की बात"), true);
  assert.equal(matches(["cafe"], "Café"), true, "Latin accents are dropped");
  assert.equal(matches(["cafe"], "Cafe\u0301"), true, "also as a letter and a separate mark");
  assert.equal(matches(["ñandú"], "NANDU"), true);
  assert.equal(matches(["σας"], "ΣΑΣ"), true, "the final sigma is the same letter");
});

test("Arabic is folded as search folds it: marks, the article, and a word after Arabic punctuation", () => {
  assert.equal(matches(["المدينة"], "الكتاب،المدينة"), true);
  assert.equal(matches(["مدينة"], "الكتاب؛ المدينة"), true);
  assert.equal(matches(["كتاب"], "الكِتَابُ الجَدِيدُ"), true);
  assert.equal(matches(["المكتبة"], "مقال", "عن المدرسة؛ والمكتبة"), true);
  assert.equal(matches(["حديقة"], "الكتاب،المدينة"), false);
  assert.deepEqual(plainWords("الكتاب،المدينة"), ["كتاب", "مدينه"]);
});

// The same answers the text index gives: muted words used to be looked up in it, and search still is.
test("muted words match what the search index would match as whole words", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(title, excerpt, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')");
  const items: [string, string][] = [
    ["Football transfer news", "Nothing else."], ["Match report", "A long FOOTBALL weekend."], ["Café culture", "Coffee."], ["The great bake off recap", "Cake."],
    ["Bake sale off the high street", "Words apart."], ["Footballers' wives", "Not the same word."], ["Great bake", "off we go"], ["Gardening", "Plants and the bake"],
    ["الكتاب،المدينة", "نص"], ["مقال", "عن المدرسة؛ والمكتبة"], ["الكِتَابُ الجَدِيدُ", ""], ["СЕГОДНЯ в городе", "Новости"], ["Don't stop", "Budget 2024"], ["Über uns", "Straße"],
    // The index drops accents from Latin letters only; other scripts keep the marks that tell words apart.
    ["Мой город", ""], ["Мои друзья", ""], ["Край света", ""], ["Краи", ""], ["Ελλάδα σήμερα", ""], ["Ελλαδα", ""], ["ΣΑΣ", ""], ["Κυριακή", ""], ["Κυριακη", ""],
    ["कल की बात", ""], ["किल का नाम", ""], ["काला रंग", ""], ["Zoë and José", ""], ["Ñandú", "ǖber, ẽ"], ["Cafe\u0301 society", ""],
    ["great 🎂bake🎂 off", ""], ["𝐛ake", ""], ["𠀀𠀁 word", ""],
  ];
  items.forEach(([title, excerpt], i) => db.prepare("INSERT INTO t (rowid, title, excerpt) VALUES (?, ?, ?)").run(i + 1, foldForSearch(title), foldForSearch(excerpt)));
  for (const word of ["football", "café", "cafe", "bake off", "bake", "off", "المدينة", "مدينة", "المكتبة", "كتاب", "сегодня", "don", "2024", "uber", "über", "strasse", "wives",
    "мой", "мои", "край", "краи", "ελλάδα", "ελλαδα", "σας", "κυριακή", "κυριακη", "कल", "किल", "काला", "की", "zoe", "josé", "nandu", "ñandú", "ẽ", "word", "𠀀𠀁"]) {
    const viaIndex = new Set((db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(`{title excerpt} : ("${foldForSearch(word)}")`) as { rowid: number }[]).map((r) => r.rowid));
    const viaText = new Set(items.flatMap(([title, excerpt], i) => (matches([word], title, excerpt) ? [i + 1] : [])));
    assert.deepEqual(viaText, viaIndex, `"${word}"`);
  }
  db.close();
});

// Characters added to Unicode after the tables the text index uses were made: it reads them as part of a word, whatever they are.
const NEWER_THAN_INDEX = new Set([0x37f, 0x528, 0x52a, 0x52c, 0x52e, 0x605, 0x61c, 0x61d, 0x2066, 0x2067, 0x2068, 0x2069]);

test("every character of the common scripts is dropped, folded or kept apart as the search index does", () => {
  const blocks: [number, number][] = [
    [0x80, 0x24f], [0x250, 0x2af], [0x300, 0x36f], [0x370, 0x3ff], [0x400, 0x52f], [0x590, 0x5ff], [0x600, 0x6ff], [0x900, 0x97f], [0xe00, 0xe7f],
    [0x1e00, 0x1eff], [0x1f00, 0x1fff], [0x2000, 0x206f], [0x3040, 0x30ff],
  ];
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')");
  db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance')");
  const chars: string[] = [];
  for (const [from, to] of blocks) for (let c = from; c <= to; c++) if (!NEWER_THAN_INDEX.has(c) && !/^\p{Cn}$/u.test(String.fromCodePoint(c))) chars.push(String.fromCodePoint(c));
  const insert = db.prepare("INSERT INTO t (rowid, x) VALUES (?, ?)");
  chars.forEach((c, i) => insert.run(i + 1, foldForSearch(`a${c}b`)));
  const indexed = new Map<number, string[]>();
  for (const r of db.prepare("SELECT term, doc FROM v ORDER BY doc, offset").all() as { term: string; doc: number }[]) indexed.set(r.doc, [...(indexed.get(r.doc) ?? []), r.term]);
  const differ = chars.flatMap((c, i) => {
    const mine = plainWords(`a${c}b`);
    const theirs = indexed.get(i + 1) ?? [];
    return mine.join("|") === theirs.join("|") ? [] : [`U+${c.codePointAt(0)!.toString(16)} ${c}: index ${JSON.stringify(theirs)}, here ${JSON.stringify(mine)}`];
  });
  db.close();
  assert.ok(chars.length > 2000, "a sweep of several thousand characters");
  assert.deepEqual(differ, []);
});

test("a long run of different texts keeps matching right while the cache turns over", () => {
  const patterns = mutedPatterns(["wörd0", "wörd24999 extra"])!;
  // Texts that need folding are the ones kept; the cache holds fewer than this many, so it turns over twice.
  for (let i = 0; i < 45_000; i++) {
    const hit = matchesMuted(patterns, `Wörd${i} (Ünï)`, i === 24_999 ? "wörd24999, EXTRA" : "");
    if (i === 0 || i === 24_999) assert.equal(hit, true, `row ${i}`);
    else if (i % 997 === 0) assert.equal(hit, false, `row ${i}`);
  }
  assert.equal(matchesMuted(patterns, "WÖRD0", null), true, "the first text again, long out of the cache");
  assert.equal(matchesMuted(patterns, "wörd00", null), false);
});

test("phrases and words sit between any characters that are not letters or digits, astral ones included", () => {
  assert.equal(matches(["bake off"], "bake 🎂 off"), true);
  assert.equal(matches(["bake off"], "bake🎂off"), true);
  assert.equal(matches(["bake"], "🎂bake🎂"), true);
  assert.equal(matches(["bake"], "𝐛ake"), false, "a mathematical letter is a letter");
  assert.equal(matches(["bake off"], "bakeoff"), false);
  assert.equal(matches(["off"], "bakeoff"), false);
  assert.equal(matches(["bake"], "baker bake"), true, "a later occurrence when the first is the start of a longer word");
  assert.equal(matches(["a b c"], "a b cc a b c"), true);
  assert.equal(matches(["a b c"], "a b cc a bb c"), false);
});
