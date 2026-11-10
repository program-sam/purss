/*
 * Is a readable capture the page's text, or only part of it? Readability finds "the main block" of a page,
 * and on a page behind a wall that block is the wall itself; on a journal page it can be the reference list.
 * A capture that is one of these is kept, but it is not called the full text:
 *
 *  - gated:      a sign-in, subscription, cookie-consent or security-check notice, alone or nearly so;
 *  - references: a body that is mostly a list of references;
 *  - short:      shorter than the text the feed already gave for the same item.
 *
 * Pure text rules, no network, so the same answer comes whatever fetched the page.
 */

export type PartialReason = "gated" | "references" | "short";
export type CaptureAssessment = { full: true } | { full: false; reason: PartialReason };

/** A preview is short: a text this short that ends with, or has in a block of its own, a strong phrase is the wall. */
const GATED_SHORT_CHARS = 1500;
/** "Ends with": the phrase ends within this many characters of the end. */
const GATED_ENDING_CHARS = 200;
/** "A block of its own": a block no longer than this. */
const GATED_OWN_BLOCK_CHARS = 200;
/** Past this length a wall must make up a share of the text, in short blocks. */
const GATED_LONG_CHARS = 3000;
const GATED_BLOCK_CHARS = 500;
const GATED_SHARE = 0.35;
/** A consent page: this many phrases, at this rate for every 1,000 characters. */
const GATED_DENSE_PHRASES = 3;
const GATED_DENSE_RATE = 1.5;
/** References: at least this many paragraphs, and this share of the text. */
const REFERENCES_MIN = 5;
const REFERENCES_SHARE = 0.6;
/** Short: the feed gave at least this much text, and the capture is under this share of it. */
const FEED_MIN_CHARS = 200;
const FEED_SHARE = 0.6;

/**
 * What a wall says, in English, French, German, Spanish, Dutch and Italian. Strong phrases are specific to a wall ("subscribe to
 * continue reading", "pour accéder à l'intégralité", "verify you are a human"): "subscribe to our newsletter" and "log in to
 * comment" end ordinary articles and are not here. Weak phrases are the vocabulary of a consent page ("accept all cookies",
 * "cookie policy"), which an article about cookies uses too, so they count only together and thick on the ground.
 */
