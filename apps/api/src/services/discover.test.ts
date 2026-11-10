import test from "node:test";
import assert from "node:assert/strict";
import type { DiscoverResponse } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { publicRouter } from "../routes/public.ts";
import { MIN_READERS, arrange, buildAggregates, rebuildDiscovery, runDiscoveryPass } from "./discover.ts";
import type { FollowRow } from "./discover.ts";

const follow = (account: string, feed: string, title = feed, extra: Partial<FollowRow> = {}): FollowRow =>
  ({ account_id: account, feed_url: `https://example.org/${feed}.xml`, title, site_url: `https://www.${feed}.example/`, kind: "feed", ...extra });
const accounts = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `acc_${from + i}`);

test("a source or a pair counts only once MIN_READERS different accounts follow it", () => {
  const rows = [
    ...accounts(MIN_READERS).flatMap((a) => [follow(a, "a"), follow(a, "b")]),
    ...accounts(MIN_READERS - 1).map((a) => follow(a, "c")),
    follow("acc_0", "a"), // the same account twice is one reader
  ];
  const g = buildAggregates(rows);
  assert.deepEqual(g.sources.map((s) => [s.key, s.followers]).sort(), [["example.org/a.xml", MIN_READERS], ["example.org/b.xml", MIN_READERS]]);
  assert.deepEqual(g.pairs.map((p) => [p.a, p.b, p.together]).sort(), [
    ["example.org/a.xml", "example.org/b.xml", MIN_READERS], ["example.org/b.xml", "example.org/a.xml", MIN_READERS]]);

  const thinPair = buildAggregates([...accounts(MIN_READERS).map((a) => follow(a, "a")), ...accounts(MIN_READERS).map((a, i) => follow(a, i === 0 ? "x" : "b")), follow("acc_99", "b")]);
  assert.equal(thinPair.sources.length, 2);
  assert.equal(thinPair.pairs.length, 0, "nine accounts following both is not enough");
});

test("what a suggestion shows is shared by many followers, never one person's own name or address", () => {
  const rows = [...accounts(MIN_READERS), "acc_extra"].map((a, i) => follow(a, "a", i === 0 ? "Alice's secret nickname" : "The A Blog", {
    // Tracking parameters and plain http are the same feed.
    feed_url: i === 1 ? "http://example.org/a.xml?utm_source=alice" : "https://example.org/a.xml",
  }));
  rows.push(...accounts(MIN_READERS).map((a) => follow(a, "who", `Name ${a}`, { feed_url: "https://user:pw@example.org/who.xml" })));
  rows.push(...accounts(MIN_READERS).map((a) => follow(a, "z", `Own name ${a}`)));
  const g = buildAggregates(rows);
  const a = g.sources.find((s) => s.key === "example.org/a.xml")!;
  assert.equal(a.title, "The A Blog");
  assert.equal(a.feedUrl, "https://example.org/a.xml");
  assert.equal(a.host, "a.example");
  assert.equal(g.sources.some((s) => s.key.includes("@")), false, "an address with a name and password never counts");
  assert.equal(g.sources.find((s) => s.key === "example.org/z.xml")!.title, "z.example", "no shared title: the site's host instead");
  // Nine of ten use one title: not enough on its own, so the host shows.
  const nine = buildAggregates(accounts(MIN_READERS).map((a, i) => follow(a, "n", i === 0 ? "Own" : "Nine Agree")));
  assert.equal(nine.sources[0]!.title, "n.example");
});

test("chance reorders suggestions per seed, keeps them within a seed, and mixes in a wildcard every fourth place", () => {
  const matched = Array.from({ length: 30 }, (_, i) => ({ key: `m${i}`, score: 1 / (i + 1), because: ["src_1"] }));
  const popular = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, followers: 100 - i }));
  const one = arrange(matched, popular, new Set(["m0"]), "ws:2026-11-07");
  assert.deepEqual(arrange(matched, popular, new Set(["m0"]), "ws:2026-11-07"), one, "the same day gives the same list");
  assert.notDeepEqual(arrange(matched, popular, new Set(["m0"]), "ws:2026-11-08").map((x) => x.key), one.map((x) => x.key), "another day another order");
  assert.equal(one.length, 20);
  assert.equal(new Set(one.map((x) => x.key)).size, 20, "nothing twice");
  assert.ok(!one.some((x) => x.key === "m0"), "what is skipped never shows");
  one.forEach((x, i) => assert.equal(x.reason, (i + 1) % 4 === 0 ? "wildcard" : "because", `place ${i + 1}`));

  const fresh = arrange([], popular, new Set(), "new:2026-11-07");
  assert.ok(fresh.every((x) => x.reason === "popular"), "nothing matched: popular sources");

  // Few matches and no popular sources left: the matches still fill the list.
  assert.deepEqual(arrange(matched.slice(0, 5), [], new Set(), "s").map((x) => x.reason), Array(5).fill("because"));
});

