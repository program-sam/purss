import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { reconcile } from "./storage.ts";
import { acceptSuggested, listReconciliation, resolveEntry } from "./reconcile.ts";
import { HttpError } from "../http.ts";
import type { SyncEntry } from "@purss/domain";

/** An engine replaced after history exists: entries arrive under engine-B and wait for review. */
function replaced() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Sediment Letters", "feed/1");
  const e1 = entry("feed/1", { title: "First", originalGuid: "g1" });
  const e2 = entry("feed/1", { title: "Second", originalGuid: "g2" });
  const dupA = entry("feed/1", { title: "Twin A", originalGuid: "twin-a", url: "https://example.org/twin" });
  const dupB = entry("feed/1", { title: "Twin B", originalGuid: "twin-b", url: "https://example.org/twin" });
  applySyncBatch(app, p.engineUserId, batch([e1, e2, dupA, dupB], "a-1", "engine-A"));
  const again = (e: SyncEntry, over: Partial<SyncEntry> = {}): SyncEntry => ({ ...e, externalId: e.externalId.replace("0000", "9999"), ...over });
  const r1 = again(e1);
  const r2 = again(e2);
  const brandNew = entry("feed/1", { title: "Brand new", originalGuid: "g-new", url: "https://example.org/brand-new" });
  const ambiguous = entry("feed/1", { title: "Twin C", originalGuid: "twin-c", url: "https://example.org/twin" });
  const unmatched = entry("feed/1", { title: "Unknown stream", streamId: "feed/1", originalGuid: null, url: null });
  const res = applySyncBatch(app, p.engineUserId, batch([r1, r2, brandNew, ambiguous, unmatched], "b-1", "engine-B"));
  assert.equal(res.queuedForReview, 5);
  return { app, p, cleanup, e1, e2, r1, r2, brandNew, ambiguous, unmatched, items: () => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n };
}

test("the review queue shows candidates, with matches suggested only when clear", (t) => {
  const { app, p, cleanup, r1, brandNew, ambiguous } = replaced();
  t.after(cleanup);
  const list = listReconciliation(app, p);
  assert.equal(list.total, 5);
  const by = (title: string) => list.entries.find((e) => e.entry.title === title)!;
  assert.equal(by("First").suggestion, "match");
  assert.equal(by("First").candidate?.title, "First");
  assert.match(by("First").reason, /original ID/);
  assert.equal(by("Brand new").suggestion, "new");
  assert.equal(by("Brand new").candidate, null);
  assert.equal(by("Twin C").suggestion, "review", "two existing items share this link, so it needs a human");
  assert.equal(by("Twin C").candidate, null);
  assert.equal(by("Unknown stream").suggestion, "new");
  assert.equal(list.suggestedMatches, 2);
  assert.equal(by("First").sourceTitle, "Sediment Letters");
  assert.ok(!JSON.stringify(list).includes(r1.externalId), "engine ids stay server-side");
  void brandNew; void ambiguous;
});

test("bulk accept attaches the new engine identity to the existing items and leaves the rest for review", (t) => {
  const { app, p, cleanup, r1, r2, items } = replaced();
  t.after(cleanup);
  const before = items();
  const out = acceptSuggested(app, p);
  assert.deepEqual(out, { matched: 2, skipped: 3, remaining: 3 });
  assert.equal(items(), before, "no duplicates were created");
  const mapped = app.db.all<{ item_id: string; external_id: string }>("SELECT item_id, external_id FROM external_ids WHERE external_id IN (?, ?)", r1.externalId, r2.externalId);
  assert.equal(mapped.length, 2);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reconciliation_queue WHERE status = 'matched'")!.n, 2);
  assert.deepEqual(acceptSuggested(app, p), { matched: 0, skipped: 3, remaining: 3 }, "idempotent");
});

test("a genuinely new entry is created through the core item path; ambiguous ones need a choice", (t) => {
  const { app, p, cleanup, items } = replaced();
  t.after(cleanup);
  const queue = listReconciliation(app, p).entries;
  const id = (title: string) => queue.find((e) => e.entry.title === title)!.id;
  const before = items();

  const created = resolveEntry(app, p, id("Brand new"), "new");
  assert.equal(created.status, "new");
  assert.equal(items(), before + 1);
  const row = app.db.get<{ title: string; fresh: number }>("SELECT i.title, st.fresh FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.id = ?", created.itemId!)!;
  assert.deepEqual([row.title, row.fresh], ["Brand new", 0], "restored history is not 'new since you looked'");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM external_ids WHERE item_id = ?", created.itemId!)!.n, 1);
  assert.equal(reconcile(app, p.accountId).difference, 0, "storage admission went through the ledger");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items_fts WHERE items_fts MATCH '\"brand\"*'")!.n, 1, "and it is searchable");

  // The ambiguous entry has no candidate: matching needs an explicit item, and an unknown item is refused.
  assert.throws(() => resolveEntry(app, p, id("Twin C"), "match"), (e: unknown) => e instanceof HttpError && e.code === "choose_item");
  assert.throws(() => resolveEntry(app, p, id("Twin C"), "match", "itm_00000000000000000000000000"), (e: unknown) => e instanceof HttpError && e.status === 404);
  const twinA = app.db.get<{ id: string }>("SELECT id FROM items WHERE title = 'Twin A'")!.id;
  assert.equal(resolveEntry(app, p, id("Twin C"), "match", twinA).itemId, twinA);
  assert.equal(items(), before + 1, "matching created nothing");

  // Dismissing creates nothing, and a handled entry cannot be handled again.
  assert.equal(resolveEntry(app, p, id("Unknown stream"), "dismiss").status, "dismissed");
  assert.equal(items(), before + 1);
  assert.throws(() => resolveEntry(app, p, id("Unknown stream"), "new"), (e: unknown) => e instanceof HttpError && e.status === 409);
  assert.throws(() => resolveEntry(app, p, id("Brand new"), "dismiss"), (e: unknown) => e instanceof HttpError && e.status === 409);
});

test("an entry the owner deleted earlier is not resurrected, and other PURSSes cannot see or resolve it", (t) => {
  const { app, p, cleanup, brandNew } = replaced();
  t.after(cleanup);
  const queue = listReconciliation(app, p).entries;
  const target = queue.find((e) => e.entry.title === "Brand new")!;
  app.db.run("INSERT INTO item_tombstones (engine_user_id, external_id, deleted_at) VALUES (?, ?, ?)", p.engineUserId, brandNew.externalId, new Date().toISOString());
  assert.throws(() => resolveEntry(app, p, target.id, "new"), (e: unknown) => e instanceof HttpError && e.status === 409 && /deleted/.test(e.message));
  const stranger = makeOwner(app, { admin: false });
  assert.deepEqual(listReconciliation(app, stranger).entries, []);
  assert.throws(() => resolveEntry(app, stranger, target.id, "dismiss"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(acceptSuggested(app, stranger).matched, 0);
});

test("when the source is no longer followed the entry can be dismissed but not created", (t) => {
  const { app, p, cleanup } = replaced();
  t.after(cleanup);
  const queue = listReconciliation(app, p).entries;
  const target = queue.find((e) => e.entry.title === "Brand new")!;
  app.db.run("UPDATE sources SET engine_stream_id = NULL");
  assert.throws(() => resolveEntry(app, p, target.id, "new"), (e: unknown) => e instanceof HttpError && e.code === "source_gone");
  assert.equal(resolveEntry(app, p, target.id, "dismiss").status, "dismissed");
});
