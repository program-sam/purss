import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@purss/domain";
import type { OpmlImportRequest } from "@purss/domain";
import type { DiscoveryDraft } from "@purss/connectors";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { getOpmlImport, runOpmlImports, startOpmlImport } from "./opml-import.ts";
import { previewOpml } from "./opml.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { followSource, presentCandidates, retrySource, unfollowSource } from "./sources.ts";
import { applySyncBatch } from "./sync.ts";
import { newsUrls } from "./news-address.ts";

/*
 * Whether an account already has a source, and what finding, reviving or making it does, asked through every road
 * that leads there: following, following again, the OPML preview, an OPML import and an archive import. Each road
 * is given the same address spelled several ways, for a source that is followed and for one that was unfollowed.
 */

const STORED = "https://harbour.example/feed/";
const SPELLINGS: { label: string; address: string; same: boolean }[] = [
  { label: "as it is stored", address: "https://harbour.example/feed/", same: true },
  { label: "without the trailing slash", address: "https://harbour.example/feed", same: true },
  { label: "over http", address: "http://harbour.example/feed/", same: true },
  { label: "with a tracking parameter", address: "https://harbour.example/feed/?utm_source=newsletter", same: true },
  { label: "with the host in capitals", address: "https://HARBOUR.example/feed/", same: true },
  { label: "with www.", address: "https://www.harbour.example/feed/", same: false },
  { label: "at another path", address: "https://harbour.example/feed/atom", same: false },
];

const base = { collectionId: null, newCollectionName: null, fullText: false };

function hold(p: Principal, feedUrl: string, over: Record<string, unknown> = {}): string {
  const token = newId("dsc");
  holdCandidate(token, p.accountId, {
    feedUrl, siteUrl: "https://harbour.example/", title: "Harbour Notes", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [],
    route: "feed-address", entry: "paste", summariesOnly: false, privateWarning: null, ...over,
  } as never);
  return token;
}

const candidate = (feedUrl: string, over: Record<string, unknown> = {}) => ({
  title: "Harbour Notes", kind: "feed" as const, origin: "RSS feed", via: "Posts feed", feedUrl, siteUrl: "https://harbour.example/", cadence: null, samples: [], route: "feed-address" as const, summariesOnly: false, privateWarning: null, alreadyFollowingSourceId: null, ...over,
});
const found = (url: string, ...c: ReturnType<typeof candidate>[]): DiscoveryDraft => ({ ok: true, url, candidates: c });
const discoverFrom = (table: Record<string, DiscoveryDraft>) => async (url: string): Promise<DiscoveryDraft> => table[url] ?? Object.entries(table).find(([key]) => new URL(key).href === url)?.[1] ?? { ok: false, url, reason: "unreachable", message: "That site isn't answering." };
const listOf = (...f: [string, string][]): OpmlImportRequest["feeds"] => f.map(([title, feedUrl]) => ({ title, feedUrl, siteUrl: null, folder: null }));
const opml = (...urls: string[]) => `<opml><body>${urls.map((u, i) => `<outline type="rss" text="F${i}" xmlUrl="${u}"/>`).join("")}</body></opml>`;

/** An archive, as another PURSS would export it, holding these sources. */
async function archiveOf(sources: { title: string; feedUrl?: string; followed?: boolean; isPrivate?: boolean }[]) {
  const from = makeTestApp();
  const pa = makeOwner(from.app);
  sources.forEach((s, i) => {
    const id = makeSource(from.app, pa, s.title, `feed/${i}`, { isPrivate: s.isPrivate });
    if (s.feedUrl) from.app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", s.feedUrl, id);
    if (s.followed === false) from.app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", id);
  });
  const parts: string[] = [];
  await streamExport(from.app, pa, (c) => { parts.push(c); });
  from.cleanup();
  return JSON.parse(parts.join(""));
}

