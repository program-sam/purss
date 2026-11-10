import { z } from "zod";

/** The installation's own news: posts its administrators write for everyone on it. */

export const NEWS_TITLE_MAX = 200;
export const NEWS_BODY_MAX = 20_000;

/** A new post or an edit. `publish` puts a draft out; a published post stays published when edited. */
export const newsPostInputSchema = z.object({
  title: z.string().trim().min(1).max(NEWS_TITLE_MAX),
  body: z.string().trim().min(1).max(NEWS_BODY_MAX),
  publish: z.boolean().default(false),
});
export type NewsPostInput = z.infer<typeof newsPostInputSchema>;

/** How a published post fared, counted over the PURSSes it was put into. Counts only, never who. */
export type NewsPostStats = {
  /** PURSSes it was put into. */
  delivered: number;
  /** Copies opened, or marked In progress or Finished. */
  read: number;
  /** Copies in at least one basket. */
  kept: number;
  /** Copies marked Ignored. */
  ignored: number;
  /** Copies their owner has since deleted (or whose account is gone): their reading is no longer known. */
  removed: number;
};

export type NewsPostDTO = {
  id: string;
  title: string;
  body: string;
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** The post's public page; null for a draft. */
  url: string | null;
  stats: NewsPostStats | null;
};

export type NewsAdminDTO = {
  /** The news source's name in every PURSS. */
  title: string;
  pageUrl: string;
  feedUrl: string;
  /** PURSSes following the news source now, and those that unfollowed it. */
  audience: { following: number; unfollowed: number };
  posts: NewsPostDTO[];
};
