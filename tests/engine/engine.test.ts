/**
 * Contract tests of the FreshRSS boundary against the real pinned container (see packages/freshrss/CAPABILITIES.md).
 * Run with `npm run test:engine`; on this shared host wrap it: `~/.t3/bin/hostlock work engine-tests -- npm run test:engine`.
 *
 * One engine is started for the file. Every test makes its own engine user and feed so tests do not depend on each other.
 * All feed fetches go through a recording test proxy (the engine has no other way out); the real egress proxy is
 * apps/egress and is not exercised here.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ENGINE_FETCH_CACHE_MIN_SECONDS, EngineError, GReaderClient, normalizeItem, resolveEgressProxy, runSync } from "@purss/freshrss";
import type { SyncBatchDraft } from "@purss/freshrss";
import type { SyncEntry } from "@purss/domain";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHandlers, defaultMakeClient } from "../../apps/worker/src/handlers.ts";
import type { InternalApi } from "../../apps/worker/src/internal-api.ts";
import { createLogger } from "../../apps/worker/src/log.ts";
import { EngineUserSecrets } from "../../apps/worker/src/secrets.ts";
import type { FeedItem } from "./support/feed-server.ts";
import { readZip } from "./support/zip.ts";
import { sleep, startTestEngine, waitFor } from "./support/harness.ts";
import type { TestEngine } from "./support/harness.ts";

const execFileAsync = promisify(execFile);
let engine: TestEngine;
let feedCounter = 0;

before(async () => {
  engine = await startTestEngine();
}, { timeout: 240_000 });

after(async () => {
  await engine?.stop();
}, { timeout: 120_000 });

const items = (n: number, prefix = "post", from = 0): FeedItem[] =>
  Array.from({ length: n }, (_, i) => ({
    guid: `${prefix}-${from + i}`,
    title: `Title ${prefix} ${from + i}`,
    html: `<p>Body ${prefix} ${from + i}</p>`,
    pubDate: new Date(Date.UTC(2026, 0, 1, 0, from + i)),
  }));

function newFeed(title: string, list: FeedItem[]): { url: string; path: string } {
  const path = `/feed-${++feedCounter}.xml`;
  const url = engine.feeds.setFeed({ path, title, items: list });
  return { url, path };
}

/** A stand-in for the product: remembers batches by key, keeps a checkpoint. */
function productStore() {
  const keys = new Set<string>();
  const byExternalId = new Map<string, SyncEntry>();
  const batches: SyncBatchDraft[] = [];
  let checkpoint = { continuation: null as string | null, newestCrawlUsec: null as string | null, engineIdentity: null as string | null };
  return {
    batches,
    byExternalId,
    get checkpoint() {
      return checkpoint;
    },
    submit: async (b: SyncBatchDraft) => {
      batches.push(b);
      if (keys.has(b.idempotencyKey)) return { accepted: 0, duplicates: b.entries.length };
      keys.add(b.idempotencyKey);
      let dup = 0;
      for (const e of b.entries) {
        if (byExternalId.has(e.externalId)) dup += 1;
        byExternalId.set(e.externalId, e);
      }
      checkpoint = { ...b.checkpoint, engineIdentity: b.engineIdentity };
      return { accepted: b.entries.length - dup, duplicates: dup };
    },
  };
}

async function subscribeAndFetch(user: { username: string; client: GReaderClient }, url: string): Promise<string> {
  const added = await user.client.quickAdd(url);
  assert.ok("streamId" in added, "quick-add should have subscribed");
  return added.streamId; // the engine fetches the feed and stores its entries as part of quick-add
}

