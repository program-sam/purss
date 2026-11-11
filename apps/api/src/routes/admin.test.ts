import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeOwner, makeTestApp, testPassword } from "../testing.ts";
import type { Principal } from "../app.ts";
import { call, seedLibrary, shareRow, signIn, startTestServer } from "../features-testing.ts";
import type { Reply, TestSession } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { acceptInvite } from "../auth/accounts.ts";
import { enqueue } from "../services/jobs.ts";
import { usedBytes } from "../services/storage.ts";
import { updateAccount } from "../services/admin.ts";
import { HttpError } from "../http.ts";
import { publicRouter } from "./public.ts";
import { checkMail, useTransport } from "../mail/mailer.ts";

type Owner = Principal & { engineUserId: string };

async function boot(env: Record<string, string> = {}) {
  const { app, cleanup } = makeTestApp(env);
  const admin = makeOwner(app, { admin: true });
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return {
    app, admin, server,
    as: (s: TestSession | null) => ({
      get: (path: string) => call(app, server.base, "GET", path, s),
      post: (path: string, body?: unknown) => call(app, server.base, "POST", path, s, body ?? {}),
      patch: (path: string, body?: unknown) => call(app, server.base, "PATCH", path, s, body ?? {}),
    }),
    close: async () => { await server.close(); cleanup(); },
  };
}

const ADMIN_ROUTES: [string, string][] = [
  ["GET", "/api/admin/health"], ["GET", "/api/admin/jobs"], ["GET", "/api/admin/audit"], ["POST", "/api/admin/usage/reconcile"], ["GET", "/api/admin/accounts"],
  ["POST", "/api/admin/invites"], ["POST", "/api/admin/jobs/job_x/retry"], ["POST", "/api/admin/jobs/job_x/cancel"], ["PATCH", "/api/admin/accounts/acc_x"],
  ["GET", "/api/admin/news"], ["POST", "/api/admin/news"], ["PUT", "/api/admin/news/nws_x"], ["DELETE", "/api/admin/news/nws_x"],
];

test("admin routes refuse signed-out visitors and ordinary accounts on the server", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const ordinary = makeOwner(b.app, { admin: false });
  const user = signIn(b.app, ordinary.accountId);
  for (const [method, path] of ADMIN_ROUTES) {
    const out = await call(b.app, b.server.base, method, path, null, method === "GET" ? undefined : {});
    assert.equal(out.status, 401, `${method} ${path} signed out`);
    const plain = await call(b.app, b.server.base, method, path, user, method === "GET" ? undefined : {});
    assert.equal(plain.status, 403, `${method} ${path} as an ordinary account`);
    assert.equal(plain.json.error.code, "forbidden");
  }
});

