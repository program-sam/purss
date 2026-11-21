import type { DiscoveryCandidate, DiscoveryEntry, DiscoveryRoute } from "@purss/domain";

/**
 * Discovery previews live in memory only, behind opaque tokens. A pasted feed address may
 * carry a secret (a private link), so it never enters the database, backups or logs before
 * the owner decides how to follow it. A restart forgets previews; the person looks up again.
 * `large`: the feed is bigger than the engine can read whole, so following it goes through the
 * feed gateway; it is held with the preview and never sent to the browser. `itemLinks`: the feed's newest posts' addresses, compared
 * with followed sources to recognise the same feed at another address; never sent either. Nor are `route` (which way discovery found it) and
 * `entry` (how the person got to the lookup): they go onto the source when it is followed, and into the administrator's counts.
 */
export type HeldCandidate = Omit<DiscoveryCandidate, "token" | "alreadyFollowingSourceId"> & { route: DiscoveryRoute; entry: DiscoveryEntry; large?: boolean; itemLinks?: string[] };
type Held = { workspaceId: string; candidate: HeldCandidate; expires: number };

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const held = new Map<string, Held>();

export function holdCandidate(token: string, workspaceId: string, candidate: Held["candidate"]): void {
  purgeCandidates();
  if (held.size >= MAX_ENTRIES) held.delete(held.keys().next().value!);
  held.set(token, { workspaceId, candidate, expires: Date.now() + TTL_MS });
}

/** The held candidate for this PURSS, or null when unknown, expired or someone else's. */
export function peekCandidate(token: string, workspaceId: string): Held["candidate"] | null {
  const h = held.get(token);
  if (!h || h.workspaceId !== workspaceId) return null;
  if (h.expires < Date.now()) { held.delete(token); return null; }
  return h.candidate;
}

export function dropCandidate(token: string): void {
  held.delete(token);
}

export function purgeCandidates(now = Date.now()): void {
  for (const [token, h] of held) if (h.expires < now) held.delete(token);
}