const ids = (app: App, p: Principal) => app.db.all<{ id: string }>("SELECT id FROM sources WHERE account_id = ? AND kind <> 'manual' ORDER BY created_at, id", p.accountId).map((r) => r.id);
const row = <T extends Record<string, unknown>>(app: App, id: string, columns: string) => app.db.get<T>(`SELECT ${columns} FROM sources WHERE id = ?`, id)!;
const subscriptions = (app: App) => app.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'").map((j) => JSON.parse(j.payload) as { sourceId: string; feedUrl: string });

function setup(t: test.TestContext, followed: boolean) {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const stored = makeSource(app, p, "Harbour Notes", "feed/harbour");
  app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", STORED, stored);
  if (!followed) unfollowSource(app, p, stored);
  return { app, p, stored };
}

type Road = {
  name: string;
  /** Asks the road about the address; `reported` is the source it says the address is, when it says one. */
  run: (app: App, p: Principal, address: string, over: Record<string, unknown>) => Promise<{ reported?: string | null }>;
  /** A road that only answers and changes nothing. */
  reads?: boolean;
};

const ROADS: Road[] = [
  {
    name: "looking it up",
    reads: true,
    run: async (app, p, address, over) => ({ reported: presentCandidates(app, p, [candidate(address, over)])[0]!.alreadyFollowingSourceId }),
  },
  {
    name: "following it",
    run: async (app, p, address, over) => ({ reported: followSource(app, p, { ...base, token: hold(p, address, over) }).id }),
  },
  {
    name: "the OPML preview",
    reads: true,
    run: async (app, p, address) => ({ reported: previewOpml(app, p, opml(address)).feeds[0]!.sourceId }),
  },
  {
    name: "an OPML import",
    run: async (app, p, address, over) => {
      const list = startOpmlImport(app, p, { fileName: "list.opml", destination: { kind: "none" }, feeds: listOf(["Harbour Notes", address]) });
      await runOpmlImports(app, { discover: discoverFrom({ [address]: found(address, candidate(address, over)) }) });
      const done = getOpmlImport(app, p, list.id);
      assert.deepEqual([done.failed, done.waiting], [0, 0], JSON.stringify(done.entries));
      return { reported: done.entries![0]!.sourceId };
    },
  },
  {
    name: "an archive import",
    run: async (app, p, address) => {
      const doc = await archiveOf([{ title: "Harbour Notes", feedUrl: address }]);
      applyImport(app, p, stageImport(app, p, doc).token);
      return {};
    },
  },
];

/** What every road must do with one address, for a source that is followed or not. */
async function expectRoad(road: Road, spelling: { address: string; same: boolean }, followed: boolean, made: { app: App; p: Principal; stored: string }, over: Record<string, unknown>) {
  const { app, p, stored } = made;
  const before = subscriptions(app).length;
  const { reported } = await road.run(app, p, spelling.address, over);
  const after = ids(app, p);
  if (road.reads) {
    assert.deepEqual(after, [stored], "nothing was made");
    assert.equal(reported, spelling.same && followed ? stored : null);
    return;
  }
  assert.equal(after.length, spelling.same ? 1 : 2, spelling.same ? "no second source for the same feed" : "a different feed is a source of its own");
  if (reported !== undefined) assert.equal(reported === stored, spelling.same, `the road reported ${reported}`);
  if (spelling.same) assert.equal(row<{ followed: number }>(app, stored, "followed").followed, 1, "and it is followed");
  // An address the account already follows needs no new subscription; a source taken up again, or a new one, gets one, at the address the source keeps.
  const queued = subscriptions(app).slice(before);
  assert.equal(queued.length, spelling.same && followed ? 0 : 1);
  if (spelling.same && !followed && !over.privateWarning) assert.deepEqual(queued.map((j) => [j.sourceId, j.feedUrl]), [[stored, STORED]]);
}