describe("provisioning and lifecycle", () => {
  test("the engine is up and healthy, the operator can log in, and only the operator user exists", async () => {
    const s = await engine.life.status();
    assert.equal(s.healthy, true, s.problems.join("; "));
    assert.equal(s.api.adminLogin, true);
    assert.equal(s.egress.enforced, "ok");
    assert.match(s.identity ?? "", /^freshrss:[0-9a-f]{32}$/);
    assert.equal(s.users?.length, 1, "only the operator admin exists before any product user");
  });

  test("provisioning an API user is idempotent and re-running keeps the identity and the credentials working", async () => {
    const username = "provtest1";
    const pw1 = "a".repeat(32);
    assert.deepEqual(await engine.admin.ensureUser({ username, apiPassword: pw1 }), { created: true });
    const identityBefore = await engine.admin.engineIdentity();
    assert.deepEqual(await engine.admin.ensureUser({ username, apiPassword: pw1 }), { created: false });
    assert.equal(await engine.admin.engineIdentity(), identityBefore);
    await new GReaderClient({ baseUrl: engine.baseUrl, username, apiPassword: pw1 }).login();
    assert.equal((await engine.admin.listUsers()).filter((u) => u === username).length, 1);
  });

  test("rotating an API password invalidates the old one and the client recovers with the new one", async () => {
    const u = await engine.newUser("rot");
    const old = u.apiPassword;
    const fresh = "b".repeat(32);
    await engine.admin.setApiPassword({ username: u.username, apiPassword: fresh });
    await assert.rejects(new GReaderClient({ baseUrl: engine.baseUrl, username: u.username, apiPassword: old }).login(), (e: unknown) => e instanceof EngineError && e.kind === "auth");
    await new GReaderClient({ baseUrl: engine.baseUrl, username: u.username, apiPassword: fresh }).login();
    // the previously issued session of the old client keeps no access after rotation
    await assert.rejects(u.client.listSubscriptions(), (e: unknown) => e instanceof EngineError && e.kind === "auth");
  });

  test("engine users have no web password and no default feeds", async () => {
    const u = await engine.newUser("nopw");
    assert.deepEqual(await u.client.listSubscriptions(), [], "no default feeds that would be fetched behind the proxy's back");
    const out = await engine.php('$c = require "/var/www/FreshRSS/data/users/" . $argv[1] . "/config.php"; echo json_encode(["web" => $c["passwordHash"] ?? null, "api" => ($c["apiPasswordHash"] ?? "") !== ""]);', u.username);
    assert.deepEqual(JSON.parse(out), { web: "", api: true });
  });

  test("a wrong API password is rejected as an auth error", async () => {
    const u = await engine.newUser("bad");
    await assert.rejects(new GReaderClient({ baseUrl: engine.baseUrl, username: u.username, apiPassword: "c".repeat(32) }).login(), (e: unknown) => e instanceof EngineError && e.kind === "auth" && !e.retryable);
    await assert.rejects(new GReaderClient({ baseUrl: engine.baseUrl, username: "no-such-user", apiPassword: "c".repeat(32) }).login(), (e: unknown) => e instanceof EngineError && e.kind === "auth");
  });

  test("restarting the engine keeps users, data and identity (stop/start and down/up)", { timeout: 240_000 }, async () => {
    const u = await engine.newUser("persist");
    const feed = newFeed("Persist", items(3, "persist"));
    await subscribeAndFetch(u, feed.url);
    const before = { identity: await engine.admin.engineIdentity(), users: await engine.admin.listUsers() };
    await engine.life.down();
    await engine.life.up();
    assert.equal(await engine.admin.engineIdentity(), before.identity);
    assert.deepEqual(await engine.admin.listUsers(), before.users);
    const login = new GReaderClient({ baseUrl: engine.baseUrl, username: u.username, apiPassword: u.apiPassword });
    const page = await login.streamContents({ count: 50, order: "asc" });
    assert.equal(page.items.length, 3);
  });

  test("a second engine instance has a different identity (a replacement engine is a new engine)", { timeout: 300_000 }, async () => {
    const other = await startTestEngine();
    try {
      assert.notEqual(await other.admin.engineIdentity(), await engine.admin.engineIdentity());
    } finally {
      await other.stop();
    }
  });

  test("deleting an engine user removes it and its data directory, and other users stay", async () => {
    const gone = await engine.newUser("del");
    const stays = await engine.newUser("keep");
    const feed = newFeed("Deleted", items(2, "del"));
    await subscribeAndFetch(gone, feed.url);
    const dir = (name: string) => engine.php('echo is_dir("/var/www/FreshRSS/data/users/" . $argv[1]) ? "yes" : "no";', name);
    assert.equal(await dir(gone.username), "yes");
    await engine.admin.deleteUser(gone.username);
    assert.equal(await engine.admin.userExists(gone.username), false, "list-users no longer has it");
    assert.equal(await dir(gone.username), "no", "its data directory is gone");
    await assert.rejects(new GReaderClient({ baseUrl: engine.baseUrl, username: gone.username, apiPassword: gone.apiPassword }).login(), (e: unknown) => e instanceof EngineError && e.kind === "auth");
    await assert.rejects(engine.admin.deleteUser(gone.username), (e: unknown) => e instanceof EngineError, "deleting it again is an error, which is why the worker checks first");
    assert.equal(await engine.admin.userExists(stays.username), true);
    await stays.client.listSubscriptions();
  });

  test("the effective retention policy of new users is the recorded one", async () => {
    const u = await engine.newUser("ret");
    const eff = await engine.admin.readUserArchiving(u.username);
    assert.deepEqual(eff.archiving, engine.cfg.archiving);
    assert.equal(eff.ttl_default, engine.cfg.ttlDefaultSeconds);
  });
});

