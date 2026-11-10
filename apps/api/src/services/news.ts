import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_PATH, newId } from "@purss/domain";
import type { NewsAdminDTO, NewsPostDTO, NewsPostInput, NewsPostStats } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit, emit } from "../app.ts";
import { notFound, nowIso } from "../http.ts";
import { insertItem } from "./items.ts";
import { updateItem } from "./sync.ts";
import { deleteItemNow } from "./collections.ts";
import { hueFor } from "./content.ts";
import { markPaused, StorageFull } from "./storage.ts";
import { notifyArrivals } from "./notifications.ts";
import { usableAccountSql } from "./deletion.ts";
import { HAS_ANNOTATIONS } from "./annotations.ts";
import { PRODUCT_NAME, pageShell } from "./public-pages.ts";
import { escapeHtml, escapeXml, uuidFrom } from "./text-safety.ts";
import { onAccountCreated } from "./account-hooks.ts";
import { NEWS_INITIAL_POSTS, NEWS_TITLE, newsUrls, publishedNews } from "./news-address.ts";

export { NEWS_INITIAL_POSTS, NEWS_TITLE } from "./news-address.ts";

/*
 * The installation's own news. Administrators write posts; published ones are a public Atom feed and page
 * (/news, /news/feed.atom) and are put straight into every PURSS that follows the built-in news source,
 * which each PURSS gets once, when the installation has published something. No engine fetches it: the
 * posts are this product's own data. Unfollowing, pausing and deleting copies work as for any source.
 */

const FEED_POSTS = 30;

type PostRow = { id: string; title: string; body: string; status: "draft" | "published"; created_at: string; updated_at: string; published_at: string | null };
type NewsSource = { id: string; account_id: string; workspace_id: string };

// ---------- the body's markup

const LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)|(https?:\/\/[^\s<]{1,2000}[^\s<.,;:!?)'"])/g;

/** One line: [text](https://…) and bare https addresses become links, **text** bold; everything else is text. */
function inline(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(LINK)) {
    out += bold(escapeHtml(line.slice(last, m.index)));
    const href = m[2] ?? m[3]!;
    out += `<a href="${escapeHtml(href)}">${bold(escapeHtml(m[1] ?? href))}</a>`;
    last = m.index + m[0].length;
  }
  return out + bold(escapeHtml(line.slice(last)));
}
const bold = (html: string) => html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");

/** What an administrator wrote as HTML: blank lines separate paragraphs; a block of "- " lines is a list. */
export function renderNewsBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.every((l) => /^[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2).trim())}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}

// ---------- delivery into PURSSes

const hasPublished = (app: App) => !!app.db.get("SELECT 1 FROM news_posts WHERE status = 'published' LIMIT 1");

/**
 * Put one post into a PURSS and record it; true when a copy was added. A copy the PURSS already has (one an
 * archive import brought back) is recorded instead of added twice. A full account is skipped (and marked paused) until
 * it has room again.
 */
function deliver(app: App, s: NewsSource, post: PostRow, fresh: boolean): boolean {
  const url = newsUrls(app).post(post.id);
  const present = app.db.get<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? AND source_id = ? AND url = ? LIMIT 1", s.workspace_id, s.id, url);
  if (present) {
    // Its text may be older than the post's: left unrevised, the next pass brings it up to date.
    app.db.run("INSERT OR IGNORE INTO news_deliveries (post_id, workspace_id, item_id, delivered_at) VALUES (?, ?, ?, ?)", post.id, s.workspace_id, present.id, nowIso());
    return false;
  }
  try {
    app.db.tx(() => {
      const itemId = insertItem(app, {
        accountId: s.account_id, workspaceId: s.workspace_id, sourceId: s.id, kind: "article", title: post.title, url,
        author: null, summaryHtml: null, contentHtml: renderNewsBody(post.body), imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
        publishedAt: post.published_at, discoveredAt: nowIso(), enclosures: [], fresh, reason: "news post",
      }).id;
      app.db.run("INSERT INTO news_deliveries (post_id, workspace_id, item_id, delivered_at, revised_at) VALUES (?, ?, ?, ?, ?)", post.id, s.workspace_id, itemId, nowIso(), post.updated_at);
      app.db.run("UPDATE sources SET last_item_at = MAX(COALESCE(last_item_at, ''), ?), last_success_at = ?, health = 'ok', health_text = NULL WHERE id = ?", post.published_at, nowIso(), s.id);
    });
    return true;
  } catch (err) {
    if (err instanceof StorageFull) { markPaused(app, err); return false; }
    throw err;
  }
}

