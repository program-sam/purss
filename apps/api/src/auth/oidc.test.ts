import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Server } from "oauth2-mock-server";
import { makeOwner, makeTestApp } from "../testing.ts";
import { call, signIn } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { bootDeletion, member, setCookie } from "../deletion-testing.ts";
import type { DeletionBoot } from "../deletion-testing.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import { OidcFlowError, finishOidc, issueAppTicket, redeemLinkCode, startFromTicket, startOidc } from "./oidc.ts";
import { canConfirm, linkedProviders } from "./providers.ts";
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

/** An ID token's auth_time for "the person just signed in again". */
const authNow = () => Math.floor(Date.now() / 1000);

let addresses = 0;
/** A fresh client address, so one test's sign-up attempts never count against another's. */
const freshAddress = () => `198.51.100.${++addresses}`;
const caller = (binder: string, who: { accountId?: string; sessionId?: string } = {}, address = freshAddress()): OidcCaller => ({ binder, accountId: who.accountId ?? null, sessionId: who.sessionId ?? null, address });
const sessionIdOf = (s: TestSession) => sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(s.cookie)![1]!));

/** A hosted installation with open sign-up (it needs working outgoing email), without a listener. */
async function hosted(t: test.TestContext, env: Record<string, string> = {}, providerExtra: Record<string, unknown> = {}, issuerSuffix = "") {
  const iss = await issuer(t);
  const made = makeTestApp({ ...HOSTED, PURSS_OIDC: provider(iss.url + issuerSuffix, providerExtra), ...env });
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
  assert.deepEqual(linked, { purpose: "link", accountId: owner.accountId, sharedComputer: false, created: false, viaApp: false, appFlow: false, linkCode: null });
  assert.ok(app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'user-123' AND account_id = ?", owner.accountId));

  const out = await signInWith(app, iss, caller("binder-signin"));
  assert.deepEqual(out, { purpose: "signin", accountId: owner.accountId, sharedComputer: false, created: false, viaApp: false, appFlow: false, linkCode: null });
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

test("an email another account has confirmed is neither linked nor duplicated; one only typed in doesn't count", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const typed = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET email = 'Ana@Example.org', email_verified_at = NULL WHERE id = ?", typed.accountId);
  const confirmed = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET email = 'bo@example.org', email_verified_at = ? WHERE id = ?", nowIso(), confirmed.accountId);
  const before = accountCount(app);
  for (const [sub, email] of [["u1", "bo@example.org"], ["u2", "BO@EXAMPLE.ORG"]] as const) {
    setClaims({ sub, email, email_verified: true });
    await assert.rejects(finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, `b-${sub}`)), caller(`b-${sub}`)),
      (e: unknown) => e instanceof HttpError && e.code === "email_in_use" && /username and password/.test(e.message) && /connect Mock ID in Settings → Security/.test(e.message));
  }
  assert.equal(accountCount(app), before, "no second account");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc'")!.n, 0, "and nothing linked");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM signup_creations")!.n, 0, "no capacity used");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'oidc' AND detail = 'email in use'")!.n, 2, "each refusal is recorded");

  // The address on the first account was never confirmed: the provider, which vouched for it, may make its own account.
  setClaims({ sub: "u3", email: "ana@example.org", email_verified: true });
  const made = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "signin", null, "b-u3")), caller("b-u3"));
  assert.equal(made.created, true);
  assert.equal(accountCount(app), before + 1);
  assert.equal(app.db.get<{ email_verified_at: string | null }>("SELECT email_verified_at FROM accounts WHERE id = ?", typed.accountId)!.email_verified_at, null, "and the unconfirmed one is left as it was");
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
  iss.setClaims({ sub, email: `${sub}@example.org`, email_verified: true, name: "Step Up", auth_time: authNow() });
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
  assert.deepEqual(ok, { purpose: "stepup", accountId: who.accountId, sharedComputer: false, created: false, viaApp: false, appFlow: false, linkCode: null });
  assert.equal(isStale(app, who.sessionId), false, "the session that asked is recently authenticated");
  assert.equal(isStale(app, otherId), true, "the account's other session is not");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'oidc_step_up' AND outcome = 'success'")!.n, 1);
});

