import { decodeBody } from "./content-type.ts";
import { isForbiddenLiteralHost } from "./addresses.ts";
import { looksPrivateUrl, privateUrlReason } from "./privacy.ts";
import { parseTarget } from "./safe-fetch.ts";
import { assertShallowMarkup, escapeXml, parseXml, plainLine, TooComplexError } from "./text.ts";
import type { XNode } from "./text.ts";

/*
 * OPML import and export. Export writes validated product fields only (never raw
 * stored text) and leaves out private and credential-bearing sources. Import is for
 * user-uploaded files: bounded, parsed without entity expansion, and returned as an
 * outline list for the person to preview. The raw upload is never forwarded.
 */

export type OpmlSubscription = {
  title: string;
  feedUrl: string;
  siteUrl?: string | null;
  /** Collection/folder name, or null for none. */
  folder?: string | null;
  /** The owner marked this source private: it is never written to OPML. */
  private?: boolean;
};

export type OpmlExport = {
  xml: string;
  included: number;
  omitted: { title: string; reason: "private" | "invalid" }[];
};

const MAX_EXPORT = 10_000;

function cleanUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = parseTarget(value.trim());
  return t.ok ? t.url.href : null;
}

export function generateOpml(subscriptions: readonly OpmlSubscription[], opts: { title?: string; now?: Date } = {}): OpmlExport {
  const omitted: OpmlExport["omitted"] = [];
  const groups = new Map<string, string[]>();
  let included = 0;
  for (const sub of subscriptions.slice(0, MAX_EXPORT)) {
    const label = plainLine(sub.title, 200) ?? "Untitled source";
    const feedUrl = cleanUrl(sub.feedUrl);
    if (!feedUrl) {
      omitted.push({ title: label, reason: "invalid" });
      continue;
    }
    // Native capability/secret-link URLs count as credentials (plan/20): never exported.
    if (sub.private || looksPrivateUrl(feedUrl)) {
      omitted.push({ title: label, reason: "private" });
      continue;
    }
    const siteUrl = cleanUrl(sub.siteUrl);
    const folder = plainLine(sub.folder ?? "", 80) ?? "";
    const attrs = `type="rss" text="${escapeXml(label)}" title="${escapeXml(label)}" xmlUrl="${escapeXml(feedUrl)}"${siteUrl ? ` htmlUrl="${escapeXml(siteUrl)}"` : ""}`;
    const list = groups.get(folder) ?? [];
    list.push(`<outline ${attrs}/>`);
    groups.set(folder, list);
    included++;
  }
  const lines: string[] = [];
  for (const [folder, outlines] of groups) {
    if (folder) lines.push(`    <outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">`, ...outlines.map((o) => `      ${o}`), "    </outline>");
    else lines.push(...outlines.map((o) => `    ${o}`));
  }
  const title = escapeXml(plainLine(opts.title ?? "Subscriptions", 120) ?? "Subscriptions");
  const created = (opts.now ?? new Date()).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${title}</title>\n    <dateCreated>${created}</dateCreated>\n  </head>\n  <body>\n${lines.join("\n")}${lines.length ? "\n" : ""}  </body>\n</opml>\n`;
  return { xml, included, omitted };
}

export type OpmlOutline = {
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  /** Folder path, "Parent / Child", or null at top level. */
  folder: string | null;
  /** The address looks like it carries a private key; the preview should say so. */
  looksPrivate: boolean;
};

export type OpmlSkipReason = "not-a-web-address" | "has-login" | "internal-address" | "duplicate";
export type OpmlParse =
  | { ok: true; title: string | null; outlines: OpmlOutline[]; skipped: { reason: OpmlSkipReason; count: number }[]; truncated: boolean }
  | { ok: false; reason: "toolarge" | "invalid" | "empty"; message: string };

export const OPML_MAX_BYTES = 2 * 1024 * 1024;
export const OPML_MAX_OUTLINES = 5000;
const OPML_MAX_DEPTH = 24;

function attr(node: XNode, ...names: string[]): string | null {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(node.attribs ?? {})) if (wanted.includes(k.toLowerCase())) return v;
  return null;
}

export function parseOpml(input: string | Uint8Array): OpmlParse {
  if (typeof input !== "string" && input.length > OPML_MAX_BYTES) return { ok: false, reason: "toolarge", message: "That file is larger than the 2 MB we accept for an import." };
  const text = typeof input === "string" ? input : decodeBody(input, null);
  if (text.length > OPML_MAX_BYTES) return { ok: false, reason: "toolarge", message: "That file is larger than the 2 MB we accept for an import." };
  if (!text.trim()) return { ok: false, reason: "empty", message: "That file is empty." };
  let doc: XNode;
  try {
    assertShallowMarkup(text, "xml", { depth: OPML_MAX_DEPTH + 8 });
    doc = parseXml(text);
  } catch (error) {
    if (error instanceof TooComplexError) return { ok: false, reason: "invalid", message: "That file is nested too deeply to be a subscription list." };
    throw error;
  }
  const root = (doc.children ?? []).find((n) => n.type === "tag" && n.name?.toLowerCase() === "opml");
  if (!root) return { ok: false, reason: "invalid", message: "That file isn't an OPML subscription list." };
  const head = (root.children ?? []).find((n) => n.type === "tag" && n.name?.toLowerCase() === "head");
  const titleNode = (head?.children ?? []).find((n) => n.type === "tag" && n.name?.toLowerCase() === "title");
  const listTitle = plainLine((titleNode?.children ?? []).map((c) => c.data ?? "").join(""), 120);
  const body = (root.children ?? []).find((n) => n.type === "tag" && n.name?.toLowerCase() === "body");
  if (!body) return { ok: false, reason: "invalid", message: "That OPML file has no subscriptions in it." };

  const outlines: OpmlOutline[] = [];
  const skipped = new Map<OpmlSkipReason, number>();
  const seen = new Set<string>();
  let truncated = false;
  const skip = (reason: OpmlSkipReason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  type Frame = { node: XNode; path: string[]; depth: number };
  const stack: Frame[] = [];
  const pushChildren = (node: XNode, path: string[], depth: number) => {
    const kids = (node.children ?? []).filter((c) => c.type === "tag" && c.name?.toLowerCase() === "outline");
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, path, depth });
  };
  pushChildren(body, [], 0);
  while (stack.length) {
    const { node, path, depth } = stack.pop()!;
    const xmlUrl = attr(node, "xmlUrl", "xmlurl") ?? (attr(node, "type")?.toLowerCase() === "rss" ? attr(node, "url") : null);
    const label = plainLine(attr(node, "title") ?? attr(node, "text") ?? "", 200);
    if (xmlUrl) {
      if (outlines.length >= OPML_MAX_OUTLINES) {
        truncated = true;
        continue;
      }
      const parsedTarget = parseTarget(xmlUrl.trim());
      const target = parsedTarget.ok && isForbiddenLiteralHost(parsedTarget.url.hostname) ? ({ ok: false, reason: "blocked", message: "private address" } as const) : parsedTarget;
      if (!target.ok) {
        skip(target.reason === "blocked" ? "internal-address" : /username or password/.test(target.message) ? "has-login" : "not-a-web-address");
      } else {
        const key = target.url.href;
        if (seen.has(key)) skip("duplicate");
        else {
          seen.add(key);
          const site = cleanUrl(attr(node, "htmlUrl", "htmlurl"));
          outlines.push({
            title: label ?? target.url.hostname,
            feedUrl: key,
            siteUrl: site,
            folder: path.length ? path.join(" / ").slice(0, 120) : null,
            looksPrivate: privateUrlReason(key) !== null,
          });
        }
      }
    }
    if (depth < OPML_MAX_DEPTH) pushChildren(node, !xmlUrl && label ? [...path, label] : path, depth + 1);
  }
  if (outlines.length === 0 && skipped.size === 0) return { ok: false, reason: "empty", message: "That OPML file doesn't contain any feeds." };
  return { ok: true, title: listTitle, outlines, skipped: [...skipped].map(([reason, count]) => ({ reason, count })), truncated };
}
