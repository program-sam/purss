import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { app } from "@purss/translations/app";
import { isolate } from "../lib/bidi.ts";
import { workflowLabel } from "../lib/constants.ts";
import { isNewerCopy } from "../lib/items.ts";
import type { LateStore } from "../lib/late-writes.ts";
import { createSeenStore } from "../lib/open-item.ts";
import { plural } from "../lib/format.ts";
import { onManualWorkflowChange } from "../state/workflow-intent.ts";
import type { PlaybackWorkflow } from "./entries.ts";
import { notChangedMessage } from "./entries.ts";
import type { Entry } from "./entries.ts";
import { createItemWriter, overlayItem, showChange, writeState } from "./item-writer.ts";
import type { ItemCache, Say, StateRequests, Written } from "./item-writer.ts";
import { Outbox } from "./outbox.ts";
import type { Sender } from "./outbox.ts";
import { MemoryStore } from "./store.ts";

const t = app.state.actions;

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "itm_a", number: 1, sourceId: "src_a", sourceTitle: "S", keptByHand: false, kind: "article", title: "T", url: null, author: null, excerpt: null, imageUrl: null,
    durationSeconds: null, readMinutes: null, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", listedAt: "2026-11-03T08:00:00Z", workflow: "undecided",
    revision: 5, workflowRevision: 0, playbackWorkflowSessionId: null, stateVersion: 4, isNew: true, progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null, ...over,
  };
}
const base = { id: "e", installation: "https://purss.test", accountId: "acc", seq: 1, createdAt: "2026-11-03T08:00:00Z", attempts: 0, notBefore: 0 };

// ---------- how a change appears on an item ----------

test("a change waiting in the outbox shows the New marker gone after a reload, as PURSS will answer it", () => {
  const a = item({ basketIds: ["bkt_1"] });
  const workflow: Entry = { ...base, kind: "workflow", itemId: "itm_a", from: "undecided", to: "toread", revision: 5 };
  const kept: Entry = { ...base, kind: "keep", itemId: "itm_a", basketId: "bkt_2", on: true };
  const unkept: Entry = { ...base, kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false };
  const undo: Entry = { ...base, kind: "undoWorkflow", itemId: "itm_a", applied: "toread", restore: "undecided" };
  assert.equal(overlayItem(a, [workflow]).isNew, false, "a workflow change");
  assert.equal(overlayItem(a, [kept]).isNew, false, "keeping");
  assert.equal(overlayItem(a, [unkept]).isNew, false, "taking it out of a basket");
  assert.equal(overlayItem(item({ workflow: "toread" }), [undo]).isNew, false, "an Undo that is waiting for the item to be read");
});

test("a change that changes nothing leaves the item, New marker included, as PURSS does", () => {
  const a = item({ workflow: "toread", basketIds: ["bkt_1"] });
  assert.equal(showChange(a, { kind: "workflow", itemId: "itm_a", from: "undecided", to: "toread", revision: 5 }), a, "the workflow it already has");
  assert.equal(showChange(a, { kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: true }), a, "a basket it is already in");
  assert.equal(showChange(a, { kind: "keep", itemId: "itm_a", basketId: "bkt_2", on: false }), a, "a basket it is not in");
  assert.equal(showChange(item({ isNew: false }), { kind: "clearNew", itemIds: ["itm_a"] }).isNew, false);
  assert.equal(showChange(a, { kind: "clearNew", itemIds: ["itm_other"] }), a, "an item the change is not about");
  assert.equal(showChange(a, { kind: "workflow", itemId: "itm_other", from: "undecided", to: "finished", revision: 5 }), a);
  assert.equal(showChange(item({ workflow: "finished" }), { kind: "undoWorkflow", itemId: "itm_a", applied: "toread", restore: "undecided" }).workflow, "finished", "an Undo of a workflow the item no longer has");
});

test("a workflow change moves the workflow revision a step and leaves the revision to PURSS", () => {
  const shown = showChange(item(), { kind: "workflow", itemId: "itm_a", from: "undecided", to: "toread", revision: 5 });
  assert.deepEqual([shown.workflow, shown.workflowRevision, shown.revision, shown.playbackWorkflowSessionId, shown.isNew], ["toread", 1, 5, null, false]);
  const playback: PlaybackWorkflow = { sessionId: "play-1", expectedWorkflowRevision: 0, startedWorkflowRevision: 0 };
  const player = showChange(item(), { kind: "workflow", itemId: "itm_a", from: "undecided", to: "inprogress", revision: 5, playback });
  assert.deepEqual([player.workflow, player.workflowRevision, player.playbackWorkflowSessionId, player.isNew], ["inprogress", 1, "play-1", false], "the player's change is seen too");
});

