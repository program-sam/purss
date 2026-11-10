import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { bridgeRoutePath, bridgeService, parseFeed } from "@purss/connectors";
import type { BridgeService } from "@purss/connectors";
import { createBridgeServer } from "./bridge/http.ts";
import { BridgeLog } from "./bridge/log.ts";
import { BridgeRouter, rssBridgeBackend } from "./bridge/router.ts";
import type { BridgeBackend } from "./bridge/router.ts";
import { startEgress } from "./server.ts";
import { makeConfig, startUpstream } from "./testing.ts";

const SECRET = "k".repeat(43);
const T0 = Date.parse("2026-11-08T12:00:00Z");

/** RSS-Bridge's Atom for a Telegram channel: entry ids and links are post addresses. */
function telegramAtom(channel: string, posts: number[], opts: { hashedIds?: boolean } = {}): string {
  const entries = posts.map((n) => `<entry><title>Post ${n}</title><id>${opts.hashedIds ? `urn:sha1:${String(n).padStart(40, "0")}` : `https://t.me/${channel}/${n}`}</id>`
    + `<link rel="alternate" href="https://t.me/${channel}/${n}"/><updated>2026-11-0${(n % 7) + 1}T10:00:00+00:00</updated><content type="html">&lt;p&gt;Body ${n}&lt;/p&gt;</content></entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Durov's Channel</title><id>https://t.me/s/${channel}</id><updated>2026-11-08T10:00:00+00:00</updated>${entries}</feed>`;
}

class FakeBackend implements BridgeBackend {
  name: string;
  calls = 0;
  answer: () => Awaited<ReturnType<BridgeBackend["fetch"]>>;
  gate: Promise<void> | null = null;
  constructor(name: string, answer: () => Awaited<ReturnType<BridgeBackend["fetch"]>>) {
    this.name = name;
    this.answer = answer;
  }
  async fetch(): Promise<Awaited<ReturnType<BridgeBackend["fetch"]>>> {
    this.calls++;
    if (this.gate) await this.gate;
    return this.answer();
  }
}

const ok = (body: string) => () => ({ status: 200, body: Buffer.from(body) });
const sig = (service: string, key: string) => bridgeRoutePath(SECRET, service, key).split("/").at(-1)!;

function router(backends: BridgeBackend[], clock = { now: T0 }) {
  const log = new BridgeLog({ now: () => clock.now });
  return { r: new BridgeRouter({ secret: SECRET, backends, log, now: () => clock.now }), log, clock };
}

test("a signed address is answered as RSS whose ids are the post addresses' ids", async () => {
  const backend = new FakeBackend("rss-bridge", ok(telegramAtom("durov", [552, 551])));
  const { r } = router([backend]);
  const a = await r.serve("telegram", "durov", sig("telegram", "durov"));
  assert.equal(a.status, 200);
  const feed = parseFeed(a.body, a.headers["content-type"]);
  assert.deepEqual(feed.items.map((i) => i.guid), ["telegram:durov/552", "telegram:durov/551"]);
  assert.deepEqual(feed.items.map((i) => i.url), ["https://t.me/durov/552", "https://t.me/durov/551"]);
  assert.equal(feed.siteUrl, "https://t.me/durov");
});

test("an unsigned, wrongly signed, unknown or malformed address is the same 404 and asks no backend", async () => {
  const backend = new FakeBackend("rss-bridge", ok(telegramAtom("durov", [1])));
  const { r } = router([backend]);
  for (const [service, key, s] of [
    ["telegram", "durov", "x".repeat(43)],
    ["telegram", "durov", sig("telegram", "pavel")],
    ["telegram", "pavel", sig("telegram", "durov")],
    ["instagram", "durov", sig("instagram", "durov")],
    ["telegram", "Du rov", sig("telegram", "Du rov")],
    ["telegram", "%E0%A4%A", sig("telegram", "durov")],
  ] as const) {
    const a = await r.serve(service, key, s);
    assert.equal(a.status, 404, `${service}/${key}`);
  }
  assert.equal(backend.calls, 0);
});

test("the same output under another backend keeps every id (a backend change duplicates nothing)", async () => {
  const plain = router([new FakeBackend("a", ok(telegramAtom("durov", [10, 11])))]).r;
  const hashed = router([new FakeBackend("b", ok(telegramAtom("durov", [10, 11], { hashedIds: true })))]).r;
  const ids = async (rt: BridgeRouter) => parseFeed((await rt.serve("telegram", "durov", sig("telegram", "durov"))).body).items.map((i) => i.guid);
  assert.deepEqual(await ids(plain), await ids(hashed));
});

test("entries that aren't this source's posts are dropped; output with none at all is a failure, not an empty feed", async () => {
  const mixed = telegramAtom("durov", [5]).replace("</feed>", '<entry><title>Elsewhere</title><id>x</id><link href="https://example.com/otherchannel/9"/></entry></feed>');
  const { r } = router([new FakeBackend("rss-bridge", ok(mixed))]);
  const feed = parseFeed((await r.serve("telegram", "durov", sig("telegram", "durov"))).body);
  assert.deepEqual(feed.items.map((i) => i.guid), ["telegram:durov/5"]);

  const strangers = telegramAtom("someone", [1, 2]).replaceAll("https://t.me/someone/", "https://example.com/someone/");
  const { r: r2, log } = router([new FakeBackend("rss-bridge", ok(strangers))]);
  const a = await r2.serve("telegram", "durov", sig("telegram", "durov"));
  assert.equal(a.status, 503);
  assert.deepEqual(log.summary().failing.map((f) => [f.key, f.outcome, f.phase]), [["durov", "no_ids", "identity"]]);
});

test("a real empty feed is 200 with no items", async () => {
  const { r } = router([new FakeBackend("rss-bridge", ok(telegramAtom("durov", [])))]);
  const a = await r.serve("telegram", "durov", sig("telegram", "durov"));
  assert.equal(a.status, 200);
  assert.equal(parseFeed(a.body).items.length, 0);
});

test("good answers are reused for ten minutes; concurrent requests share one backend fetch", async () => {
  const backend = new FakeBackend("rss-bridge", ok(telegramAtom("durov", [1])));
  let open!: () => void;
  backend.gate = new Promise((resolve) => { open = resolve; });
  const { r, clock, log } = router([backend]);
  const s = sig("telegram", "durov");
  const both = Promise.all([r.serve("telegram", "durov", s), r.serve("telegram", "durov", s)]);
  open();
  assert.deepEqual((await both).map((a) => a.status), [200, 200]);
  assert.equal(backend.calls, 1);
  backend.gate = null;
  clock.now += 9 * 60_000;
  await r.serve("telegram", "durov", s);
  assert.equal(backend.calls, 1, "cached");
  clock.now += 2 * 60_000;
  await r.serve("telegram", "durov", s);
  assert.equal(backend.calls, 2, "expired");
  const summary = log.summary().services[0]!;
  assert.equal(summary.attempts, 2);
  assert.equal(summary.cachedAnswers, 1);
});

test("a failure is never an empty success: 503 with Retry-After, then back-off that doubles", async () => {
  const backend = new FakeBackend("rss-bridge", () => ({ status: 500, body: Buffer.from("cURL error") }));
  const { r, clock, log } = router([backend]);
  const s = sig("telegram", "durov");
  const first = await r.serve("telegram", "durov", s);
  assert.equal(first.status, 503);
  assert.equal(first.headers["retry-after"], "300");
  await r.serve("telegram", "durov", s);
  assert.equal(backend.calls, 1, "backing off");
  clock.now += 5 * 60_000 + 1;
  const second = await r.serve("telegram", "durov", s);
  assert.equal(second.headers["retry-after"], "600");
  assert.equal(backend.calls, 2);
  const failing = log.summary().failing;
  assert.deepEqual(failing.map((f) => [f.key, f.outcome, f.attempts]), [["durov", "http_500", 2]]);
});

test("while the backend fails, a source that answered before keeps its last good answer", async () => {
  let up = true;
  const backend = new FakeBackend("rss-bridge", () => (up ? { status: 200, body: Buffer.from(telegramAtom("durov", [7])) } : { failed: "timeout" as const }));
  const { r, clock } = router([backend]);
  const s = sig("telegram", "durov");
  const good = await r.serve("telegram", "durov", s);
  up = false;
  clock.now += 11 * 60_000;
  const later = await r.serve("telegram", "durov", s);
  assert.equal(later.status, 200);
  assert.equal(later.body, good.body);
});

test("backends are asked in order: the second answers when the first fails", async () => {
  const first = new FakeBackend("rss-bridge", () => ({ failed: "unreachable" as const }));
  const second = new FakeBackend("other", ok(telegramAtom("durov", [3])));
  const { r, log } = router([first, second]);
  const a = await r.serve("telegram", "durov", sig("telegram", "durov"));
  assert.equal(a.status, 200);
  assert.equal(first.calls + second.calls, 2);
  assert.equal(log.summary().services[0]!.failed, 1);
});

test("at most the configured number of backend fetches run at once; beyond the queue the answer is busy", async () => {
  let running = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const backend: BridgeBackend = {
    name: "slow",
    async fetch(service: BridgeService, key: string) {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return { status: 200, body: Buffer.from(telegramAtom(key, [1])) };
    },
  };
  const log = new BridgeLog({ now: () => T0 });
  const r = new BridgeRouter({ secret: SECRET, backends: [backend], log, now: () => T0, limits: { concurrency: 2, maxQueue: 1 } });
  const keys = ["alpha", "bravo", "charlie", "delta"];
  const pending = keys.map((k) => r.serve("telegram", k, sig("telegram", k)));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const statuses = (await Promise.all(pending)).map((a) => a.status);
  assert.equal(peak, 2);
  assert.deepEqual(statuses.sort(), [200, 200, 200, 503]);
});

test("the fetch log keeps 30 days and reports failing keys with their streak", () => {
  const clock = { now: T0 };
  const log = new BridgeLog({ now: () => clock.now });
  const rec = (key: string, outcome: "ok" | "http_500") => log.record({ service: "telegram", key, backend: "rss-bridge", phase: "backend", outcome, entries: outcome === "ok" ? 3 : 0, ms: 10, cached: false });
  rec("durov", "ok");
  clock.now += 3600_000;
  rec("durov", "http_500");
  rec("durov", "http_500");
  rec("stable", "ok");
  const s = log.summary();
  assert.deepEqual(s.failing.map((f) => [f.key, f.attempts, f.lastOkAt]), [["durov", 2, new Date(T0).toISOString()]]);
  clock.now += 31 * 86_400_000;
  log.prune();
  assert.equal((log.db.prepare("SELECT COUNT(*) AS n FROM bridge_fetches").get() as { n: number }).n, 0);
});

test("the running listener serves the signed route only and asks RSS-Bridge for the catalogued bridge", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(telegramAtom("durov", [1]));
  });
  const egress = await startEgress(
    makeConfig({ bridge: { host: "127.0.0.1", port: 0, backendUrl: `http://127.0.0.1:${upstream.port}`, secret: SECRET, dbPath: ":memory:", net: null } }),
    { bridgeBackends: [rssBridgeBackend(`http://127.0.0.1:${upstream.port}`)] },
  );
  try {
    const port = egress.ports.bridge!;
    const get = (path: string) => new Promise<number>((resolve, reject) => http.get({ host: "127.0.0.1", port, path }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject));
    assert.equal(await get(bridgeRoutePath(SECRET, "telegram", "durov")), 200);
    assert.equal(upstream.requests[0]!.url.includes("bridge=TelegramBridge"), true);
    assert.equal(upstream.requests[0]!.url.includes("username=durov"), true);
    assert.equal(await get("/b/telegram/durov"), 404);
    assert.equal(await get("/feeds/abcdefgh"), 404);
  } finally {
    await egress.stop();
    await upstream.close();
  }
});

