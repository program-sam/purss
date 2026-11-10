import type { ItemDTO, WorkflowState } from "@purss/domain";
import { asFailure, backoffSeconds, classify, itemIdsOf, judgeConflict, notChangedMessage, overlayItem, removedFromBasket, scopeOf } from "./entries.ts";
import type { Change, Entry } from "./entries.ts";

/** Where entries are kept between visits, filed by scope (installation and account). */
export type Store = {
  load(scope: string): Promise<Entry[]>;
  put(entry: Entry): Promise<void>;
  remove(id: string): Promise<void>;
};

/** What PURSS holds about an item when a conflict is checked. */
export type ServerWorkflow = { workflow: WorkflowState; revision: number };

/** The requests the outbox makes; each throws the API client's error when PURSS does not answer or refuses. */
export type Sender = {
  workflow(itemId: string, workflow: WorkflowState, expectedRevision: number): Promise<{ item: ItemDTO; undoToken: string }>;
  keep(itemId: string, basketId: string, on: boolean): Promise<{ item: ItemDTO; undoToken: string; captureNote: string | null }>;
  clearFresh(itemIds: string[]): Promise<{ changed: number; undoToken: string | null }>;
  /** PURSS's current workflow and revision for an item. */
  workflowOf(itemId: string): Promise<ServerWorkflow>;
};

export type Result =
  /** `item` and `undoToken` are null when PURSS already had the workflow this change wanted. */
  | { kind: "workflow"; item: ItemDTO | null; undoToken: string | null }
  | { kind: "keep"; item: ItemDTO; undoToken: string; captureNote: string | null }
  | { kind: "clearFresh"; changed: number; undoToken: string | null }
  /** `item` is null when the item no longer had the workflow to put back: nothing was done, and nothing needs saying. */
  | { kind: "undoWorkflow"; item: ItemDTO | null };

/**
 * `late` is false while the person who made the change is still waiting for its first answer, and
 * true once they were told it was kept for later (or when it was found on this device after a reload).
 */
export type Outcome =
  | { status: "sent"; entry: Entry; result: Result; late: boolean }
  | { status: "dropped"; entry: Entry; reason: "conflict" | "rejected"; message: string; late: boolean }
  | { status: "deferred"; entry: Entry };

/**
 * How taking a change back ended. `cancelled`: it never left, and is gone. `undo`: it may have reached PURSS (another
 * tab sent it, or a send was started and its answer lost), so it is gone from the queue and the caller must send the opposite
 * change; `revision` is the item's current revision when it could be read. `pending`: the item could not be read (no connection),
 * so the Undo was kept as a change of its own (`undoWorkflow`) that reads the item when it is sent; the caller shows the restored
 * state meanwhile. `away`: the account that made the change is not the signed-in one any more (signed out, or another account
 * signed in) before the Undo could be settled, so nothing was done for the caller to show or follow up; if the Undo had to be
 * kept it stays filed under its own account.
 */
export type Cancelled = { status: "cancelled" } | { status: "undo"; revision?: number } | { status: "pending" } | { status: "away" };

export type Deps = {
  store: Store;
  sender: Sender;
  /** The installation this page belongs to (its origin). Entries of another installation are never touched. */
  installation?: string;
  now?: () => number;
  /** Run `fn` after `ms` milliseconds; returns a function that cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Run one item's requests one after another with the page's other writes to it. */
  serialize?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /** Only one tab sends at a time: run `fn` if this tab may, return false when another tab is sending. */
  exclusive?: (fn: () => Promise<void>) => Promise<boolean>;
  /** Whether the browser says it has a connection. A request made without one cannot have reached PURSS. */
  online?: () => boolean;
  /** The same lock, waited for: run `fn` once no tab (this one included) is sending. */
  locked?: <T>(fn: () => Promise<T>) => Promise<T>;
  newId?: () => string;
};

/** A store that does not answer must not hold the page up: after this long the page carries on without it. */
const STORE_WAIT_MS = 2_000;
const RECHECK_MS = 15_000;
/** An Undo that is refused because the item moved between its read and its write reads it again, this many times at most. */
const WORKFLOW_ROUNDS = 3;
const BUSY_RECHECK_MS = 5_000;

