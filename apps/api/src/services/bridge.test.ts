import test from "node:test";
import assert from "node:assert/strict";
import { encodePageKey } from "@purss/connectors";
import { followSchema } from "@purss/domain";
import { makeOwner, makeTestApp } from "../testing.ts";
import { buildAggregates } from "./discover.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { scheduleIconChecks } from "./icons.ts";
import { generateOpml, previewOpml } from "./opml.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { followSource } from "./sources.ts";
import type { App, Principal } from "../app.ts";

function followBridged(app: App, p: Principal, key = "durov"): string {
  holdCandidate(`dsc_${key}`, p.workspaceId, {
    feedUrl: `bridge:telegram/${key}`, siteUrl: `https://t.me/${key}`, title: key, kind: "feed",
    origin: "Telegram channel", via: "Posts feed", cadence: null, samples: [], route: "bridge:telegram", entry: "paste", summariesOnly: false, privateWarning: null,
  });
  return followSource(app, p, followSchema.parse({ token: `dsc_${key}`, collectionId: null, newCollectionName: null })).id;
}

test("a bridged source is followed as its descriptor, never as a private link, and exports its public page", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  holdCandidate("dsc_bridge", p.workspaceId, {
    feedUrl: "bridge:telegram/durov", siteUrl: "https://t.me/durov", title: "Pavel Durov (@durov)", kind: "feed",
    origin: "Telegram channel", via: "Posts feed", cadence: null, samples: [], route: "bridge:telegram", entry: "paste", summariesOnly: false, privateWarning: null,
  });
  // Even when the request asks for it, there is no link to lock away.
  const s = followSource(app, p, followSchema.parse({ token: "dsc_bridge", collectionId: null, newCollectionName: null, markPrivate: true }));
  const row = app.db.get<{ feed_url: string; is_private: number; kind: string }>("SELECT feed_url, is_private, kind FROM sources WHERE id = ?", s.id)!;
  assert.deepEqual({ ...row }, { feed_url: "bridge:telegram/durov", is_private: 0, kind: "feed" });
  const job = app.db.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'")!;
  assert.equal(JSON.parse(job.payload).feedUrl, "bridge:telegram/durov", "the worker signs it; the job carries no engine address");
  const opml = generateOpml(app, p);
  assert.equal(opml.included, 1);
  assert.match(opml.xml, /xmlUrl="https:\/\/t\.me\/durov"/);
  assert.doesNotMatch(opml.xml, /bridge:|feed-bridge/);
});

test("an archive restores a bridged source as itself, into an empty PURSS and into one that already follows it", async (t) => {
  const from = makeTestApp();
  t.after(from.cleanup);
  const pa = makeOwner(from.app);
  followBridged(from.app, pa);
  const parts: string[] = [];
  await streamExport(from.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));

  const empty = makeTestApp();
  t.after(empty.cleanup);
  const pe = makeOwner(empty.app);
  applyImport(empty.app, pe, stageImport(empty.app, pe, doc).token);
  const row = empty.app.db.get<{ feed_url: string; is_private: number; health: string }>("SELECT feed_url, is_private, health FROM sources WHERE workspace_id = ? AND kind <> 'manual'", pe.workspaceId)!;
  assert.deepEqual({ feed_url: row.feed_url, is_private: row.is_private }, { feed_url: "bridge:telegram/durov", is_private: 0 });
  assert.notEqual(row.health, "reconnect");
  assert.ok(empty.app.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'").some((j) => JSON.parse(j.payload).feedUrl === "bridge:telegram/durov"));

  const same = makeTestApp();
  t.after(same.cleanup);
  const ps = makeOwner(same.app);
  followBridged(same.app, ps);
  const preview = stageImport(same.app, ps, doc);
  applyImport(same.app, ps, preview.token);
  assert.equal(same.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE workspace_id = ? AND kind <> 'manual'", ps.workspaceId)!.n, 1, "not added twice");
});

test("an OPML list naming a followed bridged source's page shows it as already followed", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const id = followBridged(app, p);
  const preview = previewOpml(app, p, generateOpml(app, p).xml);
  assert.equal(preview.feeds[0]!.alreadyFollowing, true);
  assert.equal(preview.feeds[0]!.sourceId, id);
});