test("popular sources for a new account still lean towards the most followed", () => {
  const popular = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, followers: i < 5 ? 500 : 10 }));
  let topHits = 0;
  for (let d = 0; d < 50; d++) topHits += arrange([], popular, new Set(), `ws:${d}`, 5).filter((x) => Number(x.key.slice(1)) < 5).length;
  assert.ok(topHits > 150, `the five most followed fill most top places (${topHits} of 250)`);
  assert.ok(topHits < 250, "but not every one: chance lets others in");
});

type Boot = { app: App; server: { base: string; close: () => Promise<void> }; close: () => Promise<void> };
async function boot(mode: "hosted" | "self" = "hosted"): Promise<Boot> {
  const { app, cleanup } = makeTestApp(mode === "hosted" ? { PURSS_MODE: "hosted" } : {});
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, server, close: async () => { await server.close(); cleanup(); } };
}
let stream = 0;
const add = (app: App, p: Principal, feed: string, extra: { kind?: string; isPrivate?: boolean } = {}) => {
  const id = makeSource(app, p, `Title ${feed}`, `s${stream++}`, extra);
  if (!extra.isPrivate) app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", `https://example.org/${feed}.xml`, id);
  return id;
};
const get = async (b: Boot, p: Principal) => {
  const r = await call(b.app, b.server.base, "GET", "/api/suggestions", signIn(b.app, p.accountId));
  assert.equal(r.status, 200, r.text);
  return r as { json: DiscoverResponse; text: string };
};

test("a reader gets what people who follow the same sources also follow, with their own source as the reason and no counts", async (t) => {
  const b = await boot();
  t.after(b.close);
  const crowd = Array.from({ length: MIN_READERS + 2 }, () => makeOwner(b.app, { admin: false }));
  for (const p of crowd) { add(b.app, p, "a"); add(b.app, p, "b"); add(b.app, p, "c", { kind: "manual" }); add(b.app, p, "d", { kind: "publication" }); }
  const reader = makeOwner(b.app, { admin: false });
  const mineA = add(b.app, reader, "a");
  // Before the graph holds anything, Discovery is "coming soon" for everyone.
  assert.deepEqual({ ...(await get(b, reader)).json }, { sharing: true, ready: false, suggestions: [] });
  rebuildDiscovery(b.app);

  const r = await get(b, reader);
  assert.equal(r.json.sharing, true);
  assert.equal(r.json.ready, true);
  assert.deepEqual(r.json.suggestions.map((s) => [s.key, s.reason]), [["example.org/b.xml", { kind: "because", sourceIds: [mineA] }]],
    "manual sources and followed shared collections never count");
  assert.doesNotMatch(r.text, /followers|together|\b1[0-9]\b/, "no counts reach the browser");

  // A brand-new account follows nothing yet: popular sources.
  const fresh = makeOwner(b.app, { admin: false });
  assert.deepEqual((await get(b, fresh)).json.suggestions.map((s) => s.reason.kind), ["popular", "popular"]);

  // Not interested: it stops coming back, for this reader only.
  const s = signIn(b.app, reader.accountId);
  assert.equal((await call(b.app, b.server.base, "POST", "/api/suggestions/dismiss", s, { key: "example.org/b.xml" })).status, 200);
  assert.deepEqual((await get(b, reader)).json.suggestions, []);
  assert.equal((await get(b, fresh)).json.suggestions.length, 2);
  // A made-up key isn't stored.
  await call(b.app, b.server.base, "POST", "/api/suggestions/dismiss", s, { key: "nothing/here" });
  assert.equal(b.app.db.all("SELECT 1 FROM discovery_dismissed").length, 1);
});

