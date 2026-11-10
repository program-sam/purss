import http from "node:http";
import { bridgeService, bridgeSignatureMatches, parseFeed } from "@purss/connectors";
import type { BridgeService, FeedItem } from "@purss/connectors";
import { boundEntry, serializeFeed, serializeItem } from "../gateway/rss.ts";
import type { StagedEntry } from "../gateway/types.ts";
import type { BridgeLog, FetchOutcome, FetchPhase } from "./log.ts";

/*
 * The bridge router (plan/41). It answers the engine's signed source addresses
 * (`/b/<service>/<key>/<signature>`) by asking the service's backends in order (RSS-Bridge in this
 * build), and re-serves the result as RSS in which every entry's id comes from its post address, so
 * a source keeps its items whichever backend answered. Upstream work is bounded: one fetch per
 * source at a time (concurrent requests share it), a few fetches at once overall, a short cache of
 * good answers (public content only), and a back-off after a failure during which the last good
 * answer, or the failure, is repeated. A failure is never served as an empty feed.
 */

export type BridgeBackend = {
  /** Recorded in the fetch log. */
  name: string;
  /** Fetch a source's feed: the body and status, or a transport failure. */
  fetch(service: BridgeService, key: string): Promise<{ status: number; body: Buffer } | { failed: "timeout" | "too_large" | "unreachable" }>;
};

export type RouterLimits = {
  /** How long a good answer is reused. */
  cacheMs: number;
  /** First back-off after a failure; doubles while failures continue, up to maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
  /** Backend fetches running at once. */
  concurrency: number;
  /** Requests waiting for a free backend slot; beyond that the answer is "busy". */
  maxQueue: number;
  /** Entries per answer. */
  maxItems: number;
  maxEntryBytes: number;
  /** Sources whose state (last good answer, back-off) is kept, least recently used out. */
  maxCached: number;
  /** Bytes of good answers kept in all; the least recently used are dropped first (egress runs in 160 MiB). */
  maxCachedBytes: number;
};

export const DEFAULT_ROUTER_LIMITS: RouterLimits = {
  cacheMs: 10 * 60_000,
  backoffMs: 5 * 60_000,
  maxBackoffMs: 60 * 60_000,
  concurrency: 4,
  maxQueue: 64,
  maxItems: 50,
  maxEntryBytes: 256 * 1024,
  maxCached: 2000,
  maxCachedBytes: 24 * 1024 * 1024,
};

export type RouterAnswer = { status: number; headers: Record<string, string>; body: string };

type Good = { at: number; body: string; entries: number };
type State = { good: Good | null; failure: { at: number; until: number; streak: number; outcome: FetchOutcome } | null };

const XML = "application/rss+xml; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const NOT_FOUND: RouterAnswer = { status: 404, headers: { "content-type": TEXT }, body: "Not found.\n" };

export class BridgeRouter {
  #secret: string;
  #backends: readonly BridgeBackend[];
  #log: BridgeLog;
  #now: () => number;
  #limits: RouterLimits;
  #states = new Map<string, State>();
  #cachedBytes = 0;
  #inflight = new Map<string, Promise<RouterAnswer>>();
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(opts: { secret: string; backends: readonly BridgeBackend[]; log: BridgeLog; now?: () => number; limits?: Partial<RouterLimits> }) {
    if (opts.secret.length < 32) throw new Error("The bridge key must be at least 32 characters.");
    this.#secret = opts.secret;
    this.#backends = opts.backends;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#limits = { ...DEFAULT_ROUTER_LIMITS, ...opts.limits };
  }

