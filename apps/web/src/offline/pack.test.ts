import test from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { DETAIL_MAX_AGE_MS, PACK_CHANGE_INTERVAL_MS, PACK_KEPT_LIMIT, PACK_MIN_INTERVAL_MS, PACK_REBUILD_INTERVAL_MS, annotationsToFetch, copiesMissing, itemsToFetch, packWait, parseRecord, selectQueue, sourcesOf, waitBeforeRun } from "./pack.ts";

let n = 0;
function item(over: Partial<ItemDTO> & { workflow: WorkflowState }): ItemDTO {
  n++;
  return {
    id: over.id ?? `itm_${n}`, sourceId: "src_1", sourceTitle: "A source", kind: "article", title: `Item ${n}`, url: null, author: null, excerpt: null, imageUrl: null,
    durationSeconds: null, readMinutes: null, doi: null, publishedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), discoveredAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
    revision: 1, stateVersion: 1, fresh: false, progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null, ...over,
  };
}

test("the queue is what was chosen to read, newest first, then new undecided items, newest first", () => {
  const a = item({ workflow: "toread" });
  const b = item({ workflow: "inprogress" });
  const c = item({ workflow: "toread" });
  const u1 = item({ workflow: "new", fresh: true });
  const u2 = item({ workflow: "new", fresh: true });
  const queue = selectQueue({ toread: [a, c], inprogress: [b], fresh: [u1, u2] });
  assert.deepEqual(queue.map((i) => i.id), [c.id, b.id, a.id, u2.id, u1.id]);
});

test("only undecided items that are New join; New items already chosen, finished or ignored do not", () => {
  const chosen = item({ workflow: "toread", fresh: true });
  const done = item({ workflow: "finished", fresh: true });
  const ignored = item({ workflow: "ignored", fresh: true });
  const stale = item({ workflow: "new", fresh: false });
  const keep = item({ workflow: "new", fresh: true });
  const queue = selectQueue({ toread: [chosen], inprogress: [], fresh: [chosen, done, ignored, stale, keep] });
  assert.deepEqual(queue.map((i) => i.id), [chosen.id, keep.id]);
});

test("a cap of 200 never lets arrivals push out what was chosen", () => {
  const chosen = Array.from({ length: 150 }, () => item({ workflow: "toread" }));
  const fresh = Array.from({ length: 300 }, () => item({ workflow: "new", fresh: true }));
  const queue = selectQueue({ toread: chosen, inprogress: [], fresh });
  assert.equal(queue.length, 200);
  assert.equal(chosen.every((c) => queue.some((q) => q.id === c.id)), true);
  assert.equal(queue.filter((q) => q.workflow === "new").length, 50);
  const crowded = selectQueue({ toread: Array.from({ length: 260 }, () => item({ workflow: "toread" })), inprogress: [], fresh });
  assert.equal(crowded.length, 200);
  assert.equal(crowded.some((q) => q.workflow === "new"), false);
});

test("the queue copes with nothing, and with an item listed twice", () => {
  assert.deepEqual(selectQueue({ toread: [], inprogress: [], fresh: [] }), []);
  const a = item({ workflow: "toread", fresh: true });
  assert.equal(selectQueue({ toread: [a, a], inprogress: [a], fresh: [a] }).length, 1);
});

test("only items that are missing, changed or old are fetched again", () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const same = item({ workflow: "toread", stateVersion: 3 });
  const changed = item({ workflow: "toread", stateVersion: 4 });
  const fresh = item({ workflow: "toread", stateVersion: 1 });
  const old = item({ workflow: "toread", stateVersion: 1 });
  const wiped = item({ workflow: "toread", stateVersion: 1 });
  const waitingForText = item({ workflow: "toread", stateVersion: 2 });
  const saved = {
    [same.id]: { stateVersion: 3, at: now - 60_000 },
    [changed.id]: { stateVersion: 3, at: now - 60_000 },
    [old.id]: { stateVersion: 1, at: now - DETAIL_MAX_AGE_MS - 1 },
    [wiped.id]: { stateVersion: 1, at: now - 60_000 },
    [waitingForText.id]: { stateVersion: 2, at: now - 60_000, textPending: true },
  };
  const present = new Set([same.id, changed.id, old.id, waitingForText.id]);
  const todo = itemsToFetch([same, changed, fresh, old, wiped, waitingForText], saved, present, now).map((i) => i.id);
  assert.deepEqual(todo, [changed.id, fresh.id, old.id, wiped.id, waitingForText.id], "an item saved before its readable copy finished is fetched again");
  assert.equal(parseRecord(JSON.stringify({ items: saved })).items[waitingForText.id]!.textPending, true, "the flag survives a reload");
});

