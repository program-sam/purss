import test from "node:test";
import assert from "node:assert/strict";
import { FULL_TEXT_BACKFILL, newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";
import { changeState } from "./state.ts";
import { deleteItemNow } from "./collections.ts";
import { categories, reconcile, summary } from "./storage.ts";
import { AUTO_CAPTURE_SPACING_SECONDS, completeCapture } from "./captures.ts";
import { followSource, getSource, patchSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";

const pendingCaptures = (app: App, sourceId: string) => app.db.all<{ item_id: string }>(
  "SELECT c.item_id FROM captures c JOIN items i ON i.id = c.item_id WHERE i.source_id = ? AND c.status = 'pending'", sourceId).map((r) => r.item_id);
const captureJobs = (app: App) => app.db.all<{ payload: string; run_after: string }>("SELECT payload, run_after FROM jobs WHERE kind = 'capture.fulltext' ORDER BY run_after");

function setup(allocationBytes: number | null = null) {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app, { allocationBytes });
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  return { app, p, src, cleanup };
}

test("new items from a full-article source each get one readable-text capture, spaced out; replays add none", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const plain = makeSource(app, p, "Plain", "feed/2");
  patchSource(app, p, src, { fullText: true });
  const key = newId("bat");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1"), entry("feed/1"), entry("feed/2")], key));

  assert.equal(pendingCaptures(app, src).length, 3);
  assert.equal(pendingCaptures(app, plain).length, 0, "a source without full articles gets no captures");
  const jobs = captureJobs(app);
  assert.equal(jobs.length, 3);
  const urls = jobs.map((j) => JSON.parse(j.payload).url as string);
  const items = listItems(app, p, { scope: `source:${src}` }).items;
  assert.deepEqual(new Set(urls), new Set(items.map((i) => i.url)), "each capture fetches its item's page");
  const gaps = jobs.slice(1).map((j, i) => (Date.parse(j.run_after) - Date.parse(jobs[i]!.run_after)) / 1000);
  for (const g of gaps) assert.ok(g >= AUTO_CAPTURE_SPACING_SECONDS - 1, `captures are spaced out (gap ${g}s)`);

  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")], key));
  assert.equal(captureJobs(app).length, 3, "a replayed batch queues nothing more");

  // Spacing follows the last scheduled slot, also after earlier copies finished.
  const first = app.db.get<{ id: string }>("SELECT c.id FROM captures c JOIN jobs j ON json_extract(j.payload, '$.captureId') = c.id ORDER BY j.run_after LIMIT 1")!;
  app.db.tx(() => completeCapture(app, first.id, { ok: true, title: null, text: "x".repeat(300), html: "<p>x</p>", finalUrl: "https://example.org/x", bytes: 10 }));
  app.db.run("UPDATE jobs SET status = 'done' WHERE json_extract(payload, '$.captureId') = ?", first.id);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const waiting = app.db.all<{ run_after: string }>("SELECT run_after FROM jobs WHERE kind = 'capture.fulltext' AND status = 'queued' ORDER BY run_after");
  assert.equal(waiting.length, 3);
  for (let i = 1; i < waiting.length; i++) {
    assert.ok(Date.parse(waiting[i]!.run_after) - Date.parse(waiting[i - 1]!.run_after) >= AUTO_CAPTURE_SPACING_SECONDS * 1000, "slots stay spaced");
  }
});

test("the readable copy of a full-article item replaces the summary in the reader and counts as feed storage until kept", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  patchSource(app, p, src, { fullText: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const [item] = listItems(app, p, { scope: "all" }).items;
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", item!.id)!;
  assert.equal(summary(app, p.accountId).reservedBytes, 0, "an optional copy holds no reservation");
  const before = categories(app, p.accountId);
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text: "The whole article about estuarine mudflats", html: "<p>The whole article about estuarine mudflats</p>", finalUrl: item!.url!, bytes: 40 }));
  assert.match(getItemDetail(app, p, item!.id).contentHtml ?? "", /whole article/);
  assert.equal(listItems(app, p, { scope: "all", q: "estuarine" }).total, 1, "the full text is searchable");
  const copyBytes = app.db.get<{ bytes: number }>("SELECT bytes FROM stored_objects WHERE kind = 'capture' AND ref_id = ? AND released_at IS NULL", cap.id)!.bytes;
  const after = categories(app, p.accountId);
  assert.deepEqual([after.feed - before.feed, after.kept - before.kept, after.other - before.other], [copyBytes, 0, 0], "an unkept item's copy counts as feed storage");

  assert.ok(deleteItemNow(app, p, item!.id)! > 0);
  assert.equal(app.db.get("SELECT 1 FROM captures WHERE item_id = ?", item!.id), undefined, "deleting the item deletes its copy");
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("turning full articles on backfills the newest unfinished items once, and only where allowed", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: FULL_TEXT_BACKFILL + 5 }, () => entry("feed/1"))));
  assert.equal(captureJobs(app).length, 0, "nothing is fetched while the setting is off");
  const items = listItems(app, p, { scope: `source:${src}`, limit: 100 }).items;
  const newestFirst = [...items].sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!));
  changeState(app, p, newestFirst[0]!.id, { workflow: "finished", expectedRevision: newestFirst[0]!.revision });
  changeState(app, p, newestFirst[1]!.id, { workflow: "ignored", expectedRevision: newestFirst[1]!.revision });

  const dto = patchSource(app, p, src, { fullText: true });
  assert.equal(dto.fullText, true);
  const queued = new Set(pendingCaptures(app, src));
  assert.equal(queued.size, FULL_TEXT_BACKFILL);
  assert.deepEqual(queued, new Set(newestFirst.slice(2, 2 + FULL_TEXT_BACKFILL).map((i) => i.id)), "newest items that aren't Finished or Ignored");

  patchSource(app, p, src, { fullText: true });
  assert.equal(pendingCaptures(app, src).length, FULL_TEXT_BACKFILL, "setting it on again queues nothing more");
  assert.equal(patchSource(app, p, src, { fullText: false }).fullText, false);

  const video = makeSource(app, p, "Kiln & Coil", "feed/3", { kind: "youtube" });
  const priv = makeSource(app, p, "Members", "feed/4", { isPrivate: true });
  for (const id of [video, priv]) {
    assert.equal(getSource(app, p, id).fullTextAvailable, false);
    assert.throws(() => patchSource(app, p, id, { fullText: true }), (e: unknown) => e instanceof HttpError && e.code === "full_text_unavailable");
  }
});

