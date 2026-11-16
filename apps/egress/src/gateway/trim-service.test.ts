import assert from "node:assert/strict";
import type http from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { parseFeed, trimRoutePath } from "@purss/connectors";
import { startEgress } from "../server.ts";
import type { RunningEgress } from "../server.ts";
import type { LogEvent } from "../proxy.ts";
import { allowLoopback, gatewayGet, makeConfig, startUpstream } from "../testing.ts";
import type { TrimServeOptions } from "./trim-service.ts";
import type { Upstream } from "../testing.ts";

const KEY = "trim-key-".repeat(6);
const SECRET_QUERY = "token=s3cr3t-feed-key";

/** A podcast-like feed, newest first, in which every episode repeats its notes (as the big ones do). */
function podcast(count: number, order: "newest-first" | "oldest-first" | "shuffled" | "late-newest" = "newest-first"): string {
  const notes = "<p>Show notes with a link <a href=\"https://show.example\">here</a> and plenty of words. </p>".repeat(12);
  let ids = Array.from({ length: count }, (_, i) => i);
  if (order === "newest-first" || order === "late-newest") ids.reverse();
  // The first 200 episodes descending, the newest one after them, then the older ones, still descending.
  if (order === "late-newest") ids = [...ids.slice(1, 201), ids[0]!, ...ids.slice(201)];
  if (order === "shuffled") ids.sort((a, b) => ((a * 7919) % 1009) - ((b * 7919) % 1009));
  const items = ids.map((i) => `<item><title>Episode ${i}</title><guid isPermaLink="false">ep-${i}</guid><pubDate>${new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toUTCString()}</pubDate><enclosure url="https://cdn.example/${i}.mp3" length="1" type="audio/mpeg"/><description><![CDATA[${notes}]]></description><content:encoded><![CDATA[${notes}]]></content:encoded></item>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n<title>Big Show</title>\n<link>https://show.example/</link>\n<description>d</description>\n<itunes:author>Show Author</itunes:author>\n<itunes:image href="https://show.example/art.jpg"/>\n${items.join("")}</channel>\n</rss>\n`;
}

type Harness = { egress: RunningEgress; upstream: Upstream; logs: LogEvent[]; clock: { now: number }; url: (path: string) => string; get: (path: string) => ReturnType<typeof gatewayGet>; stop: () => Promise<void> };

async function harness(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, opts: { trimKey?: string | null; trimLimits?: TrimServeOptions; open?: boolean } = {}): Promise<Harness> {
  const upstream = await startUpstream(handler);
  const logs: LogEvent[] = [];
  const clock = { now: Date.parse("2026-11-16T12:00:00Z") };
  const egress = await startEgress(makeConfig({ trimKey: opts.trimKey === undefined ? KEY : opts.trimKey }), {
    log: (e) => logs.push(e),
    now: () => clock.now,
    // The ordinary address rules apply; only this test's own upstream (loopback) is let through, as in the other egress tests.
    ...(opts.open === false ? {} : { testAllowAddress: allowLoopback }),
    trimLimits: opts.trimLimits,
  });
  return {
    egress,
    upstream,
    logs,
    clock,
    url: (path) => `http://127.0.0.1:${upstream.port}${path}`,
    get: (path) => gatewayGet(egress.ports.gateway, path),
    stop: async () => {
      await egress.stop();
      await upstream.close();
    },
  };
}

const feedHandler = (body: string, extra: Record<string, string> = {}) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", ...extra });
  res.end(body);
};

test("a big feed is served trimmed: its newest items and its channel metadata, read in full", async () => {
  const doc = podcast(3000);
  let sent = 0;
  const h = await harness((req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml", "content-length": String(Buffer.byteLength(doc)) });
    // Written in pieces, as a publisher's server does.
    let at = 0;
    const next = () => {
      while (at < doc.length) {
        const piece = doc.slice(at, at + 65536);
        at += 65536;
        sent += piece.length;
        if (!res.write(piece)) return void res.once("drain", next);
      }
      res.end();
    };
    next();
    res.on("close", () => (at = Infinity));
  });
  try {
    const r = await h.get(trimRoutePath(KEY, h.url("/feed.xml")));
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /^application\/rss\+xml/);
    const parsed = parseFeed(r.body, "application/rss+xml", { maxItems: 1000 });
    assert.equal(parsed.items.length, 100);
    assert.equal(parsed.title, "Big Show");
    assert.deepEqual(parsed.items.slice(0, 2).map((i) => i.title), ["Episode 2999", "Episode 2998"]);
    assert.ok(r.body.includes('<itunes:image href="https://show.example/art.jpg"/>'), "the channel's own markup comes through");
    assert.ok(r.body.length < doc.length / 10, `${r.body.length} bytes for ${doc.length}`);
    const served = h.logs.find((e) => e.event === "gateway.trim" && e.outcome === "ok");
    assert.ok(served && served.kept === 100 && served.cached === false, JSON.stringify(h.logs));
    assert.equal(Number(served.bytes), doc.length, "nothing says the rest of the document is older, so all of it was read");
    assert.equal(sent, doc.length);
    assert.equal(served.complete, 1);
  } finally {
    await h.stop();
  }
});