test("pending changes are shown on an item in the order they were made", () => {
  const entries: Entry[] = [
    { ...base, seq: 1, kind: "workflow", itemId: "itm_a", from: "undecided", to: "toread", revision: 5 },
    { ...base, seq: 2, kind: "workflow", itemId: "itm_a", from: "toread", to: "finished", revision: 5 },
    { ...base, seq: 3, kind: "keep", itemId: "itm_a", basketId: "bkt_2", on: true },
    { ...base, seq: 4, kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false },
    { ...base, seq: 5, kind: "workflow", itemId: "itm_other", from: "undecided", to: "ignored", revision: 1 },
    { ...base, seq: 6, kind: "clearNew", itemIds: ["itm_a", "itm_z"] },
  ];
  const a = item({ basketIds: ["bkt_1"] });
  const out = overlayItem(a, entries);
  assert.equal(out.workflow, "finished");
  assert.deepEqual(out.basketIds, ["bkt_2"]);
  assert.equal(out.isNew, false);
  assert.equal(out.workflowRevision, 2, "each pending workflow change moves the workflow revision, as PURSS will");
  assert.equal(out.playbackWorkflowSessionId, null, "a change by hand has no playback session");
  assert.equal(out.revision, 5, "the revision is PURSS's to move");
  assert.equal(overlayItem(a, []), a);
});

test("the player's pending changes are shown with their session, and a change by hand after them takes it away", () => {
  const playback = { sessionId: "play-1", expectedWorkflowRevision: 0, startedWorkflowRevision: 0 };
  const own: Entry = { ...base, seq: 1, kind: "workflow", itemId: "itm_a", from: "undecided", to: "inprogress", revision: 5, playback };
  const shown = overlayItem(item(), [own]);
  assert.deepEqual([shown.workflow, shown.workflowRevision, shown.playbackWorkflowSessionId], ["inprogress", 1, "play-1"]);
  const byHand = overlayItem(item(), [own, { ...base, seq: 2, kind: "workflow", itemId: "itm_a", from: "inprogress", to: "ignored", revision: 5 }]);
  assert.deepEqual([byHand.workflow, byHand.workflowRevision, byHand.playbackWorkflowSessionId], ["ignored", 2, null]);
});

// ---------- PURSS in a box ----------

type Fail = { status: number; code: string; message: string };
const offline: Fail = { status: 0, code: "offline", message: "Can't reach PURSS right now." };
const conflict: Fail = { status: 409, code: "conflict", message: "This item changed in another tab or device." };

type Row = { workflow: WorkflowState; revision: number; workflowRevision: number; session: string | null; baskets: Set<string>; isNew: boolean; stateVersion: number; progress: number; opened: boolean };

/**
 * What PURSS does with each change, as apps/api/src/services/new-marker.test.ts and state.ts have it: a workflow that differs, a basket
 * that is entered or left, and reading progress count as doing something with the item (the New marker goes, the state version moves);
 * the workflow it already has and a basket nothing changes in do not. Items are New when they start.
 */
class Purss {
  rows = new Map<string, Row>();
  log: string[] = [];
  down = false;
  /** Requests held back until the promise is answered: `workflow itm_a`, `state itm_a`. */
  holds = new Map<string, Promise<void>>();
  /** Failures to throw, in order, for the next request that starts with `when`. */
  failures: { when: string; error: Fail }[] = [];
  constructor(ids: string[]) { for (const id of ids) this.rows.set(id, { workflow: "undecided", revision: 5, workflowRevision: 0, session: null, baskets: new Set(), isNew: true, stateVersion: 4, progress: 0, opened: false }); }

  dto(id: string): ItemDTO {
    const r = this.rows.get(id)!;
    return item({ id, workflow: r.workflow, revision: r.revision, workflowRevision: r.workflowRevision, playbackWorkflowSessionId: r.session, stateVersion: r.stateVersion, isNew: r.isNew, progress: r.progress, opened: r.opened, basketIds: [...r.baskets] });
  }
  private async gate(call: string): Promise<void> {
    this.log.push(call);
    if (this.down) throw offline;
    const i = this.failures.findIndex((f) => call.startsWith(f.when));
    if (i >= 0) throw this.failures.splice(i, 1)[0]!.error;
    await this.holds.get(call.split(" ").slice(0, 2).join(" "));
  }
  private row(id: string): Row {
    const r = this.rows.get(id);
    if (!r) throw { status: 404, code: "not_found", message: "That item wasn't found." } satisfies Fail;
    return r;
  }
  private seen(r: Row): void { r.isNew = false; r.stateVersion += 1; }

  sender: Sender = {
    workflow: async (id, workflow, expectedRevision, playback) => {
      await this.gate(`workflow ${id} ${workflow} @${expectedRevision}`);
      const r = this.row(id);
      if (playback) {
        const chain = r.workflowRevision === playback.expectedWorkflowRevision && (r.workflowRevision === playback.startedWorkflowRevision || r.session === playback.sessionId);
        const forward = workflow === "inprogress" ? r.workflow === "undecided" || r.workflow === "toread" : r.workflow === "undecided" || r.workflow === "toread" || r.workflow === "inprogress";
        if (!chain || !forward) throw conflict;
      } else if (r.revision !== expectedRevision) throw conflict;
      if (r.workflow !== workflow) { r.workflow = workflow; r.workflowRevision += 1; r.session = playback?.sessionId ?? null; r.revision += 1; this.seen(r); }
      return { item: this.dto(id), undoToken: `und_workflow_${id}_${r.revision}` };
    },
    keep: async (id, basketId, on) => {
      await this.gate(`${on ? "keep" : "unkeep"} ${id} ${basketId}`);
      const r = this.row(id);
      if (on !== r.baskets.has(basketId)) { if (on) r.baskets.add(basketId); else r.baskets.delete(basketId); this.seen(r); }
      return { item: this.dto(id), undoToken: `und_keep_${id}`, captureNote: null };
    },
    clearNew: async (ids) => {
      await this.gate(`clearNew ${ids.join(",")}`);
      let changed = 0;
      for (const id of ids) { const r = this.rows.get(id); if (r?.isNew) { this.seen(r); changed++; } }
      return { changed, undoToken: changed ? "und_fresh" : null };
    },
    workflowOf: async (id) => {
      await this.gate(`get ${id}`);
      const r = this.row(id);
      return { workflow: r.workflow, revision: r.revision, workflowRevision: r.workflowRevision, playbackWorkflowSessionId: r.session };
    },
  };

