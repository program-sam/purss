import test from "node:test";
import assert from "node:assert/strict";
import { server } from "@purss/translations/server";
import type { SafeFetchOptions, SafeFetchResult } from "@purss/connectors";
import { fakeFailure, fakeResponse } from "../../../../packages/connectors/src/testing.ts";
import { inHtml } from "../translations-testing.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { lookUpBlueskyPictures, MAX_TRIES } from "./bluesky.ts";
import { getItemDetail, listItems } from "./items.ts";
import { applySyncBatch } from "./sync.ts";

const DID = "did:plc:oflombnj6v6xyohhatfkbzyd";
const post = (n: number, handle = "tomgauld.bsky.social") => `https://bsky.app/profile/${handle}/post/3n2ehqj3hxs${String(n).padStart(2, "0")}`;
const rkey = (n: number) => `3n2ehqj3hxs${String(n).padStart(2, "0")}`;

/** Bluesky's public API for the posts it is told about: `posts[rkey]` is the embed of that post, absent for one that is gone. */
function api(posts: Record<string, unknown>, opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, _o?: SafeFetchOptions): Promise<SafeFetchResult> => {
    calls.push(url);
    const respond = (body: unknown, status = 200): SafeFetchResult => fakeResponse(url, JSON.stringify(body), "application/json", status);
    if (opts.down) return fakeFailure("unreachable");
    const u = new URL(url);
    if (u.pathname.endsWith("resolveHandle")) return respond({ did: DID });
    return respond({ posts: u.searchParams.getAll("uris").flatMap((uri) => { const key = uri.split("/").pop()!; return key in posts ? [{ uri, embed: posts[key] }] : []; }) });
  };
  return { fetch, calls };
}

const pic = (id: string) => ({ images: [{ thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${id}`, fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/${DID}/${id}`, alt: "Three books" }] });

/** The posts a sync has just brought: the test entries carry dates of their own, so they are made to have arrived now. */
const arrived = (app: ReturnType<typeof makeTestApp>["app"]) => app.db.run("UPDATE items SET discovered_at = ? WHERE embed_tries = 0 AND discovered_at < ?", new Date().toISOString(), new Date(Date.now() - 86_400_000).toISOString());

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const src = makeSource(app, p, "@tomgauld.bsky.social - Tom Gauld", "feed/bsky");
  return { app, p, src, cleanup };
}

test("posts of a Bluesky account are posts, with their words as the title and nothing repeated under it", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const text = "Signing copies of three new prints for my webshop: www.tomgauld.com/shop and a few more words to make this post long enough to be cut";
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/bsky", { url: post(1), title: "", summaryHtml: "My latest books cartoon for @theguardian.com #tolkien" }),
    entry("feed/bsky", { url: post(2), title: "", summaryHtml: text }),
    entry("feed/bsky", { url: "https://example.org/an-article", title: "An article", summaryHtml: "<p>Words.</p>" }),
  ]));
  const items = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  assert.deepEqual(items.map((i) => i.kind), ["post", "post", "article"]);
  assert.equal(items[0]!.title, "My latest books cartoon for @theguardian.com #tolkien");
  assert.equal(items[0]!.excerpt, null, "a post that is only its title shows no second copy of it");
  assert.equal(items[1]!.title.endsWith("…"), true, "a long post is cut for its title");
  assert.ok(!items[1]!.excerpt!.startsWith(items[1]!.title.slice(0, 30)), "the excerpt goes on where the title stopped");
  assert.equal(`${items[1]!.title.slice(0, -1)}${items[1]!.excerpt!.startsWith(" ") ? "" : " "}${items[1]!.excerpt}`.replace(/\s+/g, " ").trim().replace(/…/g, ""), text, "title and excerpt together are the post, once");
  assert.equal(items[2]!.excerpt, "Words.");
});

