import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EngineError } from "@purss/freshrss";
import { FakeEngine } from "../../../packages/freshrss/src/testing/fake-engine.ts";
import { createHandlers, defaultMakeClient } from "./handlers.ts";
import type { CaptureFn, IconFn, PicturesFn, HandlerDeps } from "./handlers.ts";
import { InternalApi } from "./internal-api.ts";
import { createLogger } from "./log.ts";
import { JobFailure, SETTLED, classify } from "./runner.ts";
import type { JobHandler } from "./runner.ts";
import { EngineUserSecrets } from "./secrets.ts";
import { FakeInternalApi } from "./testing/fake-internal-api.ts";

const quiet = createLogger(() => {});
const T0 = 1_762_000_000n;

async function setup(opts: { capture?: CaptureFn; pictures?: PicturesFn; icon?: IconFn; makeClient?: HandlerDeps["makeClient"]; deleteUser?: (username: string) => Promise<void> } = {}) {
  const engine = new FakeEngine();
  engine.users.set("eng_user", "known-api-password-0123456789");
  const engineSrv = await engine.listen();
  const fake = new FakeInternalApi();
  const apiSrv = await fake.listen();
  fake.engineUsers.set("eu1", { id: "eu1", username: "eng_user", baseUrl: engineSrv.baseUrl });
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-"));
  const secrets = new EngineUserSecrets(path.join(dir, "engine-users"));
  const adminCalls: Array<{ op: string; secretFileExistedAtCall?: boolean; apiPassword?: string; attemptRecorded?: boolean }> = [];
  let identity = "freshrss:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const api = new InternalApi({ baseUrl: apiSrv.url, token: { get: () => fake.token, invalidate() {} }, retryDelaysMs: [10] });
  const deps: HandlerDeps = {
    api,
    secrets,
    secretsDir: dir,
    admin: {
      ensureUser: async ({ apiPassword }) => {
        adminCalls.push({ op: "ensureUser", secretFileExistedAtCall: existsSync(path.join(dir, "engine-users", "eu1")), apiPassword });
        engine.users.set("eng_user", apiPassword);
        return { created: adminCalls.filter((c) => c.op === "ensureUser").length === 1 };
      },
      engineIdentity: async () => identity,
      userExists: async (username) => engine.users.has(username),
      deleteUser: async (username) => {
        adminCalls.push({ op: "deleteUser", attemptRecorded: !!fake.deletions.get("eu1")?.engineAttemptedAt });
        if (opts.deleteUser) return opts.deleteUser(username);
        engine.users.delete(username);
      },
    },
    log: quiet,
    makeClient: opts.makeClient ?? defaultMakeClient(3000),
    ...(opts.capture ? { capture: opts.capture } : {}),
    ...(opts.pictures ? { pictures: opts.pictures } : {}),
    ...(opts.icon ? { icon: opts.icon } : {}),
    syncPageSize: 10,
    syncOverlapSeconds: 0,
    syncMaxBatchBytes: 700_000,
    requestTimeoutMs: 3000,
  };
  const handlers = createHandlers(deps);
  // Results are records, except SETTLED for jobs whose last API call already recorded the outcome.
  const run = async (kind: string, payload: unknown, jobId = "job_x"): Promise<Record<string, unknown>> => {
    const handler = handlers[kind as keyof typeof handlers] as JobHandler;
    const leaseId = `lse_${Math.random()}`;
    // a lease must exist for batch posts to be accepted
    fake.leased.set(jobId, { job: { id: jobId, kind, payload }, leaseId });
    return handler({ job: { id: jobId, kind: kind as never, payload, leaseId, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), attempts: 1 }, payload: payload as never, signal: new AbortController().signal }) as Promise<Record<string, unknown>>;
  };
  return {
    engine, fake, secrets, adminCalls, run, handlers, dir,
    setIdentity: (v: string) => { identity = v; },
    async close() { await engineSrv.close(); await apiSrv.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seed(engine: FakeEngine, n: number, start = T0): void {
  const feed = engine.feeds[0] ?? engine.addFeed("https://example.org/feed.xml", "Example");
  for (let i = 0; i < n; i++) engine.addEntry({ id: (start + BigInt(i * 30)) * 1_000_000n + BigInt(i), feedId: feed.id, title: `E${i}`, content: `<p>${i}</p>`, link: `https://example.org/${i}` });
}

test("provision stores the credential (0600) before the engine sees it, and is idempotent", async () => {
  const t = await setup();
  try {
    const first = await t.run("engine.provision", { engineUserId: "eu1", username: "eng_user" });
    assert.equal(first.created, true);
    assert.match(first.engineIdentity as string, /^freshrss:/);
    const file = path.join(t.dir, "engine-users", "eu1");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(t.adminCalls[0]!.secretFileExistedAtCall, true, "secret existed before ensureUser ran");
    const password = readFileSync(file, "utf8").trim();
    assert.equal(t.adminCalls[0]!.apiPassword, password);
    assert.match(password, /^[0-9a-f]{48}$/);

    const second = await t.run("engine.provision", { engineUserId: "eu1", username: "eng_user" });
    assert.equal(second.created, false);
    assert.equal(t.adminCalls[1]!.apiPassword, password, "the stored password is reused, not regenerated");
    assert.equal(readFileSync(file, "utf8").trim(), password);
  } finally { await t.close(); }
});

test("provision refuses a username that differs from the API's record", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.run("engine.provision", { engineUserId: "eu1", username: "someone_else" }), (e: unknown) => e instanceof JobFailure && !e.retryable);
    assert.equal(existsSync(path.join(t.dir, "engine-users", "eu1")), false);
  } finally { await t.close(); }
});

