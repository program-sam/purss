import assert from "node:assert/strict";
import { test } from "node:test";
import { lookUpPostPictures, parseBlueskyPostUrl, POSTS_PER_LOOKUP, readPostPictures } from "./bluesky.ts";
import type { PostRef } from "./bluesky.ts";
import { fakeFailure, fakeResponse } from "./testing.ts";
import type { SafeFetchResult } from "./safe-fetch.ts";
import { MAX_URL_LENGTH, safeFetch } from "./safe-fetch.ts";

const DID = "did:plc:oflombnj6v6xyohhatfkbzyd";
const image = (id: string, alt = "A cartoon") => ({ thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${id}`, fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/${DID}/${id}`, alt });

test("a post's address is read the way Bluesky's feed writes it, and nothing else is a post", () => {
  assert.deepEqual(parseBlueskyPostUrl("https://bsky.app/profile/tomgauld.bsky.social/post/3n2ehqj3hxs26"), { actor: "tomgauld.bsky.social", rkey: "3n2ehqj3hxs26" });
  assert.deepEqual(parseBlueskyPostUrl(`https://bsky.app/profile/${DID}/post/3n2ehqj3hxs26?x=1`), { actor: DID, rkey: "3n2ehqj3hxs26" });
  assert.deepEqual(parseBlueskyPostUrl("https://www.bsky.app/profile/Tom.Example.COM/post/3n2ehqj3hxs26/"), { actor: "tom.example.com", rkey: "3n2ehqj3hxs26" });
  for (const bad of [null, "", "https://bsky.app/profile/tom.bsky.social", "https://bsky.app/profile/tom.bsky.social/post/", "http://bsky.app/profile/tom.bsky.social/post/3n2ehqj3hxs26",
    "https://evil.example/profile/tom.bsky.social/post/3n2ehqj3hxs26", "https://bsky.app/profile/not a handle/post/3n2ehqj3hxs26", "https://bsky.app/profile/localhost/post/3n2ehqj3hxs26", "https://bsky.app/profile/tom.bsky.social/post/../x"]) {
    assert.equal(parseBlueskyPostUrl(bad), null, String(bad));
  }
});

test("the pictures of a post: its images, a video's still, a link card's picture, or the media of a quote with media", () => {
  const url = (p: { url: string }) => p.url;
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.images#view", images: [image("a"), image("b", "")] } }).map((p) => [p.url, p.alt]),
    [[image("a").thumb, "A cartoon"], [image("b").thumb, null]]);
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.video#view", thumbnail: "https://video.cdn.bsky.app/hls/x/thumbnail.jpg", alt: "A boat" } }).map((p) => [p.url, p.alt]), [["https://video.cdn.bsky.app/hls/x/thumbnail.jpg", "A boat"]]);
  assert.deepEqual(readPostPictures({ embed: { external: { uri: "https://x.example", title: "T", thumb: "https://cdn.bsky.app/img/feed_thumbnail/plain/d/c" } } }).map(url), ["https://cdn.bsky.app/img/feed_thumbnail/plain/d/c"]);
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.recordWithMedia#view", record: { record: { uri: "at://x" } }, media: { images: [image("m")] } } }).map(url), [image("m").thumb]);
  assert.deepEqual(readPostPictures({ embed: { images: new Array(9).fill(image("z")) } }).length, 4, "no more than the four a post may carry");
  assert.deepEqual(readPostPictures({}), []);
  assert.deepEqual(readPostPictures(null), []);
  // Only Bluesky's own https picture hosts count, whatever the answer says.
  assert.deepEqual(readPostPictures({ embed: { images: [{ thumb: "https://evil.example/x.jpg", fullsize: "http://cdn.bsky.app/x.jpg" }, { thumb: "javascript:alert(1)" }, { thumb: "https://u:p@cdn.bsky.app/x.jpg" }, { thumb: `https://cdn.bsky.app/${"a".repeat(2100)}` }, { thumb: 5 }] } }), []);
});