test("highlights and notes are saved for annotated items when their text was fetched or they changed", () => {
  const never = item({ workflow: "toread" });
  const same = item({ workflow: "toread", annotatedAt: "2026-11-01T10:00:00.000Z" });
  const changed = item({ workflow: "toread", annotatedAt: "2026-11-02T10:00:00.000Z" });
  const refetched = item({ workflow: "toread", annotatedAt: "2026-11-01T10:00:00.000Z" });
  const saved = {
    [never.id]: { stateVersion: 1, at: 1 },
    [same.id]: { stateVersion: 1, at: 1, annotatedAt: "2026-11-01T10:00:00.000Z" },
    [changed.id]: { stateVersion: 1, at: 1, annotatedAt: "2026-11-01T10:00:00.000Z" },
    [refetched.id]: { stateVersion: 1, at: 1, annotatedAt: "2026-11-01T10:00:00.000Z" },
  };
  const todo = annotationsToFetch([never, same, changed, refetched], saved, new Set([never.id, refetched.id])).map((i) => i.id);
  assert.deepEqual(todo, [changed.id, refetched.id], "an item never annotated needs no copy");
  assert.equal(parseRecord(JSON.stringify({ items: saved })).items[same.id]!.annotatedAt, "2026-11-01T10:00:00.000Z", "remembered across reloads");
});

test("a saved item is fetched again when any change to its state moved the version, even one that leaves the revision alone", () => {
  const now = Date.UTC(2026, 10, 4, 12);
  // Cleared by opening, then taken back: the revision never moved, the version moved twice, and the New marker is as it was.
  const restored = item({ workflow: "toread", revision: 3, stateVersion: 7, fresh: true });
  const cleared = item({ workflow: "toread", revision: 3, stateVersion: 6, fresh: false, opened: true });
  const untouched = item({ workflow: "toread", revision: 3, stateVersion: 5 });
  const kept = item({ workflow: "toread", revision: 3, stateVersion: 6, basketIds: ["bkt_1"] }); // saved before it was kept: keeping leaves the revision alone
  const saved = {
    [restored.id]: { stateVersion: 6, at: now - 60_000 }, // saved while it was cleared
    [cleared.id]: { stateVersion: 5, at: now - 60_000 }, // saved while it was still New
    [untouched.id]: { stateVersion: 5, at: now - 60_000 },
    [kept.id]: { stateVersion: 5, at: now - 60_000 },
  };
  const present = new Set([restored.id, cleared.id, untouched.id, kept.id]);
  assert.deepEqual(itemsToFetch([restored, cleared, untouched, kept], saved, present, now).map((i) => i.id), [restored.id, cleared.id, kept.id]);
  assert.equal(parseRecord(JSON.stringify({ items: saved })).items[cleared.id]!.stateVersion, 5, "it survives a reload");
  // A record from before the version existed has none: it is dropped, so the item is refreshed once and then has one.
  assert.deepEqual(parseRecord(JSON.stringify({ items: { old: { revision: 3, at: now } } })).items, {});
});

test("automatic refreshes wait until fifteen minutes after the last start", () => {
  const now = 1_000_000_000;
  assert.equal(waitBeforeRun(null, now), 0);
  assert.equal(waitBeforeRun(now - 60_000, now), PACK_MIN_INTERVAL_MS - 60_000);
  assert.equal(waitBeforeRun(now - PACK_MIN_INTERVAL_MS, now), 0);
  assert.equal(waitBeforeRun(now - 2 * PACK_MIN_INTERVAL_MS, now), 0);
});

