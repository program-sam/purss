import assert from "node:assert/strict";
import { test } from "node:test";
import { Buckets } from "./limits.ts";
import { limitKey } from "./server.ts";

test("a bucket allows its capacity, then reports the wait, then refills", () => {
  let now = 0;
  const buckets = new Buckets(3, 1 / 60, () => now);
  for (let i = 0; i < 3; i += 1) assert.equal(buckets.take("a"), 0);
  assert.equal(buckets.take("a"), 60);
  assert.equal(buckets.take("b"), 0);
  now += 30_000;
  assert.equal(buckets.take("a"), 30);
  now += 30_000;
  assert.equal(buckets.take("a"), 0);
  now += 10 * 60_000;
  for (let i = 0; i < 3; i += 1) assert.equal(buckets.take("a"), 0);
  assert.ok(buckets.take("a") > 0);
});

test("fully refilled keys are forgotten without changing behaviour", () => {
  let now = 0;
  const buckets = new Buckets(2, 1, () => now);
  for (let i = 0; i < 2000; i += 1) buckets.take(`k${i}`);
  now += 120_000;
  buckets.take("trigger");
  for (let i = 0; i < 2; i += 1) assert.equal(buckets.take("k5"), 0);
  assert.ok(buckets.take("k5") > 0);
});

test("the number of keys held is capped; the least recently used go first", () => {
  let now = 0;
  const buckets = new Buckets(1, 1 / 3600, () => now, 3);
  for (const k of ["a", "b", "c"]) assert.equal(buckets.take(k), 0);
  assert.ok(buckets.take("a") > 0, "a is used up and now the most recent");
  assert.equal(buckets.take("d"), 0);
  assert.equal(buckets.size, 3);
  assert.equal(buckets.take("b"), 0, "b was the least recently used, so it was dropped and starts full");
  assert.ok(buckets.take("a") > 0, "a stayed");
});

test("addresses are limited as IPv4 addresses or IPv6 /64s", () => {
  assert.equal(limitKey("203.0.113.5"), "203.0.113.5");
  assert.equal(limitKey("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(limitKey("2001:db8:1:2::5"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(limitKey("::1"), "0:0:0:0::/64");
  assert.equal(limitKey("fe80::1%eth0"), "fe80:0:0:0::/64");
});