/**
 * The write outbox. A change is kept (on disk, through the store) before anything is sent, sent in the
 * order it was made, and removed only when PURSS confirmed it or refused it for good. It is
 * sent again after a lost connection, a closed tab or a reload.
 *
 * The queue belongs to one installation and one account. When the signed-in account changes it is set aside
 * untouched on disk, and the new account's own entries are loaded; nothing crosses over.
 */
export class Outbox {
  private readonly store: Store;
  private readonly sender: Sender;
  private readonly installation: string;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly serialize: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  private readonly exclusive: (fn: () => Promise<void>) => Promise<boolean>;
  private readonly locked: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly online: () => boolean;
  private readonly newId: () => string;

  /** The signed-in account's entries only. */
  private mem: Entry[] = [];
  private account: string | null = null;
  private scope: string | null = null;
  private loading: Promise<void> = Promise.resolve();
  private seq = 0;
  private puts = 0;
  private sending: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped: "signed-out" | null = null;
  private cancelRetry: (() => void) | null = null;
  private readonly callers = new Map<string, (o: Outcome) => void>();
  private readonly told = new Set<string>();
  /** Entries taken back or confirmed during this visit: a slow store must not bring them back. */
  private readonly gone = new Set<string>();
  private readonly views = new Set<() => void>();
  private readonly listeners = new Set<(o: Outcome) => void>();
  private ids: ReadonlySet<string> = new Set();
  private shown: readonly Entry[] = [];

