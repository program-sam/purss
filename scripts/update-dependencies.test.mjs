import assert from "node:assert/strict";
import { test } from "node:test";
import { newestBreaking, newestCompatible, offered, parseSpec, parseVersion, showVersion } from "./update-dependencies.ts";

const list = ["1.2.3", "1.2.4", "1.3.0-beta.1", "1.9.0", "2.0.0", "2.1.0-rc.1", "0.4.1", "0.4.2", "0.5.0"];

test("only exact versions and caret ranges of plain releases are updated", () => {
  assert.deepEqual(parseSpec("^1.2.3"), { prefix: "^", version: [1, 2, 3] });
  assert.deepEqual(parseSpec("1.2.3"), { prefix: "", version: [1, 2, 3] });
  for (const spec of ["~1.2.3", ">=1.0.0", "1.2.3-beta.1", "workspace:*", "file:../x", "latest", "1.x"]) assert.equal(parseSpec(spec), null, spec);
  assert.equal(parseVersion("1.2.3-rc.1"), null);
});

test("an update stays within the major version (the minor for 0.x) and skips pre-releases", () => {
  assert.equal(showVersion(newestCompatible([1, 2, 3], list)), "1.9.0");
  assert.equal(newestCompatible([1, 9, 0], list), null, "already the newest of its major");
  assert.equal(showVersion(newestCompatible([0, 4, 1], list)), "0.4.2", "0.x: a new minor is a breaking change");
});

test("a newer major (or a new minor of 0.x) is reported, not taken", () => {
  assert.equal(showVersion(newestBreaking([1, 2, 3], list)), "2.0.0", "the release candidate of 2.1 is skipped");
  assert.equal(showVersion(newestBreaking([0, 4, 1], list)), "2.0.0");
  assert.equal(newestBreaking([2, 0, 0], list), null);
});

test("nothing above the latest tag is offered: an old mistaken major is no update", () => {
  // @capgo/capacitor-updater: 9.0.0 and 10.0.0 are 2023 publishes for Capacitor 5; latest is 8.54.2.
  const updater = ["7.53.0", "8.54.1", "8.54.2", "9.0.0", "10.0.0", "8.55.0-beta.1"];
  assert.equal(newestBreaking([8, 54, 1], offered(updater, "8.54.2")), null);
  assert.equal(showVersion(newestCompatible([8, 54, 1], offered(updater, "8.54.2"))), "8.54.2");
  assert.equal(showVersion(newestBreaking([1, 2, 3], offered(list, "2.0.0"))), "2.0.0", "a real new major still shows");
  assert.deepEqual(offered(list, "3.0.0-rc.1"), list, "a pre-release latest filters nothing");
  assert.deepEqual(offered(list, undefined), list);
});