test("step-up refuses another identity, one that was never linked, and a stale or missing auth_time", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const step = async (claims: Claims, binder: string) => {
    setClaims(claims);
    return finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "stepup", who.accountId, binder, { sessionId: who.sessionId })), caller(binder, { accountId: who.accountId, sessionId: who.sessionId }));
  };
  const long = { sub: "g-step", email: "g-step@example.org", email_verified: true };
  // Another Google account signs in at the provider: it isn't the one linked to this account.
  await assert.rejects(step({ ...long, sub: "someone-else", auth_time: authNow() }, "b1"), rejected("wrong_account"));
  // The provider says the person last signed in an hour ago: it didn't ask again.
  await assert.rejects(step({ ...long, auth_time: authNow() - 3600 }, "b2"), rejected("stale_auth"));
  // A provider asked to re-authenticate that doesn't say when it did, proves nothing.
  await assert.rejects(step(long, "b2b"), rejected("stale_auth"));
  assert.equal(isStale(app, who.sessionId), true, "none of those confirmed anything");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'oidc_step_up' AND detail = 'no auth_time'")!.n, 1);
  // A sign-in that just happened (clock differences allowed) is accepted.
  assert.equal((await step({ ...long, auth_time: authNow() - 30 }, "b3")).purpose, "stepup");
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
  setClaims({ sub: "g-step", email: "g-step@example.org", email_verified: true, auth_time: authNow() });
  const third = await startFromTicket(app, "mock", new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession)).searchParams.get("ticket")!, "app-binder");
  const out = await finishOidc(app, "mock", await authorize(third), caller("app-binder"));
  assert.deepEqual(out, { purpose: "stepup", accountId: who.accountId, sharedComputer: false, created: false, viaApp: true, appFlow: true, linkCode: null });
  assert.ok(Date.now() - Date.parse(authAt()) < 60_000, "the app's connection is recently authenticated");

  // A browser session can't be given a ticket, and an expired or foreign one starts nothing.
  assert.throws(() => issueAppTicket(app, "mock", "stepup", who.accountId, who.sessionId), rejected("not_device"));
  const old = new URL(issueAppTicket(app, "mock", "stepup", who.accountId, deviceSession)).searchParams.get("ticket")!;
  app.db.run("UPDATE auth_challenges SET expires_at = ? WHERE id = ?", addSeconds(-1), `oidc-ticket:${sha256(old)}`);
  await assert.rejects(startFromTicket(app, "mock", old, "b"), rejected("expired"));
  await assert.rejects(startFromTicket(app, "mock", "no-such-ticket", "b"), rejected("expired"));
  // The ticket was issued for one provider.
  const mine = new URL(issueAppTicket(app, "mock", "link", who.accountId, deviceSession, { challenge: "A".repeat(43), state: "S".repeat(22) })).searchParams.get("ticket")!;
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
  assert.deepEqual(me.account.linkedProviders, [{ id: "mock", label: "Mock ID", canConfirm: true }]);
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
  b.app.db.run("UPDATE accounts SET email = 'taken@example.org', email_verified_at = ? WHERE id = ?", nowIso(), owner.accountId);
  setClaims({ sub: "g-taken", email: "TAKEN@example.org", email_verified: true });
  const refused = await browse(b, { authorize }, "");
  assert.equal(refused.answer!.headers.get("location"), "/app/signin?error=email_in_use&provider=mock");
  assert.equal(refused.session, null);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 1);

  const closed = await boot(t, { PURSS_SIGNUP: "invite" });
  closed.setClaims({ sub: "g-closed", email: "new@example.org", email_verified: true });
  const out = await browse(closed.b, closed, "");
  assert.equal(out.answer!.headers.get("location"), "/app/signin?error=not_linked&provider=mock");
  assert.equal(closed.b.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 0);
});

test("over HTTP: step-up confirms the sensitive actions of a provider-only account; delete, export and add-a-password all work", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-only", email: "only@example.org", email_verified: true, name: "Only Provider", auth_time: authNow() });
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
  assert.equal(bad.answer!.headers.get("location"), "/app/signin?error=signed_out&provider=mock", "another session can't finish it");
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
  setClaims({ sub: "g-routes", email: "routes@example.org", email_verified: true, auth_time: authNow() });
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
  assert.match(replay.headers.get("content-type") ?? "", /text\/html/, "and said as a page for the app, not as JSON");
  assert.match(await replay.text(), /Go back to the PURSS app/);
  // Linking from an app needs recent authentication at the start, like the browser's link.
  b.app.db.run("UPDATE device_tokens SET auth_at = ? WHERE account_id = ?", addSeconds(-3600), accountId);
  assert.equal((await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link" })).json.error.code, "step_up");
});

// ---------- an app's link ----------

/** What an app keeps for one link: a verifier only it holds, its S256 challenge and a state. */
function linkPair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(16).toString("base64url") };
}
const appSessionOf = (app: App, accountId: string): string => {
  createDeviceToken(app, accountId, "mobile", "Phone", "connect");
  return `${DEVICE_SESSION_PREFIX}${app.db.get<{ id: string }>("SELECT id FROM device_tokens WHERE account_id = ? ORDER BY created_at DESC", accountId)!.id}`;
};
const oidcRows = (app: App, subject: string) => app.db.get<{ n: number }>("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc' AND subject = ?", subject)!.n;