test("a path-like engine user id can never escape the secrets directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-"));
  try {
    const s = new EngineUserSecrets(path.join(dir, "u"));
    for (const bad of ["../x", "a/b", "", ".hidden", "a\0b"]) assert.throws(() => s.ensure(bad), /not a safe file name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync imports a backlog in batches that satisfy the contract, saves the checkpoint, and resumes incrementally", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 25);
    const r1 = await t.run("engine.sync", { engineUserId: "eu1" });
    assert.equal(r1.entries, 25);
    assert.equal(r1.accepted, 25);
    assert.equal(t.fake.imported.get("eu1")!.size, 25);
    assert.equal(t.fake.calls.batches.length, 3, "10 + 10 + 5");
    const cp = t.fake.checkpoints.get("eu1")!;
    assert.equal(cp.continuation, null, "a finished walk stores no continuation");
    assert.equal(cp.engineIdentity, "freshrss:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    seed(t.engine, 3, T0 + 100_000n);
    const r2 = await t.run("engine.sync", { engineUserId: "eu1" });
    assert.equal(r2.accepted, 3);
    assert.ok((r2.entries as number) <= 4, "only the new entries plus the newest known one are re-read");
    assert.equal(t.fake.imported.get("eu1")!.size, 28);
  } finally { await t.close(); }
});

test("sync replay: the same page offered twice is absorbed by the API's idempotency", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 8);
    await t.run("engine.sync", { engineUserId: "eu1" });
    const before = t.fake.imported.get("eu1")!.size;
    t.fake.checkpoints.delete("eu1"); // as if the checkpoint commit had been lost: everything is offered again
    const again = await t.run("engine.sync", { engineUserId: "eu1" });
    assert.equal(again.accepted, 0);
    assert.equal(t.fake.imported.get("eu1")!.size, before);
  } finally { await t.close(); }
});

test("a transient API failure while posting a batch is retried with the same idempotency key", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 4);
    t.fake.failBatchCall = { call: 1, status: 503 };
    const r = await t.run("engine.sync", { engineUserId: "eu1" });
    assert.equal(r.accepted, 4);
    assert.equal(t.fake.imported.get("eu1")!.size, 4);
    assert.equal(t.fake.failedBatchKeys.length, 1);
    assert.equal((t.fake.calls.batches[0] as { idempotencyKey: string }).idempotencyKey, t.fake.failedBatchKeys[0], "the retry carries the same key");
  } finally { await t.close(); }
});

