import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeOwner, makeTestApp } from "../testing.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { eventStream } from "../main.ts";
import { publicServer } from "../server.ts";
import { addSeconds, nowIso, HttpError } from "../http.ts";
import {
  credentialWrite, issueRecoveryCodes, recentAuthAvailable, recoveryGeneration, refreshAuth, sessionInfo,
  renewSessionCookie, resolvePrincipal, setupPermissionAvailable, startSession,
} from "./accounts.ts";
import { removeMethod } from "./passkeys.ts";
import { setPassword } from "./passwords.ts";
import { randomToken, sha256 } from "../secrets.ts";

function fakeResponse() {
  const headers = new Map<string, string | string[]>();
  const response = {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => { headers.set(name, value); },
  } as unknown as ServerResponse;
  return { response, headers };
}

function insertSignupSession(app: ReturnType<typeof makeTestApp>["app"], accountId: string, opts: { createdAt?: string; authAgeSeconds?: number; setupExpiresAt?: string; lastSeenAt?: string; expiresAt?: string } = {}) {
  const token = randomToken(32);
  const id = sha256(token);
  const createdAt = opts.createdAt ?? nowIso();
  // Like startSession: a fresh sign-up session's auth_at equals its created_at (no real authentication yet).
  const authAt = opts.authAgeSeconds ? addSeconds(-opts.authAgeSeconds) : createdAt;
  const expiresAt = opts.expiresAt ?? addSeconds(30 * 86400);
  const setupExpiresAt = opts.setupExpiresAt ?? addSeconds(30 * 60);
  app.db.run(
    "INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, session_class, setup_permission_expires_at) VALUES (?, ?, 'csrf', ?, ?, ?, ?, 'signup', 'persistent', ?)",
    id, accountId, createdAt, expiresAt, opts.lastSeenAt ?? nowIso(), authAt, setupExpiresAt,
  );
  return { id, token };
}


/** Hosted open sign-up needs working outgoing email (plan/27): a mail server that answers and sends nowhere. */
async function hostedSignup(env: Record<string, string>) {
  const made = makeTestApp({ PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>", ...env });
  useTransport(made.app, { send: async () => {}, verify: async () => {} });
  await checkMail(made.app);
  return { app: made.app, cleanup: async () => { await settleMail(made.app); made.cleanup(); } };
}

test("two concurrent first-method enrollments consume one setup permission atomically", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const session = insertSignupSession(app, owner.accountId);

  const results = await Promise.allSettled([
    setPassword(app, owner.accountId, session.id, "firstowner", "a first long secret"),
    setPassword(app, owner.accountId, session.id, "secondowner", "a second long secret"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const denied = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(denied.reason instanceof HttpError);
  assert.equal(denied.reason.code, "step_up");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId)!.n, 1);
  assert.equal(app.db.get<{ durable_method_exists: number }>("SELECT durable_method_exists FROM account_enrollment WHERE account_id = ?", owner.accountId)!.durable_method_exists, 1);
  assert.equal(setupPermissionAvailable(app, owner.accountId, session.id), false);
  const setupUsedAt = app.db.get<{ setup_permission_used_at: string }>("SELECT setup_permission_used_at FROM sessions WHERE id = ?", session.id)!.setup_permission_used_at;
  assert.ok(Date.parse(setupUsedAt) > Date.parse(app.db.get<{ auth_at: string }>("SELECT auth_at FROM sessions WHERE id = ?", session.id)!.auth_at));

  // An explicit ordinary step-up after the consumed permission allows a later credential change.
  refreshAuth(app, session.id);
  await setPassword(app, owner.accountId, session.id, "laterowner", "a later long secret");
});

test("activity renews the ordinary session without extending the 30-minute setup deadline", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const created = addSeconds(-31 * 60);
  const setupDeadline = addSeconds(30 * 60, Date.parse(created));
  const session = insertSignupSession(app, owner.accountId, {
    createdAt: created,
    authAgeSeconds: 3600,
    setupExpiresAt: setupDeadline,
    lastSeenAt: addSeconds(-61),
    expiresAt: addSeconds(3600),
  });
  const before = app.db.get<{ expires_at: string; setup_permission_expires_at: string }>("SELECT expires_at, setup_permission_expires_at FROM sessions WHERE id = ?", session.id)!;
  assert.ok(resolvePrincipal(app, session.token));
  const after = app.db.get<{ expires_at: string; setup_permission_expires_at: string }>("SELECT expires_at, setup_permission_expires_at FROM sessions WHERE id = ?", session.id)!;
  assert.notEqual(after.expires_at, before.expires_at, "ordinary activity renewed the session");
  assert.equal(after.setup_permission_expires_at, before.setup_permission_expires_at, "the setup deadline is unchanged");
  assert.ok(Date.parse(after.setup_permission_expires_at) < Date.now());
  assert.equal(recentAuthAvailable(app, owner.accountId, session.id), false, "activity cannot make an expired first-method permission look recently confirmed");
  assert.throws(() => credentialWrite(app, owner.accountId, session.id, () => app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_late', ?, 'password', 'lateuser', 'hash', ?)", owner.accountId, nowIso())),
    (e: unknown) => e instanceof HttpError && e.code === "step_up");
});

test("removing the first durable method never restores the sign-up permission", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const session = insertSignupSession(app, owner.accountId);
  await setPassword(app, owner.accountId, session.id, "firstmethod", "a long first password");
  issueRecoveryCodes(app, owner.accountId); // leaves another usable way in so removal is allowed
  const id = app.db.get<{ id: string }>("SELECT id FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId)!.id;
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", nowIso(), session.id);
  removeMethod(app, owner.accountId, session.id, id);
  assert.equal(setupPermissionAvailable(app, owner.accountId, session.id), false);
  assert.equal(app.db.get<{ durable_method_exists: number }>("SELECT durable_method_exists FROM account_enrollment WHERE account_id = ?", owner.accountId)!.durable_method_exists, 1);
  assert.equal(sessionInfo({ app, principal: resolvePrincipal(app, session.token) }).account?.needsSetup, true, "the banner returns while no durable method currently exists");
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", addSeconds(-3600), session.id);
  assert.throws(() => credentialWrite(app, owner.accountId, session.id, () => undefined),
    (e: unknown) => e instanceof HttpError && e.code === "step_up");
});

test("the acknowledgment endpoint stores the current generation and rejects a superseded batch", async (t) => {
  const { app, cleanup } = makeTestApp();
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); await cleanup(); });
  const owner = makeOwner(app, { admin: false });
  issueRecoveryCodes(app, owner.accountId);
  const first = recoveryGeneration(app, owner.accountId);
  const session = signIn(app, owner.accountId);
  const ack = await call(app, server.base, "POST", "/api/account/recovery-codes/acknowledge", session, { generation: first });
  assert.equal(ack.status, 200, ack.text);
  assert.equal(app.db.get<{ recovery_acknowledged_generation: number }>("SELECT recovery_acknowledged_generation FROM account_enrollment WHERE account_id = ?", owner.accountId)!.recovery_acknowledged_generation, first);
  issueRecoveryCodes(app, owner.accountId);
  assert.equal(recoveryGeneration(app, owner.accountId), first + 1);
  const staleAck = await call(app, server.base, "POST", "/api/account/recovery-codes/acknowledge", session, { generation: first });
  assert.equal(staleAck.status, 409);
  assert.equal(staleAck.json.error.code, "recovery_codes_superseded");
});

