import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, setCookie } from "../deletion-testing.ts";
import { addSeconds } from "../http.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import type { Message } from "../mail/mailer.ts";
import { checkPassword } from "./passwords.ts";

/*
 * Sign-up makes the account with its username and password and returns no codes. It is also idempotent per attempt: the browser
 * sends a random id with the form, and an earlier press with the same id (a double press, or a new try after the page was
 * closed) signs in to the account it made, provided it gives the same email address and password, instead of making another
 * one and sending another confirmation.
 */

const HOSTED = { PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_TRUST_PROXY: "1", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
const ATTEMPT = "Qk3mZpT0xv8sLw2YcA9RhA";
const PASSWORD = "tidal flats at low water";
let n = 0;

async function boot() {
  const b = await bootDeletion(HOSTED);
  const sent: Message[] = [];
  useTransport(b.app, { send: async (m) => { sent.push(m); }, verify: async () => undefined });
  await checkMail(b.app);
  // Every call is a different person unless it says otherwise: its own address, and a username of its own.
  const signUp = (body: Record<string, unknown>) => b.api(null, "POST", "/api/signup", { username: `reader${++n}`, password: PASSWORD, ...body }, { "x-forwarded-for": `10.7.${Math.floor(n / 250)}.${n % 250}` });
  const accounts = () => b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n;
  const mails = async () => { await settleMail(b.app); return sent.filter((m) => m.subject === "Confirm your email address"); };
  const signedIn = async (reply: Awaited<ReturnType<typeof signUp>>) => {
    const cookie = setCookie(reply, "purss_session")?.pair;
    return cookie ? (await b.api({ cookie, csrf: "" }, "GET", "/api/session")).json : null;
  };
  return { b, sent, signUp, accounts, mails, signedIn };
}

test("sign-up makes the account with a password and no codes, and starts a session that can add a passkey at once", async (t) => {
  const { b, signUp, signedIn } = await boot();
  t.after(b.close);
  const out = await signUp({ email: "ana@example.org", username: "Ana-Ana", attempt: ATTEMPT });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { ok: true }, "nothing but the answer: no recovery codes");
  const accountId = b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id;
  assert.deepEqual(b.app.db.all<{ kind: string; label: string }>("SELECT kind, label FROM sign_in_methods WHERE account_id = ?", accountId).map((m) => [m.kind, m.label]), [["password", "ana-ana"]], "a password sign-in and nothing else");
  assert.equal(await checkPassword(b.app, "ana-ana", PASSWORD), accountId);
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM sign_in_methods")).includes(PASSWORD), false, "only a hash is stored");
  const session = await signedIn(out);
  assert.equal(session.state, "signed_in");
  assert.equal(session.account.hasPassword, true);
  assert.equal(session.account.hasPasskey, false);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'password_add'")!.n, 1);
  // Choosing the password counts as signing in: adding a passkey right afterwards needs no further confirmation.
  const cookie = setCookie(out, "purss_session")!.pair;
  const csrf = session.csrf as string;
  const options = await b.api({ cookie, csrf }, "POST", "/api/auth/passkey/register/options");
  assert.equal(options.status, 200, options.text);
});

test("sign-up refuses a missing, short or reused username and password, and makes nothing", async (t) => {
  const { b, signUp, accounts, mails } = await boot();
  t.after(b.close);
  assert.equal((await signUp({ email: "ana@example.org", username: undefined })).status, 400);
  assert.equal((await signUp({ email: "ana@example.org", password: undefined })).status, 400);
  assert.equal((await signUp({ email: "ana@example.org", username: "ab" })).json.error.code, "bad_username");
  assert.equal((await signUp({ email: "ana@example.org", password: "short" })).json.error.code, "short_password");
  assert.equal((await signUp({ email: "ana@example.org", username: "tidalflatsx", password: "tidalflatsx" })).json.error.code, "weak_password");
  assert.equal(accounts(), 0);
  assert.equal((await signUp({ email: "ana@example.org", username: "taken-name" })).status, 200);
  const clash = await signUp({ email: "bo@example.org", username: "Taken-Name" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "username_taken");
  assert.equal(accounts(), 1, "the refused sign-up left no account behind");
  assert.equal((await mails()).length, 1, "and sent no confirmation");
});

test("pressing the button again with the same attempt, email address and password signs in to the account: one account, one confirmation, a working session", async (t) => {
  const { b, signUp, accounts, mails, signedIn } = await boot();
  t.after(b.close);
  const first = await signUp({ email: "ana@example.org", username: "ana-ana", displayName: "Ana", attempt: ATTEMPT });
  assert.equal(first.status, 200, first.text);
  const second = await signUp({ email: "Ana@Example.org", username: "ana-ana", displayName: "Ana", attempt: ATTEMPT });
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.json, { ok: true });
  assert.equal(accounts(), 1, "one account");
  assert.equal((await mails()).length, 1, "one confirmation mail");
  const session = await signedIn(second);
  assert.equal(session.state, "signed_in");
  assert.equal(session.account.id, b.app.db.get<{ id: string }>("SELECT id FROM accounts")!.id);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_attempts")!.n, 1);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'signup_resume'")?.n, 1, "the repeat is in the audit log");
});