test("the placeholder Bluesky's feed puts where a post has a quote or attachment becomes a clear short note", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/bsky", { url: post(1), title: "", summaryHtml: "SF folks, join us tonight!\n\n[contains quote post or other embedded content]" }),
    entry("feed/bsky", { url: post(2), title: "", summaryHtml: "[contains quote post or other embedded content]" }),
  ]));
  const [one, two] = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  assert.ok(!JSON.stringify([one, two]).includes("contains quote post"), "the upstream wording is not shown");
  const { embedLabel } = server.api.content;
  assert.equal(one!.title, `SF folks, join us tonight! ${embedLabel}`);
  assert.equal(two!.title, embedLabel);
  assert.ok((getItemDetail(app, p, one!.id).contentHtml ?? "").includes(inHtml(embedLabel)));
});

test("the picture of a post is asked of Bluesky once the post is here, and set only where the item has none", async (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/bsky", { url: post(1), title: "", summaryHtml: "A cartoon" }),
    entry("feed/bsky", { url: post(2), title: "", summaryHtml: "Words only" }),
    entry("feed/bsky", { url: post(3), title: "", summaryHtml: "Already has one", imageUrl: "https://cdn.example/own.jpg" }),
    entry("feed/bsky", { url: post(4), title: "", summaryHtml: "Deleted since" }),
    entry("feed/other", { url: "https://example.org/a", title: "Not a post" }),
  ]));
  arrived(app);
  const { fetch, calls } = api({ [rkey(1)]: pic("one"), [rkey(2)]: null, [rkey(3)]: pic("three") });
  const events: unknown[] = [];
  app.events.on(`account:${p.accountId}`, (m: unknown) => events.push(m));
  assert.equal(await lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() }), 1);
  assert.deepEqual(events.filter((m) => (m as { type: string }).type === "items"), [{ type: "items", sourceIds: [listItems(app, p, { scope: "all", limit: 50 }).items.find((i) => i.url === post(1))!.sourceId], count: 0 }],
    "the account's open lists are told the post now has a picture");
  const byUrl = (u: string) => listItems(app, p, { scope: "all", limit: 50 }).items.find((i) => i.url === u)!;
  assert.equal(byUrl(post(1)).imageUrl, `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/one`);
  assert.equal(byUrl(post(2)).imageUrl, null);
  assert.equal(byUrl(post(3)).imageUrl, "https://cdn.example/own.jpg", "a picture the feed gave is never replaced");
  assert.equal(byUrl(post(4)).imageUrl, null);
  // Cached: what has been answered is not asked again, and nothing outside Bluesky's posts is ever asked about.
  const before = calls.length;
  assert.equal(await lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() }), 0);
  assert.equal(calls.length, before, "a second pass asks nothing: every post was answered for");
  assert.equal(events.filter((m) => (m as { type: string }).type === "items").length, 1, "nothing new, nothing told");
  assert.ok(calls.every((c) => c.startsWith("https://public.api.bsky.app/xrpc/")));
  assert.ok(!calls.some((c) => c.includes("example.org")));
  assert.equal(src.length > 0, true);
});

test("a post that quotes a post with pictures gets the quoted post's picture; its own pictures come first", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/bsky", { url: post(1), title: "", summaryHtml: "I need Kaylin to hold up all of my drawings [contains quote post or other embedded content]" }),
    entry("feed/bsky", { url: post(2), title: "", summaryHtml: "Quoting, with my own picture [contains quote post or other embedded content]" }),
    entry("feed/bsky", { url: post(3), title: "", summaryHtml: "Quoting a post that is only words [contains quote post or other embedded content]" }),
  ]));
  arrived(app);
  const quote = (...embeds: unknown[]) => ({ $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewRecord", uri: "at://did:plc:other/app.bsky.feed.post/3kq", embeds } });
  const { fetch } = api({
    [rkey(1)]: quote({ $type: "app.bsky.embed.images#view", ...pic("drawings") }),
    [rkey(2)]: { $type: "app.bsky.embed.recordWithMedia#view", record: quote(pic("theirs")), media: { $type: "app.bsky.embed.images#view", ...pic("mine") } },
    [rkey(3)]: quote(),
  });
  assert.equal(await lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() }), 2);
  const byUrl = (u: string) => listItems(app, p, { scope: "all", limit: 50 }).items.find((i) => i.url === u)!;
  assert.equal(byUrl(post(1)).imageUrl, `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/drawings`, "the quoted post's picture");
  assert.equal(byUrl(post(2)).imageUrl, `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/mine`, "the post's own picture");
  assert.equal(byUrl(post(3)).imageUrl, null);
});

