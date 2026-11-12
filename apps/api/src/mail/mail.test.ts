import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../main.ts";
import type { App } from "../app.ts";
import { loadConfig } from "../config.ts";
import { makeOwner, makeTestApp, testPassword } from "../testing.ts";
import { acceptInvite, createInvite } from "../auth/accounts.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { checkPassword, writePassword } from "../auth/passwords.ts";
import { requestPasswordReset } from "../services/account-email.ts";
import { main } from "../cli.ts";
import { checkMail, drainMail, maskAddress, mailHealth, purgeMail, sendMail, settleMail, signupOpen, useTransport } from "./mailer.ts";
import { openDatabase } from "../db/database.ts";
import type { Message } from "./mailer.ts";
import { invitationMail, resetMail, verifyMail } from "./templates.ts";
import { startSmtpSink, textOf } from "./testing.ts";

const MAIL = { PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
const HOSTED = { PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", ...MAIL };

type Sent = Message & { from: string };
function fakeServer(app: App) {
  const sent: Sent[] = [];
  const box = { sent, fail: null as (Error & { code?: string; responseCode?: number }) | null, verifyFails: false };
  useTransport(app, {
    send: async (m) => { if (box.fail) throw box.fail; sent.push(m); },
    verify: async () => { if (box.verifyFails) throw Object.assign(new Error("auth"), { code: "EAUTH", responseCode: 535 }); },
  });
  return box;
}
const tokenIn = (m: Sent | undefined, path: string) => {
  const found = m && new RegExp(`https://ws\\.example\\.org${path}\\?token=([\\w-]+)`).exec(m.text);
  assert.ok(found, `a ${path} link in ${m?.text}`);
  return decodeURIComponent(found[1]!);
};

async function boot(env: Record<string, string>) {
  const { app, cleanup } = makeTestApp(env);
  const admin = makeOwner(app, { admin: true });
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const req = (method: string, path: string, s: TestSession | null, body?: unknown) => call(app, server.base, method, path, s, body);
  return { app, admin, server, req, close: async () => { await settleMail(app); await server.close(); cleanup(); } };
}

test("configuration: off without a host; a host needs a sender; security and port are checked", () => {
  assert.equal(loadConfig({ PURSS_DATA_DIR: "/tmp/x" }).mail, null);
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/tmp/x", PURSS_SMTP_HOST: "smtp.example.org" }), /PURSS_MAIL_FROM/);
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL, PURSS_SMTP_SECURITY: "ssl" }), /starttls, tls or none/);
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL, PURSS_SMTP_PORT: "70000" }), /port/);
  assert.deepEqual(loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL }).mail, { host: "smtp.example.org", port: 587, security: "starttls", user: null, password: null, from: "PURSS <ws@example.org>" });
  assert.equal(loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL, PURSS_SMTP_SECURITY: "tls" }).mail!.port, 465);
  // Compose passes unset variables as empty strings.
  assert.deepEqual(loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL, PURSS_SMTP_PORT: "", PURSS_SMTP_SECURITY: "", PURSS_SMTP_USER: "", PURSS_SMTP_PASSWORD: "" }).mail, loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...MAIL }).mail);
  assert.equal(loadConfig({ PURSS_DATA_DIR: "/tmp/x", PURSS_SMTP_HOST: "", PURSS_MAIL_FROM: "" }).mail, null);
});