  requests: StateRequests = {
    state: async (id, body): Promise<Written> => {
      await this.gate("progress" in body ? `state ${id} progress=${body.progress} @${body.expectedRevision}` : `state ${id} opened @${body.expectedRevision}`);
      const r = this.row(id);
      if (r.revision !== body.expectedRevision) throw conflict;
      if ("progress" in body) { r.progress = body.progress; r.revision += 1; this.seen(r); }
      else if (!r.opened) { r.opened = true; if (r.isNew) this.seen(r); else r.stateVersion += 1; }
      return { item: this.dto(id), undoToken: `und_state_${id}_${r.stateVersion}` };
    },
    undo: async (token) => { this.log.push(`undo ${token}`); },
    clearNew: async (scope) => { this.log.push(`clearNew scope ${scope}`); if (this.down) throw offline; return { changed: 2, undoToken: "und_scope" }; },
  };
}

test("the copy shown at once is the copy PURSS answers, change by change", async () => {
  const cases: { name: string; start?: (r: Row) => void; send: (p: Purss) => Promise<unknown>; change: Parameters<typeof showChange>[1] }[] = [
    { name: "workflow", send: (p) => p.sender.workflow("itm_a", "toread", 5), change: { kind: "workflow", itemId: "itm_a", from: "undecided", to: "toread", revision: 5 } },
    { name: "the workflow it has", start: (r) => { r.workflow = "toread"; }, send: (p) => p.sender.workflow("itm_a", "toread", 5), change: { kind: "workflow", itemId: "itm_a", from: "toread", to: "toread", revision: 5 } },
    { name: "keep", send: (p) => p.sender.keep("itm_a", "bkt_1", true), change: { kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: true } },
    { name: "keep where it is kept", start: (r) => { r.baskets.add("bkt_1"); }, send: (p) => p.sender.keep("itm_a", "bkt_1", true), change: { kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: true } },
    { name: "take out", start: (r) => { r.baskets.add("bkt_1"); }, send: (p) => p.sender.keep("itm_a", "bkt_1", false), change: { kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false } },
    { name: "take out where it is not kept", send: (p) => p.sender.keep("itm_a", "bkt_1", false), change: { kind: "keep", itemId: "itm_a", basketId: "bkt_1", on: false } },
    { name: "clear New", send: (p) => p.sender.clearNew(["itm_a"]), change: { kind: "clearNew", itemIds: ["itm_a"] } },
    { name: "clear New of an item that is not New", start: (r) => { r.isNew = false; }, send: (p) => p.sender.clearNew(["itm_a"]), change: { kind: "clearNew", itemIds: ["itm_a"] } },
    { name: "an Undo that is waiting", start: (r) => { r.workflow = "toread"; r.workflowRevision = 1; r.isNew = false; }, send: (p) => p.sender.workflow("itm_a", "undecided", 5), change: { kind: "undoWorkflow", itemId: "itm_a", applied: "toread", restore: "undecided" } },
  ];
  for (const c of cases) {
    const purss = new Purss(["itm_a"]);
    c.start?.(purss.rows.get("itm_a")!);
    const before = purss.dto("itm_a");
    const shown = showChange(before, c.change);
    await c.send(purss);
    const answered = purss.dto("itm_a");
    const state = (it: ItemDTO) => [it.workflow, it.workflowRevision, it.playbackWorkflowSessionId, it.isNew, [...it.basketIds].sort()];
    assert.deepEqual(state(shown), state(answered), c.name);
  }
});

type Said = { message: string; opts?: Parameters<Say>[1] };

/** The page, the outbox and PURSS in a box. */
function harness(ids: string[], opts: { baskets?: Record<string, string>; unsent?: Record<string, number> } = {}) {
  const purss = new Purss(ids);
  const items = new Map(ids.map((id) => [id, purss.dto(id)] as const));
  const log: string[] = [];
  const shown: ItemDTO[] = [];
  const cache: ItemCache = {
    find: (id) => items.get(id),
    put: (it) => { const cur = items.get(it.id); if (cur && isNewerCopy(cur, it)) return; items.set(it.id, { ...cur, ...it }); shown.push(it); },
    dropFromBasket: (basketId, id) => { log.push(`dropFromBasket ${basketId} ${id}`); },
    readAgain: (id) => { log.push(`readAgain ${id}`); },
    readItemAgain: (id) => { log.push(`readItemAgain ${id}`); },
    readListsAgain: () => { log.push("readListsAgain"); },
    listsStale: () => { log.push("listsStale"); },
    newCleared: () => { log.push("newCleared"); },
    readEverythingAgain: () => { log.push("readEverythingAgain"); },
  };
  let n = 0;
  const outbox = new Outbox({ store: new MemoryStore(), sender: purss.sender, installation: "https://purss.test", newId: () => `ent_${++n}`, online: () => !purss.down, schedule: () => () => undefined });
  outbox.setAccount("acc_1");
  const said: Said[] = [];
  const unsentRows: Record<string, number> = { ...opts.unsent };
  const unsent: LateStore<number> = { all: () => ({ ...unsentRows }), put: (id, v) => { unsentRows[id] = v; }, remove: (id, v) => { if (unsentRows[id] === v) delete unsentRows[id]; } };
  const seen = createSeenStore();
  let online = true;
  const writer = createItemWriter({
    cache, outbox, requests: purss.requests,
    say: (message, o) => { said.push({ message, opts: o }); },
    messageOf: (err) => (err as { message?: string } | null)?.message ?? "Something went wrong.",
    basketName: (id) => opts.baskets?.[id],
    unsentProgress: () => unsent,
    seen,
    online: () => online,
  });
  return { purss, items, log, shown, cache, outbox, said, unsentRows, seen, writer, setOnline: (v: boolean) => { online = v; }, last: () => said.at(-1)! };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const later = () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release }; };

