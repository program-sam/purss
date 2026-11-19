import { lookUpPostPictures, parseBlueskyPostUrl, postKey } from "@purss/connectors";
import type { LookupOptions, PostRef } from "@purss/connectors";
import { emit, type App } from "../app.ts";
import { usableAccountSql } from "./deletion.ts";

/*
 * The pictures of Bluesky posts. The feed FreshRSS collects for an account carries a post's text and none of what is attached, so a
 * post of a cartoon would arrive as a caption. Once a post is here its picture is asked of Bluesky's public API, a batch at a time, and set as the
 * item's picture. It is optional and never in the way: it runs after the sync that brought the posts, looks only at recent ones, tries a post
 * three times at most, and a failure, a slow answer or a deleted post leaves the item as it was. No post is added or changed here besides its picture.
 */

/** Posts looked at in one pass, and how new they must be: older ones are left as they are. */
export const PASS_POSTS = 50;
const RECENT_SECONDS = 3 * 86_400;
export const MAX_TRIES = 3;
/** A post that could not be learned about is asked again after this long. */
const RETRY_SECONDS = 15 * 60;
/** One pass at a time, and not more than one in a while. */
const MIN_GAP_MS = 20_000;

const running = new WeakSet<App>();
const lastRun = new WeakMap<App, number>();

export type BlueskyPassOptions = Pick<LookupOptions, "fetch" | "handles" | "testAllowAddress" | "resolver" | "testTlsCa"> & { now?: () => number; ignoreGap?: boolean };

/**
 * Ask for the pictures of the Bluesky posts that still have none; returns how many items got one. Never throws.
 * `image_url` is only set where it is empty, so a picture the feed or the person gave is never replaced.
 */
export async function lookUpBlueskyPictures(app: App, opts: BlueskyPassOptions = {}): Promise<number> {
  const now = (opts.now ?? Date.now)();
  if (running.has(app) || (!opts.ignoreGap && now - (lastRun.get(app) ?? 0) < MIN_GAP_MS)) return 0;
  running.add(app);
  lastRun.set(app, now);
  try {
    const rows = app.db.all<{ id: string; url: string; embed_tries: number; account_id: string; source_id: string }>(
      `SELECT i.id, i.url, i.embed_tries, i.account_id, i.source_id FROM items i
       WHERE i.kind = 'post' AND i.image_url IS NULL AND i.embed_tries < ? AND i.discovered_at > ? AND (i.embed_at IS NULL OR i.embed_at < ?)
         AND i.url LIKE 'https://bsky.app/profile/%/post/%' AND ${usableAccountSql("i.account_id")}
       ORDER BY i.discovered_at DESC LIMIT ?`,
      MAX_TRIES, new Date(now - RECENT_SECONDS * 1000).toISOString(), new Date(now - RETRY_SECONDS * 1000).toISOString(), PASS_POSTS);
    const asked: { id: string; ref: PostRef; tries: number; accountId: string; sourceId: string }[] = [];
    for (const r of rows) {
      const ref = parseBlueskyPostUrl(r.url);
      if (ref) asked.push({ id: r.id, ref, tries: r.embed_tries, accountId: r.account_id, sourceId: r.source_id });
      else app.db.run("UPDATE items SET embed_tries = ? WHERE id = ?", MAX_TRIES, r.id); // not an address Bluesky answers for
    }
    if (!asked.length) return 0;
    const answers = await lookUpPostPictures(asked.map((a) => a.ref), { fetch: opts.fetch, handles: opts.handles, now: opts.now, testAllowAddress: opts.testAllowAddress, resolver: opts.resolver, testTlsCa: opts.testTlsCa });
    let set = 0;
    // Lists and open items were fetched before the pictures came: tell each account which of its sources changed.
    const shown = new Map<string, Set<string>>();
    const at = new Date((opts.now ?? Date.now)()).toISOString();
    for (const a of asked) {
      const answer = answers.get(postKey(a.ref));
      if (answer?.status === "found" || answer?.status === "gone") {
        const first = answer.status === "found" ? answer.pictures[0] : undefined;
        // A post answered for is done, with or without a picture.
        const got = app.db.run("UPDATE items SET image_url = COALESCE(image_url, ?), embed_tries = ?, embed_at = ? WHERE id = ?", first?.url ?? null, MAX_TRIES, at, a.id).changes > 0 && !!first;
        if (got) {
          set += 1;
          if (!shown.has(a.accountId)) shown.set(a.accountId, new Set());
          shown.get(a.accountId)!.add(a.sourceId);
        }
      } else {
        app.db.run("UPDATE items SET embed_tries = embed_tries + 1, embed_at = ? WHERE id = ?", at, a.id);
      }
    }
    for (const [accountId, sources] of shown) emit(app, accountId, { type: "items", sourceIds: [...sources], count: 0 });
    return set;
  } catch (err) {
    // A closed database (the app is stopping) is not worth a word; anything else is logged and the next pass tries again.
    if (!/not open/i.test(String((err as Error)?.message))) console.error("[api] looking up the pictures of Bluesky posts failed:", err);
    return 0;
  } finally {
    running.delete(app);
  }
}
