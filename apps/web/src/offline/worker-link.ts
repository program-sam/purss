import { platform } from "../platform/index.ts";
import { deleteAllCopies } from "./store.ts";

/**
 * The page's side of whatever keeps the offline copies: the service worker on the web, the page itself
 * in the apps (platform/). Telling it who is signed in, wiping, and switching to a new build.
 */

/** Start it once. Resolves false where it can't run (insecure address, the development server). */
export function registerWorker(): Promise<boolean> {
  return platform.offline.start();
}

/** Tell it which account is signed in here and whether to keep copies. Resolves true once it has acted on it. */
export function syncWorkerState(accountId: string | null, enabled: boolean): Promise<boolean> {
  return platform.offline.tell({ type: "state", accountId, enabled });
}

/** Forget every saved copy on this device: the keeper's, and directly, in case it isn't running. */
export async function wipeOfflineCopies(): Promise<void> {
  await platform.offline.tell({ type: "wipe" });
  await deleteAllCopies();
}

/** Resolves true once this page's requests pass through the keeper. */
export function whenControlled(timeoutMs = 10_000): Promise<boolean> {
  return platform.offline.whenControlled(timeoutMs);
}

/** Call back when a new build has been downloaded and is waiting for the page to switch to it. */
export function onUpdateReady(callback: () => void): () => void {
  return platform.offline.onUpdateReady(callback);
}

/** Switch to the waiting build and reload once. */
export function applyUpdate(): void {
  platform.offline.applyUpdate();
}