test("a checkpoint from another engine identity restarts the walk and the new identity is reported", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 5);
    await t.run("engine.sync", { engineUserId: "eu1" });
    t.setIdentity("freshrss:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const r = await t.run("engine.sync", { engineUserId: "eu1" });
    assert.equal(r.identityChanged, true);
    assert.equal(r.entries, 5);
    assert.equal(t.fake.checkpoints.get("eu1")!.engineIdentity, "freshrss:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  } finally { await t.close(); }
});

test("sync without stored credentials is a permanent failure, not a retry loop", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.run("engine.sync", { engineUserId: "eu1" }), (e: unknown) => e instanceof JobFailure && !e.retryable);
  } finally { await t.close(); }
});

test("rejected engine credentials surface as a non-retryable engine error", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1"); // password differs from what the engine knows
    await assert.rejects(t.run("engine.sync", { engineUserId: "eu1" }), (e: unknown) => e instanceof EngineError && e.kind === "auth" && !e.retryable);
  } finally { await t.close(); }
});

test("subscribe returns the stream id and title; subscribing again finds the existing stream", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    const a = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "src1", feedUrl: "https://example.org/a.xml", title: "A" });
    assert.deepEqual(a, { streamId: "feed/1", title: "example.org", alreadySubscribed: false, empty: true });
    const b = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "src1", feedUrl: "https://example.org/a.xml", title: "A" });
    assert.deepEqual(b, { streamId: "feed/1", title: "example.org", alreadySubscribed: true, empty: true });
    assert.equal(t.engine.feeds.length, 1);
    await assert.rejects(t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s", feedUrl: "https://example.org/broken.xml", title: "x" }), (e: unknown) => e instanceof EngineError && e.kind === "rejected" && !e.retryable);
  } finally { await t.close(); }
});

test("subscribe says whether the feed the engine just fetched had anything in it; when the engine can't say, it says nothing", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    t.engine.addEntry({ id: 1_700_000_000n * 1_000_000n, feedId: 1, title: "t", content: "c", link: "https://example.org/t" });
    const full = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s1", feedUrl: "https://example.org/a.xml", title: "A" });
    assert.equal((full as { empty?: boolean }).empty, false, "the engine's stream for this feed has an item");
    const none = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s2", feedUrl: "https://example.org/b.xml", title: "B" });
    assert.equal((none as { empty?: boolean }).empty, true, "and for this one nothing");
  } finally { await t.close(); }
  // An engine that answers the subscription but not the question: the subscribe still succeeds, without a claim about the feed.
  const makeClient: HandlerDeps["makeClient"] = (args) => {
    const real = defaultMakeClient(3000)(args);
    return {
      login: () => real.login(), quickAdd: (u) => real.quickAdd(u), listSubscriptions: () => real.listSubscriptions(), unsubscribe: (s) => real.unsubscribe(s),
      renameSubscription: (s, t) => real.renameSubscription(s, t), markRead: (i, r) => real.markRead(i, r), streamContents: (o) => real.streamContents(o),
      feedHasItems: async () => { throw new Error("engine hiccup"); },
    };
  };
  const u = await setup({ makeClient });
  try {
    u.secrets.ensure("eu1");
    u.engine.users.set("eng_user", u.secrets.read("eu1")!);
    const r = await u.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s3", feedUrl: "https://example.org/c.xml", title: "C" });
    assert.deepEqual(r, { streamId: "feed/1", title: "example.org", alreadySubscribed: false });
  } finally { await u.close(); }
});

test("a site that limits requests at subscribe time fails the job as a rate limit, which the runner reports as retryable with its reason", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    const err = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s", feedUrl: "https://www.reddit.com/r/limited/.rss", title: "x" }).catch((e: unknown) => e);
    assert.ok(err instanceof EngineError && err.kind === "rate_limited" && err.retryable && err.reason === "rate_limited", "429 is a delay, not a verdict on the feed");
    assert.deepEqual(classify(err), { error: err.message, retryable: true, reason: "rate_limited" });
    const flaky = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s", feedUrl: "https://example.org/flaky.xml", title: "x" }).catch((e: unknown) => e);
    assert.equal(classify(flaky).reason, "unavailable");
    const missing = await t.run("engine.subscribe", { engineUserId: "eu1", sourceId: "s", feedUrl: "https://example.org/broken.xml", title: "x" }).catch((e: unknown) => e);
    assert.deepEqual([classify(missing).reason, classify(missing).retryable], ["not_found", false]);
  } finally { await t.close(); }
});