test("a signup enrollment revoked while password hashing is in flight cannot commit", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const session = insertSignupSession(app, owner.accountId);
  const pending = setPassword(app, owner.accountId, session.id, "revokeduser", "a password hashing secret");
  // setPassword has started async scrypt and has not reached its credential-write transaction.
  app.db.run("DELETE FROM sessions WHERE id = ?", session.id);
  await assert.rejects(pending, (e: unknown) => e instanceof HttpError && e.code === "signed_out");
  assert.equal(app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId), undefined);
});

test("shared-computer cookies stay browser-session cookies and expire after eight hours for every sign-in class", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  for (const method of ["signup", "setup", "invite", "passkey", "password", "recovery", "oidc"]) {
    const started = fakeResponse();
    startSession(app, started.response, { headers: { "user-agent": "Firefox/123 Linux" } } as IncomingMessage, owner.accountId, method, { sharedComputer: true, setupPermission: method === "signup" });
    const header = String((started.headers.get("set-cookie") as string[])[0]);
    assert.doesNotMatch(header, /Max-Age/i, `${method} cookie remains browser-session scoped`);
    const token = decodeURIComponent(/purss_session=([^;]+)/.exec(header)![1]!);
    const id = sha256(token);
    const row = app.db.get<{ created_at: string; expires_at: string; session_class: string }>("SELECT created_at, expires_at, session_class FROM sessions WHERE id = ?", id)!;
    assert.equal(row.session_class, "shared", method);
    assert.equal(setupPermissionAvailable(app, owner.accountId, id), method === "signup", `${method} setup permission is sign-up only`);
    assert.ok(Math.abs(Date.parse(row.expires_at) - Date.parse(row.created_at) - 8 * 60 * 60_000) < 1000, `${method} has an absolute eight-hour deadline`);

    app.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", addSeconds(-61), id);
    const originalExpiry = row.expires_at;
    assert.ok(resolvePrincipal(app, token));
    assert.equal(app.db.get<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE id = ?", id)!.expires_at, originalExpiry, `${method} activity does not renew expiry`);
    const renewed = fakeResponse();
    renewSessionCookie(app, renewed.response, token);
    assert.doesNotMatch(String(renewed.headers.get("set-cookie")), /Max-Age/i, `${method} cookie cannot be upgraded by renewal`);

    app.db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", addSeconds(-1), id);
    assert.equal(resolvePrincipal(app, token), null, `${method} stops resolving after expiry`);
  }
});