test("a shuffled feed gives its newest items however they are listed; a gzipped answer is read decompressed", async () => {
  const doc = podcast(700, "shuffled");
  const h = await harness((req, res) => {
    res.writeHead(200, { "content-type": "application/xml", "content-encoding": "gzip" });
    res.end(gzipSync(doc));
  });
  try {
    const r = await h.get(trimRoutePath(KEY, h.url("/f")));
    assert.equal(r.status, 200);
    const titles = parseFeed(r.body, "application/xml", { maxItems: 1000 }).items.map((i) => i.title);
    assert.equal(titles.length, 100);
    assert.deepEqual(titles.slice(0, 3), ["Episode 699", "Episode 698", "Episode 697"]);
    assert.equal(titles.at(-1), "Episode 600");
  } finally {
    await h.stop();
  }
});

test("only addresses signed with this installation's key are answered, and everything else is the same 404", async () => {
  const h = await harness(feedHandler(podcast(20)));
  try {
    const good = trimRoutePath(KEY, h.url("/f"));
    assert.equal((await h.get(good)).status, 200);
    const [, , sig, encoded] = good.split("/");
    const notFound = await h.get("/t/" + "A".repeat(43) + "/" + encoded);
    const forged = [
      `/t/${"A".repeat(43)}/${encoded}`, // wrong signature
      `/t/${sig}/${Buffer.from(h.url("/other")).toString("base64url")}`, // a signature is for one address
      trimRoutePath("other-key-".repeat(5), h.url("/f")), // another installation's key
      `/t/${sig}`, // no address
      `/t/${sig}/${encoded}/extra`,
      `/t/short/${encoded}`,
      `/t/${sig}/${Buffer.from("file:///etc/passwd").toString("base64url")}`,
    ];
    for (const path of forged) {
      const r = await h.get(path);
      assert.equal(r.status, 404, path);
      assert.equal(r.body, notFound.body, "a forged address learns nothing");
    }
    assert.equal(h.upstream.requests.length, 1, "nothing but the signed address was fetched");
    const post = await gatewayGet(h.egress.ports.gateway, good, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await h.stop();
  }
});

test("an installation without the key answers no such address at all", async () => {
  const h = await harness(feedHandler(podcast(5)), { trimKey: null });
  try {
    assert.equal(h.egress.trim, null);
    assert.equal((await h.get(trimRoutePath(KEY, h.url("/f")))).status, 404);
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.stop();
  }
});

test("the address rules are safeFetch's: private and local addresses, and redirects to them, are refused", async () => {
  // No test allowance here: the upstream is on loopback, which no address rule lets through.
  const h = await harness(feedHandler(podcast(5)), { open: false });
  try {
    const direct = await h.get(trimRoutePath(KEY, h.url("/f")));
    assert.equal(direct.status, 403);
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/feed", "http://localhost/feed", "http://[::1]/feed", "http://feed-gateway.internal:8947/feeds/abc"]) {
      assert.equal((await h.get(trimRoutePath(KEY, target))).status, 403, target);
    }
    assert.equal(h.upstream.requests.length, 0);
  } finally {
    await h.stop();
  }
  const redirecting = await harness((req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/feed" });
    res.end();
  });
  try {
    const r = await redirecting.get(trimRoutePath(KEY, redirecting.url("/f")));
    assert.equal(r.status, 403, "a redirect into a private address is refused at the hop");
  } finally {
    await redirecting.stop();
  }
  // A redirect to another public place is followed, with the same rules at every hop and the same trimming.
  let landing = "";
  const hop = await harness((req, res) => {
    if (req.url === "/old") {
      res.writeHead(301, { location: landing });
      return void res.end();
    }
    feedHandler(podcast(300))(req, res);
  });
  try {
    landing = hop.url("/new");
    const r = await hop.get(trimRoutePath(KEY, hop.url("/old")));
    assert.equal(r.status, 200);
    assert.equal(parseFeed(r.body, "application/rss+xml", { maxItems: 1000 }).items.length, 100);
  } finally {
    await hop.stop();
  }
});