/** Engine users eu2.. with their own credentials, next to the harness's eu1, so several accounts can act at once. */
function addEngineUsers(t: Awaited<ReturnType<typeof setup>>, count: number): string[] {
  const baseUrl = t.fake.engineUsers.get("eu1")!.baseUrl;
  const ids = ["eu1"];
  for (let i = 2; i <= count; i++) {
    const id = `eu${i}`;
    t.fake.engineUsers.set(id, { id, username: `eng_user${i}`, baseUrl });
    ids.push(id);
  }
  for (const id of ids) t.engine.users.set(t.fake.engineUsers.get(id)!.username, t.secrets.ensure(id).apiPassword);
  return ids;
}

/** A client whose quick-adds are slowed down and recorded, to see whether two of them ever run at once. */
function watchedQuickAdds(delayMs = 60) {
  const log = { active: 0, peak: 0, urls: [] as string[] };
  const makeClient: HandlerDeps["makeClient"] = (args) => {
    const client = defaultMakeClient(3000)(args);
    return new Proxy(client, {
      get(target, key) {
        if (key === "quickAdd") {
          return async (url: string) => {
            log.active += 1;
            log.peak = Math.max(log.peak, log.active);
            log.urls.push(url);
            try {
              await new Promise((r) => setTimeout(r, delayMs));
              return await target.quickAdd(url);
            } finally {
              log.active -= 1;
            }
          };
        }
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  return { log, makeClient };
}

const subscribe = (t: Awaited<ReturnType<typeof setup>>, engineUserId: string, feedUrl: string) =>
  t.run("engine.subscribe", { engineUserId, sourceId: `src_${engineUserId}`, feedUrl, title: "x" }, `job_${engineUserId}_${Math.random()}`);

test("accounts following the same new feed at the same moment subscribe one after another, so the engine fetches it once", async () => {
  const { log, makeClient } = watchedQuickAdds();
  const t = await setup({ makeClient });
  try {
    const users = addEngineUsers(t, 3);
    // The same address three ways: as written, with a fragment, and with a trailing slash on the bare host.
    const done = await Promise.all([
      subscribe(t, users[0]!, "https://news.example.org/feed.xml"),
      subscribe(t, users[1]!, "https://news.example.org/feed.xml#top"),
      subscribe(t, users[2]!, "https://news.example.org/feed.xml"),
    ]);
    assert.equal(log.peak, 1, "never two quick-adds of one address in flight");
    assert.equal(log.urls.length, 3);
    assert.ok(done.every((d) => typeof d.streamId === "string"));

    // A different address does not wait for it.
    log.peak = 0;
    await Promise.all([subscribe(t, users[0]!, "https://a.example.org/feed.xml"), subscribe(t, users[1]!, "https://b.example.org/feed.xml")]);
    assert.equal(log.peak, 2, "the lock is per address");
  } finally { await t.close(); }
});

test("private feed addresses are not serialized: each belongs to one account and is never shared", async () => {
  const { log, makeClient } = watchedQuickAdds();
  const t = await setup({ makeClient });
  try {
    const users = addEngineUsers(t, 2);
    mkdirSync(path.join(t.dir, "source-urls"), { recursive: true });
    // Two accounts whose private links happen to be the same address.
    const refs = ["src_0000000000000000000000000a", "src_0000000000000000000000000b"];
    for (const ref of refs) writeFileSync(path.join(t.dir, "source-urls", ref), "https://private.example.org/u/abc/feed.xml\n");
    await Promise.all(users.map((u, i) => subscribe(t, u, `secret:source-urls/${refs[i]}`)));
    assert.equal(log.peak, 2);
  } finally { await t.close(); }
});

test("the address lock is released when a subscribe fails, and a failed subscribe does not block the next one", async () => {
  const { log, makeClient } = watchedQuickAdds(30);
  const t = await setup({ makeClient });
  try {
    const users = addEngineUsers(t, 3);
    const limited = "https://www.reddit.com/r/limited/.rss";
    const settled = await Promise.race([
      Promise.allSettled([subscribe(t, users[0]!, limited), subscribe(t, users[1]!, limited), subscribe(t, users[2]!, limited)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a subscribe is stuck behind a failed one")), 5000)),
    ]);
    assert.deepEqual(settled.map((r) => r.status), ["rejected", "rejected", "rejected"]);
    assert.ok(settled.every((r) => r.status === "rejected" && r.reason instanceof EngineError && r.reason.kind === "rate_limited"));
    assert.equal(log.peak, 1);
    // Later, the site lets it through (the fake engine accepts any other address): not blocked by the earlier failures.
    const ok = await subscribe(t, users[0]!, "https://www.reddit.com/r/fine/.rss");
    assert.equal(typeof ok.streamId, "string");
  } finally { await t.close(); }
});

test("unsubscribe is idempotent and never touches imported items; rename of an unknown stream is permanent", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 3);
    await t.run("engine.sync", { engineUserId: "eu1" });
    const imported = t.fake.imported.get("eu1")!.size;
    assert.deepEqual(await t.run("engine.unsubscribe", { engineUserId: "eu1", streamId: "feed/1" }), { streamId: "feed/1", removed: true });
    assert.deepEqual(await t.run("engine.unsubscribe", { engineUserId: "eu1", streamId: "feed/1" }), { streamId: "feed/1", removed: false });
    assert.equal(t.fake.imported.get("eu1")!.size, imported, "product records are untouched");
    await assert.rejects(t.run("engine.rename", { engineUserId: "eu1", streamId: "feed/99", title: "x" }), (e: unknown) => e instanceof JobFailure && !e.retryable);
  } finally { await t.close(); }
});

test("rename and mark_read call the engine", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 2);
    await t.run("engine.rename", { engineUserId: "eu1", streamId: "feed/1", title: "New name" });
    assert.equal(t.engine.feeds[0]!.title, "New name");
    const ids = t.engine.entries.map((e) => e.id.toString());
    assert.deepEqual(await t.run("engine.mark_read", { engineUserId: "eu1", externalIds: ids, read: true }), { count: 2, read: true });
    assert.ok(t.engine.entries.every((e) => e.read));
    await t.run("engine.mark_read", { engineUserId: "eu1", externalIds: [ids[0]!], read: false });
    assert.equal(t.engine.entries[0]!.read, false);
  } finally { await t.close(); }
});

