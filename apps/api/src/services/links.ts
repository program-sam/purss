import { newId } from "@purss/domain";
import type { BrowserCaptureResult, ItemDTO, ManualKeepResult, UrlLookup, WorkflowState } from "@purss/domain";
import { fetchLinkMetadata } from "@purss/connectors";
import type { LinkMetadata } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { badRequest, notFound, nowIso } from "../http.ts";
import { cleanBrowserHtml, queueCapture, saveBrowserCapture } from "./captures.ts";
import { markPaused, StorageFull } from "./storage.ts";
import { hueFor } from "./content.ts";
import { getItem, insertItem, reindex } from "./items.ts";
import { keepItem } from "./state.ts";
import { urlKey } from "./url-key.ts";

/*
 * Keeping a single link, with or without the text the person's browser captured (plan/24, plan/32),
 * and asking what the PURSS has for a page. All compare addresses by their key (url-key.ts),
 * within the principal's PURSS only. A link the PURSS doesn't have yet is asked what it calls
 * itself (Open Graph or oEmbed, through safeFetch) so it gets a real title, a picture and a site or
 * channel; when the page says nothing, the address stays the title. Its title can be changed later.
 */

export type MetadataLookup = (url: string) => Promise<LinkMetadata | null>;
const lookupPage: MetadataLookup = (url) => fetchLinkMetadata(url);

/** A web address typed or shared by a person: "example.org/a" means https; other schemes (ftp:, mailto:) are refused, not read as a host. */
export function parseWebAddress(raw: string): URL {
  // "host:8080" is an address with a port, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw) && !/^https?:/i.test(raw)) throw badRequest("Only web addresses can be kept.");
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw badRequest("That doesn't look like a web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest("Only web addresses can be kept.");
  if (!url.hostname) throw badRequest("That doesn't look like a web address.");
  return url;
}

/**
 * The PURSS's item for an address key: one already kept first, then one shown in lists
 * (a followed source or kept by hand), then the oldest. Items from an unfollowed source that were
 * never kept still count: keeping one again brings it back with its feed content.
 */
function findByKey(app: App, p: Principal, key: string): { id: string } | undefined {
  return app.db.get<{ id: string }>(
    `SELECT i.id FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.workspace_id = ? AND i.url_key = ?
     ORDER BY EXISTS (SELECT 1 FROM basket_items b WHERE b.item_id = i.id) DESC,
              (i.source_id IS NULL OR s.followed = 1 OR s.kind = 'manual') DESC, i.created_at, i.id
     LIMIT 1`, p.workspaceId, key);
}

/** The PURSS's item for an address: the one it already has, or a new saved link. Inside the caller's transaction. */
function itemForLink(app: App, p: Principal, url: URL, title: string | undefined, meta: LinkMetadata | null = null): { id: string; existing: boolean } {
  const key = urlKey(url.href);
  const found = key ? findByKey(app, p, key) : undefined;
  if (found) return { id: found.id, existing: true };
  let src = app.db.get<{ id: string }>("SELECT id FROM sources WHERE workspace_id = ? AND kind = 'manual'", p.workspaceId);
  if (!src) {
    const id = newId("src");
    app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, hue, health, created_at) VALUES (?, ?, ?, 'manual', 'Saved links', 'Kept by hand', ?, 'ok', ?)",
      id, p.accountId, p.workspaceId, hueFor("Saved links"), nowIso());
    src = { id };
  }
  const item = insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId: src.id, kind: meta?.kind ?? "link",
    title: title || meta?.title || url.hostname + url.pathname.replace(/\/$/, ""),
    url: url.href, author: meta?.author ?? meta?.siteName ?? null, summaryHtml: null, contentHtml: null, imageUrl: meta?.imageUrl ?? null, durationSeconds: null, doi: null, curatorNote: null,
    publishedAt: null, discoveredAt: nowIso(), enclosures: [], fresh: false, reason: "kept link",
  });
  return { id: item.id, existing: false };
}

const inBasket = (app: App, p: Principal, basketId: string, itemId: string) =>
  !!app.db.get("SELECT 1 FROM basket_items WHERE basket_id = ? AND item_id = ? AND workspace_id = ?", basketId, itemId, p.workspaceId);

/**
 * Keep a link in a basket. A page the PURSS already has is kept as that item, not a new one; only
 * a new one is looked up first, and a page that can't be read is no reason not to keep its address.
 */
export async function keepLink(app: App, p: Principal, input: { url: string; basketId: string; title?: string; readableText?: boolean }, lookup: MetadataLookup = lookupPage): Promise<ManualKeepResult> {
  const url = parseWebAddress(input.url);
  if (!app.db.get("SELECT 1 FROM baskets WHERE id = ? AND workspace_id = ?", input.basketId, p.workspaceId)) throw notFound("That basket");
  const key = urlKey(url.href);
  const meta = key && findByKey(app, p, key) ? null : await lookup(url.href).catch(() => null);
  return app.db.tx(() => {
    const item = itemForLink(app, p, url, input.title, meta);
    const alreadyInBasket = item.existing && inBasket(app, p, input.basketId, item.id);
    // keepItem checks that the basket is this PURSS's and does nothing if it's already there.
    const keep = keepItem(app, p, item.id, input.basketId);
    // "Keep readable text too": the person asked for the page's text whatever the basket does by itself.
    if (input.readableText && !keep.captureQueued) {
      try {
        // The page of an item from a private source is never fetched (queueCapture refuses too); the link itself is kept.
        if (app.db.get("SELECT 1 FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND s.is_private = 1", item.id)) {
          keep.captureNote ??= "Kept with its details. Readable copies aren't made for items from private sources.";
        } else {
          keep.captureQueued = queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: url.href });
        }
      } catch (err) {
        if (!(err instanceof StorageFull)) throw err;
        markPaused(app, err);
        keep.captureNote ??= "Kept with its details. A readable copy wasn't made because storage is full.";
      }
    }
    return { itemId: item.id, existing: item.existing, alreadyInBasket, ...keep };
  });
}

