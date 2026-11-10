import type { ItemDTO } from "@purss/domain";
import { itemDate } from "../lib/items.ts";

/**
 * The offline pack: the reading queue this device keeps so it can be read without a connection.
 * Pure decisions only; pack-runner.ts does the fetching.
 */
export const PACK_LIMIT = 200;
/** Most kept items (from baskets that save readable text) in the queue. */
export const PACK_KEPT_LIMIT = 100;
/** Automatic refreshes are at least this far apart. */
export const PACK_MIN_INTERVAL_MS = 15 * 60_000;
/** A change the person made to what they read or keep (To read, a keep) is saved again after this long at the soonest since the last save started. */
export const PACK_CHANGE_INTERVAL_MS = 30_000;
/** Lost copies are saved again after this long at the soonest since the last save started (so a device that keeps losing them doesn't save in a loop). */
export const PACK_REBUILD_INTERVAL_MS = 10_000;
/** A saved item is fetched again after this, in case its text arrived or changed after it was saved. */
export const DETAIL_MAX_AGE_MS = 12 * 3_600_000;
export const PACK_CONCURRENCY = 2;

export type QueueLists = { toread: readonly ItemDTO[]; inprogress: readonly ItemDTO[]; fresh: readonly ItemDTO[]; kept?: readonly ItemDTO[] };

const newestFirst = (a: ItemDTO, b: ItemDTO) => Date.parse(itemDate(b)) - Date.parse(itemDate(a)) || (a.id < b.id ? 1 : -1);

/**
 * Items the person chose to read (To read, In progress), newest first; then what they kept in baskets that save readable
 * text, most recently kept first (as listed), at most PACK_KEPT_LIMIT; then items that are New and still Undecided, newest
 * first; at most `limit` in all. What the person chose is never crowded out by what merely arrived.
 */
export function selectQueue(lists: QueueLists, limit = PACK_LIMIT): ItemDTO[] {
  const chosen = new Map<string, ItemDTO>();
  for (const it of [...lists.toread, ...lists.inprogress]) if (it.workflow === "toread" || it.workflow === "inprogress") chosen.set(it.id, it);
  const out = [...chosen.values()].sort(newestFirst).slice(0, limit);
  const have = new Set(out.map((it) => it.id));
  let keptCount = 0;
  for (const it of lists.kept ?? []) {
    if (out.length >= limit || keptCount >= PACK_KEPT_LIMIT) break;
    if (have.has(it.id)) continue;
    have.add(it.id);
    out.push(it);
    keptCount++;
  }
  const undecided = (lists.fresh).filter((it) => it.fresh && it.workflow === "new" && !have.has(it.id)).sort(newestFirst);
  for (const it of undecided) {
    if (out.length >= limit) break;
    if (!have.has(it.id)) { have.add(it.id); out.push(it); }
  }
  return out;
}

/**
 * What the device last saved of one item: the state version it was at (the server's counter of every change to the item's state,
 * including the New marker and the opened time), when it was saved, whether a readable copy was still being made, and when its
 * highlights and notes had last changed when they were saved.
 */
export type SavedItems = Record<string, { stateVersion: number; at: number; textPending?: boolean; annotatedAt?: string }>;

/** Items whose text must be fetched: not saved, changed since, still waiting for its readable copy, or saved long enough ago to refresh. */
export function itemsToFetch(queue: readonly ItemDTO[], saved: SavedItems, present: ReadonlySet<string>, now: number, maxAge = DETAIL_MAX_AGE_MS): ItemDTO[] {
  return queue.filter((it) => {
    const s = saved[it.id];
    return !(s && present.has(it.id) && s.stateVersion === it.stateVersion && !s.textPending && now - s.at < maxAge);
  });
}

/**
 * Items whose highlights and notes must be fetched: ones that have any (an item never annotated needs
 * no copy: it has none) and whose text was just fetched or whose annotations changed since they were saved.
 */
export function annotationsToFetch(queue: readonly ItemDTO[], saved: SavedItems, refetched: ReadonlySet<string>): ItemDTO[] {
  return queue.filter((it) => it.annotatedAt !== null && (refetched.has(it.id) || saved[it.id]?.annotatedAt !== it.annotatedAt));
}

/** Milliseconds until an automatic refresh may start; 0 means now. */
export function waitBeforeRun(lastStartedAt: number | null, now: number, minInterval = PACK_MIN_INTERVAL_MS): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, lastStartedAt + minInterval - now);
}

/**
 * Whether the device has lost copies it should hold: the record says items were saved that the device's store no longer has
 * (the browser cleared its storage, or the copies were evicted). Then the queue is saved again at once instead of waiting
 * out the interval, which would leave a device with the setting on and nothing saved.
 */
export function copiesMissing(record: PackRecord, present: ReadonlySet<string>): boolean {
  return Object.keys(record.items).some((id) => !present.has(id));
}

/**
 * Milliseconds until a save may start: at least `minimum`, and not before `floor` has passed since the last one started; when the
 * device has lost copies the record says it saved, the floor is ten seconds at most.
 */
export function packWait(record: PackRecord, present: ReadonlySet<string>, now: number, minimum: number, floor: number = PACK_MIN_INTERVAL_MS): number {
  return Math.max(minimum, waitBeforeRun(record.startedAt, now, copiesMissing(record, present) ? Math.min(floor, PACK_REBUILD_INTERVAL_MS) : floor));
}

export type PackRecord = { startedAt: number | null; savedAt: string | null; items: SavedItems };
export const EMPTY_RECORD: PackRecord = { startedAt: null, savedAt: null, items: {} };

/** What localStorage held about the pack; anything unreadable counts as nothing saved. */
export function parseRecord(raw: string | null): PackRecord {
  if (!raw) return { ...EMPTY_RECORD, items: {} };
  try {
    const v = JSON.parse(raw) as Partial<PackRecord>;
    const items: SavedItems = {};
    for (const [id, s] of Object.entries(v.items ?? {})) {
      if (s && typeof s.stateVersion === "number" && typeof s.at === "number") {
        items[id] = { stateVersion: s.stateVersion, at: s.at, ...(s.textPending === true ? { textPending: true } : {}), ...(typeof s.annotatedAt === "string" ? { annotatedAt: s.annotatedAt } : {}) };
      }
    }
    return {
      startedAt: typeof v.startedAt === "number" ? v.startedAt : null,
      savedAt: typeof v.savedAt === "string" ? v.savedAt : null,
      items,
    };
  } catch { return { ...EMPTY_RECORD, items: {} }; }
}

/** Distinct sources behind the queue, most items first, for the pages worth saving a first page of. */
export function sourcesOf(queue: readonly ItemDTO[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const it of queue) if (it.sourceId) counts.set(it.sourceId, (counts.get(it.sourceId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([id]) => id);
}