// ---------- workflow ----------

test("a workflow change is shown at once, replaced by PURSS's answer, and said with PURSS's Undo", async () => {
  const h = harness(["itm_a"]);
  const hold = later();
  h.purss.holds.set("workflow itm_a", hold.gate);
  const done = h.writer.setWorkflow(["itm_a"], "toread");
  try {
    await tick();
    assert.deepEqual([h.items.get("itm_a")!.workflow, h.items.get("itm_a")!.isNew], ["toread", false], "shown before PURSS has answered");
    assert.equal(h.said.length, 0);
  } finally { hold.release(); }
  await done;
  assert.deepEqual(h.purss.log, ["workflow itm_a toread @5"]);
  assert.equal(h.items.get("itm_a")!.revision, 6, "PURSS's own copy");
  assert.deepEqual(h.last(), { message: t.marked(workflowLabel("toread")), opts: { undoToken: "und_workflow_itm_a_6" } });
  assert.deepEqual(h.log, ["newCleared", "listsStale"], "the counts follow the New marker going, and the lists are read again");
  assert.equal(h.outbox.pendingCount(), 0);
});

test("choosing the workflow an item already has says so and sends nothing", async () => {
  const h = harness(["itm_a"]);
  await h.writer.setWorkflow(["itm_a"], "undecided");
  assert.deepEqual(h.said, [{ message: t.already(workflowLabel("undecided")), opts: undefined }]);
  assert.deepEqual(h.purss.log, []);
  assert.equal(h.items.get("itm_a")!.isNew, true, "nothing was done with it");
});

test("the to-read label follows the kind of item", async () => {
  const h = harness(["itm_a"]);
  h.items.set("itm_a", { ...h.items.get("itm_a")!, kind: "video" });
  await h.writer.setWorkflow(["itm_a"], "toread");
  assert.equal(h.last().message, t.marked(app.words.toWatch));
});

test("Ignored remembers what the item was, and Restore puts it back", async () => {
  const h = harness(["itm_ignored", "itm_never"]);
  await h.writer.setWorkflow(["itm_ignored"], "inprogress");
  await h.writer.setWorkflow(["itm_ignored"], "ignored");
  assert.equal(h.last().message, app.words.ignored);
  await h.writer.restore("itm_ignored");
  assert.equal(h.items.get("itm_ignored")!.workflow, "inprogress");
  assert.equal(h.last().message, t.restoredTo(workflowLabel("inprogress")));
  await h.writer.setWorkflow(["itm_never"], "ignored");
  h.items.set("itm_never", { ...h.items.get("itm_never")!, workflow: "ignored" });
  await h.writer.restore("itm_never");
  assert.equal(h.items.get("itm_never")!.workflow, "undecided", "an item ignored from Undecided is restored to it");
});

test("a hand-set choice ends the player's automatic changes for the item", async () => {
  const noted: string[] = [];
  const stop = onManualWorkflowChange((id) => noted.push(id));
  const h = harness(["itm_a", "itm_b", "itm_c"]);
  await h.writer.setWorkflow(["itm_a"], "toread");
  await h.writer.setWorkflow(["itm_b", "itm_c"], "finished");
  await h.writer.restore("itm_c");
  stop();
  assert.deepEqual(noted, ["itm_a", "itm_b", "itm_c", "itm_c"]);
});

test("a change kept for later says so, stays shown, and Undo takes it back before it leaves", async () => {
  const h = harness(["itm_a"]);
  h.purss.down = true;
  await h.writer.setWorkflow(["itm_a"], "toread");
  const said = h.last();
  assert.equal(said.message, t.withNote(t.marked(workflowLabel("toread")), t.notSent));
  assert.equal(said.opts?.undoToken, undefined);
  assert.deepEqual([h.items.get("itm_a")!.workflow, h.items.get("itm_a")!.isNew], ["toread", false], "it stays shown");
  assert.equal(h.outbox.pendingCount(), 1);
  await said.opts!.undo!();
  assert.deepEqual([h.items.get("itm_a")!.workflow, h.items.get("itm_a")!.isNew], ["undecided", true], "the item as it was");
  assert.equal(h.outbox.pendingCount(), 0);
  assert.equal(h.log.at(-1), "listsStale");
});