test("capture: a successful result is the job result, a refusal is a permanent failure, and no capture function means no handler", async () => {
  const ok: CaptureFn = async (url) => ({ ok: true, title: "T", text: "body", html: "<p>body</p>", finalUrl: url, bytes: 4 });
  const t = await setup({ capture: ok });
  try {
    assert.deepEqual(await t.run("capture.fulltext", { captureId: "c1", url: "https://example.org/a" }), { ok: true, title: "T", text: "body", html: "<p>body</p>", finalUrl: "https://example.org/a", bytes: 4 });
  } finally { await t.close(); }
  const refuse: CaptureFn = async () => ({ ok: false, reason: "blocked_address", message: "That address is not allowed." });
  const t2 = await setup({ capture: refuse });
  try {
    await assert.rejects(t2.run("capture.fulltext", { captureId: "c1", url: "http://127.0.0.1/x" }), (e: unknown) => e instanceof JobFailure && !e.retryable && /blocked_address/.test(e.message));
  } finally { await t2.close(); }
  const t3 = await setup();
  try {
    assert.equal("capture.fulltext" in t3.handlers, false);
  } finally { await t3.close(); }
});

test("capture.images: the pictures fetched are the job result as base64, within the room the job names, and no function means no handler", async () => {
  const seen: { urls: string[]; maxBytes: number }[] = [];
  const pictures: PicturesFn = async (urls, opts) => { seen.push({ urls, maxBytes: opts.maxBytes }); return [{ url: urls[0]!, contentType: "image/png", data: Buffer.from([1, 2, 3]) }]; };
  const t = await setup({ pictures });
  try {
    assert.deepEqual(await t.run("capture.images", { itemId: "itm_1", urls: ["https://pictures.example/a.png", "https://pictures.example/b.png"], maxBytes: 1000 }),
      { images: [{ url: "https://pictures.example/a.png", contentType: "image/png", data: "AQID" }] });
    assert.deepEqual(seen, [{ urls: ["https://pictures.example/a.png", "https://pictures.example/b.png"], maxBytes: 1000 }]);
  } finally { await t.close(); }
  const none = await setup();
  try {
    assert.equal("capture.images" in none.handlers, false);
  } finally { await none.close(); }
});

