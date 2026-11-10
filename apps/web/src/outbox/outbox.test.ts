import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { Outbox } from "./outbox.ts";
import type { Deps, Outcome, Sender } from "./outbox.ts";
import { scopeOf } from "./entries.ts";
import type { Entry } from "./entries.ts";
import { signOutGate } from "./sign-out.ts";
import { MemoryStore } from "./store.ts";

type Fail = { status: number; code: string; message: string };
const offline: Fail = { status: 0, code: "offline", message: "Can't reach PURSS right now." };
const conflict: Fail = { status: 409, code: "conflict", message: "This item changed in another tab or device." };

function dto(id: string, workflow: WorkflowState, revision: number, basketIds: string[] = []): ItemDTO {
  return {
    id, sourceId: "src_a", sourceTitle: "S", kind: "article", title: id, url: null, author: null, excerpt: null, imageUrl: null, durationSeconds: null, readMinutes: null,
    doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow, revision, stateVersion: 4, fresh: false, progress: 0, opened: false, basketIds, curatorNote: null, media: null, annotatedAt: null,
  };
}

/** A PURSS in a box: items with a workflow and a revision, a log of requests, and failures to inject. */
class Fake {
  items = new Map<string, { workflow: WorkflowState; revision: number; baskets: Set<string>; fresh: boolean }>();
  /** Requests to hold back: `keep <item>` waits for the promise before it is answered (it has been received, and counts in the log). */
  holds = new Map<string, Promise<void>>();
  log: string[] = [];
  /** Failures to throw, in order, for the next requests that match `when`. */
  failures: { when: (call: string) => boolean; error: Fail; applied?: boolean }[] = [];
  down = false;
  /** Runs when an item is read, before the request is answered: a test holds the read open here, or makes it fail. */
  beforeRead?: (id: string) => Promise<void>;
  constructor(items: Record<string, WorkflowState> = {}) { for (const [id, w] of Object.entries(items)) this.items.set(id, { workflow: w, revision: 5, baskets: new Set(), fresh: true }); }
  private gate(call: string): void {
    this.log.push(call);
    if (this.down) throw offline;
    const i = this.failures.findIndex((f) => f.when(call));
    if (i < 0) return;
    const [f] = this.failures.splice(i, 1);
    if (f!.applied) this.applyHidden = true;
    throw f!.error;
  }
  applyHidden = false;
  sender: Sender = {
    workflow: async (id, workflow, expectedRevision) => {
      const hidden = () => { const it = this.items.get(id)!; it.workflow = workflow; it.revision += 1; };
      try { this.gate(`workflow ${id} ${workflow} @${expectedRevision}`); } catch (err) { if (this.applyHidden) { this.applyHidden = false; hidden(); } throw err; }
      const it = this.items.get(id);
      if (!it) throw { status: 404, code: "not_found", message: "That item wasn't found." } satisfies Fail;
      if (it.revision !== expectedRevision) throw conflict;
      hidden();
      return { item: dto(id, it.workflow, it.revision, [...it.baskets]), undoToken: `und_${id}_${it.revision}` };
    },
    keep: async (id, basketId, on) => {
      this.gate(`${on ? "keep" : "unkeep"} ${id} ${basketId}`);
      await this.holds.get(`keep ${id}`);
      const it = this.items.get(id);
      if (!it) throw { status: 404, code: "not_found", message: "That item wasn't found." } satisfies Fail;
      if (on) it.baskets.add(basketId); else it.baskets.delete(basketId);
      return { item: dto(id, it.workflow, it.revision, [...it.baskets]), undoToken: `und_keep_${id}`, captureNote: null };
    },
    clearFresh: async (ids) => {
      // Like PURSS: only items that are New change, and the New marker is separate from the revision, which stays put.
      const apply = () => { let changed = 0; for (const id of ids) { const it = this.items.get(id); if (it?.fresh) { it.fresh = false; changed++; } } return changed; };
      try { this.gate(`clearFresh ${ids.join(",")}`); } catch (err) { if (this.applyHidden) { this.applyHidden = false; apply(); } throw err; }
      return { changed: apply(), undoToken: "und_fresh" };
    },
    workflowOf: async (id) => {
      await this.beforeRead?.(id);
      this.gate(`get ${id}`);
      const it = this.items.get(id);
      if (!it) throw { status: 404, code: "not_found", message: "That item wasn't found." } satisfies Fail;
      return { workflow: it.workflow, revision: it.revision };
    },
  };
}

function make(fake: Fake, store = new MemoryStore(), account: string | null = "acc_1", installation = "https://purss.test", extra: Partial<Deps> = {}) {
  let t = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  let n = 0;
  const outbox = new Outbox({
    store, sender: fake.sender, installation, now: () => t, newId: () => `ent_${++n}_${installation.length}_${Math.random().toString(36).slice(2, 6)}`, ...extra,
    schedule: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }; },
  });
  const seen: Outcome[] = [];
  outbox.onOutcome((o) => seen.push(o));
  if (account) outbox.setAccount(account);
  return { outbox, store, seen, timers, advance: (ms: number) => { t += ms; }, now: () => t };
}

const workflow = (itemId: string, from: WorkflowState, to: WorkflowState, revision = 5) => ({ kind: "workflow", itemId, from, to, revision }) as const;

test("a change that reaches PURSS is confirmed and leaves nothing behind", async () => {
  const fake = new Fake({ a: "new" });
  const { outbox, store } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(out.status, "sent");
  assert.equal(out.status === "sent" && out.result.kind === "workflow" ? out.result.undoToken : null, "und_a_6");
  assert.deepEqual(fake.log, ["workflow a toread @5"]);
  assert.equal(outbox.pendingCount(), 0);
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
});