for (const followed of [true, false]) {
  for (const road of ROADS) {
    for (const spelling of SPELLINGS) {
      test(`${followed ? "a followed" : "an unfollowed"} source and ${road.name}: the address ${spelling.label} is ${spelling.same ? "the same source" : "another source"}`, async (t) => {
        await expectRoad(road, spelling, followed, setup(t, followed), {});
      });
    }
  }
}
test("a feed written in two spellings in one list or one archive is one source", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const a = "https://harbour.example/feed/";
  const b = "http://harbour.example/feed?utm_source=x";
  const list = startOpmlImport(app, p, { fileName: "list.opml", destination: { kind: "none" }, feeds: listOf(["One", a], ["Two", b]) });
  assert.equal(list.total, 1, "the list holds the feed once");

  const q = makeOwner(app, { admin: false });
  applyImport(app, q, stageImport(app, q, await archiveOf([{ title: "One", feedUrl: a }, { title: "Two", feedUrl: b }])).token);
  assert.equal(ids(app, q).length, 1);
});

test("a feed followed as a private link starts a source of its own: a private link never takes up a public source", (t) => {
  const { app, p, stored } = setup(t, false);
  const priv = followSource(app, p, { ...base, token: hold(p, STORED), markPrivate: true });
  assert.notEqual(priv.id, stored);
  assert.equal(row<{ followed: number }>(app, stored, "followed").followed, 0, "the public source stays unfollowed");
  assert.equal(row<{ feed_url: string | null }>(app, priv.id, "feed_url").feed_url, null);
});

test("of several unfollowed sources for one feed, the one followed last is taken up again", (t) => {
  const { app, p, stored } = setup(t, false);
  const later = makeSource(app, p, "Harbour Notes again", "feed/harbour-2");
  app.db.run("UPDATE sources SET feed_url = ?, created_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", STORED, later);
  unfollowSource(app, p, later);
  assert.equal(followSource(app, p, { ...base, token: hold(p, STORED) }).id, later);
  assert.equal(row<{ followed: number }>(app, stored, "followed").followed, 0);
});

test("a source taken up again keeps its stored address, and the first subscription and a retry both use it", (t) => {
  const { app, p, stored } = setup(t, false);
  const again = followSource(app, p, { ...base, token: hold(p, "http://harbour.example/feed?utm_source=x") });
  assert.equal(again.id, stored);
  assert.equal(row<{ feed_url: string }>(app, stored, "feed_url").feed_url, STORED);
  assert.deepEqual(subscriptions(app).map((j) => [j.sourceId, j.feedUrl]), [[stored, STORED]], "the first subscription");
  app.db.run("UPDATE sources SET health = 'error' WHERE id = ?", stored);
  retrySource(app, p, stored);
  assert.deepEqual(subscriptions(app).map((j) => [j.sourceId, j.feedUrl]), [[stored, STORED]], "and a retry, which reads the stored address");
});

test("one existing unfollowed source written two ways in one archive is taken up once", async (t) => {
  const { app, p, stored } = setup(t, false);
  const doc = await archiveOf([{ title: "Harbour Notes", feedUrl: STORED }, { title: "Harbour Notes (again)", feedUrl: "http://harbour.example/feed?utm_source=x" }]);
  const staged = stageImport(app, p, doc);
  assert.equal(staged.counts.sourcesToFollow, 1);
  const result = applyImport(app, p, staged.token);
  assert.equal(result.following, 1);
  assert.deepEqual(subscriptions(app).map((j) => [j.sourceId, j.feedUrl]), [[stored, STORED]]);
  assert.deepEqual(ids(app, p), [stored]);
});

test("this installation's own news is only ever its built-in source, made once and never subscribed to", (t) => {
  const { app, p, stored } = setup(t, false);
  const feed = newsUrls(app).feed;
  app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", feed, stored); // an ordinary source that was made for the news address
  const news = followSource(app, p, { ...base, token: hold(p, feed, { route: "installation-news", title: "News" }) });
  assert.notEqual(news.id, stored, "the ordinary source is not taken for it");
  assert.deepEqual({ ...row<{ builtin: string | null; health: string; followed: number }>(app, news.id, "builtin, health, followed") }, { builtin: "news", health: "ok", followed: 1 });
  assert.deepEqual(subscriptions(app), []);
  // Unfollowed and followed again, it is the same source, and still has no subscription.
  unfollowSource(app, p, news.id);
  assert.equal(followSource(app, p, { ...base, token: hold(p, feed, { route: "installation-news", title: "News" }) }).id, news.id);
  assert.deepEqual(subscriptions(app), []);
});