test("Undo of a change that may have reached PURSS sends the opposite change on the revision it now has", async () => {
  const h = harness(["itm_a"]);
  // The request got through and its answer was lost.
  const send = h.purss.sender.workflow;
  let lost = true;
  h.purss.sender.workflow = async (...args) => { const out = await send(...args); if (lost) { lost = false; throw offline; } return out; };
  await h.writer.setWorkflow(["itm_a"], "toread");
  const said = h.last();
  assert.equal(said.message, t.withNote(t.marked(workflowLabel("toread")), t.notSent));
  await said.opts!.undo!();
  assert.deepEqual(h.purss.log.filter((l) => l.startsWith("workflow")), ["workflow itm_a toread @5", "workflow itm_a undecided @6"]);
  assert.equal(h.purss.rows.get("itm_a")!.workflow, "undecided");
  assert.equal(h.last().message, t.marked(workflowLabel("undecided")));
});

test("a change PURSS refuses is shown as it was, with the item read again and the reason said", async () => {
  const h = harness(["itm_a"]);
  h.purss.failures.push({ when: "workflow itm_a", error: conflict });
  h.purss.rows.get("itm_a")!.workflow = "finished"; // changed elsewhere
  await h.writer.setWorkflow(["itm_a"], "toread");
  assert.deepEqual([h.items.get("itm_a")!.workflow, h.items.get("itm_a")!.isNew], ["undecided", true]);
  assert.deepEqual(h.log, ["readAgain itm_a"]);
  assert.deepEqual(h.last(), { message: app.outbox.entries.conflict, opts: { tone: "error" } });
});

test("a change that cannot be kept at all is shown as it was and the error said", async () => {
  const h = harness(["itm_a"]);
  h.outbox.setAccount(null);
  await h.writer.setWorkflow(["itm_a"], "toread");
  assert.equal(h.items.get("itm_a")!.workflow, "undecided");
  assert.deepEqual(h.last(), { message: "Not signed in", opts: { tone: "error" } });
  assert.deepEqual(h.log, [], "a failure that is no conflict reads nothing again");
});

test("several items get one message, one Undo that reaches every confirmed change, and refused ones are shown as they were", async () => {
  const h = harness(["itm_a", "itm_b", "itm_c"]);
  h.purss.failures.push({ when: "workflow itm_c", error: { status: 404, code: "not_found", message: "That item wasn't found." } });
  await h.writer.setWorkflow(["itm_a", "itm_b", "itm_c"], "finished");
  assert.deepEqual(["itm_a", "itm_b", "itm_c"].map((id) => h.items.get(id)!.workflow), ["finished", "finished", "undecided"]);
  const said = h.last();
  assert.equal(said.message, `${t.markedFor(t.marked(workflowLabel("finished")), plural(2, app.words.item))} ${notChangedMessage("rejected", "That item wasn't found.")}`);
  await said.opts!.undo!();
  assert.deepEqual(h.purss.log.filter((l) => l.startsWith("undo")), ["undo und_workflow_itm_b_6", "undo und_workflow_itm_a_6"], "newest first");
  assert.equal(h.log.at(-1), "readEverythingAgain");
});

test("several items with nothing to change say so", async () => {
  const h = harness(["itm_a", "itm_b"]);
  await h.writer.setWorkflow(["itm_a", "itm_b"], "undecided");
  assert.deepEqual(h.said, [{ message: t.already(workflowLabel("undecided")), opts: undefined }]);
});

test("several changes kept for later are taken back together by Undo", async () => {
  const h = harness(["itm_a", "itm_b"]);
  h.purss.down = true;
  await h.writer.setWorkflow(["itm_a", "itm_b"], "ignored");
  const said = h.last();
  assert.equal(said.message, t.withNote(t.markedFor(app.words.ignored, plural(2, app.words.item)), t.notSent));
  assert.equal(h.outbox.pendingCount(), 2);
  await said.opts!.undo!();
  assert.deepEqual(["itm_a", "itm_b"].map((id) => [h.items.get(id)!.workflow, h.items.get(id)!.isNew]), [["undecided", true], ["undecided", true]]);
  assert.equal(h.outbox.pendingCount(), 0);
});

// ---------- the player ----------

const playback = (over: Partial<PlaybackWorkflow> = {}): PlaybackWorkflow => ({ sessionId: "play-1", expectedWorkflowRevision: 0, startedWorkflowRevision: 0, ...over });

test("the player's change is shown, sent, and said nothing about", async () => {
  const h = harness(["itm_a"]);
  const out = await h.writer.setPlaybackWorkflow("itm_a", "undecided", "inprogress", playback());
  assert.deepEqual(out, { applied: true, workflowRevision: 1 });
  assert.deepEqual([h.items.get("itm_a")!.workflow, h.items.get("itm_a")!.playbackWorkflowSessionId, h.items.get("itm_a")!.isNew], ["inprogress", "play-1", false]);
  assert.deepEqual(h.said, []);
  assert.deepEqual(h.log, ["newCleared", "listsStale"]);
});

