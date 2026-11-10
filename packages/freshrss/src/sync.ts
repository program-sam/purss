import { createHash } from "node:crypto";
import type { SyncEntry } from "@purss/domain";
import { EngineError } from "./errors.ts";
import type { GReaderClient } from "./greader.ts";
import { clamp, normalizeItem } from "./normalize.ts";

/**
 * Forward, resumable, replay-safe walk of one engine user's reading list.
 *
 * Semantics this relies on (observed against the pinned engine, see CAPABILITIES.md):
 *  - Entry ids are first-crawl timestamps in microseconds and only ever grow; ascending order by id is a stable
 *    walk even while new entries are being crawled (they land after the walk position).
 *  - `ot` (lower bound, seconds) returns entries whose id OR last-modified time is at/after it, so entries edited
 *    upstream (same id, new content) reappear in later incremental passes.
 *  - A page that returns a `continuation` may have more; the token is the last id of the page.
 *  - Absence from the stream proves nothing: the engine purges by its own retention policy and cannot enumerate
 *    deletions. Nothing here ever infers a deletion.
 *
 * Crash safety: every page is submitted with its own checkpoint, committed atomically by the product's API.
 * Re-running after a crash re-reads at most the uncommitted page; re-submitting a committed page is a no-op
 * because the idempotency key is derived from the page's coordinates and content.
 */

export type SyncCheckpoint = {
  continuation: string | null;
  newestCrawlUsec: string | null;
  engineIdentity: string | null;
};

export type SyncBatchDraft = {
  idempotencyKey: string;
  engineIdentity: string;
  entries: SyncEntry[];
  checkpoint: { continuation: string | null; newestCrawlUsec: string | null };
  done: boolean;
};

export type SubmitResult = { accepted: number; duplicates: number };

export type SyncOptions = {
  client: Pick<GReaderClient, "streamContents">;
  engineUserId: string;
  /** Identity of the engine we are talking to now. */
  engineIdentity: string;
  /** The product's stored checkpoint (null on the very first sync). */
  checkpoint: SyncCheckpoint | null;
  submit: (batch: SyncBatchDraft) => Promise<SubmitResult>;
  /** Entries per page; the batch contract allows at most 500. */
  pageSize?: number;
  /**
   * Seconds subtracted from the newest crawl time when computing the next lower bound. Entries are stamped when
   * the engine stages them but become visible when its refresh run commits, so a pass that started in between can
   * see a newer entry before an older one commits. The overlap re-reads that window; duplicates are absorbed.
   */
  overlapSeconds?: number;
  now?: () => Date;
  signal?: AbortSignal;
  /** Hard bound on pages per run so a misbehaving engine cannot loop a job forever. */
  maxPages?: number;
  /**
   * Upper bound on the size of one submitted batch's request body, counted in UTF-8 bytes (Arabic and CJK text takes two
   * or three bytes a character) and including the batch envelope. A page that is larger is submitted in several batches;
   * only the last one advances the checkpoint, so a crash in between re-reads the page. An entry that alone does not
   * fit keeps its title, link, dates, author and a short summary; its full text is dropped and the entry says so
   * (`contentOmitted`), so one feed can never stop an account's sync.
   */
  maxBatchBytes?: number;
};

export type SyncSummary = {
  /** Engine pages read that produced at least one submitted batch. */
  pages: number;
  /** Batches submitted (a large page is split into several). */
  batches: number;
  entries: number;
  accepted: number;
  duplicates: number;
  /** True when the walk reached the end of the stream. False only when aborted. */
  complete: boolean;
  /** The checkpoint as of the last committed batch. */
  checkpoint: { continuation: string | null; newestCrawlUsec: string | null };
  /** True when the stored checkpoint belonged to a different engine and was ignored. */
  identityChanged: boolean;
};

export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_MAX_BATCH_BYTES = 700_000;
export const DEFAULT_OVERLAP_SECONDS = 3600;

