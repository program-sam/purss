import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { newId } from "@purss/domain";
import type { Principal } from "../app.ts";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { backfillFeedKeys, checkEmptyFeeds, followSource, getSource, presentCandidates, unfollowSource } from "./sources.ts";
import { previewOpml } from "./opml.ts";
import { applySyncBatch } from "./sync.ts";
import { batch, entry } from "../testing.ts";
import { writeSecret } from "../secrets.ts";
import { reconnectSource } from "./portability.ts";

const SECRET = "https://feeds.example/private/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c/feed.xml";
const base = { collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false, fullText: false };

function hold(p: Principal, feedUrl: string, over: Record<string, unknown> = {}): string {
  const token = newId("dsc");
  holdCandidate(token, p.workspaceId, { feedUrl, siteUrl: null, title: "Private feed", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: "This link has a secret in it.", ...over } as never);
  return token;
}
const draft = (feedUrl: string) => ({ feedUrl, siteUrl: null, title: "Private feed", kind: "feed" as const, origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: "This link has a secret in it." });
const linkFiles = (dir: string) => { try { return readdirSync(path.join(dir, "source-urls")); } catch { return []; } };

test("a private link's file goes when following fails after it was written; nothing is left for a deletion to miss", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  // The database gives way after the link was written (the subscription can't be queued).
  app.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  assert.throws(() => followSource(app, p, { ...base, token: hold(p, SECRET) }), /simulated failure/);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 0, "no source");
  assert.deepEqual(linkFiles(app.config.secretsDir), [], "and no link file");
  app.db.exec("DROP TRIGGER boom");
  const ok = followSource(app, p, { ...base, token: hold(p, SECRET) });
  assert.deepEqual(linkFiles(app.config.secretsDir), [ok.id], "a successful follow keeps its link, under its own source");
});

test("a private source is found again by a keyed hash of its link, in follow, discovery and the OPML preview; the link itself is stored nowhere", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const first = followSource(app, p, { ...base, token: hold(p, SECRET) });
  const row = app.db.get<{ feed_url: string | null; feed_key: string | null }>("SELECT feed_url, feed_key FROM sources WHERE id = ?", first.id)!;
  assert.equal(row.feed_url, null);
  assert.match(row.feed_key ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(row.feed_key, createHash("sha256").update(SECRET).digest("hex"), "a keyed hash, not one anyone can compute to test a guess");
  assert.ok(!JSON.stringify(app.db.all("SELECT * FROM sources")).includes("3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"));

  // The same link again (with a trailing slash or a fragment, as lists write them): already followed, not followed twice.
  const again = followSource(app, p, { ...base, token: hold(p, `${SECRET}#x`) });
  assert.equal(again.id, first.id);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 1, "and no second subscription");
  const [shown] = presentCandidates(app, p, [draft(SECRET)]);
  assert.equal(shown!.alreadyFollowingSourceId, first.id);

  const doc = `<opml><body><outline type="rss" text="Mine" xmlUrl="${SECRET}"/><outline type="rss" text="Other" xmlUrl="https://feeds.example/private/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feed.xml"/></body></opml>`;
  const preview = previewOpml(app, p, doc);
  assert.deepEqual(preview.feeds.map((f) => [f.alreadyFollowing, f.sourceId]), [[true, first.id], [false, null]]);

  // Another account's PURSS is its own: the same link there is new.
  const q = makeOwner(app, { admin: false });
  assert.equal(presentCandidates(app, q, [draft(SECRET)])[0]!.alreadyFollowingSourceId, null);
  // An unfollowed private source is not "already followed".
  unfollowSource(app, p, first.id);
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, null);
});

test("a private source whose key was lost is given one again from its link file; ones with no file are left alone", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const old = makeSource(app, p, "Old private", "feed/1", { isPrivate: true });
  writeSecret(app.config.secretsDir, `source-urls/${old}`, SECRET);
  const noFile = makeSource(app, p, "Came back from an export", "feed/2", { isPrivate: true });
  app.db.run("UPDATE sources SET health = 'reconnect' WHERE id = ?", noFile);
  // The first look at keys makes them for what is already there.
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, old);
  app.db.run("UPDATE sources SET feed_key = NULL WHERE id = ?", old);
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, null, "no key");
  backfillFeedKeys(app);
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, old);
  assert.equal(app.db.get<{ feed_key: string | null }>("SELECT feed_key FROM sources WHERE id = ?", noFile)!.feed_key, null);
});

test("the same private link in two PURSSes has two different keys, so the database does not say who follows what the others do", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const q = makeOwner(app, { admin: false });
  const a = followSource(app, p, { ...base, token: hold(p, SECRET) });
  const b = followSource(app, q, { ...base, token: hold(q, SECRET) });
  const keys = [a.id, b.id].map((id) => app.db.get<{ feed_key: string }>("SELECT feed_key FROM sources WHERE id = ?", id)!.feed_key);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, a.id);
  assert.equal(presentCandidates(app, q, [draft(SECRET)])[0]!.alreadyFollowingSourceId, b.id);
});

test("keys made by an older scheme are made again from the link files the first time, without alarm", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const warn = t.mock.method(console, "warn", () => {});
  const p = makeOwner(app);
  const id = makeSource(app, p, "Old", "feed/1", { isPrivate: true });
  writeSecret(app.config.secretsDir, `source-urls/${id}`, SECRET);
  app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", "aa".repeat(32), id); // as the first scheme made them: no workspace in it
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, id);
  assert.notEqual(app.db.get<{ feed_key: string }>("SELECT feed_key FROM sources WHERE id = ?", id)!.feed_key, "aa".repeat(32));
  assert.equal(warn.mock.callCount(), 0);
});

