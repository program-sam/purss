import { EngineError } from "./errors.ts";

/**
 * Typed client for FreshRSS's Google-Reader-compatible API (`/api/greader.php`), written against the
 * pinned build (see CAPABILITIES.md). Only the endpoints the product needs are implemented.
 * Credentials stay inside this object; they never appear in thrown errors.
 */

export const STATE_READ = "user/-/state/com.google/read";
export const STATE_STARRED = "user/-/state/com.google/starred";
export const READING_LIST = "user/-/state/com.google/reading-list";

export type GReaderOptions = {
  /** Engine root, e.g. `http://127.0.0.1:8941`. */
  baseUrl: string;
  username: string;
  apiPassword: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /** Aborts every request made by this client. */
  signal?: AbortSignal;
};

export type EngineSubscription = {
  streamId: string; // "feed/12"
  title: string;
  url: string;
  htmlUrl: string;
  category: string | null;
};

export type RawStreamItem = {
  id: string; // "tag:google.com,2005:reader/item/<16 hex>"
  timestampUsec: string;
  crawlTimeMsec?: string;
  published?: number;
  title?: string;
  author?: string;
  canonical?: Array<{ href?: string }>;
  alternate?: Array<{ href?: string }>;
  summary?: { content?: string };
  content?: { content?: string };
  origin?: { streamId?: string; title?: string; htmlUrl?: string };
  enclosure?: Array<{ href?: string; type?: string; length?: number | string }>;
  categories?: string[];
};

export type StreamPage = { items: RawStreamItem[]; continuation: string | null };

export type StreamContentsOptions = {
  /** Page size; the engine honours any positive value, the product asks for at most 500. */
  count: number;
  /** `asc` walks oldest-crawled first, the only order a forward-resumable sync can use. */
  order: "asc" | "desc";
  /** Continuation token from the previous page (an engine item id; inclusive, first element discarded by the engine). */
  continuation?: string | null;
  /** Unix seconds lower bound: entries first crawled at/after it OR modified at/after it. */
  newerThanSeconds?: number | null;
  /** Restrict to unread items. */
  excludeRead?: boolean;
};

export class GReaderClient {
  readonly #base: string;
  readonly #username: string;
  readonly #password: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #signal: AbortSignal | undefined;
  #auth: string | null = null;
  #token: string | null = null;