test("what goes wrong is told truthfully: the feed's own statuses, not a feed, too large, too slow", async () => {
  const huge = podcast(400, "shuffled");
  const h = await harness(
    (req, res) => {
      const path = req.url ?? "";
      if (path === "/gone") return void res.writeHead(404).end("no");
      if (path === "/refused") return void res.writeHead(403).end("no");
      if (path === "/down") return void res.writeHead(503).end("no");
      if (path === "/slow-down") return void res.writeHead(429, { "retry-after": "120" }).end("no");
      if (path === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end("<html><body>hello</body></html>");
      if (path === "/json") return void res.writeHead(200, { "content-type": "application/json" }).end('{"items":[]}');
      if (path === "/stall") return void res.writeHead(200, { "content-type": "application/rss+xml" }).write("<rss><channel>");
      if (path === "/huge") return void feedHandler(huge)(req, res);
      res.writeHead(404).end();
    },
    { trimLimits: { timeoutMs: 1500, trim: { maxBytes: 200_000 } } },
  );
  try {
    const status = async (p: string) => h.get(trimRoutePath(KEY, h.url(p)));
    assert.equal((await status("/gone")).status, 404);
    assert.equal((await status("/refused")).status, 403);
    assert.equal((await status("/down")).status, 502);
    const slow = await status("/slow-down");
    assert.equal(slow.status, 429);
    assert.equal(slow.headers["retry-after"], "120");
    assert.equal((await status("/page")).status, 422);
    assert.equal((await status("/json")).status, 422);
    const large = await status("/huge");
    assert.equal(large.status, 413);
    assert.match(large.body, /too large to follow/);
    const stalled = await status("/stall");
    assert.equal(stalled.status, 504);
    for (const p of ["/gone", "/down", "/page", "/huge"]) assert.doesNotMatch((await status(p)).body, /<rss|<item/, "a failure is never a feed");
  } finally {
    await h.stop();
  }
});

test("concurrent requests share one fetch; a good answer is reused for a while; a failing host is not hammered", async () => {
  const doc = podcast(500);
  let mode: "ok" | "down" = "ok";
  const h = await harness((req, res) => {
    if (mode === "down") return void res.writeHead(503).end("down");
    setTimeout(() => feedHandler(doc)(req, res), 50);
  });
  try {
    const path = trimRoutePath(KEY, h.url("/f"));
    const three = await Promise.all([h.get(path), h.get(path), h.get(path)]);
    assert.deepEqual(three.map((r) => r.status), [200, 200, 200]);
    assert.equal(h.upstream.requests.length, 1, "three requests, one fetch");
    assert.equal((await h.get(path)).status, 200);
    assert.equal(h.upstream.requests.length, 1, "reused");
    h.clock.now += 11 * 60_000;
    mode = "down";
    const stale = await h.get(path);
    assert.equal(h.upstream.requests.length, 2, "asked again after the good answer aged");
    assert.equal(stale.status, 200, "a feed that answered before keeps its last good answer while its host is down");
    assert.equal(parseFeed(stale.body, "application/rss+xml", { maxItems: 1000 }).items.length, 100);
    await h.get(path);
    await h.get(path);
    assert.equal(h.upstream.requests.length, 2, "and the host is left alone for the back-off");
    h.clock.now += 2 * 60_000;
    await h.get(path);
    assert.equal(h.upstream.requests.length, 3);
    // A feed that never answered is a failure, every time, never an empty feed.
    const never = trimRoutePath(KEY, h.url("/never"));
    const first = await h.get(never);
    const again = await h.get(never);
    assert.deepEqual([first.status, again.status], [502, 502]);
    assert.equal(h.upstream.requests.length, 4);
  } finally {
    await h.stop();
  }
});

test("fetches are bounded: a few at once, a short queue, then 'busy'", async () => {
  const release: (() => void)[] = [];
  const h = await harness(
    (req, res) => {
      release.push(() => feedHandler(podcast(5))(req, res));
    },
    { trimLimits: { concurrency: 1, maxQueue: 1 } },
  );
  try {
    const a = h.get(trimRoutePath(KEY, h.url("/a")));
    await new Promise((r) => setTimeout(r, 100));
    const b = h.get(trimRoutePath(KEY, h.url("/b"))); // waits for the slot
    await new Promise((r) => setTimeout(r, 100));
    const c = await h.get(trimRoutePath(KEY, h.url("/c"))); // the queue is full
    assert.equal(c.status, 503);
    assert.equal(c.headers["retry-after"], "60");
    assert.equal(release.length, 1, "only one upstream fetch is running");
    release.shift()!();
    assert.equal((await a).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    release.shift()!();
    assert.equal((await b).status, 200);
  } finally {
    await h.stop();
  }
});

test("what is kept is bounded: answers beyond the byte budget are dropped, least recently used first", async () => {
  const h = await harness(feedHandler(podcast(12)), { trimLimits: { maxCachedBytes: 60_000, maxRemembered: 5 } });
  try {
    const one = (await h.get(trimRoutePath(KEY, h.url("/f0")))).body.length;
    assert.ok(one > 10_000 && one < 60_000);
    for (let i = 1; i < 12; i++) assert.equal((await h.get(trimRoutePath(KEY, h.url(`/f${i}`)))).status, 200);
    const fp = h.egress.trim!.footprint;
    assert.ok(fp.cachedBytes <= 60_000, `kept ${fp.cachedBytes} bytes`);
    assert.ok(fp.remembered <= 5, `remembered ${fp.remembered} feeds`);
    assert.equal(fp.running, 0);
  } finally {
    await h.stop();
  }
});

test("the log names the host and the outcome, never the address (a private feed's key is in it)", async () => {
  const h = await harness(feedHandler(podcast(20)));
  try {
    await h.get(trimRoutePath(KEY, h.url(`/private/feed.xml?${SECRET_QUERY}`)));
    await h.get(trimRoutePath(KEY, h.url(`/missing?${SECRET_QUERY}`)));
    const lines = JSON.stringify(h.logs);
    assert.ok(h.logs.some((e) => e.event === "gateway.trim" && e.host === "127.0.0.1"));
    assert.ok(!lines.includes("s3cr3t") && !lines.includes("feed.xml") && !lines.includes("private"), lines);
  } finally {
    await h.stop();
  }
});

test("a newer episode after more than 200 in descending order is served: the order of the first says nothing of the rest", async () => {
  const doc = podcast(1001, "late-newest");
  const h = await harness(feedHandler(doc));
  try {
    const r = await h.get(trimRoutePath(KEY, h.url("/f")));
    assert.equal(r.status, 200);
    const titles = parseFeed(r.body, "application/rss+xml", { maxItems: 1000 }).items.map((i) => i.title);
    assert.equal(titles.length, 100);
    assert.equal(titles[0], "Episode 1000", "the newest episode, listed 201st");
    assert.equal(titles[1], "Episode 999");
    assert.equal(titles.at(-1), "Episode 901");
    const served = h.logs.find((e) => e.event === "gateway.trim" && e.outcome === "ok")!;
    assert.deepEqual([served.seen, served.complete], [1001, 1]);
  } finally {
    await h.stop();
  }
});

/** A publisher with validators: ETag and Last-Modified, and a 304 for a request that carries the current ones. */
function validating(state: { doc: string; etag: string; modified: string }) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const same = req.headers["if-none-match"] === state.etag && req.headers["if-modified-since"] === state.modified;
    if (same) return void res.writeHead(304, { etag: state.etag, "last-modified": state.modified }).end();
    res.writeHead(200, { "content-type": "application/rss+xml", etag: state.etag, "last-modified": state.modified });
    res.end(state.doc);
  };
}

