import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Server } from "oauth2-mock-server";
import { makeOwner, makeTestApp } from "../testing.ts";
import { call, signIn } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { bootDeletion, member, setCookie } from "../deletion-testing.ts";
import type { DeletionBoot } from "../deletion-testing.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import { finishOidc, issueAppTicket, startFromTicket, startOidc } from "./oidc.ts";
import type { OidcCaller, OidcPurpose } from "./oidc.ts";
import { addSeconds, consumeRateLimit, HttpError, nowIso } from "../http.ts";
import { createDeviceToken, DEVICE_SESSION_PREFIX } from "../connect/devices.ts";
import { sha256 } from "../secrets.ts";
import type { App } from "../app.ts";

/*
 * External sign-in (OpenID Connect) against a local issuer: the real openid-client flow (code + PKCE + state + nonce), the
 * account a provider can create, and "confirm it's you" with a provider.
 */

const HOSTED = { PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_TRUST_PROXY: "1", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };

type Issuer = { authorize: (url: string) => Promise<URL>; setClaims: (c: Claims) => void };

/** The claims the issuer puts in the next ID tokens. */
type Claims = { sub: string; email?: string; email_verified?: boolean; name?: string; auth_time?: number };

async function issuer(t: test.TestContext) {
  const server = new OAuth2Server();
  await server.issuer.keys.generate("RS256");
  await server.start(0, "127.0.0.1");
  t.after(() => server.stop());
  let claims: Claims = { sub: "user-123" };
  server.service.on("beforeTokenSigning", (token) => { Object.assign(token.payload, claims); });
  /** Follow the authorization redirect the way a browser would; returns the callback URL and what the request asked for. */
  const authorize = async (url: string) => {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    assert.ok(location, "the issuer redirects back");
    return new URL(location);
  };
  return { url: server.issuer.url!, authorize, setClaims: (c: Claims) => { claims = c; } };
}

const provider = (url: string, extra: Record<string, unknown> = {}) => JSON.stringify([{ id: "mock", label: "Mock ID", issuer: url, clientId: "purss-test", ...extra }]);

let addresses = 0;
/** A fresh client address, so one test's sign-up attempts never count against another's. */
const freshAddress = () => `198.51.100.${++addresses}`;
const caller = (binder: string, who: { accountId?: string; sessionId?: string } = {}, address = freshAddress()): OidcCaller => ({ binder, accountId: who.accountId ?? null, sessionId: who.sessionId ?? null, address });
const sessionIdOf = (s: TestSession) => sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(s.cookie)![1]!));

/** A hosted installation with open sign-up (it needs working outgoing email), without a listener. */
async function hosted(t: test.TestContext, env: Record<string, string> = {}, providerExtra: Record<string, unknown> = {}) {
  const iss = await issuer(t);
  const made = makeTestApp({ ...HOSTED, PURSS_OIDC: provider(iss.url, providerExtra), ...env });
  useTransport(made.app, { send: async () => {}, verify: async () => {} });
  await checkMail(made.app);
  t.after(async () => { await settleMail(made.app); made.cleanup(); });
  return { app: made.app, ...iss };
}

/** One complete provider round trip: start, the provider, finish. */
async function signInWith(app: App, iss: Issuer, c: OidcCaller, purpose: OidcPurpose = "signin", opts: { accountId?: string | null; sharedComputer?: boolean } = {}) {
  const url = await startOidc(app, "mock", purpose, opts.accountId ?? null, c.binder, { sharedComputer: opts.sharedComputer, sessionId: c.sessionId });
  return finishOidc(app, "mock", await iss.authorize(url), c);
}

const rejected = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
const accountCount = (app: App) => app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n;

