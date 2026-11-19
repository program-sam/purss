import v8 from "node:v8";
import vm from "node:vm";
import { HARD_STREAM_BYTES, parseContentType, parseTrimTarget, safeFetch, trimSignatureMatches } from "@purss/connectors";
import type { Resolver, SafeFetchOptions, SafeFetchResult } from "@purss/connectors";
import type { Logger } from "../proxy.ts";
import { FeedTrimmer, TRIM_LIMITS } from "./trim.ts";
import type { TrimFailure, TrimLimits } from "./trim.ts";

/*
 * The gateway's answer for a big feed: `GET /t/<signature>/<address>` reads the feed at that address as a stream through
 * safeFetch (the same address, redirect, time and size rules as every other fetch of a feed a person supplied) to its end, keeps its
 * newest items, and answers with a much smaller copy of the same feed. Only addresses signed with this installation's key are answered.
 * Nothing is stored for good, but the work is shared: the trimmed answer is kept in memory per upstream address (the whole address,
 * a private feed's key included, so one account's feed is never another's) and reused for a few minutes by every account that follows
 * the feed, and when it ages the publisher is asked whether the feed changed (If-None-Match / If-Modified-Since from its last answer's
 * ETag / Last-Modified): a 304 gives the same answer again without reading the feed. Upstream work is bounded: one fetch per address
 * at a time (concurrent requests share it), a few fetches at once overall, and after a failure a back-off during which the failure is
 * repeated. A failure is never served as an empty feed.
 */

export type TrimServeLimits = {
  /** How long a good answer is reused before the publisher is asked again. */
  cacheMs: number;
  /** First back-off after a failure that may pass; doubles while it continues, up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
  /** Fetches running at once. */
  concurrency: number;
  /** Requests waiting for a free fetch slot; beyond that the answer is "busy". */
  maxQueue: number;
  /** Addresses whose last answer or failure is remembered, least recently used out. */
  maxRemembered: number;
  /** Bytes of good answers kept in all, with the addresses they are kept under (egress's container is 192 MiB and the process holds about 125 MiB idle). */
  maxCachedBytes: number;
  /** One fetch, all hops. */
  timeoutMs: number;
  trim: TrimLimits;
};

/** What can be changed (tests): any of the limits, and any of the trimmer's. */
export type TrimServeOptions = Partial<Omit<TrimServeLimits, "trim">> & { trim?: Partial<TrimLimits> };

export const DEFAULT_TRIM_SERVE_LIMITS: TrimServeLimits = {
  cacheMs: 10 * 60_000,
  backoffMs: 60_000,
  maxBackoffMs: 30 * 60_000,
  concurrency: 2,
  maxQueue: 16,
  maxRemembered: 500,
  maxCachedBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
  trim: { ...TRIM_LIMITS },
};

/**
 * Reading a big feed makes garbage as fast as it arrives (a buffer and a string for every piece), and Node lets that pile up to tens of
 * megabytes before it collects: in egress's 160 MiB container, which holds 125 MiB before any feed is read, that is the difference between
 * a fetch that costs 25 MiB and one that gets the process killed (and the engine's only way out with it). So a feed read past
 * `COLLECT_EVERY` bytes is collected after each of them: a few tens of milliseconds a time, only for the feeds that are read in full.
 */
const COLLECT_EVERY = 1024 * 1024;
/** A fetch that read this much is collected when it ends, so that a run of them does not pile up either. */
const COLLECT_AFTER = 512 * 1024;
let collect: (() => void) | null | undefined;
function collectGarbage(): void {
  if (collect === undefined) {
    try {
      v8.setFlagsFromString("--expose-gc");
      collect = vm.runInNewContext("gc") as () => void;
    } catch {
      collect = null; // not available here: the garbage is left to Node
    }
  }
  collect?.();
}

export type TrimAnswer = { status: number; headers: Record<string, string>; body: Buffer };

/** What the publisher said about its feed, to ask again with; `base` is the address it was read from (after redirects). */
type Validators = { etag: string | null; lastModified: string | null; base: string };
type Good = { at: number; answer: TrimAnswer } & Validators;
type Failure = { until: number; streak: number; answer: TrimAnswer; retryable: boolean };
type State = { good: Good | null; failure: Failure | null };