test("two jobs for one engine user never talk to the engine at the same time", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    seed(t.engine, 3);
    t.engine.delayMs = 40;
    await Promise.all([t.run("engine.sync", { engineUserId: "eu1" }, "j1"), t.run("engine.mark_read", { engineUserId: "eu1", externalIds: ["1"], read: true }, "j2")]);
    assert.equal(t.engine.peakInFlight, 1);
    // a different engine user is independent
    t.fake.engineUsers.set("eu2", { id: "eu2", username: "eng_user", baseUrl: t.fake.engineUsers.get("eu1")!.baseUrl });
    t.secrets.ensure("eu2");
    t.engine.users.set("eng_user", t.secrets.read("eu1")!);
    writeFileSync(path.join(t.dir, "engine-users", "eu2"), `${t.secrets.read("eu1")}\n`);
    t.engine.peakInFlight = 0;
    await Promise.all([t.run("engine.mark_read", { engineUserId: "eu1", externalIds: ["1"], read: true }, "j3"), t.run("engine.mark_read", { engineUserId: "eu2", externalIds: ["1"], read: true }, "j4")]);
    assert.equal(t.engine.peakInFlight, 2);
  } finally { await t.close(); }
});

test("source.icon: a found icon goes back as base64, a miss is an answer, and lookups run one at a time", async () => {
  let running = 0, most = 0;
  const seen: unknown[] = [];
  const icon: IconFn = async (input) => {
    seen.push(input);
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return input.siteUrl ? { ok: true, icon: { data: Buffer.from("RIFFxxxxWEBP"), width: 128, from: "https://a.example/i.png" }, tried: 2 } : { ok: false, tried: 1, reasons: ["http 404"] };
  };
  const t = await setup({ icon });
  try {
    const [hit, miss] = await Promise.all([
      t.run("source.icon", { sourceId: "s1", kind: "feed", feedUrl: "https://a.example/feed", siteUrl: "https://a.example/" }, "job_a"),
      t.run("source.icon", { sourceId: "s2", kind: "private", feedUrl: null, siteUrl: null }, "job_b"),
    ]);
    assert.deepEqual(hit, { found: true, data: Buffer.from("RIFFxxxxWEBP").toString("base64"), width: 128, from: "https://a.example/i.png" });
    assert.deepEqual(miss, { found: false, reasons: ["http 404"] });
    assert.equal(most, 1, "never two lookups at once");
    assert.deepEqual(seen[1], { kind: "private", feedUrl: null, siteUrl: null });
  } finally { await t.close(); }
  const t2 = await setup();
  try {
    assert.equal("source.icon" in t2.handlers, false, "no icon function means the kind is not leased");
  } finally { await t2.close(); }
});

// ---------- engine.delete_user (account deletion, phase 2)

const deletion = { engineUserId: "eu1", username: "eng_user" };
const fresh = () => ({ engineAttemptedAt: null, engineRemovedAt: null, engineReviewAt: null, finalized: false });

