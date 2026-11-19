/**
 * Contract test of the feed gateway's trimming of big feeds against the real pinned FreshRSS container: a feed far too big for
 * the engine's PHP memory limit (a podcast feed of 3,000 episodes that repeats its show notes three times, about 20 MB, like The Daily's)
 * makes the engine fail the request itself (HTTP 500) when it is added directly, and is followed without trouble through the gateway,
 * which gives the engine a copy of the newest 50 episodes (what it keeps of a feed). The path is the real one except the product's database: FreshRSS fetches
 * through the real egress proxy, whose internal alias leads to the real gateway, which streams the fixture feed through safeFetch;
 * the subscriptions are made by the worker's own `engine.subscribe` handler.
 * Run with `npm run test:engine`.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { isLargeFeed, TRIM_FEED_BYTES } from "@purss/connectors";
import { EngineError, GReaderClient } from "@purss/freshrss";
import { createHandlers, defaultMakeClient } from "../../apps/worker/src/handlers.ts";
import type { InternalApi } from "../../apps/worker/src/internal-api.ts";
import { createLogger } from "../../apps/worker/src/log.ts";
import { EngineUserSecrets } from "../../apps/worker/src/secrets.ts";
import { startEgress } from "../../apps/egress/src/server.ts";
import type { RunningEgress } from "../../apps/egress/src/server.ts";
import type { LogEvent } from "../../apps/egress/src/proxy.ts";
import { allowLoopback, makeConfig } from "../../apps/egress/src/testing.ts";
import { FIXTURE_HEAD, FIXTURE_TAIL, fixtureEpisode, fixtureListing } from "./support/big-feed-fixture.ts";
import type { FixtureOrder } from "./support/big-feed-fixture.ts";
import { startTestEngine } from "./support/harness.ts";
import type { TestEngine } from "./support/harness.ts";

const TRIM_KEY = "contract-test-trim-key-".repeat(3);
const ALIAS = "feed-gateway.internal";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

type Fixture = { path: string; count: number; order: FixtureOrder; hits: number; notModified: number };

let engine: TestEngine;
let egress: RunningEgress;
let egressLogs: LogEvent[] = [];
let origin: Server;
let originPort = 0;
let secretsDir = "";
const fixtures = new Map<string, Fixture>();
/** Small documents served exactly as written (the relative-link feeds below), by path. */
const documents = new Map<string, { body: string; contentType: string }>();

before(async () => {
  const gatewayPort = await freePort();
  const proxyPort = await freePort();
  // The fixture feeds' host: served from memory, written in pieces so a reader that stops early leaves most of it unread.
  origin = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const doc = documents.get(path);
    if (doc) {
      res.writeHead(200, { "content-type": doc.contentType, "cache-control": "no-store" });
      return void res.end(doc.body);
    }
    const f = fixtures.get(path);
    if (!f) return void res.writeHead(404).end();
    f.hits++;
    // A publisher with a validator: it changes when the feed does (a new episode), and a request that carries the current one is answered 304.
    const etag = `"${f.count}-${f.order}"`;
    if (!path.startsWith("/endless") && req.headers["if-none-match"] === etag) {
      f.notModified++;
      return void res.writeHead(304, { etag }).end();
    }
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "no-store", ...(path.startsWith("/endless") ? {} : { etag }) });
    if (path.startsWith("/endless")) {
      // Never ends, and its dates run up and down: only the gateway's ceiling stops it. One block of episodes, sent over and over.
      const block = Array.from({ length: 150 }, (_, k) => fixtureEpisode(k)).join("");
      res.write(FIXTURE_HEAD);
      const pump = () => {
        while (!res.destroyed) {
          if (!res.write(block)) return void res.once("drain", pump);
        }
      };
      pump();
      return;
    }
    const ids = fixtureListing(f.count, f.order);
    res.write(FIXTURE_HEAD);
    let at = 0;
    const pump = () => {
      while (at < ids.length && !res.destroyed) {
        const ok = res.write(fixtureEpisode(ids[at]!));
        at++;
        if (!ok) return void res.once("drain", pump);
      }
      if (!res.destroyed) res.end(FIXTURE_TAIL);
    };
    pump();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  originPort = (origin.address() as AddressInfo).port;

  // The real egress: its proxy is the engine's only way out, and its internal alias leads to its gateway.
  egress = await startEgress(
    makeConfig({
      proxy: { host: "127.0.0.1", port: proxyPort },
      gateway: { host: "127.0.0.1", port: gatewayPort },
      internalDestinations: [{ host: ALIAS, port: gatewayPort, connectHost: "127.0.0.1", connectPort: gatewayPort }],
      trimKey: TRIM_KEY,
      limits: { maxResponseBytes: 32 * 1024 * 1024, requestTimeoutMs: 120_000, idleTimeoutMs: 60_000, connectTimeoutMs: 5000, maxConnections: 64, maxRequestBodyBytes: 1024 * 1024, maxTunnelBytes: 8 * 1024 * 1024, maxTunnelMs: 10_000 },
    }),
    // No upstream is cached for long here: every refresh of the engine reads the feed again, as it does after the gateway's few minutes.
    { log: (e) => egressLogs.push(e), testAllowAddress: allowLoopback, trimLimits: { cacheMs: 0, backoffMs: 1 } },
  );
  // Under the limits of a production engine (infra/compose.yaml: a 256 MB container; its web requests get PHP's 128 MB): the harness's
  // default gives the container 1 GB, in which a 20 MB feed is read slowly instead of failing.
  engine = await startTestEngine({ egressProxy: `http://host.containers.internal:${egress.ports.proxy}`, memoryLimit: "256m" });
  secretsDir = mkdtempSync(path.join(tmpdir(), "purss-bigfeed-secrets-"));
  writeFileSync(path.join(secretsDir, "feed-trim-key"), `${TRIM_KEY}\n`);
}, { timeout: 300_000 });

