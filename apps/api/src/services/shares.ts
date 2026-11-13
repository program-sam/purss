import { createHash, randomBytes } from "node:crypto";
import { REPORT_REASONS, REPORT_REASON_LABELS, checkQuery, newId, planShares } from "@purss/domain";
import type { PageItem, QueryNode, ReportReason, ShareDTO, ShareItemDTO, SharePreview, ShareReportDTO, ShareTarget, shareSettingsSchema } from "@purss/domain";
import type { z } from "zod";
import type { App, Principal } from "../app.ts";
import { audit, emit } from "../app.ts";
import { HttpError, addSeconds, badRequest, notFound, nowIso } from "../http.ts";
import { randomToken } from "../secrets.ts";
import { compileQuery } from "./items.ts";
import { planOf } from "./plans.ts";
import { PRODUCT_NAME, pageShell, productHome, publicLink } from "./public-pages.ts";
import { escapeHtml, escapeXml, plainText, uuidFrom } from "./text-safety.ts";
import type { SqlParam } from "../db/database.ts";

/*
 * Sharing (plan/19): a basket or a collection can be shared as a public page and an Atom feed of its own
 * items, live. Visitors see, per item, its title, original link, a short plain-text summary, source name
 * and date, plus the person's public note on it when they wrote one; never reading state, private notes
 * and highlights, saved text or anything else from the PURSS. Items from private sources and links
 * that carry a key never show. Filter collections whose rules use reading state can't be shared.
 *
 * On hosted installations sharing is part of Plus (administrators always); self-hosted ones always have it.
 * Anyone can report a public page; an administrator can take it down, which pauses it and keeps it from
 * being published again or removed until restored. The owner is told why.
 */

const PAGE_ITEMS = 200;
const FEED_ITEMS = 100;

export function shareStatement(listed: boolean): string {
  return "Sharing makes this page and its feed readable by anyone who has the link, with no sign-in, and it keeps showing what you add from now on. " +
    (listed ? "You chose to let search engines list it, so people can also find it by searching. " : "Search engines are asked not to index it, but that is a request, not access control. ") +
    "You can pause or stop sharing at any time, but copies that people or feed readers have already fetched, cached or kept can't be recalled.";
}
export const LISTING_STATEMENT = "Search engines may list this page from their next visit, so people can find it by searching. Turning it off later asks them to drop it, but they decide when.";
export const REVOCATION_NOTICE = "The page and feed no longer show. Copies that were already fetched, cached or kept by others can't be recalled.";
const TAKEN_DOWN_BLOCKER = "An administrator took this page down after a report, so it can't be shared again. The reason is shown above.";
const PLUS_ONLY = "Sharing a basket or collection as a public page is part of Plus.";

type ShareRow = {
  id: string; workspace_id: string; target_kind: ShareTarget; target_id: string; slug: string; curator_name: string; description: string | null;
  status: "draft" | "published" | "paused"; listed: number; taken_down_at: string | null; takedown_reason: string | null;
  created_at: string; published_at: string | null; updated_at: string;
};

/** This installation's page for following a feed: a button target for any site, and for shared pages. */
export const followUrl = (app: App, feed: string) => `${app.config.publicOrigin}/follow?url=${encodeURIComponent(feed)}`;
const urls = (app: App, slug: string) => {
  const feedUrl = `${app.config.publicOrigin}/p/${slug}/feed.atom`;
  return { publicUrl: `${app.config.publicOrigin}/p/${slug}`, feedUrl, followUrl: followUrl(app, feedUrl) };
};
const takenDown = (r: Pick<ShareRow, "taken_down_at" | "takedown_reason">) => (r.taken_down_at ? { at: r.taken_down_at, reason: r.takedown_reason ?? "" } : null);

const SLUG_LETTERS = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 letters that don't look alike: 5 bits each, no bias

/**
 * The page's address: the title, then 12 random letters (60 bits). Unlisted pages aren't access control,
 * but the address shouldn't be guessable either: at the public pages' rate limit nobody can walk 2^60.
 */
export function makeSlug(title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "shared";
  return `${base}-${[...randomBytes(12)].map((b) => SLUG_LETTERS[b % 32]).join("")}`;
}

// ---------- what may be shared

/** Filter rules that read the person's reading state; a collection that uses one can't be shared. */
const READING_STATE_FIELDS = new Set(["workflow", "fresh", "opened", "capture"]);
/** Filter rules that read the person's baskets: allowed, but the page then shows what they keep. */
const KEEPING_FIELDS = new Set(["basket", "kept"]);