test("a lost, damaged or replaced feed-key file is noticed and answered: a warning, and every key made again from the link files", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const warn = t.mock.method(console, "warn", () => {});
  const p = makeOwner(app);
  const keyFile = path.join(app.config.secretsDir, "feed-key");
  const first = followSource(app, p, { ...base, token: hold(p, SECRET) });
  const noFile = makeSource(app, p, "Came back from an export", "feed/2", { isPrivate: true });
  app.db.run("UPDATE sources SET health = 'reconnect', feed_key = ? WHERE id = ?", "bb".repeat(32), noFile);
  const keyOf = () => app.db.get<{ feed_key: string }>("SELECT feed_key FROM sources WHERE id = ?", first.id)!.feed_key;
  const fingerprint = () => app.db.get<{ value: string }>("SELECT value FROM installation WHERE key = 'feed_key_check'")?.value;
  const secret = readFileSync(keyFile, "utf8").trim();
  assert.ok(secret.length >= 40, "a whole key");
  assert.match(fingerprint() ?? "", /^[0-9a-f]{64}$/, "its fingerprint is in the database");
  assert.ok(!(fingerprint() ?? "").includes(secret), "which is not the key");
  assert.deepEqual(readdirSync(app.config.secretsDir).filter((f) => f.includes("feed-key")), ["feed-key"], "written whole: no half-written file is left");
  const before = keyOf();

  // A restart with the key as it was: nothing to say.
  assert.equal(presentCandidates({ ...app }, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, first.id);
  assert.equal(warn.mock.callCount(), 0);

  // The file is gone.
  rmSync(keyFile);
  assert.equal(presentCandidates({ ...app }, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, first.id, "the same link is still found: its key was made again");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /feed-key/);
  assert.notEqual(keyOf(), before);
  assert.equal(app.db.get<{ feed_key: string | null }>("SELECT feed_key FROM sources WHERE id = ?", noFile)!.feed_key, null, "a source with no link file has no key to make");
  const afterLoss = keyOf();

  // The file is cut short.
  writeFileSync(keyFile, "abc");
  assert.equal(presentCandidates({ ...app }, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, first.id);
  assert.equal(warn.mock.callCount(), 2);
  assert.ok(readFileSync(keyFile, "utf8").trim().length >= 40, "replaced by a whole key");
  assert.notEqual(keyOf(), afterLoss);

  // Another key put in its place.
  writeFileSync(keyFile, `${"x".repeat(43)}\n`);
  assert.equal(presentCandidates({ ...app }, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, first.id);
  assert.equal(warn.mock.callCount(), 3);
  // And following the same link again afterwards is still one source.
  const again = followSource({ ...app }, p, { ...base, token: hold(p, SECRET) });
  assert.equal(again.id, first.id);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE feed_key IS NOT NULL")!.n, 1);
});

test("a source still waiting for its first items after the engine was asked is asked once more, not forever", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const stale = makeSource(app, p, "Stale", "feed/1", { settled: false });
  const fresh = makeSource(app, p, "Fresh", "feed/2", { settled: false });
  const busy = makeSource(app, p, "Busy", "feed/3", { settled: false });
  const unsubscribed = makeSource(app, p, "Not subscribed", "feed/4", { settled: false });
  const old = new Date(Date.now() - 3600_000).toISOString();
  for (const id of [stale, fresh, busy, unsubscribed]) app.db.run("UPDATE sources SET health = 'pending', health_text = 'Collecting the first items…' WHERE id = ?", id);
  app.db.run("UPDATE sources SET subscribed_at = ? WHERE id IN (?, ?)", old, stale, busy);
  app.db.run("UPDATE sources SET subscribed_at = ? WHERE id = ?", new Date().toISOString(), fresh);
  app.db.run("UPDATE sources SET engine_stream_id = NULL, subscribed_at = NULL WHERE id = ?", unsubscribed);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/3")]));
  app.db.run("UPDATE sources SET health = 'pending' WHERE id = ?", busy);

  checkEmptyFeeds(app);
  const jobs = () => app.db.all<{ payload: string; idempotency_key: string }>("SELECT payload, idempotency_key FROM jobs WHERE kind = 'engine.subscribe'");
  assert.deepEqual(jobs().map((j) => JSON.parse(j.payload).sourceId), [stale], "only the one that is pending, subscribed a while ago, with no items");
  assert.equal(JSON.parse(jobs()[0]!.payload).feedUrl, "https://example.org/feed/1.xml");
  checkEmptyFeeds(app);
  app.db.run("UPDATE jobs SET status = 'done'");
  checkEmptyFeeds(app);
  assert.equal(jobs().length, 1, "asked once, whatever its outcome");
  assert.equal(getSource(app, p, stale).health, "pending", "the answer, not the question, changes the source");
});

test("reconnecting a source that came back from an export gives it its key, so the same link is found afterwards", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const id = makeSource(app, p, "Came back", "feed/5", { isPrivate: true });
  app.db.run("UPDATE sources SET health = 'reconnect', followed = 1, engine_stream_id = NULL WHERE id = ?", id);
  reconnectSource(app, p, id, hold(p, SECRET));
  assert.match(app.db.get<{ feed_key: string | null }>("SELECT feed_key FROM sources WHERE id = ?", id)!.feed_key ?? "", /^[0-9a-f]{64}$/);
  assert.equal(presentCandidates(app, p, [draft(SECRET)])[0]!.alreadyFollowingSourceId, id);
});
