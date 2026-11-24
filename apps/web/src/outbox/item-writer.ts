import { app } from "@purss/translations/app";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { isolate } from "../lib/bidi.ts";
import { workflowLabel } from "../lib/constants.ts";
import { plural } from "../lib/format.ts";
import { newMarkerCleared } from "../lib/items.ts";
import type { LateStore } from "../lib/late-writes.ts";
import { worthRetrying } from "../lib/late-writes.ts";
import { openItem, undoSeen } from "../lib/open-item.ts";
import type { SeenNotice, SeenStore } from "../lib/open-item.ts";
import { settleProgress } from "../state/late-progress.ts";
import { noteManualWorkflowChange } from "../state/workflow-intent.ts";
import { keepChanges, summariseBatch, workflowChanges } from "./batch.ts";
import type { Change, PlaybackWorkflow } from "./entries.ts";
import { droppedLine } from "./messages.ts";
import type { Outbox, Outcome } from "./outbox.ts";
import { serial } from "./serial.ts";

/*
 * How a change to an item is shown and sent.
 *
 * `showChange` is the one rule for what a change looks like on an item. It builds the copy the page shows the moment a change is
 * made and the copy a reloaded list shows while the change still waits in the outbox, and it follows what PURSS will answer, change
 * by change: any change of the workflow, keeping or taking an item out of a basket, and reading progress is doing something with the
 * item, so its New marker goes; a change that changes nothing (the workflow it already has, a basket it is already in or not in)
 * leaves it. Undo restores the marker through PURSS's own token, which is why a copy put back after taking a change back is the copy
 * from before it.
 *
 * `createItemWriter` is every write the page makes to an item: it shows the change, keeps it on this device and sends it through the
 * outbox (or, for reading progress and opening, straight to PURSS one request at a time per item), and tells the person how it ended.
 */

/** A change as an item shows it. Reading progress shows like the others but is sent outside the outbox. */
export type Shown = Change | { kind: "progress"; itemId: string; progress: number };

/** The item with a new workflow, as PURSS will have it: its workflow revision a step on, the session that made it (null: the person), and no longer New. */
function withWorkflow<T extends ItemDTO>(item: T, workflow: WorkflowState, sessionId: string | null): T {
  return { ...item, workflow, workflowRevision: item.workflowRevision + 1, playbackWorkflowSessionId: sessionId, isNew: false };
}

/** The item as it looks with the change made, or the same object when the change is not about it or changes nothing. */
export function showChange<T extends ItemDTO>(item: T, change: Shown): T {
  switch (change.kind) {
    case "workflow":
      return change.itemId === item.id && item.workflow !== change.to ? withWorkflow(item, change.to, change.playback?.sessionId ?? null) : item;
    case "undoWorkflow":
      return change.itemId === item.id && item.workflow === change.applied && item.workflow !== change.restore ? withWorkflow(item, change.restore, null) : item;
    case "keep": {
      if (change.itemId !== item.id || item.basketIds.includes(change.basketId) === change.on) return item;
      const basketIds = change.on ? [...item.basketIds, change.basketId] : item.basketIds.filter((b) => b !== change.basketId);
      return { ...item, basketIds, isNew: false };
    }
    case "clearNew":
      return change.itemIds.includes(item.id) && item.isNew ? { ...item, isNew: false } : item;
    case "progress":
      return change.itemId === item.id ? { ...item, progress: change.progress, isNew: false } : item;
  }
}

/** Show the changes still waiting in the outbox on an item, in the order they were made. */
export function overlayItem<T extends ItemDTO>(item: T, changes: readonly Shown[]): T {
  let out = item;
  for (const change of changes) out = showChange(out, change);
  return out;
}

/** What an ignored item was before, so Restore can put it back (kept for this visit only, across writers). */
const previousWorkflow = new Map<string, WorkflowState>();

/** The page's copies of items, and the reading again that follows a change. */
export type ItemCache = {
  /** The latest copy of an item the page holds, wherever it is loaded. */
  find(itemId: string): ItemDTO | undefined;
  /** Show a copy wherever the item is held; a copy older than the one held is ignored. */
  put(item: ItemDTO): void;
  /** Take an item off a basket's page at once. */
  dropFromBasket(basketId: string, itemId: string): void;
  /** PURSS refused a change, or the item moved past it: read the item and every list again. */
  readAgain(itemId: string): void;
  /** Read the item itself again. */
  readItemAgain(itemId: string): void;
  /** Read the lists again, as the items they show may have changed. */
  readListsAgain(): void;
  /** A change went through: the counts and the lists are out of date, and are read again once changes stop. */
  listsStale(): void;
  /** An item's New marker went: the sidebar's counts and Home's follow at once. */
  newCleared(): void;
  /** Read everything that shows items or counts again. */
  readEverythingAgain(): void;
};