test("an app's provider link is never made in the browser: the app redeems a code with its own token and verifier", async (t) => {
  const { app, authorize, setClaims } = await hosted(t);
  const attacker = makeOwner(app, { admin: false });
  const attackerApp = appSessionOf(app, attacker.accountId);
  const bystander = makeOwner(app, { admin: false });
  const bystanderApp = appSessionOf(app, bystander.accountId);
  const victim: Claims = { sub: "victim-google", email: "victim@example.org", email_verified: true, name: "Victim" };
  /** The attacker's app asks to link and hands the address to someone, who signs in at the provider in their own browser. */
  const handedOver = async (pair = linkPair()) => {
    const ticket = new URL(issueAppTicket(app, "mock", "link", attacker.accountId, attackerApp, pair)).searchParams.get("ticket")!;
    const providerUrl = await startFromTicket(app, "mock", ticket, "victim-browser");
    setClaims(victim);
    return { pair, out: await finishOidc(app, "mock", await authorize(providerUrl), caller("victim-browser")) };
  };

  // The victim's half yields nothing: the identity waits behind a code that goes back to the app, and nothing is linked.
  const { pair, out } = await handedOver();
  assert.equal(out.purpose, "link");
  assert.ok(out.linkCode, "a code for the app");
  assert.equal(out.linkCode.state, pair.state);
  assert.equal(oidcRows(app, "victim-google"), 0, "nothing linked by the browser");
  assert.equal(JSON.stringify(app.db.all("SELECT * FROM auth_challenges")).includes(out.linkCode.code), false, "only the code's hash is kept");
  assert.equal(app.db.get("SELECT 1 FROM audit_events WHERE action = 'oidc_link' AND outcome = 'success'"), undefined);

  // Another account's app can't redeem it, and the code is spent by the attempt.
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: bystander.accountId, sessionId: bystanderApp }, out.linkCode!.code, pair.verifier), rejected("invalid_grant"));
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, out.linkCode!.code, pair.verifier), rejected("invalid_grant"), "spent");
  assert.equal(oidcRows(app, "victim-google"), 0);

  // Without the verifier the app made (nor with another), it fails too.
  const second = await handedOver();
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, second.out.linkCode!.code, linkPair().verifier), rejected("invalid_grant"));
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, second.out.linkCode!.code, second.pair.verifier), rejected("invalid_grant"), "a wrong verifier spends the code");
  const third = await handedOver();
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, third.out.linkCode!.code, ""), rejected("invalid_grant"));

  // A browser session of the same account isn't the app that asked.
  const fourth = await handedOver();
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: sessionIdOf(signIn(app, attacker.accountId)) }, fourth.out.linkCode!.code, fourth.pair.verifier), rejected("invalid_grant"));
  // A code that waited too long is no good either.
  const fifth = await handedOver();
  app.db.run("UPDATE auth_challenges SET expires_at = ? WHERE purpose = 'oidc-link-code'", addSeconds(-1));
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, fifth.out.linkCode!.code, fifth.pair.verifier), rejected("invalid_grant"));
  assert.equal(oidcRows(app, "victim-google"), 0, "none of those linked anything");

  // The app that asked, with its verifier, links what was signed in (here by the person themself, on their own device).
  const sixth = await handedOver();
  redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, sixth.out.linkCode!.code, sixth.pair.verifier);
  assert.deepEqual(app.db.all<{ account_id: string }>("SELECT account_id FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'victim-google'").map((r) => r.account_id), [attacker.accountId]);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE action = 'oidc_link' AND outcome = 'success'")!.n, 1);
  assert.throws(() => redeemLinkCode(app, "mock", { accountId: attacker.accountId, sessionId: attackerApp }, sixth.out.linkCode!.code, sixth.pair.verifier), rejected("invalid_grant"), "a code works once");

  // An identity another account already has is refused in the browser already, as a page for the app.
  const takenBy = makeOwner(app, { admin: false });
  await assert.rejects(async () => {
    const ticket = new URL(issueAppTicket(app, "mock", "link", takenBy.accountId, appSessionOf(app, takenBy.accountId), linkPair())).searchParams.get("ticket")!;
    setClaims(victim);
    await finishOidc(app, "mock", await authorize(await startFromTicket(app, "mock", ticket, "b-taken")), caller("b-taken"));
  }, (e: unknown) => e instanceof OidcFlowError && e.code === "linked_elsewhere");
});

