import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawStreamItem, StreamContentsOptions, StreamPage } from "../greader.ts";

/**
 * In-memory stand-in for the parts of FreshRSS's GReader API the product uses, implementing the paging, continuation
 * and lower-bound rules read from the pinned engine's source (p/api/greader.php, EntryDAO). It is test
 * infrastructure only; the real behaviour is pinned by tests/engine against the container.
 */
export type FakeEntry = {
  id: bigint; // first-crawl time in microseconds
  feedId: number;
  title: string;
  content: string;
  link: string;
  author?: string;
  published?: number;
  lastModified: number; // seconds
  read?: boolean;
  starred?: boolean;
  enclosures?: Array<{ href: string; type?: string; length?: number }>;
};

export type FakeFeed = { id: number; url: string; title: string };

export class FakeEngine {
  readonly feeds: FakeFeed[] = [];
  readonly entries: FakeEntry[] = [];
  readonly requests: Array<{ method: string; path: string; query: Record<string, string>; form: URLSearchParams | null }> = [];
  users = new Map<string, string>([["user1", "pw-user1-0123456789abcdef"]]);
  /** Called before each request; may throw an HTTP status via `failWith`. */
  failNext: { status: number; remaining: number } | null = null;
  delayMs = 0;
  /** Concurrent requests currently being handled, and the highest value seen. */
  inFlight = 0;
  peakInFlight = 0;
  #nextFeed = 1;