after(async () => {
  await engine?.stop();
  await egress?.stop();
  await new Promise<void>((resolve) => { origin?.closeAllConnections(); origin?.close(() => resolve()); });
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
}, { timeout: 120_000 });

function addFixture(name: string, count: number, order: FixtureOrder): { url: string; fixture: Fixture } {
  const fixture: Fixture = { path: `/${name}.xml`, count, order, hits: 0, notModified: 0 };
  fixtures.set(fixture.path, fixture);
  return { url: `http://127.0.0.1:${originPort}${fixture.path}`, fixture };
}

/** A new engine user and the worker's own subscribe handler for it (with the gateway's address and a real size check). */
async function newAccount(label: string) {
  const secrets = new EngineUserSecrets(path.join(secretsDir, `users-${label}`));
  const id = `eu_${label}`;
  const username = `t${label}${Math.random().toString(16).slice(2, 8)}`;
  const { apiPassword } = secrets.ensure(id);
  await engine.admin.ensureUser({ username, apiPassword });
  const client = new GReaderClient({ baseUrl: engine.baseUrl, username, apiPassword, requestTimeoutMs: 120_000 });
  await client.login();
  const handlers = createHandlers({
    api: { engineUser: async () => ({ id, username, baseUrl: engine.baseUrl }) } as unknown as InternalApi,
    secrets,
    secretsDir,
    gatewayEngineUrl: `http://${ALIAS}:${egress.ports.gateway}`,
    admin: engine.admin,
    log: createLogger(() => {}),
    makeClient: defaultMakeClient(120_000),
    isLargeFeed: (url, opts) => isLargeFeed(url, { signal: opts.signal, testAllowAddress: allowLoopback }),
    syncPageSize: 10,
    syncOverlapSeconds: 0,
    syncMaxBatchBytes: 700_000,
    requestTimeoutMs: 120_000,
  });
  const subscribe = (feedUrl: string, extra: { trim?: boolean } = {}) =>
    handlers["engine.subscribe"]!({
      job: { id: "job_big", kind: "engine.subscribe", payload: null, leaseId: "lse", leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), attempts: 1 },
      payload: { engineUserId: id, sourceId: `src_${label}`, feedUrl, title: "Big show", ...extra },
      signal: AbortSignal.timeout(280_000),
    }) as Promise<Record<string, unknown>>;
  const titles = async (): Promise<string[]> => {
    const page = await client.streamContents({ count: 1000, order: "desc" });
    return page.items.map((i) => String(i.title));
  };
  /** What the engine stored of each item that matters for links: its link and enclosure, by the last word of its title (the engine words titles its own way). */
  const links = async (): Promise<Record<string, { link: string | undefined; enclosure: string | undefined }>> => {
    const page = await client.streamContents({ count: 1000, order: "desc" });
    return Object.fromEntries(page.items.map((i) => [String(i.title).split(" ").at(-1)!, { link: i.canonical?.[0]?.href ?? i.alternate?.[0]?.href, enclosure: i.enclosure?.[0]?.href }]));
  };
  return { username, client, subscribe, titles, links };
}

