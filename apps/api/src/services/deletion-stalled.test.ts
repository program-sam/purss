import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { OAuth2Server } from "oauth2-mock-server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { App } from "../app.ts";
import { registrationOptions, verifyRegistration } from "../auth/passkeys.ts";
import { finishOidc, startOidc } from "../auth/oidc.ts";
import { setPassword } from "../auth/accounts.ts";
import { bootDeletion, member, setCookie, signInWithPassword, stalledRequest } from "../deletion-testing.ts";
import type { DeletionBoot, Member } from "../deletion-testing.ts";
import { signIn, signedInPrincipal } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { HttpError } from "../http.ts";
import { requestDeletion } from "./deletion.ts";

/*
 * Requests that were already past authentication when the deletion was requested: each is held
 * back (its body, or the await inside it) across the request, and must then change nothing.
 */

const isSignedOut = (e: unknown) => e instanceof HttpError && e.code === "signed_out";

function browserHeaders(app: App, s: TestSession): Record<string, string> {
  return { origin: app.config.publicOrigin, cookie: s.cookie, "x-purss-csrf": s.csrf };
}

async function requestNow(b: DeletionBoot, m: Member, name: string): Promise<void> {
  const r = await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: name });
  assert.equal(r.status, 200, r.text);
}

test("a browser mutation whose body arrives after the deletion request changes nothing", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Ira");
  const s = signIn(b.app, m.accountId);

  const healthy = stalledRequest(b.base, "/api/baskets", browserHeaders(b.app, s), JSON.stringify({ name: "Before" }));
  await healthy.started;
  assert.equal((await healthy.finish()).status, 200, "the same request works while the account is usable");

  const stalled = stalledRequest(b.base, "/api/baskets", browserHeaders(b.app, s), JSON.stringify({ name: "Too late" }));
  await stalled.started;
  await requestNow(b, m, "Ira");
  const out = await stalled.finish();
  assert.equal(out.status, 401);
  assert.equal(out.json.error.code, "signed_out");
  assert.equal(b.app.db.get("SELECT 1 FROM baskets WHERE name = 'Too late'"), undefined);
});

test("MCP: a healthy request works; one stalled across a deletion, or a deletion and a cancel, is refused", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  const admin = await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Max");
  await b.api(signIn(b.app, admin.accountId), "PUT", "/api/admin/assistant", { enabled: true });
  const ms = signIn(b.app, m.accountId);
  await b.api(ms, "PUT", "/api/assistant", { enabled: true });
  const secret = (await b.api(ms, "POST", "/api/assistant/tokens", { name: "Claude", access: "write" })).json.secret as string;
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const auth = { authorization: `Bearer ${secret}`, accept: "application/json" };

  const healthy = stalledRequest(b.base, "/mcp", auth, rpc);
  await healthy.started;
  const ok = await healthy.finish();
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.result.tools));

  const acrossDeletion = stalledRequest(b.base, "/mcp", auth, rpc);
  const acrossCancel = stalledRequest(b.base, "/mcp", auth, rpc);
  await Promise.all([acrossDeletion.started, acrossCancel.started]);
  await requestNow(b, m, "Max");
  const refused = await acrossDeletion.finish();
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.code, -32600);

  // Keeping the account doesn't bring the revoked token back.
  const cookie = setCookie(await signInWithPassword(b, m), "purss_deletion")!.pair;
  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie })).status, 200);
  assert.equal((await acrossCancel.finish()).status, 401);
  const after = await fetch(`${b.base}/mcp`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: rpc });
  assert.equal(after.status, 401, "the token stays invalid");
});

test("a password change whose hashing straddles the deletion request is not saved", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Pia");
  const p = signedInPrincipal(b.app, m.accountId);
  const before = b.app.db.get<{ label: string; secret_hash: string }>("SELECT label, secret_hash FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", m.accountId)!;
  const pending = setPassword(b.app, p.accountId, p.sessionId, "pia-new-name", "a whole new password");
  requestDeletion(b.app, signedInPrincipal(b.app, m.accountId), "Pia");
  await assert.rejects(pending, isSignedOut);
  const after = b.app.db.get<{ label: string; secret_hash: string }>("SELECT label, secret_hash FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", m.accountId)!;
  assert.deepEqual({ ...after }, { ...before });
});

// ---- a software passkey: enough of WebAuthn's "none" attestation for the real verifier

function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

function softwarePasskey(app: App, challenge: string): RegistrationResponseJSON {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const credentialId = randomBytes(16);
  const authData = Buffer.concat([
    createHash("sha256").update(app.config.rpId).digest(),
    Buffer.from([0x45]), // user present, user verified, attested credential data
    Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose,
  ]);
  const clientData = JSON.stringify({ type: "webauthn.create", challenge, origin: app.config.publicOrigin, crossOrigin: false });
  const id = credentialId.toString("base64url");
  return {
    id, rawId: id, type: "public-key", clientExtensionResults: {},
    response: { clientDataJSON: Buffer.from(clientData).toString("base64url"), attestationObject: cbor({ fmt: "none", attStmt: {}, authData }).toString("base64url"), transports: ["internal"] },
  };
}

test("a passkey registration whose verification straddles the deletion request is not saved", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Quin");
  const register = async () => {
    const { challengeId, options } = await registrationOptions(b.app, m.accountId);
    return { challengeId, response: softwarePasskey(b.app, options.challenge) };
  };
  const control = await register();
  { const s = signedInPrincipal(b.app, m.accountId); await verifyRegistration(b.app, s.accountId, s.sessionId, control.challengeId, control.response, "Laptop"); }
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", m.accountId)!.n, 1, "the software passkey verifies");

  const late = await register();
  const lateSession = signedInPrincipal(b.app, m.accountId);
  const pending = verifyRegistration(b.app, lateSession.accountId, lateSession.sessionId, late.challengeId, late.response, "Phone");
  requestDeletion(b.app, signedInPrincipal(b.app, m.accountId), "Quin");
  await assert.rejects(pending, isSignedOut);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", m.accountId)!.n, 1, "the second passkey wasn't added");
});

test("linking an OIDC identity whose provider round trip straddles the deletion request is not saved", async (t) => {
  const issuer = new OAuth2Server();
  await issuer.issuer.keys.generate("RS256");
  await issuer.start(0, "127.0.0.1");
  t.after(() => issuer.stop());
  const b = await bootDeletion({ PURSS_OIDC: JSON.stringify([{ id: "mock", label: "Mock ID", issuer: issuer.issuer.url!, clientId: "purss-test" }]) });
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Rae");
  const p = signedInPrincipal(b.app, m.accountId);
  const linkUrl = await startOidc(b.app, "mock", "link", m.accountId, "binder", { sessionId: p.sessionId });
  const atIssuer = await fetch(linkUrl, { redirect: "manual" });
  const callback = new URL(atIssuer.headers.get("location")!);

  const pending = finishOidc(b.app, "mock", callback, { binder: "binder", accountId: p.accountId, sessionId: p.sessionId, address: "198.51.100.250" });
  requestDeletion(b.app, signedInPrincipal(b.app, m.accountId), "Rae");
  await assert.rejects(pending, isSignedOut);
  assert.equal(b.app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'oidc'", m.accountId), undefined);
});