test("a repeated attempt with a wrong password gets no session and the ordinary error", async (t) => {
  const { b, signUp, accounts, mails, signedIn } = await boot();
  t.after(b.close);
  assert.equal((await signUp({ email: "ana@example.org", username: "ana-ana", attempt: ATTEMPT })).status, 200);
  const wrong = await signUp({ email: "ana@example.org", username: "ana-ana", password: "somebody else's password", attempt: ATTEMPT });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error.code, "username_taken");
  assert.equal(await signedIn(wrong), null, "no session cookie came with it");
  // Neither the right password for another username... nor the right password with another address finds the account.
  const other = await signUp({ email: "ana@example.org", username: "other-ana", password: "somebody else's password", attempt: ATTEMPT });
  assert.equal(other.status, 200, "a different username and password is simply a new sign-up");
  assert.equal(accounts(), 2);
  const elsewhere = await signUp({ email: "mallory@example.org", username: "ana-ana", attempt: ATTEMPT });
  assert.equal(elsewhere.status, 409);
  assert.equal(await signedIn(elsewhere), null);
  assert.equal((await mails()).length, 2);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'signup_resume'")!.n, 0);
});

test("a different address on the second try is a new sign-up: a repeat never changes an account's address", async (t) => {
  const { b, sent, signUp, accounts, mails } = await boot();
  t.after(b.close);
  await signUp({ email: "ana@exmaple.org", username: "ana-first", attempt: ATTEMPT });
  await signUp({ email: "ana@example.org", username: "ana-second", attempt: ATTEMPT });
  assert.equal(accounts(), 2);
  await mails();
  assert.deepEqual(sent.filter((m) => m.subject === "Confirm your email address").map((m) => m.to).sort(), ["ana@example.org", "ana@exmaple.org"]);
});

test("a different attempt, no attempt, or a malformed one is a new sign-up", async (t) => {
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

test("an attempt is picked up only for an active account, within a day", async (t) => {
  const { b, signUp, accounts } = await boot();
  t.after(b.close);
  const accountId = () => b.app.db.get<{ id: string }>("SELECT id FROM accounts ORDER BY created_at DESC, rowid DESC LIMIT 1")!.id;
  const again = (username: string, attempt: string) => signUp({ email: "ana@example.org", username, attempt });

  const old = "Pq1Rs2Tu3Vw4Xy5Za6Bc7D";
  assert.equal((await again("ana-old", old)).status, 200);
  b.app.db.run("UPDATE signup_attempts SET created_at = ?", addSeconds(-25 * 3600));
  assert.equal((await again("ana-old", old)).status, 409, "a day later the same attempt finds nothing");

  const suspended = "Ef8Gh9Ij0Kl1Mn2Op3Qr4S";
  assert.equal((await again("ana-susp", suspended)).status, 200);
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", accountId());
  const refused = await again("ana-susp", suspended);
  assert.equal(refused.status, 409, "a suspended account isn't signed in by a repeat");
  assert.equal(accounts(), 2);
});

test("pressing twice at once never makes two accounts", async (t) => {
  const { b, signUp, accounts, mails } = await boot();
  t.after(b.close);
  const body = { email: "ana@example.org", username: "ana-ana", attempt: ATTEMPT };
  const [a, c] = await Promise.all([signUp(body), signUp(body)]);
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
