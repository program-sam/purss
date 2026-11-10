import { MemoryOutboxStore, Outbox } from "./outbox.ts";
import type { OutboxEntry, OutboxStore } from "./outbox.ts";

/**
 * The outbox's place on this device: an IndexedDB database of its own, so unsent highlights and notes
 * survive reloads and restarts. Where IndexedDB isn't available (some private modes) the outbox lives
 * in memory for this visit only.
 */
const DB_NAME = "purss-annotations";
const STORE = "outbox";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.open();
    const t = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
    const out = await work(t.objectStore(STORE));
    await done;
    return out;
  }

  all(): Promise<OutboxEntry[]> {
    return this.tx("readonly", (s) => request(s.getAll() as IDBRequest<OutboxEntry[]>));
  }

  save(entry: OutboxEntry): Promise<OutboxEntry> {
    return this.tx("readwrite", async (s) => {
      const { seq, ...rest } = entry;
      const key = await request(seq === undefined ? s.add(rest) : s.put(entry));
      return { ...entry, seq: Number(key) };
    });
  }

  remove(seqs: readonly number[]): Promise<void> {
    if (!seqs.length) return Promise.resolve();
    return this.tx("readwrite", async (s) => { for (const seq of seqs) s.delete(seq); });
  }
}

/** IndexedDB when it opens, otherwise memory; decided once, on first use. */
class DeviceOutboxStore implements OutboxStore {
  private inner: Promise<OutboxStore> | null = null;

  private pick(): Promise<OutboxStore> {
    this.inner ??= (async () => {
      try {
        if (typeof indexedDB === "undefined") return new MemoryOutboxStore();
        const idb = new IndexedDbOutboxStore();
        await idb.all();
        return idb;
      } catch {
        return new MemoryOutboxStore();
      }
    })();
    return this.inner;
  }

  async all(): Promise<OutboxEntry[]> { return (await this.pick()).all(); }
  async save(entry: OutboxEntry): Promise<OutboxEntry> { return (await this.pick()).save(entry); }
  async remove(seqs: readonly number[]): Promise<void> { return (await this.pick()).remove(seqs); }
}

/** This device's annotation outbox, shared by every page of the app. */
export const outbox = new Outbox(new DeviceOutboxStore());