test("the bridge listener writes no signature into its logs", async () => {
  const logs: Record<string, unknown>[] = [];
  const log = new BridgeLog({ now: () => T0 });
  const r = new BridgeRouter({ secret: SECRET, backends: [new FakeBackend("rss-bridge", ok(telegramAtom("durov", [1])))], log, now: () => T0 });
  const server = createBridgeServer(r, { log: (e) => logs.push(e) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const path = bridgeRoutePath(SECRET, "telegram", "durov");
  await new Promise<void>((resolve) => http.get({ host: "127.0.0.1", port, path }, (res) => { res.resume(); res.on("end", resolve); }));
  server.close();
  assert.equal(JSON.stringify(logs).includes(path.split("/").at(-1)!), false);
  assert.equal(bridgeService("telegram")!.name, "Telegram");
});

test("a backend that labels Moscow time as UTC has its dates corrected (Rutube)", async () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Channel - Rutube</title><id>x</id><updated>2026-11-08T16:24:29+00:00</updated>`
    + `<entry><title>Video</title><id>https://rutube.ru/video/${"a".repeat(32)}/</id><link href="https://rutube.ru/video/${"a".repeat(32)}/"/><updated>2026-11-08T16:24:29+00:00</updated></entry></feed>`;
  const { r } = router([new FakeBackend("rss-bridge", ok(atom))]);
  const feed = parseFeed((await r.serve("rutube", "23460655", sig("rutube", "23460655"))).body);
  assert.equal(feed.items[0]!.publishedAt, "2026-11-08T13:24:29.000Z");
  assert.equal(feed.title, "Channel");
});

test("good answers are kept within a byte budget, least recently used dropped first", async () => {
  let current = "alpha";
  const backend = new FakeBackend("rss-bridge", () => ({ status: 200, body: Buffer.from(telegramAtom(current, [1, 2, 3])) }));
  const size = Buffer.byteLength((await router([backend]).r.serve("telegram", "alpha", sig("telegram", "alpha"))).body);
  backend.calls = 0;
  const log = new BridgeLog({ now: () => T0 });
  // Room for one answer and a half: the second pushes the first out.
  const r = new BridgeRouter({ secret: SECRET, backends: [backend], log, now: () => T0, limits: { maxCachedBytes: Math.floor(size * 1.5) } });
  for (const k of ["alpha", "bravo"]) { current = k; await r.serve("telegram", k, sig("telegram", k)); }
  assert.equal(backend.calls, 2);
  await r.serve("telegram", "bravo", sig("telegram", "bravo"));
  assert.equal(backend.calls, 2, "the most recent answer stays");
  current = "alpha";
  await r.serve("telegram", "alpha", sig("telegram", "alpha"));
  assert.equal(backend.calls, 3, "the older one was dropped to stay within the budget");
});

test("a source's fetch under way can't lose what it learns to eviction, and requests turned away as busy store nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let alphaCalls = 0;
  const backend: BridgeBackend = {
    name: "rss-bridge",
    async fetch(_service: BridgeService, key: string) {
      if (key === "alpha") { alphaCalls++; await gate; return { status: 500, body: Buffer.from("x") }; }
      return { status: 200, body: Buffer.from(telegramAtom(key, [1])) };
    },
  };
  const log = new BridgeLog({ now: () => T0 });
  const r = new BridgeRouter({ secret: SECRET, backends: [backend], log, now: () => T0, limits: { maxCached: 2, concurrency: 2, maxQueue: 0 } });
  const alpha = r.serve("telegram", "alpha", sig("telegram", "alpha"));
  // While alpha's fetch waits, more sources than the state limit finish around it.
  for (const k of ["bravo", "charlie", "delta"]) assert.equal((await r.serve("telegram", k, sig("telegram", k))).status, 200);
  release();
  assert.equal((await alpha).status, 503);
  assert.equal((await r.serve("telegram", "alpha", sig("telegram", "alpha"))).status, 503);
  assert.equal(alphaCalls, 1, "alpha's back-off was recorded and holds: it isn't asked again");
});