test("signing out everywhere else closes the other session's event stream", async (t) => {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { admin: false });
  const current = signIn(app, owner.accountId);
  const other = signIn(app, owner.accountId);
  const server = publicServer(app, [publicRouter()], { events: eventStream });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const stream = await fetch(`${base}/api/events`, { headers: { cookie: other.cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  await reader.read(); // connected comment
  const result = await call(app, base, "POST", "/api/account/sessions/sign-out-others", current);
  assert.equal(result.status, 200, result.text);
  const ended = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("event stream stayed open after revocation")), 1500); timer.unref(); }),
  ]);
  assert.equal(ended.done, true);
  assert.equal(app.db.get("SELECT 1 FROM sessions WHERE id = ?", sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(other.cookie)![1]!))), undefined);
});

test("a shared session's event stream closes at its absolute expiry", async (t) => {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { admin: false });
  const started = fakeResponse();
  startSession(app, started.response, { headers: { "user-agent": "Firefox/123 Linux" } } as IncomingMessage, owner.accountId, "password", { sharedComputer: true });
  const cookie = String((started.headers.get("set-cookie") as string[])[0]).split(";")[0]!;
  const token = decodeURIComponent(/purss_session=([^;]+)/.exec(cookie)![1]!);
  app.db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", addSeconds(0.8), sha256(token));
  const server = publicServer(app, [publicRouter()], { events: eventStream });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const stream = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  await reader.read(); // connected comment
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("event stream stayed open past session expiry")), 2000); }),
  ]);
  if (timeout) clearTimeout(timeout);
  assert.equal(ended.done, true);
});

test("Retry-After is the latest release among the attempt and installation signup caps", async (t) => {
  const { app, cleanup } = await hostedSignup({ PURSS_TRUST_PROXY: "1", PURSS_SIGNUP_DAILY_LIMIT: "1" });
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); await cleanup(); });
  const address = `203.0.113.${randomToken(16)}`;
  const seedAt = new Date(Date.now() - 22.5 * 60 * 60_000).toISOString();
  const expectedRelease = Date.parse(seedAt) + 24 * 60 * 60_000;
  app.db.run("INSERT INTO audit_events (id, at, actor_account_id, action, target, outcome, detail) VALUES ('aud_signup_limit', ?, NULL, 'signup', NULL, 'success', NULL)", seedAt);
  const addressHash = sha256(`${app.serviceToken}\0signup-address\0${address}`);
  const oldestAddressSignup = new Date(Date.now() - 15 * 60_000).toISOString();
  for (let i = 0; i < 10; i++) {
    const accountId = `acc_signup_limit_${i}`;
    app.db.run("INSERT INTO accounts (id, created_at) VALUES (?, ?)", accountId, oldestAddressSignup);
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", accountId, addressHash, new Date(Date.parse(oldestAddressSignup) + i * 1000).toISOString());
  }

  let response;
  for (let i = 0; i < 31; i++) {
    response = await call(app, server.base, "POST", "/api/signup", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": address } });
  }
  assert.equal(response!.status, 429);
  assert.equal(response!.json.error.code, "signup_rate_limited");
  const retryAfter = Number(response!.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  assert.ok(Math.abs(Date.now() + retryAfter * 1000 - expectedRelease) < 1100, "Retry-After points at the latest blocking release, rounded up to seconds");
});

test("the 30th allowed signup attempt reports the latest release when account capacity also blocks", async (t) => {
  const { app, cleanup } = await hostedSignup({ PURSS_TRUST_PROXY: "1" });
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); await cleanup(); });
  const address = `203.0.113.${randomToken(16)}`;
  const firstAttemptAt = Date.now();
  for (let i = 0; i < 29; i++) {
    const invalid = await call(app, server.base, "POST", "/api/signup", null, { displayName: "x".repeat(61) }, { headers: { "x-forwarded-for": address } });
    assert.equal(invalid.status, 400, `attempt ${i + 1} was charged before input validation`);
  }

  const capacityTime = nowIso();
  const addressHash = sha256(`${app.serviceToken}\0signup-address\0${address}`);
  for (let i = 0; i < 10; i++) {
    const accountId = `acc_signup_edge_${i}`;
    app.db.run("INSERT INTO accounts (id, created_at) VALUES (?, ?)", accountId, capacityTime);
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", accountId, addressHash, capacityTime);
  }

  const response = await call(app, server.base, "POST", "/api/signup", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": address } });
  assert.equal(response.status, 429);
  assert.equal(response.json.error.code, "signup_full");
  const retryAfter = Number(response.headers.get("retry-after"));
  const capacityRelease = Date.parse(capacityTime) + 60 * 60_000;
  assert.ok(capacityRelease > firstAttemptAt + 60 * 60_000, "capacity remains blocked longer than the attempt window");
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  assert.ok(Math.abs(Date.now() + retryAfter * 1000 - capacityRelease) < 1100, "Retry-After matches the latest blocking release, rounded up to seconds");
});

