import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnnotationDTO } from "@purss/domain";
import { MemoryOutboxStore, Outbox, mergeView, outboxAsText } from "./outbox.ts";
import type { OutboxEntry, SendOutcome } from "./outbox.ts";

const note = (body: string) => ({ kind: "note" as const, body, updatedAt: "2026-11-01T10:00:00.000Z" });
const put = (annotationId: string, body: string, at = "2026-11-01T10:00:00.000Z", accountId = "acc_a", itemId = "itm_1") =>
  ({ accountId, itemId, annotationId, at, op: "put" as const, body: { ...note(body), updatedAt: at } });
const remove = (annotationId: string, at: string, accountId = "acc_a", itemId = "itm_1") => ({ accountId, itemId, annotationId, at, op: "delete" as const });
const done = (_entry: OutboxEntry): SendOutcome => ({ kind: "done", result: { annotation: null, applied: true } });
const bodies = (o: Outbox) => o.snapshot().map((e) => (e.op === "put" ? `${e.annotationId}:${e.body.body}` : `${e.annotationId}:removed`));

test("a change replaces the unsent change of the same annotation and keeps its place after the others", async () => {
  const o = new Outbox(new MemoryOutboxStore());
  await o.record(put("ann_1", "first"));
  await o.record(put("ann_2", "other"));
  await o.record(put("ann_1", "second"));
  assert.deepEqual(bodies(o), ["ann_2:other", "ann_1:second"]);
  await o.record(remove("ann_2", "2026-11-01T10:05:00.000Z"));
  assert.deepEqual(bodies(o), ["ann_1:second", "ann_2:removed"]);
});

test("changes survive a reload: a new outbox over the same store finds them", async () => {
  const store = new MemoryOutboxStore();
  const before = new Outbox(store);
  await before.record(put("ann_1", "written offline"));
  const after = new Outbox(store);
  await after.load();
  assert.deepEqual(bodies(after), ["ann_1:written offline"]);
});

test("flush sends in order, stops when it has to wait, marks refusals failed, and drops refused removals", async () => {
  const o = new Outbox(new MemoryOutboxStore());
  await o.record(put("ann_1", "one"));
  await o.record(put("ann_2", "two"));
  await o.record(remove("ann_3", "2026-11-01T10:00:00.000Z"));
  await o.record(put("ann_4", "four"));
  const sent: string[] = [];
  const applied: string[] = [];
  let offline = true;
  const send = async (e: OutboxEntry): Promise<SendOutcome> => {
    sent.push(e.annotationId);
    if (offline) return { kind: "later" };
    if (e.annotationId === "ann_2") return { kind: "refused", message: "This item was deleted." };
    if (e.annotationId === "ann_3") return { kind: "refused", message: "nope" };
    return done(e);
  };
  await o.flush("acc_a", send, (e) => applied.push(e.annotationId));
  assert.deepEqual(sent, ["ann_1"], "offline: the first one waits and nothing after it is tried");
  assert.equal(o.snapshot().length, 4);

  offline = false;
  sent.length = 0;
  await o.flush("acc_a", send, (e) => applied.push(e.annotationId));
  assert.deepEqual(sent, ["ann_1", "ann_2", "ann_3", "ann_4"], "in the order they were made");
  assert.deepEqual(applied, ["ann_1", "ann_4"]);
  assert.deepEqual(o.snapshot().map((e) => [e.annotationId, e.status, e.error]), [["ann_2", "failed", "This item was deleted."]], "the refused note stays, with why");

  sent.length = 0;
  await o.flush("acc_a", send, () => undefined);
  assert.deepEqual(sent, [], "a failed change waits for the person");
  await o.retry(o.snapshot()[0]!.seq!);
  assert.equal(o.snapshot()[0]!.status, "waiting");
  await o.discard(o.snapshot()[0]!.seq!);
  assert.equal(o.snapshot().length, 0);
});

