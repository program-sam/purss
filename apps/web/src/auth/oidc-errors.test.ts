import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/copy/app";
import { oidcError, oidcErrorFor } from "./oidc-errors.ts";

const t = app.auth.oidcErrors;
const providers = [{ id: "google", label: "Google" }, { id: "sso", label: "Company SSO" }];

test("a sign-in that failed names the provider that failed, not the first one set up", () => {
  assert.equal(oidcErrorFor("email_in_use", "sso", providers), t.emailInUse("Company SSO"));
  assert.equal(oidcErrorFor("email_in_use", "google", providers), t.emailInUse("Google"));
  assert.equal(oidcErrorFor("not_linked", "sso", providers), t.notLinked("Company SSO"));
  assert.equal(oidcErrorFor("email_unverified", "sso", providers), t.emailUnverified("Company SSO"));
  // No provider in the address, or one that isn't set up: the first, or none.
  assert.equal(oidcErrorFor("email_in_use", undefined, providers), t.emailInUse("Google"));
  assert.equal(oidcErrorFor("email_in_use", "gone", providers), t.emailInUse("Google"));
  assert.equal(oidcErrorFor("not_linked", undefined, []), t.notLinked(undefined));
  assert.equal(oidcErrorFor("email_in_use", undefined, []), t.emailInUse(undefined));
  assert.equal(oidcErrorFor("email_unverified", undefined, []), t.emailUnverified(undefined));
});

test("every refusal has its own words, and anything else says the sign-in didn't work", () => {
  assert.equal(oidcError("signup_full", "Google"), t.signupFull);
  assert.equal(oidcError("signup_rate_limited", "Google"), t.signupRateLimited);
  assert.equal(oidcError("account_deleting", "Google"), t.deleting);
  assert.equal(oidcError("mismatch", "Google"), t.didntWork);
  assert.equal(oidcError("stale_auth", "Google"), t.didntWork);
});