describe("egress: every feed fetch goes through the configured proxy", () => {
  test("a feed is fetched through the proxy, and only through it", async () => {
    const u = await engine.newUser("egress");
    const feed = newFeed("Via proxy", items(2, "eg"));
    const proxyBefore = engine.proxy.seen.length;
    await subscribeAndFetch(u, feed.url);
    const used = engine.proxy.seen.slice(proxyBefore).filter((r) => r.url.endsWith(feed.path));
    assert.ok(used.length >= 1, "the proxy saw the feed request");
    assert.ok(used.every((r) => r.method === "GET" && r.allowed));
    const hits = engine.feeds.hits.filter((h) => h.path === feed.path);
    assert.ok(hits.length >= 1 && hits.every((h) => h.viaProxy), "the feed server only ever heard from the proxy");
  });

  test("with the proxy down, fetching fails instead of going direct", async () => {
    const u = await engine.newUser("down");
    const feed = newFeed("Unreachable", items(1, "dn"));
    const port = engine.proxy.port;
    await engine.proxy.stop();
    try {
      const hitsBefore = engine.feeds.hits.length;
      await assert.rejects(u.client.quickAdd(feed.url), (e: unknown) => e instanceof EngineError && e.kind === "unavailable" && e.retryable, "an unreachable proxy is a temporary condition");
      assert.equal(engine.feeds.hits.length, hitsBefore, "nothing reached the feed server");
      assert.deepEqual(await u.client.listSubscriptions(), []);
    } finally {
      await engine.proxy.start(port);
    }
  });

  test("a host the proxy refuses is not fetched, and the engine does not fall back to a direct request", async () => {
    const u = await engine.newUser("refused");
    const before = engine.proxy.seen.length;
    const res = await u.client.quickAdd("http://10.255.255.1:9/feed.xml").catch((e: unknown) => e);
    assert.ok(res instanceof EngineError && res.kind === "rejected" && !res.retryable && /403/.test(res.message), String(res));
    const seen = engine.proxy.seen.slice(before);
    assert.ok(seen.some((r) => r.url.includes("10.255.255.1") && !r.allowed), "the attempt went to the proxy and was refused there");
  });

  test("the engine's own internal-host guard is not weakened: only the proxy address is allowed", async () => {
    const out = await engine.php('$c = require "/var/www/FreshRSS/data/config.php"; echo json_encode($c["internal_host_allowlist"] ?? null);');
    assert.deepEqual(JSON.parse(out), [`169.254.1.2:${engine.proxy.port}`]);
  });
});

describe("subscription management", () => {
  test("subscribe returns the stream id and title; subscribing twice reports the existing subscription; list shows it", async () => {
    const u = await engine.newUser("sub");
    const feed = newFeed("My Feed", items(2, "s"));
    const first = await u.client.quickAdd(feed.url);
    assert.ok("streamId" in first && /^feed\/\d+$/.test(first.streamId));
    assert.equal(first.title, "My Feed");
    const again = await u.client.quickAdd(feed.url);
    assert.ok("already" in again, JSON.stringify(again));
    const list = await u.client.listSubscriptions();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.url, feed.url);
    assert.equal(list[0]!.title, "My Feed");
  });

  test("rename changes the engine's title; unsubscribe removes the subscription; an unknown stream is a bad request to unsubscribe but a silent no-op to rename", async () => {
    const u = await engine.newUser("ren");
    const feed = newFeed("Original", items(1, "r"));
    const added = await u.client.quickAdd(feed.url);
    assert.ok("streamId" in added);
    await u.client.renameSubscription(added.streamId, "Renamed ☕ & more");
    assert.equal((await u.client.listSubscriptions())[0]!.title.includes("Renamed"), true);
    await u.client.unsubscribe(added.streamId);
    assert.deepEqual(await u.client.listSubscriptions(), []);
    await assert.rejects(u.client.unsubscribe(added.streamId), (e: unknown) => e instanceof EngineError && e.kind === "bad_request");
    // observed: the engine answers OK to a rename of a stream that does not exist, so the worker checks the list first
    await u.client.renameSubscription("feed/999999", "x");
    assert.deepEqual(await u.client.listSubscriptions(), []);
  });

  test("a URL that is not a feed is rejected permanently", async () => {
    const u = await engine.newUser("nofeed");
    engine.feeds.feeds.delete("/not-a-feed");
    const res = await u.client.quickAdd(`${engine.feeds.base}/definitely-missing`).catch((e: unknown) => e);
    assert.ok(res instanceof EngineError && res.kind === "rejected" && !res.retryable, String(res));
  });
});

