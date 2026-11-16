import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newId } from "@purss/domain";
import type { Principal } from "../app.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { generateOpml } from "./opml.ts";
import { retryOverloadedSubscribes, settleFailedJob, subscribeGaveUpText, subscribeRetryText } from "./failures.ts";
import { checkEmptyFeeds, followSource, getSource, onSubscribed, presentCandidates, retrySource, unfollowSource } from "./sources.ts";

const BIG = "https://feeds.simplecast.com/54nAGcIl";
const base = { collectionId: null, newCollectionName: null, fullText: false };
const draft = (feedUrl: string, over: Record<string, unknown> = {}) => ({ feedUrl, siteUrl: "https://www.nytimes.com/the-daily", title: "The Daily", kind: "podcast" as const, origin: "Podcast feed", via: "Podcast feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null, ...over });

function hold(p: Principal, feedUrl: string, over: Record<string, unknown> = {}): string {
  const token = newId("dsc");
  holdCandidate(token, p.workspaceId, draft(feedUrl, over) as never);
  return token;
}
type Row = { via_gateway: number; feed_url: string | null; health: string; health_text: string | null; engine_stream_id: string | null };
const row = (app: ReturnType<typeof makeTestApp>["app"], id: string) => app.db.get<Row>("SELECT via_gateway, feed_url, health, health_text, engine_stream_id FROM sources WHERE id = ?", id)!;
const jobs = (app: ReturnType<typeof makeTestApp>["app"]) => app.db.all<{ payload: string; idempotency_key: string; status: string }>("SELECT payload, idempotency_key, status FROM jobs WHERE kind = 'engine.subscribe' ORDER BY created_at, rowid").map((j) => ({ ...j, payload: JSON.parse(j.payload) as Record<string, unknown> }));

test("a feed the preview found too big for the engine is followed through the gateway; the source keeps its own address and the person is shown nothing different", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  // What the person is shown is the same for a big feed and a small one: the decision is not theirs and not in the preview they get.
  const shown = presentCandidates(app, p, [draft(BIG, { large: true }), draft("https://example.org/small.xml")]);
  assert.ok(shown.every((c) => !("large" in c)), JSON.stringify(shown));
  const big = followSource(app, p, { ...base, token: shown[0]!.token });
  assert.equal(big.feedUrl, BIG, "the address the person sees, and exports, is the feed's own");
  assert.equal(row(app, big.id).via_gateway, 1);
  assert.equal(row(app, big.id).feed_url, BIG);
  const small = followSource(app, p, { ...base, token: shown[1]!.token });
  assert.equal(row(app, small.id).via_gateway, 0);
  const [a, b] = jobs(app);
  assert.deepEqual([a!.payload.feedUrl, a!.payload.trim], [BIG, true], "the job says to use the gateway; its address stays the feed's own");
  assert.deepEqual([b!.payload.feedUrl, b!.payload.trim], ["https://example.org/small.xml", undefined]);
  assert.ok(generateOpml(app, p).xml.includes(`xmlUrl="${BIG}"`), "an export names the feed itself");
});

test("a big private link is followed through the gateway too; its link stays in the secrets folder and out of the job", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const link = "https://patreon.example/rss/show?auth=0123456789abcdef0123456789abcdef";
  const s = followSource(app, p, { ...base, token: hold(p, link, { large: true, privateWarning: "This link has a secret in it." }) });
  assert.equal(row(app, s.id).via_gateway, 1);
  assert.equal(row(app, s.id).feed_url, null);
  const [job] = jobs(app);
  assert.deepEqual([job!.payload.feedUrl, job!.payload.trim], [`secret:source-urls/${s.id}`, true]);
  assert.ok(!JSON.stringify(job).includes("0123456789abcdef"));
  assert.equal(readFileSync(path.join(app.config.secretsDir, "source-urls", s.id), "utf8").trim(), link);
});

test("following a big feed again after unfollowing it takes the decision from the new preview", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const first = followSource(app, p, { ...base, token: hold(p, BIG, { large: true }) });
  unfollowSource(app, p, first.id);
  const again = followSource(app, p, { ...base, token: hold(p, BIG) }); // the feed has shrunk
  assert.equal(again.id, first.id, "the same source is taken up again");
  assert.equal(row(app, first.id).via_gateway, 0);
  unfollowSource(app, p, first.id);
  followSource(app, p, { ...base, token: hold(p, BIG, { large: true }) });
  assert.equal(row(app, first.id).via_gateway, 1);
});