/** Tell the PURSS what arrived: lists refresh, and the source's notification setting decides about a notification. */
function announce(app: App, s: NewsSource, count: number, notify: boolean): void {
  if (!count) return;
  if (notify) notifyArrivals(app, s.workspace_id, [[s.id, count]]);
  emit(app, s.account_id, { type: "items", sourceIds: [s.id], count });
  emit(app, s.account_id, { type: "storage" });
}

/**
 * Give a PURSS its news source, once, with the newest few posts. Nothing happens before the installation has
 * published a post, or when the PURSS already has the source (followed or not: an unfollow is respected).
 */
export function addNewsSource(app: App, accountId: string, workspaceId: string): void {
  if (!hasPublished(app) || app.db.get("SELECT 1 FROM sources WHERE workspace_id = ? AND builtin = 'news'", workspaceId)) return;
  const s: NewsSource = { id: newId("src"), account_id: accountId, workspace_id: workspaceId };
  const { page, feed } = newsUrls(app);
  // A source of this kind is like any feed to the person; it has no engine subscription, so it never waits for one.
  app.db.run(
    `INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, site_url, feed_url, hue, health, builtin, created_at)
     VALUES (?, ?, ?, 'feed', ?, ?, ?, ?, ?, 'ok', 'news', ?)`,
    s.id, accountId, workspaceId, NEWS_TITLE, `News from this ${PRODUCT_NAME}`, page, feed, hueFor(NEWS_TITLE), nowIso());
  const posts = app.db.all<PostRow>("SELECT * FROM news_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ?", NEWS_INITIAL_POSTS);
  let n = 0;
  for (const post of posts.reverse()) if (deliver(app, s, post, true)) n++;
  giveNewsIcons(app);
  emit(app, accountId, { type: "source", sourceId: s.id });
  announce(app, s, n, false);
}

/**
 * The app's own icon (apps/web/public/icon-512.png), encoded the way the worker encodes every source icon
 * (news.test.ts checks it still matches the app icon). The news source never asks the worker: its site is this
 * server, which the worker may not reach, and whatever icon the website shows is not the app's.
 */
const NEWS_ICON = readFileSync(new URL("./news-icon.webp", import.meta.url));
const NEWS_ICON_DIGEST = createHash("sha256").update(NEWS_ICON).digest("hex");

/** Every news source shows the app's icon: new ones, ones followed again, and all of them after the icon changes. */
function giveNewsIcons(app: App): void {
  const missing = app.db.all<{ id: string; account_id: string; workspace_id: string }>(
    `SELECT s.id, s.account_id, s.workspace_id FROM sources s LEFT JOIN source_icons si ON si.source_id = s.id
     WHERE s.builtin = 'news' AND (si.digest IS NULL OR si.digest <> ?) LIMIT 500`, NEWS_ICON_DIGEST);
  const now = nowIso();
  for (const s of missing) {
    app.db.run(
      `INSERT INTO source_icons (source_id, account_id, workspace_id, bytes, digest, found_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET bytes = excluded.bytes, digest = excluded.digest, found_url = excluded.found_url, updated_at = excluded.updated_at`,
      s.id, s.account_id, s.workspace_id, NEWS_ICON, NEWS_ICON_DIGEST, `${app.config.publicOrigin}${APP_PATH}/icon-512.png`, now);
    app.db.run("UPDATE sources SET icon_checked_at = ? WHERE id = ?", now, s.id);
    emit(app, s.account_id, { type: "source", sourceId: s.id });
  }
}

onAccountCreated(addNewsSource);

