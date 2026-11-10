/**
 * Writes this device couldn't send (offline, or PURSS didn't answer): the latest one per item,
 * kept on the device under the account that made it, until it is sent when the connection is back.
 * Used for playback positions and reading progress, which the state-write outbox doesn't carry.
 */
export type LateStore<T> = {
  all(): Record<string, T>;
  put(itemId: string, value: T): void;
  /** Remove the item's write, only if it is still `value` (not replaced by a newer one meanwhile). */
  remove(itemId: string, value: T): void;
};

const PREFIX = "purss-late:";

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const memory = (): KV => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
};

function deviceStorage(): KV {
  try { return localStorage; } catch { return memory(); }
}

export function lateStore<T>(kind: string, accountId: string, storage: KV = deviceStorage()): LateStore<T> {
  const key = `${PREFIX}${kind}:${accountId}`;
  const read = (): Record<string, T> => {
    try {
      const v = JSON.parse(storage.getItem(key) ?? "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, T> : {};
    } catch { return {}; }
  };
  const write = (all: Record<string, T>) => {
    try { if (Object.keys(all).length) storage.setItem(key, JSON.stringify(all)); else storage.removeItem(key); } catch { /* full or private mode: kept for this visit only by the caller's retry */ }
  };
  return {
    all: read,
    put(itemId, value) { write({ ...read(), [itemId]: value }); },
    remove(itemId, value) {
      const all = read();
      if (!(itemId in all) || JSON.stringify(all[itemId]) !== JSON.stringify(value)) return;
      delete all[itemId];
      write(all);
    },
  };
}

/**
 * Sign-out and disconnecting: every account's unsent writes leave the device. `except`: keep that
 * account's (a browser, which several people may share, keeps only the signed-in account's).
 */
export function clearLateWrites(storage: KV = deviceStorage(), except: string | null = null): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(PREFIX) && !(except && k.endsWith(`:${except}`))) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

/** Whether a failed write should be kept for later: no connection, a busy server, or a session that ended. */
export function worthRetrying(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  if (!e || typeof e.status !== "number") return true;
  return e.code === "offline" || e.status === 0 || e.status === 401 || e.status === 403 || e.status === 408 || e.status === 429 || (e.status >= 500 && e.status !== 507);
}