  constructor(deps: Deps) {
    this.store = deps.store;
    this.sender = deps.sender;
    this.installation = deps.installation ?? (typeof location !== "undefined" ? location.origin : "local");
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.serialize = deps.serialize ?? ((_key, fn) => fn());
    this.exclusive = deps.exclusive ?? (async (fn) => { await fn(); return true; });
    this.locked = deps.locked ?? ((fn) => fn());
    this.online = deps.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
    this.newId = deps.newId ?? (() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`));
  }

  /** Resolves when the signed-in account's entries have been read from this device. */
  get ready(): Promise<void> { return this.loading; }

  // ---------- what the page shows ----------

  /** Entries of the signed-in account, in the order they will be sent. */
  entries(): readonly Entry[] { return this.shown; }
  /** Ids of the items with a change not yet confirmed. The same object until something changes. */
  pendingItemIds(): ReadonlySet<string> { return this.ids; }
  pendingCount(): number { return this.shown.length; }
  /** Whether the session ended with changes still waiting. */
  needsSignIn(): boolean { return this.stopped === "signed-out" && this.shown.length > 0; }

  subscribe(fn: () => void): () => void { this.views.add(fn); return () => this.views.delete(fn); }
  onOutcome(fn: (o: Outcome) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  overlay<T extends ItemDTO>(items: readonly T[]): T[] {
    if (!this.shown.length) return items as T[];
    return items.map((it) => (this.ids.has(it.id) ? overlayItem(it, this.shown) : it));
  }
  removedFromBasket(basketId: string): Set<string> { return removedFromBasket(this.shown, basketId); }

  private changed(): void {
    this.shown = this.mem;
    this.ids = itemIdsOf(this.mem);
    this.views.forEach((fn) => fn());
  }

  // ---------- who it belongs to ----------

  /**
   * Whose changes these are. A different account (or none) sets the previous account's queue aside, untouched, and
   * reads the new account's own entries from this device; sending resumes for that account only.
   */
  setAccount(accountId: string | null): void {
    if (accountId === this.account) return;
    this.account = accountId;
    this.scope = accountId ? scopeOf(this.installation, accountId) : null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.stopped = null;
    for (const e of this.mem) this.defer(e); // whoever was still waiting for an answer is told it is kept for later
    this.mem = [];
    this.callers.clear();
    this.told.clear();
    this.changed();
    const scope = this.scope;
    this.loading = scope ? this.load(scope) : Promise.resolve();
    if (scope) void this.loading.then(() => { if (this.scope === scope) void this.drain(); });
  }

  private async loadStore(scope: string): Promise<Entry[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The store did not answer")), STORE_WAIT_MS); });
    try { return await Promise.race([this.store.load(scope), wait]); } finally { clearTimeout(timer); }
  }

  private async load(scope: string): Promise<void> {
    let found: Entry[] = [];
    try { found = (await this.loadStore(scope)).sort((a, b) => a.seq - b.seq); } catch { /* carry on with an empty queue */ }
    if (this.scope !== scope) return; // the account changed while reading
    this.mem = found;
    for (const e of found) { this.told.add(e.id); this.seq = Math.max(this.seq, e.seq); }
    this.changed();
  }

  /** Read the account's entries again (another tab may have added or sent some). */
  private async refresh(scope: string): Promise<void> {
    if (this.puts > 0 || this.sending) return;
    try {
      const stored = (await this.loadStore(scope)).filter((e) => !this.gone.has(e.id)).sort((a, b) => a.seq - b.seq);
      if (this.puts > 0 || this.scope !== scope) return;
      const keepLocal = this.mem.filter((e) => !stored.some((s) => s.id === e.id) && this.callers.has(e.id));
      this.mem = [...stored, ...keepLocal].sort((a, b) => a.seq - b.seq);
      for (const e of this.mem) { if (!this.callers.has(e.id)) this.told.add(e.id); this.seq = Math.max(this.seq, e.seq); }
      this.changed();
    } catch { /* keep what the page has */ }
  }

  /**
   * Signing out: remove every change of the signed-in account that has not been confirmed, from memory and from
   * this device. Returns how many there were.
   */
  async discard(): Promise<number> {
    const doomed = this.mem;
    this.mem = [];
    for (const e of doomed) { this.gone.add(e.id); this.callers.delete(e.id); this.told.delete(e.id); }
    this.changed();
    await Promise.all(doomed.map((e) => this.store.remove(e.id).catch(() => undefined)));
    return doomed.length;
  }

  // ---------- making changes ----------

  /** Keep a change and start sending it. Resolves at its first answer: sent, refused, or kept for later. */
  async submit(change: Change): Promise<Outcome> {
    return (await this.submitMany([change]))[0]!;
  }

  /** Keep several changes at once (they are sent in this order) and start sending. One answer for each, in the same order. */
  async submitMany(changes: readonly Change[]): Promise<Outcome[]> {
    await this.loading;
    const accountId = this.account;
    if (!accountId) throw new Error("Not signed in");
    const entries: Entry[] = changes.map((change) => {
      this.seq = Math.max(this.seq + 1, this.now());
      return { ...change, id: this.newId(), installation: this.installation, accountId, seq: this.seq, createdAt: new Date(this.now()).toISOString(), attempts: 0, notBefore: 0 };
    });
    const answers = entries.map((entry) => new Promise<Outcome>((resolve) => this.callers.set(entry.id, resolve)));
    this.puts++;
    try { await Promise.all(entries.map((entry) => this.store.put(entry).catch(() => undefined))); } finally { this.puts--; } // storage refused: still sent from memory, just not kept across a reload
    if (this.account !== accountId) return Promise.all(answers); // signed out or switched while saving: they stay filed under their own account
    this.mem.push(...entries);
    this.changed();
    // If this pass could not get to one (the connection is down, or an earlier change of the item is waiting), say so.
    void this.drain().then(() => entries.forEach((entry) => this.defer(entry)));
    return Promise.all(answers);
  }

  /**
   * Take a change back (Undo before it was confirmed). The send lock is waited for, so no tab is sending while this decides.
   * A change that never left is removed: `cancelled`. One that may have reached PURSS (another tab sent it and took it
   * off the queue, or a send was started and its answer lost) is `undo`: the caller sends the opposite change. For a workflow
   * change the item is read first, even when the entry is already gone: if it does not have the target workflow the change
   * never took effect (`cancelled`), and if it does, `revision` is the one to send the opposite change on. If the item cannot be
   * read (no connection), the Undo itself is kept as a change of its own (`pending`): sent later, it reads the item first.
   * `change` is the change as the caller made it, for when the queue no longer holds it.
   *
   * Everything here is for the account that was signed in when the Undo was pressed. The send lock, the store and the read all
   * take time, so the account is checked after each: once it is not the signed-in one, the answer is `away`, the item is not read
   * with the other account's session, and nothing is added to the other account's queue.
   */
  async cancel(entryId: string, change?: Change): Promise<Cancelled> {
    const scope = this.scope;
    const accountId = this.account;
    if (!scope || !accountId) return { status: "away" };
    const away = { status: "away" } as const;
    return this.locked(async (): Promise<Cancelled> => {
      await this.settled();
      await this.refresh(scope);
      if (this.scope !== scope) return away;
      const entry = this.mem.find((e) => e.id === entryId);
      if (entry) {
        await this.discardOne(entry);
        if (this.scope !== scope) return away; // the account changed while it came off the disk: nothing for the caller to roll back
        if (!entry.tried) return { status: "cancelled" };
      }
      const original = entry ?? change;
      if (original?.kind !== "workflow") return { status: "undo" };
      try {
        const server = await this.sender.workflowOf(original.itemId);
        if (this.scope !== scope) return away; // the answer came under another session
        return server.workflow === original.to ? { status: "undo", revision: server.revision } : { status: "cancelled" };
      } catch {
        // Cannot tell whether it took effect, and the revision to undo on is unknown: the Undo is kept, as a change of its own.
        const kept = await this.keep({ kind: "undoWorkflow", itemId: original.itemId, applied: original.to, restore: original.from }, accountId, scope);
        return kept ? { status: "pending" } : away;
      }
    }).then((result) => { if (result.status === "pending") void this.drain(); return result; });
  }

  /**
   * Keep one more change on disk, under the account that made it, without sending it yet (the caller holds the send lock). It
   * joins the queue in memory only while that account is still the signed-in one; otherwise it stays on disk for its own account
   * and nothing is added to whoever is signed in now. Returns whether it joined the queue.
   */
  private async keep(change: Change, accountId: string, scope: string): Promise<boolean> {
    this.seq = Math.max(this.seq + 1, this.now());
    const entry: Entry = { ...change, id: this.newId(), installation: this.installation, accountId, seq: this.seq, createdAt: new Date(this.now()).toISOString(), attempts: 0, notBefore: 0 };
    await this.store.put(entry).catch(() => undefined);
    if (this.scope !== scope) return false;
    this.mem.push(entry);
    this.told.add(entry.id);
    this.changed();
    return true;
  }

  private async discardOne(entry: Entry): Promise<void> {
    this.mem = this.mem.filter((e) => e.id !== entry.id);
    this.gone.add(entry.id);
    this.callers.delete(entry.id);
    this.told.delete(entry.id);
    this.changed();
    await this.store.remove(entry.id).catch(() => undefined);
  }

  /**
   * The page changed an item itself (opening it, reading progress), moving its revision from `from` to `to`. Waiting
   * workflow changes that were made against `from` are made against `to` now: nothing else touched the item between,
   * or that write would have been refused. The same goes for the changes queued behind a send of the outbox's own.
   */
  noteOwnWrite(itemId: string, from: number, to: number): void {
    if (to <= from) return;
    for (const e of this.mem) {
      if (e.kind === "workflow" && e.itemId === itemId && e.revision === from) {
        e.revision = to;
        void this.store.put(e).catch(() => undefined);
      }
    }
  }

  /**
   * A kept Undo wrote the item, leaving it at `revision`. What this client queued for the item after the Undo was made on the item
   * as the Undo left it, whatever revision the page had cached when it was made (a send whose answer was lost leaves the page
   * behind), so those changes are sent on `revision`. Changes queued before the Undo are not touched, and neither is anything
   * written elsewhere: the Undo read the item first, so a write from elsewhere has already stopped it from writing.
   */
  private rebaseAfter(undo: Entry & { kind: "undoWorkflow" }, revision: number): void {
    for (const e of this.mem) {
      if (e.kind === "workflow" && e.itemId === undo.itemId && e.seq > undo.seq && e.revision !== revision) {
        e.revision = revision;
        void this.store.put(e).catch(() => undefined);
      }
    }
  }

  // ---------- sending ----------

  /** Send what is waiting. Safe to call at any time; one pass runs at once, and a call made during a pass asks for one more. */
  drain(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        for (;;) {
          this.again = false;
          await this.loading;
          let stalled = false;
          const ran = await this.exclusive(async () => { stalled = (await this.pass()) === "stalled"; });
          if (!ran) { this.retryIn(BUSY_RECHECK_MS); break; }
          // No answer from PURSS, or nobody signed in: another pass now would only fail the same way.
          if (stalled || !this.again) break;
        }
      } finally { this.running = null; }
    })();
    return this.running;
  }

  /** Resolves when nothing is being sent (without asking for another pass). */
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }

  /** Send everything now, including changes that were waiting out a pause after a fault. */
  sendNow(): Promise<void> {
    for (const e of this.mem) e.notBefore = 0;
    this.resume();
    return this.running ?? Promise.resolve();
  }

  /** After signing in again, or when the connection is back. */
  resume(): void {
    this.stopped = null;
    this.views.forEach((fn) => fn());
    void this.drain();
  }

  private retryIn(ms: number): void {
    this.cancelRetry?.();
    this.cancelRetry = this.schedule(() => { this.cancelRetry = null; void this.drain(); }, ms);
  }

  private async pass(): Promise<"done" | "stalled"> {
    const scope = this.scope;
    if (!scope || this.stopped) return "stalled";
    await this.refresh(scope);
    const blocked = new Set<string>();
    let soonest = Infinity;
    for (const entry of [...this.mem].sort((a, b) => a.seq - b.seq)) {
      if (this.scope !== scope) return "done"; // the account changed: this queue is set aside
      if (!this.mem.includes(entry)) continue;
      const items = [...itemIdsOf([entry])];
      if (items.some((id) => blocked.has(id))) continue;
      if (entry.notBefore > this.now()) { items.forEach((id) => blocked.add(id)); soonest = Math.min(soonest, entry.notBefore); continue; }
      const out = await this.attempt(entry, scope);
      if (out === "connection") { this.retryIn(RECHECK_MS); return "stalled"; }
      if (out === "signed-out" || out === "away") return "stalled";
      if (out === "later") { items.forEach((id) => blocked.add(id)); soonest = Math.min(soonest, entry.notBefore); }
    }
    if (Number.isFinite(soonest)) this.retryIn(Math.max(1000, soonest - this.now()));
    return "done";
  }

  /** One attempt at one entry. Returns what the caller of the pass should do next. */
  private async attempt(entry: Entry, scope: string): Promise<"done" | "connection" | "signed-out" | "later" | "away"> {
    this.sending = entry.id;
    try {
      // Kept on disk before the request leaves: from here on the change may have reached PURSS, whatever comes back.
      if (!entry.tried && this.online()) { entry.tried = true; await this.store.put(entry).catch(() => undefined); }
      const result = await this.send(entry);
      if (this.scope !== scope) { await this.store.remove(entry.id).catch(() => undefined); return "away"; } // it went through; nobody here is waiting for it
      await this.finish(entry, { status: "sent", entry, result, late: this.told.has(entry.id) });
      return "done";
    } catch (err) {
      // Whatever the answer was, if the account changed meanwhile it was meant for the other account's session: leave the entry filed.
      if (this.scope !== scope) return "away";
      const failure = asFailure(err);
      const kind = classify(failure);
      if (kind === "connection") { this.defer(entry); return "connection"; }
      if (kind === "signed-out") { this.stopped = "signed-out"; this.defer(entry); this.views.forEach((fn) => fn()); return "signed-out"; }
      if (kind === "later") {
        entry.attempts += 1;
        entry.notBefore = this.now() + backoffSeconds(entry.attempts) * 1000;
        await this.store.put(entry).catch(() => undefined);
        this.defer(entry);
        return "later";
      }
      const reason = kind === "conflict" ? "conflict" : "rejected";
      await this.finish(entry, { status: "dropped", entry, reason, message: notChangedMessage(reason, failure.message), late: this.told.has(entry.id) });
      return "done";
    } finally { this.sending = null; }
  }

  /** Tell the person who is waiting that the change is kept for later; once. */
  private defer(entry: Entry): void {
    const resolve = this.callers.get(entry.id);
    if (!resolve) return;
    this.callers.delete(entry.id);
    this.told.add(entry.id);
    resolve({ status: "deferred", entry });
  }

  private async finish(entry: Entry, outcome: Exclude<Outcome, { status: "deferred" }>): Promise<void> {
    this.mem = this.mem.filter((e) => e.id !== entry.id);
    this.gone.add(entry.id);
    await this.store.remove(entry.id).catch(() => undefined);
    this.changed();
    const resolve = this.callers.get(entry.id);
    this.callers.delete(entry.id);
    this.told.delete(entry.id);
    this.listeners.forEach((fn) => fn(outcome));
    resolve?.(outcome);
  }

  private send(entry: Entry): Promise<Result> {
    switch (entry.kind) {
      case "keep":
        return this.serialize(entry.itemId, async () => {
          const out = await this.sender.keep(entry.itemId, entry.basketId, entry.on);
          return { kind: "keep", item: out.item, undoToken: out.undoToken, captureNote: out.captureNote } as const;
        });
      case "clearFresh":
        return this.sender.clearFresh(entry.itemIds).then((out) => ({ kind: "clearFresh", changed: out.changed, undoToken: out.undoToken }) as const);
      case "workflow":
        return this.serialize(entry.itemId, () => this.sendWorkflow(entry));
      case "undoWorkflow":
        return this.serialize(entry.itemId, () => this.sendUndoWorkflow(entry));
    }
  }

  /**
   * An Undo that could not be settled when it was pressed. The item is read: only if it still has the workflow that was applied is
   * it put back, on the revision just read; otherwise there is nothing to undo and nothing is said. When the write goes through,
   * the workflow changes this client queued after the Undo move on to the revision it produced (see `rebaseAfter`).
   */
  private async sendUndoWorkflow(entry: Entry & { kind: "undoWorkflow" }): Promise<Result> {
    for (let round = 0; round < WORKFLOW_ROUNDS; round++) {
      const server = await this.sender.workflowOf(entry.itemId);
      if (server.workflow !== entry.applied) return { kind: "undoWorkflow", item: null };
      try {
        const out = await this.sender.workflow(entry.itemId, entry.restore, server.revision);
        this.rebaseAfter(entry, out.item.revision);
        return { kind: "undoWorkflow", item: out.item };
      } catch (err) {
        if (classify(asFailure(err)) !== "conflict") throw err; // it moved between the read and the write: read again
      }
    }
    throw Object.assign(new Error("changed elsewhere"), { status: 409, code: "conflict", message: "" });
  }

  /**
   * Sent with the revision it was made against. If PURSS says the item moved on, the item is read once:
   * it already has the target workflow (the earlier send committed, only its answer was lost): done, silently.
   * Otherwise the change is dropped. The workflow the change started from is not compared (A to B to A elsewhere
   * would pass for unchanged), and no timestamps are used.
   */
  private async sendWorkflow(entry: Entry & { kind: "workflow" }): Promise<Result> {
    try {
      const out = await this.sender.workflow(entry.itemId, entry.to, entry.revision);
      this.noteOwnWrite(entry.itemId, entry.revision, out.item.revision);
      return { kind: "workflow", item: out.item, undoToken: out.undoToken };
    } catch (err) {
      if (classify(asFailure(err)) !== "conflict") throw err;
    }
    const server = await this.sender.workflowOf(entry.itemId);
    if (judgeConflict(entry, server) === "done") {
      this.noteOwnWrite(entry.itemId, entry.revision, server.revision);
      return { kind: "workflow", item: null, undoToken: null };
    }
    throw Object.assign(new Error("changed elsewhere"), { status: 409, code: "conflict", message: "" });
  }
}
