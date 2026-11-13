import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, setCookie } from "../deletion-testing.ts";
import { OPERATOR_EMAIL, makeOperator } from "../testing.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";
import type { Message } from "../mail/mailer.ts";
import { checkPassword } from "./passwords.ts";

/* Open sign-up starts with the address: the account is made only with the link that was emailed there. */

const HOSTED = { PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_TRUST_PROXY: "1", PURSS_PUBLIC_ORIGIN: "https://ws.example.org", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" };
const PASSWORD = "tidal flats at low water";
let n = 0;

async function boot(env: Record<string, string> = HOSTED) {
  const b = await bootDeletion(env);
  makeOperator(b.app); // claimed by its operator first: nobody signs up before (mail/mailer.ts signupOpen)
  const sent: Message[] = [];
  useTransport(b.app, { send: async (m) => { sent.push(m); }, verify: async () => undefined });
  await checkMail(b.app);
  // Every call comes from a different network address unless it says otherwise.
  const from = () => ({ "x-forwarded-for": `10.7.${Math.floor(++n / 250)}.${n % 250}` });
  const start = (email: string) => b.api(null, "POST", "/api/signup/start", { email }, from());
  const finish = (body: Record<string, unknown>) => b.api(null, "POST", "/api/signup", { password: PASSWORD, ...body }, from());
  const accounts = () => b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts WHERE email IS NOT 'operator@example.test'")!.n;
  const mail = async (subject: RegExp) => { await settleMail(b.app); return sent.filter((m) => subject.test(m.subject)); };
  /** The token in the newest "finish creating your account" message to `to`. */
  const linkFor = async (to: string) => {
    const m = (await mail(/^Finish creating/)).filter((x) => x.to === to).at(-1);
    return m ? decodeURIComponent(/\/signup\?token=([^\s"&]+)/.exec(m.text)![1]!) : null;
  };
  const signedIn = async (reply: Awaited<ReturnType<typeof finish>>) => {
    const cookie = setCookie(reply, "purss_session")?.pair;
    return cookie ? (await b.api({ cookie, csrf: "" }, "GET", "/api/session")).json : null;
  };
  return { b, sent, start, finish, accounts, mail, linkFor, signedIn };
}

test("sign-up emails a link and makes nothing; the link makes the account with that address confirmed, a password and a session", async (t) => {
  const { b, start, finish, accounts, linkFor, signedIn } = await boot();
  t.after(b.close);
  const started = await start("Ana0@Example.org");
  assert.equal(started.status, 200, started.text);
  assert.deepEqual(started.json, { ok: true });
  assert.equal(accounts(), 0, "no account until the link is used");
  const token = (await linkFor("Ana0@Example.org"))!;
  assert.ok(token, "the link went to the address");
  assert.deepEqual((await b.api(null, "POST", "/api/signup/check", { token })).json, { email: "Ana0@Example.org" });

  const out = await finish({ token, displayName: "Ana" });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { ok: true }, "nothing but the answer: no recovery codes");
  const acct = b.app.db.get<{ id: string; email: string; email_verified_at: string | null; display_name: string }>("SELECT id, email, email_verified_at, display_name FROM accounts WHERE email IS NOT 'operator@example.test'")!;
  assert.equal(acct.email, "Ana0@Example.org");
  assert.ok(acct.email_verified_at, "the link proved the address");
  assert.equal(acct.display_name, "Ana");
  assert.deepEqual(b.app.db.all<{ kind: string; label: string | null }>("SELECT kind, label FROM sign_in_methods WHERE account_id = ?", acct.id).map((m) => [m.kind, m.label]), [["password", null]], "a password sign-in and nothing else");
  assert.equal(await checkPassword(b.app, "ana0@example.org", PASSWORD), acct.id, "signs in with the address, whatever its case");
  assert.equal(JSON.stringify(b.app.db.all("SELECT * FROM sign_in_methods")).includes(PASSWORD), false, "only a hash is stored");
  const session = await signedIn(out);
  assert.equal(session.state, "signed_in");
  assert.equal(session.account.email, "Ana0@Example.org");
  assert.equal(session.account.hasPassword, true);
  // Choosing the password counts as signing in: adding a passkey right afterwards needs no further confirmation.
  const options = await b.api({ cookie: setCookie(out, "purss_session")!.pair, csrf: session.csrf as string }, "POST", "/api/auth/passkey/register/options");
  assert.equal(options.status, 200, options.text);

  // The link works once.
  assert.equal((await finish({ token })).json.error.code, "link_spent");
  assert.equal((await b.api(null, "POST", "/api/signup/check", { token })).json.error.code, "link_spent");
});

test("an address that has an account gets a note instead of a link, and the answer is the same", async (t) => {
  const { b, start, finish, accounts, mail, linkFor } = await boot();
  t.after(b.close);
  await start("ana1@example.org");
  assert.equal((await finish({ token: await linkFor("ana1@example.org") })).status, 200);
  const again = await start("ANA1@example.org");
  assert.deepEqual([again.status, again.json], [200, { ok: true }], "the same answer as for a new address");
  const notes = await mail(/^You already have/);
  assert.deepEqual(notes.map((m) => m.to), ["ANA1@example.org"]);
  assert.match(notes[0]!.text, /\/reset-password/, "with a way to reset the password");
  assert.equal(await linkFor("ANA1@example.org"), null, "and no link that could make a second account");
  assert.equal(accounts(), 1);
});

test("refused passwords leave the link usable and make nothing", async (t) => {
  const { b, start, finish, accounts, linkFor } = await boot();
  t.after(b.close);
  await start("ana2@example.org");
  const token = (await linkFor("ana2@example.org"))!;
  assert.equal((await finish({ token, password: undefined })).status, 400);
  assert.equal((await finish({ token, password: "short" })).json.error.code, "short_password");
  assert.equal((await finish({ token, password: "Ana2@Example.org" })).json.error.code, "weak_password", "not the address itself");
  assert.equal((await finish({ token: "x".repeat(40) })).json.error.code, "link_spent");
  assert.equal(accounts(), 0);
  assert.equal((await finish({ token })).status, 200, "the link still works");
});

test("pressing twice makes one account and the second press gets no session", async (t) => {
  const { b, start, finish, accounts, linkFor, signedIn } = await boot();
  t.after(b.close);
  await start("ana3@example.org");
  const token = (await linkFor("ana3@example.org"))!;
  const [x, y] = await Promise.all([finish({ token }), finish({ token })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
  const refused = x.status === 400 ? x : y;
  assert.equal(refused.json.error.code, "link_spent");
  assert.equal(await signedIn(refused), null, "no session cookie came with the refusal");
  assert.equal(accounts(), 1);
});

test("of two links to one address the first used makes the account and the other is refused", async (t) => {
  const { b, start, finish, accounts, linkFor } = await boot();
  t.after(b.close);
  await start("ana4@example.org");
  const first = (await linkFor("ana4@example.org"))!;
  await start("ana4@example.org");
  const second = (await linkFor("ana4@example.org"))!;
  assert.notEqual(first, second);
  assert.equal((await finish({ token: second })).status, 200);
  assert.equal((await finish({ token: first })).json.error.code, "email_in_use");
  assert.equal(accounts(), 1);
});

test("one address is sent at most three sign-up messages an hour", async (t) => {
  const { b, start, mail } = await boot();
  t.after(b.close);
  for (let i = 0; i < 5; i++) assert.deepEqual((await start("flood@example.org")).json, { ok: true });
  assert.equal((await mail(/^Finish creating/)).length, 3);
});

test("where sign-up is closed, starting it is refused and nothing is sent", async (t) => {
  const { b, start, sent } = await boot({ ...HOSTED, PURSS_SIGNUP: "invite" });
  t.after(b.close);
  assert.equal((await start("ana6@example.org")).json.error.code, "closed");
  await settleMail(b.app);
  assert.equal(sent.length, 0);
});

test("a new hosted account has no storage limit", async (t) => {
  const { b, start, finish, linkFor } = await boot();
  t.after(b.close);
  await start("ana7@example.org");
  assert.equal((await finish({ token: await linkFor("ana7@example.org") })).status, 200);
  const rows = b.app.db.all<{ allocation_bytes: number | null }>("SELECT s.allocation_bytes FROM storage_accounts s JOIN accounts a ON a.id = s.account_id WHERE a.email IS NOT ?", OPERATOR_EMAIL);
  assert.deepEqual(rows.map((r) => r.allocation_bytes), [null], "no allocation unless an administrator sets one");
});

test("nobody can sign up before the installation is claimed: the setup code's administrator must come first", async (t) => {
  const { b, start } = await boot();
  t.after(b.close);
  b.app.db.exec("PRAGMA foreign_keys = OFF; DELETE FROM sessions; DELETE FROM role_grants; DELETE FROM sign_in_methods; DELETE FROM accounts; PRAGMA foreign_keys = ON;");
  const early = await start("early@example.org");
  assert.equal(early.status, 403);
  assert.equal(early.json.error.code, "closed");
  assert.equal((await b.api(null, "GET", "/api/session")).json.state, "unclaimed", "the setup code still works");
});