const trimEvents = (since: number) => egressLogs.slice(since).filter((e) => e.event === "gateway.trim");

describe("a feed too big for the engine, through the feed gateway", () => {
  const big = () => addFixture("daily", 3000, "newest-first");

  test("the fixture is a feed the engine cannot read whole: added directly it fails the request itself (HTTP 500), as The Daily's does", async () => {
    const { url, fixture } = addFixture("daily-direct", 3000, "newest-first");
    const u = await newAccount("direct");
    const bytes = (await (await fetch(url)).arrayBuffer()).byteLength;
    assert.ok(bytes > 15 * 1024 * 1024 && bytes > 3 * TRIM_FEED_BYTES, `the fixture is ${bytes} bytes`);
    fixture.hits = 0;
    const err = await u.client.quickAdd(url).catch((e: unknown) => e);
    assert.ok(err instanceof EngineError, `expected the engine to fail, got ${String(err)}`);
    assert.deepEqual([err.kind, err.status], ["unavailable", 500], "the engine's own failure: PHP's memory limit, not the feed's site");
    assert.equal(fixture.hits, 1, "it did fetch the feed, so the failure is in reading it");
    assert.deepEqual(await u.client.listSubscriptions(), []);
  });

  test("followed through the gateway: the engine takes the newest episodes, the channel's metadata, and a subscription at the gateway's address", async () => {
    const { url, fixture } = big();
    const u = await newAccount("via");
    const logsBefore = egressLogs.length;
    const r = await u.subscribe(url, { trim: true });
    assert.equal(r.viaGateway, true);
    assert.equal(r.alreadySubscribed, false);
    assert.equal(r.empty, false);
    assert.equal(r.title, "The Big Show", "the channel's title comes through");
    const subs = await u.client.listSubscriptions();
    assert.equal(subs.length, 1);
    assert.ok(subs[0]!.url.startsWith(`http://${ALIAS}:${egress.ports.gateway}/t/`), subs[0]!.url);
    assert.ok(!subs[0]!.url.includes("127.0.0.1"), "the engine holds the gateway's address, never the feed's own");
    const titles = await u.titles();
    assert.equal(titles.length, 50, "the engine holds the newest 50 episodes");
    assert.deepEqual(titles.slice(0, 3), ["Episode 2999", "Episode 2998", "Episode 2997"], "the newest, newest first");
    const served = trimEvents(logsBefore).filter((e) => e.outcome === "ok");
    assert.equal(served.length, 1);
    assert.deepEqual([served[0]!.kept, served[0]!.seen, served[0]!.complete], [50, 3000, 1]);
    assert.ok(Number(served[0]!.bytes) > 15 * 1024 * 1024, `the gateway read ${served[0]!.bytes} bytes of a 20 MB feed: all of it, since nothing says the rest is older`);
    assert.equal(fixture.hits, 1, "one request to the feed's site");
    // Subscribing again (a retry, the empty-feed check) finds the same subscription.
    const again = await u.subscribe(url, { trim: true });
    assert.deepEqual([again.alreadySubscribed, again.streamId], [true, r.streamId]);
  });

  test("a refresh asks the gateway again, which reads the changed feed in full again, and a new episode arrives", async () => {
    const { url, fixture } = big();
    const u = await newAccount("refresh");
    const r = await u.subscribe(url, { trim: true });
    const streamId = String(r.streamId);
    // A new episode appears at the top of the feed.
    fixture.count = 3001;
    const logsBefore = egressLogs.length;
    const hitsBefore = fixture.hits;
    const refreshed = await engine.refresh(u.username, streamId);
    assert.equal(refreshed.feeds, 1);
    assert.ok(fixture.hits > hitsBefore, "the engine's refresh reached the feed's site through the gateway");
    assert.ok(trimEvents(logsBefore).every((e) => e.outcome === "ok" && e.kept === 50 && e.seen === 3001 && Number(e.bytes) > 15 * 1024 * 1024), JSON.stringify(trimEvents(logsBefore)));
    const titles = await u.titles();
    assert.equal(titles[0], "Episode 3000", "the new episode is in");
    assert.ok(titles.includes("Episode 2999"));
  });

  test("a refresh of a feed that has not changed asks the publisher whether it did, and its 304 gives the engine the same copy without the feed being read again", async () => {
    const { url, fixture } = addFixture("daily-unchanged", 3000, "newest-first");
    const u = await newAccount("unchanged");
    const r = await u.subscribe(url, { trim: true });
    const streamId = String(r.streamId);
    assert.equal(fixture.notModified, 0);
    const logsBefore = egressLogs.length;
    const hitsBefore = fixture.hits;
    assert.equal((await engine.refresh(u.username, streamId)).feeds, 1);
    assert.equal(fixture.hits, hitsBefore + 1, "the gateway asked the publisher");
    assert.equal(fixture.notModified, 1, "with the validator it was given, and the publisher said the feed is as it was");
    assert.deepEqual(trimEvents(logsBefore).map((e) => [e.outcome, e.status, e.bytes]), [["not_modified", 200, 0]], "nothing was read, and the engine was given the kept copy");
    assert.deepEqual((await u.titles()).slice(0, 2), ["Episode 2999", "Episode 2998"]);
    // The feed changes, and with it its validator: the next refresh reads it in full.
    fixture.count = 3001;
    const changedFrom = egressLogs.length;
    await engine.refresh(u.username, streamId);
    assert.equal(fixture.notModified, 1);
    const read = trimEvents(changedFrom);
    assert.deepEqual([read.length, read[0]!.outcome, read[0]!.seen], [1, "ok", 3001]);
    assert.equal((await u.titles())[0], "Episode 3000");
  });

  test("a feed followed before the gateway, which the engine fails on, is moved to it by the worker when it really is that big", async () => {
    const { url } = addFixture("daily-old", 3000, "newest-first");
    const u = await newAccount("moved");
    const r = await u.subscribe(url); // no instruction from a preview: this is an old subscription, an import or a retry
    assert.equal(r.viaGateway, true, "the engine failed with its own HTTP 500, and the feed is bigger than it can read");
    const subs = await u.client.listSubscriptions();
    assert.deepEqual(subs.map((s) => s.url.startsWith(`http://${ALIAS}:`)), [true]);
    assert.equal((await u.titles())[0], "Episode 2999");
  });

  test("a feed listed in no order is read to its end for its newest items, and the engine takes them", async () => {
    const { url } = addFixture("shuffled", 1800, "shuffled"); // about 12 MB
    const u = await newAccount("shuffled");
    const logsBefore = egressLogs.length;
    const r = await u.subscribe(url, { trim: true });
    assert.equal(r.viaGateway, true);
    const served = trimEvents(logsBefore).find((e) => e.outcome === "ok")!;
    assert.equal(served.complete, 1, "all of it was read: only then are the newest known");
    const titles = await u.titles();
    assert.equal(titles[0], "Episode 1799");
    assert.equal(titles.length, 50);
    const nums = titles.map((t) => Number(t.replace("Episode ", "")));
    assert.ok(nums.every((n) => n >= 1750), "only the newest 50 of 1800 were given to the engine");
  });

  test("a feed that never ends is followed from what the gateway read before its ceiling: the newest of that, with no failure and nothing said about its size", async () => {
    addFixture("endless", 0, "shuffled");
    const u = await newAccount("endless");
    const logsBefore = egressLogs.length;
    const r = await u.subscribe(`http://127.0.0.1:${originPort}/endless.xml`, { trim: true });
    assert.equal(r.viaGateway, true);
    assert.equal(r.empty, false);
    assert.equal((await u.client.listSubscriptions()).length, 1);
    const served = trimEvents(logsBefore).find((e) => e.outcome === "ok")!;
    assert.ok(served, JSON.stringify(trimEvents(logsBefore).map((e) => e.outcome)));
    assert.deepEqual([served.status, served.complete, served.capped, served.bytes], [200, 0, 1, 64 * 1024 * 1024], "read to the ceiling and served as far as it went");
    assert.ok((await u.titles()).length >= 1);
    assert.ok(trimEvents(logsBefore).every((e) => e.outcome !== "too_large" && e.status !== 413));
  });

  describe("relative links", () => {
    const rssItem = (title: string, link: string, enclosure: string, n: number) =>
      `<item><guid isPermaLink="false">${title}</guid><title>${title}</title><link>${link}</link><pubDate>${new Date(Date.UTC(2026, 0, 10 + n)).toUTCString()}</pubDate><description>Notes of ${title}</description><enclosure url="${enclosure}" type="audio/mpeg" length="1"/></item>`;
    const atomEntry = (title: string, href: string, n: number, attrs = "") =>
      `<entry${attrs}><id>${title}</id><title>${title}</title><link href="${href}"/><updated>${new Date(Date.UTC(2026, 0, 10 + n)).toISOString()}</updated><summary>Notes of ${title}</summary></entry>`;
    const rss = (...items: string[]) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Relative RSS</title><description>d</description>\n${items.join("\n")}\n</channel></rss>\n`;
    const atom = (rootAttrs: string, ...entries: string[]) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"${rootAttrs}><id>urn:rel</id><title>Relative Atom</title><updated>2026-02-01T00:00:00Z</updated>\n${entries.join("\n")}\n</feed>\n`;
    const cases: Record<string, { xml: string; type: string; sameAsDirect: boolean; expect: (origin: string) => Record<string, { link: string; enclosure?: string }> }> = {
      "rss-rel": {
        type: "application/rss+xml",
        sameAsDirect: true,
        xml: rss(rssItem("RootRelative", "/posts/one", "/audio/one.mp3", 1), rssItem("PathRelative", "posts/two", "audio/two.mp3", 2), rssItem("Absolute", "https://show.example/ep/3", "https://cdn.example/3.mp3", 3)),
        expect: (o) => ({
          RootRelative: { link: `${o}/posts/one`, enclosure: `${o}/audio/one.mp3` },
          PathRelative: { link: `${o}/blog/posts/two`, enclosure: `${o}/blog/audio/two.mp3` },
          Absolute: { link: "https://show.example/ep/3", enclosure: "https://cdn.example/3.mp3" },
        }),
      },
      "atom-rel": {
        type: "application/atom+xml",
        sameAsDirect: true,
        xml: atom("", atomEntry("RootRelative", "/posts/one", 1), atomEntry("PathRelative", "posts/two", 2), atomEntry("Absolute", "https://show.example/ep/3", 3)),
        expect: (o) => ({ RootRelative: { link: `${o}/posts/one` }, PathRelative: { link: `${o}/blog/posts/two` }, Absolute: { link: "https://show.example/ep/3" } }),
      },
      "atom-xmlbase": {
        // The feed's own relative xml:base on the root and another on an entry: both stay meaningful, resolved against where the feed is. The engine
        // reading such a feed at its own address ignores them (SimplePie resolves a relative xml:base against nothing), so the standard's reading is
        // asserted here, not sameness with that.
        type: "application/atom+xml",
        sameAsDirect: false,
        xml: atom(' xml:base="posts/"', atomEntry("FromRoot", "one", 1), atomEntry("OwnBase", "two", 2, ' xml:base="/entries/"'), atomEntry("RootRelative", "/top", 3)),
        expect: (o) => ({ FromRoot: { link: `${o}/blog/posts/one` }, OwnBase: { link: `${o}/entries/two` }, RootRelative: { link: `${o}/top` } }),
      },
    };

    for (const [name, c] of Object.entries(cases)) {
      test(`${name}: followed through the gateway, its relative links resolve against the publisher${c.sameAsDirect ? ", as when the engine reads the feed itself" : ""}`, async () => {
        const feedPath = `/blog/${name}.xml`;
        documents.set(feedPath, { body: c.xml, contentType: c.type });
        const url = `http://127.0.0.1:${originPort}${feedPath}`;
        const origin = `http://127.0.0.1:${originPort}`;
        const through = await newAccount(`${name}-via`);
        const t = await through.subscribe(url, { trim: true });
        assert.equal(t.viaGateway, true);
        const subs = await through.client.listSubscriptions();
        assert.ok(subs[0]!.url.startsWith(`http://${ALIAS}:${egress.ports.gateway}/t/`), "the engine reads it at the gateway");
        const got = await through.links();
        if (c.sameAsDirect) {
          const direct = await newAccount(`${name}-direct`);
          assert.ok(!(await direct.subscribe(url)).viaGateway, "read by the engine at its own address");
          assert.deepEqual(got, await direct.links(), "the same links as when the engine reads the feed at its own address");
        }
        for (const [title, want] of Object.entries(c.expect(origin))) {
          assert.equal(got[title]?.link, want.link, `${title}'s link`);
          if (want.enclosure) assert.equal(got[title]?.enclosure, want.enclosure, `${title}'s enclosure`);
          assert.ok(!JSON.stringify(got[title]).includes(ALIAS), `${title} never points at the gateway`);
        }
      });
    }
  });

  test("a feed that is gone is told as gone, through the gateway as well", async () => {
    const u = await newAccount("notfeed");
    const err = await u.subscribe(`http://127.0.0.1:${originPort}/missing.xml`, { trim: true }).catch((e: unknown) => e);
    assert.ok(err instanceof EngineError && err.reason === "not_found", String(err));
  });
});