test("OIDC: link while signed in, then sign in with it; binding by issuer + subject", async (t) => {
  const iss = await issuer(t);
  const { app, cleanup } = makeTestApp({ PURSS_OIDC: provider(iss.url) });
  t.after(cleanup);
  const owner = makeOwner(app);
  const sessionId = sessionIdOf(signIn(app, owner.accountId));
  const linked = await signInWith(app, iss, caller("binder-link", { accountId: owner.accountId, sessionId }), "link", { accountId: owner.accountId });
  assert.deepEqual(linked, { purpose: "link", accountId: owner.accountId, sharedComputer: false, created: false, viaApp: false });
  assert.ok(app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'user-123' AND account_id = ?", owner.accountId));

  const out = await signInWith(app, iss, caller("binder-signin"));
  assert.deepEqual(out, { purpose: "signin", accountId: owner.accountId, sharedComputer: false, created: false, viaApp: false });
  const shared = await signInWith(app, iss, caller("binder-shared"), "signin", { sharedComputer: true });
  assert.equal(shared.sharedComputer, true, "the shared-computer choice survives the OIDC round trip");
});

test("OIDC asks for the openid, email and profile scopes; a shared computer is offered the account choice", async (t) => {
  const iss = await issuer(t);
  const { app, cleanup } = makeTestApp({ PURSS_OIDC: provider(iss.url) });
  t.after(cleanup);
  const plain = new URL(await startOidc(app, "mock", "signin", null, "b1"));
  assert.equal(plain.searchParams.get("scope"), "openid email profile");
  assert.equal(plain.searchParams.get("prompt"), null);
  assert.equal(new URL(await startOidc(app, "mock", "signin", null, "b2", { sharedComputer: true })).searchParams.get("prompt"), "select_account");
});

test("OIDC linking keeps the sign-in fresh at start and rechecks the live session after the provider return", async (t) => {
  const iss = await issuer(t);
  const { app, cleanup } = makeTestApp({ PURSS_OIDC: provider(iss.url) });
  t.after(cleanup);
  const owner = makeOwner(app);
  const sessionId = sessionIdOf(signIn(app, owner.accountId));
  const linkUrl = await startOidc(app, "mock", "link", owner.accountId, "binder-delayed", { sessionId });
  const callback = await iss.authorize(linkUrl);

  // The link route already required recent auth before starting this external flow.
  // The provider may take longer than that freshness window; the callback must still
  // reject a revoked session, but not discard a valid authorization due only to time.
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", addSeconds(-11 * 60), sessionId);
  const linked = await finishOidc(app, "mock", callback, caller("binder-delayed", { accountId: owner.accountId, sessionId }));
  assert.equal(linked.purpose, "link");
  assert.ok(app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'user-123' AND account_id = ?", owner.accountId));
});

test("OIDC: a callback finished in another browser, a replay, or an unlinked identity is refused", async (t) => {
  const iss = await issuer(t);
  const { app, cleanup } = makeTestApp({ PURSS_OIDC: provider(iss.url) });
  t.after(cleanup);
  const owner = makeOwner(app);
  const ownerSessionId = sessionIdOf(signIn(app, owner.accountId));
  await signInWith(app, iss, caller("b1", { accountId: owner.accountId, sessionId: ownerSessionId }), "link", { accountId: owner.accountId });

  // Login CSRF: someone else's callback URL opened in a browser without the binder cookie.
  const stolen = await iss.authorize(await startOidc(app, "mock", "signin", null, "attacker-binder"));
  await assert.rejects(finishOidc(app, "mock", stolen, caller("victim-has-no-binder")), rejected("mismatch"));
  // The state was consumed: replaying the callback fails too.
  await assert.rejects(finishOidc(app, "mock", stolen, caller("attacker-binder")), rejected("expired"));

  // Linking must finish in the signed-in browser of the same account.
  const other = makeOwner(app, { admin: false });
  const otherSessionId = sessionIdOf(signIn(app, other.accountId));
  const linkCb = await iss.authorize(await startOidc(app, "mock", "link", owner.accountId, "b2", { sessionId: ownerSessionId }));
  await assert.rejects(finishOidc(app, "mock", linkCb, caller("b2", { accountId: other.accountId, sessionId: otherSessionId })), rejected("mismatch"));

  // An identity nobody linked can't sign in where sign-up is closed, and no account is created for it.
  iss.setClaims({ sub: "stranger", email: "stranger@example.org", email_verified: true });
  await assert.rejects(signInWith(app, iss, caller("b3")), rejected("not_linked"));
  assert.equal(accountCount(app), 2);
});

test("sign-up through a provider creates one account: confirmed email, name from the provider, no password", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  setClaims({ sub: "g-1", email: "Ana.Reader@Example.org", email_verified: true, name: "  Ana Reader  " });
  const address = freshAddress();
  const out = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b1")), caller("b1", {}, address));
  assert.equal(out.created, true);
  assert.equal(out.purpose, "signin");
  assert.equal(accountCount(app), 1);
  const account = app.db.get<{ id: string; display_name: string; email: string; email_verified_at: string | null }>("SELECT id, display_name, email, email_verified_at FROM accounts")!;
  assert.equal(account.id, out.accountId);
  assert.equal(account.display_name, "Ana Reader");
  assert.equal(account.email, "Ana.Reader@Example.org");
  assert.ok(account.email_verified_at, "the provider vouched for the address: stored confirmed");
  assert.deepEqual(app.db.all<{ kind: string; issuer: string; subject: string; label: string }>("SELECT kind, issuer, subject, label FROM sign_in_methods WHERE account_id = ?", account.id)
    .map((m) => [m.kind, m.subject, m.label]), [["oidc", "g-1", "Mock ID"]], "one linked sign-in, no password");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM email_tokens")!.n, 0, "nothing to confirm");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM mail_queue")!.n, 0, "and no mail sent");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM signup_creations WHERE account_id = ?", account.id)!.n, 1, "counted like any sign-up");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'signup' AND outcome = 'success' AND actor_account_id = ?", account.id)!.n, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM engine_users WHERE account_id = ?", account.id)!.n, 1, "its own workspace and engine user");
  assert.equal(app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", account.id), undefined, "an ordinary account, never an administrator");

  // Signing in again with the same identity signs in the same account.
  const again = await signInWith(app, { authorize, setClaims }, caller("b2", {}, address));
  assert.deepEqual([again.accountId, again.created], [account.id, false]);
  assert.equal(accountCount(app), 1);
});

