import test from "node:test";
import assert from "node:assert/strict";
import type { App, Principal } from "../app.ts";
import type { SyncEntry } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { keepItem, unkeepItem } from "./state.ts";
import { createBasket, deleteItemNow } from "./collections.ts";
import { completeCapture } from "./captures.ts";
import { categories, recountCurrentFlags } from "./storage.ts";

/*
 * The storage split reads `stored_objects.is_current`, which database triggers keep equal to "this version is its item's
 * current version". Random operations through the product's own code (new items, upstream edits of kept and unkept
 * items, keeping with and without a readable copy, unkeeping, deleting) must leave the flag and the split equal to a
 * recount done one object at a time.
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

/** The split worked out from the tables, one object at a time. */
function recount(app: App, accountId: string): { kept: number; feed: number; other: number } {
  const keptVersions = new Set(app.db.all<{ v: string }>("SELECT version_id AS v FROM basket_items").map((r) => r.v));
  const keptItems = new Set(app.db.all<{ i: string }>("SELECT item_id AS i FROM basket_items").map((r) => r.i));
  const current = new Set(app.db.all<{ v: string }>("SELECT current_version_id AS v FROM items WHERE current_version_id IS NOT NULL").map((r) => r.v));
  const out = { kept: 0, feed: 0, other: 0 };
  for (const o of app.db.all<{ kind: string; ref_id: string; item_id: string | null; bytes: number }>("SELECT kind, ref_id, item_id, bytes FROM stored_objects WHERE account_id = ? AND released_at IS NULL", accountId)) {
    if ((o.kind === "item_version" && keptVersions.has(o.ref_id)) || (o.kind === "capture" && o.item_id !== null && keptItems.has(o.item_id))) out.kept += o.bytes;
    else if ((o.kind === "item_version" && current.has(o.ref_id)) || (o.kind === "capture" && o.item_id !== null)) out.feed += o.bytes;
    else out.other += o.bytes;
  }
  return out;
}

/** Live version objects whose flag disagrees with the items. */
const wrongFlags = (app: App) => app.db.get<{ n: number }>(
  `SELECT COUNT(*) AS n FROM stored_objects o WHERE o.kind = 'item_version' AND o.released_at IS NULL
     AND o.is_current <> EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = o.ref_id)`)!.n;

type Acct = { p: Principal & { engineUserId: string }; entries: SyncEntry[]; stream: number };

test("through random operations the current-version flag and the storage split equal a recount", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = rng(seed);
    const { app, cleanup } = makeTestApp();
    try {
      const accts: Acct[] = [0, 1].map((i) => {
        const p = makeOwner(app, { admin: i === 0 });
        makeSource(app, p, "S", `feed/${i}`);
        return { p, entries: [], stream: i };
      });
      const baskets = new Map(accts.map((a) => [a, [createBasket(app, a.p, { name: "Text", captureMode: "text" }).id, createBasket(app, a.p, { name: "Plain", captureMode: "metadata" }).id]]));
      const itemsOf = (a: Acct) => app.db.all<{ id: string; url: string }>("SELECT id, url FROM items WHERE workspace_id = ? ORDER BY seq", a.p.workspaceId);
      let ops = 0;
      for (let step = 0; step < 70; step++) {
        const a = accts[Math.floor(r() * 2)]!;
        const items = itemsOf(a);
        const roll = r();
        if (roll < 0.3 || items.length < 3) {
          const fresh = Array.from({ length: 1 + Math.floor(r() * 5) }, () => entry(`feed/${a.stream}`, { contentHtml: `<p>${"x".repeat(50 + Math.floor(r() * 400))}</p>` }));
          a.entries.push(...fresh);
          applySyncBatch(app, a.p.engineUserId, batch(fresh));
        } else if (roll < 0.5) {
          // An upstream edit of any item we delivered, kept or not.
          const e = a.entries[Math.floor(r() * a.entries.length)]!;
          if (itemsOf(a).some((i) => i.url === e.url)) applySyncBatch(app, a.p.engineUserId, batch([{ ...e, title: `${e.title}!`, contentHtml: `<p>${"edit".repeat(1 + Math.floor(r() * 80))}</p>` }]));
        } else if (roll < 0.72) {
          const it = items[Math.floor(r() * items.length)]!;
          keepItem(app, a.p, it.id, baskets.get(a)![Math.floor(r() * 2)]!);
        } else if (roll < 0.82) {
          const kept = app.db.all<{ item_id: string; basket_id: string }>("SELECT item_id, basket_id FROM basket_items WHERE workspace_id = ?", a.p.workspaceId);
          if (kept.length) { const k = kept[Math.floor(r() * kept.length)]!; unkeepItem(app, a.p, k.item_id, k.basket_id); }
        } else if (roll < 0.92) {
          const cap = app.db.get<{ id: string; item_id: string }>("SELECT id, item_id FROM captures WHERE workspace_id = ? AND status = 'pending' LIMIT 1", a.p.workspaceId);
          if (cap) completeCapture(app, cap.id, { ok: true, title: "t", text: "readable", html: "<p>readable</p>", finalUrl: "https://example.org/x", bytes: 8 });
        } else {
          const it = items[Math.floor(r() * items.length)]!;
          app.db.tx(() => deleteItemNow(app, a.p, it.id));
        }
        ops++;
        if (step % 5 === 4) {
          for (const x of accts) assert.deepEqual({ ...categories(app, x.p.accountId) }, recount(app, x.p.accountId), `seed ${seed}, after ${ops} operations`);
          assert.equal(wrongFlags(app), 0, `seed ${seed}, flags after ${ops} operations`);
        }
      }
      const total = accts.map((x) => categories(app, x.p.accountId));
      assert.ok(total.every((t) => t.kept > 0 && t.feed > 0 && t.other >= 0), `seed ${seed}: the run exercised kept and feed bytes`);
    } finally { cleanup(); }
  }
});

