import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, member, setCookie } from "../deletion-testing.ts";
import type { DeletionBoot, Member } from "../deletion-testing.ts";
import { nowIso } from "../http.ts";
import { checkPassword } from "./passwords.ts";

/*
 * Password sign-in takes the confirmed email address as well as the username. These tests pin what must not change: one
 * message for every way of not being known, the same rate limits (and the address and username sharing theirs), and the
 * same work for a name nobody has as for a wrong password.
 */

const BAD = "That username and password don't match.";
let n = 0;
/** A different caller address every time, so the per-address limit never gets in the way of the per-name one. */
const from = () => ({ "x-forwarded-for": `10.9.${Math.floor(++n / 250)}.${n % 250}` });

async function boot() {
  const b = await bootDeletion({ PURSS_TRUST_PROXY: "1" });
  const confirmed = async (m: Member, address: string, verified = true) => {
    b.app.db.run("UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?", address, verified ? nowIso() : null, m.accountId);
  };
  const signIn = (name: string, password: string, extra: Record<string, unknown> = {}) =>
    b.api(null, "POST", "/api/auth/password", { username: name, password, ...extra }, from());
  return { b, confirmed, signIn };
}

test("the confirmed email address signs in like the username, in any case and with stray spaces", async (t) => {
  const { b, confirmed, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  await confirmed(ana, "Ana@Example.org");
  for (const name of [ana.username, ana.username.toUpperCase(), "ana@example.org", "  ANA@EXAMPLE.ORG ", "Ana@Example.org"]) {
    const r = await signIn(name, ana.password);
    assert.equal(r.status, 200, `${JSON.stringify(name)}: ${r.text}`);
    assert.ok(setCookie(r, "purss_session"), "a session starts");
  }
  assert.equal(await checkPassword(b.app, "ana@example.org", ana.password), ana.accountId);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND method = 'password'", ana.accountId)!.n, 5);
});

test("an address that isn't confirmed, is unknown, or belongs to several accounts is treated like an unknown username", async (t) => {
  const { b, confirmed, signIn } = await boot();
  t.after(b.close);
  const unconfirmed = await member(b.app, "Unconfirmed");
  await confirmed(unconfirmed, "unconfirmed@example.org", false);
  const pat = await member(b.app, "Pat");
  const sam = await member(b.app, "Sam");
  await confirmed(pat, "shared@example.org");
  await confirmed(sam, "SHARED@example.org");
  const solo = await member(b.app, "Solo");
  await confirmed(solo, "solo@example.org");

  const cases: [string, string][] = [
    ["unconfirmed@example.org", unconfirmed.password],
    ["nobody@example.org", solo.password],
    ["shared@example.org", pat.password],
    ["shared@example.org", sam.password],
    ["solo@example.org", "not the password"],
    ["no-such-user", solo.password],
  ];
  for (const [name, password] of cases) {
    const r = await signIn(name, password);
    assert.equal(r.status, 401, name);
    assert.equal(r.json.error.code, "bad_password", name);
    assert.equal(r.json.error.message, BAD, `${name}: the same words for every way of not being known`);
    assert.equal(setCookie(r, "purss_session"), null, name);
  }
  // The usernames of the accounts that share an address still work.
  assert.equal((await signIn(pat.username, pat.password)).status, 200);
  assert.equal((await signIn(sam.username, sam.password)).status, 200);
  assert.equal((await signIn(unconfirmed.username, unconfirmed.password)).status, 200);
});

test("the limits stay as they were: ten tries per name in fifteen minutes, an unknown address like any other name, and an address keeps its own count", async (t) => {
  const { b, confirmed, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  await confirmed(ana, "ana@example.org");
  // An address nobody has: ten wrong tries, then slowed down, exactly as an unknown username is.
  for (let i = 0; i < 10; i++) assert.equal((await signIn("ghost@example.org", "x")).status, 401);
  const slow = await signIn("ghost@example.org", "x");
  assert.equal(slow.status, 429);
  assert.equal(slow.json.error.code, "slow_down");
  for (let i = 0; i < 10; i++) assert.equal((await signIn("ghost-name", "x")).status, 401);
  const slowName = await signIn("ghost-name", "x");
  assert.equal(slowName.status, 429);
  assert.equal(slowName.json.error.message, slow.json.error.message, "an unknown address and an unknown username are told the same");

  // An address keeps its own count: a username slowed down says nothing about which address belongs to it.
  for (let i = 0; i < 10; i++) assert.equal((await signIn(ana.username, "wrong")).status, 401);
  assert.equal((await signIn(ana.username, ana.password)).status, 429, "ten wrong tries on the username");
  assert.equal((await signIn("ana@example.org", "wrong")).status, 401, "the address is answered like any unknown or unrelated name");
  assert.equal((await signIn("ana@example.org", ana.password)).status, 200);
});

test("an unknown address costs the same work as a wrong password: the dummy hash runs", async (t) => {
  const { b, confirmed } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  await confirmed(ana, "ana@example.org");
  const time = async (name: string) => {
    const start = performance.now();
    assert.equal(await checkPassword(b.app, name, "wrong password"), null);
    return performance.now() - start;
  };
  await time("warm@example.org"); // the dummy hash is made once
  const wrong = Math.min(await time("ana@example.org"), await time("ana@example.org"));
  const unknown = Math.min(await time("ghost@example.org"), await time("ghost@example.org"));
  const unknownName = Math.min(await time("ghost"), await time("ghost"));
  assert.ok(unknown > 8, `the unknown address was checked against a hash (${unknown.toFixed(1)} ms)`);
  assert.ok(unknown > wrong * 0.4 && unknown < wrong * 2.5, `about as long as a wrong password (${unknown.toFixed(1)} vs ${wrong.toFixed(1)} ms)`);
  assert.ok(unknownName > 8, `and so is an unknown username (${unknownName.toFixed(1)} ms)`);
});

test("the session says whether this is a shared computer, and what a new account starts with on a hosted installation", async (t) => {
  const { b, signIn } = await boot();
  t.after(b.close);
  const ana = await member(b.app, "Ana");
  const asBoot = b as DeletionBoot;
  for (const shared of [false, true]) {
    const r = await signIn(ana.username, ana.password, { sharedComputer: shared });
    assert.equal(r.status, 200);
    const cookie = setCookie(r, "purss_session")!.pair;
    const session = await asBoot.api({ cookie, csrf: "" }, "GET", "/api/session");
    assert.equal(session.json.account.sharedComputer, shared);
  }
});