test("self-hosted without email: invitations are shared by hand, addresses change at once, and nothing degrades", async (t) => {
  const b = await boot({});
  t.after(b.close);
  const s = signIn(b.app, b.admin.accountId);
  const session = await b.req("GET", "/api/session", s);
  assert.equal(session.json.installation.mail, false);
  assert.equal(session.json.installation.accountEmail, false);
  assert.equal(session.json.installation.signup, "invite");
  assert.equal((await b.req("POST", "/api/admin/invites", s, { note: null })).status, 400, "an invitation is for an address");
  const invite = await b.req("POST", "/api/admin/invites", s, { email: "sis@example.org" });
  assert.equal(invite.status, 200);
  assert.match(invite.json.code, /^[a-z0-9-]{24}$/, "nothing sent: the administrator shares the code");
  assert.equal((await b.req("GET", "/api/account/email", s)).json.available, false);
  // The address changes at once, but never to one another account has.
  const other = makeOwner(b.app, { admin: false });
  b.app.db.run("UPDATE accounts SET email = 'taken@example.org' WHERE id = ?", other.accountId);
  const taken = await b.req("PUT", "/api/account/email", s, { email: "Taken@Example.org" });
  assert.deepEqual([taken.status, taken.json.error.code], [409, "email_in_use"]);
  const changed = await b.req("PUT", "/api/account/email", s, { email: "me@example.org" });
  assert.deepEqual(changed.json, { available: false, address: "me@example.org", confirmed: false, pending: null });
  assert.equal((await b.req("POST", "/api/password-reset", null, { email: "me@example.org" })).status, 404);
  assert.equal((await b.req("POST", "/api/account/email/resend", s)).status, 404);
  assert.equal((await b.req("GET", "/api/admin/health", s)).json.mail, null);
  assert.equal((await b.req("GET", "/api/admin/health", s)).json.signupWaitingForMail, false);
  assert.equal(signupOpen(b.app), false);
});

test("the real SMTP path: a message reaches a mail server, and the log keeps no body, link or full address", async (t) => {
  const sink = await startSmtpSink({ reject: /nobody@/ });
  const { app, cleanup } = makeTestApp({ PURSS_SMTP_HOST: "127.0.0.1", PURSS_SMTP_PORT: String(sink.port), PURSS_SMTP_SECURITY: "none", PURSS_MAIL_FROM: "PURSS <ws@example.org>" });
  t.after(async () => { await sink.close(); cleanup(); });
  assert.equal(await checkMail(app), true);
  const link = "https://ws.example.org/invite?code=abcd-efgh-ijkl-mnop-qrst";
  assert.equal(await sendMail(app, "invitation", null, invitationMail("Alex@Example.org", { link, days: 7, origin: "https://ws.example.org" })), true);
  assert.equal(sink.received.length, 1);
  const m = sink.received[0]!;
  assert.deepEqual(m.to, ["<Alex@example.org>"]);
  assert.match(m.data, /^Subject: You're invited to PURSS/m);
  assert.match(m.data, /Content-Type: text\/html/);
  const text = textOf(m);
  assert.ok(text.includes(link), "the link is in the message");
  assert.match(text, /ends in 7 days/);
  // A refused recipient fails that message only; the server is still fine.
  assert.equal(await sendMail(app, "test", null, { to: "nobody@example.org", subject: "x", text: "x", html: "x" }), false);
  assert.equal(mailHealth(app)!.status, "ok");
  const log = app.db.all<{ kind: string; recipient: string; outcome: string; error: string | null }>("SELECT kind, recipient, outcome, error FROM mail_log ORDER BY at, rowid");
  assert.deepEqual(log.map((l) => [l.kind, l.recipient, l.outcome]), [["invitation", "A•••@example.org", "sent"], ["test", "n•••@example.org", "failed"]]);
  assert.match(log[1]!.error!, /^EENVELOPE( 550)?$/);
  const dump = JSON.stringify(app.db.all("SELECT * FROM mail_log"));
  for (const secret of [link, "abcd-efgh", "Alex@Example.org", "invited"]) assert.ok(!dump.includes(secret), `the log must not hold ${secret}`);
  // A server that isn't there marks email as failing, which keeps open sign-up closed.
  await sink.close();
  assert.equal(await checkMail(app), false);
  assert.equal(mailHealth(app)!.status, "failing");
  assert.match(mailHealth(app)!.lastError!, /^E[A-Z]+/);
});

test("hosted open sign-up stays closed until the mail server check succeeds, and starts with an address", async (t) => {
  const b = await boot({ ...HOSTED, PURSS_SIGNUP: "open" });
  t.after(b.close);
  const mail = fakeServer(b.app);
  const closed = await b.req("POST", "/api/signup/start", null, { email: "ana@example.org" });
  assert.equal(closed.status, 403, "unchecked email: closed");
  assert.equal((await b.req("GET", "/api/session", null)).json.installation.signup, "invite");
  const admin = signIn(b.app, b.admin.accountId);
  assert.equal((await b.req("GET", "/api/admin/health", admin)).json.signupWaitingForMail, true, "the operator sees why");
  mail.verifyFails = true;
  await checkMail(b.app);
  assert.equal(signupOpen(b.app), false, "failing email: closed");
  assert.equal((await b.req("GET", "/api/admin/health", admin)).json.mail.status, "failing");
  mail.verifyFails = false;
  await checkMail(b.app);
  assert.equal((await b.req("GET", "/api/session", null)).json.installation.signup, "open");
  assert.equal((await b.req("GET", "/api/admin/health", admin)).json.signupWaitingForMail, false);
  assert.equal((await b.req("POST", "/api/signup/start", null, {})).status, 400, "an address is required");

  assert.equal((await b.req("POST", "/api/signup/start", null, { email: "ana@example.org" })).status, 200);
  await settleMail(b.app);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0]!.to, "ana@example.org");
  assert.equal(mail.sent[0]!.subject, "Finish creating your PURSS account");
  assert.equal(mail.sent[0]!.from, "PURSS <ws@example.org>");
  const token = tokenIn(mail.sent[0], "/app/signup");
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM signup_requests")).includes(token), "only a hash of the link is stored");
  const ok = await b.req("POST", "/api/signup", null, { token, displayName: "Ana", password: "a long enough password" });
  assert.equal(ok.status, 200, ok.text);
  const ana = b.app.db.get<{ id: string; email: string; email_verified_at: string | null }>("SELECT id, email, email_verified_at FROM accounts WHERE display_name = 'Ana'")!;
  assert.equal(ana.email, "ana@example.org");
  assert.ok(ana.email_verified_at, "the link confirmed the address");
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM audit_events")).includes("ana@example.org"), "the audit log keeps no address");
  // Never an administrator, whatever the address.
  assert.equal(b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", ana.id), undefined);
});