test("an app's link ticket needs the app's own challenge and state", async (t) => {
  const { app } = await hosted(t);
  const owner = makeOwner(app, { admin: false });
  const device = appSessionOf(app, owner.accountId);
  const good = linkPair();
  for (const link of [undefined, { challenge: "", state: good.state }, { challenge: good.challenge, state: "short" }, { challenge: "not base64url!".padEnd(43, "x"), state: good.state }, { challenge: `${good.challenge}x`, state: good.state }]) {
    assert.throws(() => issueAppTicket(app, "mock", "link", owner.accountId, device, link), rejected("bad_request"), JSON.stringify(link));
  }
  assert.match(issueAppTicket(app, "mock", "link", owner.accountId, device, good), /\/start\?ticket=/);
});

// ---------- which accounts a provider may confirm, and issuer addresses ----------

test("a provider that only shows its account chooser confirms an account with no password and no passkey, and no other", async (t) => {
  const { app, authorize, setClaims } = await hosted(t, {}, { stepUp: "choose-account" });
  const iss: Issuer = { authorize, setClaims };
  const who = await providerOnly(app, iss);
  const p = app.config.oidc[0]!;
  assert.equal(canConfirm(app, who.accountId, p), true);
  const attempt = (binder: string) => startOidc(app, "mock", "stepup", who.accountId, binder, { sessionId: who.sessionId });
  await attempt("b0");

  // A passkey: it confirms with that.
  app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, created_at) VALUES ('sim_pk', ?, 'passkey', 'Laptop', 'cred-1', x'01', 0, ?)", who.accountId, nowIso());
  assert.equal(canConfirm(app, who.accountId, p), false);
  await assert.rejects(attempt("b1"), rejected("confirm_another_way"));
  const device = appSessionOf(app, who.accountId);
  assert.throws(() => issueAppTicket(app, "mock", "stepup", who.accountId, device), rejected("confirm_another_way"));
  app.db.run("DELETE FROM sign_in_methods WHERE id = 'sim_pk'");

  // A password: likewise, and one added while the provider's page was open is caught when it comes back.
  const pending = await authorize(await attempt("b2"));
  app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES ('sim_pw', ?, 'password', 'step-up', 'x', ?)", who.accountId, nowIso());
  await assert.rejects(finishOidc(app, "mock", pending, caller("b2", { accountId: who.accountId, sessionId: who.sessionId })), rejected("confirm_another_way"));
  assert.equal(isStale(app, who.sessionId), true, "nothing was confirmed");
  await assert.rejects(attempt("b3"), rejected("confirm_another_way"));
  assert.equal(canConfirm(app, who.accountId, p), false);

  // A provider that does re-authenticate confirms any account that has it linked.
  assert.equal(canConfirm(app, who.accountId, { ...p, stepUp: "reauthenticate" }), true);
});

test("the session says which linked providers may confirm it's you", async (t) => {
  const { b, authorize, setClaims } = await boot(t, {}, { stepUp: "choose-account" });
  setClaims({ sub: "g-flag", email: "flag@example.org", email_verified: true });
  const made = await browse(b, { authorize }, "");
  const linked = async () => (await b.api(made.session, "GET", "/api/session")).json.account.linkedProviders;
  assert.deepEqual(await linked(), [{ id: "mock", label: "Mock ID", canConfirm: true }]);
  assert.equal((await b.api(made.session, "PUT", "/api/account/password", { username: "flagged", password: "a long enough password" })).status, 200);
  assert.deepEqual(await linked(), [{ id: "mock", label: "Mock ID", canConfirm: false }], "a password confirms it instead");
  const refused = await fetch(`${b.base}/api/auth/oidc/mock/start?stepup=1`, { redirect: "manual", headers: { cookie: made.session!.cookie } });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "confirm_another_way");
});

