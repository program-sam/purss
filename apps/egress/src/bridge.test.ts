import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { BRIDGE_SERVICES, MAX_PAGE_KEY, bridgeRoutePath, bridgeService, decodePageKey, encodePageKey, needsRssBridge, parseFeed } from "@purss/connectors";
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
  kind = "rss-bridge" as const;
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
    ["tiktok", "durov", sig("tiktok", "durov")],
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
    kind: "rss-bridge",
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
    kind: "rss-bridge",
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

/** The attachments of a served feed, as "address type", in order. */
const enclosuresIn = (body: string | Buffer) =>
  [...String(body).matchAll(/<enclosure url="([^"]+)" length="\d+" type="([^"]+)"\/>/g)].map((m) => `${m[1]!.replace(/&amp;/g, "&")} ${m[2]}`);

/** RSS-Bridge's Atom for an Instagram account's widget: a video whose player has nothing to play, with its picture as an attachment. */
function instagramAtom(codes: string[]): string {
  const entries = codes.map((c) => `<entry><title>Post ${c}</title><id>https://www.instagram.com/p/${c}/</id><link rel="alternate" href="https://www.instagram.com/p/${c}/"/>`
    + `<updated>2026-11-08T10:00:00+00:00</updated><content type="html">&lt;video controls&gt;&lt;source src="" poster="https://www.instagram.com/p/${c}/media?size=l" type="video/mp4"&gt;&lt;/video&gt;&lt;br&gt;Caption ${c}</content>`
    + `<link rel="enclosure" type="application/octet-stream" href="https://scontent.cdninstagram.com/v/${c}.jpg?oe=6B0271F4"/></entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>natgeo - Instagram</title><id>x</id><updated>2026-11-08T10:00:00+00:00</updated>${entries}</feed>`;
}

test("Instagram posts name their pictures only for keeping: the lasting first picture, the rest of a carousel as picture attachments", async () => {
  const { r } = router([new FakeBackend("rss-bridge", ok(instagramAtom(["DfxGoxTl16O"])))]);
  const a = await r.serve("instagram", "natgeo", sig("instagram", "natgeo"));
  assert.equal(a.status, 200);
  const feed = parseFeed(a.body, a.headers["content-type"]);
  assert.equal(feed.title, "natgeo");
  const [item] = feed.items;
  assert.equal(item!.guid, "instagram:p/DfxGoxTl16O");
  assert.equal(item!.imageUrl, "https://www.instagram.com/p/DfxGoxTl16O/media/?size=l");
  assert.deepEqual(enclosuresIn(a.body), ["https://www.instagram.com/p/DfxGoxTl16O/media/?size=l image/jpeg"], "the backend's own attachment is left out");
  assert.doesNotMatch(item!.contentHtml ?? "", /cdninstagram|<video|<img/);

  const carousel = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>natgeo - Instagram</title><id>x</id><updated>2026-11-08T10:00:00+00:00</updated>`
    + `<entry><title>Album</title><id>https://www.instagram.com/p/Df147tCiAyB/</id><link rel="alternate" href="https://www.instagram.com/p/Df147tCiAyB/"/><updated>2026-11-08T10:00:00+00:00</updated>`
    + `<content type="html">&lt;a href="https://scontent.cdninstagram.com/v/1.jpg?oe=6B0271F4&amp;amp;x=1"&gt;&lt;img src="https://scontent.cdninstagram.com/v/1.jpg?oe=6B0271F4&amp;amp;x=1" alt="Album" /&gt;&lt;/a&gt;&lt;br&gt;`
    + `&lt;a href="https://scontent.cdninstagram.com/v/2.jpg?oe=6B0271F4&amp;amp;x=2"&gt;&lt;img src="https://scontent.cdninstagram.com/v/2.jpg?oe=6B0271F4&amp;amp;x=2" alt="Album" /&gt;&lt;/a&gt;&lt;br&gt;&lt;br&gt;Album caption</content></entry></feed>`;
  const { r: r2 } = router([new FakeBackend("rss-bridge", ok(carousel))]);
  const b = await r2.serve("instagram", "natgeo", sig("instagram", "natgeo"));
  const [album] = parseFeed(b.body, b.headers["content-type"]).items;
  assert.equal(album!.imageUrl, "https://www.instagram.com/p/Df147tCiAyB/media/?size=l");
  // The engine takes the first picture attachment as the entry's picture: the lasting one.
  assert.deepEqual(enclosuresIn(b.body), ["https://www.instagram.com/p/Df147tCiAyB/media/?size=l image/jpeg", "https://scontent.cdninstagram.com/v/2.jpg?oe=6B0271F4&x=2 image/jpeg"]);
  assert.equal(album!.contentHtml, "Album caption");
});

test("an Instagram answer without posts is a misread page: asked again at once, then a failure that keeps the last good answer", async () => {
  let answers = [instagramAtom([]), instagramAtom(["DfxGoxTl16O"])];
  const backend = new FakeBackend("rss-bridge", () => ({ status: 200, body: Buffer.from(answers.shift() ?? instagramAtom([])) }));
  const { r, clock, log } = router([backend]);
  const s = sig("instagram", "natgeo");
  const first = await r.serve("instagram", "natgeo", s);
  assert.equal(first.status, 200, "the second try read the page");
  assert.equal(backend.calls, 2);
  assert.equal(parseFeed(first.body).items.length, 1);

  clock.now += 11 * 60_000;
  answers = [];
  const again = await r.serve("instagram", "natgeo", s);
  assert.equal(backend.calls, 4, "two tries, both empty");
  assert.equal(again.status, 200, "the last good answer is served");
  assert.equal(parseFeed(again.body).items.length, 1);
  assert.deepEqual(log.summary().failing.map((f) => [f.key, f.outcome]), [["natgeo", "no_posts"]]);

  const { r: fresh } = router([new FakeBackend("rss-bridge", ok(instagramAtom([])))]);
  assert.equal((await fresh.serve("instagram", "natgeo", s)).status, 503, "with nothing good yet, never an empty source");
});

/** What RSS-Bridge answered for a service's example, recorded (trimmed), in the connectors' fixtures. */
const recorded = (name: string) => readFileSync(new URL(`../../../packages/connectors/src/fixtures/bridges/${name}.atom`, import.meta.url), "utf8");

const RECORDED = [
  { service: "mangadex", key: "801513ba-a712-498c-8f57-cae55b38cc92", file: "mangadex-berserk", title: "Berserk", site: "https://mangadex.org/title/801513ba-a712-498c-8f57-cae55b38cc92",
    guids: ["c0cd4656-6946-4be8-8d33-0aeb2fbeddfb", "cb0148ea-ba2e-487a-b368-2a9346350b5c", "a153d3b0-d79c-459e-912b-ed6c24dc1738", "62650219-b889-4a63-960b-0ac4add893a7",
      "4b7b0d08-b690-47a3-b9d1-73c1e230c4e1", "c95f6343-24c9-4476-af3c-a4d904238734", "17f089d2-d457-4718-89f5-4c41cf5f29a4", "88d18567-d54a-4c76-8e4e-d419291ce38b"].map((u) => `mangadex:chapter/${u}`) },
  { service: "vkvideo", key: "thoisoi", file: "vkvideo-thoisoi", title: "Thoisoi", site: "https://vkvideo.ru/@thoisoi",
    guids: [456240181, 456240180, 456240179, 456240178, 456240177].map((n) => `vkvideo:video/-22629421_${n}`) },
] as const;

test("MangaDex's and VK Video's recorded outputs are served as RSS whose ids come from the post links and whose links are the canonical post addresses", async () => {
  for (const n of RECORDED) {
    const { r } = router([new FakeBackend("rss-bridge", ok(recorded(n.file)))]);
    const a = await r.serve(n.service, n.key, sig(n.service, n.key));
    assert.equal(a.status, 200, n.file);
    const feed = parseFeed(a.body, a.headers["content-type"]);
    assert.deepEqual(feed.items.map((i) => i.guid), n.guids, n.file);
    assert.equal(feed.title, n.title, n.file);
    assert.equal(feed.siteUrl, n.site, n.file);
    assert.ok(feed.items.every((i) => i.url && i.publishedAt), `${n.file}: every entry has its link and date`);
  }
});

test("a MangaDex answer without entries is a title it doesn't know, or a misread: asked twice and then a failure, never an empty feed", async () => {
  const [service, key] = ["mangadex", "00000000-0000-4000-8000-000000000000"];
  const backend = new FakeBackend("rss-bridge", ok(recorded("mangadex-unknown-title")));
  const { r, log } = router([backend]);
  const a = await r.serve(service, key, sig(service, key));
  assert.equal(a.status, 503);
  assert.equal(backend.calls, 2, "asked again once at once");
  assert.deepEqual(log.summary().failing.map((f) => [f.service, f.outcome]), [[service, "no_posts"]]);
});

test("each service's example, asked of RSS-Bridge as the catalogue says, comes back through the router as entries with ids", async () => {
  const files = new Map<string, string>([...RECORDED.map((n) => [n.service, n.file] as const), ["page", "xpath-anthropic-news"]]);
  const asked: { bridge: string; params: Record<string, string> }[] = [];
  const upstream = await startUpstream((req, res) => {
    const q = new URL(req.url ?? "/", "http://rss-bridge.test").searchParams;
    const bridge = q.get("bridge") ?? "";
    asked.push({ bridge, params: Object.fromEntries([...q].filter(([k]) => k !== "bridge" && k !== "action" && k !== "format")) });
    const file = [...files].find(([service]) => (bridgeService(service)!.backend as { bridge?: string }).bridge === bridge)?.[1];
    res.writeHead(file ? 200 : 404, { "content-type": "application/atom+xml" });
    res.end(file ? recorded(file) : "unknown bridge");
  });
  try {
    const log = new BridgeLog({ now: () => T0 });
    const r = new BridgeRouter({ secret: SECRET, backends: [rssBridgeBackend(`http://127.0.0.1:${upstream.port}`)], log, now: () => T0 });
    for (const service of BRIDGE_SERVICES.filter((s) => needsRssBridge(s) && files.has(s.id))) {
      const a = await r.serve(service.id, service.example, sig(service.id, service.example));
      assert.equal(a.status, 200, service.id);
      const feed = parseFeed(a.body, a.headers["content-type"]);
      assert.ok(feed.items.length > 0 && feed.items.every((i) => i.guid?.startsWith(`${service.id}:`)), service.id);
    }
    assert.deepEqual(asked, [
      { bridge: "MangaDexBridge", params: { context: "Title Chapters", url: "https://mangadex.org/title/801513ba-a712-498c-8f57-cae55b38cc92", limit: "50", images: "no" } },
      { bridge: "VkVideoBridge", params: { context: "Channel", u: "@thoisoi" } },
      { bridge: "XPathBridge", params: { url: "https://www.anthropic.com/news", item: "//li[contains(@class, '_row')]", title: ".//h3", uri: ".//a/@href", timestamp: ".//time" } },
    ]);
  } finally {
    await upstream.close();
  }
});

// ---------- page lists (XPathBridge) ----------

const PAGE = { url: "https://www.anthropic.com/news", recipe: { item: "//li[contains(@class, '_row')]", title: ".//h3", link: ".//a/@href", date: ".//time" }, fixEncoding: false };
const pageKey = (source = PAGE) => encodePageKey(source)!;
const askPage = async (r: BridgeRouter, key: string) => r.serve("page", key, sig("page", key));

/** XPathBridge's Atom for a page: its feed title is the page's title, its entries have no content. */
function xpathAtom(entries: { title: string; href?: string; date?: string }[], title = "Newsroom \\ Anthropic"): string {
  const items = entries.map((e, i) => `<entry><title type="html">${e.title}</title>${e.date ? `<published>${e.date}</published><updated>${e.date}</updated>` : ""}`
    + `<id>${e.href ?? `urn:sha1:${String(i).padStart(40, "0")}`}</id>${e.href ? `<link rel="alternate" type="text/html" href="${e.href}"/>` : ""}<content type="html"> </content></entry>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">${title}</title><link rel="alternate" type="text/html" href="https://www.anthropic.com/news"/><id>x</id><updated>2026-11-21T14:43:30+00:00</updated>${items}</feed>`;
}

test("a page list, as the pinned XPathBridge answered it, is served as RSS with each post's id taken from its canonical address", async () => {
  const key = pageKey();
  const { r } = router([new FakeBackend("rss-bridge", ok(recorded("xpath-anthropic-news")))]);
  const a = await askPage(r, key);
  assert.equal(a.status, 200);
  const feed = parseFeed(a.body, a.headers["content-type"]);
  assert.equal(feed.items.length, 24);
  assert.deepEqual(feed.items.slice(0, 2).map((i) => i.guid), ["page:https://anthropic.com/news/ipo-close", "page:https://anthropic.com/news/anthropic-prices-initial-public-offering"]);
  assert.equal(new Set(feed.items.map((i) => i.guid)).size, 24, "every post has an id of its own");
  assert.ok(feed.items.every((i) => i.guid?.startsWith("page:https://") && i.url && i.publishedAt), "every post has its link and date");
  assert.equal(feed.items[0]!.publishedAt, "2026-11-20T00:00:00.000Z");
  assert.equal(feed.title, "Newsroom \\ Anthropic", "the source is named by the page's own title");
  assert.equal(feed.siteUrl, "https://www.anthropic.com/news");
  assert.match(a.body, /<description>Page list https:\/\/www\.anthropic\.com\/news<\/description>/, "the feed says which page it is, not what the key is");
  assert.doesNotMatch(a.body, new RegExp(key.slice(0, 40)));
});

test("a page list's titles lose the whitespace of the page's markup, and posts without a web address are left out", async () => {
  const { r } = router([new FakeBackend("rss-bridge", ok(recorded("xpath-whitespace")))]);
  const a = await askPage(r, pageKey({ ...PAGE, url: "http://pages.test/ws.html" }));
  assert.equal(a.status, 200);
  const feed = parseFeed(a.body, a.headers["content-type"]);
  assert.equal(feed.title, "Spaced out title");
  assert.deepEqual(feed.items.map((i) => [i.guid, i.title]), [
    ["page:https://pages.test/p/1", "A title with odd spaces and lines"],
    ["page:https://pages.test/p/2", "Second post"],
    ["page:https://pages.test/p/3", "Third"],
  ]);
  // The tracking parameters are no part of the post's identity; the entry's link is as the page gives it.
  assert.equal(feed.items[1]!.url, "http://pages.test/p/2?utm_source=x&ref=y");
  assert.equal(feed.items[0]!.publishedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(feed.items[1]!.publishedAt, null, "a post whose date the page doesn't show has none, and FreshRSS dates it when it first sees it");
});

test("a page list with no title of its own is named by its page's site", async () => {
  for (const title of ["XPathBridge", "  XPathBridge ", ""]) {
    const { r } = router([new FakeBackend("rss-bridge", ok(xpathAtom([{ title: "One", href: "https://www.anthropic.com/news/one" }], title)))]);
    const feed = parseFeed((await askPage(r, pageKey())).body);
    assert.equal(feed.title, "anthropic.com", JSON.stringify(title));
  }
});

test("a changelog's entries, which are headings of one page, keep their fragments in their ids and links; no other service's links do", async () => {
  const log: typeof PAGE = { ...PAGE, url: "https://go.dev/doc/devel/release" };
  const atom = xpathAtom(["go1.26.0", "go1.25.0", "go1.24.0"].map((h) => ({ title: h, href: `https://go.dev/doc/devel/release#${h}` })), "Release History");
  const { r } = router([new FakeBackend("rss-bridge", ok(atom))]);
  const feed = parseFeed((await askPage(r, pageKey(log))).body);
  assert.deepEqual(feed.items.map((i) => i.guid), ["page:https://go.dev/doc/devel/release#go1.26.0", "page:https://go.dev/doc/devel/release#go1.25.0", "page:https://go.dev/doc/devel/release#go1.24.0"]);
  assert.deepEqual(feed.items.map((i) => i.url), ["https://go.dev/doc/devel/release#go1.26.0", "https://go.dev/doc/devel/release#go1.25.0", "https://go.dev/doc/devel/release#go1.24.0"]);
  // An anchor on another page's address is that page's post, and loses it as before.
  const other = xpathAtom([{ title: "A", href: "https://www.anthropic.com/news/a#comments" }]);
  const second = parseFeed((await askPage(router([new FakeBackend("rss-bridge", ok(other))]).r, pageKey())).body);
  assert.deepEqual(second.items.map((i) => [i.guid, i.url]), [["page:https://anthropic.com/news/a", "https://www.anthropic.com/news/a"]]);
});

test("a page list that matches nothing, or whose page can't be read, is a failure asked about twice, never an empty source", async () => {
  const backend = new FakeBackend("rss-bridge", ok(xpathAtom([])));
  const { r, log } = router([backend]);
  const a = await askPage(r, pageKey());
  assert.equal(a.status, 503);
  assert.equal(backend.calls, 2);
  assert.deepEqual(log.summary().failing.map((f) => [f.service, f.outcome]), [["page", "no_posts"]]);
  assert.equal(bridgeService("page")!.emptyIsFailure, true);
  // Entries that are all without a web address (a page whose list has no links) are no posts either.
  const none = router([new FakeBackend("rss-bridge", ok(xpathAtom([{ title: "No link" }])))]);
  assert.equal((await askPage(none.r, pageKey())).status, 503);
});

test("a page list's key must be one the writer made and one the installation signed: anything else is the same 404 and asks no backend", async () => {
  const backend = new FakeBackend("rss-bridge", ok(xpathAtom([{ title: "One", href: "https://www.anthropic.com/news/one" }])));
  const { r } = router([backend]);
  const key = pageKey();
  const forgedKey = (fields: Record<string, unknown>) => deflateRawSync(Buffer.from(JSON.stringify(fields))).toString("base64url");
  const recipe = PAGE.recipe;
  for (const [k, s] of [
    [key, "x".repeat(43)],
    [key, sig("page", key.slice(0, -1))],
    [key.slice(0, -2), sig("page", key.slice(0, -2))],
    ["not-a-key", sig("page", "not-a-key")],
    // Signed by the installation's key, but not a key the writer makes: the address is private, or the recipe leaves the grammar.
    [forgedKey({ u: "http://169.254.169.254/latest", i: recipe.item, t: recipe.title, l: recipe.link }), ""],
    [forgedKey({ u: PAGE.url, i: "//li[document('http://example.com/x')]", t: recipe.title, l: recipe.link }), ""],
  ] as const) {
    const a = await r.serve("page", k, s || sig("page", k));
    assert.equal(a.status, 404, k.slice(0, 30));
  }
  assert.equal(backend.calls, 0);
  assert.equal((await askPage(r, key)).status, 200, "the real key, signed, is served");
});

test("RSS-Bridge's XPathBridge is asked with the page and the recipe, and the character-set repair only for a page that needs it", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(xpathAtom([{ title: "One", href: "https://www.anthropic.com/news/one" }]));
  });
  try {
    const r = new BridgeRouter({ secret: SECRET, backends: [rssBridgeBackend(`http://127.0.0.1:${upstream.port}`)], log: new BridgeLog({ now: () => T0 }), now: () => T0 });
    for (const fixEncoding of [false, true]) {
      assert.equal((await askPage(r, pageKey({ ...PAGE, fixEncoding }))).status, 200);
    }
    const asked = upstream.requests.map((q) => Object.fromEntries(new URL(q.url, "http://rss-bridge.test").searchParams));
    assert.deepEqual(asked.map((q) => q.fix_encoding), [undefined, "on"]);
    assert.deepEqual(asked.map((q) => [q.bridge, q.url, q.item, q.title, q.uri, q.timestamp]), Array(2).fill(["XPathBridge", PAGE.url, PAGE.recipe.item, PAGE.recipe.title, PAGE.recipe.link, PAGE.recipe.date]));
    assert.ok(asked.every((q) => !("content" in q) && !("author" in q) && !("enclosures" in q) && !("categories" in q)), "nothing but the recipe is asked");
  } finally {
    await upstream.close();
  }
});