test("a bridged source is found by its descriptor in follow and archive import, and by its page address in a list", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const descriptor = "bridge:telegram/durov";
  const page = "https://t.me/durov";
  const draft = { siteUrl: page, title: "Pavel Durov", origin: "Telegram channel", route: "bridge:telegram" };
  const first = followSource(app, p, { ...base, token: hold(p, descriptor, draft) });
  assert.equal(followSource(app, p, { ...base, token: hold(p, descriptor, draft) }).id, first.id, "following it again");
  assert.deepEqual(previewOpml(app, p, opml(page, `${page}/`, "https://t.me/other")).feeds.map((f) => f.sourceId), [first.id, null]);

  const list = startOpmlImport(app, p, { fileName: "list.opml", destination: { kind: "none" }, feeds: listOf(["Durov", page]) });
  await runOpmlImports(app, { discover: discoverFrom({ [page]: found(page, candidate(descriptor, draft)) }) });
  assert.deepEqual(getOpmlImport(app, p, list.id).entries!.map((e) => [e.state, e.sourceId]), [["already", first.id]]);

  applyImport(app, p, stageImport(app, p, await archiveOf([{ title: "Pavel Durov", feedUrl: descriptor }])).token);
  assert.deepEqual(ids(app, p), [first.id]);

  // Unfollowed, it is taken up again from the descriptor, and from the page's address in a list.
  unfollowSource(app, p, first.id);
  assert.equal(followSource(app, p, { ...base, token: hold(p, descriptor, draft) }).id, first.id);
  assert.deepEqual(ids(app, p), [first.id]);
});

const SECRET = "https://feeds.example/private/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c/feed.xml";
const PRIVATE_SPELLINGS: { label: string; address: string; same: boolean }[] = [
  { label: "as it was followed", address: SECRET, same: true },
  { label: "with a fragment", address: `${SECRET}#x`, same: true },
  { label: "over http", address: SECRET.replace("https:", "http:"), same: true },
  { label: "with the host in capitals", address: SECRET.replace("feeds.example", "FEEDS.example"), same: true },
  { label: "with another key", address: SECRET.replace("3f9a8b7c", "aaaaaaaa"), same: false },
];

const SECRET_NOTE = { privateWarning: "This link has a secret in it." };
for (const road of ROADS.filter((r) => r.name !== "an archive import")) {
  for (const spelling of PRIVATE_SPELLINGS) {
    test(`a followed private source and ${road.name}: the link ${spelling.label} is ${spelling.same ? "the same source" : "another source"}`, async (t) => {
      const { app, cleanup } = makeTestApp();
      t.after(cleanup);
      const p = makeOwner(app);
      const stored = followSource(app, p, { ...base, token: hold(p, SECRET, SECRET_NOTE) }).id;
      await expectRoad(road, spelling, true, { app, p, stored }, SECRET_NOTE);
    });
  }
}

test("an unfollowed private source has no link left to be found by: the same link followed again starts a source of its own", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const first = followSource(app, p, { ...base, token: hold(p, SECRET, SECRET_NOTE) });
  unfollowSource(app, p, first.id);
  const asPublic = followSource(app, p, { ...base, markPrivate: false, token: hold(p, SECRET, SECRET_NOTE) });
  assert.notEqual(asPublic.id, first.id);
  assert.deepEqual({ ...row<{ is_private: number; feed_url: string | null }>(app, asPublic.id, "is_private, feed_url") }, { is_private: 0, feed_url: SECRET });
  assert.deepEqual({ ...row<{ is_private: number; followed: number }>(app, first.id, "is_private, followed") }, { is_private: 1, followed: 0 }, "the private source stays as it was");
});