test("sensitive admin actions need a recent strong sign-in; reads and job controls do not", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const stale = signIn(b.app, b.admin.accountId, { authAgeSeconds: 3600 });
  const fresh = signIn(b.app, b.admin.accountId);
  const other = makeOwner(b.app, { admin: false });

  for (const [method, path, body] of [["POST", "/api/admin/invites", {}], ["PATCH", `/api/admin/accounts/${other.accountId}`, { allocationBytes: 5 }]] as const) {
    const denied = await call(b.app, b.server.base, method, path, stale, body);
    assert.equal(denied.status, 403, `${path} with a stale sign-in`);
    assert.equal(denied.json.error.code, "step_up");
  }
  assert.equal((await b.as(stale).get("/api/admin/health")).status, 200, "reads don't need step-up");
  assert.equal((await b.as(stale).get("/api/admin/accounts")).status, 200);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invites")!.n, 0, "nothing was issued");
  assert.equal(b.app.db.get<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", other.accountId)!.allocation_bytes, null);

  const invite = await b.as(fresh).post("/api/admin/invites", { note: "for Alex", allocationBytes: 123_456, days: 7 });
  assert.equal(invite.status, 200);
  assert.match(invite.json.code, /^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM invites")).includes(invite.json.code), false, "only a hash of the code is stored");
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM audit_events")).includes(invite.json.code), false, "and it is not logged");
  const joined = acceptInvite(b.app, invite.json.code, "Alex", testPassword());
  assert.equal(b.app.db.get<{ allocation_bytes: number }>("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", joined.accountId)!.allocation_bytes, 123_456);
  assert.equal(b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", joined.accountId), undefined, "an invitation never grants administration");
});

test("self-hosted: admins manage accounts and invite family members, without storage allowances", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.admin.accountId);
  assert.equal((await b.as(s).get("/api/admin/accounts")).status, 200);
  const invite = await b.as(s).post("/api/admin/invites", { note: "For Sam's sister" });
  assert.equal(invite.status, 200);
  assert.ok(invite.json.code);
  const listed = await b.as(s).get("/api/admin/invites");
  assert.equal(listed.json[0].status, "pending");
  assert.ok(!JSON.stringify(listed.json).includes(invite.json.code), "codes are never listed");
  // Storage allowances are a hosted feature.
  const alloc = await b.as(s).post("/api/admin/invites", { allocationBytes: 1000 });
  assert.equal(alloc.status, 400);
  assert.equal(alloc.json.error.code, "not_available");
  // The invitation creates an ordinary account with no limit; it can be made an administrator and back.
  const { acceptInvite } = await import("../auth/accounts.ts");
  const fam = acceptInvite(b.app, invite.json.code, "Sister", testPassword());
  assert.equal(b.app.db.get<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", fam.accountId)!.allocation_bytes, null);
  assert.equal((await b.as(s).patch(`/api/admin/accounts/${fam.accountId}`, { isAdmin: true })).json.isAdmin, true);
  assert.equal((await b.as(s).patch(`/api/admin/accounts/${fam.accountId}`, { isAdmin: false })).json.isAdmin, false);
  const self = await b.as(s).patch(`/api/admin/accounts/${b.admin.accountId}`, { isAdmin: false });
  assert.equal(self.status, 409, "can't demote yourself");
  // No open signup on a self-hosted installation.
  const signup = await b.as(null).post("/api/signup", { displayName: "Stranger", username: "stranger", password: "a long enough password" });
  assert.equal(signup.status, 403);
});

test("hosted with open signup: anyone can create an ordinary account, rate-limited and capped", async (t) => {
  // Open sign-up needs working outgoing email (plan/27); a stand-in mail server accepts everything.
  const b = await boot({ PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_SIGNUP_DAILY_LIMIT: "1", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" });
  t.after(b.close);
  useTransport(b.app, { send: async () => {}, verify: async () => {} });
  await checkMail(b.app);
  const first = await b.as(null).post("/api/signup", { displayName: "Ana", email: "ana@example.org", username: "ana-ana", password: "a long enough password" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true }, "no recovery codes");
  const acct = b.app.db.get<{ id: string }>("SELECT id FROM accounts WHERE display_name = 'Ana'")!;
  assert.ok(!b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", acct.id), "never an admin");
  assert.equal(b.app.db.get<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", acct.id)!.allocation_bytes, null, "no storage limit");
  const second = await b.as(null).post("/api/signup", { displayName: "Ben", email: "ben@example.org", username: "ben-ben", password: "a long enough password" });
  assert.equal(second.status, 429, "daily cap");
});

test("hosted accounts: minimal metadata, allocation changes, suspension, and the last administrator is protected", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const s = signIn(b.app, b.admin.accountId);
  const pa = makeOwner(b.app, { admin: false, allocationBytes: 10_000_000 });
  b.app.db.run("UPDATE accounts SET display_name = 'Pat' WHERE id = ?", pa.accountId);
  const lib = seedLibrary(b.app, pa);
  shareRow(b.app, pa, "basket", lib.baskets.reading);
  const patSession = signIn(b.app, pa.accountId);

  const list = await b.as(s).get("/api/admin/accounts");
  assert.equal(list.status, 200);
  const pat = list.json.find((a: any) => a.id === pa.accountId);
  assert.deepEqual(Object.keys(pat).sort(), ["allocationBytes", "capacity", "createdAt", "deletion", "displayName", "id", "isAdmin", "plan", "smartFilterTokens", "status", "usedBytes"]);
  assert.equal(pat.usedBytes, usedBytes(b.app, pa.accountId));
  assert.equal(pat.smartFilterTokens, 0, "Smart filters: only the tokens used, nothing about filters or posts");
  assert.ok(!JSON.stringify(list.json).includes("Tidal"), "no content in the account list");

  // Lowering the allocation below usage keeps the data and pauses new growth.
  const lowered = await b.as(s).patch(`/api/admin/accounts/${pa.accountId}`, { allocationBytes: 1000 });
  assert.equal(lowered.status, 200);
  assert.equal(b.app.db.get("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", pa.accountId)!.paused_reason, "quota");
  assert.ok(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE account_id = ?", pa.accountId)!.n > 0, "nothing deleted");
  const raised = await b.as(s).patch(`/api/admin/accounts/${pa.accountId}`, { allocationBytes: 50_000_000 });
  assert.equal(raised.json.allocationBytes, 50_000_000);
  assert.equal(b.app.db.get("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", pa.accountId)!.paused_reason, null, "more room lifts the pause");

  // Suspension signs the account out everywhere and stops its public pages.
  assert.equal((await b.as(patSession).get("/api/bootstrap")).status, 200);
  const suspended = await b.as(s).patch(`/api/admin/accounts/${pa.accountId}`, { status: "suspended" });
  assert.equal(suspended.json.status, "suspended");
  assert.equal((await b.as(patSession).get("/api/bootstrap")).status, 401);
  assert.equal(b.app.db.get("SELECT status FROM shares")!.status, "paused");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", pa.accountId)!.n, 0);
  assert.equal((await b.as(s).patch(`/api/admin/accounts/${pa.accountId}`, { status: "active" })).json.status, "active");

  // Audited, with who/what but no content.
  const audit = b.app.db.all<{ action: string; actor_account_id: string; target: string; outcome: string; detail: string }>("SELECT * FROM audit_events WHERE action = 'admin_account_update' ORDER BY at");
  assert.ok(audit.length >= 4 && audit.every((e) => e.actor_account_id === b.admin.accountId && e.target === pa.accountId && e.outcome === "success"));
  assert.ok(audit.some((e) => /allocation 10000000 -> 1000/.test(e.detail)));

  // Nobody can suspend themselves, and the last active administrator is protected even from a caller that isn't that account.
  const own = await b.as(s).patch(`/api/admin/accounts/${b.admin.accountId}`, { status: "suspended" });
  assert.equal(own.status, 409);
  assert.match(own.json.error.message, /own account/);
  assert.throws(() => updateAccount(b.app, { ...b.admin, accountId: "acc_someone_else" }, b.admin.accountId, { status: "suspended" }), (e: unknown) => e instanceof HttpError && e.status === 409 && /last active administrator/.test(e.message));
  assert.equal(b.app.db.get("SELECT status FROM accounts WHERE id = ?", b.admin.accountId)!.status, "active");
  // With two administrators one may suspend the other, and the survivor is then protected.
  const second = makeOwner(b.app, { admin: true });
  const secondSession = signIn(b.app, second.accountId);
  assert.equal((await b.as(secondSession).patch(`/api/admin/accounts/${b.admin.accountId}`, { status: "suspended" })).status, 200);
  assert.throws(() => updateAccount(b.app, { ...b.admin, accountId: "acc_someone_else" }, second.accountId, { status: "suspended" }), (e: unknown) => e instanceof HttpError && /last active administrator/.test(e.message));
  assert.ok(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin_account_update' AND outcome = 'failure'")!.n >= 3, "refusals are audited too");
});

test("health is an aggregate: engine, jobs, disk, database, sources and a tolerant egress check", async (t) => {
  let seenAuth = "";
  const egress = createServer((req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    if (seenAuth !== "Bearer test-token") { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ blockedLastHour: 4 }));
  });
  await new Promise<void>((r) => egress.listen(0, "127.0.0.1", r));
  t.after(() => { egress.close(); egress.closeAllConnections(); });
  const b = await boot({ PURSS_EGRESS_CONTROL_URL: `http://127.0.0.1:${(egress.address() as AddressInfo).port}/` });
  t.after(b.close);
  const p = b.admin as Owner;
  const s = signIn(b.app, p.accountId);
  seedLibrary(b.app, p);
  enqueue(b.app, "engine.sync", { engineUserId: p.engineUserId }, { accountId: p.accountId, idempotencyKey: "k1", runAfter: new Date(Date.now() - 90_000).toISOString() });
  b.app.db.run("UPDATE sources SET health = 'error' WHERE title = 'Secret Garden'");
  b.app.db.run("UPDATE sources SET paused = 1 WHERE title = 'Sediment Letters'");

  const out = await b.as(s).get("/api/admin/health");
  assert.equal(out.status, 200);
  const h = out.json;
  assert.equal(seenAuth, "Bearer test-token", "the egress check carries the service token");
  assert.deepEqual(h.egress, { status: "ok", blockedLastHour: 4 });
  assert.equal(h.bridge, null, "no bridge is configured, and the egress log isn't asked for");
  assert.deepEqual(h.discoveryMisses, []);
  assert.equal(h.jobs.queued >= 1, true);
  assert.ok(h.jobs.oldestQueuedSeconds >= 89);
  assert.deepEqual(h.sources, { total: 2, failing: 1, paused: 1 });
  assert.deepEqual(h.accounts, { total: 1 });
  assert.equal(h.engine.status, "ok");
  assert.ok(typeof h.disk.freeBytes === "number" && h.disk.reserveBytes === 0 && h.disk.growthPaused === false);
  assert.ok(h.database.bytes > 0);
  for (const content of ["Tidal", "Private note", "Sediment", "Secret Garden", "example.org"]) assert.ok(!out.text.includes(content), `health must not include ${content}`);

  b.app.db.run("UPDATE sync_checkpoints SET last_success_at = '2026-11-01T00:00:00.000Z', last_attempt_at = '2026-11-02T00:00:00.000Z', last_error = 'boom' WHERE engine_user_id = ?", p.engineUserId);
  const degraded = (await b.as(s).get("/api/admin/health")).json.engine;
  assert.equal(degraded.status, "unavailable");
  assert.equal(degraded.lastSyncAt, "2026-11-01T00:00:00.000Z");
  assert.ok(degraded.lagSeconds > 0);
  assert.match(degraded.message, /syncing/);
});

test("health still answers when the egress service is unreachable or refuses", async (t) => {
  const b = await boot({ PURSS_EGRESS_CONTROL_URL: "http://127.0.0.1:1/" });
  t.after(b.close);
  const out = await b.as(signIn(b.app, b.admin.accountId)).get("/api/admin/health");
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.egress, { status: "unavailable", blockedLastHour: null });
  const refusing = createServer((_req, res) => { res.writeHead(500).end(); });
  await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", r));
  t.after(() => { refusing.close(); refusing.closeAllConnections(); });
  b.app.config.egressControlUrl = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
  assert.equal((await b.as(signIn(b.app, b.admin.accountId)).get("/api/admin/health")).json.egress.status, "unavailable");
});

/** A stand-in for the egress control listener; `routes` maps a request's path and query to an answer. */
async function fakeEgress(t: { after: (fn: () => void) => void }, routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const seen: { url: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
    const handler = routes[req.url ?? ""];
    if (handler) handler(res); else res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const json = (body: unknown) => (res: import("node:http").ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)); };

const SUMMARY = {
  days: 7,
  services: [
    { service: "bandcamp", attempts: 1000, ok: 990, empty: 9, failed: 1, cachedAnswers: 40 },
    { service: "telegram", attempts: 10, ok: 7, empty: 1, failed: 2, cachedAnswers: 5 },
    { service: "retired", attempts: 3, ok: 0, empty: 0, failed: 3, cachedAnswers: 0 },
    { service: "soundcloud", attempts: 3, ok: 2, empty: 0, failed: 1, cachedAnswers: 0 },
    { service: "fine", attempts: 400, ok: 400, empty: 0, failed: 0, cachedAnswers: 12 },
  ],
  failing: [
    { service: "telegram", key: "durov", outcome: "http_503", phase: "backend", failingSince: "2026-11-06T10:00:00.000Z", lastOkAt: "2026-11-06T09:00:00.000Z", attempts: 6 },
    { service: "bandcamp", key: "nilsfrahm", outcome: "no_ids", phase: "identity", failingSince: "2026-11-07T10:00:00.000Z", lastOkAt: null, attempts: 2 },
    { service: "telegram", key: "<b>x</b>", outcome: "Weird Outcome!", phase: "somewhere", failingSince: "2026-11-07T11:00:00.000Z", lastOkAt: "not a date", attempts: -4 },
    { service: "retired", key: "gone", outcome: "timeout", phase: "parse", failingSince: "2026-11-07T12:00:00.000Z", lastOkAt: null, attempts: 3 },
    { service: "telegram", key: "no-time", outcome: "timeout", phase: "backend", failingSince: "yesterday", lastOkAt: null, attempts: 1 },
    { service: "telegram", outcome: "timeout", failingSince: "2026-11-07T12:00:00.000Z" },
    "not a row", null,
  ],
};

test("health shows the bridge's last week from the egress log: every catalogued service, success rates, and the keys failing now", async (t) => {
  const egress = await fakeEgress(t, { "/status": json({ blockedLastHour: 2 }), "/bridge/summary?days=7": json(SUMMARY) });
  const b = await boot({ PURSS_EGRESS_CONTROL_URL: `${egress.url}/status`, PURSS_BRIDGE_URL: "http://172.31.88.10:8945" });
  t.after(b.close);
  const out = await b.as(signIn(b.app, b.admin.accountId)).get("/api/admin/health");
  assert.equal(out.status, 200);
  assert.deepEqual(egress.seen.map((r) => r.url).sort(), ["/bridge/summary?days=7", "/status"]);
  assert.ok(egress.seen.every((r) => r.auth === "Bearer test-token"), "both requests carry the service token");
  assert.deepEqual(out.json.egress, { status: "ok", blockedLastHour: 2 });
  assert.deepEqual(out.json.bridge, {
    status: "ok",
    days: 7,
    services: [
      { id: "telegram", name: "Telegram", attempts: 10, ok: 7, empty: 1, failed: 2, cachedAnswers: 5, successPercent: 80 },
      { id: "bandcamp", name: "Bandcamp", attempts: 1000, ok: 990, empty: 9, failed: 1, cachedAnswers: 40, successPercent: 99 },
      { id: "soundcloud", name: "SoundCloud", attempts: 3, ok: 2, empty: 0, failed: 1, cachedAnswers: 0, successPercent: 67 },
      { id: "twitch", name: "Twitch", attempts: 0, ok: 0, empty: 0, failed: 0, cachedAnswers: 0, successPercent: null },
      ...[["mixcloud", "Mixcloud"], ["rutube", "Rutube"], ["applemusic", "Apple Music"]].map(([id, name]) => ({ id, name, attempts: 0, ok: 0, empty: 0, failed: 0, cachedAnswers: 0, successPercent: null })),
      { id: "fine", name: "fine", attempts: 400, ok: 400, empty: 0, failed: 0, cachedAnswers: 12, successPercent: 100 },
      { id: "retired", name: "retired", attempts: 3, ok: 0, empty: 0, failed: 3, cachedAnswers: 0, successPercent: 0 },
    ],
    failing: [
      { service: "telegram", serviceName: "Telegram", key: "durov", pageUrl: "https://t.me/durov", outcome: "http_503", failingSince: "2026-11-06T10:00:00.000Z", lastOkAt: "2026-11-06T09:00:00.000Z", attempts: 6 },
      { service: "bandcamp", serviceName: "Bandcamp", key: "nilsfrahm", pageUrl: "https://nilsfrahm.bandcamp.com/", outcome: "no_ids", failingSince: "2026-11-07T10:00:00.000Z", lastOkAt: null, attempts: 2 },
      { service: "telegram", serviceName: "Telegram", key: "<b>x</b>", pageUrl: null, outcome: "unknown", failingSince: "2026-11-07T11:00:00.000Z", lastOkAt: null, attempts: 0 },
      { service: "retired", serviceName: "retired", key: "gone", pageUrl: null, outcome: "timeout", failingSince: "2026-11-07T12:00:00.000Z", lastOkAt: null, attempts: 3 },
    ],
  }, "rows that aren't shaped as expected are left out, and a page address is given only for a key the service's handles allow");
});

test("health marks the bridge unavailable, and still answers, when the egress service can't give its log", async (t) => {
  const redirectedTo = await fakeEgress(t, {});
  const slow = await fakeEgress(t, { "/status": json({ blockedLastHour: 0 }), "/bridge/summary?days=7": () => { /* never answers */ } });
  const cases: [string, Record<string, (res: import("node:http").ServerResponse) => void>][] = [
    ["the egress runs no bridge (404)", { "/status": json({ blockedLastHour: 1 }) }],
    ["an error", { "/status": json({ blockedLastHour: 1 }), "/bridge/summary?days=7": (res) => { res.writeHead(500).end(); } }],
    ["an answer that isn't JSON", { "/status": json({ blockedLastHour: 1 }), "/bridge/summary?days=7": (res) => { res.writeHead(200, { "content-type": "text/plain" }).end("hello"); } }],
    ["an answer that isn't an object", { "/status": json({ blockedLastHour: 1 }), "/bridge/summary?days=7": json([1, 2]) }],
    ["a redirect, which is never followed", { "/status": json({ blockedLastHour: 1 }), "/bridge/summary?days=7": (res) => { res.writeHead(302, { location: `${redirectedTo.url}/elsewhere` }).end(); } }],
  ];
  const b = await boot({ PURSS_BRIDGE_URL: "http://172.31.88.10:8945" });
  t.after(b.close);
  const health = async () => (await b.as(signIn(b.app, b.admin.accountId)).get("/api/admin/health"));
  for (const [what, routes] of cases) {
    const egress = await fakeEgress(t, routes);
    b.app.config.egressControlUrl = `${egress.url}/status`;
    const out = await health();
    assert.equal(out.status, 200, what);
    assert.deepEqual(out.json.bridge, { status: "unavailable", days: 7, services: [], failing: [] }, what);
    assert.equal(out.json.egress.status, "ok", `${what}: the egress check is separate`);
  }
  assert.deepEqual(redirectedTo.seen, [], "the service token never went to the redirect's address");

  // Nothing listening, and an egress that never answers: both give up after the same short wait, together.
  for (const url of ["http://127.0.0.1:1/status", `${slow.url}/status`]) {
    b.app.config.egressControlUrl = url;
    const started = Date.now();
    const out = await health();
    assert.equal(out.status, 200);
    assert.equal(out.json.bridge.status, "unavailable", url);
    assert.ok(Date.now() - started < 4000, "the two checks run together, each with a short timeout");
  }
});

test("health lists the sites people most often tried to follow without success, summed over the last 30 days", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.admin.accountId);
  const today = new Date();
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const add = (day: string, site: string, reason: string, count: number) => b.app.db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES (?, ?, ?, ?)", day, site, reason, count);
  const misses = async () => (await b.as(s).get("/api/admin/health")).json.discoveryMisses as { site: string; reason: string; count: number }[];
  assert.deepEqual(await misses(), []);

  add(daysAgo(0), "tiktok.com", "unsupported", 4); add(daysAgo(3), "tiktok.com", "unsupported", 5); add(daysAgo(29), "tiktok.com", "unsupported", 1);
  add(daysAgo(30), "tiktok.com", "unsupported", 50); // older than the window
  add(daysAgo(2), "tiktok.com", "timeout", 1);
  add(daysAgo(1), "bandcamp.com", "nofeed", 7);
  assert.deepEqual(await misses(), [
    { site: "tiktok.com", reason: "unsupported", count: 10 },
    { site: "bandcamp.com", reason: "nofeed", count: 7 },
    { site: "tiktok.com", reason: "timeout", count: 1 },
  ], "one line per site and reason, summed over the window, most first");

  for (let i = 0; i < 25; i++) add(daysAgo(1), `small${String(i).padStart(2, "0")}.example`, "unreachable", 2);
  const top = await misses();
  assert.equal(top.length, 20, "at most twenty");
  assert.deepEqual(top.slice(0, 4).map((m) => `${m.site} ${m.reason} ${m.count}`), ["tiktok.com unsupported 10", "bandcamp.com nofeed 7", "small00.example unreachable 2", "small01.example unreachable 2"]);
  assert.deepEqual(Object.keys(top[0]!).sort(), ["count", "reason", "site"], "no account, no path");

  // Only administrators see it (the route is administrator-only; see the admin routes test).
  const ordinary = makeOwner(b.app, { admin: false });
  assert.equal((await b.as(signIn(b.app, ordinary.accountId)).get("/api/admin/health")).status, 403);
});

test("jobs: failures are listed with redacted errors, and retry/cancel are audited and state-checked", async (t) => {
  const b = await boot();
  t.after(b.close);
  const p = b.admin as Owner;
  const s = signIn(b.app, p.accountId);
  const failed = enqueue(b.app, "engine.sync", { engineUserId: p.engineUserId }, { accountId: p.accountId, idempotencyKey: "f1" });
  const queued = enqueue(b.app, "engine.sync", { engineUserId: p.engineUserId }, { accountId: p.accountId, idempotencyKey: "q1" });
  const done = enqueue(b.app, "engine.sync", { engineUserId: p.engineUserId }, { accountId: p.accountId, idempotencyKey: "d1" });
  b.app.db.run("UPDATE jobs SET status = 'failed', attempts = 3, last_error = ? WHERE id = ?",
    `fetch https://feeds.example/u/abc?token=SECRETVALUE failed for me@example.com with ${"A".repeat(40)}`, failed);
  b.app.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", done);

  const list = await b.as(s).get("/api/admin/jobs");
  assert.equal(list.json[0].id, failed, "failures first");
  assert.equal(list.json[0].attempts, 3);
  assert.equal(list.json[0].account, p.accountId);
  for (const leak of ["SECRETVALUE", "me@example.com", "A".repeat(40), "payload", p.engineUserId, "feeds.example/u/abc"]) assert.ok(!list.text.includes(leak), `must not expose ${leak}`);
  assert.match(list.json[0].lastError, /https:\/\/feeds\.example\/…/);
  assert.equal((await b.as(s).get("/api/admin/jobs?status=failed")).json.length, 1);
  assert.equal((await b.as(s).get("/api/admin/jobs?status=bogus")).status, 400);

  assert.equal((await b.as(s).post(`/api/admin/jobs/${failed}/retry`)).status, 200);
  assert.equal(b.app.db.get("SELECT status FROM jobs WHERE id = ?", failed)!.status, "queued");
  assert.equal((await b.as(s).post(`/api/admin/jobs/${failed}/retry`)).status, 409, "only failed or cancelled jobs");
  assert.equal((await b.as(s).post(`/api/admin/jobs/${done}/cancel`)).status, 409);
  assert.equal((await b.as(s).post(`/api/admin/jobs/${queued}/cancel`)).status, 200);
  assert.equal(b.app.db.get("SELECT status FROM jobs WHERE id = ?", queued)!.status, "cancelled");
  assert.equal((await b.as(s).post("/api/admin/jobs/job_nope/retry")).status, 404);

  const events = (await b.as(s).get("/api/admin/audit")).json.events as any[];
  const actions = events.map((e) => `${e.action}:${e.outcome}`);
  assert.ok(actions.includes("admin_job_retry:success") && actions.includes("admin_job_retry:failure") && actions.includes("admin_job_cancel:success"), actions.join(","));
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].at >= e.at), "newest first");
  const page = await b.as(s).get("/api/admin/audit?limit=2");
  assert.equal(page.json.events.length, 2);
  assert.ok(page.json.nextBefore);
  const next = await b.as(s).get(`/api/admin/audit?limit=2&before=${encodeURIComponent(page.json.nextBefore)}`);
  assert.ok(next.json.events.every((e: any) => e.at < page.json.nextBefore));
});