test("a source that is followed through the gateway keeps using it: a retry and the empty-feed check carry the instruction", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const s = followSource(app, p, { ...base, token: hold(p, BIG, { large: true }) });
  onSubscribed(app, s.id, "feed/7", { empty: false, viaGateway: true });
  app.db.run("UPDATE sources SET subscribed_at = ? WHERE id = ?", new Date(Date.now() - 3600_000).toISOString(), s.id);
  checkEmptyFeeds(app);
  const check = jobs(app).find((j) => j.idempotency_key.startsWith("empty-check:"));
  assert.deepEqual([check!.payload.feedUrl, check!.payload.trim], [BIG, true]);
  // A failed one retried by the person.
  app.db.run("UPDATE sources SET engine_stream_id = NULL, health = 'error' WHERE id = ?", s.id);
  retrySource(app, p, s.id);
  const retried = jobs(app).find((j) => j.idempotency_key === `subscribe:${s.id}`);
  assert.equal(retried!.payload.trim, true);
});

test("the worker moving a subscription to the gateway marks the source, which then keeps the gateway", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const s = followSource(app, p, { ...base, token: hold(p, BIG) });
  assert.equal(row(app, s.id).via_gateway, 0);
  onSubscribed(app, s.id, "feed/9", { viaGateway: true });
  assert.deepEqual([row(app, s.id).via_gateway, row(app, s.id).engine_stream_id], [1, "feed/9"]);
  onSubscribed(app, s.id, "feed/9", {}); // a later answer that says nothing does not unmark it
  assert.equal(row(app, s.id).via_gateway, 1);
});

test("sources the engine failed on with its own overload are subscribed once more, so the worker can move a big feed to the gateway", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const follow = (url: string, over: Record<string, unknown> = {}) => followSource(app, p, { ...base, token: hold(p, url, over) }).id;
  const gaveUp = follow("https://feeds.example/a.xml");
  const waiting = follow("https://feeds.example/b.xml");
  const privateOne = follow("https://patreon.example/rss?auth=0123456789abcdef0123456789abcdef", { privateWarning: "secret" });
  const notFound = follow("https://feeds.example/c.xml");
  const subscribed = follow("https://feeds.example/d.xml");
  const alreadyGateway = follow("https://feeds.example/e.xml", { large: true });
  const stillQueued = follow("https://feeds.example/f.xml");
  const fail = (id: string, text: string | null) => app.db.run("UPDATE sources SET health = 'error', health_text = ? WHERE id = ?", text, id);
  const settle = () => app.db.run("UPDATE jobs SET status = 'failed'");
  settle();
  fail(gaveUp, subscribeGaveUpText("unavailable"));
  fail(waiting, subscribeRetryText("unavailable"));
  fail(privateOne, subscribeGaveUpText("unavailable"));
  fail(notFound, subscribeGaveUpText("not_found"));
  fail(subscribed, subscribeGaveUpText("unavailable"));
  app.db.run("UPDATE sources SET engine_stream_id = 'feed/1' WHERE id = ?", subscribed);
  fail(alreadyGateway, subscribeGaveUpText("unavailable"));
  fail(stillQueued, subscribeRetryText("unavailable"));
  app.db.run("UPDATE jobs SET status = 'queued' WHERE idempotency_key = ?", `subscribe:${stillQueued}`);
  const before = jobs(app).length;
  retryOverloadedSubscribes(app);
  const added = jobs(app).slice(before);
  assert.deepEqual(added.map((j) => j.payload.sourceId).sort(), [gaveUp, waiting, privateOne].sort(), "only unavailable failures with no subscription and nothing already on its way");
  for (const j of added) assert.equal(j.idempotency_key, `gateway-retry:${j.payload.sourceId}`);
  const priv = added.find((j) => j.payload.sourceId === privateOne)!;
  assert.equal(priv.payload.feedUrl, `secret:source-urls/${privateOne}`);
  assert.equal(priv.payload.trim, undefined, "the worker decides for these; the job says nothing about size");
  // Once: the same sources are not asked again, whatever came of it.
  retryOverloadedSubscribes(app);
  app.db.run("UPDATE jobs SET status = 'failed' WHERE idempotency_key <> ?", `subscribe:${stillQueued}`);
  retryOverloadedSubscribes(app);
  assert.equal(jobs(app).length, before + 3);
  // And if the feed is moved, the source is working and says so as any new subscription does.
  onSubscribed(app, gaveUp, "feed/20", { viaGateway: true });
  assert.deepEqual([row(app, gaveUp).via_gateway, row(app, gaveUp).health], [1, "pending"]);
});

test("a feed that can't be followed even trimmed says it is too large to follow, not that the site isn't answering", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const s = followSource(app, p, { ...base, token: hold(p, BIG, { large: true }) });
  settleFailedJob(app, { kind: "engine.subscribe", payload: { sourceId: s.id } }, { finalFailure: true }, "too_large");
  assert.deepEqual([getSource(app, p, s.id).health, getSource(app, p, s.id).healthText], ["error", "The feed is too large to follow."]);
  // The same engine failure that is a real outage still says so.
  const o = followSource(app, p, { ...base, token: hold(p, "https://example.org/other.xml") });
  settleFailedJob(app, { kind: "engine.subscribe", payload: { sourceId: o.id } }, { finalFailure: false }, "unavailable");
  assert.equal(getSource(app, p, o.id).healthText, "The site isn't answering right now; we'll keep trying.");
});
