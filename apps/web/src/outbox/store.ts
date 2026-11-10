import { scopeOf } from "./entries.ts";
import type { Entry } from "./entries.ts";
import type { Store } from "./outbox.ts";

/** Entries held in memory only: for tests, and for a browser that does not allow IndexedDB. */
export class MemoryStore implements Store {
  private readonly rows = new Map<string, Entry>();
  load(scope: string): Promise<Entry[]> { return Promise.resolve([...this.rows.values()].filter((e) => scopeOf(e.installation, e.accountId) === scope).map((e) => structuredClone(e))); }
  put(entry: Entry): Promise<void> { this.rows.set(entry.id, structuredClone(entry)); return Promise.resolve(); }
  remove(id: string): Promise<void> { this.rows.delete(id); return Promise.resolve(); }
}

const DB_NAME = "purss-outbox";
const TABLE = "entries";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

/**
 * Entries kept in this browser's IndexedDB so they survive a closed tab, a lost connection and a reload. They are filed
 * under a scope (installation and account) in an index, and only that scope is ever read back.
 */
export class IndexedDbStore implements Store {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const table = req.result.createObjectStore(TABLE, { keyPath: "id" });
        table.createIndex("scope", "scope");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("The outbox database is blocked by another tab."));
    });
    return this.db;
  }

  async load(scope: string): Promise<Entry[]> {
    const db = await this.open();
    const rows = await request(db.transaction(TABLE, "readonly").objectStore(TABLE).index("scope").getAll(scope) as IDBRequest<(Entry & { scope: string })[]>);
    return rows.map(({ scope: _scope, ...entry }) => entry as Entry);
  }

  async put(entry: Entry): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(TABLE, "readwrite");
    tx.objectStore(TABLE).put({ ...entry, scope: scopeOf(entry.installation, entry.accountId) });
    await finished(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(TABLE, "readwrite");
    tx.objectStore(TABLE).delete(id);
    await finished(tx);
  }
}

/** IndexedDB when this browser has it and allows it, otherwise memory (changes then survive only this visit). */
export function openStore(): Store {
  try {
    if (typeof indexedDB !== "undefined") return new FallbackStore(new IndexedDbStore(), new MemoryStore());
  } catch { /* no IndexedDB here */ }
  return new MemoryStore();
}

/** Uses the first store; if it fails (private mode, blocked, quota), carries on in the second so nothing is refused. */
class FallbackStore implements Store {
  private broken = false;
  private readonly main: Store;
  private readonly spare: Store;
  constructor(main: Store, spare: Store) { this.main = main; this.spare = spare; }
  async load(scope: string): Promise<Entry[]> {
    if (this.broken) return this.spare.load(scope);
    try { return await this.main.load(scope); } catch { this.broken = true; return this.spare.load(scope); }
  }
  async put(entry: Entry): Promise<void> {
    if (!this.broken) { try { await this.main.put(entry); return; } catch { this.broken = true; } }
    await this.spare.put(entry);
  }
  async remove(id: string): Promise<void> {
    if (!this.broken) { try { await this.main.remove(id); } catch { this.broken = true; } }
    await this.spare.remove(id);
  }
}
