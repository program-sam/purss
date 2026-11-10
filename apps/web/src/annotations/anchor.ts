import type { TextPosition, TextQuote } from "@purss/domain";

/**
 * Anchoring highlights in the reader's text (plan/26). Pure, so it is testable without a DOM.
 *
 * The reader's text is the article's text nodes in order, with every run of white space (and every
 * block boundary, such as between paragraphs) collapsed to one space and the ends trimmed. A
 * highlight stores the passage it marked with some text before and after it (a text-quote selector)
 * and where it started and ended in that text (a position hint). When the text changes, a highlight
 * is found again by its passage; prefix and suffix decide between repeats, then nearness to the hint.
 * A passage that is no longer in the text is "detached": the highlight is kept and listed with its quote.
 */

/** Text kept on each side of a passage. */
export const CONTEXT_CHARS = 32;
/** Repeats of a passage examined before giving up on telling them apart. */
const MAX_CANDIDATES = 1000;

/** A text node's content, or null for a block boundary. */
export type Segment = string | null;

export type TextIndex = {
  /** The normalised text. */
  text: string;
  /** For each character of `text`, its offset in the raw text (the segments' text concatenated). */
  raw: Int32Array;
  /** Where each segment starts in the raw text (block boundaries take no room). */
  segStart: Int32Array;
};

const isSpace = (ch: string) => /\s/.test(ch);

/** Build the normalised text and its mapping back to the raw text. */
export function indexSegments(segments: readonly Segment[]): TextIndex {
  const chars: string[] = [];
  const raw: number[] = [];
  const segStart = new Int32Array(segments.length);
  let pos = 0;
  let pendingSpace = -1; // raw offset of a space waiting to be written, -1 when none
  for (let s = 0; s < segments.length; s++) {
    segStart[s] = pos;
    const seg = segments[s] ?? null;
    if (seg === null) {
      if (pendingSpace < 0) pendingSpace = pos;
      continue;
    }
    for (let i = 0; i < seg.length; i++, pos++) {
      const ch = seg[i]!;
      if (isSpace(ch)) {
        if (pendingSpace < 0) pendingSpace = pos;
        continue;
      }
      if (pendingSpace >= 0 && chars.length > 0) { chars.push(" "); raw.push(pendingSpace); }
      pendingSpace = -1;
      chars.push(ch);
      raw.push(pos);
    }
  }
  return { text: chars.join(""), raw: Int32Array.from(raw), segStart };
}

/** Collapse white space the same way, for passages that came from elsewhere (an import, an older text). */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** First normalised index whose raw offset is at or after `rawOffset` (text.length when none). */
function firstAtOrAfter(index: TextIndex, rawOffset: number): number {
  let lo = 0, hi = index.raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.raw[mid]! < rawOffset) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Raw offset of a point in segment `seg` at `offset`. */
export function rawOffsetOf(index: TextIndex, seg: number, offset: number): number {
  return index.segStart[seg]! + offset;
}

/** A raw range (start inclusive, end exclusive) as a normalised range, or null when it holds no text. */
export function toNormalized(index: TextIndex, rawStart: number, rawEnd: number): TextPosition | null {
  let start = firstAtOrAfter(index, rawStart);
  let end = firstAtOrAfter(index, rawEnd);
  while (start < end && index.text[start] === " ") start++;
  while (end > start && index.text[end - 1] === " ") end--;
  return end > start ? { start, end } : null;
}

/** A normalised range as a raw range (end exclusive). */
export function toRaw(index: TextIndex, pos: TextPosition): { start: number; end: number } {
  return { start: index.raw[pos.start]!, end: index.raw[pos.end - 1]! + 1 };
}

/**
 * Which segment holds a raw offset, and where in it. A start point belongs to the segment that
 * begins there; an end point to the segment that ends there (so a range never ends at offset 0 of
 * the next text node).
 */
export function segmentAt(index: TextIndex, rawOffset: number, side: "start" | "end" = "start"): { seg: number; offset: number } {
  let lo = 0, hi = index.segStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = index.segStart[mid]!;
    if (side === "start" ? s <= rawOffset : s < rawOffset) lo = mid; else hi = mid - 1;
  }
  return { seg: lo, offset: rawOffset - index.segStart[lo]! };
}

/** The selector for a passage of the normalised text. */
export function describe(text: string, pos: TextPosition): { quote: TextQuote; position: TextPosition } {
  return {
    quote: {
      exact: text.slice(pos.start, pos.end),
      prefix: text.slice(Math.max(0, pos.start - CONTEXT_CHARS), pos.start),
      suffix: text.slice(pos.end, pos.end + CONTEXT_CHARS),
    },
    position: pos,
  };
}

/** How many characters of `a`'s end agree with `b`'s end. */
function commonEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Find a passage in the normalised text: at its position hint when the text there still matches,
 * otherwise the occurrence whose surroundings agree best with the stored context, then the one
 * nearest the hint. Null when the passage isn't in the text (the highlight is detached).
 */
export function locate(text: string, quote: TextQuote, hint: TextPosition | null): TextPosition | null {
  const exact = normalizeText(quote.exact);
  if (!exact) return null;
  const prefix = quote.prefix.replace(/\s+/g, " ");
  const suffix = quote.suffix.replace(/\s+/g, " ");
  if (hint && text.startsWith(exact, hint.start) && text.slice(0, hint.start).endsWith(prefix) && text.startsWith(suffix, hint.start + exact.length)) {
    return { start: hint.start, end: hint.start + exact.length };
  }
  let best: { start: number; score: number; distance: number } | null = null;
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const at = text.indexOf(exact, from);
    if (at < 0) break;
    const score = commonEnd(text.slice(Math.max(0, at - prefix.length), at), prefix) + commonStart(text.slice(at + exact.length, at + exact.length + suffix.length), suffix);
    const distance = hint ? Math.abs(at - hint.start) : at;
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { start: at, score, distance };
    from = at + 1;
  }
  return best ? { start: best.start, end: best.start + exact.length } : null;
}

/** A piece of one text segment and the highlights that cover it, in the order they were given. */
export type Piece = { start: number; end: number; ids: string[] };

/**
 * Split each segment into pieces at every highlight boundary. Returns, per segment index, the pieces
 * covered by at least one highlight (segments with none are absent). Overlapping highlights share pieces.
 */
export function coverPieces(index: TextIndex, segments: readonly Segment[], placed: readonly { id: string; pos: TextPosition }[]): Map<number, Piece[]> {
  const ranges = placed.map((p) => ({ id: p.id, ...toRaw(index, p.pos) }));
  const out = new Map<number, Piece[]>();
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg) continue;
    const segFrom = index.segStart[s]!;
    const segTo = segFrom + seg.length;
    const hits = ranges.filter((r) => r.start < segTo && r.end > segFrom);
    if (!hits.length) continue;
    const cuts = new Set<number>([0, seg.length]);
    for (const r of hits) {
      cuts.add(Math.max(0, r.start - segFrom));
      cuts.add(Math.min(seg.length, r.end - segFrom));
    }
    const points = [...cuts].sort((a, b) => a - b);
    const pieces: Piece[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!, b = points[i + 1]!;
      const ids = hits.filter((r) => r.start - segFrom < b && r.end - segFrom > a).map((r) => r.id);
      if (ids.length && a < b) pieces.push({ start: a, end: b, ids });
    }
    if (pieces.length) out.set(s, pieces);
  }
  return out;
}
