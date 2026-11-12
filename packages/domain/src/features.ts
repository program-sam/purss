import type { ShareDTO } from "./api.ts";
import type { WorkflowState } from "./workflow.ts";
import type { Capacity, Plan } from "./plans.ts";

/* Response shapes of the feature routes (sharing, portability,
   reconciliation, admin). The API services import these, so both sides agree. */

export type PageItem = { publicId: string; title: string; url: string; summary: string | null; note: string | null; sourceTitle: string | null; publishedAt: string | null; addedAt: string };

export const REPORT_REASONS = ["copyright", "illegal", "spam", "harassment", "privacy", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  copyright: "It copies someone's work without permission",
  illegal: "It links to something illegal",
  spam: "It's spam or a scam",
  harassment: "It harasses or threatens someone",
  privacy: "It shares someone's private information",
  other: "Something else",
};

/** A visitor's report about a shared page, for administrators. */
export type ShareReportDTO = {
  id: string;
  reason: ReportReason;
  details: string;
  contact: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: "taken_down" | "dismissed" | null;
  share: { id: string; title: string; curatorName: string; status: "draft" | "published" | "paused"; publicUrl: string; takenDown: { at: string; reason: string } | null; openReports: number };
};

export type SharePreview = {
  share: ShareDTO;
  /** How many items the page shows now. */
  itemCount: number;
  /** The exact page visitors would see. */
  html: string;
  isPublic: boolean;
  /** What sharing makes public that the person added themselves: their keeping, links they saved, their public notes. */
  warnings: string[];
  blockers: string[];
  /** Issued only when sharing is possible; send it back to confirm. */
  confirmation: { token: string; statement: string } | null;
};

export type ImportResult = {
  created: { sources: number; collections: number; baskets: number; items: number; keptPins: number; captures: number; shares: number; annotations: number; reminders: number };
  alreadyPresent: { items: number; sources: number };
  following: number;
  reconnectRequired: number;
};

export type ReconcileEntryDTO = {
  id: string;
  createdAt: string;
  sourceTitle: string | null;
  entry: { title: string; url: string | null; author: string | null; publishedAt: string | null; summary: string | null };
  candidate: { itemId: string; title: string; url: string | null; publishedAt: string | null; kept: boolean } | null;
  suggestion: "match" | "new" | "review";
  reason: string;
};
export type ReconcileList = { entries: ReconcileEntryDTO[]; total: number; suggestedMatches: number };

/**
 * `differenceBytes` is the usage ledger minus the objects (reported, never changed). `trackedDifferenceBytes` is the account's
 * used-bytes total minus a recount of its objects; the check puts the total right, so it is 0 the next time.
 */
export type UsageReport = { checkedAt: string; accounts: { accountId: string; ledgerBytes: number; objectBytes: number; differenceBytes: number; trackedDifferenceBytes: number }[]; mismatched: number };
/**
 * `deletion` is set while the account is being deleted: `pending` during the grace period, `purging` once removal started.
 * `engineReview` means an administrator has to confirm the engine user's data was removed before the deletion can finish.
 */
export type AdminAccountDeletion = { dueAt: string; state: "pending" | "purging"; engineReview: boolean };
/** `plan` is the chosen plan and `capacity.plan` the one that applies (Unlimited while an administrator); both null on self-hosted installs, which have no plans. */
export type AdminAccountDTO = { id: string; displayName: string | null; email: string | null; status: "active" | "suspended"; createdAt: string; isAdmin: boolean; usedBytes: number; allocationBytes: number | null; plan: Plan | null; capacity: Capacity; deletion: AdminAccountDeletion | null;
  /** Hosted only: Smart filter tokens used on the server's key this week (plan/36); null when self-hosted. */
  smartFilterTokens: number | null };

export type OpmlFeed = { title: string; feedUrl: string; siteUrl: string | null; folder: string | null };
export type ParsedOpml = { feeds: OpmlFeed[]; skipped: { notWebAddress: number; duplicates: number }; truncated: boolean };
export type OpmlPreviewEntry = OpmlFeed & { alreadyFollowing: boolean; sourceId: string | null; looksPrivate: boolean };
export type OpmlPreview = { feeds: OpmlPreviewEntry[]; skipped: ParsedOpml["skipped"]; truncated: boolean };

