import type { DiscoveryCandidate } from "@purss/domain";
import type { App } from "../app.ts";
import { PRODUCT_NAME } from "./public-pages.ts";

/*
 * The installation's news by its addresses (services/news.ts has the rest). Kept apart, with nothing but the database
 * behind it, so discovery, OPML and archive imports can recognise the news without importing the delivery code (which
 * would close an import cycle through items, notifications and home).
 */

export const NEWS_TITLE = `${PRODUCT_NAME} news`;
/** What a PURSS receives of what was already published when it gets the news source or follows it again. */
export const NEWS_INITIAL_POSTS = 3;

export function newsUrls(app: App) {
  const origin = app.config.publicOrigin;
  return { page: `${origin}/news`, feed: `${origin}/news/feed.atom`, post: (id: string) => `${origin}/news/${id}` };
}

export function isNewsFeed(app: App, feedUrl: string): boolean {
  return feedUrl === newsUrls(app).feed;
}

export function publishedNews(app: App, limit: number): { id: string; title: string; body: string; status: "published"; created_at: string; updated_at: string; published_at: string }[] {
  return app.db.all("SELECT * FROM news_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ?", limit);
}

/** This installation's news page or feed address, as a discovery preview: nothing is fetched (the engine never fetches it). */
export function newsCandidate(app: App, url: string): Omit<DiscoveryCandidate, "token" | "alreadyFollowingSourceId"> | null {
  const { page, feed } = newsUrls(app);
  const u = url.trim().replace(/\/+$/, "");
  if (u !== page && u !== feed) return null;
  return {
    title: NEWS_TITLE, kind: "feed", origin: `News from this ${PRODUCT_NAME}`, via: "News feed", feedUrl: feed, siteUrl: page, cadence: null,
    samples: publishedNews(app, 3).map((p) => ({ title: p.title, publishedAt: p.published_at })), summariesOnly: false, privateWarning: null,
  };
}