test("the player makes no change to an item that is not as it expects", async () => {
  const h = harness(["itm_a"]);
  assert.deepEqual(await h.writer.setPlaybackWorkflow("itm_a", "toread", "inprogress", playback()), { applied: false, workflowRevision: 0 }, "not in the state it started from");
  assert.deepEqual(await h.writer.setPlaybackWorkflow("itm_a", "undecided", "inprogress", playback({ expectedWorkflowRevision: 3 })), { applied: false, workflowRevision: 3 }, "set by hand since");
  assert.deepEqual(await h.writer.setPlaybackWorkflow("itm_x", "undecided", "inprogress", playback()), { applied: false, workflowRevision: 0 }, "an item that is not loaded");
  assert.deepEqual(h.purss.log, []);
});

test("a player change kept for later counts as made; one PURSS refuses is shown as it was", async () => {
  const h = harness(["itm_a", "itm_b"]);
  h.purss.down = true;
  assert.deepEqual(await h.writer.setPlaybackWorkflow("itm_a", "undecided", "finished", playback()), { applied: true, workflowRevision: 1 });
  assert.equal(h.items.get("itm_a")!.workflow, "finished", "it stays shown while it waits");
  h.purss.down = false;
  h.purss.rows.get("itm_b")!.workflowRevision = 2; // set by hand on another device
  assert.deepEqual(await h.writer.setPlaybackWorkflow("itm_b", "undecided", "inprogress", playback()), { applied: false, workflowRevision: 0 });
  assert.equal(h.items.get("itm_b")!.workflow, "undecided");
  assert.deepEqual(h.said, [], "never a message");
});

// ---------- keeping ----------

const baskets = { bkt_1: "Reading", bkt_2: "Later" };

test("keeping is shown at once, and says where, with PURSS's Undo", async () => {
  const h = harness(["itm_a"], { baskets });
  await h.writer.keep("itm_a", "bkt_1", true);
  assert.deepEqual([h.items.get("itm_a")!.basketIds, h.items.get("itm_a")!.isNew], [["bkt_1"], false]);
  assert.deepEqual(h.last(), { message: t.keep(true, isolate("Reading")), opts: { undoToken: "und_keep_itm_a" } });
  assert.deepEqual(h.log, ["newCleared", "readItemAgain itm_a", "listsStale"]);
});

test("taking an item out of a basket takes it off that basket's page at once", async () => {
  const h = harness(["itm_a"], { baskets });
  await h.writer.keep("itm_a", "bkt_1", true);
  h.log.length = 0;
  await h.writer.keep("itm_a", "bkt_1", false);
  assert.deepEqual(h.items.get("itm_a")!.basketIds, []);
  assert.equal(h.log[0], "dropFromBasket bkt_1 itm_a");
  assert.equal(h.last().message, t.keep(false, isolate("Reading")));
});

test("keeping adds what could not be saved to the message", async () => {
  const h = harness(["itm_a"], { baskets });
  h.purss.sender.keep = async (id) => ({ item: h.purss.dto(id), undoToken: "und_k", captureNote: "The text was left out." });
  await h.writer.keep("itm_a", "bkt_1", true);
  assert.equal(h.last().message, t.withNote(t.keep(true, isolate("Reading")), "The text was left out."));
});

test("keeping in a basket the page does not know does nothing", async () => {
  const h = harness(["itm_a"], { baskets });
  await h.writer.keep("itm_a", "bkt_9", true);
  await h.writer.keep("itm_x", "bkt_1", true);
  assert.deepEqual([h.said, h.purss.log, h.shown], [[], [], []]);
});

test("a keep kept for later is undone by taking it back, and a removal returns to the basket's page", async () => {
  const h = harness(["itm_a"], { baskets });
  h.purss.rows.get("itm_a")!.baskets.add("bkt_1");
  h.items.set("itm_a", h.purss.dto("itm_a"));
  h.purss.down = true;
  await h.writer.keep("itm_a", "bkt_1", false);
  const said = h.last();
  assert.equal(said.message, t.withNote(t.keep(false, isolate("Reading")), t.notSent));
  assert.deepEqual(h.items.get("itm_a")!.basketIds, []);
  await said.opts!.undo!();
  assert.deepEqual([h.items.get("itm_a")!.basketIds, h.items.get("itm_a")!.isNew], [["bkt_1"], true]);
  assert.deepEqual(h.log.filter((l) => l.startsWith("read")), ["readListsAgain"], "the basket's page is read again to bring it back");
});

test("a keep PURSS refuses is shown as it was", async () => {
  const h = harness(["itm_a"], { baskets });
  h.purss.failures.push({ when: "keep itm_a", error: { status: 507, code: "allowance_full", message: "Your storage is full." } });
  await h.writer.keep("itm_a", "bkt_1", true);
  assert.deepEqual([h.items.get("itm_a")!.basketIds, h.items.get("itm_a")!.isNew], [[], true]);
  assert.deepEqual(h.last(), { message: notChangedMessage("rejected", "Your storage is full."), opts: { tone: "error" } });
  assert.deepEqual(h.log, ["readAgain itm_a"]);
});

test("keeping several items in several baskets gives one message, and Undo takes each out again", async () => {
  const h = harness(["itm_a", "itm_b"], { baskets });
  h.purss.rows.get("itm_b")!.baskets.add("bkt_1");
  h.items.set("itm_b", h.purss.dto("itm_b"));
  await h.writer.keepMany(["itm_a", "itm_b"], ["bkt_1", "bkt_2"]);
  assert.deepEqual(["itm_a", "itm_b"].map((id) => [...h.items.get(id)!.basketIds].sort()), [["bkt_1", "bkt_2"], ["bkt_1", "bkt_2"]]);
  assert.equal(h.last().message, t.keptIn(plural(2, app.words.item), plural(2, app.words.basketLower)));
  assert.equal(h.purss.log.filter((l) => l.startsWith("keep")).length, 3, "the pair already kept is not sent");
  await h.last().opts!.undo!();
  assert.equal(h.purss.log.filter((l) => l.startsWith("undo")).length, 3);
});

