import { toText } from "./content.ts";

/** An excerpt that ends the way publishers cut one ("…", "Read more", "The post … appeared first on …"). Kept in step with the feed check in packages/connectors/src/feed.ts. */
const EXCERPT_END = /(?:…|\[\s*…\s*\]|\[\s*\.{3}\s*\]|\.{3}|read more\.?|continue reading\.?|read the rest\.?|\(more…\)|the post .+ appeared first on .+)\s*$/i;

/** Below this many characters of text, what a feed sends is a teaser rather than the article (the same limit the Add source preview uses). */
export const TEASER_CHARS = 800;

/**
 * Whether the text an item shows is only a summary of an article that lives on the original site: it is short, or it
 * is cut off the way publishers cut an excerpt. Takes the HTML the reader would show; nothing at all is not a summary.
 */
export function looksLikeSummary(html: string | null | undefined): boolean {
  const text = toText(html);
  return text.length > 0 && (text.length < TEASER_CHARS || EXCERPT_END.test(text));
}
