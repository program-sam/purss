import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { askJevEach, JevError, jevConfigFromEnv, jevKeyFingerprint } from "@purss/connectors";
import type { AiJudgeInput } from "@purss/domain";
import { SMART_FILTER_WEEKLY_TOKENS, usageWeek } from "@purss/domain";
import type { App } from "../app.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { internalServer } from "../server.ts";
import { internalRouter } from "../routes/internal.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { leaseJobs } from "./jobs.ts";
import { applySyncBatch } from "./sync.ts";
import { changeState, keepItem } from "./state.ts";
import { createBasket, createCollection, deleteCollection, listCollections } from "./collections.ts";
import { setPreferences } from "./preferences.ts";
import { listSources } from "./sources.ts";
import { collectionStats, sourceStats } from "./statistics.ts";

/*
 * Smart filters (plan/36) end to end: a sync queues judging, a worker step asks a stand-in Jev over HTTP through the internal routes
 * (the same calls the worker makes), and the answers change the posts' workflow and what is announced.
 */

/** A stand-in for Jev: a post is kept when its title has a word of the "keep" description of 5 letters or more. */
async function fakeJev(opts: { status?: number } = {}) {
  const seen: { auth: string | undefined; body: any }[] = [];
  let status = opts.status ?? 200;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ auth: req.headers.authorization, body });
      if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }).end("{}"); return; }
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const [key, q] of Object.entries<any>(body.questions)) {
        const words: string[] = (q.criteria.true.split(":").slice(1).join(":").toLowerCase().match(/[a-z]{5,}/g) ?? []);
        const title = String(body.state.title).toLowerCase();
        answers[key] = { type: "noul", noul: words.some((w) => title.includes(w)) ? 0.92 : 0.04 };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 150, output_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    setStatus: (s: number) => { status = s; },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

async function boot(env: Record<string, string> = {}) {
  const jev = await fakeJev();
  const { app, cleanup } = makeTestApp({ PURSS_JEV_URL: jev.url, ...env });
  const internal = internalServer(app, internalRouter(app));
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  const internalBase = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
  const pub = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const owner = makeOwner(app, { admin: false });
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, s: TestSession = session) => call(app, pub.base, method, path, s, body);
  const admin = makeOwner(app, { admin: true });
  const adminSession = signIn(app, admin.accountId);
  /** Smart filters run only on the server's key, which an administrator sets. */
  const setServerKey = async (key: string) => assert.equal((await api("PUT", "/api/admin/ai/key", { key }, adminSession)).status, 200);
  const close = async () => {
    await new Promise<void>((r) => { internal.close(() => r()); internal.closeAllConnections(); });
    await pub.close();
    await jev.close();
    cleanup();
  };
  return { app, owner, session, api, admin, adminSession, setServerKey, jev, internalBase, close };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const internalPost = (b: Booted, path: string, body: unknown) =>
  fetch(b.internalBase + path, { method: "POST", headers: { authorization: `Bearer ${b.app.serviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });

/** Run the waiting filter.judge jobs as the worker does: ask the API what to ask, ask Jev, report the answers. */
async function runJudging(b: Booted): Promise<number> {
  let ran = 0;
  for (;;) {
    const job = leaseJobs(b.app, ["filter.judge"], 1)[0];
    if (!job) return ran;
    ran++;
    const input = (await (await internalPost(b, `/internal/filters/${job.id}/input`, { leaseId: job.leaseId })).json()) as AiJudgeInput;
    const result = { route: input.route, model: null as string | null, keyRejected: false, keyFingerprint: null as string | null, unfinished: [] as string[], verdicts: [] as { itemId: string; answers: Record<string, number>; inputTokens: number }[] };
    if (input.route && input.requests.length) {
      const key = readFileSync(path.join(b.app.config.secretsDir, "jev-server-key"), "utf8").trim();
      const answers = await askJevEach({ ...jevConfigFromEnv({ PURSS_JEV_URL: b.jev.url }), model: input.model }, key, input.requests);
      answers.forEach((a, i) => {
        if (a instanceof JevError) {
          if (a.failure === "key_rejected") { result.keyRejected = true; result.keyFingerprint = jevKeyFingerprint(key); }
          else result.unfinished.push(input.requests[i]!.itemId);
        } else result.verdicts.push({ itemId: input.requests[i]!.itemId, answers: a.answers, inputTokens: a.inputTokens });
      });
    }
    const done = await internalPost(b, `/internal/jobs/${job.id}/complete`, { leaseId: job.leaseId, result });
    assert.equal(done.status, 200, await done.text());
  }
}

/** This week's Smart filter use of the test account, as the administrator's safeguard counts it. */
const usageRow = (b: Booted) => {
  const r = b.app.db.get<{ week: string; tokens: number }>("SELECT week, input_tokens AS tokens FROM ai_usage WHERE account_id = ?", b.owner.accountId);
  return r ? { week: r.week, tokens: r.tokens } : undefined;
};

const post = (app: App, workspaceId: string, title: string) => app.db.get<{ id: string; workflow: string; fresh: number; revision: number }>(
  "SELECT i.id, st.workflow, st.fresh, st.revision FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.workspace_id = ? AND i.title = ?", workspaceId, title)!;

const arrivals = (app: App, workspaceId: string) =>
  app.db.all<{ title: string }>("SELECT title FROM notifications WHERE workspace_id = ? AND kind = 'arrivals'", workspaceId).map((r) => r.title);

/** A post that arrives now, whose summary says nothing a filter would match. */
const neutral = (title: string, streamId: string) => entry(streamId, { title, summaryHtml: "<p>Nothing to see.</p>", crawledAt: new Date().toISOString(), publishedAt: new Date().toISOString() });

test("a source filter marks the posts it drops Ignored, keeps the rest, and announces only those", async (t) => {
  const b = await boot();
  t.after(b.close);
  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  b.app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", source);

  assert.equal((await b.api("GET", "/api/ai")).json.ready, false, "no server key, no filters");
  const noKey = await b.api("POST", `/api/sources/${source}/ai-filter/preview`, { keep: "sediment research" });
  assert.equal(noKey.status, 409);
  assert.equal(noKey.json.error.code, "ai_unavailable");
  assert.equal(noKey.json.error.message, "This server hasn't set up Smart filters yet. Ask your administrator.");

  await b.setServerKey("server-key-1234");
  const settings = (await b.api("GET", "/api/ai")).json;
  assert.equal(settings.ready, true);
  assert.equal(settings.pro, null, "self-hosted: no plans");

  const saved = await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment research", drop: "job ads" });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.filter.whenUnsure, "keep");
  assert.equal(await runJudging(b), 0, "no posts yet, nothing to re-check");

  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Sediment cores from the delta", "feed/1"), neutral("We're hiring a designer", "feed/1")]));
  assert.deepEqual(arrivals(b.app, b.owner.workspaceId), [], "nothing is announced before the filter has judged");
  assert.equal(await runJudging(b), 1);

  const kept = post(b.app, b.owner.workspaceId, "Sediment cores from the delta");
  const dropped = post(b.app, b.owner.workspaceId, "We're hiring a designer");
  assert.equal(kept.workflow, "new");
  assert.equal(kept.fresh, 1);
  assert.equal(dropped.workflow, "ignored");
  assert.equal(dropped.fresh, 0, "Ignored is no longer New, as when the person ignores it");
  assert.ok(b.app.db.get("SELECT 1 FROM state_log WHERE item_id = ? AND from_state = 'new' AND to_state = 'ignored'", dropped.id), "the change is in the workflow log");
  assert.ok(b.app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.mark_read'"), "and mirrored to the engine as read, like the person's own");
  assert.deepEqual(arrivals(b.app, b.owner.workspaceId), ["New from Delta Notes"], "only the kept post is announced");

  // What Jev was sent: the post's text and the person's words, with the server's key.
  const sent = b.jev.seen.at(-1)!;
  assert.equal(sent.auth, "Bearer server-key-1234");
  assert.equal(sent.body.model, "jev-latest", "the newest Jev unless the operator pins one");
  assert.deepEqual(Object.keys(sent.body.state).sort(), ["author", "source", "summary", "title"]);
  const q = Object.values<any>(sent.body.questions)[0];
  assert.equal(q.type, "noul");
  assert.match(q.criteria.true, /sediment research/);
  assert.match(q.criteria.false, /job ads/);

  assert.deepEqual(usageRow(b), { week: usageWeek(), tokens: 300 }, "two requests of 150 input tokens, counted for the administrator only");
  const filter = (await b.api("GET", `/api/sources/${source}/ai-filter`)).json.filter;
  assert.equal(filter.judgedCount, 2);
  assert.equal(filter.droppedCount, 1);
});

test("the person's change is their last word; a looser filter gives back only untouched posts", async (t) => {
  const b = await boot();
  t.after(b.close);
  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  await b.setServerKey("server-key-1234");
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment" });
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Sediment cores", "feed/1"), neutral("Hiring now", "feed/1"), neutral("Hiring again", "feed/1"), neutral("Opened before judging", "feed/1")]));
  // Opened before Jev answered: the person has seen it, so the filter leaves it.
  const opened = post(b.app, b.owner.workspaceId, "Opened before judging");
  changeState(b.app, b.owner, opened.id, { opened: true, expectedRevision: opened.revision });
  await runJudging(b);
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring now").workflow, "ignored");
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring again").workflow, "ignored");
  assert.equal(post(b.app, b.owner.workspaceId, "Opened before judging").workflow, "new");

  // The person takes one back.
  const back = post(b.app, b.owner.workspaceId, "Hiring now");
  changeState(b.app, b.owner, back.id, { workflow: "new", expectedRevision: back.revision });

  // Tighter words would drop it again; the person's word stands.
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment cores only" });
  await runJudging(b);
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring now").workflow, "new", "the person's own change is not undone");

  // Opening a dropped post (in Ignored) is a touch too, though it doesn't move the revision: it is not given back.
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Hiring, opened in Ignored", "feed/1")]));
  await runJudging(b);
  const seen = post(b.app, b.owner.workspaceId, "Hiring, opened in Ignored");
  assert.equal(seen.workflow, "ignored");
  changeState(b.app, b.owner, seen.id, { opened: true, expectedRevision: seen.revision });

  // Looser words keep hiring posts: the one the filter dropped and nobody touched comes back.
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment or hiring" });
  await runJudging(b);
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring again").workflow, "new", "given back");
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring now").workflow, "new");
  assert.ok(b.app.db.get("SELECT 1 FROM state_log WHERE item_id = ? AND from_state = 'ignored' AND to_state = 'new'", post(b.app, b.owner.workspaceId, "Hiring again").id));
  assert.equal(post(b.app, b.owner.workspaceId, "Hiring, opened in Ignored").workflow, "ignored", "opened while Ignored: the person's");
});

test("statistics count what a Smart filter filtered out, until the person changes it", async (t) => {
  const b = await boot();
  t.after(b.close);
  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  const col = createCollection(b.app, b.owner, { name: "Delta", emoji: null, mode: "sources", sourceIds: [source], query: null, view: "list" });
  await b.setServerKey("server-key-1234");
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment" });
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Sediment cores", "feed/1"), neutral("Hiring now", "feed/1"), neutral("Hiring again", "feed/1"), neutral("Hiring thrice", "feed/1")]));
  await runJudging(b);
  assert.equal(sourceStats(b.app, b.owner, source).stats.filteredOut, 3);

  // Finished by the person: no longer the filter's. Taken back and ignored by hand: Ignored, but not filtered out.
  const done = post(b.app, b.owner.workspaceId, "Hiring now");
  changeState(b.app, b.owner, done.id, { workflow: "finished", expectedRevision: done.revision });
  const manual = post(b.app, b.owner.workspaceId, "Hiring again");
  changeState(b.app, b.owner, manual.id, { workflow: "new", expectedRevision: manual.revision });
  changeState(b.app, b.owner, manual.id, { workflow: "ignored", expectedRevision: post(b.app, b.owner.workspaceId, "Hiring again").revision });

  const stats = sourceStats(b.app, b.owner, source).stats;
  assert.deepEqual([stats.workflow.ignored, stats.filteredOut], [2, 1]);
  assert.equal(collectionStats(b.app, b.owner, col.id).totals.filteredOut, 1);
});

test("a kept post is never dropped, a filter changed mid-flight waits for its own re-check, and turning off stops judging", async (t) => {
  const b = await boot();
  t.after(b.close);
  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  await b.setServerKey("server-key-1234");
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment" });
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Kept off-topic post", "feed/1"), neutral("Off-topic post", "feed/1")]));
  const keptPost = post(b.app, b.owner.workspaceId, "Kept off-topic post");
  keepItem(b.app, b.owner, keptPost.id, createBasket(b.app, b.owner, { name: "Later", captureMode: "metadata" }).id);

  // The words change after the job was queued: answers to the old words are not used.
  const job = leaseJobs(b.app, ["filter.judge"], 1)[0]!;
  const input = (await (await internalPost(b, `/internal/filters/${job.id}/input`, { leaseId: job.leaseId })).json()) as AiJudgeInput;
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment and tides" });
  const stale = { route: input.route, model: null, keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: input.requests.map((r) => ({ itemId: r.itemId, answers: Object.fromEntries(Object.keys(r.questions).map((k) => [k, 0.01])), inputTokens: 10 })) };
  assert.equal((await internalPost(b, `/internal/jobs/${job.id}/complete`, { leaseId: job.leaseId, result: stale })).status, 200);
  assert.equal(post(b.app, b.owner.workspaceId, "Off-topic post").workflow, "new", "an answer to the old words changes nothing");
  await runJudging(b); // the re-check the change queued
  assert.equal(post(b.app, b.owner.workspaceId, "Off-topic post").workflow, "ignored");
  assert.equal(post(b.app, b.owner.workspaceId, "Kept off-topic post").workflow, "new", "a kept post stays");

  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment and tides", enabled: false });
  assert.equal(listSources(b.app, b.owner)[0]!.aiFiltered, false, "a filter that is off isn't marked");
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Another off-topic post", "feed/1")]));
  assert.equal(await runJudging(b), 0, "a filter that is off judges nothing");
  assert.equal(post(b.app, b.owner.workspaceId, "Another off-topic post").workflow, "new");
});

test("a collection's filter covers its sources and goes with the collection; previews change nothing", async (t) => {
  const b = await boot();
  t.after(b.close);
  const one = makeSource(b.app, b.owner, "One", "feed/1");
  const two = makeSource(b.app, b.owner, "Two", "feed/2");
  const other = makeSource(b.app, b.owner, "Elsewhere", "feed/3");
  const col = createCollection(b.app, b.owner, { name: "Science", emoji: null, mode: "sources", sourceIds: [one, two], query: null, view: "list" });
  await b.setServerKey("server-key-1234");
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Sediment one", "feed/1"), neutral("Gossip two", "feed/2"), neutral("Gossip elsewhere", "feed/3")]));

  const preview = await b.api("POST", `/api/collections/${col.id}/ai-filter/preview`, { keep: "sediment", whenUnsure: "drop" });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.posts.map((p: any) => [p.title, p.dropped]).sort(), [["Gossip two", true], ["Sediment one", false]]);
  assert.equal(post(b.app, b.owner.workspaceId, "Gossip two").workflow, "new", "a preview changes no post");
  assert.equal(usageRow(b)?.tokens, 300, "but its tokens count");

  await b.api("PUT", `/api/collections/${col.id}/ai-filter`, { keep: "sediment" });
  await runJudging(b); // the re-check of the collection's recent Undecided posts
  assert.equal(post(b.app, b.owner.workspaceId, "Gossip two").workflow, "ignored");
  assert.equal(post(b.app, b.owner.workspaceId, "Gossip elsewhere").workflow, "new", "a source outside the collection is not filtered");
  // The sidebar marks the collection whose filter is on, not each of its sources; a source's own filter marks the source.
  await b.api("PUT", `/api/sources/${two}/ai-filter`, { keep: "tides" });
  const marked = Object.fromEntries(listSources(b.app, b.owner).map((x) => [x.title, x.aiFiltered]));
  assert.deepEqual(marked, { One: false, Two: true, Elsewhere: false });
  assert.equal(listCollections(b.app, b.owner).find((c) => c.id === col.id)!.aiFiltered, true);
  await b.api("PUT", `/api/collections/${col.id}/ai-filter`, { keep: "sediment", enabled: false });
  assert.equal(listCollections(b.app, b.owner).find((c) => c.id === col.id)!.aiFiltered, false, "a collection filter that is off isn't marked");
  await b.api("PUT", `/api/collections/${col.id}/ai-filter`, { keep: "sediment" });

  // Someone else's source or collection is not found.
  const stranger = makeOwner(b.app, { admin: false });
  const theirs = makeSource(b.app, stranger, "Theirs", "feed/9");
  assert.equal((await b.api("PUT", `/api/sources/${theirs}/ai-filter`, { keep: "sediment" })).status, 404);
  assert.equal((await b.api("POST", `/api/sources/${theirs}/ai-filter/preview`, { keep: "sediment" })).status, 404);

  const query = createCollection(b.app, b.owner, { name: "Saved search", emoji: null, mode: "query", sourceIds: [], query: { field: "text", value: "sediment" }, view: "list" });
  assert.equal((await b.api("PUT", `/api/collections/${query.id}/ai-filter`, { keep: "sediment" })).status, 400, "a query collection has no sources to filter");

  deleteCollection(b.app, b.owner, col.id);
  assert.equal(b.app.db.get("SELECT 1 FROM ai_filters WHERE collection_id = ?", col.id), undefined);
  assert.equal(b.app.db.get("SELECT 1 FROM ai_filter_verdicts WHERE workspace_id = ?", b.owner.workspaceId), undefined);
  assert.equal(post(b.app, b.owner.workspaceId, "Gossip two").workflow, "ignored", "what it did stays; the person changes it back in Ignored");
});

test("a key Jev refuses: posts stay as they are and are announced, the key is marked, and a new key clears it", async (t) => {
  const b = await boot();
  t.after(b.close);
  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  b.app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", source);
  await b.setServerKey("server-key-1234");
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment" });
  b.jev.setStatus(401);
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Off-topic post", "feed/1")]));
  await runJudging(b);
  assert.equal(post(b.app, b.owner.workspaceId, "Off-topic post").workflow, "new");
  assert.deepEqual(arrivals(b.app, b.owner.workspaceId), ["New from Delta Notes"], "announced as if there were no filter");
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false);
  assert.deepEqual((await b.api("GET", "/api/admin/ai", undefined, b.adminSession)).json.key, { hint: "1234", rejected: true });
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Second post", "feed/1")]));
  assert.equal(leaseJobs(b.app, ["filter.judge"], 1).length, 0, "with no usable key nothing is queued");
  await b.setServerKey("server-key-5678");
  assert.equal((await b.api("GET", "/api/ai")).json.ready, true);

  // A late refusal of the old key doesn't disable its replacement.
  const late = { route: "server", model: null, keyRejected: true, keyFingerprint: jevKeyFingerprint("server-key-1234"), unfinished: [], verdicts: [] };
  b.app.db.run("INSERT INTO jobs (id, account_id, workspace_id, kind, payload, status, lease_id, lease_expires_at, run_after, max_attempts, created_at, updated_at) VALUES ('job_late', ?, ?, 'filter.judge', ?, 'leased', 'lse_late', ?, ?, 4, ?, ?)",
    b.owner.accountId, b.owner.workspaceId, JSON.stringify({ itemIds: [post(b.app, b.owner.workspaceId, "Second post").id], announce: false }), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  assert.equal((await internalPost(b, "/internal/jobs/job_late/complete", { leaseId: "lse_late", result: late })).status, 200);
  assert.deepEqual((await b.api("GET", "/api/admin/ai", undefined, b.adminSession)).json.key, { hint: "5678", rejected: false });
});

test("people cannot hand the server a Jev key of their own", async (t) => {
  const b = await boot();
  t.after(b.close);
  assert.equal((await b.api("PUT", "/api/ai/key", { key: "personal-key-1234" })).status, 404);
  assert.equal((await b.api("DELETE", "/api/ai/key")).status, 404);
  assert.equal((await b.api("PUT", "/api/admin/ai/key", { key: "personal-key-1234" })).status, 403, "only an administrator sets the server's key");
  assert.equal((await b.api("GET", "/api/admin/ai", undefined, b.adminSession)).json.key, null);
  assert.deepEqual(Object.keys((await b.api("GET", "/api/ai")).json).sort(), ["allowanceUsedUp", "keySource", "pro", "ready", "serverKey"], "no key, and no amounts or tokens");
});

test("hosted: Pro uses the server key an administrator set, until the week's allowance is used", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const { adminSession } = b;
  const s0 = (await b.api("GET", "/api/ai")).json;
  assert.equal(s0.ready, false);
  assert.deepEqual(s0.pro, { included: false });

  // Only an administrator sets the server key, and it is never shown back whole.
  assert.equal((await b.api("PUT", "/api/admin/ai/key", { key: "server-key-9999" })).status, 403);
  const set = await b.api("PUT", "/api/admin/ai/key", { key: "server-key-9999" }, adminSession);
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json, { key: { hint: "9999", rejected: false }, mode: "hosted", keySource: new URL(b.jev.url).host });
  assert.ok(!JSON.stringify((await b.api("GET", "/api/admin/ai", undefined, adminSession)).json).includes("server-key"));
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'ai.server_key_set'"));
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false, "Free: a server key alone isn't enough");
  await b.api("PATCH", `/api/admin/accounts/${b.owner.accountId}`, { plan: "plus" }, adminSession);
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false, "nor is Plus");

  const patched = await b.api("PATCH", `/api/admin/accounts/${b.owner.accountId}`, { plan: "pro" }, adminSession);
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.smartFilterTokens, 0);
  assert.deepEqual({ ...patched.json.capacity.sources, used: 0 }, { used: 0, limit: 5000 }, "Pro follows up to 5,000 sources");
  assert.equal(patched.json.capacity.collections.limit, null, "and has unlimited collections");
  assert.deepEqual((await b.api("GET", "/api/ai")).json.pro, { included: true });

  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Off-topic post", "feed/1")]));
  const preview = await b.api("POST", `/api/sources/${source}/ai-filter/preview`, { keep: "sediment" });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(b.jev.seen.at(-1)!.auth, "Bearer server-key-9999");
  assert.equal(usageRow(b)?.tokens, 150);

  b.app.db.run("UPDATE ai_usage SET input_tokens = ? WHERE account_id = ?", SMART_FILTER_WEEKLY_TOKENS, b.owner.accountId);
  const capped = (await b.api("GET", "/api/ai")).json;
  assert.equal(capped.allowanceUsedUp, true);
  assert.equal(capped.ready, false, "the allowance is used up: filters wait");
  const waiting = await b.api("POST", `/api/sources/${source}/ai-filter/preview`, { keep: "sediment" });
  assert.equal(waiting.json.error.message, "You've used this week's Smart filter allowance. Contact your administrator to change your limits.");
  assert.doesNotMatch(JSON.stringify(capped) + waiting.text, /token/i, "people never see tokens");
  // A new week starts afresh: last week's use doesn't count.
  b.app.db.run("UPDATE ai_usage SET week = ? WHERE account_id = ?", usageWeek(new Date(Date.now() - 7 * 86_400_000)), b.owner.accountId);
  assert.equal((await b.api("GET", "/api/ai")).json.ready, true, "the next week, filters run again");

  // Moving back to Plus: filters stop; nothing they did is undone.
  b.app.db.run("DELETE FROM ai_usage");
  await b.api("PATCH", `/api/admin/accounts/${b.owner.accountId}`, { plan: "plus" }, adminSession);
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false);
});

test("self-hosted: a server key an administrator sets serves every account, with no plan or allowance; a refused key stops", async (t) => {
  const b = await boot();
  t.after(b.close);
  const { adminSession } = b;
  assert.equal((await b.api("PATCH", `/api/admin/accounts/${b.owner.accountId}`, { plan: "pro" }, adminSession)).status, 400, "no plans to set");
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false);
  await b.api("PUT", "/api/admin/ai/key", { key: "server-key-9999" }, adminSession);
  const s = (await b.api("GET", "/api/ai")).json;
  assert.equal(s.ready, true, "every account may use it");
  assert.equal(s.serverKey, true);
  assert.equal(s.pro, null);

  const source = makeSource(b.app, b.owner, "Delta Notes", "feed/1");
  await b.api("PUT", `/api/sources/${source}/ai-filter`, { keep: "sediment" });
  applySyncBatch(b.app, b.owner.engineUserId, batch([neutral("Off-topic post", "feed/1")]));
  b.jev.setStatus(401);
  await runJudging(b);
  assert.equal(post(b.app, b.owner.workspaceId, "Off-topic post").workflow, "new", "fails open");
  assert.deepEqual((await b.api("GET", "/api/admin/ai", undefined, adminSession)).json.key, { hint: "9999", rejected: true });
  assert.equal((await b.api("GET", "/api/ai")).json.ready, false, "a refused key isn't used");
  await b.api("PUT", "/api/admin/ai/key", { key: "server-key-0000" }, adminSession);
  assert.equal((await b.api("GET", "/api/ai")).json.ready, true, "a new key clears it");
  assert.equal((await b.api("DELETE", "/api/admin/ai/key", undefined, adminSession)).json.key, null);
});