test("a change is on disk before it is sent, and stays while PURSS is out of reach", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox, store } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(out.status, "deferred");
  assert.deepEqual([...outbox.pendingItemIds()], ["a"]);
  assert.equal((await store.load(scopeOf("https://purss.test", "acc_1"))).length, 1);
  assert.equal(fake.items.get("a")!.workflow, "new");
});

test("a lost connection stops the pass: nothing is sent out of order and nothing is dropped", async () => {
  const fake = new Fake({ a: "new", b: "new", c: "new" });
  fake.down = true;
  const { outbox } = make(fake);
  await outbox.submit(workflow("a", "new", "toread"));
  await outbox.submit(workflow("b", "new", "finished"));
  await outbox.submit(workflow("c", "new", "ignored"));
  await outbox.drain();
  assert.equal(outbox.pendingCount(), 3);
  assert.equal(fake.log.filter((l) => l.startsWith("workflow a")).length >= 1, true);
  assert.equal(fake.log.some((l) => l.startsWith("workflow b") || l.startsWith("workflow c")), false, "later changes wait behind the one that could not be sent");
});

test("when the connection is back the kept changes are sent in the order they were made", async () => {
  const fake = new Fake({ a: "new", b: "new" });
  fake.down = true;
  const { outbox, seen } = make(fake);
  await outbox.submit(workflow("a", "new", "toread"));
  await outbox.submit(workflow("b", "new", "finished"));
  await outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: true });
  await outbox.settled();
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["workflow a toread @5", "workflow b finished @5", "keep a bkt_1"]);
  assert.equal(outbox.pendingCount(), 0);
  assert.deepEqual(seen.map((o) => (o.status === "sent" ? o.late : null)), [true, true, true], "the person was already told these were kept for later");
});

test("changes kept on disk are found and sent after a reload, by a new outbox", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const store = new MemoryStore();
  const first = make(fake, store);
  await first.outbox.submit(workflow("a", "new", "finished"));
  await first.outbox.settled();
  // The tab is closed here. A new page opens later with the same on-disk store.
  fake.down = false; fake.log.length = 0;
  const second = make(fake, store);
  await second.outbox.ready;
  assert.deepEqual([...second.outbox.pendingItemIds()], ["a"], "the pending mark comes back with the page");
  await second.outbox.drain();
  assert.deepEqual(fake.log, ["workflow a finished @5"]);
  assert.equal(fake.items.get("a")!.workflow, "finished");
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
  assert.equal(second.seen.length, 1);
  assert.equal(second.seen[0]!.status === "sent" && second.seen[0]!.late, true);
});

test("a request lost mid-flight is sent again without being counted as a conflict", async () => {
  // PURSS applied the change but the answer never arrived (tab closed, signal lost).
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: offline, applied: true });
  const store = new MemoryStore();
  const first = make(fake, store);
  assert.equal((await first.outbox.submit(workflow("a", "new", "toread"))).status, "deferred");
  assert.equal(fake.items.get("a")!.workflow, "toread", "PURSS has it");
  await first.outbox.settled();
  fake.log.length = 0;
  const second = make(fake, store);
  await second.outbox.drain();
  assert.deepEqual(fake.log, ["workflow a toread @5", "get a"], "stale revision, so the item is looked at");
  assert.equal(second.seen.length, 1);
  const o = second.seen[0]!;
  assert.equal(o.status, "sent");
  assert.equal(o.status === "sent" && o.result.kind === "workflow" ? o.result.item : "x", null, "already had it: nothing more to say");
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
});

test("an item that went new, finished, new elsewhere is not 'unchanged': the stale change is dropped with a message", async () => {
  const fake = new Fake({ a: "new" });
  fake.items.get("a")!.revision = 9; // elsewhere: new -> finished -> new
  const { outbox } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread", 5));
  assert.equal(out.status, "dropped");
  assert.equal(out.status === "dropped" ? out.message : "", "Not changed: this item was changed on another device.");
  assert.deepEqual(fake.log, ["workflow a toread @5", "get a"], "resent once with its own revision, then the item was read; no second try");
  assert.equal(fake.items.get("a")!.workflow, "new");
});

test("the page's own writes to an item (opening it, progress) carry the waiting change along to the new revision", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox } = make(fake);
  await outbox.submit(workflow("a", "new", "toread", 5));
  await outbox.settled();
  fake.items.get("a")!.revision = 6; // the page opened the item meanwhile
  outbox.noteOwnWrite("a", 5, 6);
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["workflow a toread @6"], "no refusal, no look at the item");
  assert.equal(fake.items.get("a")!.workflow, "toread");
});

test("a lost answer followed by a second change to the item: the first counts as done, the second goes through", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a toread"), error: offline, applied: true });
  const { outbox, seen } = make(fake);
  assert.equal((await outbox.submit(workflow("a", "new", "toread"))).status, "deferred");
  await outbox.settled();
  fake.down = true; // still no signal when the second change is made
  assert.equal((await outbox.submit(workflow("a", "toread", "inprogress"))).status, "deferred");
  await outbox.settled();
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["workflow a toread @5", "get a", "workflow a inprogress @6"]);
  assert.equal(fake.items.get("a")!.workflow, "inprogress");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "sent"]);
  assert.equal(outbox.pendingCount(), 0);
});

test("a workflow change is dropped, with a plain message, if the workflow changed elsewhere", async () => {
  const fake = new Fake({ a: "finished" }); // another device finished it
  fake.items.get("a")!.revision = 9;
  const { outbox, store } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread", 5));
  assert.equal(out.status, "dropped");
  assert.equal(out.status === "dropped" ? out.message : "", "Not changed: this item was changed on another device.");
  assert.equal(out.status === "dropped" ? out.reason : "", "conflict");
  assert.equal(fake.items.get("a")!.workflow, "finished", "the other device's choice stands");
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
  assert.equal(outbox.pendingCount(), 0);
});