/**
 * Bring every PURSS up to date: give the news source to those that never had it, and put each published post
 * into every followed, unpaused news source made before it was published that doesn't have it yet, as well as the
 * newest few posts a source gets when it is made or followed again; then bring copies of edited posts up to date. Runs
 * after a post is published and on every maintenance tick, so an account that was full, suspended or paused catches up later.
 */
export function deliverNews(app: App): void {
  giveNewsIcons(app);
  if (!hasPublished(app)) return;
  for (const w of app.db.all<{ id: string; account_id: string }>(
    `SELECT w.id, w.account_id FROM workspaces w WHERE ${usableAccountSql("w.account_id")}
       AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.workspace_id = w.id AND s.builtin = 'news') LIMIT 200`)) {
    addNewsSource(app, w.account_id, w.id);
  }
  const pending = app.db.all<NewsSource & { post: string }>(
    `SELECT s.id, s.account_id, s.workspace_id, json_object('id', p.id, 'title', p.title, 'body', p.body, 'status', p.status, 'created_at', p.created_at,
       'updated_at', p.updated_at, 'published_at', p.published_at) AS post FROM sources s
     JOIN news_posts p ON p.status = 'published' AND (p.published_at >= s.created_at
       OR p.id IN (SELECT id FROM news_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ${NEWS_INITIAL_POSTS}))
     WHERE s.builtin = 'news' AND s.followed = 1 AND s.paused = 0 AND ${usableAccountSql("s.account_id")}
       AND NOT EXISTS (SELECT 1 FROM storage_accounts sa WHERE sa.account_id = s.account_id AND sa.paused_reason IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM news_deliveries d WHERE d.post_id = p.id AND d.workspace_id = s.workspace_id)
     ORDER BY p.published_at LIMIT 500`);
  const arrived = new Map<string, { s: NewsSource; n: number }>();
  for (const row of pending) {
    if (!deliver(app, row, JSON.parse(row.post) as PostRow, true)) continue;
    const a = arrived.get(row.id) ?? { s: row, n: 0 };
    a.n++;
    arrived.set(row.id, a);
  }
  for (const { s, n } of arrived.values()) announce(app, s, n, true);
  reviseCopies(app);
}

/** A published post was edited: every copy gets the new text (a kept copy keeps the version it was kept with). */
function reviseCopies(app: App): void {
  // A full account's copies wait (updateItem would only defer them) until it has room again; the tick asks again.
  const copies = app.db.all<{ post_id: string; item_id: string; account_id: string; workspace_id: string; title: string; body: string; published_at: string; updated_at: string }>(
    `SELECT d.post_id, d.item_id, i.account_id, i.workspace_id, p.title, p.body, p.published_at, p.updated_at
     FROM news_deliveries d JOIN news_posts p ON p.id = d.post_id AND p.status = 'published' JOIN items i ON i.id = d.item_id
     WHERE d.revised_at < p.updated_at AND NOT EXISTS (SELECT 1 FROM storage_accounts sa WHERE sa.account_id = i.account_id AND sa.paused_reason IS NOT NULL)
     LIMIT 500`);
  for (const c of copies) {
    const changed = updateItem(app, c, c.item_id, {
      title: c.title, url: newsUrls(app).post(c.post_id), author: null, summaryHtml: null, contentHtml: renderNewsBody(c.body),
      imageUrl: null, enclosures: [], publishedAt: c.published_at,
    });
    // Unchanged or revised now: up to date. Deferred because the account just filled up: left for later.
    if (!app.db.get("SELECT 1 FROM storage_accounts WHERE account_id = ? AND paused_reason IS NOT NULL", c.account_id)) {
      app.db.run("UPDATE news_deliveries SET revised_at = ? WHERE post_id = ? AND workspace_id = ?", c.updated_at, c.post_id, c.workspace_id);
    }
    if (changed) emit(app, c.account_id, { type: "items", sourceIds: [], count: 0 });
  }
}

// ---------- administration

