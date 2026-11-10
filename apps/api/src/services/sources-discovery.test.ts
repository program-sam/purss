import test from "node:test";
import assert from "node:assert/strict";
import type { SafeFetchResult } from "@purss/connectors";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { createBasket } from "./collections.ts";
import { keepLink } from "./links.ts";
import { getSource, listSources, NO_POSTS_YET, onSubscribed, presentCandidates, searchPodcastDirectory } from "./sources.ts";
import { applySyncBatch, recordSyncSuccess } from "./sync.ts";

/** What the fetch layer returns for a page that answered. */
function fakeResponse(url: string, body: string, contentType: string, status = 200): SafeFetchResult {
  const buf = Buffer.from(body);
  return { ok: true, response: { url, requestedUrl: url, redirects: [], status, headers: { "content-type": contentType }, mediaType: contentType.split(";")[0]!, contentType, body: buf, bytes: buf.length, truncated: false, remoteAddress: null, fetchedAt: new Date().toISOString() } };
}

const draft = (over: { title: string; feedUrl: string }) => ({
  siteUrl: null, kind: "feed" as const, origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null, ...over,
});

test("a second source with the same name is pointed out, not blocked; the same feed is 'already followed'", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const existing = makeSource(app, p, "Football Weekly | The Guardian", "feed/fw");
  makeSource(app, p, "Kept links", "feed/manual", { kind: "manual" });
  const [apple, same, other, theSameFeed] = presentCandidates(app, p, [
    draft({ title: "Football Weekly", feedUrl: "https://feeds.example/football-weekly.xml" }),
    draft({ title: "football weekly", feedUrl: "https://other.example/fw.xml" }),
    draft({ title: "Football Weekly Extra", feedUrl: "https://other.example/extra.xml" }),
    draft({ title: "Football Weekly", feedUrl: "https://example.org/feed/fw.xml" }),
  ]);
  assert.equal(apple!.sameNameSource?.id, existing);
  assert.equal(apple!.sameNameSource?.title, "Football Weekly | The Guardian");
  assert.equal(apple!.alreadyFollowingSourceId, null);
  assert.equal(same!.sameNameSource?.id, existing);
  assert.equal(other!.sameNameSource, null, "a different name is a different source");
  assert.equal(theSameFeed!.alreadyFollowingSourceId, existing);
  assert.equal(theSameFeed!.sameNameSource, null, "following the very same feed is not 'a second source'");
  // Another account's sources never count.
  const q = makeOwner(app, { admin: false });
  assert.equal(presentCandidates(app, q, [draft({ title: "Football Weekly", feedUrl: "https://feeds.example/football-weekly.xml" })])[0]!.sameNameSource, null);
  // And an unfollowed source does not either.
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", existing);
  assert.equal(presentCandidates(app, p, [draft({ title: "Football Weekly", feedUrl: "https://feeds.example/football-weekly.xml" })])[0]!.sameNameSource, null);
});