test("switching sharing off takes an account out of the graph at the next pass, within a minute", async (t) => {
  const b = await boot();
  t.after(b.close);
  const crowd = Array.from({ length: MIN_READERS }, () => makeOwner(b.app, { admin: false }));
  for (const p of crowd) { add(b.app, p, "a"); add(b.app, p, "b"); }
  const reader = makeOwner(b.app, { admin: false });
  add(b.app, reader, "a");
  runDiscoveryPass(b.app);
  assert.equal((await get(b, reader)).json.suggestions.length, 1);

  const out = await call(b.app, b.server.base, "PATCH", "/api/preferences", signIn(b.app, crowd[0]!.accountId), { discoveryShare: false });
  assert.equal(out.status, 200);
  assert.equal(b.app.db.get<{ dirty: number }>("SELECT dirty FROM discovery_state")!.dirty, 1);
  runDiscoveryPass(b.app, Date.now() + 61_000);
  assert.deepEqual((await get(b, reader)).json.suggestions, [], "nine sharing readers are not enough");
  assert.deepEqual(b.app.db.all<{ key: string }>("SELECT key FROM discovery_sources").map((r) => r.key), ["example.org/a.xml"], "a: nine plus the reader");
  // The account that stopped sharing gets no suggestions itself: suggestions are for readers who share.
  const own = await get(b, crowd[0]!);
  assert.deepEqual({ ...own.json }, { sharing: false, ready: true, suggestions: [] });
  // Sharing again brings them back, and the account counts again at the next pass.
  await call(b.app, b.server.base, "PATCH", "/api/preferences", signIn(b.app, crowd[0]!.accountId), { discoveryShare: true });
  runDiscoveryPass(b.app, Date.now() + 61_000);
  assert.equal((await get(b, crowd[0]!)).json.suggestions.length, 0, "it follows both sources already");
  assert.equal((await get(b, reader)).json.suggestions.length, 1);
});

test("unfollowed sources and suspended accounts never count", async (t) => {
  const b = await boot();
  t.after(b.close);
  const crowd = Array.from({ length: MIN_READERS }, () => makeOwner(b.app, { admin: false }));
  for (const p of crowd) { add(b.app, p, "a"); add(b.app, p, "b"); add(b.app, p, "c"); }
  rebuildDiscovery(b.app);
  assert.equal(b.app.db.all("SELECT 1 FROM discovery_sources").length, 3);

  b.app.db.run("UPDATE sources SET followed = 0 WHERE account_id = ? AND feed_url LIKE '%/c.xml'", crowd[0]!.accountId);
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", crowd[1]!.accountId);
  rebuildDiscovery(b.app);
  assert.equal(b.app.db.all("SELECT 1 FROM discovery_sources").length, 0, "nine usable followers each");
});

test("a reader's unfollowed and privately followed feeds don't come back as suggestions", async (t) => {
  const b = await boot();
  t.after(b.close);
  const crowd = Array.from({ length: MIN_READERS }, () => makeOwner(b.app, { admin: false }));
  for (const p of crowd) for (const f of ["a", "b", "c", "d"]) add(b.app, p, f);
  rebuildDiscovery(b.app);
  const reader = makeOwner(b.app, { admin: false });
  add(b.app, reader, "a");
  const gone = add(b.app, reader, "b");
  b.app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", gone);
  // A private source: its address is a secret, only a keyed hash of it is in the database.
  const { privateFeedKey } = await import("./feed-keys.ts");
  const secret = add(b.app, reader, "c-private", { isPrivate: true });
  b.app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", privateFeedKey(b.app, reader.workspaceId, "https://example.org/c.xml"), secret);
  assert.deepEqual((await get(b, reader)).json.suggestions.map((s) => s.key), ["example.org/d.xml"]);
});

test("a self-hosted installation has no Discover: no route, and nothing is built or kept", async (t) => {
  const b = await boot("self");
  t.after(b.close);
  const crowd = Array.from({ length: MIN_READERS }, () => makeOwner(b.app, { admin: false }));
  for (const p of crowd) { add(b.app, p, "a"); add(b.app, p, "b"); }
  // Left over from when the installation was hosted.
  rebuildDiscovery(b.app);
  assert.ok(b.app.db.all("SELECT 1 FROM discovery_pairs").length > 0);
  runDiscoveryPass(b.app);
  assert.equal(b.app.db.all("SELECT 1 FROM discovery_pairs").length + b.app.db.all("SELECT 1 FROM discovery_sources").length, 0);
  assert.equal(b.app.db.get<{ built_at: string | null }>("SELECT built_at FROM discovery_state")!.built_at, null);
  runDiscoveryPass(b.app);
  assert.equal(b.app.db.all("SELECT 1 FROM discovery_sources").length, 0, "and never builds again");
  const s = signIn(b.app, crowd[0]!.accountId);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/suggestions", s)).status, 404);
  assert.equal((await call(b.app, b.server.base, "POST", "/api/suggestions/dismiss", s, { key: "example.org/a.xml" })).status, 404);
});
