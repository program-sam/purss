import type { OpmlFeed, ParsedOpml, OpmlPreviewEntry, OpmlPreview } from "@purss/domain";
export type { OpmlFeed, ParsedOpml, OpmlPreviewEntry, OpmlPreview };
import { Parser } from "htmlparser2";
import { assertShallowMarkup, looksPrivateUrl, parseBridgeDescriptor, TooComplexError } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { badRequest, nowIso } from "../http.ts";
import { canonicalFeedKey, privateFeedKey } from "./feed-keys.ts";
import { escapeXml, hasCredentialShape, httpUrlOrNull, plainText } from "./text-safety.ts";

export { canonicalFeedKey };

/*
 * OPML carries subscriptions only (plan/07). Export lists public, followed sources built from
 * validated database fields; private sources and anything credential-shaped are left out.
 * The parsed list goes back to the browser as a preview; the feeds the person chooses are followed on the server
 * (opml-import.ts) through the normal discovery and follow, so no OPML is ever sent to the engine.
 */

export const OPML_MAX_BYTES = 2 * 1024 * 1024;
export const OPML_MAX_FEEDS = 5000;
const MAX_DEPTH = 16;

/** Parse an OPML document with a bounded XML parser. Entities beyond the standard five are never expanded. */
export function parseOpml(text: string): ParsedOpml {
  if (Buffer.byteLength(text, "utf8") > OPML_MAX_BYTES) throw badRequest("That file is too large to be a subscription list.", "too_large");
  const feeds: OpmlFeed[] = [];
  const skipped = { notWebAddress: 0, duplicates: 0 };
  const seen = new Set<string>();
  const folders: (string | null)[] = []; // one entry per open outline
  let sawRoot = false;
  let depth = 0;
  let truncated = false;
  let tooDeep = false;

  try {
    // Any element, not only outlines, could nest deep enough to stall the parser.
    assertShallowMarkup(text, "xml", { depth: MAX_DEPTH + 8 });
  } catch (err) {
    if (err instanceof TooComplexError) throw badRequest("That subscription list is nested too deeply to read safely.", "too_deep");
    throw err;
  }
  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = name.toLowerCase();
      if (!sawRoot) {
        if (tag !== "opml") { sawRoot = false; throw new Error("not-opml"); }
        sawRoot = true;
        return;
      }
      if (tag !== "outline") return;
      depth++;
      if (depth > MAX_DEPTH) { tooDeep = true; folders.push(null); return; }
      const a: Record<string, string> = {};
      for (const [k, v] of Object.entries(attribs)) a[k.toLowerCase()] = v;
      const label = plainText(a.text || a.title, 200);
      const xmlUrl = a.xmlurl;
      if (xmlUrl === undefined) { folders.push(label || null); return; } // a folder (or an outline we ignore)
      folders.push(null);
      if (truncated) return;
      const feedUrl = httpUrlOrNull(xmlUrl);
      if (!feedUrl) { skipped.notWebAddress++; return; }
      const key = canonicalFeedKey(feedUrl);
      if (seen.has(key)) { skipped.duplicates++; return; }
      if (feeds.length >= OPML_MAX_FEEDS) { truncated = true; return; }
      seen.add(key);
      const folder = [...folders.slice(0, -1)].reverse().find((f) => f) ?? null;
      feeds.push({ title: label || new URL(feedUrl).hostname, feedUrl, siteUrl: httpUrlOrNull(a.htmlurl), folder });
    },
    onclosetag(name) {
      if (name.toLowerCase() === "outline" && sawRoot) { folders.pop(); depth--; }
    },
  }, { xmlMode: true, decodeEntities: true });

  try {
    parser.write(text);
    parser.end();
  } catch {
    throw badRequest("That file doesn't look like an OPML subscription list.", "not_opml");
  }
  if (!sawRoot) throw badRequest("That file doesn't look like an OPML subscription list.", "not_opml");
  if (tooDeep) throw badRequest("That subscription list is nested too deeply to read safely.", "too_deep");
  return { feeds, skipped, truncated };
}