test("a feed that has not changed is asked about, not read again: the publisher's 304 gives the kept answer", async () => {
  const state = { doc: podcast(600), etag: '"v1"', modified: "Mon, 16 Nov 2026 11:00:00 GMT" };
  const h = await harness(validating(state));
  try {
    const path = trimRoutePath(KEY, h.url("/f"));
    const first = await h.get(path);
    assert.equal(first.status, 200);
    assert.equal(h.upstream.requests[0]!.headers["if-none-match"], undefined, "the first time there is nothing to ask with");
    // While the answer is fresh the publisher is not asked at all.
    h.clock.now += 5 * 60_000;
    assert.equal((await h.get(path)).body, first.body);
    assert.equal(h.upstream.requests.length, 1);
    // When it ages, the publisher is asked with what it said last, and its 304 renews the answer.
    h.clock.now += 6 * 60_000;
    const again = await h.get(path);
    assert.equal(again.status, 200);
    assert.equal(again.body, first.body, "the same trimmed copy");
    assert.equal(h.upstream.requests.length, 2);
    assert.equal(h.upstream.requests[1]!.headers["if-none-match"], '"v1"');
    assert.equal(h.upstream.requests[1]!.headers["if-modified-since"], state.modified);
    const log = h.logs.filter((e) => e.event === "gateway.trim").at(-1)!;
    assert.deepEqual([log.outcome, log.status, log.bytes, log.cached], ["not_modified", 200, 0, false]);
    h.clock.now += 5 * 60_000;
    await h.get(path);
    assert.equal(h.upstream.requests.length, 2, "and it is fresh for a full window again");
    // A changed feed is read in full, and the next question carries its new validators.
    state.doc = podcast(601);
    state.etag = '"v2"';
    state.modified = "Mon, 16 Nov 2026 12:30:00 GMT";
    h.clock.now += 6 * 60_000;
    const changed = await h.get(path);
    assert.equal(h.upstream.requests.length, 3);
    assert.equal(h.upstream.requests[2]!.headers["if-none-match"], '"v1"');
    assert.notEqual(changed.body, first.body);
    assert.equal(parseFeed(changed.body, "application/rss+xml", { maxItems: 1000 }).items[0]!.title, "Episode 600");
    h.clock.now += 11 * 60_000;
    assert.equal((await h.get(path)).body, changed.body);
    assert.equal(h.upstream.requests[3]!.headers["if-none-match"], '"v2"');
    assert.equal(h.upstream.requests[3]!.headers["if-modified-since"], state.modified);
  } finally {
    await h.stop();
  }
});

