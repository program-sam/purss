/**
 * What the page and the service worker agree on: cache names, headers and messages.
 * Pure constants and helpers, imported by both sides.
 */

/** App shell caches hold only the built files, never personal data. One per build. */
export const SHELL_CACHE_PREFIX = "purss-shell:";
/** Reading copies of API answers. One per account, so another account never sees them. */
export const DATA_CACHE_PREFIX = "purss-api:";
/** The worker's own small memory (which account, whether offline reading is on). */
export const STATE_CACHE = "purss-worker-state";
export const STATE_URL = "/__purss/worker-state";

/** Set by the worker on an answer taken from this device's copy: when that copy was saved. */
export const OFFLINE_HEADER = "x-purss-offline";
/** Stored with every copy: when it was saved. */
export const SAVED_HEADER = "x-purss-saved";
/** A page request carrying this header is passed through and never kept (used by the offline pack's queue look-ups). */
export const NO_COPY_HEADER = "x-purss-no-copy";

/** How long the network gets before the saved copy is used instead. */
export const NETWORK_TIMEOUT_MS = 4000;
/** Most saved API answers per account; the oldest go first. */
export const MAX_COPIES = 600;

export type WorkerState = { accountId: string | null; enabled: boolean };
export const EMPTY_STATE: WorkerState = { accountId: null, enabled: false };

export type PageMessage =
  | { type: "state"; accountId: string | null; enabled: boolean }
  | { type: "wipe" }
  | { type: "skip-waiting" };

export function isPageMessage(v: unknown): v is PageMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (m.type === "wipe" || m.type === "skip-waiting") return true;
  return m.type === "state" && (m.accountId === null || typeof m.accountId === "string") && typeof m.enabled === "boolean";
}

export function parseWorkerState(raw: unknown): WorkerState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE };
  const v = raw as Record<string, unknown>;
  return {
    accountId: typeof v.accountId === "string" && v.accountId ? v.accountId : null,
    enabled: v.enabled === true,
  };
}

export const shellCacheName = (build: string): string => `${SHELL_CACHE_PREFIX}${build}`;
export const dataCacheName = (accountId: string): string => `${DATA_CACHE_PREFIX}${accountId}`;
export const isShellCache = (name: string): boolean => name.startsWith(SHELL_CACHE_PREFIX);
export const isDataCache = (name: string): boolean => name.startsWith(DATA_CACHE_PREFIX);

/** The data caches that do not belong to this account (all of them when there is none). */
export function foreignDataCaches(names: readonly string[], accountId: string | null): string[] {
  const own = accountId ? dataCacheName(accountId) : null;
  return names.filter((n) => isDataCache(n) && n !== own);
}

/** Shell caches left by other builds. */
export function staleShellCaches(names: readonly string[], build: string): string[] {
  const own = shellCacheName(build);
  return names.filter((n) => isShellCache(n) && n !== own);
}
