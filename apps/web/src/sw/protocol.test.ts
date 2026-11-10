import test from "node:test";
import assert from "node:assert/strict";
import { dataCacheName, foreignDataCaches, isPageMessage, parseWorkerState, shellCacheName, staleShellCaches } from "./protocol.ts";

test("cache names say what they hold and whose", () => {
  assert.equal(dataCacheName("acc_1"), "purss-api:acc_1");
  assert.equal(shellCacheName("abc"), "purss-shell:abc");
});

test("only the signed-in account's data cache survives", () => {
  const names = ["purss-shell:b1", "purss-api:acc_1", "purss-api:acc_2", "purss-worker-state", "unrelated"];
  assert.deepEqual(foreignDataCaches(names, "acc_1"), ["purss-api:acc_2"]);
  assert.deepEqual(foreignDataCaches(names, null), ["purss-api:acc_1", "purss-api:acc_2"]);
  assert.deepEqual(foreignDataCaches(names, "acc_9"), ["purss-api:acc_1", "purss-api:acc_2"]);
});

test("older builds' shells are dropped, the current one and everything else stay", () => {
  const names = ["purss-shell:old", "purss-shell:b2", "purss-api:acc_1", "purss-worker-state"];
  assert.deepEqual(staleShellCaches(names, "b2"), ["purss-shell:old"]);
});

test("page messages are checked before the worker acts on them", () => {
  assert.equal(isPageMessage({ type: "state", accountId: "a", enabled: true }), true);
  assert.equal(isPageMessage({ type: "state", accountId: null, enabled: false }), true);
  assert.equal(isPageMessage({ type: "wipe" }), true);
  assert.equal(isPageMessage({ type: "skip-waiting" }), true);
  assert.equal(isPageMessage({ type: "state", accountId: 5, enabled: true }), false);
  assert.equal(isPageMessage({ type: "state", accountId: "a" }), false);
  assert.equal(isPageMessage({ type: "other" }), false);
  assert.equal(isPageMessage(null), false);
  assert.equal(isPageMessage("wipe"), false);
});

test("a damaged remembered state means nothing is kept", () => {
  assert.deepEqual(parseWorkerState(null), { accountId: null, enabled: false });
  assert.deepEqual(parseWorkerState({ accountId: 7, enabled: "yes" }), { accountId: null, enabled: false });
  assert.deepEqual(parseWorkerState({ accountId: "a", enabled: true }), { accountId: "a", enabled: true });
  assert.deepEqual(parseWorkerState({ accountId: "", enabled: true }), { accountId: null, enabled: true });
});