export async function runSync(opts: SyncOptions): Promise<SyncSummary> {
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const overlap = Math.max(0, opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS);
  const maxPages = opts.maxPages ?? 100_000;
  const maxBatchBytes = Math.max(1, opts.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
  const now = opts.now ?? (() => new Date());

  const stored = opts.checkpoint;
  const identityChanged = !!stored && stored.engineIdentity !== null && stored.engineIdentity !== opts.engineIdentity;
  // A checkpoint from another engine means nothing here: start over and let the product reconcile.
  const base = stored && !identityChanged ? stored : { continuation: null, newestCrawlUsec: null, engineIdentity: null };

  let newest: bigint | null = base.newestCrawlUsec ? BigInt(base.newestCrawlUsec) : null;
  let continuation = base.continuation;
  const lowerBoundSeconds = newest !== null ? Math.max(0, Number(newest / 1_000_000n) - overlap) : null;
  const passStartedAt = now().toISOString();

  const summary: SyncSummary = {
    pages: 0,
    batches: 0,
    entries: 0,
    accepted: 0,
    duplicates: 0,
    complete: false,
    checkpoint: { continuation: base.continuation, newestCrawlUsec: base.newestCrawlUsec },
    identityChanged,
  };

  for (;;) {
    if (opts.signal?.aborted) return summary;
    if (summary.pages >= maxPages) throw new EngineError("protocol", "The engine kept returning pages without reaching the end of its stream.", { retryable: false });

    const page = await opts.client.streamContents({
      count: pageSize,
      order: "asc",
      continuation,
      newerThanSeconds: lowerBoundSeconds,
    });
    if (page.continuation !== null && page.continuation === continuation) {
      throw new EngineError("protocol", "The engine returned the same continuation twice; refusing to loop.", { retryable: false });
    }

    const seen = new Set<string>();
    const entries: SyncEntry[] = [];
    const digests: string[] = [];
    const sizes: number[] = [];
    const previousNewest = newest;
    const normalized = page.items.map((raw) => normalizeItem(raw));
    for (const n of normalized) {
      if (newest === null || BigInt(n.crawlUsec) > newest) newest = BigInt(n.crawlUsec);
    }

    const done = page.continuation === null;
    const pageEnd = { continuation: done ? null : page.continuation, newestCrawlUsec: newest === null ? null : newest.toString() };
    const pageStart = { continuation, newestCrawlUsec: previousNewest === null ? null : previousNewest.toString() };
    const entryBudget = Math.max(1, maxBatchBytes - envelopeBytes(opts.engineIdentity, pageStart, pageEnd));
    for (const n of normalized) {
      if (seen.has(n.entry.externalId)) continue; // the engine never repeats an id within a page; be defensive
      seen.add(n.entry.externalId);
      const fitted = fitEntry(n.entry, entryBudget);
      entries.push(fitted.entry);
      digests.push(`${n.entry.externalId}:${n.contentDigest}`);
      sizes.push(fitted.bytes);
    }

    // An empty page is only submitted when it ends the walk (to record a successful, up-to-date pass).
    if (entries.length > 0 || done) {
      const chunks = splitByBytes(sizes, entryBudget);
      for (const [index, range] of chunks.entries()) {
        const last = index === chunks.length - 1;
        const chunkEntries = entries.slice(range.from, range.to);
        const draft: SyncBatchDraft = {
          idempotencyKey: batchKey({
            engineUserId: opts.engineUserId,
            engineIdentity: opts.engineIdentity,
            lowerBoundSeconds,
            from: continuation,
            digests: digests.slice(range.from, range.to),
            done: last && done,
            // An empty end-of-walk page has no content to key on; scope it to this pass so it is recorded once per pass.
            passStartedAt: entries.length === 0 ? passStartedAt : null,
          }),
          engineIdentity: opts.engineIdentity,
          entries: chunkEntries,
          // Only the last chunk of a page moves the checkpoint past it.
          checkpoint: last ? pageEnd : pageStart,
          done: last && done,
        };
        const result = await opts.submit(draft);
        summary.accepted += result.accepted;
        summary.duplicates += result.duplicates;
        summary.entries += chunkEntries.length;
        summary.batches += 1;
        if (last) summary.checkpoint = pageEnd;
        if (opts.signal?.aborted && !last) return summary;
      }
      summary.pages += 1;
    }

    if (done) {
      summary.complete = true;
      return summary;
    }
    continuation = page.continuation;
  }
}

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** Bytes the batch around its entries takes in the request body: the lease, key, identity and checkpoint, with room for a long lease id. */
function envelopeBytes(engineIdentity: string, ...checkpoints: Array<{ continuation: string | null; newestCrawlUsec: string | null }>): number {
  const longest = checkpoints.reduce((a, b) => (utf8(JSON.stringify(b)) > utf8(JSON.stringify(a)) ? b : a));
  return utf8(JSON.stringify({ leaseId: "l".repeat(64), idempotencyKey: `sync-${"0".repeat(48)}`, engineIdentity, entries: [], checkpoint: longest, done: false })) + 16;
}

/**
 * The entry's size in the request body (UTF-8 bytes of its JSON, plus the comma that separates it from the next entry).
 * An entry that alone is over the budget keeps what identifies and summarises it and loses its full text, flagged so the
 * product can say so; its summary becomes the start of its text, short enough to fit whatever the budget.
 */
function fitEntry(entry: SyncEntry, budget: number): { entry: SyncEntry; bytes: number } {
  const size = (e: SyncEntry) => utf8(JSON.stringify(e)) + 1;
  const whole = size(entry);
  if (whole <= budget) return { entry, bytes: whole };
  const slim: SyncEntry = { ...entry, contentHtml: null, summaryHtml: summaryOf(entry.summaryHtml ?? entry.contentHtml), contentOmitted: true };
  return { entry: slim, bytes: size(slim) };
}

const SUMMARY_CHARS = 1200;
const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** A short plain-text summary (as HTML) taken from the start of a long text, or null when there is nothing to show. */
function summaryOf(html: string | null): string | null {
  if (!html) return null;
  // Only the start is read: a summary never needs more, and a huge page must not make the cleaning slow.
  const text = html.slice(0, 60_000).replace(/<[^>]*$/, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const cut = clamp(text, SUMMARY_CHARS);
  const escaped = cut.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${escaped}${cut.length < text.length ? "…" : ""}</p>`;
}

/** Greedy split of consecutive entries into groups whose total size stays within the budget (one entry per group at minimum). */
function splitByBytes(sizes: readonly number[], budget: number): Array<{ from: number; to: number }> {
  if (sizes.length === 0) return [{ from: 0, to: 0 }];
  const out: Array<{ from: number; to: number }> = [];
  let from = 0;
  let total = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (i > from && total + sizes[i]! > budget) {
      out.push({ from, to: i });
      from = i;
      total = 0;
    }
    total += sizes[i]!;
  }
  out.push({ from, to: sizes.length });
  return out;
}

function batchKey(parts: {
  engineUserId: string;
  engineIdentity: string;
  lowerBoundSeconds: number | null;
  from: string | null;
  digests: string[];
  done: boolean;
  passStartedAt: string | null;
}): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([parts.engineUserId, parts.engineIdentity, parts.lowerBoundSeconds, parts.from, parts.done, parts.passStartedAt]));
  for (const d of parts.digests) h.update(`\n${d}`);
  return `sync-${h.digest("hex").slice(0, 48)}`;
}