/** The requests an item's writes make outside the outbox; each rejects with the API client's error. */
export type StateRequests = {
  /** Reading progress or the first opening, against the revision the page has. */
  state(itemId: string, body: StateWrite & { expectedRevision: number }): Promise<Written>;
  undo(undoToken: string): Promise<void>;
  /** Clear every New marker in a scope. */
  clearNew(scope: string): Promise<{ changed: number; undoToken: string | null }>;
};

export type StateWrite = { progress: number } | { opened: true };
export type Written = { item: ItemDTO; undoToken: string };

/** A message, with Undo when it can be taken back. */
export type Say = (message: string, opts?: { undoToken?: string | null; undo?: () => Promise<void> | void; tone?: "error" }) => void;

export type WriterDeps = {
  cache: ItemCache;
  outbox: Pick<Outbox, "submit" | "submitMany" | "cancel" | "noteOwnWrite">;
  requests: StateRequests;
  say: Say;
  /** The plain message for anything thrown. */
  messageOf(err: unknown): string;
  /** A basket's name, or undefined when the page does not know it. */
  basketName(basketId: string): string | undefined;
  /** The signed-in account's reading progress that could not be sent yet; null when nobody is signed in. */
  unsentProgress(): LateStore<number> | null;
  /** The item panel's "Marked as seen" line. */
  seen: Pick<SeenStore, "begin" | "publish" | "clear">;
  /** Whether the browser says it has a connection. */
  online?: () => boolean;
};

/**
 * One request that changes an item outside the outbox (opening it, reading progress), run after the page's other writes to the item,
 * on the revision `revision` gives when it is its turn. Waiting workflow changes made against that revision move to the one it
 * produces, so they are not refused for a write the page made itself.
 */
export function writeState(deps: Pick<WriterDeps, "outbox" | "requests">, itemId: string, write: StateWrite, revision: () => number): Promise<Written> {
  return serial(itemId, async () => {
    const expectedRevision = revision();
    const res = await deps.requests.state(itemId, { ...write, expectedRevision });
    deps.outbox.noteOwnWrite(itemId, expectedRevision, res.item.revision);
    return res;
  });
}

type Sent = Extract<Outcome, { status: "sent" }>;
type Deferred = Extract<Outcome, { status: "deferred" }>;
type Dropped = Extract<Outcome, { status: "dropped" }>;