  addFeed(url: string, title: string): FakeFeed {
    const feed = { id: this.#nextFeed++, url, title };
    this.feeds.push(feed);
    return feed;
  }

  addEntry(e: Omit<FakeEntry, "lastModified"> & { lastModified?: number }): FakeEntry {
    const entry: FakeEntry = { lastModified: Number(e.id / 1_000_000n), ...e };
    this.entries.push(entry);
    return entry;
  }

  /** Same selection and paging as the engine's stream contents for the reading list, or for one feed's stream. */
  page(opts: StreamContentsOptions, feedId?: number): StreamPage {
    const ot = opts.newerThanSeconds ?? 0;
    let list = this.entries.filter((e) => (feedId === undefined || e.feedId === feedId) && (ot === 0 || e.id >= BigInt(ot) * 1_000_000n || e.lastModified >= ot));
    if (opts.excludeRead) list = list.filter((e) => !e.read);
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (opts.order === "desc") list.reverse();
    const c = opts.continuation ? BigInt(opts.continuation) : null;
    let count = opts.count;
    if (c !== null) {
      list = list.filter((e) => (opts.order === "asc" ? e.id >= c : e.id <= c));
      count += 1;
    }
    let slice = list.slice(0, count);
    if (c !== null) {
      slice = slice.slice(1); // the engine discards the first element: it was "already sent"
      count -= 1;
    }
    const items = slice.map((e) => this.#raw(e));
    const last = slice.at(-1);
    return { items, continuation: slice.length >= count && last ? last.id.toString() : null };
  }

  #raw(e: FakeEntry): RawStreamItem {
    const feed = this.feeds.find((f) => f.id === e.feedId);
    return {
      id: `tag:google.com,2005:reader/item/${e.id.toString(16).padStart(16, "0")}`,
      timestampUsec: e.id.toString(),
      crawlTimeMsec: (e.id / 1000n).toString(),
      published: e.published ?? Number(e.id / 1_000_000n),
      title: e.title,
      author: e.author,
      canonical: [{ href: e.link }],
      alternate: [{ href: e.link }],
      summary: { content: e.content },
      origin: { streamId: `feed/${e.feedId}`, title: feed?.title, htmlUrl: "" },
      enclosure: e.enclosures,
      categories: ["user/-/state/com.google/reading-list"],
    };
  }

  /** Starts an HTTP server speaking the subset of the API the client uses. */
  async listen(): Promise<{ baseUrl: string; close(): Promise<void>; server: Server }> {
    const server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      server,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  }

  async #handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const form = req.method === "POST" ? new URLSearchParams(body) : null;
    const query = Object.fromEntries(url.searchParams);
    const path = url.pathname.replace(/^\/api\/greader\.php/, "");
    this.requests.push({ method: req.method ?? "GET", path, query, form });
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    res.on("close", () => { this.inFlight -= 1; });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const send = (status: number, text: string, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(text);
    };
    if (this.failNext && this.failNext.remaining > 0 && path !== "/accounts/ClientLogin") {
      this.failNext.remaining -= 1;
      return send(this.failNext.status, "fail", "text/plain");
    }
    if (path === "/accounts/ClientLogin") {
      const email = form?.get("Email") ?? "";
      const pw = form?.get("Passwd") ?? "";
      if (this.users.get(email) !== pw) return send(401, "Unauthorized!", "text/plain");
      return send(200, `SID=${email}/auth\nLSID=null\nAuth=${email}/auth\n`, "text/plain");
    }
    const auth = req.headers.authorization ?? "";
    const m = /^GoogleLogin auth=([^/]+)\/auth$/.exec(auth);
    if (!m || !this.users.has(m[1]!)) return send(401, "Unauthorized!", "text/plain");
    if (path === "/reader/api/0/token") return send(200, "T".repeat(57) + "\n", "text/plain");
    if (path === "/reader/api/0/user-info") return send(200, JSON.stringify({ userId: m[1], userName: m[1], userProfileId: m[1], userEmail: "" }));
    if (path === "/reader/api/0/subscription/list") {
      return send(200, JSON.stringify({ subscriptions: this.feeds.map((f) => ({ id: `feed/${f.id}`, title: f.title, url: f.url, htmlUrl: "", categories: [{ id: "user/-/label/Uncategorized", label: "Uncategorized" }] })) }));
    }
    if (path === "/reader/api/0/subscription/quickadd") {
      const target = form?.get("quickadd") ?? "";
      if (this.feeds.some((f) => f.url === target)) return send(200, JSON.stringify({ numResults: 0, error: "FreshRSS_AlreadySubscribed_Exception: already subscribed" }));
      if (target.includes("broken")) return send(200, JSON.stringify({ numResults: 0, error: `Retrieved unsupported status code "404" [${target}]` }));
      // The engine's own wording when the feed's site answers 429 (seen for Reddit feeds).
      if (target.includes("limited")) return send(200, JSON.stringify({ numResults: 0, error: "HTTP 429 Too Many Requests!" }));
      if (target.includes("flaky")) return send(200, JSON.stringify({ numResults: 0, error: `cURL error 7: Failed to connect to 169.254.1.2 port 8946 [${target}]` }));
      const feed = this.addFeed(target, new URL(target).hostname);
      return send(200, JSON.stringify({ numResults: 1, query: target, streamId: `feed/${feed.id}`, streamName: feed.title }));
    }
    if (path === "/reader/api/0/subscription/edit") {
      const s = form?.get("s") ?? "";
      const feed = this.feeds.find((f) => `feed/${f.id}` === s);
      // The engine answers 400 for an unknown stream on unsubscribe but silently accepts a rename of one (observed).
      if (!feed) return form?.get("ac") === "edit" ? send(200, "OK", "text/plain") : send(400, "Bad Request!", "text/plain");
      if (form?.get("ac") === "unsubscribe") this.feeds.splice(this.feeds.indexOf(feed), 1);
      if (form?.get("ac") === "edit" && form.get("t")) feed.title = form.get("t")!;
      return send(200, "OK", "text/plain");
    }
    if (path.startsWith("/reader/api/0/stream/contents/")) {
      const feed = /^\/reader\/api\/0\/stream\/contents\/feed\/(\d+)$/.exec(path);
      const page = this.page({
        count: Number(query.n ?? 20),
        order: query.r === "o" ? "asc" : "desc",
        continuation: query.c ?? null,
        newerThanSeconds: query.ot ? Number(query.ot) : null,
        excludeRead: query.xt === "user/-/state/com.google/read",
      }, feed ? Number(feed[1]) : undefined);
      return send(200, JSON.stringify({ id: "user/-/state/com.google/reading-list", updated: 1, items: page.items, ...(page.continuation ? { continuation: page.continuation } : {}) }));
    }
    if (path === "/reader/api/0/edit-tag") {
      const ids = form?.getAll("i") ?? [];
      for (const e of this.entries) {
        if (!ids.includes(e.id.toString())) continue;
        for (const a of form?.getAll("a") ?? []) {
          if (a.endsWith("/read")) e.read = true;
          if (a.endsWith("/starred")) e.starred = true;
        }
        for (const r of form?.getAll("r") ?? []) {
          if (r.endsWith("/read")) e.read = false;
          if (r.endsWith("/starred")) e.starred = false;
        }
      }
      return send(200, "OK", "text/plain");
    }
    return send(400, "Bad Request!", "text/plain");
  }
}
