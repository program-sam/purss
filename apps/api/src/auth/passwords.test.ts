import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeTestApp } from "../testing.ts";
import { SESSION_COOKIE } from "./accounts.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { checkPassword, hashPassword, preparePassword, storePassword, verifyPassword, writePassword } from "./passwords.ts";

/** The password makeOwner gives every account (testing.ts TEST_PASSWORD). */
const CURRENT = "correct horse battery staple";

async function boot() {
  const { app, cleanup } = makeTestApp({});
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, [publicRouter()]);
  const req = (method: string, path: string, s: TestSession | null, body?: unknown) => call(app, server.base, method, path, s, body);
  const emailOf = (accountId: string) => app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", accountId)!.email;
  return { app, owner, email: emailOf(owner.accountId), emailOf, req, close: async () => { await server.close(); cleanup(); } };
}

/** The session a successful sign-in response set, usable for further calls. */
async function sessionFrom(b: Awaited<ReturnType<typeof boot>>, setCookie: string | null): Promise<TestSession> {
  const token = /purss_session=([^;]+)/.exec(setCookie ?? "")?.[1];
  assert.ok(token, "a session cookie was set");
  const cookie = `${SESSION_COOKIE}=${token}`;
  const s = await b.req("GET", "/api/session", { cookie, csrf: "" });
  return { cookie, csrf: s.json.csrf };
}

test("passwords are stored as salted scrypt hashes and verified", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b, "salted");
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("changing the password takes the current one, however recent the sign-in, then the address signs in with the new one", async (t) => {
  const b = await boot();
  t.after(b.close);
  const fresh = signIn(b.app, b.owner.accountId);
  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });

  for (const body of [{ password: "a long enough secret" }, { currentPassword: "not the password", password: "a long enough secret" }]) {
    const denied = await b.req("PUT", "/api/account/password", fresh, body);
    assert.deepEqual([denied.status, denied.json.error.code], [401, "bad_current_password"], "a fresh sign-in isn't enough on its own");
  }
  assert.equal((await b.req("PUT", "/api/account/password", fresh, { currentPassword: CURRENT, password: "short" })).json.error.code, "short_password");
  assert.equal((await b.req("PUT", "/api/account/password", fresh, { currentPassword: CURRENT, password: b.email.toUpperCase() })).json.error.code, "weak_password", "not the address itself");

  const set = await b.req("PUT", "/api/account/password", stale, { currentPassword: CURRENT, password: "a long enough secret" });
  assert.equal(set.status, 200, set.text);
  const rows = b.app.db.all<{ label: string | null; secret_hash: string }>("SELECT label, secret_hash FROM sign_in_methods WHERE kind = 'password' AND account_id = ?", b.owner.accountId);
  assert.equal(rows.length, 1, "one password per account: changing it replaces the old one");
  assert.equal(rows[0]!.label, null, "a password has no name of its own: the account's address goes with it");
  assert.equal(rows[0]!.secret_hash.includes("a long enough secret"), false);
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM audit_events")).includes("a long enough secret"), false, "the password is never logged");

  const wrong = await b.req("POST", "/api/auth/password", null, { email: b.email, password: "not the secret!" });
  assert.equal(wrong.status, 401);
  const unknown = await b.req("POST", "/api/auth/password", null, { email: "nobody@example.test", password: "a long enough secret" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.message, wrong.json.error.message, "an unknown address gets the same answer");
  assert.equal((await b.req("POST", "/api/auth/password", null, { email: b.email, password: "correct horse battery staple" })).status, 401, "the old password is gone");

  const ok = await b.req("POST", "/api/auth/password", null, { email: b.email.toUpperCase(), password: "a long enough secret" });
  assert.equal(ok.status, 200, ok.text);
  const s = await sessionFrom(b, ok.headers.get("set-cookie"));
  const info = await b.req("GET", "/api/session", s);
  assert.equal(info.json.account.id, b.owner.accountId);
  assert.equal(info.json.account.hasPassword, true);

  const security = await b.req("GET", "/api/account/security", s);
  assert.deepEqual(security.json.methods.map((m: { kind: string; label: string | null }) => [m.kind, m.label]), [["password", "Password"]]);
  assert.equal(security.json.sessions.find((x: { current: boolean }) => x.current).method, "password");
});

