import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, setCookie } from "../deletion-testing.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import type { Message } from "../mail/mailer.ts";
import { checkPassword } from "./passwords.ts";

/* Sign-up makes the account with its username and password and returns no codes. */

const HOSTED = { PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_TRUST_PROXY: "1", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
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
  const out = await signUp({ email: "ana@example.org", username: "Ana-Ana" });
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

test("pressing twice makes one account: the second press is told the username is taken and gets no session", async (t) => {
  const { b, signUp, accounts, mails, signedIn } = await boot();
  t.after(b.close);
  const body = { email: "ana@example.org", username: "ana-ana" };
  const [x, y] = await Promise.all([signUp(body), signUp(body)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const refused = x.status === 409 ? x : y;
  assert.equal(refused.json.error.code, "username_taken");
  assert.equal(await signedIn(refused), null, "no session cookie came with the refusal");
  assert.equal(accounts(), 1);
  assert.equal((await mails()).length, 1, "one confirmation mail");
});

test("a new hosted account has no storage limit", async (t) => {
  const { b, signUp } = await boot();
  t.after(b.close);
  assert.equal((await signUp({ email: "ana@example.org" })).status, 200);
  const rows = b.app.db.all<{ allocation_bytes: number | null }>("SELECT allocation_bytes FROM storage_accounts");
  assert.deepEqual(rows.map((r) => r.allocation_bytes), [null], "no allocation unless an administrator sets one");
});