/** All item-changing writes, each with an Undo message. Conflicts read the item again and say so. */
export function createItemWriter(deps: WriterDeps) {
  const { cache, outbox, say } = deps;
  const t = app.state.actions;
  const online = deps.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const found = (ids: readonly string[]) => ids.map((id) => cache.find(id)).filter((it): it is ItemDTO => !!it);
  const isConflict = (err: unknown) => (err as { code?: unknown } | null)?.code === "conflict";

  function fail(err: unknown, itemId?: string): void {
    if (isConflict(err) && itemId) cache.readAgain(itemId);
    say(deps.messageOf(err), { tone: "error" });
  }

  /** PURSS clears an item's New marker when it is opened or anything is done with it: when it did, the counts follow at once instead of at the next event. */
  function followNewMarker(before: ItemDTO, after: ItemDTO): void {
    if (newMarkerCleared(before, after)) cache.newCleared();
  }

  /** The item as it was before a change that did not happen, with PURSS's word for it read again. */
  function putBack(before: ItemDTO): void {
    cache.put(before);
    cache.readAgain(before.id);
  }

  /** Send one change through the outbox and act on how it ended. */
  async function through<R>(change: Change, on: { thrown(err: unknown): R; sent(out: Sent): R; deferred(out: Deferred): R; dropped(out: Dropped): R }): Promise<R> {
    let out: Outcome;
    try {
      out = await outbox.submit(change);
    } catch (err) { return on.thrown(err); }
    return out.status === "sent" ? on.sent(out) : out.status === "deferred" ? on.deferred(out) : on.dropped(out);
  }

  /**
   * Shows the change at once, keeps it on this device and sends it. Resolves with how it ended: confirmed (Undo with PURSS's
   * token), kept for later (Undo takes it back), or refused (shown as it was, with the reason).
   */
  async function changeWorkflow(id: string, workflow: WorkflowState, how: "set" | "restore", revision?: number): Promise<void> {
    const before = cache.find(id);
    if (!before) return;
    const label = workflowLabel(workflow, before.kind);
    if (how === "set" && before.workflow === workflow) { say(t.already(label)); return; }
    if (how === "set" && workflow === "ignored") previousWorkflow.set(id, before.workflow);
    const message = how === "restore" ? t.restoredTo(label) : workflow === "ignored" ? app.words.ignored : t.marked(label);
    const change: Change = { kind: "workflow", itemId: id, from: before.workflow, to: workflow, revision: revision ?? before.revision };
    cache.put(showChange(before, change));
    await through(change, {
      thrown: (err) => { cache.put(before); fail(err, id); },
      sent: (out) => {
        const r = out.result;
        if (r.kind !== "workflow") return;
        if (r.item) { cache.put(r.item); followNewMarker(before, r.item); }
        cache.listsStale();
        say(message, { undoToken: r.undoToken });
      },
      deferred: (out) => say(t.withNote(message, t.notSent), { undo: () => takeBack(out.entry.id, change, () => cache.put(before), (revision) => changeWorkflow(id, before.workflow, "set", revision)) }),
      dropped: (out) => { putBack(before); say(out.message, { tone: "error" }); },
    });
  }

  /**
   * Undo for a change that has not been confirmed. One that never left is taken out of the outbox. One that may have
   * reached PURSS (another tab sent it, or its answer was lost) is taken out too and the opposite change is sent,
   * on the item's current revision when that could be read.
   */
  async function takeBack(entryId: string, change: Change, showAgain: () => void, inverse: (revision?: number) => Promise<void>): Promise<void> {
    const r = await outbox.cancel(entryId, change);
    if (r.status === "away") return; // another account is signed in now: nothing of this one to show or send
    if (r.status === "cancelled" || r.status === "pending") { showAgain(); cache.listsStale(); return; } // pending: the Undo is kept and goes out with the connection
    await inverse(r.revision);
  }

  /** The change that undoes `change`, for one that may have reached PURSS; null for a change that has none. */
  function inverseOf(change: Change, revision?: number): Change | null {
    if (change.kind === "workflow") return { kind: "workflow", itemId: change.itemId, from: change.to, to: change.from, revision: revision ?? change.revision };
    if (change.kind === "keep") return { ...change, on: !change.on };
    return null;
  }

  /**
   * Several changes at once through the outbox: shown at once, each kept on this device with the revision it was made
   * against, sent in order. One message tells how they ended; Undo reaches the ones that went through (by PURSS's
   * tokens) and the ones still waiting (by taking them back, or sending the opposite change). `before` holds the items as they were.
   */
  async function sendMany(changes: Change[], before: ReadonlyMap<string, ItemDTO>, describe: (items: number) => string): Promise<void> {
    const revert = (c: Change) => { const it = c.kind === "clearNew" ? undefined : before.get(c.itemId); if (it) cache.put(it); };
    let outs: Outcome[];
    try { outs = await outbox.submitMany(changes); } catch (err) { changes.forEach(revert); fail(err); return; }
    for (const o of outs) {
      if (o.status !== "sent") continue;
      const r = o.result;
      if (r.kind === "workflow" && r.item) cache.put(r.item);
      else if (r.kind === "keep") cache.put(r.item);
    }
    const sum = summariseBatch(changes, outs);
    sum.dropped.forEach((d) => revert(d.change));
    cache.readEverythingAgain();
    const refused = sum.dropped.length ? droppedLine(sum.dropped) : "";
    if (!sum.items) { say(refused, { tone: "error" }); return; }
    const message = [sum.waiting.length ? t.withNote(describe(sum.items), t.notSent) : describe(sum.items), refused].filter(Boolean).join(" ");
    if (!sum.tokens.length && !sum.waiting.length) { say(message); return; }
    say(message, {
      undo: async () => {
        for (const token of sum.tokens.slice().reverse()) await deps.requests.undo(token);
        const opposite: Change[] = [];
        for (const w of sum.waiting) {
          const r = await outbox.cancel(w.entryId, w.change);
          if (r.status === "away") continue;
          if (r.status === "cancelled" || r.status === "pending") revert(w.change);
          else { const inv = inverseOf(w.change, r.revision); if (inv) opposite.push(inv); }
        }
        if (opposite.length) await outbox.submitMany(opposite).catch(() => undefined);
        cache.readEverythingAgain();
      },
    });
  }

  async function setWorkflow(ids: string[], workflow: WorkflowState): Promise<void> {
    ids.forEach(noteManualWorkflowChange);
    if (ids.length === 1) { await changeWorkflow(ids[0]!, workflow, "set"); return; }
    const label = workflowLabel(workflow);
    const items = found(ids);
    const changes = workflowChanges(items, workflow);
    if (!changes.length) { say(t.already(label)); return; }
    const before = new Map(items.map((it) => [it.id, it] as const));
    for (const c of changes) {
      const it = before.get(c.itemId)!;
      if (workflow === "ignored") previousWorkflow.set(it.id, it.workflow);
      cache.put(showChange(it, c));
    }
    const verb = workflow === "ignored" ? app.words.ignored : t.marked(label);
    await sendMany(changes, before, (n) => t.markedFor(verb, plural(n, app.words.item)));
  }

  async function restore(id: string): Promise<void> {
    noteManualWorkflowChange(id);
    const prev = previousWorkflow.get(id);
    await changeWorkflow(id, prev && prev !== "ignored" ? prev : "undecided", "restore");
  }

  /**
   * The player moving an item forward by itself (In progress, Finished): shown at once, kept on this device and sent like any
   * state change, but without a message or an Undo, and without a message when it was kept for later and sent afterwards (see
   * OutboxController). It is checked against the workflow revision, so a state set by hand, here or on another device, is never
   * overridden. `applied` is false when it was not made, and the player then makes no further changes to the item.
   */
  async function setPlaybackWorkflow(id: string, from: WorkflowState, to: "inprogress" | "finished", playback: PlaybackWorkflow): Promise<{ applied: boolean; workflowRevision: number }> {
    const notApplied = { applied: false, workflowRevision: playback.expectedWorkflowRevision };
    const before = cache.find(id);
    if (!before || before.workflow !== from || before.workflowRevision !== playback.expectedWorkflowRevision) return notApplied;
    const change: Change = { kind: "workflow", itemId: id, from, to, revision: before.revision, playback };
    cache.put(showChange(before, change));
    return through(change, {
      thrown: () => { putBack(before); return notApplied; },
      sent: (out) => {
        const r = out.result;
        if (r.kind !== "workflow") { putBack(before); return notApplied; }
        if (r.item) { cache.put(r.item); followNewMarker(before, r.item); }
        cache.listsStale();
        return { applied: true, workflowRevision: r.item?.workflowRevision ?? playback.expectedWorkflowRevision + 1 };
      },
      deferred: () => ({ applied: true, workflowRevision: playback.expectedWorkflowRevision + 1 }),
      dropped: () => { putBack(before); return notApplied; },
    });
  }

  async function keep(id: string, basketId: string, on: boolean): Promise<void> {
    const name = deps.basketName(basketId);
    const before = cache.find(id);
    if (!before || name === undefined) return;
    const change: Change = { kind: "keep", itemId: id, basketId, on };
    cache.put(showChange(before, change));
    // A removed item leaves that basket's page at once; Undo reads the lists again and brings it back.
    if (!on) cache.dropFromBasket(basketId, id);
    const message = t.keep(on, isolate(name));
    const putBackOnPage = () => { cache.put(before); if (!on) cache.readListsAgain(); };
    await through(change, {
      thrown: (err) => { putBackOnPage(); fail(err, id); },
      sent: (out) => {
        const r = out.result;
        if (r.kind !== "keep") return;
        cache.put(r.item);
        followNewMarker(before, r.item);
        cache.readItemAgain(id);
        cache.listsStale();
        say(on && r.captureNote ? t.withNote(message, r.captureNote) : message, { undoToken: r.undoToken });
      },
      deferred: (out) => say(t.withNote(message, t.notSent), { undo: () => takeBack(out.entry.id, change, putBackOnPage, () => keep(id, basketId, !on)) }),
      dropped: (out) => { putBack(before); say(out.message, { tone: "error" }); },
    });
  }

  async function keepMany(ids: string[], basketIds: string[]): Promise<void> {
    const items = found(ids);
    const changes = keepChanges(items, ids, basketIds);
    if (!changes.length) { say(t.alreadyKept); return; }
    const before = new Map(items.map((it) => [it.id, it] as const));
    const byItem = new Map<string, Change[]>();
    for (const c of changes) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c]);
    for (const it of items) {
      const shown = overlayItem(it, byItem.get(it.id) ?? []);
      if (shown !== it) cache.put(shown);
    }
    const names = basketIds.map((b) => deps.basketName(b)).filter((n): n is string => !!n);
    const where = names.length === 1 ? isolate(names[0]!) : plural(names.length, app.words.basketLower);
    await sendMany(changes, before, (n) => t.keptIn(plural(n, app.words.item), where));
  }

  /**
   * Every New marker in a scope (Mark all as seen). It stays online-only: sent later it would clear items that
   * arrived since, which the person never saw. Offline, it says so instead of failing without a word.
   */
  async function clearNew(scope: string): Promise<void> {
    const needsConnection = () => say(t.needsConnection, { tone: "error" });
    if (!online()) { needsConnection(); return; }
    try {
      const out = await deps.requests.clearNew(scope);
      cache.readEverythingAgain();
      if (!out.changed || !out.undoToken) { say(t.nothingNew); return; }
      say(t.markedSeen(plural(out.changed, app.words.item)), { undoToken: out.undoToken });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "offline") needsConnection(); else fail(err);
    }
  }

  async function clearNewFor(ids: string[]): Promise<void> {
    const change: Change = { kind: "clearNew", itemIds: ids };
    const before = found(ids);
    for (const it of before) { const shown = showChange(it, change); if (shown !== it) cache.put(shown); }
    await through(change, {
      thrown: (err) => { before.forEach((it) => cache.put(it)); fail(err); },
      sent: (out) => {
        const r = out.result;
        if (r.kind !== "clearNew") return;
        cache.readEverythingAgain();
        if (!r.changed || !r.undoToken) { say(t.notMarkedNew(ids.length === 1)); return; }
        say(t.markedSeen(plural(r.changed, app.words.item)), { undoToken: r.undoToken });
      },
      deferred: () => say(t.markedSeenLater),
      dropped: (out) => { before.forEach((it) => cache.put(it)); cache.readEverythingAgain(); say(out.message, { tone: "error" }); },
    });
  }

  /** Opening an item records that it was opened and clears its New marker; the item panel then offers "Marked as seen" with Undo. */
  function markOpened(id: string): Promise<void> {
    return openItem(id, {
      find: cache.find,
      put: cache.put,
      write: () => writeState(deps, id, { opened: true }, () => {
        const cur = cache.find(id);
        if (!cur) throw new Error("The item is not loaded");
        return cur.revision;
      }),
      newCleared: followNewMarker,
      seen: deps.seen,
      conflict: cache.readItemAgain,
    });
  }

  /** The panel's Undo for "Marked as seen". */
  function undoSeenMarker(notice: SeenNotice): Promise<void> {
    return undoSeen(notice, {
      find: cache.find,
      put: cache.put,
      undo: (undoToken) => deps.requests.undo(undoToken),
      seen: deps.seen,
      refresh: cache.readEverythingAgain,
      fail: (err) => say(deps.messageOf(err), { tone: "error" }),
    });
  }

  /**
   * Reading progress (how far you scrolled), kept separately from workflow; it only ever grows. Silent. Without a
   * connection it is kept on this device and sent when the connection is back (state/late-progress.ts).
   */
  async function saveProgress(id: string, progress: number): Promise<void> {
    const before = cache.find(id);
    const value = Math.round(Math.min(1, Math.max(0, progress)) * 100) / 100;
    if (!before || value <= before.progress) return;
    cache.put(showChange(before, { kind: "progress", itemId: id, progress: value }));
    try {
      const out = await writeState(deps, id, { progress: value }, () => (cache.find(id) ?? before).revision);
      cache.put(out.item);
      followNewMarker(before, out.item);
      const unsent = deps.unsentProgress();
      if (unsent) settleProgress(unsent, id, value);
    } catch (err) {
      if (isConflict(err)) cache.readItemAgain(id);
      else {
        const waiting = worthRetrying(err) ? deps.unsentProgress() : null;
        if (waiting && (waiting.all()[id] ?? -1) < value) waiting.put(id, value);
      }
    }
  }

  return { setWorkflow, restore, setPlaybackWorkflow, keep, keepMany, clearNew, clearNewFor, markOpened, undoSeenMarker, saveProgress };
}