test("when Bluesky cannot be reached the items stay as they are, are tried a few times with a pause, and then left alone; the sync is never involved", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/bsky", { url: post(1), title: "", summaryHtml: "A cartoon" })]));
  arrived(app);
  const down = api({}, { down: true });
  let now = Date.now();
  const clock = () => now;
  for (let i = 1; i <= MAX_TRIES; i++) {
    assert.equal(await lookUpBlueskyPictures(app, { fetch: down.fetch, ignoreGap: true, now: clock, handles: new Map() }), 0);
    const row = app.db.get<{ embed_tries: number; image_url: string | null }>("SELECT embed_tries, image_url FROM items WHERE url = ?", post(1))!;
    assert.deepEqual([row.embed_tries, row.image_url], [i, null]);
    // Asked again at once: the pause has not passed, so nothing is asked.
    const asked = down.calls.length;
    await lookUpBlueskyPictures(app, { fetch: down.fetch, ignoreGap: true, now: clock, handles: new Map() });
    assert.equal(down.calls.length, asked, "a failed post waits before it is tried again");
    now += 20 * 60_000;
  }
  const after = down.calls.length;
  await lookUpBlueskyPictures(app, { fetch: down.fetch, ignoreGap: true, now: clock, handles: new Map() });
  assert.equal(down.calls.length, after, "after the last try the post is left alone");
  // Bluesky back: the item still reads as it did, and nothing was lost.
  assert.equal(listItems(app, p, { scope: "all", limit: 5 }).items[0]!.title, "A cartoon");
});

test("only recent posts are looked at, a pass is one at a time, and an account being deleted is skipped", async (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/bsky", { url: post(1), title: "", summaryHtml: "Old" }), entry("feed/bsky", { url: post(2), title: "", summaryHtml: "New" })]));
  arrived(app);
  app.db.run("UPDATE items SET discovered_at = ? WHERE url = ?", new Date(Date.now() - 10 * 86_400_000).toISOString(), post(1));
  const { fetch, calls } = api({ [rkey(1)]: pic("old"), [rkey(2)]: pic("new") });
  const first = lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() });
  const second = lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() });
  assert.equal(await second, 0, "a pass that finds another running does nothing");
  assert.equal(await first, 1);
  const asked = calls.filter((c) => c.includes("getPosts")).flatMap((c) => new URL(c).searchParams.getAll("uris"));
  assert.deepEqual(asked.map((u) => u.split("/").pop()), [rkey(2)], "the old post is not asked about");
  // Not before the gap has passed.
  applySyncBatch(app, p.engineUserId, batch([entry("feed/bsky", { url: post(3), title: "", summaryHtml: "Newer" })]));
  arrived(app);
  const n = calls.length;
  assert.equal(await lookUpBlueskyPictures(app, { fetch, handles: new Map() }), 0, "a pass right after another waits");
  assert.equal(calls.length, n);
  app.db.run("INSERT INTO account_deletions (account_id, request_id, requested_at, due_at, state) VALUES (?, 'adr_x', ?, ?, 'pending')", p.accountId, new Date().toISOString(), new Date().toISOString());
  assert.equal(await lookUpBlueskyPictures(app, { fetch, ignoreGap: true, handles: new Map() }), 0);
  assert.equal(calls.length, n, "nothing is asked for an account that is being deleted");
});
