import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./store.ts";

const DAY = 86_400_000;

test("registering again refreshes seen_at and keeps created_at", () => {
  const store = new Store(":memory:");
  store.register("k1", "fcm", "tok", 1000);
  store.register("k1", "fcm", "tok", 5000);
  assert.deepEqual(store.get("k1"), { key: "k1", platform: "fcm", token: "tok", apnsEnv: "production", createdAt: 1000, seenAt: 5000 });
  assert.equal(store.count(), 1);
  store.close();
});

test("at most five handles per platform and token; the oldest go and the newest stays", () => {
  const store = new Store(":memory:");
  for (let i = 1; i <= 7; i += 1) store.register(`k${i}`, "apns", "same", i * 1000);
  store.register("other", "apns", "different", 1);
  store.register("fcm-same", "fcm", "same", 1);
  assert.equal(store.get("k1"), undefined);
  assert.equal(store.get("k2"), undefined);
  for (const key of ["k3", "k4", "k5", "k6", "k7", "other", "fcm-same"]) assert.ok(store.get(key), key);
  // Re-registering the oldest survivor refreshes it instead of evicting it.
  store.register("k3", "apns", "same", 9000);
  assert.ok(store.get("k3"));
  store.register("k8", "apns", "same", 10_000);
  assert.ok(store.get("k3"));
  assert.equal(store.get("k4"), undefined);
  store.close();
});

test("expire deletes rows unseen for more than 180 days and keeps refreshed ones", () => {
  const store = new Store(":memory:");
  const now = 1_000 * DAY;
  store.register("stale", "fcm", "a", now - 181 * DAY);
  store.register("edge", "fcm", "b", now - 180 * DAY);
  store.register("refreshed", "fcm", "c", now - 300 * DAY);
  store.touch("refreshed", now - DAY);
  assert.equal(store.expire(now), 1);
  assert.equal(store.get("stale"), undefined);
  assert.ok(store.get("edge"));
  assert.ok(store.get("refreshed"));
  store.close();
});

test("the APNs environment can be switched and defaults to production", () => {
  const store = new Store(":memory:");
  store.register("k", "apns", "t", 1);
  assert.equal(store.get("k")!.apnsEnv, "production");
  store.setApnsEnv("k", "sandbox");
  assert.equal(store.get("k")!.apnsEnv, "sandbox");
  store.close();
});