// a list of feeds followed on the server, one feed after the other, so it goes on when the tab is closed.
export type OpmlImportDestination = { kind: "none" } | { kind: "folders" } | { kind: "collection"; id: string } | { kind: "new"; name: string };
/** The feeds the person chose from the preview, with the titles the file gave them. */
export type OpmlImportRequest = { fileName: string; destination: OpmlImportDestination; feeds: { title: string; feedUrl: string; siteUrl: string | null; folder: string | null }[] };
export type OpmlImportEntryState = "waiting" | "working" | "followed" | "already" | "failed";
export type OpmlImportEntryDTO = { position: number; title: string; host: string; folder: string | null; state: OpmlImportEntryState; message: string | null; sourceId: string | null; looksPrivate: boolean };
/** `entries` is set when one import is asked for, not in the list. */
export type OpmlImportDTO = {
  id: string;
  fileName: string;
  status: "running" | "done" | "stopped";
  createdAt: string;
  finishedAt: string | null;
  total: number;
  followed: number;
  already: number;
  failed: number;
  waiting: number;
  entries?: OpmlImportEntryDTO[];
};

// ---------- statistics ----------

/** How many weekly counts a statistics response carries. */
export const STATS_WEEKS = 26;

/** The numbers for one source, or for a whole set of items. Private to the signed-in account. */
export type StatsNumbers = {
  /** Items held, by the dates of publication (arrival date when the feed gave none). */
  totalItems: number;
  /** Items per consecutive 7-day period, oldest first; the last entry is the 7 days up to `asOf`. */
  weekly: number[];
  /** Latest item date (publication date, else arrival date); null without items. */
  lastItemAt: string | null;
  /** Longest stretch in days between two consecutive items dated in the last 12 months; null with fewer than two. */
  longestGapDays: number | null;
  /** Items in each workflow state. */
  workflow: Record<WorkflowState, number>;
  /** Items opened at least once. */
  opened: number;
  /** Items in at least one basket. */
  kept: number;
  /** Items moved to Finished / Ignored in the last 30 days, from the account's own change log, counted once each. */
  finishedLast30Days: number;
  ignoredLast30Days: number;
  /** Items a Smart filter moved to Ignored whose workflow nobody has changed since; part of the Ignored count. */
  filteredOut: number;
};

export type SourceStatsResponse = { sourceId: string; title: string; asOf: string; stats: StatsNumbers };

export type CollectionStatsRow = {
  /** null for items that belong to no source. */
  sourceId: string | null;
  title: string;
  stats: StatsNumbers;
};
export type CollectionStatsResponse = {
  collectionId: string;
  name: string;
  mode: "sources" | "query";
  asOf: string;
  sources: CollectionStatsRow[];
  /** Over all items in the collection (a gap here is between consecutive items of the whole collection). */
  totals: StatsNumbers;
};

/**
 * Discover (hosted only): a source followed by other readers here who follow what you follow. No
 * counts are ever sent. `because` names the person's own sources that led to it; `popular` is for
 * someone whose sources match nothing yet; `wildcard` is a popular source mixed in for variety.
 */
/** Different accounts that must follow a source (and both sources of a pair) before Discover uses it. */
export const DISCOVER_MIN_READERS = 10;
export type DiscoverSuggestion = {
  key: string;
  title: string;
  host: string | null;
  feedUrl: string;
  kind: "feed" | "youtube" | "podcast";
  reason: { kind: "because"; sourceIds: string[] } | { kind: "popular" } | { kind: "wildcard" };
};
export type DiscoverResponse = {
  /** Whether this account's followed sources count towards suggestions (preference `discoveryShare`). Only accounts that share get suggestions. */
  sharing: boolean;
  /** The graph holds at least one source; until then Discovery is "coming soon" for everyone. */
  ready: boolean;
  suggestions: DiscoverSuggestion[];
};
