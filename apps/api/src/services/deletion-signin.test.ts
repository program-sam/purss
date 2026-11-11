import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Server } from "oauth2-mock-server";
import { bootDeletion, makeDue, member, setCookie, signInWithPassword } from "../deletion-testing.ts";
import type { DeletionBoot, Member } from "../deletion-testing.ts";
import { signIn } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { claimDeletion } from "./deletion.ts";

async function requestDeletion(b: DeletionBoot, m: Member, name: string): Promise<string> {
  const r = await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: name });
  assert.equal(r.status, 200, r.text);
  return r.json.dueAt;
}

const sessionOf = (r: { headers: Headers }): TestSession | null => {
  const c = setCookie(r as Response, "purss_session");
  return c && !c.header.includes("Max-Age=0") ? { cookie: c.pair, csrf: "" } : null;
};

test("signing in during the grace period starts no session: a single-use cookie lets this browser keep the account", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Kim");
  const dueAt = await requestDeletion(b, m, "Kim");

  const r = await signInWithPassword(b, m);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "deletion_pending");
  assert.equal(r.json.error.dueAt, dueAt);
  assert.equal(sessionOf(r), null, "no session cookie");
  assert.equal(b.app.db.get("SELECT 1 FROM sessions WHERE account_id = ?", m.accountId), undefined, "and no session row");
  const cookie = setCookie(r, "purss_deletion")!;
  assert.match(cookie.header, /HttpOnly/);
  assert.match(cookie.header, /SameSite=Lax/);
  assert.match(cookie.header, /Path=\/api\/auth\/deletion/);
  assert.match(cookie.header, /Max-Age=600/);
  assert.ok(!r.text.includes(cookie.pair.split("=")[1]!), "the token isn't in the body");
  const stored = b.app.db.get<{ token: string }>("SELECT token FROM confirm_tokens WHERE purpose = 'deletion-cancel'")!;
  assert.notEqual(stored.token, cookie.pair.split("=")[1], "only its hash is stored");

  assert.deepEqual((await b.api(null, "GET", "/api/auth/deletion", undefined, { cookie: cookie.pair })).json, { dueAt });
  assert.deepEqual((await b.api(null, "GET", "/api/auth/deletion")).json, { dueAt: null }, "without the cookie nothing is revealed");

  const kept = await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie: cookie.pair });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(b.app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", m.accountId), undefined, "the deletion is over");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'account_deletion_cancelled' AND actor_account_id = ?", m.accountId));
  assert.match(setCookie(kept, "purss_deletion")!.header, /Max-Age=0/, "the cookie is cleared");
  const session = sessionOf(kept);
  assert.ok(session, "a session started");
  const info = await b.api(session, "GET", "/api/session");
  assert.equal(info.json.state, "signed_in");
  assert.equal(info.json.account.id, m.accountId);
  assert.equal(b.app.db.get<{ method: string }>("SELECT method FROM sessions WHERE account_id = ?", m.accountId)!.method, "password", "the session records how they signed in");

  const replay = await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie: cookie.pair });
  assert.equal(replay.status, 403, "the token works once");
  assert.equal(replay.json.error.code, "cancel_expired");

  // The account works normally again: signing in starts a session straight away.
  assert.equal((await signInWithPassword(b, m)).status, 200);
});

test("a sibling token is useless after a cancel and a new request", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Lee");
  await requestDeletion(b, m, "Lee");

  const first = setCookie(await signInWithPassword(b, m), "purss_deletion")!.pair;
  const again = await signInWithPassword(b, m);
  assert.equal(again.status, 409);
  const sibling = setCookie(again, "purss_deletion")!.pair;
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM confirm_tokens WHERE purpose = 'deletion-cancel'")!.n, 2);

  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie: first })).status, 200);
  await requestDeletion(b, m, "Lee");
  const late = await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie: sibling });
  assert.equal(late.status, 403);
  assert.equal(late.json.error.code, "cancel_expired");
  assert.ok(b.app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", m.accountId), "the new request stands");

  // A token is bound to its request: one made for an earlier request can't cancel a later one.
  const fresh = setCookie(await signInWithPassword(b, m), "purss_deletion")!.pair;
  b.app.db.run("UPDATE account_deletions SET request_id = 'adr_other' WHERE account_id = ?", m.accountId);
  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie: fresh })).json.error.code, "cancel_expired");
  assert.deepEqual((await b.api(null, "GET", "/api/auth/deletion", undefined, { cookie: fresh })).json, { dueAt: null });
});

