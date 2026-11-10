import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Server } from "oauth2-mock-server";
import { makeOwner, makeTestApp } from "../testing.ts";
import { signedInPrincipal } from "../features-testing.ts";
import { finishOidc, startOidc } from "./oidc.ts";
import { addSeconds, HttpError } from "../http.ts";
import { signIn } from "../features-testing.ts";
import { sha256 } from "../secrets.ts";

/** Drives the real openid-client flow against a local OIDC issuer (code + PKCE + state + nonce). */
async function setup(t: test.TestContext) {
  const server = new OAuth2Server();
  await server.issuer.keys.generate("RS256");
  await server.start(0, "127.0.0.1");
  const issuer = server.issuer.url!;
  const { app, cleanup } = makeTestApp({ PURSS_OIDC: JSON.stringify([{ id: "mock", label: "Mock ID", issuer, clientId: "purss-test" }]) });
  t.after(async () => { cleanup(); await server.stop(); });
  let sub = "user-123";
  server.service.on("beforeTokenSigning", (token) => { token.payload.sub = sub; });
  /** Follow the authorization redirect the way a browser would, returning the callback URL. */
  const authorize = async (url: string) => {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    assert.ok(location, "the issuer redirects back");
    return new URL(location);
  };
  return { app, authorize, setSub: (s: string) => { sub = s; } };
}

test("OIDC: link while signed in, then sign in with it; binding by issuer + subject", async (t) => {
  const { app, authorize } = await setup(t);
  const owner = makeOwner(app);
  const ownerSession = signIn(app, owner.accountId);
  const ownerSessionId = sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(ownerSession.cookie)![1]!));
  const linkUrl = await startOidc(app, "mock", "link", owner.accountId, "binder-link", { sessionId: ownerSessionId });
  const linked = await finishOidc(app, "mock", await authorize(linkUrl), "binder-link", owner.accountId, ownerSessionId);
  assert.deepEqual(linked, { purpose: "link", accountId: owner.accountId, sharedComputer: false });
  assert.ok(app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'user-123' AND account_id = ?", owner.accountId));

  const signInUrl = await startOidc(app, "mock", "signin", null, "binder-signin");
  const out = await finishOidc(app, "mock", await authorize(signInUrl), "binder-signin", null);
  assert.deepEqual(out, { purpose: "signin", accountId: owner.accountId, sharedComputer: false });
  const sharedUrl = await startOidc(app, "mock", "signin", null, "binder-shared", { sharedComputer: true });
  const shared = await finishOidc(app, "mock", await authorize(sharedUrl), "binder-shared", null);
  assert.equal(shared.sharedComputer, true, "the shared-computer choice survives the OIDC round trip");
});

test("OIDC linking keeps the sign-in fresh at start and rechecks the live session after the provider return", async (t) => {
  const { app, authorize } = await setup(t);
  const owner = makeOwner(app);
  const ownerSession = signIn(app, owner.accountId);
  const sessionId = sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(ownerSession.cookie)![1]!));
  const linkUrl = await startOidc(app, "mock", "link", owner.accountId, "binder-delayed", { sessionId });
  const callback = await authorize(linkUrl);

  // The link route already required recent auth before starting this external flow.
  // The provider may take longer than that freshness window; the callback must still
  // reject a revoked session, but not discard a valid authorization due only to time.
  app.db.run("UPDATE sessions SET auth_at = ? WHERE id = ?", addSeconds(-11 * 60), sessionId);
  const linked = await finishOidc(app, "mock", callback, "binder-delayed", owner.accountId, sessionId);
  assert.deepEqual(linked, { purpose: "link", accountId: owner.accountId, sharedComputer: false });
  assert.ok(app.db.get("SELECT 1 FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'user-123' AND account_id = ?", owner.accountId));
});

test("OIDC: a callback finished in another browser, a replay, or an unlinked identity is refused", async (t) => {
  const { app, authorize, setSub } = await setup(t);
  const owner = makeOwner(app);
  const ownerSession = signIn(app, owner.accountId);
  const ownerSessionId = sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(ownerSession.cookie)![1]!));
  await finishOidc(app, "mock", await authorize(await startOidc(app, "mock", "link", owner.accountId, "b1", { sessionId: ownerSessionId })), "b1", owner.accountId, ownerSessionId);

  // Login CSRF: someone else's callback URL opened in a browser without the binder cookie.
  const stolen = await authorize(await startOidc(app, "mock", "signin", null, "attacker-binder"));
  await assert.rejects(finishOidc(app, "mock", stolen, "victim-has-no-binder", null), (e: unknown) => e instanceof HttpError && e.code === "mismatch");
  // The state was consumed: replaying the callback fails too.
  await assert.rejects(finishOidc(app, "mock", stolen, "attacker-binder", null), (e: unknown) => e instanceof HttpError && e.code === "expired");

  // Linking must finish in the signed-in browser of the same account.
  const other = makeOwner(app, { admin: false });
  const otherSession = signIn(app, other.accountId);
  const otherSessionId = sha256(decodeURIComponent(/purss_session=([^;]+)/.exec(otherSession.cookie)![1]!));
  const linkCb = await authorize(await startOidc(app, "mock", "link", owner.accountId, "b2", { sessionId: ownerSessionId }));
  await assert.rejects(finishOidc(app, "mock", linkCb, "b2", other.accountId, otherSessionId), (e: unknown) => e instanceof HttpError && e.code === "mismatch");

  // An identity nobody linked can't sign in, and no account is created for it.
  setSub("stranger");
  const strangerCb = await authorize(await startOidc(app, "mock", "signin", null, "b3"));
  await assert.rejects(finishOidc(app, "mock", strangerCb, "b3", null), (e: unknown) => e instanceof HttpError && e.code === "not_linked");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")!.n, 2);
});
