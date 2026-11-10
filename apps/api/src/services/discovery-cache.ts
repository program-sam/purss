import type { DiscoveryCandidate } from "@purss/domain";

/**
 * Discovery previews live in memory only, behind opaque tokens. A pasted feed address may
 * carry a secret (a private link), so it never enters the database, backups or logs before
 * the owner decides how to follow it. A restart forgets previews; the person looks up again.
 */
type Held = { workspaceId: string; candidate: Omit<DiscoveryCandidate, "token" | "alreadyFollowingSourceId">; expires: number };

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