function fields(node: QueryNode, out = new Set<string>()): Set<string> {
  if ("all" in node) node.all.forEach((n) => fields(n, out));
  else if ("any" in node) node.any.forEach((n) => fields(n, out));
  else if ("not" in node) fields(node.not, out);
  else out.add(node.field === "date" && node.which === "kept" ? "kept" : node.field);
  return out;
}

type Target = { kind: ShareTarget; id: string; name: string; workspaceId: string; mode: "basket" | "sources" | "query"; query: QueryNode | null };

function target(app: App, kind: ShareTarget, id: string, workspaceId: string): Target | null {
  if (kind === "basket") {
    const b = app.db.get<{ name: string }>("SELECT name FROM baskets WHERE id = ? AND workspace_id = ?", id, workspaceId);
    return b ? { kind, id, name: b.name, workspaceId, mode: "basket", query: null } : null;
  }
  const c = app.db.get<{ name: string; mode: string; query: string | null }>("SELECT name, mode, query FROM collections WHERE id = ? AND workspace_id = ?", id, workspaceId);
  if (!c) return null;
  if (c.mode === "sources") return { kind, id, name: c.name, workspaceId, mode: "sources", query: null };
  const q = checkQuery(JSON.parse(c.query ?? "null"));
  return { kind, id, name: c.name, workspaceId, mode: "query", query: q.ok ? q.query : null };
}

/** Why this target can't be shared right now, or null. */
function unshareable(t: Target): string | null {
  if (t.mode !== "query") return null;
  if (!t.query) return "This filter collection's rules can't be read, so it can't be shared.";
  for (const f of fields(t.query)) if (READING_STATE_FIELDS.has(f)) return "This filter collection uses your reading state (such as To read, New, opened or saved text), so sharing it would show what you read. Change its rules to share it.";
  return null;
}

/** On hosted installations sharing is part of Plus and Pro; administrators and self-hosted installations always have it. */
export function canShare(app: App, accountId: string): boolean {
  const plan = planOf(app, accountId);
  return plan === null || planShares(plan);
}

const accountOf = (app: App, workspaceId: string) => app.db.get<{ account_id: string }>("SELECT account_id FROM workspaces WHERE id = ?", workspaceId)!.account_id;

// ---------- the live projection

type Row = { id: string; title: string; url: string | null; excerpt: string | null; published_at: string | null; discovered_at: string; source_title: string | null; source_kind: string | null; note: string | null };