test("a change that depended on a dropped one is dropped too", async () => {
  const fake = new Fake({ a: "finished" });
  fake.items.get("a")!.revision = 9;
  fake.down = true;
  const { outbox, seen } = make(fake);
  await outbox.submit(workflow("a", "new", "toread"));
  await outbox.submit(workflow("a", "toread", "inprogress"));
  await outbox.settled();
  fake.down = false;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(seen.map((o) => o.status), ["dropped", "dropped"]);
  assert.equal(fake.items.get("a")!.workflow, "finished");
});

test("two quick changes to one item are sent in order, each with the revision the last one produced", async () => {
  const fake = new Fake({ a: "new" });
  const { outbox } = make(fake);
  const [one, two] = await Promise.all([outbox.submit(workflow("a", "new", "toread")), outbox.submit(workflow("a", "toread", "inprogress"))]);
  assert.equal(one.status, "sent");
  assert.equal(two.status, "sent");
  assert.deepEqual(fake.log, ["workflow a toread @5", "workflow a inprogress @6"]);
});

test("keep and un-keep are repeated safely and a refusal is reported once, with PURSS's words", async () => {
  const fake = new Fake({ a: "new" });
  const { outbox, seen } = make(fake);
  assert.equal((await outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: true })).status, "sent");
  assert.equal((await outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: true })).status, "sent", "keeping again changes nothing");
  assert.equal((await outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: false })).status, "sent");
  assert.equal((await outbox.submit({ kind: "keep", itemId: "gone", basketId: "bkt_1", on: true })).status, "dropped");
  const last = seen[seen.length - 1]!;
  assert.equal(last.status === "dropped" ? last.message : "", "Not changed. That item wasn't found.");
  assert.equal(outbox.pendingCount(), 0);
});

test("a server fault holds back only that item; other items carry on, and it is tried again later", async () => {
  const fake = new Fake({ a: "new", b: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: { status: 503, code: "error", message: "" } });
  const { outbox, timers, advance } = make(fake);
  const first = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(first.status, "deferred");
  const second = await outbox.submit(workflow("b", "new", "finished"));
  assert.equal(second.status, "sent");
  const third = outbox.submit(workflow("a", "toread", "inprogress"));
  await outbox.drain();
  assert.deepEqual(fake.log.filter((l) => l.startsWith("workflow a")), ["workflow a toread @5"], "a's second change waits behind its first");
  assert.equal(timers.length > 0, true, "a retry is scheduled");
  advance(60_000);
  await outbox.drain();
  assert.equal((await third).status, "deferred");
  assert.deepEqual(fake.log.filter((l) => l.startsWith("workflow a")), ["workflow a toread @5", "workflow a toread @5", "workflow a inprogress @6"]);
  assert.equal(outbox.pendingCount(), 0);
});

test("a signed-out session sends nothing and drops nothing; signing in sends it", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: () => true, error: { status: 401, code: "unauthorized", message: "" } });
  const { outbox, seen } = make(fake);
  assert.equal((await outbox.submit(workflow("a", "new", "toread"))).status, "deferred");
  assert.equal(outbox.needsSignIn(), true);
  await outbox.drain();
  assert.equal(fake.log.length, 1, "no more attempts while signed out");
  outbox.resume();
  await outbox.drain();
  assert.equal(outbox.needsSignIn(), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, "sent");
});

test("two accounts on one browser never replay each other's changes", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const store = new MemoryStore();
  const one = make(fake, store, "acc_1");
  await one.outbox.submit(workflow("a", "new", "toread"));
  await one.outbox.settled();
  fake.down = false; fake.log.length = 0;
  // Same browser, same page: someone else signs in. Account 1's queue is set aside, untouched.
  one.outbox.setAccount("acc_2");
  await one.outbox.drain();
  assert.deepEqual(fake.log, [], "nothing of account 1 is sent under account 2");
  assert.equal(one.outbox.pendingCount(), 0, "and it is not shown to account 2");
  assert.equal((await store.load(scopeOf("https://purss.test", "acc_1"))).length, 1, "it is still on disk for account 1");
  // A fresh page for account 2 finds nothing either.
  const two = make(fake, store, "acc_2");
  await two.outbox.drain();
  assert.deepEqual(fake.log, []);
  // Account 1 comes back: its change is sent then.
  one.outbox.setAccount("acc_1");
  await one.outbox.drain();
  assert.deepEqual(fake.log, ["workflow a toread @5"]);
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
});

test("another installation served from the same browser has its own queue", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const store = new MemoryStore();
  const here = make(fake, store, "acc_1", "https://purss.test");
  await here.outbox.submit(workflow("a", "new", "toread"));
  await here.outbox.settled();
  fake.down = false; fake.log.length = 0;
  const there = make(fake, store, "acc_1", "https://other.example");
  await there.outbox.drain();
  assert.deepEqual(fake.log, [], "the same account id on another installation is a different person");
  assert.equal(there.outbox.pendingCount(), 0);
});

test("switching accounts while a change is in flight leaves it filed for its own account, never dropped", async () => {
  const fake = new Fake({ a: "new" });
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  fake.sender.workflow = async () => { await hold; throw { status: 404, code: "not_found", message: "That item wasn't found." } satisfies Fail; };
  const store = new MemoryStore();
  const { outbox, seen } = make(fake, store, "acc_1");
  const pending = outbox.submit(workflow("a", "new", "toread"));
  await new Promise((r) => setTimeout(r, 5));
  outbox.setAccount("acc_2"); // the answer will come back under the other session
  release();
  await outbox.settled();
  assert.equal((await pending).status, "deferred", "the person who was waiting is told it is kept for later");
  assert.deepEqual(seen, [], "no outcome is reported to account 2");
  assert.equal((await store.load(scopeOf("https://purss.test", "acc_1"))).length, 1);
});