// The shapes the public API gives a post that quotes another (checked against its answers): the quoted post is a `viewRecord`, and what it carries is in its `embeds`.
const quoteOf = (...embeds: unknown[]) => ({ $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewRecord", uri: "at://did:plc:other/app.bsky.feed.post/3kq", embeds } });
const imagesView = (...ids: string[]) => ({ $type: "app.bsky.embed.images#view", images: ids.map((id) => image(id)) });

test("a post that quotes another with pictures and has none of its own shows the quoted post's", () => {
  const url = (p: { url: string }) => p.url;
  assert.deepEqual(readPostPictures({ embed: quoteOf(imagesView("drawing1", "drawing2")) }).map(url), [image("drawing1").thumb, image("drawing2").thumb], "images of the quoted post");
  assert.deepEqual(readPostPictures({ embed: quoteOf({ $type: "app.bsky.embed.video#view", thumbnail: "https://video.cdn.bsky.app/hls/x/thumbnail.jpg", alt: "A boat" }) }).map((p) => [p.url, p.alt]), [["https://video.cdn.bsky.app/hls/x/thumbnail.jpg", "A boat"]], "a video's still");
  assert.deepEqual(readPostPictures({ embed: quoteOf({ $type: "app.bsky.embed.external#view", external: { uri: "https://x.example", title: "T", thumb: "https://cdn.bsky.app/img/feed_thumbnail/plain/d/c" } }) }).map(url), ["https://cdn.bsky.app/img/feed_thumbnail/plain/d/c"], "a link card's picture");
  assert.deepEqual(readPostPictures({ embed: quoteOf({ $type: "app.bsky.embed.recordWithMedia#view", record: { record: { uri: "at://x" } }, media: imagesView("inner") }) }).map(url), [image("inner").thumb], "the media a quoted post carries beside its own quote");
  assert.deepEqual(readPostPictures({ embed: quoteOf({ $type: "app.bsky.embed.external#view", external: { uri: "https://x.example" } }, imagesView("second")) }).map(url), [image("second").thumb], "the first of its embeds that has a picture");
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.recordWithMedia#view", record: quoteOf(imagesView("quoted")), media: { $type: "app.bsky.embed.external#view", external: { uri: "https://x.example" } } } }).map(url), [image("quoted").thumb], "a quote with media that has no picture shows the quoted post's");
});

test("a post's own pictures come before those of the post it quotes, and nothing deeper or stranger is read", () => {
  const url = (p: { url: string }) => p.url;
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.recordWithMedia#view", record: quoteOf(imagesView("quoted")), media: imagesView("mine") } }).map(url), [image("mine").thumb], "the author's own media, beside the quote");
  assert.deepEqual(readPostPictures({ embed: quoteOf(quoteOf(imagesView("deep"))) }), [], "what the quoted post itself quotes is not read");
  assert.deepEqual(readPostPictures({ embed: quoteOf() }), [], "a quoted post with no pictures");
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewNotFound", uri: "at://x", notFound: true } } }), [], "a quoted post that is gone");
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.embed.record#viewBlocked", uri: "at://x", blocked: true } } }), [], "a quoted post that is blocked");
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.record#view", record: { $type: "app.bsky.graph.defs#starterPackViewBasic", uri: "at://x", record: { embeds: [imagesView("not-a-post")] } } } }), [], "a starter pack or list is not a post");
  assert.deepEqual(readPostPictures({ embed: quoteOf({ images: [{ thumb: "https://evil.example/x.jpg" }] }) }), [], "only Bluesky's own picture hosts count in a quoted post too");
  assert.deepEqual(readPostPictures({ embed: { $type: "app.bsky.embed.record#view", record: { uri: "at://x", embeds: "images" } } }), []);
});

function api(routes: { resolve?: (handle: string) => { status: number; body: unknown }; posts: (uris: string[]) => unknown[] | null }) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<SafeFetchResult> => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("com.atproto.identity.resolveHandle")) {
      const r = routes.resolve?.(u.searchParams.get("handle")!) ?? { status: 200, body: { did: DID } };
      return fakeResponse(url, JSON.stringify(r.body), "application/json", r.status);
    }
    const posts = routes.posts(u.searchParams.getAll("uris"));
    return posts ? fakeResponse(url, JSON.stringify({ posts }), "application/json") : fakeFailure("unreachable");
  };
  return { fetch, calls };
}