test("self-hosted with a mail server: an account confirms its address and resets its password by email; sign-up stays by invitation", async (t) => {
  const b = await boot({ ...MAIL, PURSS_PUBLIC_ORIGIN: "https://ws.example.org" });
  t.after(b.close);
  const mail = fakeServer(b.app);
  await checkMail(b.app);
  const user = makeOwner(b.app, { admin: false });
  const address = b.app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", user.accountId)!.email;
  await writePassword(b.app, user.accountId, "a long old password");
  const s = signIn(b.app, user.accountId);
  const installation = (await b.req("GET", "/api/session", s)).json.installation;
  assert.deepEqual([installation.mode, installation.accountEmail, installation.signup], ["self", true, "invite"]);
  assert.equal(signupOpen(b.app), false, "no open sign-up outside hosted mode");
  assert.deepEqual((await b.req("GET", "/api/account/email", s)).json, { available: true, address, confirmed: false, pending: null }, "made before email was set up: not confirmed yet");

  await requestPasswordReset(b.app, address);
  await settleMail(b.app);
  assert.equal(mail.sent.length, 0, "no reset link to an address nobody confirmed");
  assert.equal((await b.req("POST", "/api/account/email/resend", s)).status, 200);
  await settleMail(b.app);
  assert.equal(mail.sent.at(-1)!.to, address);
  assert.equal((await b.req("POST", "/api/email/verify", null, { token: tokenIn(mail.sent.at(-1), "/app/verify-email") })).status, 200);
  assert.equal((await b.req("GET", "/api/account/email", s)).json.confirmed, true);

  await b.req("POST", "/api/password-reset", null, { email: address.toUpperCase() });
  await settleMail(b.app);
  assert.equal(mail.sent.at(-1)!.subject, "Reset your password");
  const token = tokenIn(mail.sent.at(-1), "/app/reset-password");
  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token, password: "a brand new password" })).status, 200);
  assert.equal(await checkPassword(b.app, address, "a brand new password"), user.accountId);
});

