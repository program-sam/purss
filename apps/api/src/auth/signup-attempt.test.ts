import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, setCookie } from "../deletion-testing.ts";
import { addSeconds } from "../http.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import type { Message } from "../mail/mailer.ts";
import { writePassword } from "./passwords.ts";

/*
 * Sign-up is idempotent per attempt: the browser sends a random id with the form, and an earlier press with the same id
 * (a double press, or a new try after the page was closed) finds the account it made instead of making another one and
 * sending another confirmation.
 */

const HOSTED = { PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_TRUST_PROXY: "1", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
const ATTEMPT = "Qk3mZpT0xv8sLw2YcA9RhA";
let n = 0;

async function boot() {
  const b = await bootDeletion(HOSTED);
  const sent: Message[] = [];
  useTransport(b.app, { send: async (m) => { sent.push(m); }, verify: async () => undefined });
  await checkMail(b.app);
  const signUp = (body: Record<string, unknown>) => b.api(null, "POST", "/api/signup", body, { "x-forwarded-for": `10.7.${Math.floor(++n / 250)}.${n % 250}` });
  const accounts = () => b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n;
  const mails = async () => { await settleMail(b.app); return sent.filter((m) => m.subject === "Confirm your email address"); };
  return { b, sent, signUp, accounts, mails };
}

test("pressing the button again with the same attempt finds the account: one account, one confirmation, a working session", async (t) => {
  const { b, signUp, accounts, mails } = await boot();
  t.after(b.close);
  const first = await signUp({ email: "ana@example.org", displayName: "Ana", attempt: ATTEMPT });
  assert.equal(first.status, 200, first.text);
  const second = await signUp({ email: "Ana@Example.org", displayName: "Ana", attempt: ATTEMPT });
  assert.equal(second.status, 200, second.text);
  assert.equal(accounts(), 1, "one account");
  assert.equal((await mails()).length, 1, "one confirmation mail");
  assert.equal(second.json.recoveryCodes.length, 10);
  assert.notDeepEqual(second.json.recoveryCodes, first.json.recoveryCodes, "the first set may never have been seen: this is a fresh one");
  assert.equal(second.json.recoveryGeneration, first.json.recoveryGeneration + 1);
  // Only the latest set works.
  const old = await b.api(null, "POST", "/api/auth/recovery", { code: first.json.recoveryCodes[0] }, { "x-forwarded-for": "10.8.0.1" });
  assert.equal(old.status, 401);
  const fresh = await b.api(null, "POST", "/api/auth/recovery", { code: second.json.recoveryCodes[0] }, { "x-forwarded-for": "10.8.0.2" });
  assert.equal(fresh.status, 200);
  // The second response started a session for that account.
  const cookie = setCookie(second, "purss_session")!.pair;
  const session = await b.api({ cookie, csrf: "" }, "GET", "/api/session");
  assert.equal(session.json.state, "signed_in");
  assert.equal(session.json.account.id, b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_attempts")!.n, 1);
});

test("a different address on the second try is a new sign-up: a repeat never changes an account's address", async (t) => {
  const { b, sent, signUp, accounts, mails } = await boot();
  t.after(b.close);
  await signUp({ email: "ana@exmaple.org", attempt: ATTEMPT });
  await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  assert.equal(accounts(), 2);
  await mails();
  assert.deepEqual(sent.filter((m) => m.subject === "Confirm your email address").map((m) => m.to).sort(), ["ana@example.org", "ana@exmaple.org"]);
});

test("a different attempt, no attempt, or a malformed one is a new sign-up, as before", async (t) => {
  const { b, signUp, accounts, mails } = await boot();
  t.after(b.close);
  await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  await signUp({ email: "ana@example.org", attempt: "Zr7Qw1Xe5Ty3Ui9Op2As4D" });
  assert.equal(accounts(), 2, "another attempt is another sign-up");
  await signUp({ email: "ana@example.org" });
  await signUp({ email: "ana@example.org" });
  assert.equal(accounts(), 4, "without an attempt id every press makes an account");
  assert.equal((await signUp({ email: "ana@example.org", attempt: "short" })).status, 400);
  assert.equal(accounts(), 4);
  assert.equal((await mails()).length, 4);
});

test("an attempt is picked up only while its sign-up session still holds setup permission and nothing was set up", async (t) => {
  const { b, signUp, accounts } = await boot();
  t.after(b.close);
  const accountId = () => b.app.db.get<{ id: string }>("SELECT id FROM accounts ORDER BY created_at DESC, rowid DESC LIMIT 1")!.id;

  // Finished: the account has a way to sign in other than its recovery codes.
  await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  await writePassword(b.app, accountId(), "ana-ana", "a long enough password");
  await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  assert.equal(accounts(), 2, "once the account is set up, the same attempt id makes a new one");

  // Set up once and the method removed again: still finished.
  const bo = "Lm4Nb6Vc8Xz0Qa2Ws5Ed7R";
  await signUp({ email: "bo@example.org", attempt: bo });
  b.app.db.run("UPDATE account_enrollment SET durable_method_exists = 1 WHERE account_id = ?", accountId());
  await signUp({ email: "bo@example.org", attempt: bo });
  assert.equal(accounts(), 4);

  // Past the sign-up session's 30 minutes of setup permission.
  const cy = "Pq1Rs2Tu3Vw4Xy5Za6Bc7D";
  await signUp({ email: "cy@example.org", attempt: cy });
  b.app.db.run("UPDATE sessions SET setup_permission_expires_at = ? WHERE account_id = ?", addSeconds(-60), accountId());
  await signUp({ email: "cy@example.org", attempt: cy });
  assert.equal(accounts(), 6);

  // Signed out: the sign-up session is gone.
  const di = "Ef8Gh9Ij0Kl1Mn2Op3Qr4S";
  const first = await signUp({ email: "di@example.org", attempt: di });
  const cookie = setCookie(first, "purss_session")!.pair;
  const csrf = (await b.api({ cookie, csrf: "" }, "GET", "/api/session")).json.csrf as string;
  assert.equal((await b.api({ cookie, csrf }, "POST", "/api/auth/logout")).status, 200);
  await signUp({ email: "di@example.org", attempt: di });
  assert.equal(accounts(), 8);

  // The codes were confirmed as saved: replacing them now needs a real sign-in, not a repeated form.
  const ed = "Tu5Vw6Xy7Za8Bc9De0Fg1H";
  const shown = await signUp({ email: "ed@example.org", attempt: ed });
  b.app.db.run("UPDATE account_enrollment SET recovery_acknowledged_generation = ? WHERE account_id = ?", shown.json.recoveryGeneration, accountId());
  await signUp({ email: "ed@example.org", attempt: ed });
  assert.equal(accounts(), 10);

  // A code was used to sign in: the codes were saved, so they are not replaced by a repeated form either.
  const fy = "Hj2Kl3Mn4Op5Qr6St7Uv8W";
  const used = await signUp({ email: "fy@example.org", attempt: fy });
  assert.equal((await b.api(null, "POST", "/api/auth/recovery", { code: used.json.recoveryCodes[0] }, { "x-forwarded-for": "10.8.1.1" })).status, 200);
  await signUp({ email: "fy@example.org", attempt: fy });
  assert.equal(accounts(), 12);
  assert.equal((await b.api(null, "POST", "/api/auth/recovery", { code: used.json.recoveryCodes[1] }, { "x-forwarded-for": "10.8.1.2" })).status, 200, "the saved codes still work");
});

test("a repeat keeps the first sign-up's setup deadline and replaces its session", async (t) => {
  const { b, signUp, accounts } = await boot();
  t.after(b.close);
  await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  const deadline = addSeconds(5 * 60);
  b.app.db.run("UPDATE sessions SET setup_permission_expires_at = ?", deadline);
  const again = await signUp({ email: "ana@example.org", attempt: ATTEMPT });
  assert.equal(again.status, 200);
  assert.equal(accounts(), 1);
  const rows = b.app.db.all<{ setup_permission_expires_at: string }>("SELECT setup_permission_expires_at FROM sessions");
  assert.deepEqual(rows.map((r) => r.setup_permission_expires_at), [deadline], "one session, with the original deadline");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'signup_resume'")?.n, 1, "the resume is in the audit log");
});

test("pressing twice at once never makes two accounts", async (t) => {
  const { b, signUp, accounts, mails } = await boot();
  t.after(b.close);
  const [a, c] = await Promise.all([signUp({ email: "ana@example.org", attempt: ATTEMPT }), signUp({ email: "ana@example.org", attempt: ATTEMPT })]);
  assert.deepEqual([a.status, c.status], [200, 200]);
  assert.equal(accounts(), 1);
  assert.equal((await mails()).length, 1);
});

test("a new hosted account has no storage limit", async (t) => {
  const { b, signUp } = await boot();
  t.after(b.close);
  assert.equal((await signUp({ email: "ana@example.org", attempt: ATTEMPT })).status, 200);
  const rows = b.app.db.all<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts");
  assert.deepEqual(rows.map((r) => r.allocation_bytes), [null], "no allocation unless an administrator sets one");
});