test("the password confirms step-up and a password change only for its own account", async (t) => {
  const b = await boot();
  t.after(b.close);
  const other = makeOwner(b.app, { admin: false });
  const mine = signIn(b.app, b.owner.accountId);
  const theirs = signIn(b.app, other.accountId);
  await b.req("PUT", "/api/account/password", mine, { currentPassword: CURRENT, password: "my long secret!!" });
  await b.req("PUT", "/api/account/password", theirs, { currentPassword: CURRENT, password: "their long secret" });

  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  assert.equal((await b.req("POST", "/api/auth/step-up/password", stale, { password: "their long secret" })).status, 401, "another account's password doesn't count");
  assert.equal((await b.req("PUT", "/api/account/password", stale, { currentPassword: "their long secret", password: "my other long secret" })).json.error.code, "bad_current_password");
  assert.equal((await b.req("POST", "/api/auth/step-up/password", stale, { password: "my long secret!!" })).status, 200);
});

test("two password changes at once: only the first wins, whether changing the password or adding a first one", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const change = (password: string) => b.req("PUT", "/api/account/password", s, { currentPassword: CURRENT, password });
  const changed = await Promise.all([change("first new long secret"), change("second new long secret")]);
  assert.deepEqual(changed.map((r) => r.status).sort(), [200, 409], "the second was allowed against a password that is gone");
  assert.equal(changed.find((r) => r.status === 409)!.json.error.code, "password_changed");
  const winner = changed[0]!.status === 200 ? "first new long secret" : "second new long secret";
  assert.equal(await checkPassword(b.app, b.email, winner), b.owner.accountId, "the one that answered 200 is the password");

  // An account with no password yet (made with a provider) adds one; two at once can't both win.
  b.app.db.run("DELETE FROM sign_in_methods WHERE account_id = ?", b.owner.accountId);
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES ('sim_o', ?, 'oidc', 'Provider', 'https://id.example', 'sub-1', '2026-01-01T00:00:00.000Z')", b.owner.accountId);
  const add = (password: string) => b.req("PUT", "/api/account/password", s, { password });
  const added = await Promise.all([add("first added long secret"), add("second added long secret")]);
  assert.deepEqual(added.map((r) => r.status).sort(), [200, 409], "the second would have replaced a password it never knew");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'password_change' AND actor_account_id = ?", b.owner.accountId)!.n, 1, "only the first change above, never an add overwritten");
});

test("guessing the current password is limited like confirming it's you", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await b.req("PUT", "/api/account/password", s, { currentPassword: `guess ${i}`, password: "a long enough secret" })).status);
  assert.deepEqual([statuses.slice(0, 10).every((x) => x === 401), statuses[10]], [true, 429]);
  assert.equal((await b.req("PUT", "/api/account/password", s, { currentPassword: CURRENT, password: "a long enough secret" })).status, 429, "even the right one waits");
});

test("a session guessing the current password can't lock its person out of their other sessions", async (t) => {
  const b = await boot();
  t.after(b.close);
  const leftOpen = signIn(b.app, b.owner.accountId);
  for (let i = 0; i < 11; i++) await b.req("POST", "/api/auth/step-up/password", leftOpen, { password: `guess ${i}` });
  assert.equal((await b.req("POST", "/api/auth/step-up/password", leftOpen, { password: CURRENT })).status, 429, "that session waits");
  const own = signIn(b.app, b.owner.accountId);
  assert.equal((await b.req("POST", "/api/auth/step-up/password", own, { password: CURRENT })).status, 200, "the person's own session doesn't");
  assert.equal((await b.req("PUT", "/api/account/password", own, { currentPassword: CURRENT, password: "a long enough secret" })).status, 200);
});