test("keeping what is already kept there says so", async () => {
  const h = harness(["itm_a"], { baskets });
  h.purss.rows.get("itm_a")!.baskets.add("bkt_1");
  h.items.set("itm_a", h.purss.dto("itm_a"));
  await h.writer.keepMany(["itm_a"], ["bkt_1"]);
  assert.deepEqual(h.said, [{ message: t.alreadyKept, opts: undefined }]);
});

test("keeping in one basket names it, and a keep kept for later is taken back with the copies as they were", async () => {
  const h = harness(["itm_a", "itm_b"], { baskets });
  h.purss.down = true;
  await h.writer.keepMany(["itm_a", "itm_b"], ["bkt_2"]);
  const said = h.last();
  assert.equal(said.message, t.withNote(t.keptIn(plural(2, app.words.item), isolate("Later")), t.notSent));
  assert.deepEqual(["itm_a", "itm_b"].map((id) => h.items.get(id)!.basketIds), [["bkt_2"], ["bkt_2"]]);
  await said.opts!.undo!();
  assert.deepEqual(["itm_a", "itm_b"].map((id) => [h.items.get(id)!.basketIds, h.items.get(id)!.isNew]), [[[], true], [[], true]]);
});

// ---------- New markers ----------

test("marking items as seen shows it at once and says how many it was", async () => {
  const h = harness(["itm_a", "itm_b"]);
  h.purss.rows.get("itm_b")!.isNew = false;
  h.items.set("itm_b", h.purss.dto("itm_b"));
  await h.writer.clearNewFor(["itm_a", "itm_b"]);
  assert.equal(h.items.get("itm_a")!.isNew, false);
  assert.deepEqual(h.last(), { message: t.markedSeen(plural(1, app.words.item)), opts: { undoToken: "und_fresh" } });
  assert.deepEqual(h.log, ["readEverythingAgain"]);
});

test("marking items that were not New says that, and a change kept for later is told plainly", async () => {
  const h = harness(["itm_a"]);
  h.purss.rows.get("itm_a")!.isNew = false;
  h.items.set("itm_a", h.purss.dto("itm_a"));
  await h.writer.clearNewFor(["itm_a"]);
  assert.equal(h.last().message, t.notMarkedNew(true));
  const g = harness(["itm_a"]);
  g.purss.down = true;
  await g.writer.clearNewFor(["itm_a"]);
  assert.deepEqual(g.last(), { message: t.markedSeenLater, opts: undefined });
  assert.equal(g.items.get("itm_a")!.isNew, false, "it stays shown");
});

test("a refused or failed mark as seen shows the markers again", async () => {
  const h = harness(["itm_a"]);
  h.purss.failures.push({ when: "clearNew", error: { status: 403, code: "forbidden", message: "Not allowed." } });
  await h.writer.clearNewFor(["itm_a"]);
  assert.equal(h.items.get("itm_a")!.isNew, true);
  assert.deepEqual(h.last(), { message: notChangedMessage("rejected", "Not allowed."), opts: { tone: "error" } });
  const g = harness(["itm_a"]);
  g.outbox.setAccount(null);
  await g.writer.clearNewFor(["itm_a"]);
  assert.equal(g.items.get("itm_a")!.isNew, true);
  assert.deepEqual(g.last(), { message: "Not signed in", opts: { tone: "error" } });
});

test("Mark all as seen needs a connection and says so instead of failing without a word", async () => {
  const h = harness(["itm_a"]);
  h.setOnline(false);
  await h.writer.clearNew("all");
  assert.deepEqual(h.said, [{ message: t.needsConnection, opts: { tone: "error" } }]);
  assert.deepEqual(h.purss.log, []);
  h.setOnline(true);
  h.purss.down = true;
  await h.writer.clearNew("all");
  assert.equal(h.said.length, 2, "a request that gets no answer says the same");
  assert.equal(h.last().message, t.needsConnection);
});

test("Mark all as seen reads everything again and says how many it was", async () => {
  const h = harness(["itm_a"]);
  await h.writer.clearNew("all");
  assert.deepEqual(h.purss.log, ["clearNew scope all"]);
  assert.deepEqual(h.last(), { message: t.markedSeen(plural(2, app.words.item)), opts: { undoToken: "und_scope" } });
  assert.deepEqual(h.log, ["readEverythingAgain"]);
});

// ---------- opening and reading progress ----------

test("opening writes on the revision the page has, and leaves the panel's line for Undo", async () => {
  const h = harness(["itm_a"]);
  await h.writer.markOpened("itm_a");
  assert.deepEqual(h.purss.log, ["state itm_a opened @5"]);
  assert.deepEqual([h.items.get("itm_a")!.opened, h.items.get("itm_a")!.isNew], [true, false]);
  assert.deepEqual(h.seen.get(), { itemId: "itm_a", undoToken: "und_state_itm_a_5" });
  assert.deepEqual(h.log, ["newCleared"]);
});

