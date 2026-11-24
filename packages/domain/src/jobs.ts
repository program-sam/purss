import { z } from "zod";
import { aiJudgeResultSchema } from "./ai-filters.ts";

/**
 * Internal job contract between the API (sole database writer) and the worker.
 * The worker authenticates with the service token on the API's internal listener.
 */
export const JOB_KINDS = [
  "engine.provision", // create/verify the engine user for an account
  "engine.subscribe", // add a feed to the engine and report its stream id
  "engine.unsubscribe",
  "engine.rename",
  "engine.sync", // import new/changed entries for one engine user
  "engine.mark_read", // optional read mirroring (outbox)
  "capture.fulltext", // readable-text capture for a kept item
  "capture.images", // fetch the pictures of an item kept with its readable text
  "source.icon", // find and normalize a source's icon
  "engine.delete_user", // remove a deleted account's engine user, then finalize the deletion
  "filter.judge", // ask Jev whether new posts pass the Smart filters that apply to them
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Whether a stored or requested kind is one this version knows; a worker or a row of another version may name others. */
export const isJobKind = (kind: string): kind is JobKind => (JOB_KINDS as readonly string[]).includes(kind);

export const jobPayloadSchemas = {
  "engine.provision": z.object({ engineUserId: z.string(), username: z.string() }),
  // trim: the feed is big (larger than the engine can read whole), so the engine is given the feed gateway's trimmed copy of it.
  "engine.subscribe": z.object({ engineUserId: z.string(), sourceId: z.string(), feedUrl: z.string(), title: z.string(), trim: z.boolean().optional() }),
  "engine.unsubscribe": z.object({ engineUserId: z.string(), streamId: z.string() }),
  "engine.rename": z.object({ engineUserId: z.string(), streamId: z.string(), title: z.string() }),
  "engine.sync": z.object({ engineUserId: z.string() }),
  "engine.mark_read": z.object({ engineUserId: z.string(), externalIds: z.array(z.string()).max(200), read: z.boolean() }),
  "capture.fulltext": z.object({ captureId: z.string(), url: z.string() }),
  // The pictures to fetch for one item; maxBytes is what is left of the item's room for pictures; shrink: store them small (an Instagram post's).
  "capture.images": z.object({ itemId: z.string(), urls: z.array(z.string().max(2048)).min(1).max(20), maxBytes: z.number().int().positive(), shrink: z.boolean().optional() }),
  // feedUrl is null for private sources: their secret link is never fetched for an icon.
  "source.icon": z.object({ sourceId: z.string(), kind: z.string(), feedUrl: z.string().nullable(), siteUrl: z.string().nullable() }),
  "engine.delete_user": z.object({ engineUserId: z.string(), username: z.string() }),
  // The posts to judge; the API answers with what to ask about them when the job runs, so a filter edited meanwhile is asked as it is now.
  // announce: the posts arrived just now, and the ones that stay are announced as new (a re-check announces nothing).
  "filter.judge": z.object({ itemIds: z.array(z.string()).min(1).max(20), announce: z.boolean() }),
} satisfies Record<JobKind, z.ZodType>;
export type JobPayload<K extends JobKind> = z.infer<(typeof jobPayloadSchemas)[K]>;

/**
 * What a worker reports when a job ran, by kind. A schema names only the fields the API uses and lets any other pass, and a
 * field a worker of another version may not send is optional, so the wire stays compatible across a rolling deploy. A result
 * the API refuses ends the job for good (the worker takes a 400 as a failure that will not pass on a retry), so only what the
 * API cannot complete without is checked: the stream id of a subscription, and a Smart filter answer. Metadata about the
 * run (an engine identity, a word about the feed) is `unknown` here, and the API acts on it only in the shape it expects. The
 * results of `capture.fulltext`, `capture.images` and `source.icon` are any object here: what the worker fetched is checked
 * where it is stored (captured text, pictures and icon bytes), and a result that fails there settles the copy, picture or
 * icon check, rather than refusing a request the worker would retry.
 */
const anyResult = z.record(z.string(), z.unknown());
export const jobResultSchemas = {
  // engineIdentity: a string says which engine this is.
  "engine.provision": z.looseObject({ engineIdentity: z.unknown().optional() }),
  // empty: the engine says the feed it just fetched has nothing in it; viaGateway: the engine follows the feed gateway's copy of a big feed. Each counts only when it is true.
  "engine.subscribe": z.looseObject({ streamId: z.string().min(1), empty: z.unknown().optional(), viaGateway: z.unknown().optional() }),
  "engine.unsubscribe": anyResult,
  "engine.rename": anyResult,
  "engine.sync": anyResult,
  "engine.mark_read": anyResult,
  "capture.fulltext": anyResult,
  "capture.images": anyResult,
  "source.icon": anyResult,
  "engine.delete_user": anyResult,
  "filter.judge": aiJudgeResultSchema,
} satisfies Record<JobKind, z.ZodType>;
export type JobResult<K extends JobKind> = z.infer<(typeof jobResultSchemas)[K]>;

export type LeasedJob = {
  id: string;
  kind: JobKind;
  payload: unknown;
  leaseId: string;
  leaseExpiresAt: string;
  attempts: number;
};

/** One entry as reported by the engine (GReader stream item), normalised by the adapter. */
export const syncEntrySchema = z.object({
  externalId: z.string().min(1).max(200), // engine item id, unique per engine user
  streamId: z.string().min(1).max(300), // engine feed stream id ("feed/12")
  originalGuid: z.string().max(2000).nullable(),
  url: z.string().max(4000).nullable(),
  title: z.string().max(2000),
  author: z.string().max(500).nullable(),
  publishedAt: z.string().nullable(), // ISO
  crawledAt: z.string(), // ISO; engine discovery time
  summaryHtml: z.string().max(200_000).nullable(),
  contentHtml: z.string().max(2_000_000).nullable(),
  imageUrl: z.string().max(4000).nullable(),
  enclosures: z.array(z.object({ url: z.string().max(4000), type: z.string().max(200).nullable(), length: z.number().nullable() })).max(10),
  /** The feed's full text was too large to send, so it was left out; the summary stands in for it. */
  contentOmitted: z.boolean().optional(),
});
export type SyncEntry = z.infer<typeof syncEntrySchema>;

export const syncBatchSchema = z.object({
  leaseId: z.string(),
  idempotencyKey: z.string().min(8).max(200),
  engineIdentity: z.string().min(1).max(200),
  entries: z.array(syncEntrySchema).max(500),
  /** Checkpoint to store with this batch; committed atomically with the entries. */
  checkpoint: z.object({ continuation: z.string().max(500).nullable(), newestCrawlUsec: z.string().max(30).nullable() }),
  /** Engine stream ids seen in the subscription list, used for health (never for deletion). */
  done: z.boolean(),
});
export type SyncBatch = z.infer<typeof syncBatchSchema>;

/** A finished job's report; its result is checked by the job's kind (`jobResultSchemas`). */
export const jobResultSchema = z.object({
  leaseId: z.string(),
  result: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Why a job failed, in terms the product can put into plain words for a person (the `error` text is for operators).
 * `rate_limited` and `unavailable` are about a site or the engine and are expected to pass; the others will not.
 */
export const FAILURE_REASONS = ["rate_limited", "unavailable", "not_found", "refused", "too_large", "not_a_feed", "other"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const jobFailureSchema = z.object({
  leaseId: z.string(),
  error: z.string().max(2000), // redacted: no secrets, no content
  retryable: z.boolean(),
  reason: z.enum(FAILURE_REASONS).optional(),
});