test("a change made while an older one is being sent isn't lost or held up, and is sent next", async () => {
  const o = new Outbox(new MemoryOutboxStore());
  await o.record(put("ann_1", "old", "2026-11-01T10:00:00.000Z"));
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const send = async (e: OutboxEntry): Promise<SendOutcome> => {
    sent.push(e.op === "put" ? e.body.body ?? "" : "removed");
    if (sent.length === 1) await gate;
    return done(e);
  };
  const flushing = o.flush("acc_a", send, () => undefined);
  await new Promise((r) => setTimeout(r, 5));
  await o.record(put("ann_1", "new", "2026-11-01T10:01:00.000Z"));
  assert.deepEqual(bodies(o), ["ann_1:new"], "recorded at once, while the old one is still in flight");
  void o.flush("acc_a", send, () => undefined);
  release();
  await flushing;
  assert.deepEqual(sent, ["old", "new"]);
  assert.equal(o.snapshot().length, 0);
});

test("only the signed-in account's changes are sent, and another account's are deleted on change of account", async () => {
  const o = new Outbox(new MemoryOutboxStore());
  await o.record(put("ann_1", "mine", undefined, "acc_a"));
  await o.record(put("ann_2", "theirs", undefined, "acc_b"));
  const sent: string[] = [];
  await o.flush("acc_b", async (e) => { sent.push(e.annotationId); return { kind: "later" }; }, () => undefined);
  assert.deepEqual(sent, ["ann_2"]);
  await o.clearExcept("acc_b");
  assert.deepEqual(bodies(o), ["ann_2:theirs"]);
  await o.clearExcept(null);
  assert.equal(o.snapshot().length, 0, "sign-out deletes everything");
});

test("the reader shows the server's annotations with this device's unsent changes laid over them", () => {
  const server: AnnotationDTO[] = [
    { id: "ann_1", itemId: "itm_1", kind: "note", quote: null, position: null, target: null, body: "server text", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "ann_2", itemId: "itm_1", kind: "note", quote: null, position: null, target: null, body: "to remove", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  ];
  const entries: OutboxEntry[] = [
    { ...put("ann_1", "edited offline", "2026-11-01T10:00:00.000Z"), seq: 1, status: "waiting" },
    { ...remove("ann_2", "2026-11-01T10:00:00.000Z"), seq: 2, status: "waiting" },
    { accountId: "acc_a", itemId: "itm_1", annotationId: "ann_3", at: "2026-11-01T10:02:00.000Z", op: "put", seq: 3, status: "failed", error: "Refused",
      body: { kind: "highlight", quote: { exact: "a passage" }, body: null, updatedAt: "2026-11-01T10:02:00.000Z" } },
    { ...put("ann_9", "other item", undefined, "acc_a", "itm_2"), seq: 4, status: "waiting" },
  ];
  const view = mergeView(server, entries, "itm_1");
  assert.deepEqual(view.map((a) => [a.id, a.body, a.sync]), [["ann_1", "edited offline", "waiting"], ["ann_3", null, "failed"]]);
  assert.equal(view[0]!.createdAt, "2026-10-01T00:00:00.000Z", "an edit keeps the creation time");
  assert.deepEqual(view[1]!.quote, { exact: "a passage", prefix: "", suffix: "" });
  assert.equal(view[1]!.error, "Refused");
});

test("unsent writing can be copied out as plain text; removals carry none", () => {
  const entries: OutboxEntry[] = [
    { ...put("ann_1", "A thought\nover two lines", "2026-11-01T10:00:00.000Z"), status: "waiting" },
    { ...remove("ann_2", "2026-11-01T10:01:00.000Z"), status: "waiting" },
    { accountId: "acc_a", itemId: "itm_2", annotationId: "ann_3", at: "2026-11-01T10:02:00.000Z", op: "put", status: "failed",
      body: { kind: "highlight", quote: { exact: "quoted\ntext", prefix: "", suffix: "" }, position: null, target: null, body: null, updatedAt: "2026-11-01T10:02:00.000Z" } },
  ];
  assert.equal(outboxAsText(entries), "Note · 2026-11-01T10:00:00.000Z · item itm_1\nA thought\nover two lines\n\nHighlight · 2026-11-01T10:02:00.000Z · item itm_2\n> quoted\n> text");
});