test("signing out asks what to do with changes that were not sent", async () => {
  const fake = new Fake({ a: "new", b: "new" });
  fake.down = true;
  const { outbox, store } = make(fake);
  await outbox.submit(workflow("a", "new", "toread"));
  await outbox.submit(workflow("b", "new", "finished"));
  await outbox.settled();
  const asked: { count: number; failed: boolean }[] = [];

  // Nothing waiting: straight through, nothing asked.
  const empty = make(new Fake(), new MemoryStore());
  assert.equal(await signOutGate(empty.outbox, async () => { throw new Error("asked"); }), "go");

  // "Stay signed in": nothing is touched.
  assert.equal(await signOutGate(outbox, async (i) => { asked.push(i); return "stay"; }), "stay");
  assert.deepEqual(asked, [{ count: 2, failed: false }]);
  assert.equal(outbox.pendingCount(), 2);

  // "Send them first" while PURSS cannot be reached: asked again, saying so; then "Stay".
  const answers = ["send", "stay"] as const;
  let n = 0;
  assert.equal(await signOutGate(outbox, async (i) => { asked.push(i); return answers[n++]!; }), "stay");
  assert.deepEqual(asked.slice(1), [{ count: 2, failed: false }, { count: 2, failed: true }]);
  assert.equal(outbox.pendingCount(), 2, "still there");

  // "Send them first" with the connection back: sent, then signing out goes ahead.
  fake.down = false; fake.log.length = 0;
  assert.equal(await signOutGate(outbox, async () => "send"), "go");
  assert.deepEqual(fake.log, ["workflow a toread @5", "workflow b finished @5"]);
  assert.equal(outbox.pendingCount(), 0);

  // "Discard them": gone from memory and from the device, and nothing is sent.
  fake.down = true;
  await outbox.submit(workflow("a", "toread", "finished", 6));
  await outbox.settled();
  fake.down = false; fake.log.length = 0;
  assert.equal(await signOutGate(outbox, async () => "discard"), "go");
  assert.equal(outbox.pendingCount(), 0);
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
  await outbox.drain();
  assert.deepEqual(fake.log, []);
});

test("a change that never left can be taken back, once", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox, store } = make(fake, new MemoryStore(), "acc_1", "https://purss.test", { online: () => false });
  const out = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(out.status, "deferred");
  await outbox.settled();
  const id = out.status === "deferred" ? out.entry.id : "";
  assert.deepEqual(await outbox.cancel(id), { status: "cancelled" });
  assert.equal(outbox.pendingCount(), 0);
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
  assert.deepEqual(await outbox.cancel(id), { status: "undo" }, "a second Undo finds nothing to take back: whatever happened to it, the opposite change is the only way");
  fake.down = false; fake.log.length = 0;
  await outbox.drain();
  assert.deepEqual(fake.log, []);
});

test("pending items are shown as they will look, and the view tells its watchers when it changes", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox } = make(fake);
  let views = 0;
  outbox.subscribe(() => { views++; });
  const before = outbox.pendingItemIds();
  await outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: true });
  assert.notEqual(outbox.pendingItemIds(), before);
  assert.equal(views > 0, true);
  const shown = outbox.overlay([dto("a", "new", 5), dto("other", "new", 5)]);
  assert.deepEqual(shown[0]!.basketIds, ["bkt_1"]);
  assert.deepEqual(shown[1]!.basketIds, []);
});

test("without a way to keep changes on disk they are still sent from memory", async () => {
  const fake = new Fake({ a: "new" });
  const broken = { load: async () => { throw new Error("denied"); }, put: async () => { throw new Error("quota"); }, remove: async () => { throw new Error("denied"); } };
  let t = 0;
  const outbox = new Outbox({ store: broken, sender: fake.sender, now: () => t++ });
  outbox.setAccount("acc_1");
  const out = await outbox.submit(workflow("a", "new", "finished"));
  assert.equal(out.status, "sent");
});

// ---------- clearing New, several items, and taking a change back across tabs ----------

test("a clear of the New marker whose answer was lost does not strand a change queued behind it", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("clearFresh"), error: offline, applied: true }); // it committed, the answer never came
  const { outbox, seen } = make(fake);
  assert.equal((await outbox.submit({ kind: "clearFresh", itemIds: ["a"] })).status, "deferred");
  await outbox.settled();
  assert.equal(fake.items.get("a")!.fresh, false, "PURSS cleared it");
  assert.equal(fake.items.get("a")!.revision, 5, "and the clear did not move the revision");
  fake.down = true; // still no signal when the second change is made, on the revision from before the clear
  assert.equal((await outbox.submit(workflow("a", "new", "toread", 5))).status, "deferred");
  await outbox.settled();
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["clearFresh a", "workflow a toread @5"], "the clear finds nothing left to do, and the change goes out on its own revision");
  assert.equal(fake.items.get("a")!.workflow, "toread");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "sent"]);
  assert.equal(outbox.pendingCount(), 0);
});

test("a write made elsewhere is still caught behind a clear of the New marker", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox, seen } = make(fake);
  await outbox.submit({ kind: "clearFresh", itemIds: ["a"] });
  await outbox.submit(workflow("a", "new", "toread", 5));
  await outbox.settled();
  fake.items.get("a")!.revision = 8; // elsewhere, the item was changed and came back to Undecided
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["clearFresh a", "workflow a toread @5", "get a"], "the conflict is found and the change dropped");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "dropped"]);
  assert.equal(fake.items.get("a")!.workflow, "new");
});

