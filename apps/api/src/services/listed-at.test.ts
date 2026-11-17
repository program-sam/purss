import test from "node:test";
import assert from "node:assert/strict";
import type { SyncEntry } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch, listedAtOf } from "./sync.ts";
import { listItems } from "./items.ts";
import { searchItems } from "./search.ts";

/*
 * An item's time in lists (migration 071): a post that came after its source was followed is listed when it arrived, whatever date
 * its publisher gave it, so a post dated hours before it was in the feed is not listed below posts that came before it. The back
 * catalogue is listed at its publication date. The publication date itself is kept and given with the item.
 */

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("a post its publisher dated hours before it was in the feed is listed when it arrived, above what came before it", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Journal", "feed/1");
  const walk = (entries: SyncEntry[]) => applySyncBatch(app, p.engineUserId, batch(entries));
  const earlier = entry("feed/1", { title: "Arrived an hour ago", publishedAt: ago(HOUR + 60_000), crawledAt: ago(HOUR) });
  walk([earlier]);
  const late = entry("feed/1", { title: "Dated ten hours ago, arrived now", publishedAt: ago(10 * HOUR), crawledAt: ago(60_000) });
  walk([late]);

  const items = listItems(app, p, { scope: "all", limit: 10 }).items;
  assert.deepEqual(items.map((i) => i.title), ["Dated ten hours ago, arrived now", "Arrived an hour ago"]);
  assert.equal(items[0]!.listedAt, late.crawledAt, "listed when it arrived");
  assert.equal(items[0]!.publishedAt, late.publishedAt, "and the publisher's date is kept");
  assert.deepEqual(listItems(app, p, { scope: "all", limit: 10, sort: "oldest" }).items.map((i) => i.title), ["Arrived an hour ago", "Dated ten hours ago, arrived now"]);
  assert.deepEqual(searchItems(app, p, "post", 10).map((i) => i.title), ["Dated ten hours ago, arrived now", "Arrived an hour ago"], "search lists them the same way");
});

test("a source's back catalogue is listed at its publication date, what comes after the follow at its arrival", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Just followed", "feed/2", { settled: false });
  const now = new Date().toISOString();
  const old = [3, 1, 2].map((d) => entry("feed/2", { title: `${d} days old`, publishedAt: ago(d * 24 * HOUR), crawledAt: now }));
  const undated = entry("feed/2", { title: "Undated", publishedAt: null, crawledAt: now });
  applySyncBatch(app, p.engineUserId, batch([...old, undated]));
  const items = listItems(app, p, { scope: "all", limit: 10 }).items;
  assert.deepEqual(items.map((i) => i.title), ["Undated", "1 days old", "2 days old", "3 days old"], "everything arrived at once, so it is ordered by when it was published");
  for (const i of items) assert.equal(i.listedAt, i.publishedAt ?? now);
});

test("the rule: arrival after the follow or once the source is settled, the publication date (else arrival) for the back catalogue", () => {
  const followed = "2026-11-10T12:00:00.000Z";
  const crawledAt = "2026-11-16T17:48:00.000Z";
  const source = (settled: boolean) => ({ created_at: followed, backlog_settled_at: settled ? "2026-11-10T13:00:00.000Z" : null });
  assert.equal(listedAtOf(source(false), { publishedAt: "2026-11-16T03:27:00.000Z", crawledAt }), crawledAt, "published after the follow");
  assert.equal(listedAtOf(source(true), { publishedAt: "2026-11-06T15:31:00.000Z", crawledAt }), crawledAt, "an old story put back in the feed of a settled source");
  assert.equal(listedAtOf(source(true), { publishedAt: null, crawledAt }), crawledAt);
  assert.equal(listedAtOf(source(false), { publishedAt: "2026-10-01T00:00:00.000Z", crawledAt }), "2026-10-01T00:00:00.000Z", "back catalogue");
  assert.equal(listedAtOf(source(false), { publishedAt: null, crawledAt }), crawledAt, "undated back catalogue");
});
