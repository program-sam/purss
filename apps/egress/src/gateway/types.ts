/*
 * Private feed gateway contracts (plan/20). A source adapter turns a documented API
 * into entries; the gateway stages them, serves them to the engine as RSS, and keeps
 * them until the product acknowledges the durable commit. No adapter is approved in
 * this build: the production registry is empty and the fixture adapter is test-only.
 */

export type StagedEntry = {
  /** Stable identity within the feed, independent of tokens and display names. */
  guid: string;
  title: string;
  url: string | null;
  author?: string | null;
  /** ISO 8601. */
  publishedAt: string | null;
  summaryHtml?: string | null;
  contentHtml?: string | null;
  imageUrl?: string | null;
  enclosures?: { url: string; type: string | null; length: number | null }[];
  categories?: string[];
};

export type RefreshContext = {
  feedId: string;
  params: unknown;
  /** Opaque provider cursor stored atomically with the staged entries. */
  cursor: string | null;
  /** Free staging capacity: the adapter must return at most this many entries. */
  limit: number;
  signal: AbortSignal;
};

export type RefreshResult =
  | { kind: "ok"; entries: StagedEntry[]; nextCursor: string | null; /** Provider says history before this window is not delivered. */ coverageGap?: { note: string } }
  /** Rate limit, network failure or provider 5xx while the grant is still valid. */
  | { kind: "temporary"; code: "rate_limited" | "network" | "provider_error"; message: string; retryAfterSeconds?: number }
  /** Confirmed authorization loss: user disconnect, provider invalid_grant, grant expiry or policy end. */
  | { kind: "grant_lost"; code: "user_disconnect" | "invalid_grant" | "grant_expired" | "policy_end"; message: string };

export interface GatewayAdapter {
  id: string;
  refresh(context: RefreshContext): Promise<RefreshResult>;
}

export type GatewayLimits = {
  /** Staged, unacknowledged entries per feed. */
  maxEntries: number;
  maxBytes: number;
  /** Entries older than this since staging are released with a recorded coverage gap. */
  maxAgeSeconds: number;
  /** One entry's emitted size; larger content is dropped, never silently truncated mid-markup. */
  maxEntryBytes: number;
  /** Entries and bytes per served response; the rest stay staged for the next poll. */
  maxItemsPerResponse: number;
  maxResponseBytes: number;
  /** Minimum time between provider refresh attempts for one feed. */
  minRefreshSeconds: number;
};

export const DEFAULT_LIMITS: GatewayLimits = {
  maxEntries: 500,
  maxBytes: 8 * 1024 * 1024,
  maxAgeSeconds: 30 * 86_400,
  maxEntryBytes: 256 * 1024,
  maxItemsPerResponse: 100,
  maxResponseBytes: 2 * 1024 * 1024,
  minRefreshSeconds: 60,
};

export type HealthStatus = "ok" | "degraded" | "error" | "permission_removed";

export type Health = {
  status: HealthStatus;
  code: string | null;
  message: string | null;
  lastRefreshAttemptAt: string | null;
  /** Last time the provider actually answered successfully. */
  lastProviderSuccessAt: string | null;
  /** Last time entries were handed to the engine. Distinct from provider success. */
  lastDeliveryAt: string | null;
};

export type GapRecord = {
  id: number;
  at: string;
  reason: "age" | "entries" | "bytes" | "provider";
  count: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  note: string | null;
};

export type FeedState = {
  feedId: string;
  adapter: string;
  title: string;
  grant: "active" | "lost";
  credential: { status: "active" | "revoked" | "none"; rotatedAt: string | null; previousValidUntil: string | null };
  staged: { entries: number; bytes: number; oldestStagedAt: string | null };
  health: Health;
  gaps: GapRecord[];
};

export type ServeResult = { status: number; headers: Record<string, string>; body: string };