test("a long or odd provider name is trimmed to 60 characters; no name leaves the display name empty", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  setClaims({ sub: "g-long", email: "long@example.org", email_verified: true, name: `${"é".repeat(70)}\n` });
  const out = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b1")), caller("b1"));
  assert.equal([...app.db.get<{ display_name: string }>("SELECT display_name FROM accounts WHERE id = ?", out.accountId)!.display_name].length, 60);
  setClaims({ sub: "g-none", email: "none@example.org", email_verified: true });
  const bare = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b2")), caller("b2"));
  assert.equal(app.db.get<{ display_name: string | null }>("SELECT display_name FROM accounts WHERE id = ?", bare.accountId)!.display_name, null);
});

test("an email the provider doesn't vouch for makes no account", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const attempt = async (claims: Claims) => {
    setClaims(claims);
    await assert.rejects(finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b")), caller("b")), rejected("email_unverified"));
  };
  await attempt({ sub: "u1", email: "unverified@example.org", email_verified: false });
  await attempt({ sub: "u2", email: "no-flag@example.org" });
  await attempt({ sub: "u3" });
  await attempt({ sub: "u4", email: "not an address", email_verified: true });
  assert.equal(accountCount(app), 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM sign_in_methods")!.n, 0);
});

test("an email that already belongs to an account is neither linked nor duplicated, confirmed or not", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const owner = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET email = 'Ana@Example.org', email_verified_at = NULL WHERE id = ?", owner.accountId);
  const second = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET email = 'bo@example.org', email_verified_at = ? WHERE id = ?", nowIso(), second.accountId);
  const before = accountCount(app);
  for (const [sub, email] of [["u1", "ana@example.org"], ["u2", "BO@EXAMPLE.ORG"]] as const) {
    setClaims({ sub, email, email_verified: true });
    await assert.rejects(finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, `b-${sub}`)), caller(`b-${sub}`)),
      (e: unknown) => e instanceof HttpError && e.code === "email_in_use" && /username and password/.test(e.message) && /Settings → Security/.test(e.message));
  }
  assert.equal(accountCount(app), before, "no second account");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc'")!.n, 0, "and nothing linked");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM signup_creations")!.n, 0, "no capacity used");
});