test("a private source never gets automatic captures, even with the flag set in the database", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const priv = makeSource(app, p, "Members", "feed/9", { isPrivate: true });
  app.db.run("UPDATE sources SET full_text = 1 WHERE id = ?", priv);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/9")]));
  assert.equal(captureJobs(app).length, 0);
  assert.equal(getSource(app, p, priv).fullText, false);
});

const pausedReason = (app: App, p: Principal) => app.db.get<{ paused_reason: string | null }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", p.accountId)!.paused_reason;

test("optional copies never hold room the source's own items need", (t) => {
  // Room for a few items but not for a Keep-sized reservation: every item still arrives.
  const { app, p, src, cleanup } = setup(1_515_000);
  t.after(cleanup);
  patchSource(app, p, src, { fullText: true });
  const bulky = () => entry("feed/1", { contentHtml: `<p>${"sediment ".repeat(1100)}</p>` });
  assert.equal(applySyncBatch(app, p.engineUserId, batch([bulky(), bulky()])).accepted, 2);
  assert.equal(applySyncBatch(app, p.engineUserId, batch([bulky()])).accepted, 1, "copies waiting from an earlier batch don't block the next one");
  assert.equal(captureJobs(app).length, 3);
  assert.equal(summary(app, p.accountId).reservedBytes, 0);
  assert.equal(pausedReason(app, p), null);
});

test("when the account is out of room no copy is queued, and a copy that no longer fits is dropped without pausing growth", (t) => {
  const { app, p, src, cleanup } = setup(1_000_000);
  t.after(cleanup);
  patchSource(app, p, src, { fullText: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures")!;
  app.db.run("UPDATE storage_accounts SET allocation_bytes = ? WHERE account_id = ?", summary(app, p.accountId).usedBytes, p.accountId);
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: null, text: "y".repeat(400), html: `<p>${"y".repeat(400)}</p>`, finalUrl: "https://example.org/y", bytes: 800 }));
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures WHERE id = ?", cap.id)!.status, "failed");
  assert.equal(pausedReason(app, p), null, "an optional copy doesn't pause growth");

  app.db.run("UPDATE storage_accounts SET allocation_bytes = 1 WHERE account_id = ?", p.accountId);
  assert.throws(() => applySyncBatch(app, p.engineUserId, batch([entry("feed/1")])), "a full account still refuses new items as before");
  app.db.run("UPDATE storage_accounts SET paused_reason = NULL WHERE account_id = ?", p.accountId);
  const n = captureJobs(app).length;
  patchSource(app, p, src, { fullText: false });
  patchSource(app, p, src, { fullText: true });
  assert.equal(captureJobs(app).length, n, "turning it on while full queues nothing");
  assert.equal(pausedReason(app, p), null);
});

function hold(p: Principal, over: { kind?: "feed" | "youtube"; summariesOnly?: boolean } = {}): string {
  const token = newId("dsc");
  holdCandidate(token, p.workspaceId, {
    feedUrl: `https://example.org/${token}.xml`, siteUrl: "https://example.org/", title: "Quiet Harbour", kind: over.kind ?? "feed",
    origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: over.summariesOnly ?? true, privateWarning: null,
  });
  return token;
}

test("following can turn full articles on, except for kinds and private links that can't have them", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const base = { collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false };
  assert.equal(followSource(app, p, { ...base, token: hold(p), fullText: true }).fullText, true);
  assert.equal(followSource(app, p, { ...base, token: hold(p), fullText: false }).fullText, false);
  assert.equal(followSource(app, p, { ...base, token: hold(p, { kind: "youtube" }), fullText: true }).fullText, false);
  const priv = followSource(app, p, { ...base, token: hold(p), fullText: true, markPrivate: true });
  assert.equal(app.db.get<{ full_text: number }>("SELECT full_text FROM sources WHERE id = ?", priv.id)!.full_text, 0);
});

test("the setting travels in an export and is restored on import", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  const on = makeSource(a.app, pa, "Full", "feed/1");
  makeSource(a.app, pa, "Summaries", "feed/2");
  patchSource(a.app, pa, on, { fullText: true });

  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));
  assert.deepEqual(doc.sources.map((s: { title: string; fullText: boolean }) => [s.title, s.fullText]).sort(), [["Full", true], ["Summaries", false]]);

  applyImport(b.app, pb, stageImport(b.app, pb, doc).token);
  const rows = b.app.db.all<{ title: string; full_text: number }>("SELECT title, full_text FROM sources WHERE kind = 'feed' ORDER BY title");
  assert.deepEqual(rows.map((r) => [r.title, r.full_text]), [["Full", 1], ["Summaries", 0]]);
});