/**
 * Does a feed address carry a secret? The same judgement discovery makes when the feed is looked up (a key in the path
 * or a long random value as well as a username or a key in the query), so that a list entry is private exactly when
 * following it would make the source private, and the address is kept out of the database before it is looked at.
 */
export function looksPrivateFeed(raw: string): boolean {
  return hasCredentialShape(raw) || looksPrivateUrl(raw);
}

export function previewOpml(app: App, p: Principal, text: string): OpmlPreview {
  const parsed = parseOpml(text);
  const followed = new Map<string, string>();
  for (const s of app.db.all<{ id: string; feed_url: string }>("SELECT id, feed_url FROM sources WHERE workspace_id = ? AND followed = 1 AND feed_url IS NOT NULL", p.workspaceId)) {
    // A bridged source is listed by its page, as the export writes it.
    const bridged = parseBridgeDescriptor(s.feed_url);
    const href = bridged ? bridged.service.pageUrl(bridged.key) : httpUrlOrNull(s.feed_url);
    if (href) followed.set(canonicalFeedKey(href), s.id);
  }
  // A private source has no address to compare: its keyed hash is compared with the listed address's.
  const privateOnes = new Map<string, string>();
  for (const s of app.db.all<{ id: string; feed_key: string }>("SELECT id, feed_key FROM sources WHERE workspace_id = ? AND followed = 1 AND feed_key IS NOT NULL", p.workspaceId)) privateOnes.set(s.feed_key, s.id);
  return {
    feeds: parsed.feeds.map((f) => {
      const key = privateOnes.size ? privateFeedKey(app, p.workspaceId, f.feedUrl) : null;
      const sourceId = followed.get(canonicalFeedKey(f.feedUrl)) ?? (key ? privateOnes.get(key) : undefined) ?? null;
      return { ...f, alreadyFollowing: sourceId !== null, sourceId, looksPrivate: looksPrivateFeed(f.feedUrl) };
    }),
    skipped: parsed.skipped,
    truncated: parsed.truncated,
  };
}

/** OPML 2.0 of the public, followed sources, grouped by their first collection. */
export function generateOpml(app: App, p: Principal): { xml: string; included: number; leftOut: number } {
  const rows = app.db.all<{ id: string; title: string; kind: string; site_url: string | null; feed_url: string | null; is_private: number; collection_name: string | null }>(
    `SELECT s.id, s.title, s.kind, s.site_url, s.feed_url, s.is_private,
       (SELECT c.name FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id
        WHERE cs.source_id = s.id ORDER BY c.position, c.created_at LIMIT 1) AS collection_name
     FROM sources s WHERE s.workspace_id = ? AND s.followed = 1 AND s.kind <> 'manual' ORDER BY lower(s.title)`, p.workspaceId);
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  let included = 0;
  let leftOut = 0;
  for (const s of rows) {
    // A bridged source has no public feed address; its page re-imports here (discovery finds the source again).
    const bridged = s.feed_url ? parseBridgeDescriptor(s.feed_url) : null;
    const href = s.is_private ? null : bridged ? bridged.service.pageUrl(bridged.key) : httpUrlOrNull(s.feed_url);
    if (!href || hasCredentialShape(href)) { leftOut++; continue; }
    const attrs = [`type="rss"`, `text="${escapeXml(s.title)}"`, `title="${escapeXml(s.title)}"`, `xmlUrl="${escapeXml(href)}"`];
    const site = httpUrlOrNull(s.site_url);
    if (site) attrs.push(`htmlUrl="${escapeXml(site)}"`);
    const line = `<outline ${attrs.join(" ")}/>`;
    included++;
    if (s.collection_name) groups.set(s.collection_name, [...(groups.get(s.collection_name) ?? []), line]);
    else loose.push(line);
  }
  const body = [
    ...[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, lines]) => `    <outline text="${escapeXml(name)}" title="${escapeXml(name)}">\n${lines.map((l) => `      ${l}`).join("\n")}\n    </outline>`),
    ...loose.map((l) => `    ${l}`),
  ].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Followed sources</title>
    <dateCreated>${new Date(nowIso()).toUTCString()}</dateCreated>
  </head>
  <body>
${body}
  </body>
</opml>
`;
  return { xml, included, leftOut };
}
