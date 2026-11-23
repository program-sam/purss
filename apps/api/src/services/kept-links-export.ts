import { escapeHtml } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { displayAuthor, displayTitle } from "./content.ts";
import { itemLinkIsMedia } from "./media.ts";
import { server } from "@purss/translations/server";

/*
 * A readable list of what the person has kept, to read, print or keep beside the machine-readable export:
 * every basket, and under it each kept item with its title as a link to the original, where it came from,
 * when it was published and when it was kept. It says plainly that the links go to places that may change.
 */

export type KeptListFormat = "html" | "md";

type BasketRow = { id: string; name: string };
type KeptRow = { item_id: string; title: string; url: string | null; author: string | null; source_title: string | null; source_kind: string | null; published_at: string | null; kept_at: string; is_private: number | null; enclosures: string | null };

const PAGE = 500;
const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
/** The address in its canonical form (spaces encoded), or null when it is not a web address. */
function webAddress(url: string | null): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try { return new URL(url).href; } catch { return null; }
}

function details(r: KeptRow): string[] {
  const author = displayAuthor(r.author);
  const from = r.source_kind === "manual" ? author : [r.source_title, author].filter((x, i, all) => x && all.indexOf(x) === i).join(", ");
  const published = day(r.published_at);
  const kept = day(r.kept_at);
  return [from || null, published ? server.api.keptLinksExport.published(published) : null, kept ? server.api.keptLinksExport.kept(kept) : null].filter((x): x is string => !!x);
}

const NOTE = server.api.keptLinksExport.note;

function md(text: string): string {
  return text.replace(/[\\`*_{}[\]<>()#+!|]/g, "\\$&").replace(/\s+/g, " ").trim();
}

const HTML_HEAD = (today: string) =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${server.api.keptLinksExport.title(today)}</title>\n`
  + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ccc}`
  + `li{margin:.5rem 0}.meta{color:#555;font-size:.9rem}.note{color:#555}@media print{a{color:inherit}}</style></head><body>\n<h1>${server.api.keptLinksExport.heading}</h1>\n`
  + `<p class="note">${server.api.keptLinksExport.exported(today)} ${escapeHtml(NOTE)}</p>\n`;

function line(format: KeptListFormat, r: KeptRow): string {
  const title = displayTitle(r.title);
  // The list is meant to be handed on: a private source's file address (which can carry its secret) is left out, as in the app.
  const link = r.is_private === 1 && itemLinkIsMedia(r.url, r.enclosures) ? null : webAddress(r.url);
  const meta = details(r);
  if (format === "html") {
    return `<li>${link ? `<a dir="auto" href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(title)}</a>` : `<span dir="auto">${escapeHtml(title)}</span>`}`
      + `${meta.length ? ` <span class="meta" dir="auto">${escapeHtml(meta.join(" · "))}</span>` : ""}</li>\n`;
  }
  return `- ${link ? `[${md(title)}](${link.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : md(title)}${meta.length ? ` — ${md(meta.join(", "))}` : ""}\n`;
}

/** The list in pieces, a basket at a time in pages, so a large collection is never held in memory whole. */
export function* keptLinksChunks(app: App, p: Principal, format: KeptListFormat, now = new Date(), page = PAGE): Generator<string> {
  const today = now.toISOString().slice(0, 10);
  yield format === "html" ? HTML_HEAD(today) : `# ${server.api.keptLinksExport.heading}\n\n${server.api.keptLinksExport.exported(today)} ${NOTE}\n`;
  for (const b of app.db.all<BasketRow>("SELECT id, name FROM baskets WHERE account_id = ? ORDER BY position, created_at", p.accountId)) {
    yield format === "html" ? `<h2 dir="auto">${escapeHtml(b.name)}</h2>\n` : `\n## ${md(b.name)}\n\n`;
    let cursor: [string, string] | null = null;
    let any = false;
    for (;;) {
      const rows: KeptRow[] = app.db.all<KeptRow>(
        `SELECT bi.item_id, i.title, i.url, i.author, s.title AS source_title, s.kind AS source_kind, i.published_at, bi.kept_at, s.is_private, i.enclosures
           FROM basket_items bi JOIN items i ON i.id = bi.item_id LEFT JOIN sources s ON s.id = i.source_id
          WHERE bi.basket_id = ? AND bi.account_id = ? ${cursor ? "AND (bi.kept_at < ? OR (bi.kept_at = ? AND bi.item_id < ?))" : ""}
          ORDER BY bi.kept_at DESC, bi.item_id DESC LIMIT ?`,
        ...(cursor ? [b.id, p.accountId, cursor[0], cursor[0], cursor[1], page] : [b.id, p.accountId, page]));
      if (rows.length && !any && format === "html") yield "<ul>\n";
      if (rows.length) yield rows.map((r) => line(format, r)).join("");
      any ||= rows.length > 0;
      if (rows.length < page) break;
      const last = rows[rows.length - 1]!;
      cursor = [last.kept_at, last.item_id];
    }
    if (!any) yield format === "html" ? server.api.keptLinksExport.nothingKeptHtml : server.api.keptLinksExport.nothingKeptMarkdown;
    else if (format === "html") yield "</ul>\n";
  }
  if (format === "html") yield "</body></html>\n";
}