test("the password can be changed but never removed, while a passkey can be removed", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  await b.req("PUT", "/api/account/password", s, { currentPassword: CURRENT, password: "kept long secret" });
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, created_at) VALUES ('sim_pk', ?, 'passkey', 'Laptop', 'cred-1', x'01', 0, '2026-01-01T00:00:00.000Z')", b.owner.accountId);
  const password = b.app.db.get<{ id: string }>("SELECT id FROM sign_in_methods WHERE kind = 'password' AND account_id = ?", b.owner.accountId)!.id;

  const refused = await b.req("DELETE", `/api/account/methods/${password}`, s);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "password_required");
  assert.match(refused.json.error.message, /changed but not removed/);
  assert.ok(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE id = ?", password), "the password is still there");

  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  assert.equal((await b.req("DELETE", "/api/account/methods/sim_pk", stale)).json.error.code, "step_up", "removing a way in needs a recent sign-in");
  assert.equal((await b.req("DELETE", "/api/account/methods/sim_pk", s)).status, 200);
  assert.equal(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE id = 'sim_pk'"), undefined, "the passkey is gone");
  assert.ok(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE id = ?", password), "and the password stays");
  assert.equal((await b.req("POST", "/api/auth/password", null, { email: b.email, password: "kept long secret" })).status, 200, "so the account can still sign in");
});

test("an account always keeps one way to sign in", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  // An account whose only way in is a linked provider (the password row is taken away to make that so).
  b.app.db.run("DELETE FROM sign_in_methods WHERE account_id = ?", b.owner.accountId);
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES ('sim_o', ?, 'oidc', 'Provider', 'https://id.example', 'sub-1', '2026-01-01T00:00:00.000Z')", b.owner.accountId);
  const last = await b.req("DELETE", "/api/account/methods/sim_o", s);
  assert.equal(last.status, 409);
  assert.equal(last.json.error.code, "last_method");
  assert.ok(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE id = 'sim_o'"));
});

test("password guessing is rate limited, and then even the right password waits", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  await b.req("PUT", "/api/account/password", s, { currentPassword: CURRENT, password: "target long secret" });
  // The per-network-address budget is shared with earlier tests in this file, so only count up to the limit.
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await b.req("POST", "/api/auth/password", null, { email: b.email, password: `guess number ${i}` })).status);
  const first = statuses.indexOf(429);
  assert.ok(first >= 0 && first <= 10, `limited within 11 attempts: ${statuses.join(",")}`);
  assert.ok(statuses.slice(0, first).every((x) => x === 401) && statuses.slice(first).every((x) => x === 429), statuses.join(","));
  assert.equal((await b.req("POST", "/api/auth/password", null, { email: b.email, password: "target long secret" })).status, 429, "even the right password waits");
});

test("a password changed while a sign-in is being checked wins: the old password doesn't sign in", async () => {
  const { app, cleanup } = makeTestApp({});
  try {
    const owner = makeOwner(app, { admin: true });
    const email = app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", owner.accountId)!.email;
    await writePassword(app, owner.accountId, "an old harbour password");
    const next = await preparePassword("a new harbour password", email);
    const checking = checkPassword(app, email, "an old harbour password");
    storePassword(app, owner.accountId, next); // committed while the old one is still being hashed
    assert.equal(await checking, null);
    assert.equal(await checkPassword(app, email, "a new harbour password"), owner.accountId);
  } finally { cleanup(); }
});

test("changing the password ends the account's other sessions, as a reset does; the one making the change stays", async (t) => {
  const b = await boot();
  t.after(b.close);
  const here = signIn(b.app, b.owner.accountId);
  const elsewhere = signIn(b.app, b.owner.accountId);
  assert.equal((await b.req("PUT", "/api/account/password", here, { currentPassword: CURRENT, password: "a long enough secret" })).status, 200);
  assert.equal((await b.req("GET", "/api/session", elsewhere)).json.state, "signed_out");
  assert.equal((await b.req("GET", "/api/session", here)).json.state, "signed_in");
});