test("a publisher without validators is asked plainly, and a 304 it was not asked for is not taken for a feed", async () => {
  let reply: "feed" | "not-modified" = "feed";
  const h = await harness((req, res) => {
    if (reply === "not-modified") return void res.writeHead(304).end();
    feedHandler(podcast(30))(req, res);
  });
  try {
    const path = trimRoutePath(KEY, h.url("/f"));
    assert.equal((await h.get(path)).status, 200);
    h.clock.now += 11 * 60_000;
    reply = "not-modified";
    const r = await h.get(path);
    assert.deepEqual(Object.keys(h.upstream.requests[1]!.headers).filter((k) => k.startsWith("if-")), [], "nothing to ask with, so nothing is asked");
    assert.equal(r.status, 502, "an answer that is not a feed is not served as one, and nothing is repeated from before");
    assert.equal(h.logs.filter((e) => e.event === "gateway.trim").at(-1)!.outcome, "http_304");
  } finally {
    await h.stop();
  }
});

test("a 304 from a different address than the kept answer was read from is not reused: the feed is read again, from there", async () => {
  const state = { doc: podcast(40), etag: '"v1"', modified: "Mon, 16 Nov 2026 11:00:00 GMT", to: "/one/feed.xml" };
  const h = await harness((req, res) => {
    if (req.url === "/old") return void res.writeHead(302, { location: state.to }).end();
    validating(state)(req, res);
  });
  try {
    const path = trimRoutePath(KEY, h.url("/old"));
    const first = await h.get(path);
    assert.ok(first.body.includes(`xml:base="${h.url("/one/feed.xml")}"`), first.body.slice(0, 400));
    state.to = "/two/feed.xml";
    h.clock.now += 11 * 60_000;
    const second = await h.get(path);
    assert.equal(second.status, 200);
    assert.ok(second.body.includes(`xml:base="${h.url("/two/feed.xml")}"`) && !second.body.includes("/one/feed.xml"), "the base follows the address it was read from now");
    const asked = h.upstream.requests.filter((r) => r.url === "/two/feed.xml");
    assert.deepEqual(asked.map((r) => r.headers["if-none-match"]), ['"v1"', undefined], "asked with the validators, then plainly");
  } finally {
    await h.stop();
  }
});

