import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { issuerKey, loadConfig } from "./config.ts";

const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("a variable passed through empty, as Compose does for one the operator didn't set, means its default", () => {
  const blank = loadConfig({ PURSS_DATA_DIR: "/tmp/purss-config-test", PURSS_DISK_RESERVE_BYTES: "", PURSS_SYNC_INTERVAL: " ", PURSS_SIGNUP_DAILY_LIMIT: "", PURSS_OIDC: "" });
  const unset = loadConfig({ PURSS_DATA_DIR: "/tmp/purss-config-test" });
  assert.equal(blank.diskReserveBytes, 1024 ** 3);
  assert.equal(blank.syncIntervalSeconds, unset.syncIntervalSeconds);
  assert.equal(blank.signupDailyLimit, unset.signupDailyLimit);
  assert.deepEqual(blank.oidc, []);
  assert.equal(loadConfig({ PURSS_DATA_DIR: "/tmp/purss-config-test", PURSS_DISK_RESERVE_BYTES: "0" }).diskReserveBytes, 0, "an explicit 0 is still 0");
});

test("PURSS_OIDC providers get a step-up mode: Google's issuer chooses the account, any other re-authenticates, and a mode can be set", () => {
  const google = { id: "google", label: "Google", issuer: "https://accounts.google.com", clientId: "id.apps.googleusercontent.com", clientSecret: "s" };
  const other = { id: "sso", label: "Company SSO", issuer: "https://sso.example.org/realm", clientId: "c" };
  const load = (providers: unknown[]) => loadConfig({ PURSS_DATA_DIR: "/tmp/purss-config-test", PURSS_OIDC: JSON.stringify(providers) });
  assert.deepEqual(load([google]).oidc, [{ ...google, stepUp: "choose-account" }], "Google can't be made to ask again");
  assert.equal(load([{ ...google, issuer: "https://accounts.google.com/" }]).oidc[0]!.stepUp, "choose-account", "however its end is written");
  assert.equal(load([other]).oidc[0]!.stepUp, "reauthenticate");
  assert.equal(load([{ ...google, stepUp: "reauthenticate" }]).oidc[0]!.stepUp, "reauthenticate", "what is set wins");
  assert.equal(load([{ ...other, stepUp: "choose-account" }]).oidc[0]!.stepUp, "choose-account");
  assert.throws(() => load([{ ...google, stepUp: "sometimes" }]), /stepUp for "google"/);
  assert.throws(() => load([{ ...other, issuer: "sso.example.org" }]), /issuer of "sso"/);
  assert.equal(load([{ ...other, issuer: "  https://sso.example.org/realm  " }]).oidc[0]!.issuer, "https://sso.example.org/realm", "kept as written, without the spaces");
});

test("issuer addresses are compared by their address, not their spelling", () => {
  assert.equal(issuerKey("https://accounts.google.com"), issuerKey("https://accounts.google.com/"));
  assert.equal(issuerKey("HTTPS://Accounts.Google.com/"), issuerKey("https://accounts.google.com"));
  assert.equal(issuerKey("https://sso.example.org/realm/"), issuerKey("https://sso.example.org/realm"));
  assert.notEqual(issuerKey("https://sso.example.org/realm"), issuerKey("https://sso.example.org/other"));
  assert.notEqual(issuerKey("https://sso.example.org"), issuerKey("http://sso.example.org"));
  assert.equal(issuerKey("accounts.google.com/"), "accounts.google.com", "not an address: as typed, without the slash");
});

test("every API setting documented for operators reaches the api container in Compose", () => {
  const docs = repoFile("docs/self-hosting.md");
  const table = docs.slice(docs.indexOf("**API** (`apps/api/src/config.ts`)"), docs.indexOf("**Worker** ("));
  const documented = new Set([...table.matchAll(/`(PURSS_[A-Z0-9_]+)`/g)].map((m) => m[1]!));
  const compose = repoFile("infra/compose.yaml");
  const api = compose.slice(compose.indexOf("\n  api:\n"), compose.indexOf("\n  worker:\n"));
  const passed = new Set([...api.matchAll(/^\s+(PURSS_[A-Z0-9_]+):/gm)].map((m) => m[1]!));
  // Fixed by the image or the Compose wiring itself, not operator settings.
  const wiring = new Set(["PURSS_DATA_DIR", "PURSS_DB_FILE", "PURSS_PORT", "PURSS_INTERNAL_PORT", "PURSS_WEB_DIST", "PURSS_SITE_DIST",
    // Set by infra/compose.proxy.yaml, the reverse-proxy overlay.
    "PURSS_TRUST_PROXY"]);
  const missing = [...documented].filter((v) => !passed.has(v) && !wiring.has(v));
  assert.deepEqual(missing, []);
  assert.ok(compose.includes("PURSS_DATA_DIR: /data") && repoFile("infra/compose.proxy.yaml").includes("PURSS_TRUST_PROXY"));
  // And every variable Compose reads from .env is in the guide's Compose table.
  const composeTable = docs.slice(docs.indexOf("Compose reads only the"), docs.indexOf("Other variables from the [configuration list]"));
  const listed = composeTable.replace(/`PURSS_SMTP_HOST` … `PURSS_MAIL_FROM`/, "PURSS_SMTP_ PURSS_MAIL_FROM");
  const read = new Set([...compose.matchAll(/\$\{(PURSS_[A-Z0-9_]+)/g)].map((m) => m[1]!).filter((v) => !v.startsWith("PURSS_ENGINE_ADMIN")));
  assert.deepEqual([...read].filter((v) => !listed.includes(v.startsWith("PURSS_SMTP_") ? "PURSS_SMTP_" : v)), []);
});

test("phone notifications use the project's relay unless the operator names another or turns them off", () => {
  const base = { PURSS_DATA_DIR: "/tmp/purss-config-test" };
  const official = loadConfig(base).pushRelay;
  assert.match(official ?? "", /^https:\/\//);
  assert.equal(loadConfig({ ...base, PURSS_PUSH_RELAY_URL: "official" }).pushRelay, official, "what Compose passes when the operator set nothing");
  assert.equal(loadConfig({ ...base, PURSS_PUSH_RELAY_URL: "" }).pushRelay, null);
  assert.equal(loadConfig({ ...base, PURSS_PUSH_RELAY_URL: "off" }).pushRelay, null);
  assert.equal(loadConfig({ ...base, PURSS_PUSH_RELAY_URL: "https://push.example.org/" }).pushRelay, "https://push.example.org");
  assert.equal(loadConfig({ ...base, PURSS_PUSH_RELAY_URL: "http://localhost:8950" }).pushRelay, "http://localhost:8950", "a local relay, for trying the apps");
  for (const bad of ["http://push.example.org", "https://u:p@push.example.org", "https://push.example.org/?x=1", "https://push.example.org/relay", "push.example.org"]) {
    assert.throws(() => loadConfig({ ...base, PURSS_PUSH_RELAY_URL: bad }), /PURSS_PUSH_RELAY_URL/, bad);
  }
});