test("a configured issuer written with a trailing slash still matches the issuer stored from its ID tokens", async (t) => {
  const { app, authorize, setClaims } = await hosted(t, {}, {}, "/");
  assert.ok(app.config.oidc[0]!.issuer.endsWith("/"), "kept as configured: discovery wants that form");
  const who = await providerOnly(app, { authorize, setClaims });
  const stored = app.db.get<{ issuer: string }>("SELECT issuer FROM sign_in_methods WHERE account_id = ?", who.accountId)!.issuer;
  assert.equal(stored.endsWith("/"), false, "the token's own spelling is what is stored");
  assert.deepEqual(linkedProviders(app, who.accountId).map((x) => x.id), ["mock"], "so the account's provider is found");
  const out = await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "stepup", who.accountId, "b-slash", { sessionId: who.sessionId })), caller("b-slash", { accountId: who.accountId, sessionId: who.sessionId }));
  assert.equal(out.purpose, "stepup");
  assert.equal(isStale(app, who.sessionId), false);
});

test("a provider can be removed only while a password remains; a passkey isn't a way in on its own, nor is a provider no longer set up", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  setClaims({ sub: "g-removal", email: "removal@example.org", email_verified: true });
  const made = await browse(b, { authorize }, "");
  const session = made.session!;
  const accountId = b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id;
  const methods = async () => (await b.api(session, "GET", "/api/account/security")).json.methods as { id: string; kind: string }[];
  const remove = async (id: string) => b.api(session, "DELETE", `/api/account/methods/${id}`);
  const oidc = (await methods()).find((m) => m.kind === "oidc")!;
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, created_at) VALUES ('sim_pk', ?, 'passkey', 'Laptop', 'cred-1', x'01', 0, ?)", accountId, nowIso());
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES ('sim_gone', ?, 'oidc', 'Gone', 'https://gone.example', 'sub-gone', ?)", accountId, nowIso());

  // A provider and a passkey, no password: the provider can't go.
  const refused = await remove(oidc.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "last_method");
  assert.match(refused.json.error.message, /Add a password first/);
  assert.ok(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE id = ?", oidc.id));
  // The passkey can, while the provider that is still set up here remains; a provider that isn't set up any more is no way in.
  b.app.db.run("DELETE FROM sign_in_methods WHERE id = ?", oidc.id);
  assert.equal((await remove("sim_pk")).json.error.code, "last_method", "only a provider no longer set up is left");
  b.app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES (?, ?, 'oidc', 'Mock ID', ?, 'g-removal', ?)", oidc.id, accountId, b.app.config.oidc[0]!.issuer, nowIso());
  assert.equal((await remove("sim_pk")).status, 200);

  // With a password, any of them can go.
  assert.equal((await b.api(session, "PUT", "/api/account/password", { username: "removal-way", password: "a long enough password" })).status, 200);
  assert.equal((await remove(oidc.id)).status, 200);
  assert.deepEqual((await methods()).map((m) => m.kind).sort(), ["oidc", "password"], "the provider that was gone is still listed; the password stays");
});

// ---------- what an app's browser shows, and what the web sign-in page does ----------

