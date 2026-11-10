import test from "node:test";
import assert from "node:assert/strict";
import type { SyncEntry } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { seedLibrary } from "../features-testing.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { changeState, keepItem, unkeepItem } from "./state.ts";
import { createBasket, deleteItemNow } from "./collections.ts";
import { completeCapture, failCapture } from "./captures.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { admitObject, addUsedBytes, countedBytes, expireReservations, recountUsedBytes, reconcile, releaseObject, reservedBytes, usedBytes } from "./storage.ts";

/*
 * The used-bytes total is what the quota check reads on every admitted object. Random operations through the product's
 * own code (new items, upstream edits, keeping with a readable copy, unkeeping, captures finishing or failing, deleting,
 * importing, state records, reservations expiring) must leave it equal to a recount of the live objects, to what the usage
 * ledger adds up to, and leave the reserved total equal to the open, unexpired reservations: including when the quota
 * refuses an object and its transaction rolls back.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Straight from the tables, without the product's helpers. */
const liveBytes = (app: App, accountId: string) =>
  app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE account_id = ? AND released_at IS NULL", accountId)!.n;
const ledgerBytes = (app: App, accountId: string) =>
  app.db.get<{ n: number }>("SELECT COALESCE(SUM(delta_bytes), 0) AS n FROM usage_events WHERE account_id = ?", accountId)!.n;
const openReservations = (app: App, accountId: string) =>
  app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM reservations WHERE account_id = ? AND settled_at IS NULL AND released_at IS NULL AND expires_at > ?", accountId, new Date().toISOString())!.n;

type Acct = { p: Principal & { engineUserId: string }; entries: SyncEntry[]; stream: string; baskets: string[] };

/** What a refusal for lack of room looks like; anything else is a bug. */
const refused = (fn: () => unknown) => {
  try { fn(); return false; } catch (e) { if (e instanceof HttpError) return true; throw e; }
};

test("through random operations the used-bytes total equals a recount, the ledger and the reservations", async () => {
  let refusals = 0, imports = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = rng(seed);
    const mine = makeTestApp();
    const theirs = makeTestApp();
    try {
      const app = mine.app;
      // The source of what gets imported: a library built elsewhere.
      const other = makeOwner(theirs.app);
      seedLibrary(theirs.app, other);
      const parts: string[] = [];
      await streamExport(theirs.app, other, (c) => { parts.push(c); });
      const archive = JSON.parse(parts.join("")) as unknown;

      const accts: Acct[] = [1_800_000, null].map((allocation, i) => {
        const p = makeOwner(app, { admin: i === 0, allocationBytes: allocation });
        makeSource(app, p, "S", `feed/${i}`);
        return { p, entries: [], stream: `feed/${i}`, baskets: [createBasket(app, p, { name: "Text", captureMode: "text" }).id, createBasket(app, p, { name: "Plain", captureMode: "metadata" }).id] };
      });
      const itemsOf = (a: Acct) => app.db.all<{ id: string; url: string }>("SELECT id, url FROM items WHERE workspace_id = ? ORDER BY seq", a.p.workspaceId);
      const check = (where: string) => {
        for (const a of accts) {
          const id = a.p.accountId;
          assert.equal(usedBytes(app, id), liveBytes(app, id), `seed ${seed}: total vs live objects, ${where}`);
          assert.equal(usedBytes(app, id), ledgerBytes(app, id), `seed ${seed}: total vs usage ledger, ${where}`);
          assert.equal(reservedBytes(app, id), openReservations(app, id), `seed ${seed}: reserved, ${where}`);
          assert.deepEqual({ ...reconcile(app, id) }, { ledger: ledgerBytes(app, id), objects: liveBytes(app, id), difference: 0, tracked: liveBytes(app, id), trackedDifference: 0 }, `seed ${seed}: reconcile, ${where}`);
        }
      };

      for (let step = 0; step < 90; step++) {
        const a = accts[Math.floor(r() * 2)]!;
        const items = itemsOf(a);
        const roll = r();
        let what: string;
        if (roll < 0.25 || items.length < 3) {
          what = "sync";
          const fresh = Array.from({ length: 1 + Math.floor(r() * 4) }, () => entry(a.stream, { contentHtml: `<p>${"x".repeat(100 + Math.floor(r() * 3000))}</p>` }));
          if (refused(() => applySyncBatch(app, a.p.engineUserId, batch(fresh)))) refusals++; else a.entries.push(...fresh);
        } else if (roll < 0.38) {
          what = "edit";
          const e = a.entries[Math.floor(r() * a.entries.length)];
          if (e && itemsOf(a).some((i) => i.url === e.url)) {
            if (refused(() => applySyncBatch(app, a.p.engineUserId, batch([{ ...e, title: `${e.title}!`, contentHtml: `<p>${"edit".repeat(1 + Math.floor(r() * 400))}</p>` }])))) refusals++;
          }
        } else if (roll < 0.55) {
          what = "keep";
          const it = items[Math.floor(r() * items.length)]!;
          if (refused(() => keepItem(app, a.p, it.id, a.baskets[Math.floor(r() * 2)]!))) refusals++;
        } else if (roll < 0.63) {
          what = "unkeep";
          const kept = app.db.all<{ item_id: string; basket_id: string }>("SELECT item_id, basket_id FROM basket_items WHERE workspace_id = ?", a.p.workspaceId);
          if (kept.length) { const k = kept[Math.floor(r() * kept.length)]!; unkeepItem(app, a.p, k.item_id, k.basket_id); }
        } else if (roll < 0.74) {
          what = "capture";
          const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE workspace_id = ? AND status = 'pending' LIMIT 1", a.p.workspaceId);
          if (cap) {
            if (r() < 0.75) app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "t", text: "readable ".repeat(1 + Math.floor(r() * 4000)), html: "<p>readable</p>", finalUrl: "https://example.org/x", bytes: 8 }));
            else app.db.tx(() => failCapture(app, cap.id, "The page couldn't be captured."));
          }
        } else if (roll < 0.82) {
          what = "delete";
          const it = items[Math.floor(r() * items.length)]!;
          app.db.tx(() => deleteItemNow(app, a.p, it.id));
        } else if (roll < 0.88) {
          what = "state";
          const it = items[Math.floor(r() * items.length)]!;
          const rev = app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", it.id)!.revision;
          if (refused(() => changeState(app, a.p, it.id, { workflow: (["toread", "finished", "ignored"] as const)[Math.floor(r() * 3)]!, expectedRevision: rev }))) refusals++;
        } else if (roll < 0.94) {
          what = "reservation expiry";
          const open = app.db.all<{ id: string }>("SELECT id FROM reservations WHERE account_id = ? AND settled_at IS NULL AND released_at IS NULL", a.p.accountId);
          if (open.length) app.db.run("UPDATE reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", open[Math.floor(r() * open.length)]!.id);
          if (r() < 0.5) expireReservations(app);
        } else {
          what = "import";
          if (refused(() => { const preview = stageImport(app, a.p, archive); if (preview.fits) { applyImport(app, a.p, preview.token); imports++; } })) refusals++;
        }
        check(`after step ${step} (${what})`);
        // Keeping with a readable copy that does not fit is refused inside the keep, which then only notes it: growth is paused.
        if (app.db.get("SELECT 1 FROM storage_accounts WHERE account_id = ? AND paused_reason IS NOT NULL", accts[0]!.p.accountId)) { refusals++; app.db.run("UPDATE storage_accounts SET paused_reason = NULL WHERE account_id = ?", accts[0]!.p.accountId); }
      }
      assert.ok(accts.every((a) => usedBytes(app, a.p.accountId) > 0));
    } finally { mine.cleanup(); theirs.cleanup(); }
  }
  assert.ok(refusals > 0, "the quota refused something along the way, and the totals held");
  assert.ok(imports > 0, "an import went through");
});

