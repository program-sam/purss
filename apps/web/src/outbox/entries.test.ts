import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { backoffSeconds, classify, judgeConflict, notChangedMessage, removedFromBasket, scopeOf } from "./entries.ts";
import type { Entry } from "./entries.ts";

const base = { id: "e", installation: "https://purss.test", accountId: "acc", seq: 1, createdAt: "2026-11-03T08:00:00Z", attempts: 0, notBefore: 0 };

test("after a conflict the item is read: it already has the target workflow, or the change is dropped", () => {
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "toread" }), "done");
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "finished" }), "drop");
  // The workflow the change started from plays no part: an item that went new, finished, new elsewhere is still dropped.
  assert.equal(judgeConflict({ to: "toread" }, { workflow: "undecided" }), "drop");
});

test("a queued change of the player's counts as made only when it is that change that is there", () => {
  const change = { to: "inprogress" as const, playback: { sessionId: "play-1", expectedWorkflowRevision: 4 } };
  assert.equal(judgeConflict(change, { workflow: "inprogress", workflowRevision: 5, playbackWorkflowSessionId: "play-1" }), "done");
  assert.equal(judgeConflict(change, { workflow: "inprogress", workflowRevision: 5, playbackWorkflowSessionId: null }), "drop", "the same state chosen by hand is the person's");
  assert.equal(judgeConflict(change, { workflow: "inprogress", workflowRevision: 5, playbackWorkflowSessionId: "play-2" }), "drop", "or another session's");
  assert.equal(judgeConflict(change, { workflow: "inprogress", workflowRevision: 6, playbackWorkflowSessionId: "play-1" }), "drop", "a later change by hand wins");
  assert.equal(judgeConflict(change, { workflow: "toread", workflowRevision: 5, playbackWorkflowSessionId: null }), "drop");
});

test("an entry is filed under its installation and account", () => {
  assert.notEqual(scopeOf("https://a.example", "acc_1"), scopeOf("https://b.example", "acc_1"));
  assert.notEqual(scopeOf("https://a.example", "acc_1"), scopeOf("https://a.example", "acc_2"));
  assert.equal(scopeOf("https://a.example", "acc_1"), scopeOf("https://a.example", "acc_1"));
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
  assert.equal(classify({ status: 507, code: "allowance_full", message: "" }), "rejected");
  assert.equal(classify({ status: 404, code: "not_found", message: "" }), "rejected");
  assert.equal(classify({ status: 400, code: "bad_request", message: "" }), "rejected");
});

const t = app.outbox.entries;

test("waits grow and then settle at five minutes; the person is told plainly what was not changed", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffSeconds), [2, 5, 15, 60, 300, 300]);
  assert.equal(notChangedMessage("conflict", ""), t.conflict);
  assert.equal(notChangedMessage("rejected", "That item wasn't found."), t.rejected("That item wasn't found."));
  assert.equal(notChangedMessage("rejected", ""), t.couldntApply);
});