  constructor(opts: GReaderOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "") + "/api/greader.php";
    this.#username = opts.username;
    this.#password = opts.apiPassword;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeout = opts.requestTimeoutMs ?? 30_000;
    this.#signal = opts.signal;
  }

  /** Verifies the credentials; throws `auth` when rejected. */
  async login(): Promise<void> {
    const body = new URLSearchParams({ Email: this.#username, Passwd: this.#password });
    const text = await this.#send("POST", "/accounts/ClientLogin", { form: body, authenticated: false });
    const match = /^Auth=(.+)$/m.exec(text);
    if (!match?.[1]) throw new EngineError("protocol", "The engine's login response did not contain an Auth value.");
    this.#auth = match[1].trim();
    this.#token = null;
  }

  async userInfo(): Promise<{ userId: string; userName: string }> {
    const json = await this.#json("GET", "/reader/api/0/user-info");
    const o = asRecord(json, "user-info");
    return { userId: str(o.userId, "user-info.userId"), userName: str(o.userName, "user-info.userName") };
  }

  async listSubscriptions(): Promise<EngineSubscription[]> {
    const json = asRecord(await this.#json("GET", "/reader/api/0/subscription/list", { query: { output: "json" } }), "subscription/list");
    const list = Array.isArray(json.subscriptions) ? json.subscriptions : null;
    if (!list) throw new EngineError("protocol", "The engine's subscription list had an unexpected shape.");
    return list.map((raw) => {
      const o = asRecord(raw, "subscription");
      const categories = Array.isArray(o.categories) ? o.categories : [];
      const first = categories[0] && typeof categories[0] === "object" ? (categories[0] as Record<string, unknown>) : null;
      return {
        streamId: str(o.id, "subscription.id"),
        title: typeof o.title === "string" ? o.title : "",
        url: typeof o.url === "string" ? o.url : "",
        htmlUrl: typeof o.htmlUrl === "string" ? o.htmlUrl : "",
        category: first && typeof first.label === "string" ? first.label : null,
      };
    });
  }

  /**
   * Subscribes to a feed URL through the engine's quick-add. The engine fetches the feed itself (through its
   * configured egress proxy) and may resolve an HTML page to its feed. Returns `already` when the engine
   * already holds a subscription for that URL (the caller then looks it up in the list).
   */
  async quickAdd(url: string): Promise<{ streamId: string; title: string; feedUrl: string } | { already: true; message: string }> {
    const form = new URLSearchParams({ quickadd: url });
    const json = asRecord(await this.#json("POST", "/reader/api/0/subscription/quickadd", { form }), "quickadd");
    if (json.numResults === 1 && typeof json.streamId === "string") {
      return { streamId: json.streamId, title: typeof json.streamName === "string" ? json.streamName : "", feedUrl: typeof json.query === "string" ? json.query : url };
    }
    const message = typeof json.error === "string" ? json.error : "";
    if (/already subscribed/i.test(message)) return { already: true, message: "already subscribed" };
    throw quickAddFailure(message, url);
  }

  async unsubscribe(streamId: string): Promise<void> {
    await this.#edit({ ac: "unsubscribe", s: streamId });
  }

  async renameSubscription(streamId: string, title: string): Promise<void> {
    await this.#edit({ ac: "edit", s: streamId, t: title });
  }

  /** Items of the reading list, one page. */
  async streamContents(opts: StreamContentsOptions): Promise<StreamPage> {
    const query: Record<string, string> = { n: String(opts.count), r: opts.order === "asc" ? "o" : "d" };
    if (opts.continuation) query.c = opts.continuation;
    if (opts.newerThanSeconds != null && opts.newerThanSeconds > 0) query.ot = String(Math.floor(opts.newerThanSeconds));
    if (opts.excludeRead) query.xt = STATE_READ;
    const json = asRecord(await this.#json("GET", `/reader/api/0/stream/contents/${READING_LIST}`, { query }), "stream/contents");
    if (!Array.isArray(json.items)) throw new EngineError("protocol", "The engine's stream response had no item list.");
    const items = json.items.map((raw) => validateItem(raw));
    const continuation = typeof json.continuation === "string" && /^\d+$/.test(json.continuation) ? json.continuation : null;
    return { items, continuation };
  }

  /**
   * Whether the engine holds any item of one subscription (its own stream, not the whole reading list). The engine fetches
   * a feed when it adds it, so right after a subscribe this says whether that fetch found anything.
   */
  async feedHasItems(streamId: string): Promise<boolean> {
    if (!/^feed\/\d{1,12}$/.test(streamId)) throw new EngineError("bad_request", "That is not an engine subscription id.", { retryable: false });
    const json = asRecord(await this.#json("GET", `/reader/api/0/stream/contents/${streamId}`, { query: { n: "1", r: "d" } }), "stream/contents");
    if (!Array.isArray(json.items)) throw new EngineError("protocol", "The engine's stream response had no item list.");
    return json.items.length > 0;
  }

  /** Sets or clears the engine's read flag. `externalIds` are the decimal ids produced by the normaliser. */
  async markRead(externalIds: readonly string[], read: boolean): Promise<void> {
    await this.#editTag(externalIds, read ? { add: [STATE_READ] } : { remove: [STATE_READ] });
  }

  async setStarred(externalIds: readonly string[], starred: boolean): Promise<void> {
    await this.#editTag(externalIds, starred ? { add: [STATE_STARRED] } : { remove: [STATE_STARRED] });
  }

  async unreadCount(): Promise<number> {
    const json = asRecord(await this.#json("GET", "/reader/api/0/unread-count", { query: { output: "json" } }), "unread-count");
    return typeof json.max === "number" ? json.max : 0;
  }

  // -- plumbing ------------------------------------------------------------------------------------------

  async #editTag(ids: readonly string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) if (!/^\d{1,20}$/.test(id)) throw new EngineError("bad_request", "An engine item id was not a decimal number.", { retryable: false });
    const token = await this.#actionToken();
    const form = new URLSearchParams();
    form.set("T", token);
    for (const id of ids) form.append("i", id);
    for (const a of change.add ?? []) form.append("a", a);
    for (const r of change.remove ?? []) form.append("r", r);
    const text = await this.#send("POST", "/reader/api/0/edit-tag", { form });
    if (text.trim() !== "OK") throw new EngineError("protocol", "The engine did not confirm the read/star change.");
  }

  async #edit(fields: Record<string, string>): Promise<void> {
    const form = new URLSearchParams(fields);
    const text = await this.#send("POST", "/reader/api/0/subscription/edit", { form });
    if (text.trim() !== "OK") throw new EngineError("protocol", "The engine did not confirm the subscription change.");
  }

  async #actionToken(): Promise<string> {
    if (this.#token) return this.#token;
    const text = await this.#send("GET", "/reader/api/0/token");
    this.#token = text.trim();
    return this.#token;
  }

  async #json(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; form?: URLSearchParams } = {}): Promise<unknown> {
    const text = await this.#send(method, path, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new EngineError("protocol", "The engine returned a response that is not valid JSON.");
    }
  }

  async #send(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; form?: URLSearchParams; authenticated?: boolean } = {},
    retried = false,
    reconnected = false,
  ): Promise<string> {
    const authenticated = opts.authenticated ?? true;
    if (authenticated && !this.#auth) await this.login();
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (authenticated && this.#auth) headers.authorization = `GoogleLogin auth=${this.#auth}`;
    let body: string | undefined;
    if (opts.form) {
      body = opts.form.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const signals = [AbortSignal.timeout(this.#timeout)];
    if (this.#signal) signals.push(this.#signal);
    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
    } catch (e) {
      if (this.#signal?.aborted) throw new EngineError("cancelled", "The request was cancelled.", { cause: e });
      // The engine's web server closes idle keep-alive connections; a request that lands on one that just closed fails
      // before any response. Every call this client makes is safe to repeat, so retry once on a fresh connection.
      if (!reconnected && isStaleConnection(e)) return this.#send(method, path, opts, retried, true);
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new EngineError("timeout", "The engine did not answer in time.", { cause: e });
      throw new EngineError("network", "The engine could not be reached.", { cause: e });
    }
    const text = await res.text();
    if (res.status === 401 && authenticated && !retried) {
      // The stored Auth value stops working when the API password is rotated; log in again once.
      this.#auth = null;
      return this.#send(method, path, opts, true, reconnected);
    }
    if (res.ok) return text;
    throw statusError(res.status);
  }
}

/**
 * The engine reports why a feed could not be added as free text that embeds the feed URL (which may be a capability link)
 * and cURL internals. Only the failure class is kept: a stable plain-language message and a retry decision.
 */
/** YouTube's feed endpoint answers 404 intermittently (more often from cloud servers); treat that as temporary. */
const isYoutubeFeed = (url: string) => /^https:\/\/(www\.)?youtube\.com\/feeds\/videos\.xml\?/.test(url);

export function quickAddFailure(message: string, url = ""): EngineError {
  const curl = /cURL error (\d+)/i.exec(message)?.[1];
  // The engine words an HTTP refusal in three ways: its own "HTTP 429 Too Many Requests!", and the library's
  // 'unsupported status code "429"' and "returned error: 429".
  const status = /unsupported status code "(\d{3})"/i.exec(message)?.[1] ?? /returned error: (\d{3})/i.exec(message)?.[1] ?? /\bHTTP (\d{3})\b/i.exec(message)?.[1];
  // cURL 63: the feed is larger than the engine will download.
  if (curl === "63" || /maximum file size|too large|too big/i.test(message)) {
    return new EngineError("rejected", "The feed is larger than the engine will read.", { retryable: false, reason: "too_large" });
  }
  if (curl && ["5", "6", "7", "18", "28", "35", "52", "55", "56"].includes(curl)) {
    return new EngineError("unavailable", `The engine could not reach the feed or its egress proxy (network error ${curl}); this will be retried.`, { retryable: true, reason: "unavailable" });
  }
  if (status) {
    const code = Number(status);
    if (code === 429) return new EngineError("rate_limited", "The feed's server is limiting requests (HTTP 429); this will be retried with a delay.", { retryable: true, reason: "rate_limited" });
    if (code >= 500) return new EngineError("unavailable", `The feed's server is not answering properly (HTTP ${code}); this will be retried.`, { retryable: true, reason: "unavailable" });
    if (code === 403) return new EngineError("rejected", "The feed's server, or the egress policy, refused the request (HTTP 403).", { retryable: false, reason: "refused" });
    if (code === 404 && isYoutubeFeed(url)) return new EngineError("unavailable", "YouTube didn't hand out this channel's feed just now (HTTP 404); this will be retried.", { retryable: true, reason: "unavailable" });
    if (code === 404 || code === 410) return new EngineError("rejected", `There is no feed at that address (HTTP ${code}).`, { retryable: false, reason: "not_found" });
    return new EngineError("rejected", `The address answered with HTTP ${code} instead of a feed.`, { retryable: false, reason: "not_a_feed" });
  }
  return new EngineError("rejected", "The address did not return a feed the engine could read.", { retryable: false, reason: "not_a_feed" });
}

function isStaleConnection(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function statusError(status: number): EngineError {
  if (status === 401) return new EngineError("auth", "The engine rejected the account's API credentials.", { status });
  if (status === 400) return new EngineError("bad_request", "The engine rejected the request as invalid.", { status });
  if (status === 429) return new EngineError("rate_limited", "The engine is rate limiting requests.", { status });
  if (status === 503) return new EngineError("api_disabled", "The engine's API is not available (disabled or starting).", { status, retryable: true });
  if (status >= 500) return new EngineError("unavailable", `The engine failed to handle the request (HTTP ${status}).`, { status });
  return new EngineError("protocol", `The engine answered with an unexpected HTTP status (${status}).`, { status });
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new EngineError("protocol", `The engine's ${what} response had an unexpected shape.`);
  return v as Record<string, unknown>;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new EngineError("protocol", `The engine's response was missing ${what}.`);
  return v;
}

function validateItem(raw: unknown): RawStreamItem {
  const o = asRecord(raw, "stream item");
  str(o.id, "item.id");
  if (typeof o.timestampUsec !== "string" || !/^\d+$/.test(o.timestampUsec)) throw new EngineError("protocol", "A stream item had no crawl timestamp.");
  return o as unknown as RawStreamItem;
}
