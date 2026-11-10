import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { createSeenStore, itemNeedsOpening, openItem, undoSeen } from "./open-item.ts";
import type { OpenDeps, SeenNotice } from "./open-item.ts";

function item(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: "itm_a", sourceId: "src_a", sourceTitle: "S", kind: "article", title: "T", url: null, author: null, excerpt: null, imageUrl: null, durationSeconds: null, readMinutes: null,
    doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 3, stateVersion: 4, fresh: true, progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null, ...over,
  };
}

/** The page and PURSS in a box: records what was shown and written; the panel's line is the real store. */
function harness(start: ItemDTO, server: (before: ItemDTO) => ItemDTO = (b) => ({ ...b, opened: true, fresh: false, revision: b.revision + 1 })) {
  const shown: ItemDTO[] = [];
  const log: string[] = [];
  const store = createSeenStore();
  const deps: OpenDeps = {
    find: () => start,
    put: (it) => { shown.push(it); },
    write: async () => { log.push("write"); return { item: server(start), undoToken: "und_open" }; },
    newCleared: () => { log.push("counts"); },
    seen: store,
    conflict: () => { log.push("conflict"); },
  };
  return { deps, shown, log, store, line: () => store.get() };
}

test("opening a New item leaves a quiet line in the panel, with the Undo that brings the marker back", async () => {
  const h = harness(item());
  await openItem("itm_a", h.deps);
  assert.deepEqual(h.line(), { itemId: "itm_a", undoToken: "und_open" }, "the line carries PURSS's token for that item");
  assert.deepEqual(h.log, ["write", "counts"]);
  assert.equal(h.shown.at(-1)!.fresh, false);
});

test("opening an item that was not New leaves no line", async () => {
  const h = harness(item({ fresh: false }), (b) => ({ ...b, opened: true, revision: b.revision + 1 }));
  await openItem("itm_a", h.deps);
  assert.equal(h.line(), null);
  assert.deepEqual(h.log, ["write"], "recorded as opened, nothing else to show");
});

test("opening any item first removes the line of the one before", async () => {
  const h = harness(item({ opened: true, fresh: false }));
  h.store.publish(h.store.begin(), { itemId: "itm_old", undoToken: "und_old" });
  assert.equal(h.line()?.itemId, "itm_old");
  await openItem("itm_a", h.deps); // nothing to write at all
  assert.equal(h.line(), null, "the earlier line is gone even though this opening wrote nothing");
});

/** Two items opened one after the other, with the answers coming back in the order given. */
async function twoOpenings(order: "A first" | "B first", between?: (store: ReturnType<typeof createSeenStore>) => void) {
  const store = createSeenStore();
  const answers: Record<string, () => void> = {};
  const deps = (id: string): OpenDeps => ({
    find: () => item({ id }),
    put: () => undefined,
    write: () => new Promise((resolve) => { answers[id] = () => resolve({ item: item({ id, fresh: false, opened: true, revision: 4 }), undoToken: `und_${id}` }); }),
    newCleared: () => undefined,
    seen: store,
    conflict: () => undefined,
  });
  const a = openItem("A", deps("A"));
  const b = openItem("B", deps("B")); // B is opened while A's answer is still on its way
  await Promise.resolve();
  between?.(store);
  const first = order === "A first" ? "A" : "B";
  const second = order === "A first" ? "B" : "A";
  answers[first]!(); await (first === "A" ? a : b);
  answers[second]!(); await (second === "A" ? a : b);
  return store;
}

test("the answer for an earlier item never replaces the line of the item now open", async () => {
  const store = await twoOpenings("B first");
  assert.deepEqual(store.get(), { itemId: "B", undoToken: "und_B" }, "B's line stays when A's late answer arrives");
  const other = await twoOpenings("A first");
  assert.deepEqual(other.get(), { itemId: "B", undoToken: "und_B" }, "and when A answers first, A's line is never shown");
});

test("an answer that arrives after the panel was closed shows nothing", async () => {
  const store = await twoOpenings("A first", (s) => s.clear()); // the panel closes before either answer
  assert.equal(store.get(), null);
});

test("Undo removes the line, shows the item as New again and presses PURSS's Undo", async () => {
  const start = item({ fresh: false, opened: true });
  const shown: ItemDTO[] = [];
  const log: string[] = [];
  const store = createSeenStore();
  store.publish(store.begin(), { itemId: "itm_a", undoToken: "und_open" });
  await undoSeen({ itemId: "itm_a", undoToken: "und_open" }, {
    find: () => start,
    put: (it) => { shown.push(it); },
    undo: async (t) => { log.push(`undo ${t}`); },
    seen: store,
    refresh: () => { log.push("refresh"); },
    fail: () => { log.push("fail"); },
  });
  assert.equal(store.get(), null, "the line is gone");
  assert.equal(shown.at(-1)!.fresh, true, "the item shows New again");
  assert.equal(shown.at(-1)!.opened, true, "it is still opened: Undo only brings the marker back");
  assert.deepEqual(log, ["undo und_open", "refresh"]);
});