test("where sign-up is closed an unlinked identity gets not_linked, with a verified email too", async (t) => {
  const iss = await issuer(t);
  for (const env of [{} as Record<string, string>, { PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://ws.example.org" }]) {
    const { app, cleanup } = makeTestApp({ PURSS_OIDC: provider(iss.url), ...env });
    t.after(cleanup);
    iss.setClaims({ sub: "g-closed", email: "closed@example.org", email_verified: true, name: "Closed" });
    await assert.rejects(signInWith(app, iss, caller("b")), rejected("not_linked"));
    assert.equal(accountCount(app), 0);
  }
});

test("provider sign-up has the same rate limit, daily capacity and per-address cap as sign-up with a password", async (t) => {
  const { app, authorize, setClaims } = await hosted(t, { PURSS_SIGNUP_DAILY_LIMIT: "2" });
  const flow = async (sub: string, address: string) => {
    setClaims({ sub, email: `${sub}@example.org`, email_verified: true });
    return finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, `b-${sub}`)), caller(`b-${sub}`, {}, address));
  };
  // Per address: 30 attempts an hour (shared with /api/signup).
  const busy = freshAddress();
  for (let i = 0; i < 30; i++) assert.equal(consumeRateLimit(`signup:${busy}`, 30, 60 * 60_000).allowed, true);
  await assert.rejects(flow("rate", busy), rejected("signup_rate_limited"));
  assert.equal(accountCount(app), 0);

  // Ten accounts an hour from one address.
  const crowded = freshAddress();
  const hash = sha256(`${app.serviceToken}\0signup-address\0${crowded}`);
  for (let i = 0; i < 10; i++) {
    app.db.run("INSERT INTO accounts (id, created_at) VALUES (?, ?)", `acc_crowd_${i}`, nowIso());
    app.db.run("INSERT INTO signup_creations (account_id, address_hash, created_at) VALUES (?, ?, ?)", `acc_crowd_${i}`, hash, nowIso());
  }
  const crowd = accountCount(app);
  await assert.rejects(flow("crowd", crowded), rejected("signup_full"));
  assert.equal(accountCount(app), crowd);

  // The installation's day: two accounts, counted whichever way they were made.
  const one = await flow("day-1", freshAddress());
  assert.equal(one.created, true);
  app.db.run("INSERT INTO audit_events (id, at, actor_account_id, action, target, outcome, detail) VALUES ('aud_earlier', ?, NULL, 'signup', NULL, 'success', NULL)", nowIso());
  await assert.rejects(flow("day-2", freshAddress()), rejected("signup_full"));
  assert.equal(app.db.get("SELECT 1 FROM sign_in_methods WHERE subject = 'day-2'"), undefined);
  // A known identity still signs in when the day is full.
  assert.deepEqual([(await flow("day-1", freshAddress())).accountId, accountCount(app)], [one.accountId, crowd + 1]);
});

test("a daily cap of zero pauses provider sign-up too", async (t) => {
  const { app, authorize, setClaims } = await hosted(t, { PURSS_SIGNUP_DAILY_LIMIT: "0" });
  setClaims({ sub: "g-paused", email: "paused@example.org", email_verified: true });
  await assert.rejects(finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b")), caller("b")), rejected("signup_full"));
  assert.equal(accountCount(app), 0);
});

// ---------- confirm it's you ----------

/** An account that signed up with the provider, with a session whose sign-in is `authAgeSeconds` old. */
async function providerOnly(app: App, iss: Issuer, sub = "g-step", authAgeSeconds = 3600) {
  iss.setClaims({ sub, email: `${sub}@example.org`, email_verified: true, name: "Step Up" });
  const made = await signInWith(app, iss, caller(`b-${sub}`));
  const session = signIn(app, made.accountId, { authAgeSeconds });
  return { accountId: made.accountId, session, sessionId: sessionIdOf(session) };
}
const recentAt = (app: App, sessionId: string) => app.db.get<{ auth_at: string }>("SELECT auth_at FROM sessions WHERE id = ?", sessionId)!.auth_at;
const isStale = (app: App, sessionId: string) => Date.now() - Date.parse(recentAt(app, sessionId)) > 10 * 60_000;

test("step-up with a provider asks it to sign the person in again and refreshes only the session that asked", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const otherSession = signIn(app, who.accountId, { authAgeSeconds: 3600 });
  const otherId = sessionIdOf(otherSession);
  assert.equal(isStale(app, who.sessionId), true);

  const url = new URL(await startOidc(app, "mock", "stepup", who.accountId, "b-up", { sessionId: who.sessionId }));
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.equal(url.searchParams.get("max_age"), "0");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  const callback = await authorize(url.href);

  // Another session of the same account can't finish it (the state is spent by the attempt); it stays unconfirmed.
  await assert.rejects(finishOidc(app, "mock", callback, caller("b-up", { accountId: who.accountId, sessionId: otherId })), rejected("signed_out"));
  await assert.rejects(finishOidc(app, "mock", callback, caller("b-up", { accountId: who.accountId, sessionId: who.sessionId })), rejected("expired"), "and it can't be retried");
  assert.equal(isStale(app, who.sessionId), true);
  assert.equal(isStale(app, otherId), true);
  const noBinder = await authorize(await startOidc(app, "mock", "stepup", who.accountId, "b-up3", { sessionId: who.sessionId }));
  await assert.rejects(finishOidc(app, "mock", noBinder, caller("someone-elses-binder", { accountId: who.accountId, sessionId: who.sessionId })), rejected("mismatch"));
  const signedOut = await authorize(await startOidc(app, "mock", "stepup", who.accountId, "b-up4", { sessionId: who.sessionId }));
  await assert.rejects(finishOidc(app, "mock", signedOut, caller("b-up4")), rejected("mismatch"));
  assert.equal(isStale(app, who.sessionId), true);

  const ok = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "stepup", who.accountId, "b-ok", { sessionId: who.sessionId })), caller("b-ok", { accountId: who.accountId, sessionId: who.sessionId }));
  assert.deepEqual(ok, { purpose: "stepup", accountId: who.accountId, sharedComputer: false, created: false, viaApp: false });
  assert.equal(isStale(app, who.sessionId), false, "the session that asked is recently authenticated");
  assert.equal(isStale(app, otherId), true, "the account's other session is not");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'oidc_step_up' AND outcome = 'success'")!.n, 1);
});