test("several changes made at once are each kept on disk with their own revision, and all go out after a lost connection", async () => {
  const fake = new Fake({ a: "new", b: "toread", c: "new" });
  fake.items.get("b")!.revision = 9;
  fake.down = true;
  const { outbox, store } = make(fake);
  const outs = await outbox.submitMany([workflow("a", "new", "finished", 5), workflow("b", "toread", "finished", 9), workflow("c", "new", "finished", 5)]);
  assert.deepEqual(outs.map((o) => o.status), ["deferred", "deferred", "deferred"]);
  const kept = await store.load(scopeOf("https://purss.test", "acc_1"));
  assert.deepEqual(kept.map((e) => (e.kind === "workflow" ? [e.itemId, e.revision] : null)), [["a", 5], ["b", 9], ["c", 5]], "each item's own revision");
  await outbox.settled();
  fake.down = false; fake.log.length = 0;
  const reloaded = make(fake, store); // the page was closed and opened again
  await reloaded.outbox.drain();
  assert.deepEqual(fake.log, ["workflow a finished @5", "workflow b finished @9", "workflow c finished @5"]);
  assert.deepEqual([...fake.items.values()].map((i) => i.workflow), ["finished", "finished", "finished"]);
});

test("one of several changes made against an old revision is dropped on its own, the others go through", async () => {
  const fake = new Fake({ a: "new", b: "new" });
  fake.items.get("b")!.revision = 8;
  fake.items.get("b")!.workflow = "ignored"; // changed elsewhere meanwhile
  const { outbox } = make(fake);
  const outs = await outbox.submitMany([workflow("a", "new", "toread", 5), workflow("b", "new", "toread", 5)]);
  assert.deepEqual(outs.map((o) => o.status), ["sent", "dropped"]);
  assert.equal(fake.items.get("a")!.workflow, "toread");
  assert.equal(fake.items.get("b")!.workflow, "ignored", "the other device's choice stands");
});

/** Two tabs of one browser share the store and take turns on one lock. */
function sharedLock() {
  let held = false;
  const waiters: (() => void)[] = [];
  const release = () => { held = false; waiters.shift()?.(); };
  return {
    exclusive: async (fn: () => Promise<void>) => { if (held) return false; held = true; try { await fn(); return true; } finally { release(); } },
    locked: async <T>(fn: () => Promise<T>): Promise<T> => {
      while (held) await new Promise<void>((r) => waiters.push(r));
      held = true;
      try { return await fn(); } finally { release(); }
    },
  };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("taking a change back while another tab is sending it waits for that tab, and then undoes what it did", async () => {
  const fake = new Fake({ a: "new", x: "new" });
  const lock = sharedLock();
  const store = new MemoryStore();
  let letGo!: () => void;
  fake.holds.set("keep x", new Promise<void>((r) => { letGo = r; }));
  let letGoA!: () => void;
  fake.holds.set("keep a", new Promise<void>((r) => { letGoA = r; }));
  const tabB = make(fake, store, "acc_1", "https://purss.test", lock);
  const tabA = make(fake, store, "acc_1", "https://purss.test", lock);
  await Promise.all([tabA.outbox.ready, tabB.outbox.ready]);
  // Tab B is busy sending x, so tab A's keep waits in the queue.
  const first = tabB.outbox.submit({ kind: "keep", itemId: "x", basketId: "bkt_1", on: true });
  await tick();
  const second = await tabA.outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: true });
  assert.equal(second.status, "deferred");
  const entryId = second.status === "deferred" ? second.entry.id : "";
  // Tab B goes round again, finds tab A's keep in the shared queue and sends it.
  void tabB.outbox.drain();
  letGo();
  await first;
  await tick(20);
  assert.ok(fake.log.includes("keep a bkt_1"), "tab B has taken tab A's keep to PURSS");
  // Undo in tab A, while that request is in the air.
  const undo = tabA.outbox.cancel(entryId);
  let settledEarly = false;
  void undo.then(() => { settledEarly = true; });
  await tick(20);
  assert.equal(settledEarly, false, "Undo waits for the tab that is sending");
  letGoA();
  const result = await undo;
  assert.deepEqual(result, { status: "undo" }, "it was sent, so it is not simply cancelled");
  assert.deepEqual([...fake.items.get("a")!.baskets], ["bkt_1"], "PURSS has it kept");
  // The caller sends the opposite change; afterwards nothing is kept and no queue holds anything.
  assert.equal((await tabA.outbox.submit({ kind: "keep", itemId: "a", basketId: "bkt_1", on: false })).status, "sent");
  assert.deepEqual([...fake.items.get("a")!.baskets], []);
  assert.equal(tabA.outbox.pendingCount() + tabB.outbox.pendingCount(), 0);
});

test("an answer lost after the request left is not taken back as if it never went; the item is read to find out", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: offline, applied: true }); // it committed, the answer never came
  const { outbox, store } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(out.status, "deferred");
  await outbox.settled();
  const entryId = out.status === "deferred" ? out.entry.id : "";
  assert.equal((await store.load(scopeOf("https://purss.test", "acc_1")))[0]?.tried, true, "kept on disk as started before it left");
  fake.log.length = 0;
  const result = await outbox.cancel(entryId);
  assert.deepEqual(result, { status: "undo", revision: 6 }, "it took effect: undo must send the opposite change, on the revision read back");
  assert.deepEqual(fake.log, ["get a"]);
  assert.equal(outbox.pendingCount(), 0);
  // The opposite change, on that revision, restores the workflow.
  assert.equal((await outbox.submit(workflow("a", "toread", "new", 6))).status, "sent");
  assert.equal(fake.items.get("a")!.workflow, "new");
});