test("posts are asked about a batch at a time, a handle once, and each answer is its own: found, gone, or unknown", async () => {
  const refs: PostRef[] = [{ actor: "tomgauld.bsky.social", rkey: "3aaaaaaaaaaaa" }, { actor: "tomgauld.bsky.social", rkey: "3bbbbbbbbbbbb" }, { actor: "tomgauld.bsky.social", rkey: "3cccccccccccc" }, { actor: DID, rkey: "3dddddddddddd" }];
  const { fetch, calls } = api({ posts: (uris) => uris.filter((u) => !u.endsWith("3cccccccccccc")).map((uri) => ({ uri, embed: uri.endsWith("3aaaaaaaaaaaa") ? { images: [image("a")] } : null })) });
  const answers = await lookUpPostPictures(refs, { fetch, handles: new Map() });
  assert.deepEqual(answers.get("tomgauld.bsky.social/3aaaaaaaaaaaa"), { status: "found", pictures: [{ url: image("a").thumb, alt: "A cartoon" }] });
  assert.deepEqual(answers.get("tomgauld.bsky.social/3bbbbbbbbbbbb"), { status: "found", pictures: [] }, "a post with nothing attached is answered too");
  assert.deepEqual(answers.get("tomgauld.bsky.social/3cccccccccccc"), { status: "gone" });
  assert.deepEqual(answers.get(`${DID}/3dddddddddddd`), { status: "found", pictures: [] });
  assert.equal(calls.filter((c) => c.includes("resolveHandle")).length, 1, "the handle is resolved once, the DID not at all");
  assert.equal(calls.filter((c) => c.includes("getPosts")).length, 1);
  assert.ok(calls.every((c) => c.startsWith("https://public.api.bsky.app/xrpc/")), "only the public API is asked");
  assert.ok(calls.find((c) => c.includes("getPosts"))!.includes(`uris=${encodeURIComponent(`at://${DID}/app.bsky.feed.post/3aaaaaaaaaaaa`)}`));
});

test("posts are asked in batches that fit an address safeFetch accepts (25 post addresses don't); a failed batch leaves its posts unknown and the rest answered", async () => {
  const refs = Array.from({ length: 60 }, (_, i) => ({ actor: DID, rkey: `3${String(i).padStart(12, "a")}` }));
  let n = 0;
  const { fetch, calls } = api({ posts: (uris) => (++n === 2 ? null : uris.map((uri) => ({ uri }))) });
  const answers = await lookUpPostPictures(refs, { fetch });
  const sizes = calls.map((c) => new URL(c).searchParams.getAll("uris").length);
  assert.ok(calls.every((c) => c.length <= MAX_URL_LENGTH), "every address is short enough for safeFetch");
  assert.ok(sizes.every((k) => k <= POSTS_PER_LOOKUP));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 60, "every post is asked about once");
  assert.ok(sizes[0]! > 15, "batches are as full as the address allows");
  const statuses = refs.map((r) => answers.get(`${r.actor}/${r.rkey}`)!.status);
  assert.equal(statuses.filter((s) => s === "unknown").length, sizes[1], "the failed batch's posts stay unknown");
  assert.equal(statuses.filter((s) => s === "found").length, 60 - sizes[1]!);
});

test("through the real safeFetch, a full batch is not refused for its length", async () => {
  const refs = Array.from({ length: POSTS_PER_LOOKUP }, (_, i) => ({ actor: DID, rkey: `3${String(i).padStart(12, "z")}` }));
  const seen: string[] = [];
  // The real address check runs first; only an address it accepts reaches the (fake) network.
  const fetch = (async (url: string, opts: Parameters<typeof safeFetch>[1]) => {
    if (url.length > MAX_URL_LENGTH) return safeFetch(url, opts);
    seen.push(url);
    return fakeResponse(url, JSON.stringify({ posts: new URL(url).searchParams.getAll("uris").map((uri) => ({ uri })) }), "application/json");
  }) as typeof safeFetch;
  const answers = await lookUpPostPictures(refs, { fetch });
  assert.ok(refs.every((r) => answers.get(`${r.actor}/${r.rkey}`)!.status === "found"), "no post is left unknown because its batch was too long");
  assert.ok(seen.length >= 2);
});
test("a handle nobody has is gone; a handle that could not be asked leaves its posts unknown; an aborted lookup asks nothing more", async () => {
  const refs: PostRef[] = [{ actor: "nobody.example.com", rkey: "3aaaaaaaaaaaa" }, { actor: "flaky.example.com", rkey: "3bbbbbbbbbbbb" }];
  const { fetch } = api({ resolve: (h) => (h.startsWith("nobody") ? { status: 400, body: { error: "InvalidRequest", message: "Unable to resolve handle" } } : { status: 502, body: {} }), posts: () => [] });
  const answers = await lookUpPostPictures(refs, { fetch, handles: new Map() });
  assert.deepEqual(answers.get("nobody.example.com/3aaaaaaaaaaaa"), { status: "gone" });
  assert.deepEqual(answers.get("flaky.example.com/3bbbbbbbbbbbb"), { status: "unknown" });
  const counted = api({ posts: () => [] });
  const aborted = await lookUpPostPictures([{ actor: "tom.example.com", rkey: "3aaaaaaaaaaaa" }], { fetch: counted.fetch, handles: new Map(), signal: AbortSignal.abort() });
  assert.deepEqual(aborted.get("tom.example.com/3aaaaaaaaaaaa"), { status: "unknown" });
  assert.equal(counted.calls.length, 0);
});

test("the lookup goes through safeFetch's address rules: if the API's name pointed into a private network, nothing is asked and nothing is learned", async () => {
  const answers = await lookUpPostPictures([{ actor: DID, rkey: "3aaaaaaaaaaaa" }, { actor: "tom.example.com", rkey: "3bbbbbbbbbbbb" }], { resolver: async () => ["10.0.0.5"], handles: new Map() });
  assert.deepEqual([...answers.values()], [{ status: "unknown" }, { status: "unknown" }]);
});