test("Undo of Marked as seen shows the marker again and presses PURSS's Undo", async () => {
  const h = harness(["itm_a"]);
  await h.writer.markOpened("itm_a");
  const notice = h.seen.get()!;
  await h.writer.undoSeenMarker(notice);
  assert.equal(h.items.get("itm_a")!.isNew, true);
  assert.equal(h.purss.log.at(-1), `undo ${notice.undoToken}`);
  assert.equal(h.seen.get(), null);
  assert.equal(h.log.at(-1), "readEverythingAgain");
});

test("reading progress is shown at once, only grows, and is written on the revision the page has", async () => {
  const h = harness(["itm_a"]);
  const hold = later();
  h.purss.holds.set("state itm_a", hold.gate);
  const done = h.writer.saveProgress("itm_a", 0.456);
  try {
    await tick();
    assert.deepEqual([h.items.get("itm_a")!.progress, h.items.get("itm_a")!.isNew], [0.46, false], "rounded, and the New marker goes");
  } finally { hold.release(); }
  await done;
  assert.deepEqual(h.purss.log, ["state itm_a progress=0.46 @5"]);
  assert.equal(h.items.get("itm_a")!.revision, 6);
  await h.writer.saveProgress("itm_a", 0.3);
  await h.writer.saveProgress("itm_x", 0.5);
  assert.equal(h.purss.log.length, 1, "less than it has, and an item that is not loaded, send nothing");
  assert.deepEqual(h.said, [], "silent");
});

test("a progress write the page makes moves the waiting workflow changes to the revision it produced", async () => {
  const h = harness(["itm_a"]);
  h.purss.down = true;
  await h.writer.setWorkflow(["itm_a"], "toread");
  h.purss.down = false;
  const waitingRevision = () => { const e = h.outbox.entries()[0]; return e?.kind === "workflow" ? e.revision : undefined; };
  assert.equal(waitingRevision(), 5);
  await h.writer.saveProgress("itm_a", 0.5);
  assert.equal(waitingRevision(), 6, "it would be refused for the write the page made itself");
});

test("progress that could not be sent is kept on this device until it is, and a smaller one never replaces a larger", async () => {
  const h = harness(["itm_a", "itm_b"], { unsent: { itm_b: 0.9 } });
  h.purss.down = true;
  await h.writer.saveProgress("itm_a", 0.5);
  assert.deepEqual(h.unsentRows, { itm_a: 0.5, itm_b: 0.9 });
  await h.writer.saveProgress("itm_b", 0.5);
  assert.deepEqual(h.unsentRows, { itm_a: 0.5, itm_b: 0.9 }, "the device has 0.9 waiting: the larger stays");
  h.purss.down = false;
  await h.writer.saveProgress("itm_b", 0.6);
  assert.deepEqual(h.unsentRows, { itm_a: 0.5, itm_b: 0.9 }, "PURSS knows 0.6 and the device 0.9: the larger stays");
  await h.writer.saveProgress("itm_b", 0.95);
  assert.deepEqual(h.unsentRows, { itm_a: 0.5 }, "what PURSS has caught up with is not needed any more");
});

test("progress PURSS refuses as a conflict reads the item again, and any other refusal keeps nothing", async () => {
  const h = harness(["itm_a", "itm_b"]);
  h.purss.failures.push({ when: "state itm_a", error: conflict }, { when: "state itm_b", error: { status: 404, code: "not_found", message: "Gone." } });
  await h.writer.saveProgress("itm_a", 0.5);
  await h.writer.saveProgress("itm_b", 0.5);
  assert.deepEqual(h.log, ["readItemAgain itm_a"]);
  assert.deepEqual(h.unsentRows, {});
  assert.deepEqual(h.said, []);
});

test("without anyone signed in progress is shown and sent but nothing is kept for later", async () => {
  const h = harness(["itm_a"]);
  const bare = createItemWriter({ cache: h.cache, outbox: h.outbox, requests: h.purss.requests, say: () => undefined, messageOf: () => "", basketName: () => undefined, unsentProgress: () => null, seen: h.seen });
  h.purss.down = true;
  await bare.saveProgress("itm_a", 0.5);
  assert.equal(h.items.get("itm_a")!.progress, 0.5);
  assert.deepEqual(h.unsentRows, {});
});

test("the page's writes to one item go one after another, each on the revision it has when its turn comes", async () => {
  const h = harness(["itm_a", "itm_b"]);
  const hold = later();
  h.purss.holds.set("state itm_a", hold.gate);
  const deps = { outbox: h.outbox, requests: h.purss.requests };
  const revision = () => h.purss.rows.get("itm_a")!.revision;
  const first = writeState(deps, "itm_a", { progress: 0.1 }, revision);
  const second = writeState(deps, "itm_a", { progress: 0.2 }, revision);
  const other = writeState(deps, "itm_b", { progress: 0.3 }, () => 5);
  try {
    await tick();
    assert.deepEqual(h.purss.log, ["state itm_a progress=0.1 @5", "state itm_b progress=0.3 @5"], "the second waits for the first; another item does not");
  } finally { hold.release(); }
  await Promise.all([first, second, other]);
  assert.deepEqual(h.purss.log.slice(2), ["state itm_a progress=0.2 @6"]);
});