function statsOf(app: App, postId: string): NewsPostStats {
  const r = app.db.get<NewsPostStats>(
    `SELECT COUNT(*) AS delivered,
       COALESCE(SUM(st.item_id IS NOT NULL AND (st.opened_at IS NOT NULL OR st.workflow IN ('inprogress', 'finished'))), 0) AS read,
       COALESCE(SUM(EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = d.item_id)), 0) AS kept,
       COALESCE(SUM(st.workflow = 'ignored'), 0) AS ignored,
       COALESCE(SUM(st.item_id IS NULL), 0) AS removed
     FROM news_deliveries d LEFT JOIN item_state st ON st.item_id = d.item_id WHERE d.post_id = ?`, postId)!;
  return { delivered: r.delivered, read: r.read, kept: r.kept, ignored: r.ignored, removed: r.removed };
}

function toDTO(app: App, r: PostRow): NewsPostDTO {
  return {
    id: r.id, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at,
    url: r.status === "published" ? newsUrls(app).post(r.id) : null, stats: r.status === "published" ? statsOf(app, r.id) : null,
  };
}

export function newsAdmin(app: App): NewsAdminDTO {
  const { page, feed } = newsUrls(app);
  const audience = app.db.get<{ following: number; unfollowed: number }>(
    `SELECT COALESCE(SUM(followed = 1), 0) AS following, COALESCE(SUM(followed = 0), 0) AS unfollowed FROM sources s
     WHERE builtin = 'news' AND ${usableAccountSql("s.account_id")}`)!;
  const posts = app.db.all<PostRow>("SELECT * FROM news_posts ORDER BY status = 'published', COALESCE(published_at, updated_at) DESC");
  return { title: NEWS_TITLE, pageUrl: page, feedUrl: feed, audience: { following: audience.following, unfollowed: audience.unfollowed }, posts: posts.map((r) => toDTO(app, r)) };
}

function postRow(app: App, id: string): PostRow {
  const r = app.db.get<PostRow>("SELECT * FROM news_posts WHERE id = ?", id);
  if (!r) throw notFound("That post");
  return r;
}