test("a new address needs a recent sign-in and takes effect only once confirmed; the old one is told", async (t) => {
  const b = await boot(HOSTED);
  t.after(b.close);
  const mail = fakeServer(b.app);
  const user = makeOwner(b.app, { admin: false });
  b.app.db.run("UPDATE accounts SET email = 'me@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), user.accountId);
  const stale = signIn(b.app, user.accountId, { authAgeSeconds: 3600 });
  const fresh = signIn(b.app, user.accountId);
  assert.equal((await b.req("PUT", "/api/account/email", stale, { email: "new@example.org" })).json.error.code, "step_up");
  assert.equal((await b.req("PUT", "/api/account/email", fresh, { email: "not an address" })).status, 400);

  const set = await b.req("PUT", "/api/account/email", fresh, { email: "new@example.org" });
  assert.deepEqual(set.json, { available: true, address: "me@example.org", confirmed: true, pending: "new@example.org" }, "the current address stays until the new one is confirmed");
  await settleMail(b.app);
  assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [["new@example.org", "Confirm your email address"]], "nothing to the old address yet");
  const first = tokenIn(mail.sent.at(-1), "/app/verify-email");
  assert.equal((await b.req("POST", "/api/account/email/resend", fresh)).status, 200);
  await settleMail(b.app);
  assert.equal(mail.sent.at(-1)!.to, "new@example.org", "a resent link goes to the pending address");
  const second = tokenIn(mail.sent.at(-1), "/app/verify-email");
  assert.equal((await b.req("POST", "/api/email/verify", null, { token: first })).status, 400, "a resent link replaces the first");
  assert.equal(await checkPassword(b.app, "new@example.org", "correct horse battery staple"), null, "not a sign-in until confirmed");

  mail.sent.length = 0;
  assert.equal((await b.req("POST", "/api/email/verify", null, { token: second })).status, 200);
  assert.deepEqual((await b.req("GET", "/api/account/email", fresh)).json, { available: true, address: "new@example.org", confirmed: true, pending: null });
  assert.equal(await checkPassword(b.app, "NEW@example.org", "correct horse battery staple"), user.accountId);
  await settleMail(b.app);
  const notice = mail.sent.find((m) => m.to === "me@example.org")!;
  assert.equal(notice.subject, "Your email address was changed");
  assert.match(notice.text, /n•••@example\.org/);
  assert.ok(!notice.text.includes("new@example.org"), "the old address isn't told the new one in full");

  // Setting the same confirmed address again sends nothing; going back to it drops a pending change.
  mail.sent.length = 0;
  await b.req("PUT", "/api/account/email", fresh, { email: "New@Example.org" });
  await b.req("PUT", "/api/account/email", fresh, { email: "third@example.org" });
  await b.req("PUT", "/api/account/email", fresh, { email: "new@example.org" });
  assert.equal((await b.req("GET", "/api/account/email", fresh)).json.pending, null);
  await settleMail(b.app);
  assert.deepEqual(mail.sent.map((m) => m.to), ["third@example.org"]);
  assert.equal((await b.req("POST", "/api/email/verify", null, { token: tokenIn(mail.sent[0], "/app/verify-email") })).status, 400, "and its link is void");
});

