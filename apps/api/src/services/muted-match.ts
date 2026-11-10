import { foldForSearch } from "./search-text.ts";

/*
 * Whether muted words match an item's text (plan/34): whole words, case ignored, Arabic folded as search folds it (search-text.ts)
 * and accents dropped from Latin letters, which is what the text index does and all it does: Cyrillic "й", Greek accents and
 * Indic vowel signs are part of a word there, so they are here. A phrase matches its words next to each other, in the title or in
 * the summary. This is plain text matching on the one row a query is looking at, so it costs in proportion to the rows looked at
 * and nothing else: it does not ask the search index, whose work grows with every PURSS's items.
 */

/** Combining marks the index drops from inside a word (U+0300-0331, the ones it treats as diacritics). Any other mark ends the word. */
const DROPPED_MARKS = "\\u0300-\\u0304\\u0306-\\u030c\\u030f\\u0311\\u031b\\u0323-\\u0328\\u032d\\u032e\\u0330\\u0331";
/** Letters that lowercasing leaves and the index writes as another: the micro sign, long s, final sigma, the Greek letter variants and the iota sign. */
const WRITTEN_AS: Record<string, string> = {
  "\u00b5": "\u03bc", "\u017f": "s", "\u03c2": "\u03c3", "\u03d0": "\u03b2", "\u03d1": "\u03b8", "\u03d5": "\u03c6", "\u03d6": "\u03c0", "\u03f0": "\u03ba", "\u03f1": "\u03c1", "\u03f5": "\u03b5", "\u1fbe": "\u03b9",
};
const WRITTEN_AS_RE = /[\u00b5\u017f\u03c2\u03d0\u03d1\u03d5\u03d6\u03f0\u03f1\u03f5\u1fbe]/g;
/** Latin letters with an accent, as one character. The index keeps five whole: a with dot and macron, ae and ezh with macron, ae and o-stroke with acute. */
const ACCENTED = /[\p{Script=Latin}--[\x00-\x7f]--[\u01e1\u01e3\u01ef\u01fd\u01ff]]/gv;
const MARKS = /\p{M}/gu;
const INNER_MARKS = new RegExp(`(?<=[\\p{L}\\p{N}])[${DROPPED_MARKS}]+`, "gu");
/**
 * Whether lowercasing is all a text needs: nothing in it is Arabic-script, an accented Latin letter, a dropped mark or a letter
 * the index writes as another. Most text, even with curly quotes, dashes and non-Latin scripts, is like that.
 */
const NEEDS_FOLD = new RegExp(`[\\u00b5\\u00c0-\\u024f${DROPPED_MARKS}\\u03c2\\u03d0\\u03d1\\u03d5\\u03d6\\u03f0\\u03f1\\u03f5\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\u1e00-\\u1eff\\u1fbe\\ufb50-\\ufdff\\ufe70-\\ufeff]`);

const withoutAccent = new Map<string, string>();
function bareLetter(c: string): string {
  let b = withoutAccent.get(c);
  if (b === undefined) {
    b = c.normalize("NFD").replace(MARKS, "");
    withoutAccent.set(c, b);
  }
  return b;
}

/** The text as the index holds it: lowercase, folded as search folds it, Latin accents gone. Words are what runs of letters and digits are in it. */
function folded(text: string): string {
  const lower = text.toLowerCase();
  if (!NEEDS_FOLD.test(lower)) return lower;
  return foldForSearch(lower).replace(ACCENTED, bareLetter).replace(WRITTEN_AS_RE, (c) => WRITTEN_AS[c]!).replace(INNER_MARKS, "");
}

/** The words of a text as muted words compare them. */
export function plainWords(text: string): string[] {
  return folded(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Texts that needed folding, already folded: a list asks about the same rows again and again, and folding is the costly part for
 * the few texts that need it (plain text is only lowercased, which costs less than looking it up). Two generations: new entries
 * go into the current one; when it is full it becomes the old one and the old one is dropped. What was used lately is kept (a hit
 * in the old one moves to the current), a scan of more rows than fit loses the oldest half and not everything, and nothing walks
 * a long map to find the oldest (a Map used as a least-recently-used list does, and slows down by far once a scan outgrows it).
 */
const SEEN_LIMIT = 20_000;
let current = new Map<string, string>();
let previous = new Map<string, string>();
function foldedOf(text: string): string {
  const lower = text.toLowerCase();
  if (!NEEDS_FOLD.test(lower)) return lower;
  const now = current.get(text);
  if (now !== undefined) return now;
  let value = previous.get(text);
  if (value === undefined) value = folded(lower);
  if (current.size >= SEEN_LIMIT / 2) {
    previous = current;
    current = new Map();
  }
  current.set(text, value);
  return value;
}

/** Whether a character is part of a word: a letter or a digit. Asked about the few characters beside a candidate match only. */
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const known = new Uint8Array(0x10000); // by character: 0 not asked yet, 1 part of a word, 2 not
function isWord(code: number): boolean {
  if (code < 0x80) return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
  if (code > 0xffff) return WORD_CHAR.test(String.fromCodePoint(code));
  let k = known[code]!;
  if (k === 0) known[code] = k = WORD_CHAR.test(String.fromCharCode(code)) ? 1 : 2;
  return k === 1;
}
/** The character starting at index i, whole when it is a pair. */
const at = (t: string, i: number): number => t.codePointAt(i)!;
/** Whether the character before index i is part of a word. */
function wordBefore(t: string, i: number): boolean {
  const low = t.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) return isWord(t.codePointAt(i - 2)!);
  return isWord(low);
}

/** Whether the phrase's words stand next to each other, apart by anything that is not a letter or digit, in the folded text. */
function hasPhrase(t: string, phrase: readonly string[]): boolean {
  const first = phrase[0]!;
  for (let from = t.indexOf(first); from >= 0; from = t.indexOf(first, from + 1)) {
    if (from > 0 && wordBefore(t, from)) continue;
    let end = from + first.length;
    if (end < t.length && isWord(at(t, end))) continue; // the start of a longer word
    let all = true;
    for (let k = 1; all && k < phrase.length; k++) {
      let start = end;
      while (start < t.length) {
        const code = at(t, start);
        if (isWord(code)) break;
        start += code > 0xffff ? 2 : 1;
      }
      end = start + phrase[k]!.length;
      all = t.startsWith(phrase[k]!, start) && (end >= t.length || !isWord(at(t, end)));
    }
    if (all) return true;
  }
  return false;
}

/** The muted words and phrases as lists of plain words, as the `purss_muted` SQL function takes them (a JSON string). Words with nothing to match are left out. */
export function mutedPatterns(texts: readonly string[]): string | null {
  const phrases = texts.map(plainWords).filter((w) => w.length > 0);
  return phrases.length ? JSON.stringify(phrases) : null;
}

const compiled = new Map<string, string[][]>();
function compile(patterns: string): string[][] {
  let list = compiled.get(patterns);
  if (!list) {
    if (compiled.size >= 16) compiled.clear();
    list = JSON.parse(patterns) as string[][];
    compiled.set(patterns, list);
  }
  return list;
}

/** Whether any pattern matches the title or the summary. The SQL function `purss_muted(patterns, title, excerpt)` is this. */
export function matchesMuted(patterns: string, title: unknown, excerpt: unknown): boolean {
  const list = compile(patterns);
  const t = typeof title === "string" ? foldedOf(title) : "";
  const e = typeof excerpt === "string" ? foldedOf(excerpt) : "";
  return list.some((phrase) => hasPhrase(t, phrase) || hasPhrase(e, phrase));
}