test("delete_user records the attempt first, deletes and confirms the engine user, forgets its password and finalizes", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.fake.deletions.set("eu1", fresh());
    assert.equal(await t.run("engine.delete_user", deletion), SETTLED, "the finalize call settles the job; no completion is sent");
    assert.deepEqual(t.adminCalls.filter((c) => c.op === "deleteUser"), [{ op: "deleteUser", attemptRecorded: true }], "the attempt is on record before the engine is asked");
    assert.equal(t.engine.users.has("eng_user"), false);
    assert.deepEqual(t.fake.deletionCalls, ["eu1 state", "eu1 attempt", "eu1 removed", "eu1 finalize"]);
    assert.equal(t.fake.deletions.get("eu1")!.finalized, true);
    assert.equal(existsSync(path.join(t.dir, "engine-users", "eu1")), false, "the stored API password is gone");
    assert.equal(t.fake.calls.complete.length, 0);
  } finally {
    await t.close();
  }
});

test("delete_user: an engine user that never existed (no attempt on record) is simply done", async () => {
  const t = await setup();
  try {
    t.engine.users.delete("eng_user");
    t.fake.deletions.set("eu1", fresh());
    assert.equal(await t.run("engine.delete_user", deletion), SETTLED);
    assert.equal(t.adminCalls.some((c) => c.op === "deleteUser"), false, "nothing to delete");
    assert.deepEqual(t.fake.deletionCalls, ["eu1 state", "eu1 removed", "eu1 finalize"]);
    assert.equal(t.fake.deletions.get("eu1")!.finalized, true);
  } finally {
    await t.close();
  }
});

test("delete_user: a user missing after an unconfirmed attempt opens a review instead of finishing", async () => {
  const t = await setup();
  try {
    t.secrets.ensure("eu1");
    t.engine.users.delete("eng_user");
    t.fake.deletions.set("eu1", { ...fresh(), engineAttemptedAt: "2026-11-01T00:00:00.000Z" });
    assert.equal(await t.run("engine.delete_user", deletion), SETTLED, "the review call settles the job");
    assert.deepEqual(t.fake.deletionCalls, ["eu1 state", "eu1 review"]);
    const d = t.fake.deletions.get("eu1")!;
    assert.ok(d.engineReviewAt && !d.finalized && !d.engineRemovedAt);
    assert.equal(existsSync(path.join(t.dir, "engine-users", "eu1")), true, "nothing else is touched until an administrator confirms");
  } finally {
    await t.close();
  }
});

test("delete_user: once the removal is confirmed (by an earlier run or an administrator), a rerun only finalizes", async () => {
  const t = await setup();
  try {
    t.engine.users.delete("eng_user");
    t.fake.deletions.set("eu1", { ...fresh(), engineAttemptedAt: "2026-11-01T00:00:00.000Z", engineRemovedAt: "2026-11-01T00:00:05.000Z" });
    assert.equal(await t.run("engine.delete_user", deletion), SETTLED);
    assert.deepEqual(t.fake.deletionCalls, ["eu1 state", "eu1 finalize"]);
    assert.equal(t.adminCalls.some((c) => c.op === "deleteUser"), false);
  } finally {
    await t.close();
  }
});

test("delete_user: a lost answer to finalize is retried, and the repeat reports success", async () => {
  const t = await setup();
  try {
    t.fake.deletions.set("eu1", fresh());
    t.fake.loseFinalizeAnswer = true;
    assert.equal(await t.run("engine.delete_user", deletion), SETTLED);
    assert.deepEqual(t.fake.deletionCalls.filter((c) => c.endsWith("finalize")), ["eu1 finalize", "eu1 finalize"]);
    assert.equal(t.fake.deletions.get("eu1")!.finalized, true);
  } finally {
    await t.close();
  }
});

test("delete_user: an engine user still listed after deleting it fails retryably and finalizes nothing", async () => {
  const t = await setup({ deleteUser: async () => {} });
  try {
    t.fake.deletions.set("eu1", fresh());
    await assert.rejects(t.run("engine.delete_user", deletion), (e: unknown) => e instanceof JobFailure && e.retryable);
    const d = t.fake.deletions.get("eu1")!;
    assert.ok(d.engineAttemptedAt && !d.engineRemovedAt && !d.finalized);
  } finally {
    await t.close();
  }
});
