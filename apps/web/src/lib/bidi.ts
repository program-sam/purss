/**
 * Titles, snippets and names come from feeds and from people, so any of them may be Arabic,
 * Hebrew or a mix of scripts. Elements that show them carry `dir="auto"` (the first strong letter
 * decides the direction) and are isolated by the stylesheet so neighbouring text keeps its place.
 * These helpers cover the places where text is joined into a plain string: a toast, a page title,
 * a spoken label.
 */
export type Direction = "ltr" | "rtl";

const RTL_LETTER = /^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]$/u;
const LETTER = /^\p{L}$/u;

const FSI = "⁨"; // first-strong isolate
const PDI = "⁩"; // pop directional isolate
/** Embeddings and overrides (U+202A-U+202E) and isolates (U+2066-U+2069) in text from outside. */
const CONTROLS = /[‪-‮⁦-⁩]/g;

/** The direction of the first strong letter, or null when the text has none (digits, punctuation). */
export function firstStrong(text: string): Direction | null {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return "rtl";
    if (LETTER.test(ch)) return "ltr";
  }
  return null;
}

/** Whether any letter of the text runs right to left. */
export function hasRtl(text: string): boolean {
  for (const ch of text) if (RTL_LETTER.test(ch)) return true;
  return false;
}

/**
 * Text safe to put inside a sentence: its own direction, separated from the words around it.
 * Directional controls that arrive with the text are removed, so a title cannot flip what follows it.
 */
export function isolate(text: string): string {
  const clean = text.replace(CONTROLS, "");
  return clean ? `${FSI}${clean}${PDI}` : clean;
}
