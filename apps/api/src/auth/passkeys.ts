import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransport } from "@simplewebauthn/server";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { sessionWrite } from "./accounts.ts";
import { passkeyOrigins } from "../connect/app-association.ts";

const CHALLENGE_SECONDS = 300;

function saveChallenge(app: App, purpose: string, accountId: string | null, challenge: string, data?: unknown): string {
  const id = newId("chl");
  app.db.run("DELETE FROM auth_challenges WHERE expires_at < ?", nowIso());
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)", id, purpose, accountId, challenge, data === undefined ? null : JSON.stringify(data), addSeconds(CHALLENGE_SECONDS));
  return id;
}

function takeChallenge(app: App, id: string, purpose: string): { challenge: string; account_id: string | null; data: string | null } {
  const row = app.db.get<{ challenge: string; account_id: string | null; data: string | null; expires_at: string }>("SELECT challenge, account_id, data, expires_at FROM auth_challenges WHERE id = ? AND purpose = ?", id, purpose);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", id);
  if (!row || row.expires_at < nowIso()) throw new HttpError(400, "expired", "That took too long. Please try again.");
  return row;
}

export async function registrationOptions(app: App, accountId: string) {
  const existing = app.db.all<{ credential_id: string; transports: string | null }>("SELECT credential_id, transports FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", accountId);
  const name = app.db.get<{ display_name: string | null }>("SELECT display_name FROM accounts WHERE id = ?", accountId)?.display_name ?? "PURSS";
  const options = await generateRegistrationOptions({
    rpName: "PURSS",
    rpID: app.config.rpId,
    userName: name,
    userID: new TextEncoder().encode(accountId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return { challengeId: saveChallenge(app, "register", accountId, options.challenge), options };
}

export async function verifyRegistration(app: App, accountId: string, sessionId: string, challengeId: string, response: RegistrationResponseJSON, label: string | null): Promise<void> {
  const ch = takeChallenge(app, challengeId, "register");
  if (ch.account_id !== accountId) throw new HttpError(400, "expired", "That took too long. Please try again.");
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: passkeyOrigins(app), expectedRPID: app.config.rpId });
  } catch {
    audit(app, accountId, "passkey_add", null, "failure");
    throw new HttpError(400, "passkey_failed", "Fingerprint, face or screen lock couldn't be added. Please try again.");
  }
  if (!result.verified || !result.registrationInfo) throw new HttpError(400, "passkey_failed", "Fingerprint, face or screen lock couldn't be added. Please try again.");
  const c = result.registrationInfo.credential;
  sessionWrite(app, accountId, sessionId, () => {
    app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, credential_id, public_key, counter, transports, created_at) VALUES (?, ?, 'passkey', ?, ?, ?, ?, ?, ?)",
      newId("sim"), accountId, label ?? "Fingerprint, face or screen lock", c.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), nowIso());
    audit(app, accountId, "passkey_add", null, "success");
  }, true);
}

export async function authenticationOptions(app: App, sharedComputer = false) {
  const options = await generateAuthenticationOptions({ rpID: app.config.rpId, userVerification: "preferred" });
  return { challengeId: saveChallenge(app, "authenticate", null, options.challenge, { sharedComputer }), options };
}

/** Returns the authenticated account and the shared-computer choice stored with its challenge. */
export async function verifyAuthentication(app: App, challengeId: string, response: AuthenticationResponseJSON): Promise<{ accountId: string; sharedComputer: boolean }> {
  const ch = takeChallenge(app, challengeId, "authenticate");
  const cred = app.db.get<{ id: string; account_id: string; public_key: Uint8Array; counter: number; transports: string | null }>(
    "SELECT id, account_id, public_key, counter, transports FROM sign_in_methods WHERE kind = 'passkey' AND credential_id = ?", response.id);
  if (!cred) throw new HttpError(401, "unknown_passkey", "That didn't sign you in. Try your fingerprint, face or screen lock again, or use your password.");
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: passkeyOrigins(app), expectedRPID: app.config.rpId,
      credential: { id: response.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
    });
  } catch {
    audit(app, cred.account_id, "sign_in", "passkey", "failure");
    throw new HttpError(401, "passkey_failed", "That didn't sign you in. Try your fingerprint, face or screen lock again, or use your password.");
  }
  if (!result.verified) throw new HttpError(401, "passkey_failed", "That didn't sign you in. Try your fingerprint, face or screen lock again, or use your password.");
  app.db.run("UPDATE sign_in_methods SET counter = ?, last_used_at = ? WHERE id = ?", result.authenticationInfo.newCounter, nowIso(), cred.id);
  let sharedComputer = false;
  try { sharedComputer = (JSON.parse(ch.data ?? "null") as { sharedComputer?: boolean } | null)?.sharedComputer === true; } catch { /* old challenge rows have no data */ }
  return { accountId: cred.account_id, sharedComputer };
}

export function listMethods(app: App, accountId: string) {
  return app.db.all<{ id: string; kind: string; label: string | null; issuer: string | null; created_at: string; last_used_at: string | null }>(
    "SELECT id, kind, label, issuer, created_at, last_used_at FROM sign_in_methods WHERE account_id = ? ORDER BY created_at", accountId,
  ).map((m) => ({ id: m.id, kind: m.kind as "passkey" | "oidc" | "password", label: m.label ?? (m.kind === "oidc" ? m.issuer : "Fingerprint, face or screen lock"), createdAt: m.created_at, lastUsedAt: m.last_used_at }));
}

/**
 * Removing a sign-in method needs a recent sign-in. The password can be changed but never removed: it is the way back in, and
 * a passkey or a linked provider is an extra. An account always keeps at least one way to sign in.
 */
export function removeMethod(app: App, accountId: string, sessionId: string, methodId: string): void {
  sessionWrite(app, accountId, sessionId, () => {
    const m = app.db.get<{ kind: string }>("SELECT kind FROM sign_in_methods WHERE id = ? AND account_id = ?", methodId, accountId);
    if (!m) throw new HttpError(404, "not_found", "That sign-in method doesn't exist.");
    if (m.kind === "password") throw new HttpError(409, "password_required", "Your password can be changed but not removed. It's how you can always get back in.");
    const others = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sign_in_methods WHERE account_id = ? AND id <> ?", accountId, methodId)!.n;
    if (others === 0) throw new HttpError(409, "last_method", "This is your last way to sign in. Add a password first.");
    app.db.run("DELETE FROM sign_in_methods WHERE id = ?", methodId);
    audit(app, accountId, "sign_in_method_remove", m.kind, "success");
  }, true);
}
