import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApns } from "./apns.ts";
import { ConfigError, loadConfig, loadHandleSecret } from "./config.ts";
import { createFcm } from "./fcm.ts";
import { tempDir } from "./testing.ts";

test("defaults leave both platforms unconfigured", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8950);
  assert.equal(config.fcm, null);
  assert.equal(config.apns, null);
  assert.equal(config.trustProxy, false);
  assert.ok(config.dataDir.endsWith(path.join("data", "push-relay")));
  assert.equal(config.secretFile, path.join(config.dataDir, "handle-secret"));
});

test("platform settings and APNs defaults", () => {
  const config = loadConfig({
    PURSS_RELAY_FCM_CREDENTIALS: "/c.json", PURSS_RELAY_APNS_KEY: "/k.p8", PURSS_RELAY_APNS_KEY_ID: "K", PURSS_RELAY_APNS_TEAM_ID: "T",
    PURSS_RELAY_APNS_SANDBOX_URL: "", PURSS_RELAY_TRUST_PROXY: "1", PURSS_RELAY_PORT: "0",
  });
  assert.deepEqual(config.fcm, { credentials: "/c.json", url: "https://fcm.googleapis.com" });
  assert.deepEqual(config.apns, { key: "/k.p8", keyId: "K", teamId: "T", topic: "app.purss", url: "https://api.push.apple.com", sandboxUrl: "" });
  assert.equal(config.trustProxy, true);
  assert.equal(loadConfig({ PURSS_RELAY_APNS_KEY: "/k", PURSS_RELAY_APNS_KEY_ID: "K", PURSS_RELAY_APNS_TEAM_ID: "T" }).apns!.sandboxUrl, "https://api.sandbox.push.apple.com");
});

test("partial APNs settings and a bad port fail fast", () => {
  assert.throws(() => loadConfig({ PURSS_RELAY_APNS_KEY: "/k" }), ConfigError);
  assert.throws(() => loadConfig({ PURSS_RELAY_PORT: "99999" }), ConfigError);
  assert.throws(() => loadConfig({ PURSS_RELAY_PORT: "abc" }), ConfigError);
});

test("the handle secret is created once with mode 0600 and then reused", () => {
  const temp = tempDir();
  try {
    const file = path.join(temp.dir, "nested", "handle-secret");
    const first = loadHandleSecret(file);
    assert.equal(first.length, 32);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadHandleSecret(file), first);
    assert.deepEqual(readFileSync(file), first);
    writeFileSync(path.join(temp.dir, "short"), "tiny");
    assert.throws(() => loadHandleSecret(path.join(temp.dir, "short")), ConfigError);
  } finally {
    temp.remove();
  }
});

test("malformed credential files stop the providers from being built", () => {
  const temp = tempDir();
  try {
    const file = (name: string, content: string) => { const p = path.join(temp.dir, name); writeFileSync(p, content); return p; };
    mkdirSync(temp.dir, { recursive: true });
    const now = () => 0;
    assert.throws(() => createFcm({ credentials: file("a.json", "not json"), url: "http://x" }, now), ConfigError);
    assert.throws(() => createFcm({ credentials: file("b.json", JSON.stringify({ project_id: "p" })), url: "http://x" }, now), /client_email/);
    assert.throws(() => createFcm({ credentials: file("c.json", JSON.stringify({ project_id: "p", client_email: "e", token_uri: "u", private_key: "nope" })), url: "http://x" }, now), /private_key/);
    assert.throws(() => createFcm({ credentials: path.join(temp.dir, "missing.json"), url: "http://x" }, now), ConfigError);
    const apns = (key: string) => ({ key, keyId: "K", teamId: "T", topic: "t", url: "http://x", sandboxUrl: "" });
    assert.throws(() => createApns(apns(file("d.p8", "garbage")), now), ConfigError);
    assert.throws(() => createApns(apns(path.join(temp.dir, "missing.p8")), now), ConfigError);
  } finally {
    temp.remove();
  }
});
