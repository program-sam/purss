import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeTestApp } from "../testing.ts";
import { SESSION_COOKIE } from "./accounts.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

async function boot() {
  const { app, cleanup } = makeTestApp({});
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, [publicRouter()]);
  const req = (method: string, path: string, s: TestSession | null, body?: unknown) => call(app, server.base, method, path, s, body);
  return { app, owner, req, close: async () => { await server.close(); cleanup(); } };
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

test("an account sets a username and password after a recent sign-in, then signs in with it", async (t) => {
  const b = await boot();
  t.after(b.close);
  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  const fresh = signIn(b.app, b.owner.accountId);

  const denied = await b.req("PUT", "/api/account/password", stale, { username: "Parent", password: "a long enough secret" });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "step_up");

  assert.equal((await b.req("PUT", "/api/account/password", fresh, { username: "pa", password: "a long enough secret" })).json.error.code, "bad_username");
  assert.equal((await b.req("PUT", "/api/account/password", fresh, { username: "parent", password: "short" })).json.error.code, "short_password");
  assert.equal((await b.req("PUT", "/api/account/password", fresh, { username: "parentparent", password: "ParentParent" })).json.error.code, "weak_password");

  const set = await b.req("PUT", "/api/account/password", fresh, { username: "  Parent ", password: "a long enough secret" });
  assert.equal(set.status, 200, set.text);
  const row = b.app.db.get<{ label: string; secret_hash: string }>("SELECT label, secret_hash FROM sign_in_methods WHERE kind = 'password'")!;
  assert.equal(row.label, "parent", "usernames are stored in lower case");
  assert.equal(row.secret_hash.includes("a long enough secret"), false);
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM audit_events")).includes("a long enough secret"), false, "the password is never logged");

  const wrong = await b.req("POST", "/api/auth/password", null, { username: "parent", password: "not the secret!" });
  assert.equal(wrong.status, 401);
  const unknown = await b.req("POST", "/api/auth/password", null, { username: "nobody", password: "a long enough secret" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.message, wrong.json.error.message, "an unknown username gets the same answer");

  const ok = await b.req("POST", "/api/auth/password", null, { username: "PARENT", password: "a long enough secret" });
  assert.equal(ok.status, 200, ok.text);
  const s = await sessionFrom(b, ok.headers.get("set-cookie"));
  const info = await b.req("GET", "/api/session", s);
  assert.equal(info.json.account.id, b.owner.accountId);
  assert.equal(info.json.account.hasPassword, true);

  const security = await b.req("GET", "/api/account/security", s);
  assert.deepEqual(security.json.methods.map((m: { kind: string; label: string }) => [m.kind, m.label]), [["password", "parent"]]);
  assert.equal(security.json.sessions.find((x: { current: boolean }) => x.current).method, "password");
});

test("usernames are unique, one password per account, and changing it replaces the old one", async (t) => {
  const b = await boot();
  t.after(b.close);
  const other = makeOwner(b.app, { admin: false });
  const me = signIn(b.app, b.owner.accountId);
  const them = signIn(b.app, other.accountId);
  assert.equal((await b.req("PUT", "/api/account/password", me, { username: "family", password: "first long secret" })).status, 200);
  const clash = await b.req("PUT", "/api/account/password", them, { username: "Family", password: "their long secret" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "username_taken");

  assert.equal((await b.req("PUT", "/api/account/password", me, { username: "family2", password: "second long secret" })).status, 200);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE kind = 'password' AND account_id = ?", b.owner.accountId)!.n, 1);
  assert.equal((await b.req("POST", "/api/auth/password", null, { username: "family", password: "first long secret" })).status, 401, "the old username is gone");
  assert.equal((await b.req("POST", "/api/auth/password", null, { username: "family2", password: "first long secret" })).status, 401, "the old password is gone");
  assert.equal((await b.req("POST", "/api/auth/password", null, { username: "family2", password: "second long secret" })).status, 200);
});

test("the password confirms step-up only for its own account", async (t) => {
  const b = await boot();
  t.after(b.close);
  const other = makeOwner(b.app, { admin: false });
  const mine = signIn(b.app, b.owner.accountId);
  const theirs = signIn(b.app, other.accountId);
  await b.req("PUT", "/api/account/password", mine, { username: "stepper", password: "my long secret!!" });
  await b.req("PUT", "/api/account/password", theirs, { username: "stepper2", password: "their long secret" });

  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  assert.equal((await b.req("POST", "/api/auth/step-up/password", stale, { password: "their long secret" })).status, 401, "another account's password doesn't count");
  assert.equal((await b.req("POST", "/api/account/recovery-codes", stale)).json.error.code, "step_up");
  assert.equal((await b.req("POST", "/api/auth/step-up/password", stale, { password: "my long secret!!" })).status, 200);
  assert.equal((await b.req("POST", "/api/account/recovery-codes", stale)).status, 200, "now recent");
});

test("the password can be removed only while another way in remains", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  await b.req("PUT", "/api/account/password", s, { username: "remover", password: "removable secret" });
  b.app.db.run("DELETE FROM sign_in_methods WHERE account_id = ? AND kind <> 'password'", b.owner.accountId);
  const id = b.app.db.get<{ id: string }>("SELECT id FROM sign_in_methods WHERE kind = 'password'")!.id;
  const last = await b.req("DELETE", `/api/account/methods/${id}`, s);
  assert.equal(last.status, 409);
  assert.equal(last.json.error.code, "last_method");
  assert.equal((await b.req("POST", "/api/account/recovery-codes", s)).status, 200);
  assert.equal((await b.req("DELETE", `/api/account/methods/${id}`, s)).status, 200);
  assert.equal(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'password'"), undefined);
});

test("password guessing is rate limited, and then even the right password waits", async (t) => {
  const b = await boot();
  t.after(b.close);
  const s = signIn(b.app, b.owner.accountId);
  await b.req("PUT", "/api/account/password", s, { username: "target", password: "target long secret" });
  // The per-address budget is shared with earlier tests in this file, so only count up to the limit.
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await b.req("POST", "/api/auth/password", null, { username: "target", password: `guess number ${i}` })).status);
  const first = statuses.indexOf(429);
  assert.ok(first >= 0 && first <= 10, `limited within 11 attempts: ${statuses.join(",")}`);
  assert.ok(statuses.slice(0, first).every((x) => x === 401) && statuses.slice(first).every((x) => x === 429), statuses.join(","));
  assert.equal((await b.req("POST", "/api/auth/password", null, { username: "target", password: "target long secret" })).status, 429, "even the right password waits");
});
