import test from "node:test";
import assert from "node:assert/strict";
import type { Principal } from "../app.ts";
import { checkPassword } from "../auth/passwords.ts";
import { createDeviceToken } from "../connect/devices.ts";
import { bootDeletion, makeDue, member, rowsMentioning, seedAdjacent, setCookie, stalledRequest } from "../deletion-testing.ts";
import type { DeletionBoot, Member } from "../deletion-testing.ts";
import { signIn } from "../features-testing.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { settleMail, useTransport } from "../mail/mailer.ts";
import { refreshTokens, resolveAccessToken } from "../oauth/grants.ts";
import { sha256 } from "../secrets.ts";
import { resetPassword } from "./account-email.ts";
import { claimDeletion, runDeletions } from "./deletion.ts";

/*
 * Account deletion and what the connected apps, playback positions, highlights and notes, browser capture,
 * outgoing email and assistants connected with OAuth keep for an account (plan/24-28, 31-33).
 */

const OAUTH = { PURSS_ASSISTANT_OAUTH: "on" };
const MAIL = { ...OAUTH, PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
const ASSISTANT = "https://assistant.example/client";

const principal = (m: Member): Principal & { engineUserId: string } =>
  ({ accountId: m.accountId, workspaceId: m.workspaceId, isAdmin: false, sessionId: "seed", csrf: "", authAt: nowIso(), engineUserId: m.engineUserId });

async function requested(b: DeletionBoot, m: Member, name: string): Promise<void> {
  const r = await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: name });
  assert.equal(r.status, 200, r.text);
}

const count = (b: DeletionBoot, sql: string, ...args: string[]) => b.app.db.get<{ n: number }>(sql, ...args)!.n;
const asApp = (token: string) => ({ authorization: `Bearer ${token}` });