test("an address another account took meanwhile can't be confirmed, and a link for it changes nothing", async (t) => {
  const b = await boot(HOSTED);
  t.after(b.close);
  const mail = fakeServer(b.app);
  const user = makeOwner(b.app, { admin: false });
  const other = makeOwner(b.app, { admin: false });
  const fresh = signIn(b.app, user.accountId);
  const before = b.app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", user.accountId)!.email;
  await b.req("PUT", "/api/account/email", fresh, { email: "wanted@example.org" });
  await settleMail(b.app);
  const token = tokenIn(mail.sent.at(-1), "/app/verify-email");
  b.app.db.run("UPDATE accounts SET email = 'Wanted@example.org' WHERE id = ?", other.accountId);
  const refused = await b.req("POST", "/api/email/verify", null, { token });
  assert.deepEqual([refused.status, refused.json.error.code], [409, "email_in_use"]);
  assert.equal(b.app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", user.accountId)!.email, before);
});

test("password reset: only to a confirmed address of an ordinary account with a password, with the same answer either way", async (t) => {
  const b = await boot(HOSTED);
  t.after(b.close);
  const mail = fakeServer(b.app);
  const pat = makeOwner(b.app, { admin: false });
  await writePassword(b.app, pat.accountId, "a long old password");
  b.app.db.run("UPDATE accounts SET email = 'pat@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), pat.accountId);
  const unconfirmed = makeOwner(b.app, { admin: false });
  await writePassword(b.app, unconfirmed.accountId, "a long old password");
  b.app.db.run("UPDATE accounts SET email = 'uma@example.org' WHERE id = ?", unconfirmed.accountId);
  await writePassword(b.app, b.admin.accountId, "a long old password");
  b.app.db.run("UPDATE accounts SET email = 'root@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), b.admin.accountId);

  for (const email of ["nobody", "nobody@example.org", "uma@example.org", "root@example.org"]) {
    const r = await b.req("POST", "/api/password-reset", null, { email });
    assert.deepEqual([r.status, r.json], [200, { ok: true }], email);
  }
  await settleMail(b.app);
  assert.equal(mail.sent.length, 0, "unknown, unconfirmed and administrator accounts get nothing");

  await b.req("POST", "/api/password-reset", null, { email: "PAT@example.org" });
  await b.req("POST", "/api/password-reset", null, { email: " Pat@Example.org " });
  await settleMail(b.app);
  assert.equal(mail.sent.length, 2);
  assert.ok(mail.sent.every((m) => m.to === "pat@example.org" && m.subject === "Reset your password" && /account with this email address/.test(m.text)));
  const stale = tokenIn(mail.sent[0], "/app/reset-password");
  const token = tokenIn(mail.sent[1], "/app/reset-password");

  // Sessions and assistant tokens that exist before the reset are ended by it.
  const session = signIn(b.app, pat.accountId);
  b.app.db.run("INSERT INTO assistant_tokens (id, account_id, name, access, token_hash, created_at) VALUES ('tok_1', ?, 'Laptop', 'read', 'hash', ?)", pat.accountId, new Date().toISOString());

  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token: stale, password: "a brand new password" })).status, 400, "a newer link replaces an older one");
  const weak = await b.req("POST", "/api/password-reset/confirm", null, { token, password: "short" });
  assert.equal(weak.json.error.code, "short_password");
  const done = await b.req("POST", "/api/password-reset/confirm", null, { token, password: "a brand new password" });
  assert.equal(done.status, 200, "a refused password doesn't use up the link");
  assert.equal(await checkPassword(b.app, "pat@example.org", "a brand new password"), pat.accountId);
  assert.equal(await checkPassword(b.app, "pat@example.org", "a long old password"), null);
  assert.equal((await b.req("GET", "/api/account/email", session)).status, 401, "signed out everywhere");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_tokens WHERE account_id = ?", pat.accountId)!.n, 0, "assistant tokens revoked");
  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token, password: "another new password" })).status, 400, "the link works once");
  await settleMail(b.app);
  assert.equal(mail.sent.at(-1)!.subject, "Your password was changed");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'password_reset' AND target = ?", pat.accountId));
});

test("a reset link dies with an address change, expiry, or suspension; and resets are limited per account", async (t) => {
  const b = await boot(HOSTED);
  t.after(b.close);
  const mail = fakeServer(b.app);
  const pat = makeOwner(b.app, { admin: false });
  await writePassword(b.app, pat.accountId, "a long old password");
  const confirm = () => b.app.db.run("UPDATE accounts SET email = 'pat@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), pat.accountId);
  confirm();
  const linkFor = async () => { requestPasswordReset(b.app, "pat@example.org"); await settleMail(b.app); return tokenIn(mail.sent.at(-1), "/app/reset-password"); };

  let token = await linkFor();
  b.app.db.run("UPDATE accounts SET email = 'other@example.org' WHERE id = ?", pat.accountId);
  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token, password: "a brand new password" })).status, 400, "sent to an address the account no longer has");
  confirm();
  token = await linkFor();
  b.app.db.run("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset' AND used_at IS NULL", new Date(Date.now() - 1000).toISOString());
  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token, password: "a brand new password" })).status, 400, "expired");
  await linkFor();
  const before = mail.sent.length;
  requestPasswordReset(b.app, "pat@example.org");
  await settleMail(b.app);
  assert.equal(mail.sent.length, before, "at most three links an hour per account");
  b.app.db.run("DELETE FROM email_tokens");
  token = await linkFor();
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", pat.accountId);
  assert.equal((await b.req("POST", "/api/password-reset/confirm", null, { token, password: "a brand new password" })).status, 400, "suspended accounts can't reset");
  // Links from one account never act on another.
  const other = makeOwner(b.app, { admin: false });
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ?", other.accountId)!.n, 0);
});