test("a refusal in a flow an app started is a plain page that leads back to the app; the web flows still go to the sign-in page", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  const owner = await member(b.app, "Owner");
  b.app.db.run("UPDATE accounts SET email = 'taken@example.org', email_verified_at = ? WHERE id = ?", nowIso(), owner.accountId);
  setClaims({ sub: "g-page", email: "taken@example.org", email_verified: true, name: "Page" });
  const connect = (client: string) => `?next=${encodeURIComponent(`/connect?client=${client}&state=s&code_challenge=c`)}`;

  // The phone or desktop app's own "Continue with Google" (it ends on /connect for client=mobile).
  const fromApp = await browse(b, { authorize }, connect("mobile"));
  assert.equal(fromApp.answer!.status, 409);
  assert.match(fromApp.answer!.headers.get("content-type") ?? "", /text\/html/);
  const page = await fromApp.answer!.text();
  assert.match(page, /An account with this email address already exists/);
  assert.match(page, /Go back to the PURSS app/);
  assert.equal(fromApp.answer!.headers.get("location"), null, "no redirect to the web sign-in page");
  // The browser extension, a web sign-in, a link: the web page says it.
  for (const query of [connect("extension"), "", "?next=%2Fconnect%3Fclient%3Dmobilefake"]) {
    const web = await browse(b, { authorize }, query);
    assert.equal(web.answer!.headers.get("location"), "/app/signin?error=email_in_use&provider=mock", query);
  }

  // An account that can't sign in (suspended) is refused as a page too, in the app's flow, and as the sign-in page on the web.
  setClaims({ sub: "g-suspended", email: "suspended@example.org", email_verified: true, name: "Suspended", auth_time: authNow() });
  await browse(b, { authorize }, "");
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE display_name = 'Suspended'");
  const suspendedApp = await browse(b, { authorize }, connect("mobile"));
  assert.equal(suspendedApp.answer!.status, 403);
  assert.match(await suspendedApp.answer!.text(), /suspended[\s\S]*Go back to the PURSS app/);
  assert.equal((await browse(b, { authorize }, "")).answer!.headers.get("location"), "/app/signin?error=suspended&provider=mock");

  // An app's ticket: a spent one, and an identity that isn't the account's, say so as pages too.
  setClaims({ sub: "g-page", email: "page@example.org", email_verified: true, name: "Page", auth_time: authNow() });
  const made = await browse(b, { authorize }, "");
  const accountId = b.app.db.get<{ id: string }>("SELECT id FROM accounts WHERE display_name = 'Page'")!.id;
  const phone = createDeviceToken(b.app, accountId, "mobile", "Phone", "connect");
  const ticket = async () => (await call(b.app, b.base, "POST", "/api/auth/oidc/mock/ticket", null, { purpose: "stepup" }, { headers: { authorization: `Bearer ${phone.secret}` } })).json.url as string;
  assert.ok(made.session);
  const first = await ticket();
  const open = (url: string) => fetch(b.base + new URL(url).pathname + new URL(url).search, { redirect: "manual" });
  const started = await open(first);
  assert.equal(started.status, 302);
  assert.equal((await open(first)).status, 400);
  assert.match(await (await open(first)).text(), /<h1[^>]*>That didn&#39;t work<\/h1>[\s\S]*Go back to the PURSS app/);

  setClaims({ sub: "someone-else", email: "else@example.org", email_verified: true, auth_time: authNow() });
  const second = await open(await ticket());
  const callback = await authorize(second.headers.get("location")!);
  const wrong = await fetch(b.base + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: setCookie(second, "purss_oidc")!.pair, "x-forwarded-for": freshAddress() } });
  assert.equal(wrong.status, 403);
  assert.match(await wrong.text(), /isn&#39;t the one connected[\s\S]*Go back to the PURSS app/);
});

