import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { keepChanges, summariseBatch, workflowChanges } from "./batch.ts";
import type { Entry } from "./entries.ts";
import type { Outcome } from "./outbox.ts";

function item(id: string, workflow: WorkflowState, revision: number, basketIds: string[] = []): ItemDTO {
  return {
    id, sourceId: "src_a", sourceTitle: "S", kind: "article", title: id, url: null, author: null, excerpt: null, imageUrl: null, durationSeconds: null, readMinutes: null,
    doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow, revision, stateVersion: 4, fresh: false, progress: 0, opened: false, basketIds, curatorNote: null, media: null, annotatedAt: null,
  };
}
const entry = (id: string): Entry => ({ kind: "workflow", itemId: id, from: "new", to: "toread", revision: 1, id: `ent_${id}`, installation: "x", accountId: "acc", seq: 1, createdAt: "", attempts: 0, notBefore: 0 });

test("a change to several items is one change per item, each against that item's own workflow and revision", () => {
  const items = [item("a", "new", 5), item("b", "toread", 9), item("c", "finished", 2)];
  assert.deepEqual(workflowChanges(items, "finished"), [
    { kind: "workflow", itemId: "a", from: "new", to: "finished", revision: 5 },
    { kind: "workflow", itemId: "b", from: "toread", to: "finished", revision: 9 },
  ], "c already has it; a and b keep their own revisions");
  assert.deepEqual(workflowChanges(items, "ignored").map((c) => [c.itemId, c.revision]), [["a", 5], ["b", 9], ["c", 2]]);
});

test("keeping several items is one keep per item and basket, leaving out what is already kept", () => {
  const items = [item("a", "new", 1, ["bkt_1"]), item("b", "new", 1)];
  assert.deepEqual(keepChanges(items, ["a", "b", "far"], ["bkt_1", "bkt_2"]).map((c) => `${c.itemId}:${c.basketId}`), ["b:bkt_1", "far:bkt_1", "a:bkt_2", "b:bkt_2", "far:bkt_2"]);
  assert.deepEqual(keepChanges(items, ["a"], ["bkt_1"]), [], "nothing to do");
});

test("a group of changes is told in one line: how many items, what Undo reaches, what was refused", () => {
  const changes = [
    { kind: "workflow", itemId: "a", from: "new", to: "toread", revision: 1 },
    { kind: "workflow", itemId: "b", from: "new", to: "toread", revision: 1 },
    { kind: "workflow", itemId: "c", from: "new", to: "toread", revision: 1 },
    { kind: "workflow", itemId: "d", from: "new", to: "toread", revision: 1 },
  ] as const;
  const outs: Outcome[] = [
    { status: "sent", entry: entry("a"), result: { kind: "workflow", item: item("a", "toread", 6), undoToken: "und_a" }, late: false },
    { status: "deferred", entry: entry("b") },
    { status: "dropped", entry: entry("c"), reason: "conflict", message: "Not changed: this item was changed on another device.", late: false },
    { status: "sent", entry: entry("d"), result: { kind: "workflow", item: null, undoToken: null }, late: false },
  ];
  const sum = summariseBatch(changes, outs);
  assert.equal(sum.items, 3, "sent, waiting and already-there count; the refused one does not");
  assert.deepEqual(sum.tokens, ["und_a"]);
  assert.deepEqual(sum.waiting.map((w) => [w.entryId, w.change.kind === "workflow" ? w.change.itemId : ""]), [["ent_b", "b"]]);
  assert.deepEqual(sum.dropped.map((d) => d.reason), ["conflict"]);
  const keeps = summariseBatch([{ kind: "keep", itemId: "a", basketId: "x", on: true }, { kind: "keep", itemId: "a", basketId: "y", on: true }], [
    { status: "deferred", entry: entry("a") }, { status: "deferred", entry: entry("a") },
  ]);
  assert.equal(keeps.items, 1, "one item kept in two baskets is one item");
});
