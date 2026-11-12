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
import { renewSessionCookie, resolvePrincipal, setPassword, startSession } from "./accounts.ts";
import { randomToken, sha256 } from "../secrets.ts";

function fakeResponse() {
  const headers = new Map<string, string | string[]>();
  const response = {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => { headers.set(name, value); },
  } as unknown as ServerResponse;
  return { response, headers };
}

function insertSession(app: ReturnType<typeof makeTestApp>["app"], accountId: string, opts: { lastSeenAt?: string; expiresAt?: string } = {}) {
  const token = randomToken(32);
  const id = sha256(token);
  app.db.run(
    "INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method, session_class) VALUES (?, ?, 'csrf', ?, ?, ?, ?, 'password', 'persistent')",
    id, accountId, nowIso(), opts.expiresAt ?? addSeconds(30 * 86400), opts.lastSeenAt ?? nowIso(), nowIso(),
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

test("a password change whose session ended while hashing cannot commit", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  const before = app.db.get<{ secret_hash: string }>("SELECT secret_hash FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId)!.secret_hash;
  const session = insertSession(app, owner.accountId);
  const pending = setPassword(app, owner.accountId, session.id, "a password hashing secret", { expectedHash: before, requireRecent: false });
  // setPassword has started async scrypt and has not reached its write transaction.
  app.db.run("DELETE FROM sessions WHERE id = ?", session.id);
  await assert.rejects(pending, (e: unknown) => e instanceof HttpError && e.code === "signed_out");
  assert.equal(app.db.get<{ secret_hash: string }>("SELECT secret_hash FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", owner.accountId)!.secret_hash, before, "the password is unchanged");
});

test("shared-computer cookies stay browser-session cookies and expire after eight hours for every sign-in class", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app, { admin: false });
  for (const method of ["signup", "setup", "invite", "passkey", "password", "oidc"]) {
    const started = fakeResponse();
    startSession(app, started.response, { headers: { "user-agent": "Firefox/123 Linux" } } as IncomingMessage, owner.accountId, method, { sharedComputer: true });
    const header = String((started.headers.get("set-cookie") as string[])[0]);
    assert.doesNotMatch(header, /Max-Age/i, `${method} cookie remains browser-session scoped`);
    const token = decodeURIComponent(/purss_session=([^;]+)/.exec(header)![1]!);
    const id = sha256(token);
    const row = app.db.get<{ created_at: string; expires_at: string; session_class: string }>("SELECT created_at, expires_at, session_class FROM sessions WHERE id = ?", id)!;
    assert.equal(row.session_class, "shared", method);
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
    response = await call(app, server.base, "POST", "/api/signup/start", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": address } });
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
    const invalid = await call(app, server.base, "POST", "/api/signup/start", null, { email: "not an address" }, { headers: { "x-forwarded-for": address } });
    assert.equal(invalid.status, 400, `attempt ${i + 1} was charged before input validation`);
  }

  const capacityTime = nowIso();
  const addressHash = sha256(`${app.serviceToken}\0signup-address\0${address}`);
  for (let i = 0; i < 10; i++) {
    const accountId = `acc_signup_edge_${i}`;
    app.db.run("INSERT INTO accounts (id, created_at) VALUES (?, ?)", accountId, capacityTime);
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", accountId, addressHash, capacityTime);
  }

  const response = await call(app, server.base, "POST", "/api/signup/start", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": address } });
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
  const first = await call(app, server.base, "POST", "/api/signup/start", null, { email: "new@example.org" }, options);
  assert.equal(first.status, 429);
  assert.equal(first.json.error.code, "signup_full");
  assert.equal(first.headers.get("retry-after"), null, "an operator pause has no automatic release time");

  let last = first;
  for (let i = 1; i < 31; i++) last = await call(app, server.base, "POST", "/api/signup/start", null, { email: "new@example.org" }, options);
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
  const response = await call(app, server.base, "POST", "/api/signup/start", null, { email: "new@example.org" }, { headers: { "x-forwarded-for": `203.0.113.${randomToken(16)}` } });
  assert.equal(response.status, 429);
  assert.equal(response.json.error.code, "signup_full");
  assert.equal(response.headers.get("retry-after"), null, "an unknown release time must not be guessed");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 0);
});