test("a change that never left is simply cancelled, and nothing is sent for it later", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const { outbox, store } = make(fake, new MemoryStore(), "acc_1", "https://purss.test", { online: () => false });
  const out = await outbox.submit(workflow("a", "new", "toread"));
  assert.equal(out.status, "deferred");
  await outbox.settled();
  const entryId = out.status === "deferred" ? out.entry.id : "";
  assert.notEqual((await store.load(scopeOf("https://purss.test", "acc_1")))[0]?.tried, true, "no connection: it cannot have reached PURSS");
  assert.deepEqual(await outbox.cancel(entryId), { status: "cancelled" });
  assert.equal(outbox.pendingCount(), 0);
  fake.down = false; fake.log.length = 0;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, []);
});

test("an answer lost after a change was sent, where the item turned out not to have it, is cancelled after all", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: offline }); // lost before it committed
  const { outbox } = make(fake);
  const out = await outbox.submit(workflow("a", "new", "toread"));
  await outbox.settled();
  const entryId = out.status === "deferred" ? out.entry.id : "";
  assert.deepEqual(await outbox.cancel(entryId), { status: "cancelled" }, "the item does not have the workflow, so nothing needs undoing");
  assert.equal(fake.items.get("a")!.workflow, "new");
});

test("Undo in a tab whose queued workflow change another tab already sent reads the item and gets the revision to undo on", async () => {
  const fake = new Fake({ a: "new", x: "new" });
  const lock = sharedLock();
  const store = new MemoryStore();
  let letGo!: () => void;
  fake.holds.set("keep x", new Promise<void>((r) => { letGo = r; }));
  const tabB = make(fake, store, "acc_1", "https://purss.test", lock);
  const tabA = make(fake, store, "acc_1", "https://purss.test", lock);
  await Promise.all([tabA.outbox.ready, tabB.outbox.ready]);
  // Tab B is busy sending x, so tab A's change waits in the shared queue.
  const first = tabB.outbox.submit({ kind: "keep", itemId: "x", basketId: "bkt_1", on: true });
  await tick();
  const change = workflow("a", "new", "toread", 5);
  const second = await tabA.outbox.submit(change);
  assert.equal(second.status, "deferred");
  const entryId = second.status === "deferred" ? second.entry.id : "";
  // Tab B goes round again, sends tab A's change and takes it off the shared queue.
  void tabB.outbox.drain();
  letGo();
  await first;
  await tabB.outbox.settled();
  assert.equal(fake.items.get("a")!.workflow, "toread", "tab B has sent it");
  assert.equal((await store.load(scopeOf("https://purss.test", "acc_1"))).length, 0, "and removed it");
  // Tab A's Undo: the entry is gone, but A still knows what the change was, so the item is read.
  fake.log.length = 0;
  const result = await tabA.outbox.cancel(entryId, change);
  assert.deepEqual(result, { status: "undo", revision: 6 }, "it has the target workflow, on revision 6");
  assert.deepEqual(fake.log, ["get a"]);
  // The opposite change on that revision restores the workflow (on the page's stale revision 5 it would have conflicted).
  assert.equal((await tabA.outbox.submit(workflow("a", "toread", "new", 6))).status, "sent");
  assert.equal(fake.items.get("a")!.workflow, "new");
  // And when the item turns out not to have the target workflow, there is nothing to undo.
  fake.items.get("a")!.workflow = "finished";
  assert.deepEqual(await tabA.outbox.cancel("ent_gone", change), { status: "cancelled" });
});

/** Tab B sends tab A's queued workflow change (A is left holding a change that is gone from the queue); returns what A needs to Undo it. */
async function otherTabSent(store: MemoryStore = new MemoryStore()) {
  const fake = new Fake({ a: "new", x: "new" });
  const lock = sharedLock();
  let letGo!: () => void;
  fake.holds.set("keep x", new Promise<void>((r) => { letGo = r; }));
  const tabB = make(fake, store, "acc_1", "https://purss.test", lock);
  const tabA = make(fake, store, "acc_1", "https://purss.test", lock);
  await Promise.all([tabA.outbox.ready, tabB.outbox.ready]);
  const first = tabB.outbox.submit({ kind: "keep", itemId: "x", basketId: "bkt_1", on: true });
  await tick();
  const change = workflow("a", "new", "toread", 5);
  const queued = await tabA.outbox.submit(change);
  const entryId = queued.status === "deferred" ? queued.entry.id : "";
  void tabB.outbox.drain();
  letGo();
  await first;
  await tabB.outbox.settled();
  assert.equal(fake.items.get("a")!.workflow, "toread", "tab B sent it");
  return { fake, store, tabA, change, entryId };
}

test("Undo in a tab, with no connection to read the item, is kept and restores the workflow when the connection is back", async () => {
  const { fake, store, tabA, change, entryId } = await otherTabSent();
  fake.down = true; // no signal: the read-back fails
  const result = await tabA.outbox.cancel(entryId, change);
  assert.deepEqual(result, { status: "pending" }, "the Undo is kept rather than sent on a revision that is now stale");
  const kept = await store.load(scopeOf("https://purss.test", "acc_1"));
  assert.deepEqual(kept.map((e) => (e.kind === "undoWorkflow" ? [e.itemId, e.applied, e.restore] : e.kind)), [["a", "toread", "new"]], "kept on disk as its own entry");
  assert.equal(tabA.outbox.pendingCount(), 1);
  assert.equal(tabA.outbox.overlay([dto("a", "toread", 6)])[0]!.workflow, "new", "meanwhile the item shows as restored");
  await tabA.outbox.settled();
  fake.down = false; fake.log.length = 0;
  tabA.outbox.resume();
  await tabA.outbox.drain();
  assert.deepEqual(fake.log, ["get a", "workflow a new @6"], "read first, then put back on the revision just read");
  assert.equal(fake.items.get("a")!.workflow, "new");
  assert.equal(tabA.outbox.pendingCount(), 0);
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
});