test("a damaged saved record means nothing was saved", () => {
  assert.deepEqual(parseRecord(null), { startedAt: null, savedAt: null, items: {} });
  assert.deepEqual(parseRecord("{nope"), { startedAt: null, savedAt: null, items: {} });
  assert.deepEqual(parseRecord(JSON.stringify({ startedAt: 5, savedAt: "x", items: { a: { stateVersion: 2, at: 9 }, b: { stateVersion: "2" }, c: null } })), { startedAt: 5, savedAt: "x", items: { a: { stateVersion: 2, at: 9 } } });
});

test("the pages worth saving are the sources behind the queue, busiest first", () => {
  const q = [item({ workflow: "toread", sourceId: "b" }), item({ workflow: "toread", sourceId: "a" }), item({ workflow: "toread", sourceId: "b" }), item({ workflow: "toread", sourceId: null })];
  assert.deepEqual(sourcesOf(q, 5), ["b", "a"]);
  assert.deepEqual(sourcesOf(q, 1), ["b"]);
});

test("kept items from text baskets join after what was chosen to read and before what merely arrived", () => {
  const chosen = item({ workflow: "toread" });
  const keptNew = item({ workflow: "new" });
  const keptFinished = item({ workflow: "finished" });
  const undecided = item({ workflow: "new", fresh: true });
  const queue = selectQueue({ toread: [chosen], inprogress: [], fresh: [undecided, keptNew], kept: [keptFinished, chosen, keptNew] });
  assert.deepEqual(queue.map((i) => i.id), [chosen.id, keptFinished.id, keptNew.id, undecided.id], "the kept ones keep the order they were listed in, and nothing is saved twice");
  const many = Array.from({ length: PACK_KEPT_LIMIT + 30 }, () => item({ workflow: "finished" }));
  assert.equal(selectQueue({ toread: [], inprogress: [], fresh: [], kept: many }).length, PACK_KEPT_LIMIT, "kept items are capped");
  const crowded = Array.from({ length: 200 }, () => item({ workflow: "toread" }));
  assert.equal(selectQueue({ toread: crowded, inprogress: [], fresh: [], kept: many }).some((i) => i.workflow === "finished"), false, "what was chosen is never crowded out by kept items");
});

test("copies the record says were saved but the device no longer holds mean the queue is saved again at once", () => {
  const now = 1_000_000_000;
  const record = { startedAt: now - 60_000, savedAt: "2026-11-06T10:00:00.000Z", items: { a: { stateVersion: 1, at: 1 }, b: { stateVersion: 1, at: 1 } } };
  assert.equal(copiesMissing(record, new Set(["a", "b"])), false);
  assert.equal(copiesMissing(record, new Set(["a"])), true, "one copy gone");
  assert.equal(copiesMissing(record, new Set()), true, "the browser cleared its storage");
  assert.equal(copiesMissing({ ...record, items: {} }, new Set()), false, "nothing was saved, so nothing is missing");
  // A minute after the last save with all copies present: wait out the rest of the fifteen minutes.
  assert.equal(packWait(record, new Set(["a", "b"]), now, 1500), PACK_MIN_INTERVAL_MS - 60_000);
  // The same with the copies gone: only what is left of ten seconds (none, here).
  assert.equal(packWait(record, new Set(), now, 1500), 1500);
  assert.equal(packWait({ ...record, startedAt: now - 4_000 }, new Set(), now, 1500), PACK_REBUILD_INTERVAL_MS - 4_000, "never closer together than ten seconds");
  // After a change the person made: soon, but not within half a minute of the last save.
  assert.equal(packWait(record, new Set(["a", "b"]), now, 4000, PACK_CHANGE_INTERVAL_MS), 4000);
  assert.equal(packWait({ ...record, startedAt: now - 5_000 }, new Set(["a", "b"]), now, 4000, PACK_CHANGE_INTERVAL_MS), PACK_CHANGE_INTERVAL_MS - 5_000);
  // The very first save has no record and starts at once.
  assert.equal(packWait({ startedAt: null, savedAt: null, items: {} }, new Set(), now, 1500), 1500);
});