test("usage reconciliation reports differences per account, changes no object, and puts a drifted total right", async (t) => {
  const b = await boot();
  t.after(b.close);
  const p = b.admin as Owner;
  const s = signIn(b.app, p.accountId);
  seedLibrary(b.app, p);
  const clean = (await b.as(s).post("/api/admin/usage/reconcile")).json;
  assert.equal(clean.mismatched, 0);
  assert.equal(clean.accounts[0].differenceBytes, 0);
  b.app.db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_orphan', ?, ?, 'record', 'orphan', 777, 'x')", p.accountId, p.workspaceId);
  const bad = (await b.as(s).post("/api/admin/usage/reconcile")).json;
  assert.equal(bad.mismatched, 1);
  assert.equal(bad.accounts[0].differenceBytes, -777);
  assert.equal(bad.accounts[0].trackedDifferenceBytes, -777, "the used-bytes total was 777 short of the objects");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE id = 'obj_orphan'")!.n, 1, "reported, not repaired");
  assert.equal((await b.as(s).post("/api/admin/usage/reconcile")).json.accounts[0].trackedDifferenceBytes, 0, "the total was put right by the check");
  assert.equal(b.app.db.get("SELECT outcome FROM audit_events WHERE action = 'usage_reconcile' ORDER BY at DESC, id DESC LIMIT 1")!.outcome, "failure");
});

