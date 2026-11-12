import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "../app.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { signIn } from "../features-testing.ts";
import { nowIso, addSeconds } from "../http.ts";
import { sha256 } from "../secrets.ts";
import { writePassword } from "./passwords.ts";
import { createDeviceToken } from "../connect/devices.ts";
import { issueCode } from "../connect/codes.ts";
import { resetPassword } from "../services/account-email.ts";
import { updateAccount } from "../services/admin.ts";
import { setEnabled } from "../services/assistant.ts";
import { settleMail, useTransport } from "../mail/mailer.ts";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const MAIL = { PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>", PURSS_PUBLIC_ORIGIN: "https://ws.example.org" };

/** One of every way an account can be signed in or about to be. */
function credentials(app: App, accountId: string) {
  signIn(app, accountId);
  createDeviceToken(app, accountId, "mobile", "Phone");
  createDeviceToken(app, accountId, "extension", "Browser");
  issueCode(app, { accountId, kind: "mobile", clientId: null, redirectUri: "purss://connect", label: "Phone", scope: null }, CHALLENGE, "redirect");
  issueCode(app, { accountId, kind: "oauth", clientId: "https://assistant.example/client", redirectUri: "https://assistant.example/cb", label: "Assistant", scope: "read" }, CHALLENGE, "redirect");
  app.db.run("INSERT INTO assistant_tokens (id, account_id, name, access, token_hash, created_at) VALUES (?, ?, 'Laptop', 'read', ?, ?)", `tok_${accountId}`, accountId, `hash-${accountId}`, nowIso());
  app.db.run(`INSERT INTO oauth_grants (id, account_id, client_id, client_name, redirect_uri, access, resource, code_hash, refresh_hash, refresh_generation, refresh_key_id, created_at, last_used_at, expires_at)
    VALUES (?, ?, 'https://assistant.example/client', 'Assistant', 'https://assistant.example/cb', 'read', 'https://ws.example.org/mcp', ?, ?, 0, 'k', ?, ?, ?)`,
  `grt_${accountId}`, accountId, `code-${accountId}`, `refresh-${accountId}`, nowIso(), nowIso(), addSeconds(86_400));
  // Email links not used yet: confirming the address, and a password reset someone else may have asked for.
  for (const purpose of ["verify", "reset"]) {
    app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, 'x@example.org', ?, ?)",
      sha256(`${purpose}-${accountId}`), accountId, purpose, nowIso(), addSeconds(3600));
  }
}

function left(app: App, accountId: string) {
  const n = (sql: string) => app.db.get<{ n: number }>(sql, accountId)!.n;
  return {
    sessions: n("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?"),
    devices: n("SELECT COUNT(*) AS n FROM device_tokens WHERE account_id = ?"),
    appCodes: n("SELECT COUNT(*) AS n FROM connect_codes WHERE account_id = ? AND kind <> 'oauth'"),
    oauthCodes: n("SELECT COUNT(*) AS n FROM connect_codes WHERE account_id = ? AND kind = 'oauth'"),
    tokens: n("SELECT COUNT(*) AS n FROM assistant_tokens WHERE account_id = ?"),
    grants: n("SELECT COUNT(*) AS n FROM oauth_grants WHERE account_id = ?"),
    emailLinks: n("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ? AND used_at IS NULL"),
  };
}
const ALL = { sessions: 1, devices: 2, appCodes: 1, oauthCodes: 1, tokens: 1, grants: 1, emailLinks: 2 };
const NONE = { sessions: 0, devices: 0, appCodes: 0, oauthCodes: 0, tokens: 0, grants: 0, emailLinks: 0 };

test("a password reset by email ends sessions, connected apps, pending codes, assistant tokens, grants and unused email links", async (t) => {
  const { app, cleanup } = makeTestApp(MAIL);
  t.after(async () => { await settleMail(app); cleanup(); });
  useTransport(app, { send: async () => {}, verify: async () => {} });
  const pat = makeOwner(app, { admin: false });
  const bystander = makeOwner(app, { admin: false });
  await writePassword(app, pat.accountId, "a long old password");
  app.db.run("UPDATE accounts SET email = 'pat@example.org', email_verified_at = ? WHERE id = ?", nowIso(), pat.accountId);
  credentials(app, pat.accountId);
  credentials(app, bystander.accountId);
  app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, 'reset', 'pat@example.org', ?, ?)",
    sha256("reset-token"), pat.accountId, nowIso(), addSeconds(3600));

  await resetPassword(app, "reset-token", "a brand new password");
  assert.deepEqual(left(app, pat.accountId), NONE);
  assert.deepEqual(left(app, bystander.accountId), ALL, "other accounts keep theirs");
});

test("suspension ends sessions, connected apps and pending codes; assistant tokens and grants wait for resumption", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app, { admin: true });
  const pat = makeOwner(app, { admin: false });
  credentials(app, pat.accountId);
  updateAccount(app, admin, pat.accountId, { status: "suspended" });
  assert.deepEqual(left(app, pat.accountId), { ...NONE, tokens: 1, grants: 1, emailLinks: 2 });
});

test("turning assistant access off revokes assistant tokens, grants and pending OAuth codes, and nothing else", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const pat = makeOwner(app, { admin: false });
  credentials(app, pat.accountId);
  setEnabled(app, pat, false);
  assert.deepEqual(left(app, pat.accountId), { ...ALL, oauthCodes: 0, tokens: 0, grants: 0 });
});