test("invitations by email: the code goes only to the address, using it confirms the address, and an undelivered one is withdrawn", async (t) => {
  const b = await boot({ ...MAIL, PURSS_PUBLIC_ORIGIN: "https://ws.example.org" });
  t.after(b.close);
  const mail = fakeServer(b.app);
  const s = signIn(b.app, b.admin.accountId);
  assert.equal((await b.req("GET", "/api/session", s)).json.installation.mail, true);
  assert.equal((await b.req("GET", "/api/session", s)).json.installation.accountEmail, true, "with email set up, addresses are confirmed by a link");
  const out = await b.req("POST", "/api/admin/invites", s, { note: "Sister", email: "sis@example.org", days: 5 });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { code: null, expiresInDays: 5 }, "the administrator never sees the code: only the address gets it");
  assert.equal(mail.sent[0]!.to, "sis@example.org");
  const link = /https:\/\/ws\.example\.org\/app\/invite\?code=([\w-]+)&email=sis%40example\.org/.exec(mail.sent[0]!.text);
  assert.ok(link, mail.sent[0]!.text);
  assert.match(mail.sent[0]!.html, /<a href="https:\/\/ws\.example\.org\/app\/invite\?code=/);
  assert.deepEqual(b.app.db.all<{ email: string }>("SELECT email FROM invites").map((i) => i.email), ["sis@example.org"], "the invitation keeps the address it is for");
  const elsewhere = JSON.stringify([b.app.db.all("SELECT * FROM audit_events"), b.app.db.all("SELECT * FROM mail_log"), b.app.db.all("SELECT * FROM accounts")]);
  assert.ok(!elsewhere.includes("sis@example.org"), "and nothing else does");
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM invites")).includes(link[1]!), "only a hash of the code is stored");
  const sis = acceptInvite(b.app, link[1]!, "sis@example.org", "Sis", testPassword());
  assert.ok(b.app.db.get<{ v: string | null }>("SELECT email_verified_at AS v FROM accounts WHERE id = ?", sis.accountId)!.v, "the emailed code proved the address");

  // An invitation whose code never went by email proves nothing, even on a server that sends email now.
  const handed = createInvite(b.app, b.admin.accountId, "kim@example.org", null, null);
  const kim = acceptInvite(b.app, handed, "kim@example.org", "Kim", testPassword());
  assert.equal(b.app.db.get<{ v: string | null }>("SELECT email_verified_at AS v FROM accounts WHERE id = ?", kim.accountId)!.v, null);

  assert.equal((await b.req("POST", "/api/admin/invites", s, { email: "not-an-address" })).status, 400);
  mail.fail = Object.assign(new Error("Mailbox unavailable"), { code: "EENVELOPE", responseCode: 550 });
  const refused = await b.req("POST", "/api/admin/invites", s, { email: "gone@example.org" });
  assert.deepEqual([refused.status, refused.json.error.code], [502, "invite_not_sent"]);
  assert.equal(refused.json.code, undefined, "no code to share by hand");
  assert.equal(b.app.db.get("SELECT 1 FROM invites WHERE email = 'gone@example.org'"), undefined, "the undelivered invitation is withdrawn");
  const health = (await b.req("GET", "/api/admin/health", s)).json.mail;
  assert.equal(health.sentLastDay, 1);
  assert.equal(health.failedLastDay, 1);
  assert.equal(health.status, "ok", "one refused recipient doesn't make the server failing");
});

