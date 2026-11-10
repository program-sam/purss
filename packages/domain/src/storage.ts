/**
 * Logical storage accounting contract (plan/17). Account usage is the sum of the
 * measured bytes of live stored objects; it is not physical disk usage.
 *
 * Measured representation: UTF-8 byte length of the canonical JSON of the object's
 * persisted user-visible fields (listed per kind below), plus captured text/HTML
 * byte lengths. Derived indexes (FTS), caches and engine copies are excluded.
 * A picture kept with an item ("image") counts as the byte length of the picture, once, however many baskets keep the item.
 */
export const STORED_OBJECT_KINDS = ["item_version", "capture", "record", "image"] as const;
export type StoredObjectKind = (typeof STORED_OBJECT_KINDS)[number];

/** Each object is classified once: Basket-kept beats Feed-only beats Other. */
export const STORAGE_CATEGORIES = ["kept", "feed", "other"] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export const STORAGE_CATEGORY_LABELS: Record<StorageCategory, string> = {
  kept: "Kept in baskets",
  feed: "Feed items you haven't kept",
  other: "Other account data",
};

export function measureBytes(fields: Record<string, unknown>): number {
  const keys = Object.keys(fields).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) if (fields[k] !== undefined && fields[k] !== null) canonical[k] = fields[k];
  return Buffer.byteLength(JSON.stringify(canonical), "utf8");
}

/** Small writes (workflow, progress, a basket pin of an existing item) may exceed a full quota by at most this much. */
export const CONTROL_HEADROOM_BYTES = 2 * 1024 * 1024;

export type StorageSummary = {
  usedBytes: number;
  allocationBytes: number | null;
  reservedBytes: number;
  categories: Record<StorageCategory, number>;
  growthPaused: boolean;
  pausedReason: string | null;
  measuredAt: string;
};