test("if Undo cannot be done (it expired, or no connection) the item goes back to as it was and the person is told", async () => {
  const start = item({ fresh: false, opened: true });
  const shown: ItemDTO[] = [];
  const log: string[] = [];
  await undoSeen({ itemId: "itm_a", undoToken: "und_old" }, {
    find: () => start,
    put: (it) => { shown.push(it); },
    undo: async () => { throw new Error("That undo has expired."); },
    seen: createSeenStore(),
    refresh: () => { log.push("refresh"); },
    fail: (err) => { log.push(`fail ${(err as Error).message}`); },
  });
  assert.equal(shown.at(-1)!.fresh, false);
  assert.deepEqual(log, ["fail That undo has expired."]);
});

test("an item that was opened before but is still New is written again, so its marker clears", async () => {
  // Both flags are true after a migration, or after Undoing a seen marker.
  assert.equal(itemNeedsOpening({ opened: true, fresh: true }), true);
  assert.equal(itemNeedsOpening({ opened: false, fresh: true }), true);
  assert.equal(itemNeedsOpening({ opened: false, fresh: false }), true);
  assert.equal(itemNeedsOpening({ opened: true, fresh: false }), false, "opened and not New: nothing to write");
  const h = harness(item({ opened: true, fresh: true }));
  await openItem("itm_a", h.deps);
  assert.deepEqual(h.log, ["write", "counts"]);
  assert.notEqual(h.line(), null);
});

test("a refused or failed opening puts the item back and leaves no line; a conflict looks at the item again", async () => {
  const failing = harness(item());
  failing.deps.write = async () => { throw Object.assign(new Error("offline"), { code: "offline" }); };
  await openItem("itm_a", failing.deps);
  assert.equal(failing.shown.at(-1)!.opened, false, "shown as it was");
  assert.equal(failing.line(), null);
  const clash = harness(item());
  clash.deps.write = async () => { throw Object.assign(new Error("conflict"), { code: "conflict" }); };
  await openItem("itm_a", clash.deps);
  assert.deepEqual(clash.log, ["conflict"]);
  assert.equal(clash.line(), null);
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** What the item panel does with its effects, replayed the way development StrictMode replays them: mount, unmount, mount again. */
async function panelLifecycle(strictModeReplay: boolean, closeBeforeAnswer: boolean) {
  const store = createSeenStore();
  let answer!: () => void;
  const deps: OpenDeps = {
    find: () => item(),
    put: () => undefined,
    write: () => new Promise((resolve) => { answer = () => resolve({ item: item({ fresh: false, opened: true, revision: 4 }), undoToken: "und_open" }); }),
    newCleared: () => undefined,
    seen: store,
    conflict: () => undefined,
  };
  const opened = { current: null as string | null }; // the panel's own "opened already" guard
  const mount = () => { store.hold(); if (opened.current !== "itm_a") { opened.current = "itm_a"; void openItem("itm_a", deps); } };
  const unmount = () => store.release();
  mount();
  if (strictModeReplay) { unmount(); mount(); }
  if (closeBeforeAnswer) { unmount(); await tick(); }
  answer();
  await tick();
  return store;
}

test("a replayed effect (development StrictMode) does not end the opening under way: its line still appears", async () => {
  const store = await panelLifecycle(true, false);
  assert.deepEqual(store.get(), { itemId: "itm_a", undoToken: "und_open" });
});

test("the panel really closing before the answer arrives ends the opening: no line", async () => {
  assert.equal((await panelLifecycle(false, true)).get(), null);
  assert.equal((await panelLifecycle(true, true)).get(), null, "also when it was replayed first");
});

test("closing the panel removes a line that is showing, and opening the next item takes it over without a gap", async () => {
  const store = createSeenStore();
  store.hold();
  store.publish(store.begin(), { itemId: "itm_a", undoToken: "und_a" });
  store.release();
  store.hold(); // the next item's panel mounts in the same commit
  await tick();
  assert.equal(store.get()?.itemId, "itm_a", "held again: nothing was decided");
  store.release();
  await tick();
  assert.equal(store.get(), null, "released and not held again: the panel closed");
});
