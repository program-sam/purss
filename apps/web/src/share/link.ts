import type { SharedContent } from "../platform/types.ts";

/**
 * The link in what another app shared. Apps share a bare address, or a sentence with the address in it
 * ("Look at this https://…"), sometimes with the page title as the subject or the first line.
 */
export function linkFromShare(shared: SharedContent): { url: string; title: string } | null {
  for (const text of shared.texts) {
    const m = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text);
    if (!m) continue;
    // Sentence punctuation after an address isn't part of it; a closing bracket is only when it has its opening one.
    let url = m[0].replace(/[.,;:!?]+$/, "");
    const count = (c: string) => url.split(c).length - 1;
    while (url.endsWith(")") && count(")") > count("(")) url = url.slice(0, -1).replace(/[.,;:!?]+$/, "");
    try { new URL(url); } catch { continue; }
    const rest = text.replace(m[0], " ").replace(/\s+/g, " ").trim();
    const title = (shared.title.trim() || rest).slice(0, 300);
    return { url, title };
  }
  return null;
}
