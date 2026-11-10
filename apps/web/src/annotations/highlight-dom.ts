import type { TextPosition, TextQuote } from "@purss/domain";
import { coverPieces, describe, indexSegments, locate, toNormalized } from "./anchor.ts";
import type { Segment } from "./anchor.ts";

/**
 * The DOM side of highlights: reading the article's text the way anchor.ts expects, drawing
 * highlights into the article HTML, and turning the reader's selection into a passage.
 */

const BLOCKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD",
  "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** Text nodes and block boundaries under `root`, in document order. */
export function collectText(root: Node): { segments: Segment[]; nodes: (Text | null)[] } {
  const segments: Segment[] = [];
  const nodes: (Text | null)[] = [];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) { segments.push((child as Text).data); nodes.push(child as Text); continue; }
      if (child.nodeType !== 1) continue;
      const block = BLOCKS.has((child as Element).tagName);
      if (block) { segments.push(null); nodes.push(null); }
      walk(child);
      if (block) { segments.push(null); nodes.push(null); }
    }
  };
  walk(root);
  return { segments, nodes };
}

export type HighlightInput = { id: string; quote: TextQuote; position: TextPosition | null; label: string };
export type Rendered = { html: string; placed: Set<string>; detached: Set<string> };

/**
 * Draw highlights into prepared article HTML. Each highlight is found by its passage (anchor.ts); one
 * that can't be found is reported as detached and drawn nowhere. Overlaps share <mark> pieces whose
 * `data-anno` lists every highlight covering them, newest last. The first piece of each highlight can
 * be focused and pressed to edit it.
 */
export function renderHighlights(html: string, highlights: readonly HighlightInput[]): Rendered {
  const placed = new Set<string>();
  const detached = new Set<string>();
  if (!highlights.length) return { html, placed, detached };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const { segments, nodes } = collectText(doc.body);
  const index = indexSegments(segments);
  const found: { id: string; pos: TextPosition }[] = [];
  const labels = new Map<string, string>();
  for (const h of highlights) {
    const pos = locate(index.text, h.quote, h.position);
    if (pos) { found.push({ id: h.id, pos }); placed.add(h.id); labels.set(h.id, h.label); } else detached.add(h.id);
  }
  const started = new Set<string>();
  for (const [s, pieces] of coverPieces(index, segments, found)) {
    const node = nodes[s]!;
    const data = node.data;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const piece of pieces) {
      if (piece.start > at) frag.append(doc.createTextNode(data.slice(at, piece.start)));
      const mark = doc.createElement("mark");
      mark.className = "anno";
      mark.setAttribute("data-anno", piece.ids.join(" "));
      const first = piece.ids.filter((id) => !started.has(id));
      if (first.length) {
        first.forEach((id) => started.add(id));
        const id = first[first.length - 1]!;
        mark.setAttribute("data-anno-start", id);
        mark.setAttribute("tabindex", "0");
        mark.setAttribute("role", "button");
        mark.setAttribute("aria-label", labels.get(id)!);
      }
      mark.textContent = data.slice(piece.start, piece.end);
      frag.append(mark);
      at = piece.end;
    }
    if (at < data.length) frag.append(doc.createTextNode(data.slice(at)));
    node.replaceWith(frag);
  }
  return { html: doc.body.innerHTML, placed, detached };
}

/** Length of the text from the start of `root` to a point (the raw offset anchor.ts works in). */
function rawOffsetTo(root: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(container, offset);
  return r.toString().length;
}

export type SelectedPassage = { quote: TextQuote; position: TextPosition; rect: DOMRect };

/**
 * The reader's current selection inside `root` as a passage of its normalised text, or null when
 * nothing (or only white space) is selected there. A selection reaching outside is cut to `root`.
 */
export function selectedPassage(root: HTMLElement): SelectedPassage | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!range.intersectsNode(root)) return null;
  const total = root.textContent?.length ?? 0;
  const rawStart = root.contains(range.startContainer) ? rawOffsetTo(root, range.startContainer, range.startOffset) : 0;
  const rawEnd = root.contains(range.endContainer) ? rawOffsetTo(root, range.endContainer, range.endOffset) : total;
  const { segments } = collectText(root);
  const index = indexSegments(segments);
  const pos = toNormalized(index, rawStart, rawEnd);
  if (!pos) return null;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
  return { ...describe(index.text, pos), rect };
}