/**
 * Keep a page with the readable text the person's browser extracted from it (plan/32). The HTML is
 * sanitized again here and the server fetches nothing. The text is stored before keeping, so a
 * "Save readable text" basket doesn't also queue a server fetch of the same page; when the text
 * doesn't fit in storage the link is still kept and the result says why the text wasn't.
 */
export function keepWithBrowserCapture(app: App, p: Principal, input: { url: string; basketId: string; title?: string; html: string }): BrowserCaptureResult {
  const url = parseWebAddress(input.url);
  const clean = cleanBrowserHtml(input.html);
  if (!clean) throw badRequest("No readable text came with the page, so nothing was kept.", "no_text");
  return app.db.tx(() => {
    const item = itemForLink(app, p, url, input.title);
    const alreadyInBasket = item.existing && inBasket(app, p, input.basketId, item.id);
    // Check the basket first, so a wrong one stores nothing.
    if (!app.db.get("SELECT 1 FROM baskets WHERE id = ? AND workspace_id = ?", input.basketId, p.workspaceId)) throw notFound("That basket");
    const text = saveBrowserCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: url.href, title: input.title || null, ...clean });
    const keep = keepItem(app, p, item.id, input.basketId);
    return { itemId: item.id, existing: item.existing, alreadyInBasket, ...keep, textSaved: text.saved, textReplaced: text.replaced, textNote: text.note };
  });
}

const bareHost = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Does the page live under the site address (same host, ignoring "www.", and within its path)? */
export function underSite(page: URL, siteUrl: string): boolean {
  let site: URL;
  try { site = new URL(siteUrl); } catch { return false; }
  if (site.protocol !== "http:" && site.protocol !== "https:") return false;
  if (bareHost(site.hostname) !== bareHost(page.hostname)) return false;
  const base = site.pathname.replace(/\/+$/, "");
  return base === "" || page.pathname === base || page.pathname.startsWith(`${base}/`);
}

/** What the PURSS has for a page: the item (if any) and followed sources whose site contains it. */
export function lookupUrl(app: App, p: Principal, raw: string): UrlLookup {
  const url = parseWebAddress(raw);
  const key = urlKey(url.href);
  const found = key ? findByKey(app, p, key) : undefined;
  let item: UrlLookup["item"] = null;
  if (found) {
    const row = app.db.get<{ id: string; title: string; url: string | null; workflow: WorkflowState }>(
      "SELECT i.id, i.title, i.url, st.workflow FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.id = ? AND i.workspace_id = ?", found.id, p.workspaceId)!;
    const baskets = app.db.all<{ id: string; name: string }>(
      "SELECT b.id, b.name FROM basket_items bi JOIN baskets b ON b.id = bi.basket_id WHERE bi.item_id = ? AND b.workspace_id = ? ORDER BY b.position, b.name", found.id, p.workspaceId)
      .map((b) => ({ id: b.id, name: b.name }));
    const captured = app.db.get<{ at: string | null }>("SELECT completed_at AS at FROM captures WHERE item_id = ? AND kind = 'browser' AND status = 'done'", found.id);
    item = { ...row, baskets, browserCapturedAt: captured?.at ?? null };
  }
  // Private sources have no stored feed address; their site address (if any) is the publisher's public page.
  const followedSources = app.db.all<{ id: string; title: string; site_url: string | null }>(
    "SELECT id, title, site_url FROM sources WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual' AND site_url IS NOT NULL ORDER BY title", p.workspaceId)
    .filter((s) => underSite(url, s.site_url!)).map((s) => ({ id: s.id, title: s.title }));
  return { item, followedSources };
}

/** Change the title of a link kept by hand. Followed sources' titles are the publisher's and stay as they arrived. */
export function renameKeptLink(app: App, p: Principal, itemId: string, title: string): ItemDTO {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) throw badRequest("A title can't be empty.");
  const owned = app.db.get<{ kind: string }>(
    "SELECT s.kind FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ? AND i.workspace_id = ?", itemId, p.workspaceId);
  if (!owned) throw notFound("That item");
  if (owned.kind !== "manual") throw badRequest("Only links you kept by hand can be renamed here.", "not_renamable");
  app.db.tx(() => {
    app.db.run("UPDATE items SET title = ?, updated_at = ? WHERE id = ?", clean.slice(0, 300), nowIso(), itemId);
    reindex(app, itemId);
  });
  emit(app, p.accountId, { type: "items", sourceIds: [], count: 0 });
  return getItem(app, p, itemId);
}