test("a kept Undo does nothing, quietly, if the item no longer has the workflow that was applied", async () => {
  const { fake, store, tabA, change, entryId } = await otherTabSent();
  fake.down = true;
  assert.deepEqual(await tabA.outbox.cancel(entryId, change), { status: "pending" });
  await tabA.outbox.settled();
  fake.items.get("a")!.workflow = "finished"; // changed elsewhere meanwhile
  fake.down = false; fake.log.length = 0;
  const seen: Outcome[] = [];
  tabA.outbox.onOutcome((o) => seen.push(o));
  tabA.outbox.resume();
  await tabA.outbox.drain();
  assert.deepEqual(fake.log, ["get a"], "nothing is written");
  assert.equal(fake.items.get("a")!.workflow, "finished", "the other change stands");
  assert.deepEqual(seen.map((o) => (o.status === "sent" && o.result.kind === "undoWorkflow" ? o.result.item : "x")), [null], "finished with nothing to say");
  assert.deepEqual(await store.load(scopeOf("https://purss.test", "acc_1")), []);
});

test("changes queued behind a kept Undo are carried to the revision the Undo produced, and still go through", async () => {
  const { fake, tabA, change, entryId } = await otherTabSent();
  fake.down = true;
  assert.deepEqual(await tabA.outbox.cancel(entryId, change), { status: "pending" });
  // Offline, the item shows as restored to New at revision 6, and the person goes on to finish it.
  assert.equal((await tabA.outbox.submit(workflow("a", "new", "finished", 6))).status, "deferred");
  await tabA.outbox.settled();
  fake.down = false; fake.log.length = 0;
  const seen: Outcome[] = [];
  tabA.outbox.onOutcome((o) => seen.push(o));
  tabA.outbox.resume();
  await tabA.outbox.drain();
  assert.deepEqual(fake.log, ["get a", "workflow a new @6", "workflow a finished @7"], "the later change is sent on the revision the Undo's write produced");
  assert.equal(fake.items.get("a")!.workflow, "finished");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "sent"], "nothing was dropped");
  assert.equal(tabA.outbox.pendingCount(), 0);
});

// ---------- an Undo and the account it belongs to ----------

/** A point a test holds a step at: `arrived` says the step is there, `release()` lets it go on. */
function holdPoint() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => { arrive = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { arrived, release, wait: async () => { arrive(); await released; } };
}
const kept = (entries: readonly Entry[]) => entries.map((e) => (e.kind === "undoWorkflow" ? [e.itemId, e.applied, e.restore] : e.kind));
const SCOPE_1 = scopeOf("https://purss.test", "acc_1");
const SCOPE_2 = scopeOf("https://purss.test", "acc_2");

test("an Undo whose read is out when another account signs in is not done for the new account, and stays filed for its own", async () => {
  const { fake, store, tabA, change, entryId } = await otherTabSent();
  const read = holdPoint();
  fake.beforeRead = async () => { await read.wait(); throw offline; };
  const cancelling = tabA.outbox.cancel(entryId, change);
  await read.arrived;
  tabA.outbox.setAccount("acc_2");
  read.release();
  assert.deepEqual(await cancelling, { status: "away" }, "not kept for the account that is signed in now");
  assert.deepEqual(await store.load(SCOPE_2), [], "nothing lands in the other account's partition");
  assert.equal(tabA.outbox.pendingCount(), 0, "nor in its queue");
  assert.deepEqual(kept(await store.load(SCOPE_1)), [["a", "toread", "new"]], "the Undo waits for its own account");
  // Its own account comes back: the Undo goes out.
  fake.beforeRead = undefined;
  tabA.outbox.setAccount("acc_1");
  await tabA.outbox.ready;
  await tabA.outbox.drain();
  assert.equal(fake.items.get("a")!.workflow, "new");
  assert.deepEqual(await store.load(SCOPE_1), []);
});

for (const reads of ["fails", "answers"] as const) {
  test(`an Undo whose read ${reads} after signing out is not reported as kept or as ready to send`, async () => {
    const { fake, store, tabA, change, entryId } = await otherTabSent();
    const read = holdPoint();
    fake.beforeRead = async () => { await read.wait(); if (reads === "fails") throw offline; };
    const cancelling = tabA.outbox.cancel(entryId, change);
    await read.arrived;
    tabA.outbox.setAccount(null);
    read.release();
    assert.deepEqual(await cancelling, { status: "away" }, reads === "fails" ? "there is no queue to keep it in" : "the opposite change must not be sent by whoever signs in next");
    assert.equal(tabA.outbox.pendingCount(), 0);
    assert.deepEqual(await store.load(SCOPE_2), []);
    assert.equal(fake.items.get("a")!.workflow, "toread", "nothing was sent");
  });
}

test("an Undo being written to disk when another account signs in does not enter the new account's queue", async () => {
  class SlowPuts extends MemoryStore {
    point: ReturnType<typeof holdPoint> | null = null;
    override async put(entry: Entry): Promise<void> { await super.put(entry); await this.point?.wait(); }
  }
  const store = new SlowPuts();
  const { fake, tabA, change, entryId } = await otherTabSent(store);
  fake.down = true; // the read fails, so the Undo is kept
  store.point = holdPoint();
  const cancelling = tabA.outbox.cancel(entryId, change);
  await store.point.arrived;
  tabA.outbox.setAccount("acc_2");
  store.point.release();
  assert.deepEqual(await cancelling, { status: "away" });
  assert.equal(tabA.outbox.pendingCount(), 0, "the old account's entry is not in the new account's queue");
  assert.deepEqual(tabA.outbox.entries(), []);
  assert.deepEqual(await store.load(SCOPE_2), []);
  assert.deepEqual(kept(await store.load(SCOPE_1)), [["a", "toread", "new"]], "it is on disk under its own account");
});

