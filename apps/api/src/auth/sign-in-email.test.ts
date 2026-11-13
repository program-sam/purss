import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, member, setCookie } from "../deletion-testing.ts";
import type { DeletionBoot } from "../deletion-testing.ts";
import { checkPassword } from "./passwords.ts";

/*
 * Password sign-in is by email address. These tests pin what must not change: the address matches in any case, one
 * message for every way of not being known, ten tries per address, and the same work for an address nobody has as
 * for a wrong password.
 */

const BAD = "That email address and password don't match.";
let n = 0;
/** A different caller address every time, so the per-network-address limit never gets in the way of the per-email one. */
const from = () => ({ "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}` });

async function boot() {
  const b = await bootDeletion({ PURSS_TRUST_PROXY: "1" });
  const setEmail = (accountId: string, address: string) => b.app.db.run("UPDATE accounts SET email = ? WHERE id = ?", address, accountId);
  const signIn = (email: string, password: string, extra: Record<string, unknown> = {}) =>
    b.api(null, "POST", "/api/auth/password", { email, password, ...extra }, from());
  return { b, setEmail, signIn };
}

test("the address signs in in any case and with stray spaces, confirmed or not", async (t) => {
  const { b, setEmail, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  setEmail(ana.accountId, "Ana@Example.org");
  for (const email of ["ana@example.org", "  ANA@EXAMPLE.ORG ", "Ana@Example.org"]) {
    const r = await signIn(email, ana.password);
    assert.equal(r.status, 200, `${JSON.stringify(email)}: ${r.text}`);
    assert.ok(setCookie(r, "purss_session"), "a session starts");
  }
  assert.equal(await checkPassword(b.app, "ana@example.org", ana.password), ana.accountId);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND method = 'password'", ana.accountId)!.n, 3);
});

test("each address belongs to one account, compared without regard to case", async (t) => {
  const { b, setEmail } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  const bo = await member(b.app, "Bo");
  setEmail(ana.accountId, "shared@example.org");
  assert.throws(() => setEmail(bo.accountId, "SHARED@example.org"), /UNIQUE/);
});

test("an unknown address, a wrong password, or no address at all are told the same", async (t) => {
  const { b, setEmail, signIn } = await boot();
  t.after(b.close);
  const solo = await member(b.app, "Solo");
  setEmail(solo.accountId, "solo@example.org");
  for (const [email, password] of [["nobody@example.org", solo.password], ["solo@example.org", "not the password"], ["", solo.password], ["solo", solo.password]] as const) {
    const r = await signIn(email, password);
    assert.equal(r.status, 401, email);
    assert.equal(r.json.error.code, "bad_password", email);
    assert.equal(r.json.error.message, BAD, `${email}: the same words for every way of not being known`);
    assert.equal(setCookie(r, "purss_session"), null, email);
  }
});

test("ten tries per address in fifteen minutes, known or not, in any case", async (t) => {
  const { b, setEmail, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  setEmail(ana.accountId, "limited@example.org");
  for (let i = 0; i < 10; i++) assert.equal((await signIn("ghost@example.org", "x")).status, 401);
  const slow = await signIn("ghost@example.org", "x");
  assert.equal(slow.status, 429);
  assert.equal(slow.json.error.code, "slow_down");
  for (let i = 0; i < 10; i++) assert.equal((await signIn(i % 2 ? "LIMITED@example.org" : "limited@example.org", "wrong")).status, 401);
  const slowKnown = await signIn("limited@example.org", ana.password);
  assert.equal(slowKnown.status, 429, "ten wrong tries on the address, whatever its case");
  assert.equal(slowKnown.json.error.message, slow.json.error.message, "a known address is slowed down like an unknown one");
});

test("someone spending an address's tries can't keep its person out of a browser they signed in from", async (t) => {
  const { b, setEmail, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  setEmail(ana.accountId, "ana@example.org");
  const first = await signIn("ana@example.org", ana.password);
  assert.equal(first.status, 200);
  const known = setCookie(first, "purss_known");
  assert.ok(known && /Path=\/api\/auth\//.test(known.header) && /HttpOnly/.test(known.header), known?.header ?? "no purss_known cookie");
  const withKnown = (password: string) => b.api(null, "POST", "/api/auth/password", { email: "ana@example.org", password }, { ...from(), cookie: known!.pair });

  // A stranger spends the address's shared tries; without the cookie even the right password waits.
  for (let i = 0; i < 10; i++) assert.equal((await signIn("ana@example.org", `guess ${i}`)).status, 401);
  assert.equal((await signIn("ana@example.org", ana.password)).status, 429);
  // Ana's browser has tries of its own, and a correct password gives them back.
  assert.equal((await withKnown(ana.password)).status, 200, "the browser Ana used before still signs in");
  for (let i = 0; i < 9; i++) assert.equal((await withKnown(`typo ${i}`)).status, 401);
  assert.equal((await withKnown(ana.password)).status, 200, "nine typos and then the right password");
  for (let i = 0; i < 10; i++) await withKnown(`typo ${i}`);
  assert.equal((await withKnown(ana.password)).status, 429, "the browser's own tries are limited too");

  // Others failing on the same network address (shared Wi-Fi) use up that address's tries, not the known browser's.
  const cafe = { "x-forwarded-for": "10.77.0.1" };
  for (let i = 0; i < 10; i++) await b.api(null, "POST", "/api/auth/password", { email: `stranger${i}@example.org`, password: "x" }, cafe);
  assert.equal((await b.api(null, "POST", "/api/auth/password", { email: "someone@example.org", password: "x" }, cafe)).status, 429, "the café's address is spent");
  const ana2 = await b.api(null, "POST", "/api/auth/password", { email: "ana2@example.org", password: "x" }, { ...cafe, cookie: known!.pair });
  assert.equal(ana2.status, 429, "a cookie for another address doesn't lift the network limit");

  // The cookie is only good for the address it was given for, and a forged one counts as none.
  const bo = await member(b.app, "Bo");
  setEmail(bo.accountId, "bo@example.org");
  for (let i = 0; i < 10; i++) await signIn("bo@example.org", `guess ${i}`);
  const borrowed = await b.api(null, "POST", "/api/auth/password", { email: "bo@example.org", password: bo.password }, { ...from(), cookie: known!.pair });
  assert.equal(borrowed.status, 429, "Ana's cookie gives no tries for Bo's address");
  const forged = await b.api(null, "POST", "/api/auth/password", { email: "bo@example.org", password: bo.password }, { ...from(), cookie: "purss_known=abc.def" });
  assert.equal(forged.status, 429);
});

test("a browser that signed in before isn't kept out by others failing on the same network address", async (t) => {
  const { b, setEmail } = await boot();
  t.after(b.close);
  const dee = await member(b.app, "Dee");
  setEmail(dee.accountId, "dee@example.org");
  const office = { "x-forwarded-for": "10.88.0.1" };
  const first = await b.api(null, "POST", "/api/auth/password", { email: "dee@example.org", password: dee.password }, office);
  const known = setCookie(first, "purss_known")!;
  for (let i = 0; i < 10; i++) await b.api(null, "POST", "/api/auth/password", { email: `colleague${i}@example.org`, password: "x" }, office);
  assert.equal((await b.api(null, "POST", "/api/auth/password", { email: "dee@example.org", password: dee.password }, office)).status, 429, "without the cookie, the office's address is spent");
  assert.equal((await b.api(null, "POST", "/api/auth/password", { email: "dee@example.org", password: dee.password }, { ...office, cookie: known.pair })).status, 200);
});

test("someone not signed in can send only a small body: sign-in forms are small, and many large ones would add up", async (t) => {
  const { b, signIn } = await boot();
  t.after(b.close);
  const big = await signIn("small-body@example.org", "x".repeat(70 * 1024));
  assert.equal(big.status, 413);
  assert.equal((await signIn("small-body@example.org", "x".repeat(1000))).status, 401, "an ordinary attempt is read");
});

test("parallel guesses can't get past the limit while the password is being checked", async (t) => {
  const { b, setEmail, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  setEmail(ana.accountId, "parallel@example.org");
  const statuses = (await Promise.all(Array.from({ length: 30 }, (_, i) => signIn("parallel@example.org", `guess ${i}`)))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 10, statuses.join(","));
  assert.equal(statuses.filter((s) => s === 429).length, 20);
});

test("an unknown address costs the same work as a wrong password: the dummy hash runs", async (t) => {
  const { b, setEmail } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  setEmail(ana.accountId, "ana@example.org");
  const time = async (email: string) => {
    const start = performance.now();
    assert.equal(await checkPassword(b.app, email, "wrong password"), null);
    return performance.now() - start;
  };
  await time("warm@example.org"); // the dummy hash is made once
  const wrong = Math.min(await time("ana@example.org"), await time("ana@example.org"));
  const unknown = Math.min(await time("ghost@example.org"), await time("ghost@example.org"));
  assert.ok(unknown > 8, `the unknown address was checked against a hash (${unknown.toFixed(1)} ms)`);
  assert.ok(unknown > wrong * 0.4 && unknown < wrong * 2.5, `about as long as a wrong password (${unknown.toFixed(1)} vs ${wrong.toFixed(1)} ms)`);
});

test("the session says whether this is a shared computer", async (t) => {
  const { b, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  const asBoot = b as DeletionBoot;
  for (const shared of [false, true]) {
    const r = await signIn(ana.email, ana.password, { sharedComputer: shared });
    assert.equal(r.status, 200);
    const cookie = setCookie(r, "purss_session")!.pair;
    const session = await asBoot.api({ cookie, csrf: "" }, "GET", "/api/session");
    assert.equal(session.json.account.sharedComputer, shared);
    assert.equal(session.json.account.email, ana.email);
  }
});