describe("entries: shape, paging, incremental sync", () => {
  test("stream entries map to the SyncEntry contract; the original GUID is not in the standard stream", async () => {
    const u = await engine.newUser("shape");
    const list = items(1, "shape");
    list[0] = { ...list[0]!, link: `${engine.feeds.base}/articles/alpha`, title: "Q&A <tags> and “quotes”", html: "<p>Hello <b>world</b></p>", enclosure: { url: `${engine.feeds.base}/audio.mp3`, type: "audio/mpeg", length: 12345 } };
    const feed = newFeed("Shape", list);
    await subscribeAndFetch(u, feed.url);
    const page = await u.client.streamContents({ count: 10, order: "asc" });
    assert.equal(page.items.length, 1);
    const raw = page.items[0]!;
    assert.equal("guid" in raw, false, "no GUID field in the compat output");
    assert.ok(!JSON.stringify(raw).includes("shape-0"), "the feed's GUID string appears nowhere in the item");
    const { entry } = normalizeItem(raw);
    assert.equal(entry.title, "Q&A <tags> and “quotes”", "ampersand and angle brackets are restored from their fullwidth forms");
    assert.equal(entry.originalGuid, null);
    assert.equal(entry.contentHtml?.includes("<b>world</b>"), true);
    assert.equal(entry.author, "Test Author");
    assert.match(entry.streamId, /^feed\/\d+$/);
    assert.equal(entry.url, `${engine.feeds.base}/articles/alpha`);
    assert.equal(entry.enclosures.some((e) => e.url.endsWith("/audio.mp3") && e.type === "audio/mpeg"), true);
    assert.match(entry.externalId, /^\d{16}$/, "decimal id = first-crawl time in microseconds");
    assert.equal(raw.timestampUsec, entry.externalId, "the engine id and the crawl timestamp are the same number");
  });

  test("the original GUID is obtainable only through the engine's own export, and joins to the sync id", async () => {
    const u = await engine.newUser("guid");
    const feed = newFeed("Guids", items(3, "gd"));
    await subscribeAndFetch(u, feed.url);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    const viaApi = page.items.map((i) => normalizeItem(i).entry);
    assert.ok(viaApi.every((e) => e.originalGuid === null));

    // `cli/export-zip-for-user.php` is a documented FreshRSS export; its JSON uses the output mode that includes the GUID.
    const { stdout } = await execFileAsync("podman", ["exec", "--user", "www-data", engine.cfg.containerName, "php", "-f", "./cli/export-zip-for-user.php", "--", `--user=${u.username}`, "--max-feed-entries=100"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    const files = readZip(stdout);
    const feedFile = [...files.keys()].find((n) => /^feed_.*\.json$/.test(n));
    assert.ok(feedFile, `export contained ${[...files.keys()].join(", ")}`);
    const exported = JSON.parse(files.get(feedFile)!.toString("utf8")) as { items: Array<{ "frss:id": string; guid: string; title: string; origin: { feedUrl: string } }> };
    assert.equal(exported.items.length, 3);
    for (const e of viaApi) {
      const match = exported.items.find((x) => x["frss:id"] === e.externalId);
      assert.ok(match, "the export's frss:id is the sync externalId");
      assert.match(match.guid, /^gd-\d$/);
      assert.equal(match.origin.feedUrl, feed.url);
    }
  });

  test("paging with continuation walks every entry exactly once in ascending crawl order", async () => {
    const u = await engine.newUser("page");
    const feed = newFeed("Paged", items(25, "pg"));
    await subscribeAndFetch(u, feed.url);
    const seen: string[] = [];
    let continuation: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof u.client.streamContents>> = await u.client.streamContents({ count: 7, order: "asc", continuation });
      seen.push(...page.items.map((i) => i.timestampUsec));
      continuation = page.continuation;
      pages += 1;
      assert.ok(pages < 20);
    } while (continuation);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
    assert.deepEqual(seen, [...seen].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
    assert.equal(pages, 4, "7 + 7 + 7 + 4");
  });

  test("runSync imports a backlog, resumes incrementally from the checkpoint, and replaying a committed page is a no-op", async () => {
    const u = await engine.newUser("sync");
    const feed = newFeed("Synced", items(10, "sy"));
    const sid = await subscribeAndFetch(u, feed.url);
    const setItems = (n: number) => engine.feeds.setFeed({ path: feed.path, title: "Synced", items: items(n, "sy") });
    // entries are stamped with their crawl second; spread the backlog over three refreshes so the lower bound has something to skip
    await sleep(1200);
    setItems(18);
    await engine.refresh(u.username, sid);

    const store = productStore();
    const identity = await engine.admin.engineIdentity();
    const common = { client: u.client, engineUserId: "eu_sync", engineIdentity: identity, submit: store.submit, pageSize: 5, overlapSeconds: 0 };
    const first = await runSync({ ...common, checkpoint: null });
    assert.equal(first.complete, true);
    assert.equal(store.byExternalId.size, 18);
    assert.equal(first.accepted, 18);

    await sleep(1200);
    setItems(22);
    await engine.refresh(u.username, sid);
    const second = await runSync({ ...common, checkpoint: store.checkpoint });
    assert.equal(store.byExternalId.size, 22);
    assert.equal(second.accepted, 4);
    assert.ok(second.entries < 22, `incremental read (${second.entries} entries) is smaller than the full history (22)`);
    assert.ok(second.entries >= 4);

    // replay: resubmitting the exact batches again changes nothing
    const replayed = productStore();
    for (const b of store.batches) await replayed.submit(b);
    for (const b of store.batches) {
      const r = await replayed.submit(b);
      assert.equal(r.accepted, 0);
    }
    assert.equal(replayed.byExternalId.size, store.byExternalId.size);
  });

  test("an interrupted walk resumes from its continuation without gaps", async () => {
    const u = await engine.newUser("resume");
    const feed = newFeed("Resumed", items(23, "rs"));
    await subscribeAndFetch(u, feed.url);
    const store = productStore();
    let calls = 0;
    const flaky = async (b: SyncBatchDraft) => {
      calls += 1;
      if (calls === 3) throw new EngineError("network", "simulated outage");
      return store.submit(b);
    };
    const identity = await engine.admin.engineIdentity();
    await assert.rejects(runSync({ client: u.client, engineUserId: "eu_rs", engineIdentity: identity, checkpoint: null, submit: flaky, pageSize: 5 }), /simulated outage/);
    assert.equal(store.byExternalId.size, 10);
    const resumed = await runSync({ client: u.client, engineUserId: "eu_rs", engineIdentity: identity, checkpoint: store.checkpoint, submit: store.submit, pageSize: 5 });
    assert.equal(resumed.complete, true);
    assert.equal(store.byExternalId.size, 23);
    assert.equal(resumed.duplicates, 0);
  });

  test("a late-arriving old article gets a new engine id and is found by the incremental pass", async () => {
    const u = await engine.newUser("late");
    const feed = newFeed("Late", items(3, "lt"));
    const sid = await subscribeAndFetch(u, feed.url);
    const store = productStore();
    const identity = await engine.admin.engineIdentity();
    const opts = { client: u.client, engineUserId: "eu_lt", engineIdentity: identity, submit: store.submit, overlapSeconds: 0 };
    await runSync({ ...opts, checkpoint: null });
    const old = { guid: "lt-old", title: "Published long ago, discovered today", html: "<p>old</p>", pubDate: new Date("2019-05-05T00:00:00Z") };
    engine.feeds.setFeed({ path: feed.path, title: "Late", items: [...items(3, "lt"), old] });
    await sleep(1100);
    await engine.refresh(u.username, sid);
    await runSync({ ...opts, checkpoint: store.checkpoint });
    const found = [...store.byExternalId.values()].find((e) => e.title.startsWith("Published long ago"));
    assert.ok(found, "found");
    assert.equal(found.publishedAt?.startsWith("2019-05-05"), true, "published time is the old one");
    const newestOther = Math.max(...[...store.byExternalId.values()].filter((e) => e !== found).map((e) => Date.parse(e.crawledAt)));
    assert.ok(Date.parse(found.crawledAt) > newestOther, "but its engine crawl time (and id) is the newest");
  });

  test("an entry edited upstream keeps its engine id and crawl time, carries the new content, and reappears in the incremental pass", async () => {
    const u = await engine.newUser("edit");
    const feed = newFeed("Edited", items(4, "ed"));
    const sid = await subscribeAndFetch(u, feed.url);
    const store = productStore();
    const identity = await engine.admin.engineIdentity();
    const opts = { client: u.client, engineUserId: "eu_ed", engineIdentity: identity, submit: store.submit, overlapSeconds: 0 };
    await runSync({ ...opts, checkpoint: null });
    const target = [...store.byExternalId.values()].find((e) => e.title === "Title ed 1")!;
    const before = { ...target };

    // push a newer entry afterwards so the lower bound moves past the edited one's id
    await sleep(1100);
    const changed = items(4, "ed");
    changed[1] = { ...changed[1]!, title: "Title ed 1 (corrected)", html: "<p>Corrected body</p>" };
    engine.feeds.setFeed({ path: feed.path, title: "Edited", items: [...changed, ...items(1, "ed", 4)] });
    await engine.refresh(u.username, sid);
    const second = await runSync({ ...opts, checkpoint: store.checkpoint });
    const after = store.byExternalId.get(before.externalId)!;
    assert.equal(after.externalId, before.externalId, "same engine id");
    assert.equal(after.crawledAt, before.crawledAt, "crawl time does not move on edit");
    assert.equal(after.title, "Title ed 1 (corrected)");
    assert.equal(after.contentHtml?.includes("Corrected body"), true);
    assert.ok(second.entries >= 2, "the edited entry came back with the new one");
  });

  test("upstream removal of an article does not remove it from the engine", async () => {
    const u = await engine.newUser("gone");
    const feed = newFeed("Shrinking", items(5, "gn"));
    const sid = await subscribeAndFetch(u, feed.url);
    engine.feeds.setFeed({ path: feed.path, title: "Shrinking", items: items(3, "gn") });
    await engine.refresh(u.username, sid);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    assert.equal(page.items.length, 5, "the engine keeps entries the feed stopped listing (until its retention policy purges them)");
  });
});

describe("removed subscriptions leave product data alone", () => {
  test("unsubscribing makes the entries disappear from the engine; replaying sync offers nothing and no deletion exists to apply", async () => {
    const u = await engine.newUser("unsub");
    const feed = newFeed("Doomed", items(6, "ds"));
    const streamId = await subscribeAndFetch(u, feed.url);
    const store = productStore();
    const identity = await engine.admin.engineIdentity();
    const opts = { client: u.client, engineUserId: "eu_ds", engineIdentity: identity, submit: store.submit, overlapSeconds: 0 };
    await runSync({ ...opts, checkpoint: null });
    assert.equal(store.byExternalId.size, 6);

    await u.client.unsubscribe(streamId);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    assert.equal(page.items.length, 0, "the engine removed the entries together with the subscription");
    const batchesBefore = store.batches.length;
    const after = await runSync({ ...opts, checkpoint: store.checkpoint });
    assert.equal(after.entries, 0);
    assert.equal(store.byExternalId.size, 6, "the product keeps everything it imported");
    assert.ok(store.batches.slice(batchesBefore).every((b) => b.entries.length === 0));

    // subscribing again creates a NEW stream with NEW entry ids; nothing links them to the old ones except content
    const again = await u.client.quickAdd(feed.url);
    assert.ok("streamId" in again && again.streamId !== streamId);
    const reimport = await runSync({ ...opts, checkpoint: store.checkpoint });
    assert.equal(reimport.accepted, 6, "re-followed entries arrive as new engine entries (the product must match them by URL/content, not by id)");
  });
});

describe("read and star mirroring", () => {
  test("marking read and unread is reflected by the engine's unread count and stream filter", async () => {
    const u = await engine.newUser("read");
    const feed = newFeed("Readable", items(5, "rd"));
    await subscribeAndFetch(u, feed.url);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    const ids = page.items.map((i) => normalizeItem(i).entry.externalId);
    assert.equal(await u.client.unreadCount(), 5);
    await u.client.markRead(ids.slice(0, 3), true);
    assert.equal(await u.client.unreadCount(), 2);
    const unread = await u.client.streamContents({ count: 50, order: "asc", excludeRead: true });
    assert.deepEqual(unread.items.map((i) => normalizeItem(i).entry.externalId), ids.slice(3));
    await u.client.markRead([ids[0]!], false);
    assert.equal(await u.client.unreadCount(), 3);
    // marking an id that does not exist is accepted silently
    await u.client.markRead(["9999999999999999"], true);
    assert.equal(await u.client.unreadCount(), 3);
  });

  test("starring is mirrored by the engine and does not change read state", async () => {
    const u = await engine.newUser("star");
    const feed = newFeed("Starry", items(2, "st"));
    await subscribeAndFetch(u, feed.url);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    const id = normalizeItem(page.items[0]!).entry.externalId;
    await u.client.setStarred([id], true);
    const after = await u.client.streamContents({ count: 50, order: "asc" });
    const raw = after.items.find((i) => normalizeItem(i).entry.externalId === id)!;
    assert.ok(raw.categories?.includes("user/-/state/com.google/starred"));
    assert.ok(!raw.categories?.includes("user/-/state/com.google/read"));
    await u.client.setStarred([id], false);
  });

  test("read state does not influence what sync offers (the product owns reading state)", async () => {
    const u = await engine.newUser("rdsync");
    const feed = newFeed("ReadSync", items(4, "rs2"));
    await subscribeAndFetch(u, feed.url);
    const page = await u.client.streamContents({ count: 50, order: "asc" });
    await u.client.markRead(page.items.map((i) => normalizeItem(i).entry.externalId), true);
    const store = productStore();
    const identity = await engine.admin.engineIdentity();
    await runSync({ client: u.client, engineUserId: "eu_rs2", engineIdentity: identity, checkpoint: null, submit: store.submit });
    assert.equal(store.byExternalId.size, 4);
  });
});

/** What FreshRSS itself makes of the system config: its own loader, defaults merged under data/config.php. */
const effectiveLimits = async () => JSON.parse(await engine.php('chdir("/var/www/FreshRSS"); require "/var/www/FreshRSS/cli/_cli.php"; echo json_encode(FreshRSS_Context::systemConf()->limits);')) as Record<string, number>;

describe("one fetch for many accounts", () => {
  test("a new engine keeps every fetch for 800 s and leaves the other limits at the engine's defaults", async () => {
    const limits = await effectiveLimits();
    assert.equal(limits.cache_duration_min, ENGINE_FETCH_CACHE_MIN_SECONDS);
    assert.equal(limits.cache_duration, 800);
    assert.equal(limits.cache_duration_max, 86400);
    assert.equal(limits.timeout, 20, "a partial limits array is merged over the defaults, not instead of them");
    assert.equal(limits.max_feeds, 131072);
    assert.equal((await engine.life.status()).egress.enforced, "ok");
  });

  test("an existing engine without the setting is reported as drifted, corrected in place, and keeps its other limits", async () => {
    const config = '$p = "/var/www/FreshRSS/data/config.php"; $c = require $p; ';
    const write = 'file_put_contents($p, "<?php\n return " . var_export($c, true) . ";\n");';
    await engine.php(`${config} unset($c["limits"]["cache_duration_min"]); $c["limits"]["timeout"] = 33; ${write}`);
    try {
      assert.equal((await effectiveLimits()).cache_duration_min, 60, "the engine's own default applies without it");
      const proxy = resolveEgressProxy(engine.cfg.egressProxy).hostPort;
      assert.equal((await engine.life.status()).egress.enforced, "drift");
      assert.equal(await engine.admin.applyEgressConfig({ proxyHostPort: proxy, dryRun: true }), "updated");
      assert.equal(await engine.admin.applyEgressConfig({ proxyHostPort: proxy }), "updated");
      assert.equal(await engine.admin.applyEgressConfig({ proxyHostPort: proxy, dryRun: true }), "unchanged");
      assert.equal((await engine.life.status()).egress.enforced, "ok");
      const limits = await effectiveLimits();
      assert.equal(limits.cache_duration_min, 800);
      assert.equal(limits.timeout, 33, "what the engine already had in limits is kept");
    } finally {
      await engine.php(`${config} unset($c["limits"]["timeout"]); ${write}`);
    }
  });

  test("accounts that follow one new feed at the same moment cause a single fetch, and each keeps only its own items", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "purss-parallel-"));
    try {
      const secrets = new EngineUserSecrets(path.join(dir, "engine-users"));
      const accounts = await Promise.all(["a", "b", "c"].map(async (label) => {
        const id = `eu_par_${label}`;
        const username = `tpar${label}${Math.random().toString(16).slice(2, 8)}`;
        const { apiPassword } = secrets.ensure(id);
        await engine.admin.ensureUser({ username, apiPassword });
        return { id, username, apiPassword, client: new GReaderClient({ baseUrl: engine.baseUrl, username, apiPassword, requestTimeoutMs: 60_000 }) };
      }));
      // The worker's own subscribe handler, against the real engine: the only part of the worker these accounts touch.
      const handlers = createHandlers({
        api: { engineUser: async (id: string) => ({ id, username: accounts.find((a) => a.id === id)!.username, baseUrl: engine.baseUrl }) } as unknown as InternalApi,
        secrets,
        secretsDir: dir,
        admin: engine.admin,
        log: createLogger(() => {}),
        makeClient: defaultMakeClient(60_000),
        syncPageSize: 10,
        syncOverlapSeconds: 0,
        syncMaxBatchBytes: 700_000,
        requestTimeoutMs: 60_000,
      });
      const feed = newFeed("Shared", items(5, "shared"));
      const results = await Promise.all(accounts.map((a) =>
        handlers["engine.subscribe"]!({
          job: { id: `job_${a.id}`, kind: "engine.subscribe", payload: null, leaseId: "lse", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempts: 1 },
          payload: { engineUserId: a.id, sourceId: `src_${a.id}`, feedUrl: feed.url, title: "Shared" },
          signal: new AbortController().signal,
        })));
      assert.ok(results.every((r) => typeof r === "object" && typeof (r as Record<string, unknown>).streamId === "string"));
      assert.equal(engine.feeds.hits.filter((h) => h.path === feed.path).length, 1, "three accounts, one request to the feed");

      // Each account holds its own subscription and its own copy of the items; reading in one changes nothing in another.
      const identity = await engine.admin.engineIdentity();
      for (const a of accounts) {
        assert.equal((await a.client.listSubscriptions()).length, 1);
        const store = productStore();
        await runSync({ client: a.client, engineUserId: a.id, engineIdentity: identity, checkpoint: null, submit: store.submit });
        assert.equal(store.byExternalId.size, 5, `${a.username} has all five items`);
        assert.ok([...store.byExternalId.values()].every((e) => e.title.startsWith("Title shared")));
      }
      const first = accounts[0]!;
      await first.client.markRead((await first.client.streamContents({ count: 50, order: "asc" })).items.map((i) => normalizeItem(i).entry.externalId), true);
      assert.equal(await first.client.unreadCount(), 0);
      assert.equal(await accounts[1]!.client.unreadCount(), 5, "another account's items are still unread");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a feed that says no-store is not fetched again when each account's refresh comes a minute apart", { timeout: 240_000 }, async () => {
    // The test feed server answers every request with `Cache-Control: no-store`. The engine keeps such a fetch for its
    // minimum cache time (60 s by default, 800 s here): a refresh for the second account that comes later than that, as
    // happens when many accounts are refreshed in one run, would have fetched the feed again with the default.
    const a = await engine.newUser("ns1");
    const b = await engine.newUser("ns2");
    const feed = newFeed("NoStore", items(4, "nostore"));
    const streamA = await subscribeAndFetch(a, feed.url);
    const streamB = await subscribeAndFetch(b, feed.url);
    const hits = () => engine.feeds.hits.filter((h) => h.path === feed.path).length;
    assert.equal(hits(), 1, "following it a second time already shares the first fetch");
    await sleep(65_000);
    await engine.admin.actualize({ username: a.username, feedId: Number(streamA.replace("feed/", "")) });
    await engine.admin.actualize({ username: b.username, feedId: Number(streamB.replace("feed/", "")) });
    assert.equal(hits(), 1, "both refreshes were served from the fetch the engine still holds");
    assert.equal((await b.client.streamContents({ count: 50, order: "asc" })).items.length, 4);
  });
});

describe("scheduled refresh", () => {
  test("the engine's own scheduler refreshes feeds without any API call", { timeout: 300_000 }, async () => {
    const scheduled = await startTestEngine({ cronMin: "*", ttlDefaultSeconds: 60 });
    try {
      const u = await scheduled.newUser("cron");
      const path = "/cron-feed.xml";
      const url = scheduled.feeds.setFeed({ path, title: "Cron", items: items(2, "cr") });
      await u.client.quickAdd(url);
      assert.equal((await u.client.streamContents({ count: 50, order: "asc" })).items.length, 2);
      // a new article appears upstream, and the fetch the engine kept for 800 s has aged out; nobody calls actualize
      scheduled.feeds.setFeed({ path, title: "Cron", items: items(3, "cr") });
      await scheduled.dropFetchCache();
      const got = await waitFor(async () => {
        const page = await u.client.streamContents({ count: 50, order: "asc" });
        return page.items.length === 3 ? page : null;
      }, { timeoutMs: 240_000, everyMs: 5000, what: "the engine's cron to import the new article" });
      assert.equal(got.items.length, 3);
    } finally {
      await scheduled.stop();
    }
  });
});