test("a zero installation signup cap fails closed without a misleading retry time", async (t) => {
  const { app, cleanup } = await hostedSignup({ PURSS_TRUST_PROXY: "1", PURSS_SIGNUP_DAILY_LIMIT: "0" });
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); await cleanup(); });
  const address = `203.0.113.${randomToken(16)}`;
  const options = { headers: { "x-forwarded-for": address } };
  const first = await call(app, server.base, "POST", "/api/signup", null, { email: "new@example.org" }, options);
  assert.equal(first.status, 429);
  assert.equal(first.json.error.code, "signup_full");
  assert.equal(first.headers.get("retry-after"), null, "an operator pause has no automatic release time");

  let last = first;
  for (let i = 1; i < 31; i++) last = await call(app, server.base, "POST", "/api/signup", null, { email: "new@example.org" }, options);
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, "signup_rate_limited");
  assert.equal(last.headers.get("retry-after"), null, "the attempt window cannot override the installation-wide pause");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 0);
});

test("a blocked daily signup cap fails closed when its release time is unavailable", async (t) => {
  const { app, cleanup } = await hostedSignup({ PURSS_TRUST_PROXY: "1", PURSS_SIGNUP_DAILY_LIMIT: "1" });
  const db = app.db as unknown as { get: (sql: string, ...params: unknown[]) => unknown };
  const originalGet = db.get.bind(db);
  db.get = (sql, ...params) => {
    if (sql.includes("COUNT(*) AS n FROM audit_events")) return { n: 1 };
    if (sql.includes("SELECT at FROM audit_events")) return undefined;
    return originalGet(sql, ...params);
  };
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); db.get = originalGet; await cleanup(); });
  const response = await call(app, server.base, "POST", "/api/signup", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": `203.0.113.${randomToken(16)}` } });
  assert.equal(response.status, 429);
  assert.equal(response.json.error.code, "signup_full");
  assert.equal(response.headers.get("retry-after"), null, "an unknown release time must not be guessed");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 0);
});

test("the losing first-method request can't succeed by simply retrying", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  app.db.run("UPDATE account_enrollment SET durable_method_exists = 0 WHERE account_id = ?", owner.accountId);
  app.db.run("DELETE FROM sign_in_methods WHERE account_id = ? AND kind IN ('passkey', 'password', 'oidc')", owner.accountId);
  const session = insertSignupSession(app, owner.accountId);
  const add = (label: string) => credentialWrite(app, owner.accountId, session.id, () =>
    app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES (?, ?, 'password', ?, 'hash', ?)", `sim_${label}`, owner.accountId, label, nowIso()));
  add("winner");
  const isStepUp = (e: unknown) => e instanceof HttpError && e.code === "step_up";
  assert.throws(() => add("loser"), isStepUp, "the setup permission is spent");
  assert.throws(() => add("loser-retry"), isStepUp, "retrying without confirming again still needs a step-up");
  assert.equal(recentAuthAvailable(app, owner.accountId, session.id), false, "the sign-up moment never counts as a confirmation");
  assert.deepEqual(app.db.all<{ label: string }>("SELECT label FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId).map((r) => r.label), ["winner"]);
});

test("a step-up during the setup window counts at once, for linking and for a second method", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const session = insertSignupSession(app, owner.accountId, { createdAt: addSeconds(-60) });
  assert.equal(recentAuthAvailable(app, owner.accountId, session.id), false, "before any confirmation");
  const before = resolvePrincipal(app, session.token)!;
  assert.ok(Date.now() - Date.parse(before.authAt) > 3_600_000, "the principal carries no real authentication yet");
  refreshAuth(app, session.id); // what a recovery-code, password or passkey step-up does
  assert.equal(recentAuthAvailable(app, owner.accountId, session.id), true, "the confirmation shows even while the setup deadline is in the future");
  const after = resolvePrincipal(app, session.token)!;
  assert.ok(Date.now() - Date.parse(after.authAt) < 5_000, "routes that require recent authentication (such as linking a provider) now pass");
  credentialWrite(app, owner.accountId, session.id, () =>
    app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_second', ?, 'password', 'second', 'hash', ?)", owner.accountId, nowIso()));
});