/** What one fetch came to; `validators` are given for a good answer. */
type Fetched = { answer: TrimAnswer; outcome: string; retryable: boolean; validators?: Validators; more?: Record<string, number | string> };

/** A validator the publisher sent, if it is one worth keeping and sending back (they are short). */
const validator = (value: string | undefined): string | null => (value && value.length <= 256 ? value : null);

const TEXT = "text/plain; charset=utf-8";
const NOT_FOUND: TrimAnswer = { status: 404, headers: { "content-type": TEXT }, body: Buffer.from("Not found.\n") };
const XML_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/xml", "text/xml"]);

const text = (status: number, message: string, headers: Record<string, string> = {}): TrimAnswer => ({
  status,
  headers: { "content-type": TEXT, "cache-control": "no-store", ...headers },
  body: Buffer.from(`${message}\n`),
});

/** What the engine is told when a feed can't be trimmed. Size is never the reason: a big feed is served as far as it was read. */
function failureAnswer(reason: TrimFailure): TrimAnswer {
  switch (reason) {
    case "unsupported_encoding":
      return text(422, "This feed's text encoding can't be read.");
    default:
      return text(422, "This address does not answer with a feed that can be read.");
  }
}

export class TrimService {
  #secret: string;
  #log: Logger;
  #now: () => number;
  #limits: TrimServeLimits;
  #fetch: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
  #test: { testAllowAddress?: (ip: string) => boolean; resolver?: Resolver };
  #states = new Map<string, State>();
  #cachedBytes = 0;
  #inflight = new Map<string, Promise<TrimAnswer>>();
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(opts: {
    secret: string;
    log?: Logger;
    now?: () => number;
    limits?: TrimServeOptions;
    /** TEST ONLY, in-process: replaces the fetcher, or lets it reach local servers. */
    fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
    testAllowAddress?: (ip: string) => boolean;
    resolver?: Resolver;
  }) {
    if (opts.secret.length < 32) throw new Error("The feed-trim key must be at least 32 characters.");
    this.#secret = opts.secret;
    this.#log = opts.log ?? (() => {});
    this.#now = opts.now ?? Date.now;
    this.#limits = { ...DEFAULT_TRIM_SERVE_LIMITS, ...opts.limits, trim: { ...DEFAULT_TRIM_SERVE_LIMITS.trim, ...opts.limits?.trim } };
    this.#fetch = opts.fetch ?? safeFetch;
    this.#test = { testAllowAddress: opts.testAllowAddress, resolver: opts.resolver };
  }