test("step-up refuses another identity, one that was never linked, and a stale auth_time", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const step = async (claims: Claims, binder: string) => {
    setClaims(claims);
    return finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "stepup", who.accountId, binder, { sessionId: who.sessionId })), caller(binder, { accountId: who.accountId, sessionId: who.sessionId }));
  };
  const long = { sub: "g-step", email: "g-step@example.org", email_verified: true };
  // Another Google account signs in at the provider: it isn't the one linked to this account.
  await assert.rejects(step({ ...long, sub: "someone-else" }, "b1"), rejected("wrong_account"));
  // The provider says the person last signed in an hour ago: it didn't ask again.
  await assert.rejects(step({ ...long, auth_time: Math.floor(Date.now() / 1000) - 3600 }, "b2"), rejected("stale_auth"));
  assert.equal(isStale(app, who.sessionId), true, "none of those confirmed anything");
  // A sign-in that just happened (clock differences allowed) is accepted, and so is a provider that doesn't say when.
  assert.equal((await step({ ...long, auth_time: Math.floor(Date.now() / 1000) - 30 }, "b3")).purpose, "stepup");
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", addSeconds(-3600), who.sessionId);
  assert.equal((await step(long, "b4")).purpose, "stepup");
  assert.equal(isStale(app, who.sessionId), false);

  // An account without this provider linked can't start it.
  const stranger = makeOwner(app, { admin: false });
  await assert.rejects(startOidc(app, "mock", "stepup", stranger.accountId, "b5", { sessionId: "x" }), rejected("not_linked"));
  await assert.rejects(startOidc(app, "mock", "stepup", null, "b6"), rejected("not_linked"));
});

test("a provider that can't be made to ask again is sent the account chooser instead and its old auth_time is not held against it", async (t) => {
  const { app, authorize, setClaims } = await hosted(t, {}, { stepUp: "choose-account" });
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const url = new URL(await startOidc(app, "mock", "stepup", who.accountId, "b1", { sessionId: who.sessionId }));
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("max_age"), null);
  setClaims({ sub: "g-step", email: "g-step@example.org", email_verified: true, auth_time: Math.floor(Date.now() / 1000) - 7200 });
  const out = await finishOidc(app, "mock", await authorize(url.href), caller("b1", { accountId: who.accountId, sessionId: who.sessionId }));
  assert.equal(out.purpose, "stepup");
  assert.equal(isStale(app, who.sessionId), false);
});