test("the flag follows an upstream edit: the new version is current, the old one is not, and a kept old one stays kept", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app);
    makeSource(app, p, "S", "feed/1");
    const basket = createBasket(app, p, { name: "K", captureMode: "metadata" }).id;
    const e = entry("feed/1", { contentHtml: "<p>first</p>" });
    applySyncBatch(app, p.engineUserId, batch([e]));
    const item = app.db.get<{ id: string }>("SELECT id FROM items")!.id;
    keepItem(app, p, item, basket);
    applySyncBatch(app, p.engineUserId, batch([{ ...e, contentHtml: "<p>second, edited upstream</p>" }]));
    const flags = app.db.all<{ is_current: number }>("SELECT o.is_current FROM stored_objects o WHERE o.kind = 'item_version' AND o.released_at IS NULL ORDER BY o.created_at, o.rowid").map((r) => r.is_current);
    assert.deepEqual(flags, [0, 1], "the pinned first version is no longer current; the edit is");
    const split = categories(app, p.accountId);
    assert.ok(split.kept > 0 && split.feed > 0);
    assert.deepEqual({ ...split }, recount(app, p.accountId));
    // Unkeeping releases the version nothing pins.
    unkeepItem(app, p, item, basket);
    assert.equal(wrongFlags(app), 0);
    assert.deepEqual({ ...categories(app, p.accountId) }, recount(app, p.accountId));
  } finally { cleanup(); }
});

test("the flag clears when an item is removed or points elsewhere while its version is still stored", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app);
    makeSource(app, p, "S", "feed/1");
    applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
    const [a, b] = app.db.all<{ id: string; current_version_id: string }>("SELECT id, current_version_id FROM items ORDER BY seq") as [{ id: string; current_version_id: string }, { id: string; current_version_id: string }];
    const flag = (version: string) => app.db.get<{ is_current: number }>("SELECT is_current FROM stored_objects WHERE kind = 'item_version' AND ref_id = ?", version)!.is_current;
    assert.deepEqual([flag(a.current_version_id), flag(b.current_version_id)], [1, 1]);
    app.db.run("UPDATE items SET current_version_id = NULL WHERE id = ?", a.id);
    assert.deepEqual([flag(a.current_version_id), flag(b.current_version_id)], [0, 1], "an item that points at nothing no longer holds a version current");
    app.db.run("UPDATE items SET current_version_id = ? WHERE id = ?", a.current_version_id, a.id);
    assert.equal(flag(a.current_version_id), 1);
    app.db.exec("PRAGMA foreign_keys = OFF");
    app.db.run("DELETE FROM items WHERE id = ?", b.id);
    assert.equal(flag(b.current_version_id), 0, "a removed item holds nothing current");
    assert.equal(wrongFlags(app), 0);
  } finally { cleanup(); }
});

test("the recount puts a drifted flag right, for one account or all", () => {
  const { app, cleanup } = makeTestApp();
  try {
    const a = makeOwner(app);
    const b = makeOwner(app, { admin: false });
    makeSource(app, a, "S", "feed/1");
    makeSource(app, b, "S", "feed/2");
    applySyncBatch(app, a.engineUserId, batch([entry("feed/1"), entry("feed/1")]));
    applySyncBatch(app, b.engineUserId, batch([entry("feed/2")]));
    assert.equal(wrongFlags(app), 0);
    // Flags knocked out by something that bypassed the product.
    app.db.run("UPDATE stored_objects SET is_current = 0 WHERE kind = 'item_version'");
    assert.equal(wrongFlags(app), 3);
    assert.equal(recountCurrentFlags(app, a.accountId), 2, "only this account's");
    assert.equal(wrongFlags(app), 1);
    assert.deepEqual({ ...categories(app, a.accountId) }, recount(app, a.accountId));
    assert.equal(recountCurrentFlags(app), 1);
    assert.equal(wrongFlags(app), 0);
    assert.equal(recountCurrentFlags(app), 0, "nothing left to correct");
    assert.deepEqual({ ...categories(app, b.accountId) }, recount(app, b.accountId));
  } finally { cleanup(); }
});