  /** Addresses remembered and bytes of answers kept (for tests and the memory budget). */
  get footprint(): { remembered: number; cachedBytes: number; running: number } {
    return { remembered: this.#states.size, cachedBytes: this.#cachedBytes, running: this.#running };
  }

  /** Answer a signed address. Anything unsigned or malformed is the same 404. */
  async serve(encoded: string, signature: string): Promise<TrimAnswer> {
    const url = parseTrimTarget(encoded);
    if (!url || !trimSignatureMatches(this.#secret, url, signature)) return NOT_FOUND;
    const running = this.#inflight.get(url);
    if (running) return running;
    const state = this.#touch(url);
    const now = this.#now();
    if (state?.good && now - state.good.at < this.#limits.cacheMs) return this.#logged(url, state.good.answer, "cached", 0, true);
    if (state?.failure && now < state.failure.until) {
      // A feed that answered before keeps its last good answer while its host is failing; what won't pass by itself is repeated as it is.
      return this.#logged(url, state.failure.retryable && state.good ? state.good.answer : state.failure.answer, "backoff", 0, true);
    }
    const work = this.#refresh(url).finally(() => this.#inflight.delete(url));
    this.#inflight.set(url, work);
    return work;
  }

  #touch(url: string): State | undefined {
    const s = this.#states.get(url);
    if (s) {
      this.#states.delete(url);
      this.#states.set(url, s);
    }
    return s;
  }

  /** What a kept answer weighs: its body and the address and validators it is kept under (a private feed's address is up to 2 KiB). */
  #weight(url: string, good: Good | null): number {
    return good ? good.answer.body.length + url.length + good.base.length + (good.etag?.length ?? 0) + (good.lastModified?.length ?? 0) : 0;
  }

  #commit(url: string, update: (s: State) => void): State {
    const s = this.#touch(url) ?? { good: null, failure: null };
    this.#states.set(url, s);
    this.#cachedBytes -= this.#weight(url, s.good);
    update(s);
    this.#cachedBytes += this.#weight(url, s.good);
    for (const [other, st] of this.#states) {
      if (this.#states.size <= this.#limits.maxRemembered && this.#cachedBytes <= this.#limits.maxCachedBytes) break;
      if (other === url || this.#inflight.has(other)) continue;
      if (this.#states.size > this.#limits.maxRemembered) {
        this.#cachedBytes -= this.#weight(other, st.good);
        this.#states.delete(other);
      } else if (st.good) {
        this.#cachedBytes -= this.#weight(other, st.good);
        st.good = null;
      }
    }
    // An answer bigger than the whole budget is served once and not kept.
    if (this.#cachedBytes > this.#limits.maxCachedBytes && s.good) {
      this.#cachedBytes -= this.#weight(url, s.good);
      s.good = null;
    }
    return s;
  }

  #logged(url: string, answer: TrimAnswer, outcome: string, ms: number, cached: boolean, more: Record<string, number | string> = {}): TrimAnswer {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* not logged */
    }
    // The address itself is never logged (it can carry a private feed's key): its host is enough to see what is being followed.
    this.#log({ event: "gateway.trim", host, outcome, status: answer.status, ms, cached, ...more });
    return answer;
  }

  async #slot(): Promise<boolean> {
    if (this.#running < this.#limits.concurrency) {
      this.#running++;
      return true;
    }
    if (this.#queue.length >= this.#limits.maxQueue) return false;
    // The slot is handed over by the one that frees it, so the number running never goes past the limit.
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    return true;
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#running--;
  }

  async #refresh(url: string): Promise<TrimAnswer> {
    if (!(await this.#slot())) return this.#logged(url, text(503, "Busy; try again shortly.", { "retry-after": "60" }), "busy", 0, false);
    const started = this.#now();
    let result: Fetched;
    try {
      // The last good answer is what a 304 repeats; it is held here, so it stays whatever else is evicted while the publisher answers.
      const prior = this.#states.get(url)?.good ?? null;
      result = (await this.#fetchAndTrim(url, prior)) ?? (await this.#fetchAndTrim(url, null))!;
    } catch {
      result = { answer: text(502, "This feed could not be read just now."), outcome: "error", retryable: true };
    } finally {
      this.#release();
    }
    const ms = this.#now() - started;
    if (result.answer.status === 200 && result.validators) {
      const validators = result.validators;
      this.#commit(url, (s) => {
        s.good = { at: this.#now(), answer: result.answer, ...validators };
        s.failure = null;
      });
      return this.#logged(url, result.answer, result.outcome, ms, false, result.more);
    }
    let answer = result.answer;
    const state = this.#commit(url, (s) => {
      // What won't change by itself (not a feed) is remembered too, so the engine's retries do not each cost a read.
      const streak = (s.failure?.streak ?? 0) + 1;
      const wait = Math.min(this.#limits.backoffMs * 2 ** (streak - 1), this.#limits.maxBackoffMs);
      s.failure = { until: this.#now() + wait, streak, answer, retryable: result.retryable };
    });
    // A feed that answered before keeps its last good answer while its host is failing.
    if (result.retryable && state.good) answer = state.good.answer;
    return this.#logged(url, answer, result.outcome, ms, false, result.more);
  }

  /** One fetch of the feed; null when the publisher's 304 can't be used (it came from another address than the kept answer), so the caller reads it again, unconditionally. */
  async #fetchAndTrim(url: string, prior: Good | null): Promise<Fetched | null> {
    const trimmer = new FeedTrimmer(this.#limits.trim);
    let read = 0;
    let collected = 0;
    const conditional: Record<string, string> = {};
    if (prior?.etag) conditional["if-none-match"] = prior.etag;
    if (prior?.lastModified) conditional["if-modified-since"] = prior.lastModified;
    const res = await this.#fetch(url, {
      ...this.#test,
      headers: conditional,
      // The trimmer stops reading at its own ceiling and serves what it kept; this one is only the most a transfer may be. What the feed
      // declares is not a reason to refuse it (a big feed is read as far as is useful), so only the bytes that actually arrive count.
      maxBytes: HARD_STREAM_BYTES,
      streamPastDeclaredLength: true,
      timeoutMs: this.#limits.timeoutMs,
      phaseTimeoutsMs: { firstByteMs: 15_000, idleMs: 15_000 },
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
      sink: (chunk) => {
        const verdict = trimmer.write(chunk);
        read += chunk.length;
        if (!verdict && read - collected >= COLLECT_EVERY) {
          collected = read;
          collectGarbage();
        }
        return verdict;
      },
    });
    // What was read is garbage now (and the next fetch's would pile on it): clear it before the answer goes out.
    if (read - collected >= COLLECT_AFTER) collectGarbage();
    if (!res.ok) {
      switch (res.reason) {
        case "blocked":
          return { answer: text(403, "This address is not one this service fetches."), outcome: "blocked", retryable: false };
        case "toolarge":
          // Bytes went on arriving past the most a transfer may be (HARD_STREAM_BYTES) without the trimmer stopping, which it does at its own, lower ceiling. The engine is told as for any answer that can't be read.
          return { answer: text(502, "The feed's host sent an answer that could not be read."), outcome: "too_large", retryable: false };
        case "timeout":
          return { answer: text(504, "The feed's host took too long to answer."), outcome: "timeout", retryable: true };
        case "invalid":
          return { answer: text(502, "The feed's host sent an answer that could not be read."), outcome: "invalid", retryable: true };
        default:
          return { answer: text(502, "The feed's host could not be reached."), outcome: "unreachable", retryable: true };
      }
    }
    const r = res.response;
    if (r.status === 304 && prior && Object.keys(conditional).length > 0) {
      // Unchanged: the answer kept is still the feed's. It carries the address it was read from, so it is only reused for that one.
      if (r.url !== prior.base) return null;
      return { answer: prior.answer, outcome: "not_modified", retryable: false, validators: { etag: prior.etag, lastModified: prior.lastModified, base: prior.base }, more: { bytes: 0 } };
    }
    if (r.status < 200 || r.status >= 300) return this.#upstreamStatus(r.status, r.headers["retry-after"]);
    const trimmed = trimmer.finish(r.url, parseContentType(r.contentType).charset);
    if (!trimmed.ok) {
      const permanent = trimmed.reason !== "empty";
      return { answer: failureAnswer(trimmed.reason), outcome: trimmed.reason, retryable: !permanent, more: { bytes: trimmed.bytesRead } };
    }
    const upstreamType = parseContentType(r.contentType).mediaType;
    const contentType = XML_TYPES.has(upstreamType) && r.contentType ? r.contentType : trimmed.root === "feed" ? "application/atom+xml" : "application/rss+xml";
    return {
      answer: { status: 200, headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: trimmed.body },
      outcome: "ok",
      retryable: false,
      validators: { etag: validator(r.headers.etag), lastModified: validator(r.headers["last-modified"]), base: r.url },
      more: { kept: trimmed.kept, seen: trimmed.seen, bytes: trimmed.bytesRead, skipped: trimmed.tooBig, complete: trimmed.complete ? 1 : 0, capped: trimmed.capped ? 1 : 0 },
    };
  }

  /** What the feed's own host said, in the statuses the engine understands (404/410 gone, 403 refused, 429 slow down, the rest "not answering"). */
  #upstreamStatus(status: number, retryAfter: string | undefined): Fetched {
    if (status === 404 || status === 410) return { answer: text(status, "There is no feed at this address."), outcome: `http_${status}`, retryable: false };
    if (status === 401 || status === 403) return { answer: text(403, "The feed's host refused the request."), outcome: `http_${status}`, retryable: false };
    if (status === 429) {
      const wait = Math.min(Math.max(Number(retryAfter) || 60, 1), 3600);
      return { answer: text(429, "The feed's host is limiting requests.", { "retry-after": String(wait) }), outcome: "http_429", retryable: true };
    }
    return { answer: text(502, `The feed's host answered ${status >= 500 ? "with an error" : "with something other than a feed"}.`), outcome: `http_${status}`, retryable: status >= 500 };
  }
}