  /** Answer a signed source address. Anything unsigned, unknown or malformed is the same 404. */
  async serve(serviceId: string, rawKey: string, signature: string): Promise<RouterAnswer> {
    const service = bridgeService(serviceId);
    let key: string;
    try { key = decodeURIComponent(rawKey); } catch { return NOT_FOUND; }
    if (!service || !service.keyPattern.test(key) || !bridgeSignatureMatches(this.#secret, service.id, key, signature)) return NOT_FOUND;

    const id = `${service.id}/${key}`;
    const running = this.#inflight.get(id);
    if (running) return running;
    const state = this.#touch(id);
    const now = this.#now();
    if (state?.good && now - state.good.at < this.#limits.cacheMs) return this.#cached(service, key, state.good);
    if (state?.failure && now < state.failure.until) {
      if (state.good) return this.#cached(service, key, state.good);
      this.#log.record({ service: service.id, key, backend: "-", phase: "backend", outcome: state.failure.outcome, entries: 0, ms: 0, cached: true });
      return this.#failure(state.failure.until - now);
    }
    const work = this.#refresh(service, key, id).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, work);
    return work;
  }

  /** A source's state, marked as just used, or undefined when nothing is known about it. */
  #touch(id: string): State | undefined {
    const s = this.#states.get(id);
    if (s) {
      this.#states.delete(id);
      this.#states.set(id, s);
    }
    return s;
  }

  /** Record what a finished fetch learned. Only work that reached a backend writes state, so a request turned away as busy evicts nothing. */
  #commit(id: string, update: (s: State) => void): State {
    const s = this.#touch(id) ?? { good: null, failure: null };
    this.#states.set(id, s);
    this.#cachedBytes -= s.good ? Buffer.byteLength(s.good.body) : 0;
    update(s);
    this.#cachedBytes += s.good ? Buffer.byteLength(s.good.body) : 0;
    // Least recently used first; a source with a fetch under way keeps its state.
    for (const [other, st] of this.#states) {
      if (this.#states.size <= this.#limits.maxCached && this.#cachedBytes <= this.#limits.maxCachedBytes) break;
      if (other === id || this.#inflight.has(other)) continue;
      if (this.#states.size > this.#limits.maxCached) {
        this.#cachedBytes -= st.good ? Buffer.byteLength(st.good.body) : 0;
        this.#states.delete(other);
      } else if (st.good) {
        this.#cachedBytes -= Buffer.byteLength(st.good.body);
        st.good = null;
      }
    }
    // An answer bigger than the whole budget is served once and not kept.
    if (this.#cachedBytes > this.#limits.maxCachedBytes && s.good) {
      this.#cachedBytes -= Buffer.byteLength(s.good.body);
      s.good = null;
    }
    return s;
  }

  #cached(service: BridgeService, key: string, good: Good): RouterAnswer {
    this.#log.record({ service: service.id, key, backend: "-", phase: "backend", outcome: good.entries ? "ok" : "empty", entries: good.entries, ms: 0, cached: true });
    return { status: 200, headers: { "content-type": XML, "cache-control": "no-store" }, body: good.body };
  }

  #failure(retryMs: number): RouterAnswer {
    return { status: 503, headers: { "content-type": TEXT, "retry-after": String(Math.max(1, Math.ceil(retryMs / 1000))) }, body: "This source could not be collected just now.\n" };
  }

  async #slot(): Promise<boolean> {
    if (this.#running < this.#limits.concurrency) {
      this.#running++;
      return true;
    }
    if (this.#queue.length >= this.#limits.maxQueue) return false;
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#running++;
    return true;
  }

  #release(): void {
    this.#running--;
    this.#queue.shift()?.();
  }

  async #refresh(service: BridgeService, key: string, id: string): Promise<RouterAnswer> {
    if (!(await this.#slot())) return this.#failure(60_000);
    let last: { outcome: FetchOutcome } = { outcome: "unreachable" };
    try {
      for (const backend of this.#backends) {
        const started = this.#now();
        const result = await this.#ask(backend, service, key);
        const ms = this.#now() - started;
        this.#log.record({ service: service.id, key, backend: backend.name, phase: result.phase, outcome: result.outcome, entries: result.entries?.length ?? 0, ms, cached: false });
        if (result.entries) {
          const body = this.#render(service, key, result.title, result.entries);
          const entries = result.entries.length;
          this.#commit(id, (s) => {
            s.good = { at: this.#now(), body, entries };
            s.failure = null;
          });
          return { status: 200, headers: { "content-type": XML, "cache-control": "no-store" }, body };
        }
        last = result;
      }
    } finally {
      this.#release();
    }
    let wait = 0;
    const state = this.#commit(id, (s) => {
      const streak = (s.failure?.streak ?? 0) + 1;
      wait = Math.min(this.#limits.backoffMs * 2 ** (streak - 1), this.#limits.maxBackoffMs);
      s.failure = { at: this.#now(), until: this.#now() + wait, streak, outcome: last.outcome };
    });
    // A source that answered before keeps its last good answer while the backend is failing.
    if (state.good) return { status: 200, headers: { "content-type": XML, "cache-control": "no-store" }, body: state.good.body };
    return this.#failure(wait);
  }