test("a connected app confirms with a provider through a single-use ticket and the system browser", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const phone = createDeviceToken(app, who.accountId, "mobile", "Phone", "connect");
  const deviceRow = app.db.get<{ id: string }>("SELECT id FROM device_tokens WHERE account_id = ?", who.accountId)!;
  const deviceSession = `${DEVICE_SESSION_PREFIX}${deviceRow.id}`;
  app.db.run("UPDATE device_tokens SET auth_at = ? WHERE id = ?", addSeconds(-3600), deviceRow.id);
  const authAt = () => app.db.get<{ auth_at: string }>("SELECT auth_at FROM device_tokens WHERE id = ?", deviceRow.id)!.auth_at;
  assert.ok(phone.secret);

  const ticketUrl = new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession));
  const ticket = ticketUrl.searchParams.get("ticket")!;
  // The system browser opens it: no session there, only the binder it is given.
  const providerUrl = await startFromTicket(app, "mock", ticket, "app-binder");
  await assert.rejects(startFromTicket(app, "mock", ticket, "again"), rejected("expired"), "a ticket works once");
  const callback = await authorize(providerUrl);
  await assert.rejects(finishOidc(app, "mock", callback, caller("not-the-binder")), rejected("mismatch"));
  assert.ok(Date.now() - Date.parse(authAt()) > 10 * 60_000, "a callback in another browser confirmed nothing");

  const second = await startFromTicket(app, "mock", new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession)).searchParams.get("ticket")!, "app-binder");
  setClaims({ sub: "intruder", email: "i@example.org", email_verified: true });
  await assert.rejects(finishOidc(app, "mock", await authorize(second), caller("app-binder")), rejected("wrong_account"));
  setClaims({ sub: "g-step", email: "g-step@example.org", email_verified: true });
  const third = await startFromTicket(app, "mock", new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession)).searchParams.get("ticket")!, "app-binder");
  const out = await finishOidc(app, "mock", await authorize(third), caller("app-binder"));
  assert.deepEqual(out, { purpose: "stepup", accountId: who.accountId, sharedComputer: false, created: false, viaApp: true });
  assert.ok(Date.now() - Date.parse(authAt()) < 60_000, "the app's connection is recently authenticated");

  // A browser session can't be given a ticket, and an expired or foreign one starts nothing.
  assert.throws(() => issueAppTicket(app, "mock", "stepup", who.accountId, who.sessionId), rejected("not_device"));
  const old = new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession)).searchParams.get("ticket")!;
  app.db.run("UPDATE auth_challenges SET expires_at = ? WHERE id = ?", addSeconds(-1), `oidc-ticket:${sha256(old)}`);
  await assert.rejects(startFromTicket(app, "mock", old, "b"), rejected("expired"));
  await assert.rejects(startFromTicket(app, "mock", "no-such-ticket", "b"), rejected("expired"));
  // The ticket was issued for one provider.
  const mine = new URL(issueAppTicket(app, "mock", "link", who.accountId, deviceSession)).searchParams.get("ticket")!;
  await assert.rejects(startFromTicket(app, "other", mine, "b"), rejected("expired"));
  assert.throws(() => issueAppTicket(app, "mock", "stepup", makeOwner(app, { admin: false }).accountId, deviceSession), rejected("not_linked"));
});

// ---------- over HTTP ----------

async function boot(t: test.TestContext, env: Record<string, string> = {}, providerExtra: Record<string, unknown> = {}) {
  const iss = await issuer(t);
  const b = await bootDeletion({ ...HOSTED, PURSS_OIDC: provider(iss.url, providerExtra), ...env });
  useTransport(b.app, { send: async () => {}, verify: async () => {} });
  await checkMail(b.app);
  t.after(async () => { await b.close(); });
  return { b, ...iss };
}

/** What the browser does: start, the provider, the callback. Returns the callback's answer and the session it started, if any. */
async function browse(b: DeletionBoot, iss: Pick<Issuer, "authorize">, query: string, opts: { session?: TestSession; address?: string; cookieAs?: TestSession } = {}) {
  const started = await fetch(`${b.base}/api/auth/oidc/mock/start${query}`, { redirect: "manual", headers: opts.session ? { cookie: opts.session.cookie } : {} });
  if (started.status !== 302) return { started, answer: null, session: null as TestSession | null };
  const binder = setCookie(started, "purss_oidc")!.pair;
  const next = setCookie(started, "purss_oidc_next")?.pair;
  const callback = await iss.authorize(started.headers.get("location")!);
  const cookies = [binder, next, (opts.cookieAs ?? opts.session)?.cookie].filter(Boolean).join("; ");
  const answer = await fetch(b.base + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: cookies, "x-forwarded-for": opts.address ?? freshAddress() } });
  const pair = setCookie(answer, "purss_session")?.pair;
  let session: TestSession | null = null;
  if (pair) {
    const info = (await b.api({ cookie: pair, csrf: "" }, "GET", "/api/session")).json;
    session = { cookie: pair, csrf: info.csrf };
  }
  return { started, answer, session };
}

