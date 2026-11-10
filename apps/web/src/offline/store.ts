import { platform } from "../platform/index.ts";
import { DATA_CACHE_PREFIX, dataCacheName } from "../sw/protocol.ts";
import { EMPTY_RECORD, parseRecord } from "./pack.ts";
import type { PackRecord } from "./pack.ts";

/** What this device knows about its saved copies: the pack's record (localStorage) and the copies themselves (Cache Storage, or the apps' own store). */
const RECORD_PREFIX = "purss:offline-pack:";

export function readRecord(accountId: string): PackRecord {
  try { return parseRecord(localStorage.getItem(RECORD_PREFIX + accountId)); } catch { return { ...EMPTY_RECORD, items: {} }; }
}

export function writeRecord(accountId: string, record: PackRecord): void {
  try { localStorage.setItem(RECORD_PREFIX + accountId, JSON.stringify(record)); } catch { /* storage full or private: the pack just fetches again */ }
}

export function clearRecords(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(RECORD_PREFIX)) localStorage.removeItem(key);
  } catch { /* nothing to clear */ }
}

/** Ids of the items whose text is saved on this device, read from the account's copies. */
export async function savedItemIds(accountId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const caches = platform.offline.caches();
    const name = dataCacheName(accountId);
    if (!caches || !(await caches.has(name))) return ids;
    for (const key of await (await caches.open(name)).keys()) {
      const m = /^\/api\/items\/([^/]+)$/.exec(new URL(key.url).pathname);
      if (m) ids.add(decodeURIComponent(m[1]!));
    }
  } catch { /* no Cache Storage here */ }
  return ids;
}

/** Delete every saved copy of every account (the worker does the same on its side). */
export async function deleteAllCopies(): Promise<void> {
  try {
    const caches = platform.offline.caches();
    if (caches) for (const name of await caches.keys()) if (name.startsWith(DATA_CACHE_PREFIX)) await caches.delete(name);
  } catch { /* no Cache Storage here */ }
  clearRecords();
}

/** This browser's storage use for this site (all of it, not just the copies) and its limit. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || typeof e.usage !== "number" || typeof e.quota !== "number") return null;
    return { usage: e.usage, quota: e.quota };
  } catch { return null; }
}
