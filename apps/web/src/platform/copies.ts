import type { CacheLike, CacheStorageLike } from "../sw/cache-types.ts";

/**
 * Cache Storage for the apps, kept in IndexedDB. The offline reading code (sw/offline-worker.ts and
 * offline/store.ts) only needs open/keys/delete/has and match/put/keys/delete, so the same code keeps
 * copies on the web (the browser's Cache Storage, in the service worker) and in the apps (this, in the
 * page). A WebView can't be relied on to run a service worker for the app's own pages: iOS runs them
 * only for https pages of app-bound domains, never for the app's `capacitor://` scheme.
 */

export type StoredAnswer = { status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer };

/** Where the answers are kept: IndexedDB in the apps, memory in tests. */
export interface CopyBackend {
  names(): Promise<string[]>;
  addName(name: string): Promise<void>;
  /** Remove a cache and everything in it. */
  dropName(name: string): Promise<boolean>;
  get(name: string, url: string): Promise<StoredAnswer | undefined>;
  put(name: string, url: string, answer: StoredAnswer): Promise<void>;
  remove(name: string, url: string): Promise<boolean>;
  urls(name: string): Promise<string[]>;
}

const keyOf = (input: RequestInfo | URL): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

class StoredCache implements CacheLike {
  private readonly backend: CopyBackend;
  private readonly name: string;
  constructor(backend: CopyBackend, name: string) { this.backend = backend; this.name = name; }

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const hit = await this.backend.get(this.name, keyOf(input));
    return hit ? new Response(hit.body.slice(0), { status: hit.status, statusText: hit.statusText, headers: hit.headers }) : undefined;
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const answer: StoredAnswer = { status: response.status, statusText: response.statusText, headers: [...response.headers], body: await response.arrayBuffer() };
    await this.backend.put(this.name, keyOf(input), answer);
  }

  async keys(): Promise<Request[]> {
    return (await this.backend.urls(this.name)).map((u) => new Request(u));
  }

  delete(input: RequestInfo | URL): Promise<boolean> {
    return this.backend.remove(this.name, keyOf(input));
  }
}

export class StoredCaches implements CacheStorageLike {
  private readonly backend: CopyBackend;
  constructor(backend: CopyBackend) { this.backend = backend; }

  async open(name: string): Promise<CacheLike> {
    await this.backend.addName(name);
    return new StoredCache(this.backend, name);
  }
  keys(): Promise<string[]> { return this.backend.names(); }
  delete(name: string): Promise<boolean> { return this.backend.dropName(name); }
  async has(name: string): Promise<boolean> { return (await this.backend.names()).includes(name); }
}

/** For tests. */
export class MemoryCopyBackend implements CopyBackend {
  readonly stores = new Map<string, Map<string, StoredAnswer>>();
  async names(): Promise<string[]> { return [...this.stores.keys()]; }
  async addName(name: string): Promise<void> { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  async dropName(name: string): Promise<boolean> { return this.stores.delete(name); }
  async get(name: string, url: string): Promise<StoredAnswer | undefined> { return this.stores.get(name)?.get(url); }
  async put(name: string, url: string, answer: StoredAnswer): Promise<void> { await this.addName(name); this.stores.get(name)!.set(url, answer); }
  async remove(name: string, url: string): Promise<boolean> { return this.stores.get(name)?.delete(url) ?? false; }
  async urls(name: string): Promise<string[]> { return [...(this.stores.get(name)?.keys() ?? [])]; }
}

const DB_NAME = "purss-copies";
const NAMES = "names";
const ENTRIES = "entries";

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The apps' backend: one IndexedDB database, a store of cache names and one of answers keyed by [cache, url]. */
export class IndexedDbCopyBackend implements CopyBackend {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(NAMES);
        req.result.createObjectStore(ENTRIES).createIndex("cache", "cache");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async tx<T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => Promise<T>): Promise<T> {
    const t = (await this.open()).transaction(stores, mode);
    const finished = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
    const out = await work(t);
    await finished;
    return out;
  }

  names(): Promise<string[]> {
    return this.tx([NAMES], "readonly", async (t) => (await done(t.objectStore(NAMES).getAllKeys())).map(String));
  }

  addName(name: string): Promise<void> {
    return this.tx([NAMES], "readwrite", async (t) => { await done(t.objectStore(NAMES).put(true, name)); });
  }

  dropName(name: string): Promise<boolean> {
    return this.tx([NAMES, ENTRIES], "readwrite", async (t) => {
      const had = (await done(t.objectStore(NAMES).count(name))) > 0;
      t.objectStore(NAMES).delete(name);
      const keys = await done(t.objectStore(ENTRIES).index("cache").getAllKeys(name));
      for (const k of keys) t.objectStore(ENTRIES).delete(k);
      return had;
    });
  }

  get(name: string, url: string): Promise<StoredAnswer | undefined> {
    return this.tx([ENTRIES], "readonly", async (t) => {
      const row = (await done(t.objectStore(ENTRIES).get([name, url]))) as (StoredAnswer & { cache: string }) | undefined;
      return row ? { status: row.status, statusText: row.statusText, headers: row.headers, body: row.body } : undefined;
    });
  }

  put(name: string, url: string, answer: StoredAnswer): Promise<void> {
    return this.tx([NAMES, ENTRIES], "readwrite", async (t) => {
      t.objectStore(NAMES).put(true, name);
      await done(t.objectStore(ENTRIES).put({ ...answer, cache: name }, [name, url]));
    });
  }

  remove(name: string, url: string): Promise<boolean> {
    return this.tx([ENTRIES], "readwrite", async (t) => {
      const had = (await done(t.objectStore(ENTRIES).count([name, url]))) > 0;
      t.objectStore(ENTRIES).delete([name, url]);
      return had;
    });
  }

  urls(name: string): Promise<string[]> {
    return this.tx([ENTRIES], "readonly", async (t) => (await done(t.objectStore(ENTRIES).index("cache").getAllKeys(name))).map((k) => String((k as [string, string])[1])));
  }
}