test("the running listener serves a page list's longest key", async () => {
  // A page address that makes the key as long as the longest the writer allows (a plain path of words compresses badly enough).
  const urlFor = (n: number) => `https://www.anthropic.com/${Array.from({ length: n }, (_, i) => `news${(i * 7919) % 9973}-${(i * 104729) % 7001}`).join("/")}`;
  let n = 1;
  while (encodePageKey({ ...PAGE, url: urlFor(n + 1) })) n++;
  const source = { ...PAGE, url: urlFor(n) };
  const key = pageKey(source);
  assert.ok(key.length > 300 && key.length <= MAX_PAGE_KEY, `${key.length} characters`);
  assert.deepEqual(decodePageKey(key), { ...source, url: new URL(source.url).href });
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(xpathAtom([{ title: "One", href: "https://www.anthropic.com/news/one" }]));
  });
  const egress = await startEgress(
    makeConfig({ bridge: { host: "127.0.0.1", port: 0, backendUrl: `http://127.0.0.1:${upstream.port}`, secret: SECRET, dbPath: ":memory:", net: null } }),
    { bridgeBackends: [rssBridgeBackend(`http://127.0.0.1:${upstream.port}`)] },
  );
  try {
    const status = await new Promise<number>((resolve, reject) => http.get({ host: "127.0.0.1", port: egress.ports.bridge!, path: bridgeRoutePath(SECRET, "page", key) }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject));
    assert.equal(status, 200);
    assert.equal(new URL(upstream.requests[0]!.url, "http://rss-bridge.test").searchParams.get("url"), new URL(source.url).href);
  } finally {
    await egress.stop();
    await upstream.close();
  }
});