test("icon checks of a bridged source look at its page, never at the descriptor", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  followBridged(app, p);
  scheduleIconChecks(app);
  const job = app.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'source.icon'").map((j) => JSON.parse(j.payload))[0];
  assert.equal(job.feedUrl, null);
  assert.equal(job.siteUrl, "https://t.me/durov");
});

test("co-follow suggestions keep a bridged source's descriptor", () => {
  const rows = ["a", "b", "c", "d", "e"].map((account) => ({ account_id: account, feed_url: "bridge:telegram/durov", title: "Durov", site_url: "https://t.me/durov", kind: "feed" as const }));
  const agg = buildAggregates(rows, 3);
  assert.deepEqual(agg.sources.map((s) => [s.key, s.feedUrl, s.host]), [["bridge:telegram/durov", "bridge:telegram/durov", "t.me"]]);
});

const PAGE_KEY = encodePageKey({ url: "https://www.anthropic.com/news", recipe: { item: "//li[contains(@class, '_row')]", title: ".//h3", link: ".//a/@href", date: ".//time" }, fixEncoding: false })!;

test("a page list is followed as its descriptor, never as a private link, though its key looks random; its export is the page", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  holdCandidate("dsc_page", p.workspaceId, {
    feedUrl: `bridge:page/${PAGE_KEY}`, siteUrl: "https://www.anthropic.com/news", title: "Newsroom", kind: "feed", origin: "Page list", via: "Posts listed on this page",
    cadence: null, samples: [], route: "bridge:page", entry: "paste", summariesOnly: false, privateWarning: null,
  });
  const s = followSource(app, p, followSchema.parse({ token: "dsc_page", collectionId: null, newCollectionName: null, markPrivate: true }));
  const row = app.db.get<{ feed_url: string; is_private: number }>("SELECT feed_url, is_private FROM sources WHERE id = ?", s.id)!;
  assert.deepEqual({ ...row }, { feed_url: `bridge:page/${PAGE_KEY}`, is_private: 0 });
  assert.equal(s.privacyChangeable, false);
  const job = app.db.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'")!;
  assert.equal(JSON.parse(job.payload).feedUrl, `bridge:page/${PAGE_KEY}`, "the worker signs it; the job carries no engine address");
  // The export writes the page's address, which discovery reads again (and runs the detector on again); never the key.
  const opml = generateOpml(app, p);
  assert.equal(opml.included, 1);
  assert.match(opml.xml, /xmlUrl="https:\/\/www\.anthropic\.com\/news"/);
  assert.doesNotMatch(opml.xml, new RegExp(`bridge:|feed-bridge|${PAGE_KEY.slice(0, 30)}`));
  const preview = previewOpml(app, p, opml.xml);
  assert.equal(preview.feeds[0]!.alreadyFollowing, true, "the page's address is the followed page list again");
  assert.equal(preview.feeds[0]!.looksPrivate, false);
  // Icons are looked for at the page, not at the descriptor.
  scheduleIconChecks(app);
  const icon = app.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'source.icon'").map((j) => JSON.parse(j.payload))[0];
  assert.deepEqual([icon.feedUrl, icon.siteUrl], [null, "https://www.anthropic.com/news"]);
});

test("an archive restores a page list as itself", async (t) => {
  const from = makeTestApp();
  t.after(from.cleanup);
  const pa = makeOwner(from.app);
  holdCandidate("dsc_page", pa.workspaceId, {
    feedUrl: `bridge:page/${PAGE_KEY}`, siteUrl: "https://www.anthropic.com/news", title: "Newsroom", kind: "feed", origin: "Page list", via: "Posts listed on this page",
    cadence: null, samples: [], route: "bridge:page", entry: "paste", summariesOnly: false, privateWarning: null,
  });
  followSource(from.app, pa, followSchema.parse({ token: "dsc_page", collectionId: null, newCollectionName: null }));
  const parts: string[] = [];
  await streamExport(from.app, pa, (c) => { parts.push(c); });
  const into = makeTestApp();
  t.after(into.cleanup);
  const pi = makeOwner(into.app);
  applyImport(into.app, pi, stageImport(into.app, pi, JSON.parse(parts.join(""))).token);
  const row = into.app.db.get<{ feed_url: string; is_private: number }>("SELECT feed_url, is_private FROM sources WHERE workspace_id = ? AND kind <> 'manual'", pi.workspaceId)!;
  assert.deepEqual({ ...row }, { feed_url: `bridge:page/${PAGE_KEY}`, is_private: 0 });
});