/** Exactly what visitors can see now, newest first; null when the target is gone or can no longer be shared. */
export function projection(app: App, share: Pick<ShareRow, "id" | "target_kind" | "target_id" | "workspace_id">, limit = PAGE_ITEMS): (PageItem & { itemId: string; ownLink: boolean })[] | null {
  const t = target(app, share.target_kind, share.target_id, share.workspace_id);
  if (!t || unshareable(t)) return null;
  const params: SqlParam[] = [share.id, share.workspace_id];
  let scope: string;
  let order = "COALESCE(i.published_at, i.discovered_at) DESC, i.id";
  if (t.mode === "basket") {
    params.push(t.id);
    scope = "EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id AND b.basket_id = ?)";
    order = "(SELECT b.kept_at FROM basket_items b WHERE b.item_id = i.id AND b.basket_id = ?) DESC, i.id";
  } else if (t.mode === "sources") {
    params.push(t.id);
    scope = "s.followed = 1 AND i.source_id IN (SELECT source_id FROM collection_sources WHERE collection_id = ?)";
  } else {
    scope = `(s.followed = 1 OR s.kind = 'manual' OR EXISTS (SELECT 1 FROM basket_items vb WHERE vb.item_id = i.id)) AND ${compileQuery(t.query!, params, share.workspace_id, { itemTextOnly: true })}`;
  }
  if (t.mode === "basket") params.push(t.id);
  // Read a margin past the limit: links that carry a key (in the query or the path) are dropped below, after the query.
  const rows = app.db.all<Row>(
    `SELECT i.id, i.title, i.url, i.excerpt, i.published_at, i.discovered_at, s.title AS source_title, s.kind AS source_kind, n.note
     FROM items i LEFT JOIN sources s ON s.id = i.source_id LEFT JOIN share_notes n ON n.share_id = ? AND n.item_id = i.id
     WHERE i.workspace_id = ? AND COALESCE(s.is_private, 0) = 0 AND i.url IS NOT NULL AND ${scope}
     ORDER BY ${order} LIMIT ${Math.ceil(limit * 1.5) + 20}`, ...params);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const out: (PageItem & { itemId: string; ownLink: boolean })[] = [];
  for (const r of rows) {
    const href = publicLink(r.url);
    if (!href) continue;
    out.push({
      itemId: r.id, ownLink: r.source_kind === "manual" || r.source_kind === null,
      publicId: `urn:uuid:${uuidFrom(`share:${share.id}:${r.id}`, sha)}`,
      title: plainText(r.title, 200) || "(untitled)", url: href, summary: plainText(r.excerpt, 280) || null, note: r.note,
      sourceTitle: r.source_kind === "manual" ? null : plainText(r.source_title, 120) || null, publishedAt: r.published_at, addedAt: r.discovered_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- owner-facing

function toDTO(app: App, r: ShareRow): ShareDTO {
  const t = target(app, r.target_kind, r.target_id, r.workspace_id);
  return {
    id: r.id, slug: r.slug, targetKind: r.target_kind, targetId: r.target_id, title: t?.name ?? "", description: r.description, curatorName: r.curator_name,
    status: r.status, listed: r.listed === 1, takenDown: takenDown(r), ...urls(app, r.slug), publishedAt: r.published_at,
    noteCount: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_notes WHERE share_id = ?", r.id)!.n,
    problem: !t ? "gone" : unshareable(t) ? "rules" : !canShare(app, accountOf(app, r.workspace_id)) ? "plan" : null,
  };
}

function own(app: App, p: Principal, id: string): ShareRow {
  const r = app.db.get<ShareRow>("SELECT * FROM shares WHERE id = ? AND workspace_id = ?", id, p.workspaceId);
  if (!r) throw notFound("That shared page");
  return r;
}

/** Everything this PURSS shares or has prepared to share: the Sharing page's overview. */
export function listShares(app: App, p: Principal): ShareDTO[] {
  return app.db.all<ShareRow>("SELECT * FROM shares WHERE workspace_id = ? ORDER BY created_at, id", p.workspaceId).map((r) => toDTO(app, r));
}

/** A basket's or collection's sharing: its share if any, and whether it can be shared (with why not). */
export function shareFor(app: App, p: Principal, kind: ShareTarget, id: string): { share: ShareDTO | null; blocked: string | null } {
  const t = target(app, kind, id, p.workspaceId);
  if (!t) throw notFound(kind === "basket" ? "That basket" : "That collection");
  const r = app.db.get<ShareRow>("SELECT * FROM shares WHERE target_kind = ? AND target_id = ? AND workspace_id = ?", kind, id, p.workspaceId);
  return { share: r ? toDTO(app, r) : null, blocked: !canShare(app, p.accountId) ? PLUS_ONLY : unshareable(t) };
}

/** Set up or change a basket's or collection's sharing settings. A new one starts as a draft: nothing is public until published. */
export function saveShare(app: App, p: Principal, kind: ShareTarget, id: string, input: z.infer<typeof shareSettingsSchema>): ShareDTO {
  const t = target(app, kind, id, p.workspaceId);
  if (!t) throw notFound(kind === "basket" ? "That basket" : "That collection");
  const cur = app.db.get<ShareRow>("SELECT * FROM shares WHERE target_kind = ? AND target_id = ? AND workspace_id = ?", kind, id, p.workspaceId);
  const now = nowIso();
  if (!cur) {
    if (!canShare(app, p.accountId)) throw new HttpError(403, "plan_sharing", PLUS_ONLY);
    const sid = newId("shr");
    // The name shown is whatever the person typed; it is never defaulted from account data.
    app.db.run("INSERT INTO shares (id, workspace_id, target_kind, target_id, slug, curator_name, description, listed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sid, p.workspaceId, kind, id, makeSlug(t.name), input.curatorName, input.description ?? null, input.listed ? 1 : 0, now, now);
    audit(app, p.accountId, "share_create", sid, "success");
    return toDTO(app, own(app, p, sid));
  }
  // Letting search engines list a page that is already public widens who reaches it: that takes its own confirmation.
  if (input.listed && cur.listed === 0 && cur.status === "published" && input.confirmListed !== true) throw badRequest(LISTING_STATEMENT, "confirm");
  app.db.run("UPDATE shares SET curator_name = ?, description = ?, listed = ?, updated_at = ? WHERE id = ?", input.curatorName, input.description ?? null, input.listed ? 1 : 0, now, cur.id);
  return toDTO(app, own(app, p, cur.id));
}

/** The items a share shows now, with the person's public notes, for writing notes. */
export function shareItems(app: App, p: Principal, id: string): ShareItemDTO[] {
  const r = own(app, p, id);
  return (projection(app, r) ?? []).map((i) => ({ itemId: i.itemId, title: i.title, sourceTitle: i.sourceTitle, publishedAt: i.publishedAt, note: i.note, ownLink: i.ownLink }));
}

/** Write, change or remove the public note on one item of a share. On a public page it shows at once. */
export function setShareNote(app: App, p: Principal, id: string, itemId: string, note: string | null): { note: string | null; notice: string | null } {
  const r = own(app, p, id);
  if (!(projection(app, r, 100_000) ?? []).some((i) => i.itemId === itemId)) throw notFound("That item on this shared page");
  const text = plainText(note, 500) || null;
  app.db.tx(() => {
    if (text) app.db.run("INSERT INTO share_notes (share_id, item_id, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (share_id, item_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at", id, itemId, text, nowIso());
    else app.db.run("DELETE FROM share_notes WHERE share_id = ? AND item_id = ?", id, itemId);
    app.db.run("UPDATE shares SET updated_at = ? WHERE id = ?", nowIso(), id);
  });
  return { note: text, notice: r.status === "published" ? "This page is public, so the note shows on it and in its feed now." : null };
}

/** What sharing would make visible that the person added themselves, so they are told before they share. */
function warnings(app: App, r: ShareRow, t: Target, items: { ownLink: boolean; note: string | null }[]): string[] {
  const out: string[] = [];
  if (t.mode === "basket") out.push(`Everything you keep in “${t.name}” shows on the page, including what you add later.`);
  if (t.mode === "query" && t.query && [...fields(t.query)].some((f) => KEEPING_FIELDS.has(f))) out.push("This collection's rules use your baskets, so the page shows which items you keep.");
  if (t.mode !== "basket") out.push("New items from its sources show on the page as they arrive.");
  const own = items.filter((i) => i.ownLink).length;
  if (own) out.push(`${own === 1 ? "1 link you saved yourself" : `${own} links you saved yourself`} (not from a feed) will be public, with the title you gave ${own === 1 ? "it" : "them"}.`);
  const notes = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_notes WHERE share_id = ?", r.id)!.n;
  if (notes) out.push(`${notes === 1 ? "1 public note" : `${notes} public notes`} you wrote for this page will show, with the name you chose.`);
  return out;
}

/** What a confirmation covers: the settings that were reviewed. The items are live, so new ones don't void it. */
function confirmHash(r: ShareRow): string {
  return createHash("sha256").update(JSON.stringify([r.target_kind, r.target_id, r.curator_name, r.description, r.listed])).digest("hex");
}

export function previewShare(app: App, p: Principal, id: string): SharePreview {
  const r = own(app, p, id);
  const t = target(app, r.target_kind, r.target_id, r.workspace_id);
  const items = projection(app, r) ?? [];
  const blockers: string[] = [];
  if (!t) blockers.push("This basket or collection no longer exists.");
  else {
    const why = unshareable(t);
    if (why) blockers.push(why);
  }
  if (!canShare(app, p.accountId)) blockers.push(PLUS_ONLY);
  if (r.taken_down_at) blockers.push(TAKEN_DOWN_BLOCKER);
  let confirmation: SharePreview["confirmation"] = null;
  if (!blockers.length && r.status !== "published") {
    const token = randomToken(18);
    app.db.run("INSERT INTO confirm_tokens (token, workspace_id, purpose, data, expires_at) VALUES (?, ?, 'share-publish', ?, ?)",
      token, p.workspaceId, JSON.stringify({ id, hash: confirmHash(r) }), addSeconds(600));
    confirmation = { token, statement: shareStatement(r.listed === 1) };
  }
  return {
    share: toDTO(app, r),
    itemCount: items.length,
    html: renderPage(app, head(app, r), items),
    isPublic: r.status === "published" && !r.taken_down_at,
    warnings: t ? warnings(app, r, t, items) : [],
    blockers,
    confirmation,
  };
}

export function publishShare(app: App, p: Principal, id: string, confirmToken: string): ShareDTO {
  return app.db.tx(() => {
    const r = own(app, p, id);
    if (r.taken_down_at) throw new HttpError(403, "taken_down", TAKEN_DOWN_BLOCKER);
    if (!canShare(app, p.accountId)) throw new HttpError(403, "plan_sharing", PLUS_ONLY);
    const t = target(app, r.target_kind, r.target_id, r.workspace_id);
    const why = t ? unshareable(t) : "This basket or collection no longer exists.";
    if (why) throw badRequest(why, "unshareable");
    const tok = app.db.get<{ data: string }>("SELECT data FROM confirm_tokens WHERE token = ? AND workspace_id = ? AND purpose = 'share-publish' AND expires_at > ?", confirmToken, p.workspaceId, nowIso());
    if (!tok) throw badRequest("Please review what visitors will see and confirm again.", "confirm");
    const planned = JSON.parse(tok.data) as { id: string; hash: string };
    if (planned.id !== id || planned.hash !== confirmHash(r)) throw badRequest("The sharing settings changed since you reviewed them. Please review again.", "confirm");
    app.db.run("DELETE FROM confirm_tokens WHERE token = ?", confirmToken);
    app.db.run("UPDATE shares SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
    audit(app, p.accountId, "share_publish", id, "success");
    return toDTO(app, own(app, p, id));
  });
}

export function pauseShare(app: App, p: Principal, id: string): { share: ShareDTO; notice: string } {
  const r = own(app, p, id);
  if (r.status !== "published") throw badRequest("Only a public page can be paused.", "not_published");
  app.db.run("UPDATE shares SET status = 'paused', updated_at = ? WHERE id = ?", nowIso(), id);
  audit(app, p.accountId, "share_pause", id, "success");
  return { share: toDTO(app, own(app, p, id)), notice: REVOCATION_NOTICE };
}

/** Stop sharing: the page, its address and its public notes go. A page an administrator took down stays until restored. */
export function stopSharing(app: App, p: Principal, id: string): { ok: true; notice: string } {
  const r = own(app, p, id);
  if (r.taken_down_at) throw badRequest("An administrator took this page down; it stays (switched off) until they restore it.", "taken_down");
  app.db.run("DELETE FROM shares WHERE id = ?", id);
  audit(app, p.accountId, "share_stop", id, "success");
  return { ok: true, notice: r.status === "published" ? REVOCATION_NOTICE : "Stopped." };
}

/** A basket or collection is deleted: its share goes with it. */
export function deleteSharesOf(app: App, kind: ShareTarget, id: string): void {
  app.db.run("DELETE FROM shares WHERE target_kind = ? AND target_id = ?", kind, id);
}

/** Suspension or account removal ends public sharing; copies already fetched are not recalled. */
export function pauseAllShares(app: App, workspaceId: string): number {
  return app.db.run("UPDATE shares SET status = 'paused', updated_at = ? WHERE workspace_id = ? AND status = 'published'", nowIso(), workspaceId).changes;
}

// ---------- rendering

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export type ShareHead = { slug: string; title: string; description: string | null; curatorName: string; listed: boolean };
const head = (app: App, r: ShareRow): ShareHead => ({
  slug: r.slug, title: target(app, r.target_kind, r.target_id, r.workspace_id)?.name ?? "", description: r.description, curatorName: r.curator_name, listed: r.listed === 1,
});

/** The public page: server-rendered, no scripts, no external resources, no internal identifiers. */
export function renderPage(app: App, pub: ShareHead, items: PageItem[]): string {
  const { publicUrl, feedUrl, followUrl: follow } = urls(app, pub.slug);
  const curator = escapeHtml(pub.curatorName);
  const list = items.length
    ? `<ol>${items.slice(0, PAGE_ITEMS).map((i) => {
      const date = shortDate(i.publishedAt);
      const meta = [i.sourceTitle ? escapeHtml(i.sourceTitle) : null, date ? `<time datetime="${escapeHtml(i.publishedAt!)}">${escapeHtml(date)}</time>` : null].filter(Boolean).join(" · ");
      return `<li><article><h2><a href="${escapeHtml(i.url)}" rel="noopener noreferrer nofollow">${escapeHtml(i.title)}</a></h2>${meta ? `<p class="meta">${meta}</p>` : ""}${i.note ? `<p class="note"><b>${curator}:</b> ${escapeHtml(i.note)}</p>` : ""}${i.summary ? `<p class="sum">${escapeHtml(i.summary)}</p>` : ""}</article></li>`;
    }).join("")}</ol>`
    : `<p class="empty">Nothing here yet.</p>`;
  const home = productHome(app);
  return pageShell({
    title: `${pub.title} · shared by ${pub.curatorName}`,
    indexable: pub.listed,
    head: `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(pub.title)}" href="${escapeHtml(feedUrl)}">
<link rel="canonical" href="${escapeHtml(publicUrl)}">
`,
    body: `<header>
<h1>${escapeHtml(pub.title)}</h1>
<p class="by">Shared by ${curator}</p>
${pub.description ? `<p class="about">${escapeHtml(pub.description)}</p>` : ""}
<div class="acts"><a class="btn primary sm" href="${escapeHtml(follow)}" title="Get what ${curator} adds next, in your PURSS or any feed reader">Follow</a><a class="feed" href="${escapeHtml(feedUrl)}">Feed</a></div>
</header>
<main id="main">
${list}
</main>
<footer>
<p>These are links shared by ${curator}. The articles belong to their authors and sites.</p>
<p>${home ? `Made with <a href="${escapeHtml(home)}">${PRODUCT_NAME}</a>: share your own baskets and collections as a page and a feed. · ` : ""}<a href="${escapeHtml(`${publicUrl}/report`)}">Report this page</a></p>
</footer>`,
  });
}

/** Atom 1.0 with stable public identifiers; the author is the chosen name and never carries an email address. */
export function renderAtom(app: App, pub: ShareHead & { updatedAt: string }, items: PageItem[]): string {
  const { publicUrl, feedUrl } = urls(app, pub.slug);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  // With a note, the entry's content is the note followed by the summary, so readers that show content show both.
  const content = (i: PageItem) => i.note
    ? `    <content type="html">${escapeXml(`<p><b>${escapeHtml(pub.curatorName)}:</b> ${escapeHtml(i.note)}</p>${i.summary ? `<p>${escapeHtml(i.summary)}</p>` : ""}`)}</content>\n`
    : "";
  const entries = items.slice(0, FEED_ITEMS).map((i) => `  <entry>
    <id>${escapeXml(i.publicId)}</id>
    <title>${escapeXml(i.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(i.url)}"/>
${i.publishedAt ? `    <published>${escapeXml(i.publishedAt)}</published>\n` : ""}    <updated>${escapeXml(i.publishedAt ?? i.addedAt)}</updated>
${i.summary ? `    <summary type="text">${escapeXml(i.summary)}</summary>\n` : ""}${content(i)}${i.sourceTitle ? `    <source><title>${escapeXml(i.sourceTitle)}</title></source>\n` : ""}  </entry>`).join("\n");
  const newest = items.reduce((m, i) => ((i.publishedAt ?? i.addedAt) > m ? (i.publishedAt ?? i.addedAt) : m), pub.updatedAt);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:uuid:${uuidFrom(`share:${pub.slug}`, sha)}</id>
  <title>${escapeXml(pub.title)}</title>
${pub.description ? `  <subtitle>${escapeXml(pub.description)}</subtitle>\n` : ""}  <updated>${escapeXml(newest)}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(publicUrl)}"/>
  <author><name>${escapeXml(pub.curatorName)}</name></author>
  <generator>${PRODUCT_NAME}</generator>
${entries}
</feed>
`;
}

// ---------- public reads

export type PublicShare = ShareHead & { id: string; updatedAt: string; items: PageItem[] };

/**
 * A public page by its address, with what it shows, or null. Drafts, paused and taken-down pages, pages whose
 * basket or collection is gone or can no longer be shared, and pages of accounts whose plan no longer includes
 * sharing are indistinguishable to visitors from addresses that never existed.
 */
export function findPublished(app: App, slug: string): PublicShare | null {
  if (!/^[a-z0-9-]{3,80}$/.test(slug)) return null;
  const r = app.db.get<ShareRow & { account_status: string }>(
    `SELECT sh.*, a.status AS account_status FROM shares sh JOIN workspaces w ON w.id = sh.workspace_id JOIN accounts a ON a.id = w.account_id
     WHERE sh.slug = ? AND sh.status = 'published' AND sh.taken_down_at IS NULL`, slug);
  if (!r || r.account_status !== "active" || !canShare(app, accountOf(app, r.workspace_id))) return null;
  const items = projection(app, r);
  return items ? { ...head(app, r), id: r.id, updatedAt: r.updated_at, items } : null;
}

/** A per-address counter over a window, kept in memory only and swept every window, so no address stays longer than two windows. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const sweep = () => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); };
  setInterval(sweep, windowMs).unref();
  const hit = (address: string | undefined): boolean => {
    const now = Date.now();
    if (hits.size > 5000) sweep();
    const key = address ?? "unknown";
    const e = hits.get(key);
    if (!e || e.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    return ++e.n <= max;
  };
  return { hit, reset: () => hits.clear() };
}
const reads = limiter(120, 60_000);
const reports = limiter(5, 3600_000);

/** Simple per-address limit for the public pages, feeds and follow page. */
export function limitPublicRead(address: string | undefined): void {
  if (!reads.hit(address)) throw new HttpError(429, "slow_down", "Too many requests. Please wait a minute and try again.");
}
export const resetPublicReadLimit = () => { reads.reset(); reports.reset(); };

// ---------- reports and takedowns

/** Open reports kept per page; past this, further reports are thanked but not stored, so a flood can't fill the database. */
const OPEN_REPORTS_PER_PAGE = 50;

export type ReportInput = { reason: string; details: string; contact: string };
export type ReportOutcome = { ok: true } | { ok: false; status: 400 | 429; error: string };

/** A visitor's report about a public page. Only what they typed is stored; administrators are told in their bell. */
export function reportShare(app: App, pub: PublicShare, input: ReportInput, address: string | undefined): ReportOutcome {
  const reason = (REPORT_REASONS as readonly string[]).includes(input.reason) ? input.reason as ReportReason : null;
  const details = input.details.trim().slice(0, 2000);
  const contact = plainText(input.contact, 200) || null;
  if (!reason) return { ok: false, status: 400, error: "Please choose what's wrong with the page." };
  if (details.length < 10) return { ok: false, status: 400, error: "Please say a little more about what's wrong (at least a few words)." };
  if (!reports.hit(address)) return { ok: false, status: 429, error: "You've sent several reports in a short time. Please try again in an hour." };
  const open = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_reports WHERE share_id = ? AND resolved_at IS NULL", pub.id)!.n;
  if (open >= OPEN_REPORTS_PER_PAGE) return { ok: true };
  const now = nowIso();
  const told = app.db.tx(() => {
    app.db.run("INSERT INTO share_reports (id, share_id, reason, details, contact, created_at) VALUES (?, ?, ?, ?, ?, ?)", newId("rpt"), pub.id, reason, details, contact, now);
    const admins = app.db.all<{ id: string; account_id: string }>("SELECT w.id, w.account_id FROM workspaces w JOIN role_grants g ON g.account_id = w.account_id AND g.role = 'admin'");
    const title = `A shared page was reported: ${plainText(pub.title, 80)}`;
    const body = `${REPORT_REASON_LABELS[reason]}. Review it in Administration → Reports.`;
    for (const a of admins) {
      app.db.run(`INSERT INTO notifications (id, workspace_id, kind, title, body, dedup_key, created_at) VALUES (?, ?, 'system', ?, ?, ?, ?)
        ON CONFLICT (workspace_id, dedup_key) DO UPDATE SET title = excluded.title, body = excluded.body, read_at = NULL`,
      newId("ntf"), a.id, title, body, `share-report:${pub.id}:${now.slice(0, 10)}`, now);
    }
    return admins.map((a) => a.account_id);
  });
  for (const accountId of told) emit(app, accountId, { type: "notification" });
  audit(app, null, "share_report", pub.id, "success", reason);
  return { ok: true };
}

/** A report joined with its page's row (`sh.*`); the report's own columns are aliased so they don't collide. */
type ReportRow = ShareRow & { report_id: string; reason: ReportReason; details: string; contact: string | null; reported_at: string; resolved_at: string | null; resolution: "taken_down" | "dismissed" | null; open_reports: number };

/**
 * Reports for administrators, newest first: every open one (at most 50 per page are kept open), the latest 200 of
 * all, or one per page that is taken down now (its latest report), so every takedown stays reachable for restoring.
 */
export function listReports(app: App, which: "open" | "all" | "taken_down"): ShareReportDTO[] {
  const rows = app.db.all<ReportRow>(
    `SELECT r.id AS report_id, r.reason, r.details, r.contact, r.created_at AS reported_at, r.resolved_at, r.resolution, sh.*,
       (SELECT COUNT(*) FROM share_reports o WHERE o.share_id = sh.id AND o.resolved_at IS NULL) AS open_reports
     FROM share_reports r JOIN shares sh ON sh.id = r.share_id
     ${which === "open" ? "WHERE r.resolved_at IS NULL"
    : which === "taken_down" ? "WHERE sh.taken_down_at IS NOT NULL AND r.id = (SELECT l.id FROM share_reports l WHERE l.share_id = sh.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1)" : ""}
     ORDER BY r.created_at DESC, r.id ${which === "all" ? "LIMIT 200" : ""}`);
  return rows.map((r) => ({
    id: r.report_id, reason: r.reason, details: r.details, contact: r.contact, createdAt: r.reported_at, resolvedAt: r.resolved_at, resolution: r.resolution,
    share: { id: r.id, title: head(app, r).title, curatorName: r.curator_name, status: r.status, publicUrl: urls(app, r.slug).publicUrl, takenDown: takenDown(r), openReports: r.open_reports },
  }));
}

function reportedShare(app: App, id: string): ShareRow {
  const r = app.db.get<ShareRow>("SELECT * FROM shares WHERE id = ? AND id IN (SELECT share_id FROM share_reports)", id);
  if (!r) throw notFound("That reported page");
  return r;
}

/** The page as visitors see it, for an administrator reviewing a report, whether it is public now or not. */
export function reportedPage(app: App, id: string): { html: string } {
  const r = reportedShare(app, id);
  return { html: renderPage(app, head(app, r), projection(app, r) ?? []) };
}

function tellOwner(app: App, r: ShareRow, title: string, body: string, key: string): void {
  app.db.run("INSERT OR IGNORE INTO notifications (id, workspace_id, kind, title, body, dedup_key, created_at) VALUES (?, ?, 'system', ?, ?, ?, ?)",
    newId("ntf"), r.workspace_id, title, body, key, nowIso());
}

/** Take a reported page down: it stops showing at once, its open reports are closed, and its owner is told why. */
export function takeDownShare(app: App, admin: Principal, id: string, reason: string): { ok: true } {
  const text = plainText(reason, 500);
  if (text.length < 5) throw badRequest("Write the reason the owner will see.", "reason");
  const r = app.db.tx(() => {
    const cur = reportedShare(app, id);
    if (cur.taken_down_at) throw badRequest("That page is already taken down.", "already");
    const now = nowIso();
    app.db.run("UPDATE shares SET taken_down_at = ?, takedown_reason = ?, status = CASE WHEN status = 'published' THEN 'paused' ELSE status END, updated_at = ? WHERE id = ?", now, text, now, id);
    app.db.run("UPDATE share_reports SET resolved_at = ?, resolution = 'taken_down', resolved_by = ? WHERE share_id = ? AND resolved_at IS NULL", now, admin.accountId, id);
    tellOwner(app, cur, `Your shared page “${plainText(head(app, cur).title, 80)}” was taken down`,
      `An administrator took its page and feed down after a report: ${text} You can still change it, but not share it again unless an administrator restores it.`, `share-takedown:${id}:${now}`);
    return cur;
  });
  emit(app, accountOf(app, r.workspace_id), { type: "notification" });
  audit(app, admin.accountId, "share_takedown", id, "success");
  return { ok: true };
}

/** Lift a takedown. The page stays paused; its owner can share it again after reviewing it. */
export function restoreShare(app: App, admin: Principal, id: string): { ok: true } {
  const r = app.db.tx(() => {
    const cur = reportedShare(app, id);
    if (!cur.taken_down_at) throw badRequest("That page isn't taken down.", "not_taken_down");
    app.db.run("UPDATE shares SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ?", nowIso(), id);
    tellOwner(app, cur, `Your shared page “${plainText(head(app, cur).title, 80)}” can be shared again`,
      "An administrator lifted the takedown. It is still paused: review it and share it again when you're ready.", `share-restore:${id}:${nowIso()}`);
    return cur;
  });
  emit(app, accountOf(app, r.workspace_id), { type: "notification" });
  audit(app, admin.accountId, "share_restore", id, "success");
  return { ok: true };
}

/** Close a report without action. */
export function dismissReport(app: App, admin: Principal, reportId: string): { ok: true } {
  const n = app.db.run("UPDATE share_reports SET resolved_at = ?, resolution = 'dismissed', resolved_by = ? WHERE id = ? AND resolved_at IS NULL", nowIso(), admin.accountId, reportId).changes;
  if (!n) throw notFound("That open report");
  audit(app, admin.accountId, "share_report_dismiss", reportId, "success");
  return { ok: true };
}