export function createNewsPost(app: App, admin: Principal, input: NewsPostInput): NewsPostDTO {
  const id = newId("nws");
  const now = nowIso();
  app.db.run("INSERT INTO news_posts (id, title, body, status, author_account_id, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id, input.title, input.body, input.publish ? "published" : "draft", admin.accountId, now, now, input.publish ? now : null);
  audit(app, admin.accountId, input.publish ? "news_publish" : "news_draft", id, "success");
  if (input.publish) deliverNews(app);
  return toDTO(app, postRow(app, id));
}

export function updateNewsPost(app: App, admin: Principal, id: string, input: NewsPostInput): NewsPostDTO {
  const before = postRow(app, id);
  const publishing = before.status === "draft" && input.publish;
  const now = nowIso();
  app.db.run("UPDATE news_posts SET title = ?, body = ?, status = ?, updated_at = ?, published_at = COALESCE(published_at, ?) WHERE id = ?",
    input.title, input.body, publishing ? "published" : before.status, now, publishing ? now : null, id);
  const after = postRow(app, id);
  audit(app, admin.accountId, publishing ? "news_publish" : "news_edit", id, "success");
  if (publishing) deliverNews(app);
  else if (after.status === "published") reviseCopies(app);
  return toDTO(app, after);
}

/**
 * Delete a post: it leaves the feed and page, and the copies in PURSSes go too, except those someone kept in a
 * basket, published, or wrote highlights or notes on: those stay theirs.
 */
export function deleteNewsPost(app: App, admin: Principal, id: string): { removedCopies: number; keptCopies: number } {
  postRow(app, id);
  let removedCopies = 0;
  let keptCopies = 0;
  const touched = new Set<string>();
  app.db.tx(() => {
    const copies = app.db.all<{ item_id: string; account_id: string; workspace_id: string; held: number }>(
      `SELECT d.item_id, i.account_id, i.workspace_id,
         (EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id) OR EXISTS (SELECT 1 FROM share_notes sn WHERE sn.item_id = i.id) OR ${HAS_ANNOTATIONS}) AS held
       FROM news_deliveries d JOIN items i ON i.id = d.item_id WHERE d.post_id = ?`, id);
    for (const c of copies) {
      if (c.held) { keptCopies++; continue; }
      if (deleteItemNow(app, { workspaceId: c.workspace_id }, c.item_id) !== null) { removedCopies++; touched.add(c.account_id); }
    }
    app.db.run("DELETE FROM news_deliveries WHERE post_id = ?", id);
    app.db.run("DELETE FROM news_posts WHERE id = ?", id);
    audit(app, admin.accountId, "news_delete", id, "success", `${removedCopies} copies removed, ${keptCopies} kept`);
  });
  for (const accountId of touched) {
    emit(app, accountId, { type: "items", sourceIds: [], count: 0 });
    emit(app, accountId, { type: "storage" });
  }
  return { removedCopies, keptCopies };
}

// ---------- public page and feed

const publishedPosts = (app: App, limit: number): PostRow[] => publishedNews(app, limit) as PostRow[];

export function publishedPost(app: App, id: string): PostRow | null {
  if (!/^nws_[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  return app.db.get<PostRow>("SELECT * FROM news_posts WHERE id = ? AND status = 'published'", id) ?? null;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");

function article(app: App, p: PostRow, heading: "h1" | "h2"): string {
  const title = heading === "h2" ? `<a href="${escapeHtml(newsUrls(app).post(p.id))}">${escapeHtml(p.title)}</a>` : escapeHtml(p.title);
  return `<article class="card"><${heading}>${title}</${heading}>
<p class="meta"><time datetime="${escapeHtml(p.published_at ?? "")}">${day(p.published_at)}</time></p>
${renderNewsBody(p.body)}
</article>`;
}

function feedLinks(app: App): string {
  const { feed } = newsUrls(app);
  // The shared page style draws every list item as a card; a post's own lists are plain bullets.
  return `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(NEWS_TITLE)}" href="${escapeHtml(feed)}">
<style>article ul{margin:.5rem 0;padding-left:1.4rem}article li{background:none;border:0;border-radius:0;box-shadow:none;padding:0;margin:.15rem 0}</style>\n`;
}

export function renderNewsPage(app: App): string {
  const { feed } = newsUrls(app);
  const posts = publishedPosts(app, FEED_POSTS);
  return pageShell({
    title: NEWS_TITLE, indexable: true, head: feedLinks(app),
    body: `<header><h1>${escapeHtml(NEWS_TITLE)}</h1>
<p class="about">What's new on this ${PRODUCT_NAME}. Every PURSS here follows it; any feed reader can too.</p>
<p class="acts"><a class="btn sm feed" href="${escapeHtml(feed)}">Atom feed</a></p></header>
<main>${posts.length ? posts.map((p) => article(app, p, "h2")).join("\n") : `<p class="empty">No news yet.</p>`}</main>`,
  });
}

export function renderNewsPostPage(app: App, p: PostRow): string {
  const { page } = newsUrls(app);
  return pageShell({
    title: `${p.title} · ${NEWS_TITLE}`, indexable: true, head: feedLinks(app),
    body: `<header><p class="by"><a href="${escapeHtml(page)}">${escapeHtml(NEWS_TITLE)}</a></p></header>
<main>${article(app, p, "h1")}</main>`,
  });
}

export function renderNewsAtom(app: App): string {
  const { page, feed, post } = newsUrls(app);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const posts = publishedPosts(app, FEED_POSTS);
  const updated = posts.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), posts[0]?.published_at ?? "1970-01-01T00:00:00.000Z");
  const entries = posts.map((p) => `  <entry>
    <id>urn:uuid:${uuidFrom(`news:${app.config.publicOrigin}:${p.id}`, sha)}</id>
    <title>${escapeXml(p.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(post(p.id))}"/>
    <published>${escapeXml(p.published_at!)}</published>
    <updated>${escapeXml(p.updated_at)}</updated>
    <content type="html">${escapeXml(renderNewsBody(p.body))}</content>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:uuid:${uuidFrom(`news:${app.config.publicOrigin}`, sha)}</id>
  <title>${escapeXml(NEWS_TITLE)}</title>
  <updated>${escapeXml(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feed)}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(page)}"/>
  <author><name>${escapeXml(PRODUCT_NAME)}</name></author>
  <generator>${PRODUCT_NAME}</generator>
${entries}
</feed>
`;
}
