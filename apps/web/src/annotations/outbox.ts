import type { AnnotationDTO, AnnotationPut, AnnotationWriteResult } from "@purss/domain";

/**
 * The annotation outbox (plan/26): every highlight and note change is written here first and then
 * sent, so a change made offline (or while the connection drops) survives reloads and is sent, in
 * order, when the connection is back. Annotation-specific on purpose; nothing else is queued.
 *
 * A write carries the whole annotation and the time it was made, and the server keeps the latest
 * write per annotation, so only the newest change of each annotation needs sending: a new change
 * replaces any waiting one. Entries belong to an account. In the browser, another account's entries
 * are deleted when someone else signs in here, and all of them at sign-out. In the apps they stay until
 * that account connects again (and they are sent) or the person copies or discards them.
 */

/** A change as recorded: the whole annotation (put) or its removal, and when it was made on this device (also the write's time on the server). */
export type Change = { accountId: string; itemId: string; annotationId: string; at: string } & ({ op: "put"; body: AnnotationPut } | { op: "delete" });

export type OutboxEntry = Change & {
  /** Order of recording; assigned by the store. */
  seq?: number;
  /** "failed": the server refused it for good; it waits for the person to retry or discard it. */
  status: "waiting" | "failed";
  error?: string;
};

/** Persistence for the outbox. IndexedDB in the browser (outbox-store.ts); memory in tests. */
export interface OutboxStore {
  /** Every entry, oldest first. */
  all(): Promise<OutboxEntry[]>;
  /** Insert (no seq) or replace (seq) an entry; returns it with its seq. */
  save(entry: OutboxEntry): Promise<OutboxEntry>;
  remove(seqs: readonly number[]): Promise<void>;
}

export class MemoryOutboxStore implements OutboxStore {
  private rows = new Map<number, OutboxEntry>();
  private next = 1;
  async all(): Promise<OutboxEntry[]> { return [...this.rows.values()].sort((a, b) => a.seq! - b.seq!).map((e) => structuredClone(e)); }
  async save(entry: OutboxEntry): Promise<OutboxEntry> {
    const saved = { ...structuredClone(entry), seq: entry.seq ?? this.next++ };
    this.rows.set(saved.seq, saved);
    return structuredClone(saved);
  }
  async remove(seqs: readonly number[]): Promise<void> { for (const s of seqs) this.rows.delete(s); }
}

/** What sending one entry ended in. */
export type SendOutcome =
  | { kind: "done"; result: AnnotationWriteResult }
  /** Not now (offline, server busy, signed out): stop and try again later. */
  | { kind: "later" }
  /** Refused for good, with the plain-language reason. */
  | { kind: "refused"; message: string };
export type Send = (entry: OutboxEntry) => Promise<SendOutcome>;

export type SyncState = "synced" | "waiting" | "failed";
export type ViewAnnotation = AnnotationDTO & { sync: SyncState; error?: string };

/**
 * What the reader shows for one item: the server's annotations with this device's unsent changes
 * laid over them. A waiting removal hides the annotation; a waiting or failed change shows the new text.
 */
export function mergeView(server: readonly AnnotationDTO[], entries: readonly OutboxEntry[], itemId: string): ViewAnnotation[] {
  const byId = new Map<string, ViewAnnotation>(server.map((a) => [a.id, { ...a, sync: "synced" as const }]));
  const order = server.map((a) => a.id);
  for (const e of entries) {
    if (e.itemId !== itemId) continue;
    if (e.op === "delete") { byId.delete(e.annotationId); continue; }
    const before = byId.get(e.annotationId);
    const b = e.body;
    byId.set(e.annotationId, {
      id: e.annotationId, itemId, kind: b.kind,
      quote: b.kind === "highlight" ? { exact: b.quote.exact, prefix: b.quote.prefix ?? "", suffix: b.quote.suffix ?? "" } : null,
      position: b.kind === "highlight" ? b.position ?? null : null,
      target: b.kind === "highlight" ? b.target ?? null : null,
      body: b.body ?? null,
      createdAt: before?.createdAt ?? e.at, updatedAt: e.at,
      sync: e.status, ...(e.error ? { error: e.error } : {}),
    });
    if (!before) order.push(e.annotationId);
  }
  return order.flatMap((id) => byId.get(id) ?? []);
}

/** Entries of `accountId` only. */
export const ofAccount = (entries: readonly OutboxEntry[], accountId: string | null) => entries.filter((e) => e.accountId === accountId);