test("what is kept is the whole address's: a private feed's answer is only ever for the address that was signed, and its validators go with it", async () => {
  const privateFeed = (who: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${who} private feed</title><item><title>${who} episode</title><guid>g</guid><pubDate>${new Date(Date.UTC(2026, 0, 1)).toUTCString()}</pubDate></item></channel></rss>`;
  const h = await harness((req, res) => {
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("token");
    if (token !== "key-a" && token !== "key-b") return void res.writeHead(403).end("no");
    res.writeHead(200, { "content-type": "application/rss+xml", etag: `"${token}"` });
    res.end(privateFeed(token === "key-a" ? "Alpha" : "Beta"));
  });
  try {
    const a = h.url("/feed.xml?token=key-a");
    const b = h.url("/feed.xml?token=key-b");
    const pathA = trimRoutePath(KEY, a);
    const pathB = trimRoutePath(KEY, b);
    const fromA = await h.get(pathA);
    assert.match(fromA.body, /Alpha episode/);
    const fromB = await h.get(pathB);
    assert.match(fromB.body, /Beta episode/);
    assert.doesNotMatch(fromB.body, /Alpha/, "the same publisher and path with another key is another feed");
    assert.equal(h.upstream.requests.length, 2);
    // Every account that follows the same address shares its one answer.
    assert.equal((await h.get(pathA)).body, fromA.body);
    assert.equal(h.upstream.requests.length, 2);
    // A signature is for one address: neither feed's answer can be asked for with the other's, or without the key.
    const [sigA, encodedA] = pathA.split("/").slice(2);
    const [sigB, encodedB] = pathB.split("/").slice(2);
    for (const forged of [`/t/${sigA}/${encodedB}`, `/t/${sigB}/${encodedA}`, `/t/${"A".repeat(43)}/${encodedA}`, `/t/${sigA}/${Buffer.from(h.url("/feed.xml")).toString("base64url")}`]) {
      const r = await h.get(forged);
      assert.equal(r.status, 404, forged);
      assert.doesNotMatch(r.body, /Alpha|Beta/);
    }
    assert.equal(h.upstream.requests.length, 2, "none of them reached the publisher or the answers kept");
    // The address without its key, signed (by the installation) as its own address, is its own feed and is refused by the publisher.
    const without = await h.get(trimRoutePath(KEY, h.url("/feed.xml")));
    assert.equal(without.status, 403);
    assert.doesNotMatch(without.body, /Alpha|Beta/);
    // The validators asked with are the ones that address's own answer came with.
    h.clock.now += 11 * 60_000;
    await h.get(pathB);
    assert.equal(h.upstream.requests.at(-1)!.headers["if-none-match"], '"key-b"');
  } finally {
    await h.stop();
  }
});

test("validators are kept with the answer they belong to: an answer dropped for the byte budget is asked for plainly next time", async () => {
  const h = await harness(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml", etag: `"${req.url}"` });
      res.end(podcast(12));
    },
    { trimLimits: { maxCachedBytes: 100_000 } }, // room for three answers of about 31 KB
  );
  try {
    for (let i = 0; i < 6; i++) assert.equal((await h.get(trimRoutePath(KEY, h.url(`/f${i}`)))).status, 200);
    const fp = h.egress.trim!.footprint;
    assert.ok(fp.cachedBytes <= 100_000 && fp.cachedBytes > 60_000, `kept ${fp.cachedBytes} bytes`);
    h.clock.now += 11 * 60_000;
    const before = h.upstream.requests.length;
    await h.get(trimRoutePath(KEY, h.url("/f0"))); // the first of them: its answer was dropped for the others
    await h.get(trimRoutePath(KEY, h.url("/f5"))); // the latest: still kept
    const asked = h.upstream.requests.slice(before);
    assert.deepEqual(asked.map((r) => [r.url, r.headers["if-none-match"]]), [["/f0", undefined], ["/f5", '"/f5"']]);
    assert.ok(h.egress.trim!.footprint.cachedBytes <= 100_000);
  } finally {
    await h.stop();
  }
});

test("relative links keep resolving against the publisher: the copy declares the address it was read from, after redirects", async () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:base="posts/">\n<title>Relative</title>\n${Array.from({ length: 150 }, (_, k) => `<entry><title>Post ${k}</title><id>p${k}</id><updated>${new Date(Date.UTC(2026, 0, 1, 0, k)).toISOString()}</updated><link href="/posts/${k}"/></entry>\n`).join("")}</feed>\n`;
  const h = await harness((req, res) => {
    if (req.url === "/old") return void res.writeHead(301, { location: "/blog/feed.xml" }).end();
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(atom);
  });
  try {
    const r = await h.get(trimRoutePath(KEY, h.url("/old")));
    assert.equal(r.status, 200);
    const root = /<feed [^>]*>/.exec(r.body)![0];
    assert.equal(root, `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="${h.url("/blog/posts/")}">`, "the feed's own relative xml:base is resolved against where it was read from");
    assert.ok(r.body.includes('<link href="/posts/149"/>'), "and the entries are as they were written");
  } finally {
    await h.stop();
  }
});