test("an app's link ends on a page that sends the code to purss://connect, and links only when the app redeems it", async (t) => {
  const { b, authorize, setClaims } = await boot(t);
  const dana = await member(b.app, "Dana");
  const phone = createDeviceToken(b.app, dana.accountId, "mobile", "Phone", "connect");
  const asApp = (method: string, path: string, body?: unknown, token = phone.secret) => call(b.app, b.base, method, path, null, body, { headers: { authorization: `Bearer ${token}` } });
  const pair = linkPair();
  assert.equal((await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link" })).json.error.code, "bad_request", "the app's challenge and state are required");
  const ticket = await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link", codeChallenge: pair.challenge, state: pair.state });
  assert.equal(ticket.status, 200, ticket.text);

  // Whoever opens the address in a browser signs in at the provider; the page sends the code back to the app.
  setClaims({ sub: "g-app-link", email: "link@example.org", email_verified: true });
  const started = await fetch(b.base + new URL(ticket.json.url).pathname + new URL(ticket.json.url).search, { redirect: "manual" });
  const callback = await authorize(started.headers.get("location")!);
  const done = await fetch(b.base + callback.pathname + callback.search, { redirect: "manual", headers: { cookie: setCookie(started, "purss_oidc")!.pair, "x-forwarded-for": freshAddress() } });
  assert.equal(done.status, 200);
  const html = await done.text();
  const href = /<meta http-equiv="refresh" content="0;url=(purss:\/\/connect\?[^"]+)">/.exec(html)?.[1];
  assert.ok(href, "the page goes back to the app");
  const back = new URL(href.replaceAll("&amp;", "&"));
  assert.deepEqual([back.protocol, back.host, back.searchParams.get("state"), back.searchParams.get("iss")], ["purss:", "connect", pair.state, b.app.config.publicOrigin]);
  assert.match(html, /<a href="purss:\/\/connect\?[^"]+">Go back to the PURSS app<\/a>/, "and offers the link if the browser doesn't follow it");
  const code = back.searchParams.get("link_code")!;
  assert.equal(oidcRows(b.app, "g-app-link"), 0, "the browser linked nothing");

  // The app redeems it: not with another account's token, not without its verifier; then it is linked.
  const other = await member(b.app, "Other");
  const otherPhone = createDeviceToken(b.app, other.accountId, "mobile", "Phone", "connect");
  const redeem = (token: string, verifier: string) => asApp("POST", "/api/auth/oidc/mock/link", { code, codeVerifier: verifier }, token);
  assert.equal((await redeem(otherPhone.secret, pair.verifier)).json.error.code, "invalid_grant");
  assert.equal((await redeem(phone.secret, pair.verifier)).json.error.code, "invalid_grant", "that attempt spent the code");
  assert.equal(oidcRows(b.app, "g-app-link"), 0);
  const again = await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link", codeChallenge: pair.challenge, state: pair.state });
  const started2 = await fetch(b.base + new URL(again.json.url).pathname + new URL(again.json.url).search, { redirect: "manual" });
  const callback2 = await authorize(started2.headers.get("location")!);
  const done2 = await fetch(b.base + callback2.pathname + callback2.search, { redirect: "manual", headers: { cookie: setCookie(started2, "purss_oidc")!.pair, "x-forwarded-for": freshAddress() } });
  const code2 = new URL(/url=(purss:\/\/connect\?[^"]+)"/.exec(await done2.text())![1]!.replaceAll("&amp;", "&")).searchParams.get("link_code")!;
  assert.equal((await asApp("POST", "/api/auth/oidc/mock/link", { code: code2, codeVerifier: linkPair().verifier })).status, 400, "a wrong verifier");
  assert.equal((await asApp("POST", "/api/auth/oidc/mock/link", { code: code2, codeVerifier: pair.verifier })).status, 400, "and it spent the code");
  assert.equal(oidcRows(b.app, "g-app-link"), 0);

  const third = await asApp("POST", "/api/auth/oidc/mock/ticket", { purpose: "link", codeChallenge: pair.challenge, state: pair.state });
  const started3 = await fetch(b.base + new URL(third.json.url).pathname + new URL(third.json.url).search, { redirect: "manual" });
  const callback3 = await authorize(started3.headers.get("location")!);
  const done3 = await fetch(b.base + callback3.pathname + callback3.search, { redirect: "manual", headers: { cookie: setCookie(started3, "purss_oidc")!.pair, "x-forwarded-for": freshAddress() } });
  const code3 = new URL(/url=(purss:\/\/connect\?[^"]+)"/.exec(await done3.text())![1]!.replaceAll("&amp;", "&")).searchParams.get("link_code")!;
  const linked = await asApp("POST", "/api/auth/oidc/mock/link", { code: code3, codeVerifier: pair.verifier });
  assert.equal(linked.status, 200, linked.text);
  assert.equal(oidcRows(b.app, "g-app-link"), 1);
  const security = (await asApp("GET", "/api/account/security")).json.methods as { kind: string; label: string }[];
  assert.ok(security.some((m) => m.kind === "oidc" && m.label === "Mock ID"));
  // Browsers have no use for it.
  const session = signIn(b.app, dana.accountId);
  assert.equal((await b.api({ ...session, csrf: (await b.api(session, "GET", "/api/session")).json.csrf }, "POST", "/api/auth/oidc/mock/link", { code: code3, codeVerifier: pair.verifier })).status, 400);
});

test("each flow's return address is its own: one that starts without next clears what an earlier one left", async (t) => {
  const { b } = await boot(t);
  const start = (query: string) => fetch(`${b.base}/api/auth/oidc/mock/start${query}`, { redirect: "manual" });
  const withNext = await start("?next=%2Fconnect%3Fclient%3Dmobile");
  assert.match(setCookie(withNext, "purss_oidc_next")!.header, /^purss_oidc_next=%2Fconnect%3Fclient%3Dmobile;.*Max-Age=600/);
  const without = await start("");
  const cleared = setCookie(without, "purss_oidc_next");
  assert.ok(cleared, "the cookie is set again, empty");
  assert.match(cleared.header, /^purss_oidc_next=;.*Max-Age=0/);
});