test("asking to delete ends connected apps, OAuth assistants, pending codes and email links; the data waits", async (t) => {
  const b = await bootDeletion(OAUTH);
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Dee");
  const d = seedAdjacent(b.app, principal(m));

  assert.equal((await b.api(null, "GET", "/api/baskets", undefined, asApp(d.deviceToken))).status, 200, "the app works before");
  assert.ok(!("error" in resolveAccessToken(b.app, d.accessToken)), "and so does the assistant");

  await requested(b, m, "Dee");

  assert.equal((await b.api(null, "GET", "/api/baskets", undefined, asApp(d.deviceToken))).status, 401, "the app is disconnected");
  assert.deepEqual(resolveAccessToken(b.app, d.accessToken), { error: "invalid" }, "the assistant's access token is refused");
  assert.equal((refreshTokens(b.app, { refreshToken: d.refreshToken, clientId: ASSISTANT }) as { error: string }).error, "invalid_grant", "and can't be renewed");
  for (const table of ["device_tokens", "push_devices", "connect_codes", "oauth_grants"]) assert.equal(count(b, `SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, m.accountId), 0, table);
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM oauth_access_tokens"), 0);
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ? AND used_at IS NULL", m.accountId), 0, "unused email links end");

  assert.throws(() => createDeviceToken(b.app, m.accountId, "mobile", "New phone"), (e: unknown) => e instanceof HttpError && e.code === "account_deleting", "no app can connect during the grace period");
  b.app.db.run("UPDATE accounts SET assistant_access = 1 WHERE id = ?", m.accountId);
  const fresh = b.app.db.run(`INSERT INTO oauth_grants (id, account_id, client_id, client_name, redirect_uri, access, resource, code_hash, refresh_hash, refresh_generation, refresh_key_id, created_at, last_used_at, expires_at)
    VALUES ('ogr_late', ?, ?, 'Assistant', 'https://assistant.example/cb', 'read', ?, 'c-late', 'r-late', 0, 'k', ?, ?, ?)`, m.accountId, ASSISTANT, `${b.app.config.publicOrigin}/mcp`, nowIso(), nowIso(), addSeconds(3600));
  assert.equal(fresh.changes, 1);
  b.app.db.run("INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) VALUES (?, 'ogr_late', ?)", sha256("purss_oat_late"), addSeconds(3600));
  assert.deepEqual(resolveAccessToken(b.app, "purss_oat_late"), { error: "invalid" }, "a grant that somehow survived is refused while the account is being deleted");

  // Nothing is removed before the grace period ends.
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM playback_positions WHERE account_id = ?", m.accountId), 1);
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM annotations WHERE account_id = ? AND deleted_at IS NULL", m.accountId), 2);
});

test("a connected app's or OAuth assistant's request stalled across the deletion request changes nothing", async (t) => {
  const b = await bootDeletion(OAUTH);
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Eli");
  const d = seedAdjacent(b.app, principal(m));
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const assistant = { authorization: `Bearer ${d.accessToken}`, accept: "application/json" };

  const healthy = stalledRequest(b.base, "/api/baskets", asApp(d.deviceToken), JSON.stringify({ name: "From the phone" }));
  await healthy.started;
  assert.equal((await healthy.finish()).status, 200, "an app's request whose body arrives later works while the account is usable");
  const healthyRpc = stalledRequest(b.base, "/mcp", assistant, rpc);
  await healthyRpc.started;
  assert.equal((await healthyRpc.finish()).status, 200, "and so does an OAuth assistant's");

  const stalled = stalledRequest(b.base, "/api/baskets", asApp(d.deviceToken), JSON.stringify({ name: "Too late" }));
  const stalledRpc = stalledRequest(b.base, "/mcp", assistant, rpc);
  await Promise.all([stalled.started, stalledRpc.started]);
  await requested(b, m, "Eli");
  const out = await stalled.finish();
  assert.equal(out.status, 401);
  assert.equal(b.app.db.get("SELECT 1 FROM baskets WHERE name = 'Too late'"), undefined);
  assert.equal((await stalledRpc.finish()).status, 401);
});

test("removal deletes playback, annotations and their search rows, browser captures, app and assistant credentials and email data", async (t) => {
  const b = await bootDeletion(OAUTH);
  t.after(b.close);
  const owner = await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Fay");
  seedAdjacent(b.app, principal(owner), "keepword");
  const gone = seedAdjacent(b.app, principal(m), "goneword");
  const search = (word: string) => b.app.db.all("SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?", word).length;
  assert.ok(search("goneword") > 0 && search("keepword") > 0);
  const ownerGrants = count(b, "SELECT COUNT(*) AS n FROM oauth_access_tokens");

  await requested(b, m, "Fay");
  makeDue(b.app, m.accountId);
  runDeletions(b.app);
  assert.equal(b.app.db.get<{ phase1_done: number }>("SELECT phase1_done FROM account_deletions WHERE account_id = ?", m.accountId)!.phase1_done, 1, "phase 1 passes every foreign key");
  assert.deepEqual(b.app.db.all("PRAGMA foreign_key_check"), []);

  assert.equal(search("goneword"), 0, "the account's highlights and notes are gone from search");
  assert.ok(search("keepword") > 0, "the other account's are still found");
  for (const table of ["playback_positions", "annotations", "device_tokens", "push_devices", "connect_codes", "oauth_grants", "oauth_refreshes", "email_tokens", "mail_queue", "mail_log"]) {
    const scope = table === "playback_positions" || table === "annotations" ? "workspace_id" : "account_id";
    assert.equal(count(b, `SELECT COUNT(*) AS n FROM ${table} WHERE ${scope} = ?`, scope === "account_id" ? m.accountId : m.workspaceId), 0, table);
  }
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?", m.workspaceId), 0, "browser captures");
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM oauth_access_tokens"), ownerGrants - 1, "only the other account's access token is left");
  assert.equal(count(b, "SELECT COUNT(*) AS n FROM mail_log WHERE account_id IS NULL AND recipient = 'a•••@example.org'"), 1, "the mail log keeps a masked line, no longer tied to the account");
  assert.deepEqual({ ...b.app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", m.accountId) }, { email: null, email_verified_at: null }, "the address goes before the account row");
  assert.deepEqual(rowsMentioning(b.app, [m.accountId, m.workspaceId]).filter((r) => !/^(accounts|workspaces|engine_users|account_deletions|jobs)\./.test(r)), [], "only what phase 2 removes is left");
});

test("during the grace period a password reset by email works and signing in offers to keep the account; once removal starts it is refused", async (t) => {
  const b = await bootDeletion(MAIL);
  t.after(async () => { await settleMail(b.app); await b.close(); });
  useTransport(b.app, { send: async () => {}, verify: async () => {} });
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Gus");
  b.app.db.run("UPDATE accounts SET email = 'gus@example.org', email_verified_at = ? WHERE id = ?", nowIso(), m.accountId);
  await requested(b, m, "Gus");
  const link = (token: string) => b.app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, 'reset', 'gus@example.org', ?, ?)",
    sha256(token), m.accountId, nowIso(), addSeconds(3600));

  link("reset-in-grace");
  await resetPassword(b.app, "reset-in-grace", "a brand new password");
  const signin = await b.api(null, "POST", "/api/auth/password", { username: m.username, password: "a brand new password" });
  assert.equal(signin.status, 409);
  assert.equal(signin.json.error.code, "deletion_pending", "signing in offers to keep the account");
  assert.ok(setCookie(signin, "purss_deletion"));

  makeDue(b.app, m.accountId);
  assert.ok(claimDeletion(b.app, m.accountId));
  link("reset-while-purging");
  await assert.rejects(resetPassword(b.app, "reset-while-purging", "another new password"), (e: unknown) => e instanceof HttpError && e.code === "link_spent");
  assert.equal(await checkPassword(b.app, m.username, "another new password"), null, "the password isn't changed");
  const refused = await b.api(null, "POST", "/api/auth/password", { username: m.username, password: "a brand new password" });
  assert.equal(refused.json.error.code, "account_deleting", "and signing in is refused");
});