test("an archive carries no address for a private source, so the title is what finds it again; the case of the title doesn't matter", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const mine = makeSource(app, p, "Secret Garden", "feed/1", { isPrivate: true });
  const doc = await archiveOf([{ title: "secret garden", isPrivate: true }, { title: "Another One", isPrivate: true }]);
  applyImport(app, p, stageImport(app, p, doc).token);
  const rows = app.db.all<{ id: string; title: string; health: string }>("SELECT id, title, health FROM sources WHERE account_id = ? AND is_private = 1 ORDER BY title", p.accountId);
  assert.deepEqual(rows.map((r) => [r.title, r.health]), [["Another One", "reconnect"], ["Secret Garden", "ok"]], "the one that matched keeps its own state; the other waits to be reconnected");
  assert.equal(rows.find((r) => r.title === "Secret Garden")!.id, mine);
});

test("a source taken up again by an archive is set up like one followed again: its backlog is backlog, not New", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const stored = makeSource(app, p, "Harbour Notes", "feed/harbour");
  app.db.run("UPDATE sources SET feed_url = ?, paused = 1, via_gateway = 1 WHERE id = ?", STORED, stored);
  unfollowSource(app, p, stored);
  const before = row<{ backlog_settled_at: string | null; subscribed_at: string | null; unfollowed_at: string | null }>(app, stored, "backlog_settled_at, subscribed_at, unfollowed_at");
  assert.ok(before.backlog_settled_at && before.subscribed_at && before.unfollowed_at, "it had been settled and unfollowed");

  applyImport(app, p, stageImport(app, p, await archiveOf([{ title: "Harbour Notes", feedUrl: STORED }])).token);
  const after = row<{ followed: number; paused: number; health: string; backlog_settled_at: string | null; subscribed_at: string | null; unfollowed_at: string | null; engine_stream_id: string | null; via_gateway: number; title: string }>(
    app, stored, "followed, paused, health, backlog_settled_at, subscribed_at, unfollowed_at, engine_stream_id, via_gateway, title");
  assert.deepEqual({ ...after }, { followed: 1, paused: 0, health: "pending", backlog_settled_at: null, subscribed_at: null, unfollowed_at: null, engine_stream_id: null, via_gateway: 1, title: "Harbour Notes" });
  // The engine's subscription brings the feed's older posts again: they are not New.
  app.db.run("UPDATE sources SET engine_stream_id = 'feed/again', subscribed_at = ? WHERE id = ?", new Date().toISOString(), stored);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/again", { publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })]));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_state WHERE is_new = 1")!.n, 0);
});

test("an archive makes a source as an import should: no feed key, every old post shown, no discovery route, and the installation's own news is its own source", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const news = newsUrls(app).feed;
  applyImport(app, p, stageImport(app, p, await archiveOf([{ title: "Harbour Notes", feedUrl: STORED }, { title: "Our news", feedUrl: news }])).token);
  const made = app.db.all<{ title: string; feed_key: string | null; start_from: string; via_gateway: number; discovery_route: string | null; discovery_entry: string | null; builtin: string | null; health: string }>(
    "SELECT title, feed_key, start_from, via_gateway, discovery_route, discovery_entry, builtin, health FROM sources WHERE account_id = ? AND kind <> 'manual' ORDER BY title", p.accountId);
  assert.deepEqual(made.map((r) => ({ ...r })), [
    { title: "Harbour Notes", feed_key: null, start_from: "all", via_gateway: 0, discovery_route: null, discovery_entry: null, builtin: null, health: "pending" },
    { title: "Our news", feed_key: null, start_from: "all", via_gateway: 0, discovery_route: null, discovery_entry: null, builtin: "news", health: "ok" },
  ]);
  assert.deepEqual(subscriptions(app).map((j) => j.feedUrl), [STORED], "the engine never fetches this installation's news");
});