test("over HTTP: a provider creates an account and its session reaches Home; the same identity signs in again", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-http", email: "http@example.org", email_verified: true, name: "Http Reader" });
  const first = await browse(b, { authorize }, "?next=%2Fconnect%3Fclient%3Dmobile");
  assert.equal(first.answer!.status, 302);
  assert.equal(first.answer!.headers.get("location"), "/app/connect?client=mobile", "back to where sign-in was asked for");
  assert.ok(first.session, "a session started");
  const me = (await b.api(first.session, "GET", "/api/session")).json;
  assert.equal(me.state, "signed_in");
  assert.deepEqual([me.account.hasPassword, me.account.hasPasskey, me.account.displayName], [false, false, "Http Reader"]);
  assert.deepEqual(me.account.linkedProviders, [{ id: "mock", label: "Mock ID" }]);
  assert.equal((await b.api(first.session, "GET", "/api/bootstrap")).status, 200, "Home loads");
  assert.equal((await b.api(first.session, "POST", "/api/auth/logout")).status, 200);

  const again = await browse(b, { authorize }, "");
  assert.equal(again.answer!.headers.get("location"), "/app/");
  assert.ok(again.session);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 1, "no second account");
});

test("over HTTP: an existing email is refused with a message that says what to do, and a closed sign-up says not_linked", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  const owner = await member(b.app, "Owner");
  b.app.db.run("UPDATE accounts SET email = 'taken@example.org' WHERE id = ?", owner.accountId);
  setClaims({ sub: "g-taken", email: "TAKEN@example.org", email_verified: true });
  const refused = await browse(b, { authorize }, "");
  assert.equal(refused.answer!.headers.get("location"), "/app/signin?error=email_in_use");
  assert.equal(refused.session, null);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 1);

  const closed = await boot(t, { PURSS_SIGNUP: "invite" });
  closed.setClaims({ sub: "g-closed", email: "new@example.org", email_verified: true });
  const out = await browse(closed.b, closed, "");
  assert.equal(out.answer!.headers.get("location"), "/app/signin?error=not_linked");
  assert.equal(closed.b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 0);
});

test("over HTTP: step-up confirms the sensitive actions of a provider-only account; delete, export and add-a-password all work", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-only", email: "only@example.org", email_verified: true, name: "Only Provider" });
  const made = await browse(b, { authorize }, "");
  const accountId = b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id;
  // The session made by signing in a while ago: nothing sensitive is allowed until it confirms.
  const session = { ...signIn(b.app, accountId, { authAgeSeconds: 3600 }), csrf: "" };
  session.csrf = (await b.api(session, "GET", "/api/session")).json.csrf;
  assert.ok(made.session);
  assert.equal((await b.api(session, "GET", "/api/account/security")).json.recentAuth, false);
  assert.equal((await b.api(session, "POST", "/api/account/deletion", { confirm: "Only Provider" })).json.error.code, "step_up");
  assert.equal((await b.api(session, "PUT", "/api/account/password", { username: "only-provider", password: "a long enough password" })).json.error.code, "step_up");
  // The way out of that for an account with no password and no passkey: the provider, in this browser, in this session.
  const bad = await browse(b, { authorize }, "?stepup=1&next=%2F%3Fdialog%3Dsecurity", { session, cookieAs: { cookie: signIn(b.app, accountId).cookie, csrf: "" } });
  assert.equal(bad.answer!.headers.get("location"), "/app/signin?error=signed_out", "another session can't finish it");
  assert.equal((await b.api(session, "GET", "/api/account/security")).json.recentAuth, false);
  const good = await browse(b, { authorize }, "?stepup=1&next=%2F%3Fdialog%3Dsecurity", { session });
  assert.equal(good.answer!.headers.get("location"), "/app/?dialog=security");
  assert.equal((await b.api(session, "GET", "/api/account/security")).json.recentAuth, true);

  // Add a password without having one, then the rest.
  const added = await b.api(session, "PUT", "/api/account/password", { username: "only-provider", password: "a long enough password" });
  assert.equal(added.status, 200, added.text);
  const methods = (await b.api(session, "GET", "/api/account/security")).json.methods as { id: string; kind: string }[];
  assert.deepEqual(methods.map((m) => m.kind).sort(), ["oidc", "password"]);
  const exported = await b.api(session, "GET", "/api/export");
  assert.equal(exported.status, 200, exported.text);
});

