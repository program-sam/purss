/*
 * What search compares. The full-text index tokenises and lowercases (and drops Latin accents) by
 * itself, but it does not know that an Arabic word with vowel marks, a stretched letter, another
 * spelling of alef, or a leading "al-" is the same word as the plain one. Text is folded to one plain
 * form before it goes into the index and the same fold is applied to what is searched for, so the two
 * always meet. English plurals are tolerated on the query side. The fold is part of what the index
 * contains: changing it means raising SEARCH_INDEX_VERSION (see search-index.ts).
 */

/** The Arabic-script blocks, including presentation forms and the Persian/Urdu letters. */
const ARABIC_BLOCKS = "؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿";
/**
 * Runs of Arabic-script letters, marks and digits. The blocks hold punctuation too (the comma, semicolon and question mark, the
 * Urdu full stop, the ornate brackets); it ends a run, as the ASCII comma does, so each word is folded on its own and a word
 * after the comma loses its article like any other.
 */
const ARABIC_RUN = new RegExp(`[[${ARABIC_BLOCKS}]--\\p{P}]+`, "gv");
const ARABIC_ANY = new RegExp(`[${ARABIC_BLOCKS}]`);
/** Vowel marks, Quranic annotation signs, the superscript alef and the stretching tatweel. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;
const LETTER_MAP: Record<string, string> = {
  "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", // alef with madda, hamza above/below, wasla → alef
  "ى": "ي", "ی": "ي", "ے": "ي", // alef maqsura, Persian and Urdu yeh → yeh
  "ة": "ه", "ہ": "ه", "ھ": "ه", // teh marbuta, Urdu heh → heh
  "ک": "ك", // Persian kaf → kaf
  "ؤ": "و", "ئ": "ي", // hamza on waw / yeh → the carrier
};
const LETTER_FOLD = new RegExp(`[${Object.keys(LETTER_MAP).join("")}]`, "g");
const DIGIT_FOLD = /[٠-٩۰-۹]/g;
/** "al-" (the) and its commonest joined forms, taken off a word that keeps at least three letters. */
const ARTICLE = /^(?:وال|بال|كال|فال|ال|لل)/;

function foldArabicWord(word: string): string {
  let w = word.normalize("NFKC").replace(ARABIC_MARKS, "").replace(LETTER_FOLD, (c) => LETTER_MAP[c]!);
  w = w.replace(DIGIT_FOLD, (d) => String(d.charCodeAt(0) & 0xf));
  const m = ARTICLE.exec(w);
  if (m && w.length - m[0].length >= 3) w = w.slice(m[0].length);
  return w;
}

/** The text with every Arabic-script word folded; anything else is returned untouched (and quickly). */
export function foldForSearch(text: string): string {
  if (!text || !ARABIC_ANY.test(text)) return text;
  return text.replace(ARABIC_RUN, foldArabicWord);
}

/** English plurals: the stem is searched as a prefix, so "sleeves" finds "sleeve" and "libraries" finds "library". */
export function stemTerm(term: string): string {
  if (!/^[a-z]+$/i.test(term) || term.length < 4) return term;
  const t = term.toLowerCase();
  if (t.endsWith("ies") && t.length > 4) return term.slice(0, -3);
  if (/(?:ss|x|ch|sh|z)es$/.test(t)) return term.slice(0, -2);
  if (t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return term.slice(0, -1);
  return term;
}

/** The terms an item must start-match, as typed: folded, stemmed, at most twelve. */
export function searchTerms(text: string): string[] {
  return foldForSearch(text).split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean).slice(0, 12).map(stemTerm).filter(Boolean);
}

/** Turn user text into a safe FTS5 query: quoted prefix terms joined by AND. */
export function ftsQuery(text: string): string {
  const terms = searchTerms(text);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : '""';
}

/** A word as the index holds it, for finding what matched: folded, lowercased, without Latin accents. */
export function indexedWord(word: string): string {
  return foldForSearch(word).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
