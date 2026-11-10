import assert from "node:assert/strict";
import { test } from "node:test";
import { searchPodcasts } from "./podcast-search.ts";
import { allowLoopback, fakeFailure, fakeResponse, send, startServer } from "./testing.ts";
import type { FetchFn } from "./discover.ts";

const row = (over: Record<string, unknown>) => ({ collectionName: "Show", artistName: "Maker", artworkUrl100: "https://img.example/100.jpg", feedUrl: "https://feeds.example/show.xml", primaryGenreName: "Sport", ...over });
const answer = (...rows: Record<string, unknown>[]): FetchFn => async (url) => fakeResponse(url, JSON.stringify({ resultCount: rows.length, results: rows }), "text/javascript; charset=utf-8");

test("hits carry the name, author, picture and the show's own feed; shows without a feed address are left out", async () => {
  const out = await searchPodcasts("football weekly", { fetch: answer(
    row({ collectionName: "Football Weekly", artistName: "The Guardian", feedUrl: "https://www.theguardian.com/football/series/footballweekly/podcast.xml" }),
    row({ collectionName: "Gone", feedUrl: undefined }),
    row({ collectionName: "Ftp feed", feedUrl: "ftp://feeds.example/x" }),
    row({ collectionName: "Football Weekly", feedUrl: "https://www.theguardian.com/football/series/footballweekly/podcast.xml" }),
    row({ collectionName: "Insecure picture", artworkUrl100: "http://img.example/a.jpg", artworkUrl60: undefined, feedUrl: "https://feeds.example/b.xml" }),
    { artistName: "no name", feedUrl: "https://feeds.example/c.xml" },
  ) });
  assert.ok(out.ok);
  assert.deepEqual(out.hits.map((h) => [h.name, h.author, h.artworkUrl, h.genre]), [
    ["Football Weekly", "The Guardian", "https://img.example/100.jpg", "Sport"],
    ["Insecure picture", "Maker", null, "Sport"],
  ]);
  assert.equal(out.hits[0]!.feedUrl, "https://www.theguardian.com/football/series/footballweekly/podcast.xml");
});

test("only the typed words are sent, to the directory's search address", async () => {
  const seen: string[] = [];
  await searchPodcasts("  99%   Invisible & more  ", { fetch: async (url, o) => { seen.push(url); assert.equal(o?.accept, "application/json"); return fakeResponse(url, "{}", "application/json"); } });
  const u = new URL(seen[0]!);
  assert.equal(u.origin + u.pathname, "https://itunes.apple.com/search");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["entity", "limit", "media", "term"]);
  assert.equal(u.searchParams.get("term"), "99% Invisible & more");
  assert.equal(u.searchParams.get("media"), "podcast");
  // An empty query asks nothing.
  const none = await searchPodcasts("   ", { fetch: async () => { throw new Error("no request expected"); } });
  assert.deepEqual(none, { ok: true, hits: [] });
});

test("failures say that it is Apple's directory that is slow or away, in plain words", async () => {
  const slow = await searchPodcasts("x show", { fetch: async () => fakeFailure("timeout") });
  assert.ok(!slow.ok && slow.reason === "timeout");
  assert.match(slow.message, /Apple's podcast directory was slow/);
  const away = await searchPodcasts("x show", { fetch: async () => fakeFailure("unreachable") });
  assert.ok(!away.ok && away.reason === "unreachable");
  assert.match(away.message, /couldn't reach Apple's podcast directory/);
  for (const status of [429, 503]) {
    const busy = await searchPodcasts("x show", { fetch: async (url) => fakeResponse(url, "busy", "text/html", status) });
    assert.ok(!busy.ok);
    assert.match(busy.message, /busy or limiting/);
  }
  const odd = await searchPodcasts("x show", { fetch: async (url) => fakeResponse(url, "<html>", "text/html") });
  assert.ok(!odd.ok);
  assert.match(odd.message, /couldn't read/);
});

test("through the real fetch layer: a local directory answers, and a private address is still refused", async () => {
  const server = await startServer((req, res) => {
    assert.match(req.url ?? "", /^\/search\?/);
    send(res, 200, "application/json", JSON.stringify({ results: [row({})] }));
  });
  try {
    const ok = await searchPodcasts("show", { endpoint: `${server.origin}/search`, testAllowAddress: allowLoopback });
    assert.ok(ok.ok);
    assert.equal(ok.hits.length, 1);
    const refused = await searchPodcasts("show", { endpoint: `${server.origin}/search` });
    assert.ok(!refused.ok, "loopback is blocked without the test allowance");
  } finally {
    await server.close();
  }
});