test("feature routes sit behind the same sign-in, origin and CSRF checks as the core API", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.admin.accountId);
  const call2 = (method: string, path: string, session: TestSession | null, headers: Record<string, string> = {}, body: unknown = {}): Promise<Reply> => call(b.app, b.server.base, method, path, session, body, { headers });
  assert.equal((await call(b.app, b.server.base, "GET", "/api/shares", null)).status, 401);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/reminders", null)).status, 401);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/export", null)).status, 401);
  assert.equal((await call(b.app, b.server.base, "POST", "/api/reconcile/accept-suggested", { cookie: s.cookie, csrf: "wrong" }, {})).status, 403, "wrong CSRF token");
  assert.equal((await call2("POST", "/api/reconcile/accept-suggested", s, { origin: "https://evil.example" }, {})).status, 403, "foreign origin");
  assert.equal((await call(b.app, b.server.base, "POST", "/api/reconcile/accept-suggested", s, {})).status, 200, "a valid request reaches the handler");
});


test("news: drafts need only the role; publishing, editing or deleting what everyone sees needs step-up; the page and feed are public", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const stale = signIn(b.app, b.admin.accountId, { authAgeSeconds: 3600 });
  const fresh = signIn(b.app, b.admin.accountId);
  const draft = await b.as(stale).post("/api/admin/news", { title: "Soon", body: "Coming." });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.json.status, "draft");
  const put = (s: TestSession, id: string, body: unknown) => call(b.app, b.server.base, "PUT", `/api/admin/news/${id}`, s, body);
  assert.equal((await put(stale, draft.json.id, { title: "Soon!", body: "Coming." })).status, 200, "editing a draft");
  const denied = await put(stale, draft.json.id, { title: "Soon!", body: "Coming.", publish: true });
  assert.equal(denied.json.error.code, "step_up", "publishing needs a recent sign-in");
  assert.equal((await b.as(stale).post("/api/admin/news", { title: "Now", body: "Here.", publish: true })).json.error.code, "step_up");

  const published = await put(fresh, draft.json.id, { title: "Hello <all>", body: "It's **here**.", publish: true });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.stats.delivered, 1, "the administrator's own PURSS got it");
  assert.equal((await put(stale, draft.json.id, { title: "Edited", body: "x" })).json.error.code, "step_up", "editing a published post");
  assert.equal((await call(b.app, b.server.base, "DELETE", `/api/admin/news/${draft.json.id}`, stale)).json.error.code, "step_up");

  const feed = await call(b.app, b.server.base, "GET", "/news/feed.atom", null);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type")!, /application\/atom\+xml/);
  assert.ok(feed.text.includes("<title>Hello &lt;all&gt;</title>"));
  assert.ok(feed.text.includes("&lt;strong&gt;here&lt;/strong&gt;"));
  const page = await call(b.app, b.server.base, "GET", `/news/${draft.json.id}`, null);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Hello &lt;all&gt;"));
  assert.equal((await call(b.app, b.server.base, "GET", "/news", null)).status, 200);
  assert.equal((await call(b.app, b.server.base, "GET", "/news/nws_unknown", null)).status, 404);

  const gone = await call(b.app, b.server.base, "DELETE", `/api/admin/news/${draft.json.id}`, fresh);
  assert.deepEqual(gone.json, { removedCopies: 1, keptCopies: 0 });
  assert.equal((await call(b.app, b.server.base, "GET", `/news/${draft.json.id}`, null)).status, 404);
});