test("an Undo waiting for the send lock when another account signs in does nothing for the new account", async () => {
  const fake = new Fake({ a: "new" });
  const lock = sharedLock();
  const { outbox } = make(fake, new MemoryStore(), "acc_1", "https://purss.test", lock);
  await outbox.ready;
  const busy = holdPoint();
  const otherTab = lock.locked(() => busy.wait()); // another tab is sending
  await busy.arrived;
  const cancelling = outbox.cancel("gone", workflow("a", "new", "toread", 5));
  await tick();
  outbox.setAccount("acc_2");
  busy.release();
  await otherTab;
  assert.deepEqual(await cancelling, { status: "away" });
  assert.deepEqual(fake.log, [], "the item is not read with the other account's session");
});

/** A store whose removals can be held open by a test: the entry is gone from disk, the call has not returned. */
class SlowRemoves extends MemoryStore {
  point: ReturnType<typeof holdPoint> | null = null;
  override async remove(id: string): Promise<void> { await super.remove(id); await this.point?.wait(); }
}

test("an Undo taking a sent change off the disk when another account signs in does not go on to read the item", async () => {
  const fake = new Fake({ a: "new" });
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: offline, applied: true }); // it committed, the answer never came
  const store = new SlowRemoves();
  const { outbox } = make(fake, store);
  const out = await outbox.submit(workflow("a", "new", "toread"));
  await outbox.settled();
  const entryId = out.status === "deferred" ? out.entry.id : "";
  fake.log.length = 0;
  store.point = holdPoint();
  const cancelling = outbox.cancel(entryId);
  await store.point.arrived;
  outbox.setAccount("acc_2");
  store.point.release();
  assert.deepEqual(await cancelling, { status: "away" });
  assert.deepEqual(fake.log, [], "the item is not read with the other account's session");
});

test("an Undo pressed when nobody is signed in is not done, and nothing is sent or filed", async () => {
  const fake = new Fake({ a: "new" });
  const { outbox, store } = make(fake, new MemoryStore(), "acc_1");
  await outbox.ready;
  outbox.setAccount(null);
  assert.deepEqual(await outbox.cancel("gone", workflow("a", "new", "toread", 5)), { status: "away" });
  assert.deepEqual(fake.log, []);
  assert.deepEqual(await store.load(SCOPE_1), []);
});

test("an Undo taking a change that never left off the disk when another account signs in is not done for the new account", async () => {
  const fake = new Fake({ a: "new" });
  fake.down = true;
  const store = new SlowRemoves();
  const { outbox } = make(fake, store, "acc_1", "https://purss.test", { online: () => false });
  const out = await outbox.submit(workflow("a", "new", "toread"));
  await outbox.settled();
  const entryId = out.status === "deferred" ? out.entry.id : "";
  assert.notEqual((await store.load(SCOPE_1))[0]?.tried, true, "it never left");
  store.point = holdPoint();
  const cancelling = outbox.cancel(entryId);
  await store.point.arrived;
  outbox.setAccount("acc_2");
  store.point.release();
  assert.deepEqual(await cancelling, { status: "away" }, "not 'cancelled': the caller must not roll anything back for the account that is signed in now");
  assert.deepEqual(await store.load(SCOPE_1), [], "the entry itself is gone from its own account's disk");
});

// ---------- changes made after a kept Undo ----------

/**
 * A send commits but its answer is lost: PURSS is at revision 1 while the page still has 0. The person takes it back with
 * no connection (the Undo is kept) and goes on from the restored state, still on the revision the page had.
 */
async function undoneWithoutConnection() {
  const fake = new Fake({ a: "new" });
  fake.items.get("a")!.revision = 0;
  fake.failures.push({ when: (c) => c.startsWith("workflow a"), error: offline, applied: true });
  const { outbox, seen, store } = make(fake);
  const change = workflow("a", "new", "toread", 0);
  const sent = await outbox.submit(change);
  assert.equal(sent.status, "deferred");
  await outbox.settled();
  fake.down = true;
  assert.deepEqual(await outbox.cancel(sent.status === "deferred" ? sent.entry.id : "", change), { status: "pending" });
  assert.equal((await outbox.submit(workflow("a", "new", "finished", 0))).status, "deferred");
  await outbox.settled();
  assert.equal(fake.items.get("a")!.revision, 1);
  fake.log.length = 0; seen.length = 0;
  return { fake, outbox, seen, store };
}

test("changes made after a kept Undo are sent on the revision the Undo produced, whatever revision the page had cached", async () => {
  const { fake, outbox, seen } = await undoneWithoutConnection();
  fake.down = false;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["get a", "workflow a new @1", "workflow a finished @2"], "the later change goes out on the Undo's result, not on the revision it was made against");
  assert.equal(fake.items.get("a")!.workflow, "finished");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "sent"]);
  assert.equal(outbox.pendingCount(), 0);
});

test("a write made elsewhere is still caught behind a kept Undo: the Undo does nothing and the later change is refused", async () => {
  const { fake, outbox, seen } = await undoneWithoutConnection();
  Object.assign(fake.items.get("a")!, { workflow: "ignored", revision: 2 }); // someone else's change, before the Undo could run
  fake.down = false;
  outbox.resume();
  await outbox.drain();
  assert.deepEqual(fake.log, ["get a", "workflow a finished @0", "get a"], "nothing was written by the Undo, so nothing was rebased");
  assert.equal(fake.items.get("a")!.workflow, "ignored");
  assert.deepEqual(seen.map((o) => o.status), ["sent", "dropped"]);
});
