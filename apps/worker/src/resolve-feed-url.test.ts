import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgeRoutePath } from "@purss/connectors";
import { resolveFeedUrl } from "./secrets.ts";

test("private feed references resolve from the secrets directory only", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-secret-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = "src_0000000000aaaaaaaaaaaaaaaa";
  mkdirSync(path.join(dir, "source-urls"));
  writeFileSync(path.join(dir, "source-urls", id), "https://example.org/feed?token=s3cret\n");
  assert.equal(resolveFeedUrl(dir, "https://example.org/feed"), "https://example.org/feed");
  assert.equal(resolveFeedUrl(dir, `secret:source-urls/${id}`), "https://example.org/feed?token=s3cret");
  assert.equal(resolveFeedUrl(dir, "secret:source-urls/src_0000000000bbbbbbbbbbbbbbbb"), null, "missing secret");
  assert.equal(resolveFeedUrl(dir, "secret:source-urls/../../service-token"), null, "no path traversal");
  assert.equal(resolveFeedUrl(dir, "secret:other/x"), null);
});

test("a bridged source becomes the router address signed with the bridge key", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveFeedUrl(dir, "bridge:telegram/durov"), null, "no key, no address");
  const key = "q".repeat(43);
  writeFileSync(path.join(dir, "bridge-key"), `${key}\n`);
  assert.equal(resolveFeedUrl(dir, "bridge:telegram/durov"), `http://feed-bridge.internal:8945${bridgeRoutePath(key, "telegram", "durov")}`);
  assert.equal(resolveFeedUrl(dir, "bridge:telegram/durov", "http://bridge.test:1/"), `http://bridge.test:1${bridgeRoutePath(key, "telegram", "durov")}`);
  assert.equal(resolveFeedUrl(dir, "bridge:instagram/nasa"), null, "not catalogued");
  assert.equal(resolveFeedUrl(dir, "bridge:telegram/../../x"), null);
});