test("the recount finds a drifted total and puts it right, one account at a time", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const a = makeOwner(app);
    const b = makeOwner(app, { admin: false });
    makeSource(app, a, "S", "feed/1");
    makeSource(app, b, "S", "feed/2");
    applySyncBatch(app, a.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
    applySyncBatch(app, b.engineUserId, batch([entry("feed/2")]));
    assert.deepEqual(recountUsedBytes(app, a.accountId), { tracked: liveBytes(app, a.accountId), counted: liveBytes(app, a.accountId) });
    // Something wrote around the product: one total too high, one too low.
    app.db.run("UPDATE storage_accounts SET used_bytes = used_bytes + 1000 WHERE account_id = ?", a.accountId);
    app.db.run("UPDATE storage_accounts SET used_bytes = 5 WHERE account_id = ?", b.accountId);
    assert.equal(reconcile(app, a.accountId).trackedDifference, 1000, "reported without repair");
    assert.equal(usedBytes(app, a.accountId), liveBytes(app, a.accountId) + 1000, "and left alone");
    const fixed = recountUsedBytes(app, a.accountId);
    assert.deepEqual(fixed, { tracked: liveBytes(app, a.accountId) + 1000, counted: liveBytes(app, a.accountId) });
    assert.equal(usedBytes(app, a.accountId), liveBytes(app, a.accountId));
    assert.equal(usedBytes(app, b.accountId), 5, "the other account is untouched until it is checked");
    assert.equal(reconcile(app, b.accountId, { repair: true }).trackedDifference, 5 - liveBytes(app, b.accountId));
    assert.equal(usedBytes(app, b.accountId), liveBytes(app, b.accountId));
  } finally { cleanup(); }
});

test("an account with objects but no storage row gets one, with its total", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const a = makeOwner(app);
    app.db.run("DELETE FROM storage_accounts WHERE account_id = ?", a.accountId);
    app.db.tx(() => admitObject(app, { accountId: a.accountId, workspaceId: a.workspaceId, kind: "record", refId: "r1", bytes: 40, reason: "test" }));
    assert.equal(usedBytes(app, a.accountId), 40);
    assert.equal(app.db.get("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", a.accountId)?.allocation_bytes, null, "unallocated, as before");
    app.db.tx(() => releaseObject(app, "record", "r1", "test"));
    assert.equal(usedBytes(app, a.accountId), 0);
    addUsedBytes(app, a.accountId, 7);
    assert.equal(usedBytes(app, a.accountId), 7);
    assert.equal(countedBytes(app, a.accountId), 0);
  } finally { cleanup(); }
});

test("a refused admission leaves the total as it was", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app, { allocationBytes: 1000 });
    app.db.tx(() => admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: "a", bytes: 900, reason: "test" }));
    assert.throws(() => app.db.tx(() => admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: "b", bytes: 200, reason: "test" })), HttpError);
    assert.equal(usedBytes(app, p.accountId), 900);
    assert.equal(liveBytes(app, p.accountId), 900);
    // The quota counts the object that is there, once; releasing it makes room again.
    app.db.tx(() => releaseObject(app, "record", "a", "test"));
    app.db.tx(() => admitObject(app, { accountId: p.accountId, workspaceId: p.workspaceId, kind: "record", refId: "b", bytes: 200, reason: "test" }));
    assert.equal(usedBytes(app, p.accountId), 200);
  } finally { cleanup(); }
});