test("\"Leave it\" forgets this browser's chance to keep the account", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Ash");
  await requestDeletion(b, m, "Ash");
  const cookie = setCookie(await signInWithPassword(b, m), "purss_deletion")!.pair;
  const left = await b.api(null, "DELETE", "/api/auth/deletion", undefined, { cookie });
  assert.equal(left.status, 200);
  assert.match(setCookie(left, "purss_deletion")!.header, /Max-Age=0/);
  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie })).status, 403);
  assert.ok(b.app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", m.accountId), "the deletion goes ahead");
});

test("once the grace period is over or removal started, signing in is refused and keeping is impossible", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Jo");
  await requestDeletion(b, m, "Jo");
  const cookie = setCookie(await signInWithPassword(b, m), "purss_deletion")!.pair;

  makeDue(b.app, m.accountId);
  const expired = await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie });
  assert.equal(expired.status, 403);
  assert.equal(expired.json.error.code, "account_deleting");
  const late = await signInWithPassword(b, m);
  assert.equal(late.status, 403);
  assert.equal(late.json.error.code, "account_deleting");
  assert.equal(setCookie(late, "purss_deletion"), null, "no cookie is offered");

  assert.equal(claimDeletion(b.app, m.accountId), true);
  b.app.db.run("UPDATE account_deletions SET due_at = ? WHERE account_id = ?", new Date(Date.now() + 86_400_000).toISOString(), m.accountId);
  assert.equal((await signInWithPassword(b, m)).json.error.code, "account_deleting", "purging, even with time left on the clock");
  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie })).json.error.code, "account_deleting");
  assert.equal(b.app.db.get<{ state: string }>("SELECT state FROM account_deletions WHERE account_id = ?", m.accountId)!.state, "purging");
});

test("OIDC sign-in during the grace period hands over through the cookie, not the URL", async (t) => {
  const issuer = new OAuth2Server();
  await issuer.issuer.keys.generate("RS256");
  await issuer.start(0, "127.0.0.1");
  t.after(() => issuer.stop());
  const b = await bootDeletion({ PURSS_OIDC: JSON.stringify([{ id: "mock", label: "Mock ID", issuer: issuer.issuer.url!, clientId: "purss-test" }]) });
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Oli");
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES ('sim_oidc', ?, 'oidc', 'Mock ID', ?, 'oli-sub', ?)", m.accountId, issuer.issuer.url!, new Date().toISOString());
  issuer.service.on("beforeTokenSigning", (token) => { token.payload.sub = "oli-sub"; });
  await requestDeletion(b, m, "Oli");

  const start = await fetch(`${b.base}/api/auth/oidc/mock/start`, { redirect: "manual" });
  const binder = setCookie(start, "purss_oidc")!.pair;
  const atIssuer = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const back = new URL(atIssuer.headers.get("location")!);
  const callback = await fetch(`${b.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: binder } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/app/signin?notice=deletion_pending", "no token in the address");
  assert.equal(setCookie(callback, "purss_session"), null);
  const cookie = setCookie(callback, "purss_deletion")!.pair;
  assert.ok((await b.api(null, "GET", "/api/auth/deletion", undefined, { cookie })).json.dueAt);
  const kept = await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie });
  assert.equal(kept.status, 200);
  assert.equal(b.app.db.get<{ method: string }>("SELECT method FROM sessions WHERE account_id = ?", m.accountId)!.method, "oidc");
});
