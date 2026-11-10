/*
 * Addresses: the pages the extension looks at and the deep links it opens in the PURSS (plan/32).
 * The PURSS's own address follows the rule shared with the apps (parseWorkspaceAddress in
 * @purss/domain). Pure functions, tested in address.test.ts.
 */
import { appUrl } from "@purss/domain/paths";

/** A page the extension can offer to keep or look up: a web page, and not the PURSS itself. */
export function isWebPage(url: string | undefined, workspaceOrigin: string | null): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin !== workspaceOrigin;
  } catch {
    return false;
  }
}

/** A page's address without its fragment, for caching what the PURSS said about it. */
export function withoutFragment(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

/** The PURSS's limits on what a deep link carries (apps/web/src/routes.tsx). */
const URL_MAX = 2000;
const TITLE_MAX = 300;
const QUERY_MAX = 200;

/**
 * Deep links into the PURSS: Add source filled in (nothing is looked up until the person presses
 * Find), Keep this page (after picking a basket), search. Null when the page's address is too long
 * to hand over.
 */
export function deepLink(origin: string, link: { kind: "add" | "keep"; url: string; title?: string } | { kind: "search"; q: string }): string | null {
  const p = new URLSearchParams({ dialog: link.kind });
  if (link.kind === "search") {
    p.set("q", link.q.trim().slice(0, QUERY_MAX));
  } else {
    if (link.url.length > URL_MAX) return null;
    p.set("url", link.url);
    const title = link.kind === "keep" ? link.title?.trim().slice(0, TITLE_MAX) : undefined;
    if (title) p.set("title", title);
  }
  return `${origin}${appUrl("/")}?${p}`;
}

/** Where your PURSS shows a kept item. */
export function itemLink(origin: string, itemId: string, basketId: string | null): string {
  const path = basketId ? `/b/${encodeURIComponent(basketId)}` : "/";
  return `${origin}${appUrl(path)}?${new URLSearchParams({ item: itemId })}`;
}