  async #ask(backend: BridgeBackend, service: BridgeService, key: string): Promise<{ phase: FetchPhase; outcome: FetchOutcome; entries?: StagedEntry[]; title?: string | null }> {
    let r: Awaited<ReturnType<BridgeBackend["fetch"]>>;
    try {
      r = await backend.fetch(service, key);
    } catch {
      return { phase: "backend", outcome: "unreachable" };
    }
    if ("failed" in r) return { phase: "backend", outcome: r.failed };
    if (r.status !== 200) return { phase: "backend", outcome: `http_${r.status}` };
    let parsed;
    try {
      parsed = parseFeed(r.body, "application/atom+xml", { maxItems: this.#limits.maxItems });
    } catch {
      return { phase: "parse", outcome: "parse_error" };
    }
    const entries: StagedEntry[] = [];
    let recognised = 0;
    for (const item of parsed.items) {
      const entry = this.#entry(service, key, item);
      if (entry) entries.push(entry);
      if (entry || this.#excluded(service, key, item)) recognised++;
    }
    // Entries none of which is a post of this source or one the service's rule leaves out on purpose: the backend's output changed shape.
    if (parsed.items.length > 0 && recognised === 0) return { phase: "identity", outcome: "no_ids" };
    return { phase: "backend", outcome: entries.length ? "ok" : "empty", entries, title: parsed.title };
  }

  #excluded(service: BridgeService, key: string, item: FeedItem): boolean {
    try { return service.excluded?.(key, new URL(item.url ?? "")) ?? false; } catch { return false; }
  }

  #entry(service: BridgeService, key: string, item: FeedItem): StagedEntry | null {
    let link: URL;
    try { link = new URL(item.url ?? ""); } catch { return null; }
    const guid = service.postId(key, link);
    if (!guid) return null;
    link.hash = "";
    return {
      guid,
      title: item.title ?? "",
      url: link.toString(),
      author: item.author,
      publishedAt: item.publishedAt && service.dateCorrectionMinutes
        ? new Date(Date.parse(item.publishedAt) + service.dateCorrectionMinutes * 60_000).toISOString()
        : item.publishedAt,
      summaryHtml: item.summaryHtml && service.cleanHtml ? service.cleanHtml(item.summaryHtml) : item.summaryHtml,
      contentHtml: item.contentHtml && service.cleanHtml ? service.cleanHtml(item.contentHtml) : item.contentHtml,
      imageUrl: item.imageUrl,
      enclosures: item.enclosures,
    };
  }

  #render(service: BridgeService, key: string, title: string | null | undefined, entries: StagedEntry[]): string {
    const items = entries.map((e) => {
      const b = boundEntry(e, { maxEntryBytes: this.#limits.maxEntryBytes });
      return serializeItem(b.entry, b.limited);
    });
    const raw = title?.trim() ?? "";
    const name = (raw && service.cleanTitle ? service.cleanTitle(raw) : raw) || `${key} on ${service.name}`;
    return serializeFeed({ title: name, siteUrl: service.pageUrl(key), description: `${service.origin} ${key}` }, items, new Date(this.#now()));
  }
}

/** RSS-Bridge as a backend: the service's bridge and parameters, Atom out, errors as HTTP statuses. */
export function rssBridgeBackend(baseUrl: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): BridgeBackend {
  const base = new URL(baseUrl);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  return {
    name: "rss-bridge",
    fetch(service, key) {
      const url = new URL("/", base);
      url.searchParams.set("action", "display");
      url.searchParams.set("format", "Atom");
      url.searchParams.set("bridge", service.rssBridge.bridge);
      for (const [k, v] of Object.entries(service.rssBridge.params(key))) url.searchParams.set(k, v);
      return new Promise((resolve) => {
        let settled = false;
        const done = (v: { status: number; body: Buffer } | { failed: "timeout" | "too_large" | "unreachable" }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        const req = http.get(url, { headers: { accept: "application/atom+xml" } }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy();
              done({ failed: "too_large" });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", () => done({ failed: "unreachable" }));
        });
        const timer = setTimeout(() => {
          req.destroy();
          done({ failed: "timeout" });
        }, timeoutMs);
        req.on("error", () => done({ failed: "unreachable" }));
      });
    },
  };
}