test("a feed the engine fetched and found empty says 'No posts yet'; without that evidence the wording stays 'Collecting…'", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const waiting = (title: string, stream: string) => {
    const id = makeSource(app, p, title, stream, { settled: false });
    app.db.run("UPDATE sources SET health = 'pending', health_text = 'Collecting the first items…', engine_stream_id = NULL, subscribed_at = NULL WHERE id = ?", id);
    return id;
  };
  const empty = waiting("Slow start", "feed/1");
  const busy = waiting("Busy one", "feed/2");
  const unknown = waiting("Unknown", "feed/3");
  const recent = () => new Date(Date.now() - 3600_000).toISOString();

  // The engine confirms each subscription; for the first it also says the feed it just fetched has nothing in it.
  onSubscribed(app, empty, "feed/1", { empty: true });
  onSubscribed(app, busy, "feed/2", { empty: false });
  onSubscribed(app, unknown, "feed/3");
  const none = getSource(app, p, empty);
  assert.equal(none.health, "quiet");
  assert.equal(none.healthText, NO_POSTS_YET);
  assert.equal(listSources(app, p).find((s) => s.id === empty)!.healthText, NO_POSTS_YET);
  assert.equal(getSource(app, p, busy).health, "pending", "a feed with items is waiting for them, not empty");
  assert.equal(getSource(app, p, unknown).healthText, "Collecting the first items…");

  // Time alone proves nothing: a finished sync run, however long after, does not call a feed empty.
  app.db.run("UPDATE sources SET subscribed_at = ? WHERE id IN (?, ?)", new Date(Date.now() - 3600_000).toISOString(), busy, unknown);
  recordSyncSuccess(app, p.engineUserId);
  assert.equal(getSource(app, p, busy).health, "pending");
  assert.equal(getSource(app, p, unknown).health, "pending");
  assert.equal(getSource(app, p, unknown).healthText, "Collecting the first items…");

  // Its first post makes the empty one an ordinary source again; the busy one's arrival does the same for it.
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { publishedAt: recent() }), entry("feed/2", { publishedAt: recent() })]));
  assert.deepEqual([getSource(app, p, empty).health, getSource(app, p, empty).healthText], ["ok", null]);
  assert.equal(getSource(app, p, busy).health, "ok");

  // An unfollowed source or a subscription that failed is not touched by the evidence.
  const gone = waiting("Gone", "feed/4");
  app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", gone);
  onSubscribed(app, gone, "feed/4", { empty: true });
  assert.equal(app.db.get<{ health: string }>("SELECT health FROM sources WHERE id = ?", gone)!.health, "pending");
});

test("'Keep readable text too' saves the page's text even when the basket only keeps the details", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const basket = createBasket(app, p, { name: "Later", captureMode: "metadata" }).id;
  const lookup = async () => null;
  const plain = await keepLink(app, p, { url: "https://example.org/a", basketId: basket }, lookup);
  assert.equal(plain.captureQueued, false);
  const readable = await keepLink(app, p, { url: "https://example.org/b", basketId: basket, readableText: true }, lookup);
  assert.equal(readable.captureQueued, true);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE item_id = ? AND status = 'pending'", readable.itemId)!.n, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE item_id = ?", plain.itemId)!.n, 0);
  // Asking again for a page that already has a capture queues nothing more.
  const again = await keepLink(app, p, { url: "https://example.org/b", basketId: basket, readableText: true }, lookup);
  assert.equal(again.captureQueued, false);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE item_id = ?", readable.itemId)!.n, 1);
  // A basket that saves text by itself still does, without the box.
  const text = createBasket(app, p, { name: "Reading", captureMode: "text" }).id;
  assert.equal((await keepLink(app, p, { url: "https://example.org/c", basketId: text }, lookup)).captureQueued, true);
});

test("podcast search: Apple's directory answers with shows, and a failure says so in plain words", async () => {
  const body = JSON.stringify({ resultCount: 2, results: [
    { collectionName: "Football Weekly", artistName: "The Guardian", artworkUrl100: "https://is1.example/100.jpg", feedUrl: "https://www.theguardian.com/football/series/footballweekly/podcast.xml", primaryGenreName: "Soccer" },
    { collectionName: "No feed", artistName: "X" },
  ] });
  const ok = await searchPodcastDirectory("football weekly", { fetch: async (url) => fakeResponse(url, body, "application/json") });
  assert.ok(ok.ok);
  assert.deepEqual(ok.hits.map((h) => [h.name, h.author, h.artworkUrl]), [["Football Weekly", "The Guardian", "https://is1.example/100.jpg"]]);
  const down = await searchPodcastDirectory("football weekly", { fetch: async (url) => fakeResponse(url, "oops", "text/html", 503) });
  assert.ok(!down.ok);
  assert.match(down.message, /Apple's podcast directory/);
});