test("mail queued for later survives a restart and a mail server that is down, and is kept sealed until sent", async (t) => {
  const { app, cleanup } = makeTestApp(MAIL);
  t.after(cleanup);
  const pat = makeOwner(app, { admin: false });
  await writePassword(app, pat.accountId, "a long old password");
  app.db.run("UPDATE accounts SET email = 'pat@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), pat.accountId);
  // The process stops while the message is still on its way (the mail server never answers).
  useTransport(app, { send: () => new Promise(() => {}), verify: async () => {} });
  requestPasswordReset(app, "pat@example.org");
  await new Promise((r) => setTimeout(r, 20));
  const stored = JSON.stringify(app.db.all("SELECT * FROM mail_queue"));
  assert.ok(!/reset-password\?token=/.test(stored) && !stored.includes("pat@example.org"), "no link or address in the database");

  // Started again: the message goes out. First the server is down, so it waits and is tried again.
  const again: App = { db: openDatabase(app.config.dbFile), config: app.config, events: app.events, serviceToken: "x" };
  t.after(() => again.db.close());
  const sent: Message[] = [];
  let down = true;
  useTransport(again, { send: async (m) => { if (down) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); sent.push(m); }, verify: async () => {} });
  drainMail(again);
  await settleMail(again);
  assert.equal(sent.length, 0);
  assert.equal(again.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail_queue")!.n, 1, "kept for another try");
  down = false;
  drainMail(again, Date.now() + 3600_000);
  await settleMail(again);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /reset-password\?token=/);
  assert.equal(again.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail_queue")!.n, 0, "gone once sent");
  assert.deepEqual(again.db.all<{ outcome: string }>("SELECT outcome FROM mail_log ORDER BY at").map((r) => r.outcome), ["failed", "sent"]);
});

test("templates escape what they show and carry the same words in text and HTML", () => {
  const m = resetMail("a@example.org", { link: "https://ws.example.org/reset-password?token=a<b>&c", minutes: 60 });
  assert.ok(!m.html.includes("<b>"));
  assert.ok(m.html.includes("token=a&lt;b&gt;&amp;c"));
  assert.match(m.text, /works once, for 60 minutes/);
  assert.match(m.html, /works once, for 60 minutes/);
  assert.match(verifyMail("a@example.org", { link: "https://x", hours: 48 }).text, /48 hours/);
  assert.equal(maskAddress("someone@Mail.Example.org"), "s•••@mail.example.org");
  assert.equal(maskAddress("broken"), "•••");
});

test("old log entries and spent links are purged", (t) => {
  const { app, cleanup } = makeTestApp(MAIL);
  t.after(cleanup);
  const p = makeOwner(app);
  const old = new Date(Date.now() - 100 * 86400_000).toISOString();
  app.db.run("INSERT INTO mail_log (id, at, kind, recipient, outcome) VALUES ('m1', ?, 'test', 'a•••@x', 'sent'), ('m2', ?, 'test', 'a•••@x', 'sent')", old, new Date().toISOString());
  app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES ('t1', ?, 'verify', 'a@x', ?, ?), ('t2', ?, 'verify', 'a@x', ?, ?)",
    p.accountId, old, old, p.accountId, old, new Date(Date.now() + 3600_000).toISOString());
  purgeMail(app);
  assert.deepEqual(app.db.all<{ id: string }>("SELECT id FROM mail_log").map((r) => r.id), ["m2"]);
  assert.deepEqual(app.db.all<{ id: string }>("SELECT id FROM email_tokens").map((r) => r.id), ["t2"]);
});

