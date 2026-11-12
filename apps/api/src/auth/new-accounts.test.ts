import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { call, startTestServer } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { checkPassword } from "./passwords.ts";
import { SESSION_COOKIE, createInvite, ensureClaimCode } from "./accounts.ts";
import type { TestSession } from "../features-testing.ts";

/*
 * Every way of making an account (the first-run setup code, an invitation, open sign-up, the phone app) takes an email
 * address and password and makes the account with them. A refused password leaves nothing behind, and no recovery codes
 * exist anywhere.
 */

const PASSWORD = "tidal flats at low water";

async function boot() {
  const { app, cleanup } = makeTestApp();
  const server = await startTestServer(app, [publicRouter()]);
  const post = (path: string, body: unknown) => call(app, server.base, "POST", path, null, body);
  const sessionFrom = async (setCookie: string | null): Promise<TestSession> => {
    const token = /purss_session=([^;]+)/.exec(setCookie ?? "")?.[1];
    assert.ok(token, "a session cookie was set");
    const cookie = `${SESSION_COOKIE}=${token}`;
    return { cookie, csrf: (await call(app, server.base, "GET", "/api/session", { cookie, csrf: "" })).json.csrf };
  };
  return { app, server, post, sessionFrom, close: async () => { await server.close(); cleanup(); } };
}

const methods = (b: Awaited<ReturnType<typeof boot>>, accountId: string) =>
  b.app.db.all<{ kind: string; label: string | null }>("SELECT kind, label FROM sign_in_methods WHERE account_id = ?", accountId).map((m) => [m.kind, m.label]);
const emailOf = (b: Awaited<ReturnType<typeof boot>>, accountId: string) =>
  b.app.db.get<{ email: string; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId)!;

test("setting up an installation takes an address and password, makes the owner with them and returns no codes", async (t) => {
  const b = await boot();
  t.after(b.close);
  const code = ensureClaimCode(b.app)!;
  assert.ok(existsSync(`${b.app.config.secretsDir}/setup-code`));

  // Without a valid address and password nothing is made, and the setup code still works.
  assert.equal((await b.post("/api/setup/claim", { code })).status, 400);
  assert.equal((await b.post("/api/setup/claim", { code, email: "sam", password: PASSWORD })).status, 400);
  assert.equal((await b.post("/api/setup/claim", { code, email: "sam@example.org", password: "short" })).json.error.code, "short_password");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 0);
  assert.ok(existsSync(`${b.app.config.secretsDir}/setup-code`));

  const out = await b.post("/api/setup/claim", { code, displayName: "Sam", email: " Sam@Example.org ", password: PASSWORD });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { ok: true });
  const owner = b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id;
  assert.deepEqual(methods(b, owner), [["password", null]], "a password and nothing else");
  assert.deepEqual({ ...emailOf(b, owner) }, { email: "Sam@Example.org", email_verified_at: null }, "the address as typed, trimmed; no mail server to confirm it");
  assert.ok(b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", owner), "the first owner is an administrator");
  assert.ok(!existsSync(`${b.app.config.secretsDir}/setup-code`), "the setup code is spent");

  const session = await b.sessionFrom(out.headers.get("set-cookie"));
  const info = (await call(b.app, b.server.base, "GET", "/api/session", session)).json;
  assert.deepEqual([info.state, info.account.email, info.account.hasPassword, info.account.hasPasskey], ["signed_in", "Sam@Example.org", true, false]);
  assert.equal(await checkPassword(b.app, "sam@example.org", PASSWORD), owner, "and it signs in with that address and password");
  assert.equal((await b.post("/api/auth/password", { email: "SAM@example.org", password: PASSWORD })).status, 200);
});

test("accepting an invitation takes the invited address and a password, and a refused one leaves the invitation unused", async (t) => {
  const b = await boot();
  t.after(b.close);
  const owner = makeOwner(b.app);
  const invitation = createInvite(b.app, owner.accountId, "Sister@Example.test", null, null);
  const accept = (body: Record<string, unknown>) => b.post("/api/invites/accept", { code: invitation, ...body });
  const used = () => b.app.db.get<{ used_at: string | null }>("SELECT used_at FROM invites")!.used_at;

  assert.equal((await accept({})).status, 400);
  assert.equal((await accept({ email: "sister@example.test", password: "short" })).json.error.code, "short_password");
  const other = await accept({ email: "someone@example.test", password: PASSWORD });
  assert.equal(other.status, 403);
  assert.equal(other.json.error.code, "invite_email", "only the address it was made for");
  assert.equal(used(), null);
  // An address another account took meanwhile is refused, and nothing is half made.
  b.app.db.run("UPDATE accounts SET email = 'SISTER@example.test' WHERE id = ?", owner.accountId);
  const clash = await accept({ email: "sister@example.test", password: PASSWORD });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "email_in_use");
  assert.equal(used(), null);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n, 1, "no half-made account");
  b.app.db.run("UPDATE accounts SET email = 'owner@example.test' WHERE id = ?", owner.accountId);

  const out = await accept({ displayName: "Sister", email: "sister@EXAMPLE.test", password: PASSWORD });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { ok: true }, "no codes");
  const sister = b.app.db.get<{ id: string }>("SELECT id FROM accounts WHERE display_name = 'Sister'")!.id;
  assert.deepEqual(methods(b, sister), [["password", null]]);
  assert.deepEqual({ ...emailOf(b, sister) }, { email: "Sister@Example.test", email_verified_at: null }, "the address the administrator typed; without email it stays unconfirmed");
  assert.equal(b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", sister), undefined, "an invitation never grants administration");
  assert.notEqual(used(), null);
  assert.equal(await checkPassword(b.app, "sister@example.test", PASSWORD), sister);
  assert.equal((await accept({ email: "sister@example.test", password: PASSWORD })).status, 403, "an invitation works once");
});

test("an invitation can't be made for an address that has an account", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const owner = makeOwner(app);
  const taken = app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", owner.accountId)!.email;
  assert.throws(() => createInvite(app, owner.accountId, taken.toUpperCase(), null, null), (e: unknown) => (e as { code?: string }).code === "email_in_use");
});