test("a Mixcloud account whose answer holds only shows it listened to is an empty feed, not a failure", async () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>MixCloud - someone</title><id>x</id><updated>2026-11-08T10:00:00Z</updated>`
    + `<entry><title>Other's show</title><id>a</id><link href="https://www.mixcloud.com/OtherDJ/their-show/"/><updated>2026-11-08T10:00:00Z</updated></entry></feed>`;
  const { r } = router([new FakeBackend("rss-bridge", ok(atom))]);
  const a = await r.serve("mixcloud", "someone", sig("mixcloud", "someone"));
  assert.equal(a.status, 200);
  assert.equal(parseFeed(a.body).items.length, 0);
});

test("a Mixcloud answer of site pages or malformed links is still a failure, not an empty feed", async () => {
  const tabs = ["uploads", "favorites", "listens", "playlists", "stream"].flatMap((t) => [`https://www.mixcloud.com/OtherDJ/${t}/`, `https://www.mixcloud.com/someone/${t}/`]);
  for (const link of ["https://www.mixcloud.com/discover/jazz/", "https://www.mixcloud.com/OtherDJ/bad slug!/", "https://www.mixcloud.com/OtherDJ/", "https://example.com/OtherDJ/show/", ...tabs]) {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title><id>x</id><updated>2026-11-08T10:00:00Z</updated>`
      + `<entry><title>t</title><id>a</id><link href="${link}"/><updated>2026-11-08T10:00:00Z</updated></entry></feed>`;
    const { r } = router([new FakeBackend("rss-bridge", ok(atom))]);
    assert.equal((await r.serve("mixcloud", "someone", sig("mixcloud", "someone"))).status, 503, link);
  }
});