const STRONG_PHRASES: RegExp[] = [
  // English
  /\b(?:subscribe|sign[- ]?in|log[- ]?in|register|join|become a member)\b[^.\n]{0,40}\b(?:to|and) (?:continue|keep) reading\b/i,
  /\bto (?:continue|keep) reading\b/i,
  /\b(?:subscribe|sign[- ]?in|log[- ]?in|register|create (?:a free )?account)\b[^.\n]{0,40}\bto (?:read|view|access|unlock|see) (?:this|the|more|full|all|the rest|your)\b/i,
  /\b(?:for|to|only for|exclusive to|reserved for) (?:paying |paid )?(?:subscribers|members)(?: only)?\b/i,
  /\b(?:subscribers|members|subscription) only\b/i,
  /\b(?:you(?:'|’)ve|you have) (?:reached|read|used) (?:your|the) (?:free |monthly |article )*(?:limit|allowance|articles)/i,
  /\byou (?:need|have|must) (?:to )?(?:be|become) (?:a|an) [^.\n]{0,40}\b(?:member|subscriber)\b/i,
  /\bin order to (?:comment|read|view|access)[^.\n]{0,40}\byou need to be\b/i,
  /\balready (?:a|an) (?:subscriber|member)\?/i,
  /\b(?:membership|subscription) options\b/i,
  /\bunlock (?:this|the full|full) (?:article|story|content)\b/i,
  /\bthis (?:article|story|content|post) is (?:available )?(?:only )?(?:for|to) (?:subscribers|members|paying)/i,
  // security checks and scripts-required pages
  /\b(?:verify|confirm) (?:that )?you(?: are|(?:'|’)re) (?:a )?(?:human|not a robot)\b/i,
  /\bchecking (?:your browser|if the site connection is secure)\b/i,
  /\b(?:please )?enable (?:javascript|cookies) (?:to|and|in)\b/i,
  /\baccess (?:to this page )?(?:has been )?denied\b/i,
  // French
  /\bpour accéder à l(?:'|’)intégralité\b/i,
  /\bréservé(?:e|s)? aux abonné(?:e)?s\b/i,
  /\babonnez-vous\b/i,
  /\b(?:déjà|deja) abonné/i,
  /\bvous n(?:'|’)avez pas encore de compte\b/i,
  /\b(?:identifiez|connectez)-vous pour (?:lire|accéder|continuer)\b/i,
  /\bcontinuer à lire\b/i,
  // German
  /\b(?:nur )?für (?:unsere )?(?:abonnenten|mitglieder)\b/i,
  /\bzum weiterlesen\b/i,
  /\bjetzt (?:abonnieren|anmelden|registrieren)\b/i,
  // Spanish
  /\bsolo para (?:suscriptores|socios|miembros)\b/i,
  /\b(?:suscr[ií]bete|inicia sesi[oó]n|reg[ií]strate) para (?:seguir leyendo|leer|acceder|continuar)\b/i,
  // Dutch
  /\balleen (?:voor|toegankelijk voor) (?:abonnees|leden)\b/i,
  /\b(?:log in|word abonnee|registreer) om (?:verder te lezen|te lezen|het volledige)\b/i,
  // Italian
  /\briservato (?:agli|ai) (?:abbonati|soci|iscritti)\b/i,
  /\b(?:abbonati|accedi|registrati) per (?:continuare a leggere|leggere|accedere)\b/i,
];
const WEAK_PHRASES: RegExp[] = [
  /\b(?:accept|reject|manage) (?:all )?(?:cookies|consent|tracking)\b/i,
  /\bwe (?:use|value|care about) (?:cookies|your privacy)\b/i,
  /\bcookie (?:settings|preferences|policy|notice|banner)\b/i,
  /\b(?:accepter|refuser|gérer) (?:tous )?(?:les |mes |vos )?(?:cookies|préférences|choix)\b/i,
  /\b(?:cookies?|alle cookies) (?:akzeptieren|ablehnen)\b/i,
  /\baceptar (?:todas las )?cookies\b/i,
  /\b(?:accepteer|weiger) (?:alle )?cookies\b/i,
  /\baccetta (?:tutti i )?cookie\b/i,
];

/** Where a set of phrases occurs in the text, as spans: overlapping matches (one sentence several patterns fit) are one. */
function spansOf(text: string, phrases: RegExp[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const re of phrases) for (const m of text.matchAll(new RegExp(re.source, "gi"))) found.push({ start: m.index!, end: m.index! + m[0].length });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const f of found) {
    const last = merged.at(-1);
    if (last && f.start < last.end) last.end = Math.max(last.end, f.end);
    else merged.push({ ...f });
  }
  return merged;
}

/** Paragraphs of a captured text (it keeps a blank line between blocks). */
const paragraphs = (text: string): string[] => text.split(/\n+/).map((p) => p.trim()).filter(Boolean);

/**
 * Whether the text is a wall, from the phrases it holds over the whole text, not block by block (a call to subscribe often
 * shares a block with the lines before it):
 *  - a short text (a cut-off preview is short) that ends with a strong phrase, or holds a strong phrase in a short block of its own;
 *  - two different strong phrases (the wall says it more than once), in a text that isn't long;
 *  - three or more phrases of either kind thick on the ground, which is a consent page; a piece about cookies mentions one or two,
 *    and a long explainer spreads three thin.
 * In a long text the short blocks that hold phrases must be a good share of it.
 */
function gated(text: string): boolean {
  const strong = spansOf(text, STRONG_PHRASES);
  const weak = spansOf(text, WEAK_PHRASES);
  const found = strong.length + weak.length;
  if (!found) return false;
  if (text.length > GATED_LONG_CHARS) return wallBlockShare(text) >= GATED_SHARE;
  if (strong.length >= 2) return true;
  if (text.length <= GATED_SHORT_CHARS) {
    if (strong.length && strong.at(-1)!.end >= text.length - GATED_ENDING_CHARS) return true;
    if (strong.length && paragraphs(text).some((p) => p.length <= GATED_OWN_BLOCK_CHARS && spansOf(p, STRONG_PHRASES).length)) return true;
  }
  return found >= GATED_DENSE_PHRASES && (found / text.length) * 1000 >= GATED_DENSE_RATE;
}

/** The share of a long text that sits in short blocks that hold a strong phrase, or several of any kind. */
function wallBlockShare(text: string): number {
  let chars = 0;
  for (const p of paragraphs(text)) {
    if (p.length <= GATED_BLOCK_CHARS && (spansOf(p, STRONG_PHRASES).length || spansOf(p, [...STRONG_PHRASES, ...WEAK_PHRASES]).length >= 2)) chars += p.length;
  }
  return chars / Math.max(1, text.length);
}

const YEAR = /\b(?:1[5-9]|20)\d{2}[a-z]?\b/;
const DOI = /\bdoi(?::|\.org\/)|\b10\.\d{4,9}\/\S/i;
/** Shapes a reference has and running text rarely has twice in one paragraph. */
const CITATION_SHAPES: RegExp[] = [
  /\bet al\.?[,:]?\s/i,
  /\b(?:pp?|vol|no)\.\s?\d/i,
  /\b\d{1,4}\s?[(:,]\s?\d{1,4}\)?\s?[:,]?\s?\d{1,5}\s?[–-]\s?\d{1,5}\b/,
  /\b\d{1,5}\s?[–-]\s?\d{1,5}\b[^.]{0,3}$/,
  /\b[A-ZÀ-Ý][\p{L}'’-]+,\s(?:[A-Z]\.[-\s]?){1,3}(?:,|\sand\s|\s&\s|:)/u,
  /\b(?:in|in:)\s[A-Z][^.]{3,80}(?:ed\.|eds\.|edited by)/,
  /\barXiv:\s?\d{4}\./i,
  /\bhttps?:\/\/\S+$/,
];

/** One paragraph that is a reference: a year, and a DOI or another shape of citation, and not long. */
function isReference(paragraph: string): boolean {
  if (paragraph.length > 900 || !YEAR.test(paragraph)) return false;
  return DOI.test(paragraph) || CITATION_SHAPES.filter((re) => re.test(paragraph)).length >= 2;
}

function mostlyReferences(text: string): boolean {
  const parts = paragraphs(text);
  let n = 0;
  let chars = 0;
  for (const p of parts) if (isReference(p)) { n++; chars += p.length; }
  return n >= REFERENCES_MIN && chars / Math.max(1, text.length) >= REFERENCES_SHARE;
}

/**
 * Check a readable capture against what is known of the item. `feedTextLength` is the length of the plain text the feed
 * itself gave for the item (0 when it gave none). Returns the first reason it is only part of the page.
 */
export function assessCapture(capture: { text: string; feedTextLength: number }): CaptureAssessment {
  if (gated(capture.text)) return { full: false, reason: "gated" };
  if (mostlyReferences(capture.text)) return { full: false, reason: "references" };
  if (capture.feedTextLength >= FEED_MIN_CHARS && capture.text.length < capture.feedTextLength * FEED_SHARE) return { full: false, reason: "short" };
  return { full: true };
}

/** What the reader says when a capture is only part of the page. */
export function partialReasonText(reason: PartialReason): string {
  switch (reason) {
    case "gated": return "Only part of the page could be saved: it looks like a sign-in, subscription or consent page.";
    case "references": return "Only part of the page could be saved: what was captured is mostly a list of references.";
    case "short": return "Only part of the page could be saved: what was captured is shorter than the text the feed already gave.";
  }
}
