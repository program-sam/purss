import test from "node:test";
import assert from "node:assert/strict";
import { oidcError, oidcErrorFor } from "./oidc-errors.ts";

const providers = [{ id: "google", label: "Google" }, { id: "sso", label: "Company SSO" }];

test("a sign-in that failed names the provider that failed, not the first one set up", () => {
  assert.match(oidcErrorFor("email_in_use", "sso", providers), /connect Company SSO in Settings → Security\.$/);
  assert.match(oidcErrorFor("email_in_use", "google", providers), /connect Google in Settings → Security\.$/);
  assert.match(oidcErrorFor("not_linked", "sso", providers), /That Company SSO account isn't connected/);
  assert.match(oidcErrorFor("email_unverified", "sso", providers), /^Company SSO didn't give PURSS/);
  // No provider in the address, or one that isn't set up: the first, or none.
  assert.match(oidcErrorFor("email_in_use", undefined, providers), /connect Google in Settings/);
  assert.match(oidcErrorFor("email_in_use", "gone", providers), /connect Google in Settings/);
  assert.match(oidcErrorFor("not_linked", undefined, []), /^That external account isn't connected/);
  assert.match(oidcErrorFor("email_in_use", undefined, []), /then connect it in Settings → Security\.$/);
  assert.match(oidcErrorFor("email_unverified", undefined, []), /^The provider didn't give PURSS/);
});

test("every refusal has its own words, and anything else says the sign-in didn't work", () => {
  assert.match(oidcError("signup_full", "Google"), /full for now/);
  assert.match(oidcError("signup_rate_limited", "Google"), /Too many attempts/);
  assert.match(oidcError("account_deleting", "Google"), /being deleted/);
  assert.match(oidcError("mismatch", "Google"), /didn't work/);
  assert.match(oidcError("stale_auth", "Google"), /didn't work/);
});