test("CLI with email set up: an invitation goes only by email, and set-email waits for the new address to be confirmed", async (t) => {
  const sink = await startSmtpSink();
  const { app, cleanup } = makeTestApp();
  t.after(async () => { await sink.close(); cleanup(); });
  const owner = makeOwner(app);
  app.db.run("UPDATE accounts SET email = 'owner@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), owner.accountId);
  const env = { PURSS_DATA_DIR: app.config.dataDir, PURSS_SMTP_HOST: "127.0.0.1", PURSS_SMTP_PORT: String(sink.port), PURSS_SMTP_SECURITY: "none", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const invited = await run(["create-invite", "sis@example.org"]);
  assert.equal(invited.code, 0, invited.err);
  assert.match(invited.out, /emailed to sis@example\.org/);
  assert.doesNotMatch(invited.out, /[a-z0-9]{4}(-[a-z0-9]{4}){4}/, "no code to hand out");
  assert.equal(sink.received.length, 1);
  assert.match(textOf(sink.received[0]!), /\/app\/invite\?code=/);
  assert.ok(app.db.get("SELECT emailed_at FROM invites WHERE email = 'sis@example.org'")!.emailed_at);

  const moved = await run(["set-email", owner.accountId, "new@example.org"]);
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.out, /keeps signing in with owner@example\.org/);
  assert.equal(app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", owner.accountId)!.email, "owner@example.org", "the confirmed address stays until the new one is confirmed");
  assert.equal(await checkPassword(app, "new@example.org", "correct horse battery staple"), null);
  assert.equal(await checkPassword(app, "owner@example.org", "correct horse battery staple"), owner.accountId);
  assert.ok(app.db.get("SELECT 1 FROM email_tokens WHERE account_id = ? AND purpose = 'verify' AND email = 'new@example.org'", owner.accountId), "a confirmation link is waiting for the new address");
});

test("CLI: test-email sends through the configured server and says plainly when email isn't set up", async (t) => {
  const sink = await startSmtpSink();
  const { app, cleanup } = makeTestApp();
  t.after(async () => { await sink.close(); cleanup(); });
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { PURSS_DATA_DIR: app.config.dataDir, ...env }, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const off = await run(["test-email", "me@example.org"]);
  assert.equal(off.code, 1);
  assert.match(off.err, /isn't set up/);
  assert.match((await run(["status"])).out, /Outgoing email: not set up/);
  const env = { PURSS_SMTP_HOST: "127.0.0.1", PURSS_SMTP_PORT: String(sink.port), PURSS_SMTP_SECURITY: "none", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
  assert.equal((await run(["test-email"], env)).code, 2);
  const sent = await run(["test-email", "me@example.org"], env);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(sink.received.length, 1);
  assert.match(textOf(sink.received[0]!), /Outgoing email works/);
  assert.ok(app.db.get("SELECT 1 FROM audit_events WHERE action = 'cli_test_email'"));
  assert.match((await run(["status"], env)).out, /Outgoing email: 127\.0\.0\.1:\d+ \(none\), from PURSS <ws@example\.org>/);
  const unreachable = await run(["test-email", "me@example.org"], { ...env, PURSS_SMTP_PORT: "1" });
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.err, /mail server check failed: E[A-Z]+/);
});

test("the mail queue's key is made at startup, so a change a request committed is never followed by a failure to queue its mail", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "purss-mailkey-"));
  t.after(() => { chmodSync(path.join(dataDir, "secrets"), 0o700); rmSync(dataDir, { recursive: true, force: true }); });
  const config = loadConfig({ PURSS_DATA_DIR: dataDir, PURSS_DISK_RESERVE_BYTES: "0", ...MAIL });
  const app = createApp(config);
  t.after(() => app.db.close());
  assert.ok(existsSync(path.join(config.secretsDir, "mail-queue-key")));
  // The secrets folder becomes read-only afterwards (a read-only mount): queueing still works.
  chmodSync(config.secretsDir, 0o500);
  useTransport(app, { send: async () => {}, verify: async () => {} });
  const p = makeOwner(app, { admin: false });
  await writePassword(app, p.accountId, "a long old password");
  app.db.run("UPDATE accounts SET email = 'pat@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), p.accountId);
  assert.doesNotThrow(() => requestPasswordReset(app, "pat@example.org"));
  await settleMail(app);
});

test("with mail set up, a secrets folder where the queue's key can't be made stops the server at startup with a plain reason", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "purss-mailkey-"));
  const secrets = path.join(dataDir, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(path.join(secrets, "service-token"), "token\n", { mode: 0o600 });
  chmodSync(secrets, 0o500);
  t.after(() => { chmodSync(secrets, 0o700); rmSync(dataDir, { recursive: true, force: true }); });
  assert.throws(() => createApp(loadConfig({ PURSS_DATA_DIR: dataDir, PURSS_DISK_RESERVE_BYTES: "0", ...MAIL })), /mail-queue-key.*PURSS_SMTP_HOST|PURSS_SMTP_HOST.*mail-queue-key/s);
});

test("mail queued while email was set up is dropped, and logged, once email isn't set up any more", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "purss-mailkey-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const withMail = createApp(loadConfig({ PURSS_DATA_DIR: dataDir, PURSS_DISK_RESERVE_BYTES: "0", ...MAIL }));
  withMail.db.run("INSERT INTO mail_queue (id, kind, account_id, sealed, created_at, next_attempt_at) VALUES ('mlq_1', 'reset', NULL, 'x.y.z', ?, ?)", new Date().toISOString(), new Date().toISOString());
  withMail.db.close();
  const without = createApp(loadConfig({ PURSS_DATA_DIR: dataDir, PURSS_DISK_RESERVE_BYTES: "0" }));
  t.after(() => without.db.close());
  assert.equal(without.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail_queue")!.n, 0);
  assert.deepEqual(without.db.all<{ kind: string; outcome: string; error: string }>("SELECT kind, outcome, error FROM mail_log").map((r) => [r.kind, r.outcome, r.error]), [["reset", "failed", "unconfigured"]]);
});
