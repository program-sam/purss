import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { backoffSeconds, classify, judgeConflict, notChangedMessage, overlayItem, removedFromBasket, scopeOf } from "./entries.ts";
import type { Entry } from "./entries.ts";

const item: ItemDTO = {
  id: "itm_a", sourceId: "src_a", sourceTitle: "S", kind: "article", title: "T", url: null, author: null, excerpt: null, imageUrl: null,
  durationSeconds: null, readMinutes: null, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 3, stateVersion: 4, fresh: true,
  progress: 0, opened: false, basketIds: ["bkt_1"], curatorNote: null, media: null, annotatedAt: null,
};
const base = { id: "e", installation: "https://purss.test", accountId: "acc", seq: 1, createdAt: "2026-11-03T08:00:00Z", attempts: 0, notBefore: 0 };

test("after a conflict the item is read: it already has the target workflow, or the change is dropped", () => {
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "toread" }), "done");
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "finished" }), "drop");
  // The workflow the change started from plays no part: an item that went new, finished, new elsewhere is still dropped.
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "new" }), "drop");
});

test("an entry is filed under its installation and account", () => {
  assert.notEqual(scopeOf("https://a.example", "acc_1"), scopeOf("https://b.example", "acc_1"));
  assert.notEqual(scopeOf("https://a.example", "acc_1"), scopeOf("https://a.example", "acc_2"));
  assert.equal(scopeOf("https://a.example", "acc_1"), scopeOf("https://a.example", "acc_1"));
});

test("pending changes are shown on an item in the order they were made", () => {
  const entries: Entry[] = [
    { ...base, seq: 1, kind: "workflow", itemId: "itm_a", from: "new", to: "toread", revision: 3 },
    { ...base, seq: 2, kind: "workflow", itemId: "itm_a", from: "toread", to: "finished", revision: 3 },
    { ...base, seq: 3, kind: "keep", itemId: "itm_a", basketId: "bkt_2", on: true },
    { ...base, seq: 4, kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false },
    { ...base, seq: 5, kind: "workflow", itemId: "itm_other", from: "new", to: "ignored", revision: 1 },
    { ...base, seq: 6, kind: "clearFresh", itemIds: ["itm_a", "itm_z"] },
  ];
  const out = overlayItem(item, entries);
  assert.equal(out.workflow, "finished");
  assert.deepEqual(out.basketIds, ["bkt_2"]);
  assert.equal(out.fresh, false);
  assert.equal(out.revision, 3, "the revision is PURSS's to move");
  assert.equal(overlayItem(item, []), item);
});

test("an item pending removal from a basket is hidden from that basket's page until it is sent", () => {
  const entries: Entry[] = [
    { ...base, seq: 1, kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false },
    { ...base, seq: 2, kind: "keep", itemId: "itm_b", basketId: "bkt_1", on: false },
    { ...base, seq: 3, kind: "keep", itemId: "itm_b", basketId: "bkt_1", on: true },
    { ...base, seq: 4, kind: "keep", itemId: "itm_c", basketId: "bkt_2", on: false },
  ];
  assert.deepEqual([...removedFromBasket(entries, "bkt_1")], ["itm_a"]);
});

test("failures are told apart by what to do next", () => {
  assert.equal(classify({ status: 0, code: "offline", message: "" }), "connection");
  assert.equal(classify({ status: 401, code: "unauthorized", message: "" }), "signed-out");
  assert.equal(classify({ status: 403, code: "signed_out", message: "" }), "signed-out");
  assert.equal(classify({ status: 409, code: "conflict", message: "" }), "conflict");
  assert.equal(classify({ status: 409, code: "storage_full", message: "" }), "rejected");
  assert.equal(classify({ status: 500, code: "error", message: "" }), "later");
  assert.equal(classify({ status: 429, code: "rate_limited", message: "" }), "later");
  assert.equal(classify({ status: 507, code: "quota_full", message: "" }), "rejected");
  assert.equal(classify({ status: 404, code: "not_found", message: "" }), "rejected");
  assert.equal(classify({ status: 400, code: "bad_request", message: "" }), "rejected");
});

test("waits grow and then settle at five minutes; the person is told plainly what was not changed", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffSeconds), [2, 5, 15, 60, 300, 300]);
  assert.equal(notChangedMessage("conflict", ""), "Not changed: this item was changed on another device.");
  assert.equal(notChangedMessage("rejected", "That item wasn't found."), "Not changed. That item wasn't found.");
  assert.equal(notChangedMessage("rejected", ""), "Not changed. PURSS couldn't apply it.");
});