/** Unsent changes as plain text, so the person can keep their writing when it can't be sent. Removals carry no writing and are left out. */
export function outboxAsText(entries: readonly OutboxEntry[]): string {
  return entries.flatMap((e) => {
    if (e.op !== "put") return [];
    const b = e.body;
    const lines = [`${b.kind === "highlight" ? "Highlight" : "Note"} · ${e.at} · item ${e.itemId}`];
    if (b.kind === "highlight") lines.push(`> ${b.quote.exact.replace(/\n/g, "\n> ")}`);
    if (b.body) lines.push(b.body);
    return [lines.join("\n")];
  }).join("\n\n");
}

/**
 * The outbox for this device. Keeps a snapshot for the page to render, records changes (replacing any
 * unsent change of the same annotation) and sends them one at a time in the order they were recorded.
 */
export class Outbox {
  private entries: OutboxEntry[] = [];
  private loaded: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly store: OutboxStore;

  constructor(store: OutboxStore) {
    this.store = store;
  }

  /** The current entries (all accounts), oldest first. */
  snapshot(): readonly OutboxEntry[] { return this.entries; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Read what an earlier visit left. Safe to call more than once. */
  load(): Promise<void> {
    this.loaded ??= this.store.all().then((rows) => { this.entries = rows; this.changed(); }, () => { this.entries = []; });
    return this.loaded;
  }

  /** Changes run one after another, so a send never races a record of the same annotation. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Record a change. It replaces any unsent change of the same annotation (the newest write wins anyway). */
  record(entry: Change): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const stale = this.entries.filter((e) => e.accountId === entry.accountId && e.annotationId === entry.annotationId);
      const saved = await this.store.save({ ...entry, status: "waiting" });
      await this.store.remove(stale.map((e) => e.seq!));
      this.entries = [...this.entries.filter((e) => !stale.includes(e)), saved];
      this.changed();
    });
  }

  private flushing: Promise<void> | null = null;
  private flushAgain = false;

  /**
   * Send the account's waiting entries in order, one at a time. Stops at the first one that has to
   * wait (offline, server busy); a refused one is marked failed and the rest continue. `applied` hears
   * each result. Changes recorded meanwhile are not held up by the network: a change that replaces
   * the one being sent is sent next. A flush asked for while one runs runs again after it.
   */
  flush(accountId: string, send: Send, applied: (entry: OutboxEntry, result: AnnotationWriteResult) => void): Promise<void> {
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.load();
          const tried = new Set<number>();
          for (;;) {
            const entry = ofAccount(this.entries, accountId).find((e) => e.status === "waiting" && !tried.has(e.seq!));
            if (!entry) break;
            tried.add(entry.seq!);
            const outcome = await send(entry);
            if (outcome.kind === "later") return;
            await this.serial(async () => {
              const still = this.entries.some((e) => e.seq === entry.seq);
              if (outcome.kind === "done" || entry.op === "delete") {
                // Sent, or a removal the server refused, which leaves nothing of the person's to keep.
                if (still) await this.store.remove([entry.seq!]);
                this.entries = this.entries.filter((e) => e.seq !== entry.seq);
              } else if (still) {
                const failed = await this.store.save({ ...entry, status: "failed", error: outcome.message });
                this.entries = this.entries.map((e) => (e.seq === entry.seq ? failed : e));
              }
              if (outcome.kind === "done") applied(entry, outcome.result);
              this.changed();
            });
          }
        } while (this.flushAgain);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** Try a failed change again. */
  retry(seq: number): Promise<void> {
    return this.serial(async () => {
      const entry = this.entries.find((e) => e.seq === seq);
      if (!entry) return;
      const { error: _error, ...rest } = entry;
      const again = await this.store.save({ ...rest, status: "waiting" } as OutboxEntry);
      this.entries = this.entries.map((e) => (e.seq === seq ? again : e));
      this.changed();
    });
  }

  /** Drop one change without sending it. */
  discard(seq: number): Promise<void> {
    return this.serial(async () => {
      await this.store.remove([seq]);
      this.entries = this.entries.filter((e) => e.seq !== seq);
      this.changed();
    });
  }

  /** Delete every entry except the given account's (all of them for null): account change and sign-out. */
  clearExcept(accountId: string | null): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const gone = this.entries.filter((e) => e.accountId !== accountId);
      if (!gone.length) return;
      await this.store.remove(gone.map((e) => e.seq!));
      this.entries = this.entries.filter((e) => e.accountId === accountId);
      this.changed();
    });
  }
}