test("over HTTP: a provider-only account exports and deletes itself, and can keep the account by signing in again", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-del", email: "del@example.org", email_verified: true, name: "Del Eter" });
  const made = await browse(b, { authorize }, "");
  assert.ok(made.session);
  const exported = await b.api(made.session, "GET", "/api/export");
  assert.equal(exported.status, 200, exported.text);
  const wrong = await b.api(made.session, "POST", "/api/account/deletion", { confirm: "nope" });
  assert.equal(wrong.json.error.code, "confirm_mismatch");
  const asked = await b.api(made.session, "POST", "/api/account/deletion", { confirm: "Del Eter" });
  assert.equal(asked.status, 200, asked.text);
  assert.ok(asked.json.dueAt);
  // Signing in with the provider during the grace period offers to keep it, as every sign-in does.
  const back = await browse(b, { authorize }, "");
  assert.equal(back.answer!.headers.get("location"), "/app/signin?notice=deletion_pending");
  assert.ok(setCookie(back.answer!, "purss_deletion"));
  assert.equal(back.session, null);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 1, "the same account, not a second one made at the sign-in");
});

test("over HTTP: the last way in can't be unlinked; with a password added the provider can go", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-last", email: "last@example.org", email_verified: true });
  const made = await browse(b, { authorize }, "");
  const session = made.session!;
  const methods = async () => (await b.api(session, "GET", "/api/account/security")).json.methods as { id: string; kind: string }[];
  const oidc = (await methods()).find((m) => m.kind === "oidc")!;
  const refused = await b.api(session, "DELETE", `/api/account/methods/${oidc.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "last_method");
  assert.equal((await methods()).length, 1);
  assert.equal((await b.api(session, "PUT", "/api/account/password", { username: "last-way", password: "a long enough password" })).status, 200);
  assert.equal((await b.api(session, "DELETE", `/api/account/methods/${oidc.id}`)).status, 200);
  assert.deepEqual((await methods()).map((m) => m.kind), ["password"]);
});

test("over HTTP: starting step-up or linking needs the right session, and an app asks for a ticket instead", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-routes", email: "routes@example.org", email_verified: true });
  const made = await browse(b, { authorize }, "");
  const accountId = b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id;
  const signedOut = await fetch(`${b.base}/api/auth/oidc/mock/start?stepup=1`, { redirect: "manual" });
  assert.equal(signedOut.status, 401);
  // A linked provider that isn't this account's.
  const otherAccount = await member(b.app, "Other");
  const otherSession = signIn(b.app, otherAccount.accountId);
  assert.equal((await fetch(`${b.base}/api/auth/oidc/mock/start?stepup=1`, { redirect: "manual", headers: { cookie: otherSession.cookie } })).status, 409);
  assert.ok(made.session);

  // Browsers don't get tickets; connected apps do, and a link needs a recent sign-in first.
  assert.equal((await b.api(made.session, "POST", "/api/auth/oidc/mock/ticket", { purpose: "stepup" })).status, 400);
  const phone = createDeviceToken(b.app, accountId, "mobile", "Phone", "connect");
  const asApp = (method: string, path: string, body?: unknown) => call(b.app, b.base, method, path, null, body, { headers: { authorization: `Bearer ${phone.secret}` } });
  const ticket = await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "stepup" });
  assert.equal(ticket.status, 200, ticket.text);
  assert.match(ticket.json.url, /\/api\/auth\/oidc\/mock\/start\?ticket=/);
  // The system browser follows it; the callback ends on a page for the person to go back to the app (no redirect into PURSS).
  b.app.db.run("UPDATE device_tokens SET auth_at = ? WHERE account_id = ?", addSeconds(-3600), accountId);
  assert.equal((await asApp("GET", "/api/account/security")).json.recentAuth, false);
  const browserStart = await fetch(b.base + new URL(ticket.json.url).pathname + new URL(ticket.json.url).search, { redirect: "manual" });
  assert.equal(browserStart.status, 302);
  const callback = await authorize(browserStart.headers.get("location")!);
  const done = await fetch(b.base + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: setCookie(browserStart, "purss_oidc")!.pair, "x-forwarded-for": freshAddress() } });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Go back to the PURSS app/);
  assert.equal((await asApp("GET", "/api/account/security")).json.recentAuth, true, "the app asks and finds itself confirmed");
  const replay = await fetch(b.base + new URL(ticket.json.url).pathname + new URL(ticket.json.url).search, { redirect: "manual" });
  assert.equal(replay.status, 400, "the ticket was spent");
  // Linking from an app needs recent authentication at the start, like the browser's link.
  b.app.db.run("UPDATE device_tokens SET auth_at = ? WHERE account_id = ?", addSeconds(-3600), accountId);
  assert.equal((await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link" })).json.error.code, "step_up");
});
