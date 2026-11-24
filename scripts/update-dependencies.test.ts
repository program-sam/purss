import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { describeActionUpdate, newestBreaking, newestCompatible, offered, parseActionPins, parseSpec, parseVersion, showVersion } from "./update-dependencies.ts";

const list = ["1.2.3", "1.2.4", "1.3.0-beta.1", "1.9.0", "2.0.0", "2.1.0-rc.1", "0.4.1", "0.4.2", "0.5.0"];

test("only exact versions and caret ranges of plain releases are updated", () => {
  assert.deepEqual(parseSpec("^1.2.3"), { prefix: "^", version: [1, 2, 3] });
  assert.deepEqual(parseSpec("1.2.3"), { prefix: "", version: [1, 2, 3] });
  for (const spec of ["~1.2.3", ">=1.0.0", "1.2.3-beta.1", "workspace:*", "file:../x", "latest", "1.x"]) assert.equal(parseSpec(spec), null, spec);
  assert.equal(parseVersion("1.2.3-rc.1"), null);
});

/** A version as text, or null when there is none, so a missing update fails the comparison instead of throwing. */
const shown = (v: Parameters<typeof showVersion>[0] | null) => (v ? showVersion(v) : null);

test("an update stays within the major version (the minor for 0.x) and skips pre-releases", () => {
  assert.equal(shown(newestCompatible([1, 2, 3], list)), "1.9.0");
  assert.equal(newestCompatible([1, 9, 0], list), null, "already the newest of its major");
  assert.equal(shown(newestCompatible([0, 4, 1], list)), "0.4.2", "0.x: a new minor is a breaking change");
});

test("a newer major (or a new minor of 0.x) is reported, not taken", () => {
  assert.equal(shown(newestBreaking([1, 2, 3], list)), "2.0.0", "the release candidate of 2.1 is skipped");
  assert.equal(shown(newestBreaking([0, 4, 1], list)), "2.0.0");
  assert.equal(newestBreaking([2, 0, 0], list), null);
});

test("nothing above the latest tag is offered: an old mistaken major is no update", () => {
  // @capgo/capacitor-updater: 9.0.0 and 10.0.0 are 2023 publishes for Capacitor 5; latest is 8.54.2.
  const updater = ["7.53.0", "8.54.1", "8.54.2", "9.0.0", "10.0.0", "8.55.0-beta.1"];
  assert.equal(newestBreaking([8, 54, 1], offered(updater, "8.54.2")), null);
  assert.equal(shown(newestCompatible([8, 54, 1], offered(updater, "8.54.2"))), "8.54.2");
  assert.equal(shown(newestBreaking([1, 2, 3], offered(list, "2.0.0"))), "2.0.0", "a real new major still shows");
  assert.deepEqual(offered(list, "3.0.0-rc.1"), list, "a pre-release latest filters nothing");
  assert.deepEqual(offered(list, undefined), list);
});

const sha = (c: string) => c.repeat(40);

test("a pinned action is read with its major version; local workflows, branch pins and tags are not", () => {
  const workflow = [
    `      - uses: actions/checkout@${sha("a")} # v7`,
    `      - uses: actions/setup-java@${sha("b")}   #   v5.1.0`,
    `    uses: ./.github/workflows/deploy.yml`,
    `      - uses: dtolnay/rust-toolchain@${sha("c")} # stable`,
    `      - uses: actions/download-artifact@v8`,
    `      - uses: actions/upload-artifact@${sha("d")}`,
    `      - uses: Swatinem/rust-cache@${"e".repeat(39)} # v2`,
  ].join("\n");
  assert.deepEqual(parseActionPins(workflow), [
    { action: "actions/checkout", sha: sha("a"), major: 7 },
    { action: "actions/setup-java", sha: sha("b"), major: 5 },
  ]);
});

test("a pinned action is reported for a newer major or a tag that moved, with the commit to pin", () => {
  const pin = { action: "actions/checkout", sha: sha("a"), major: 7 };
  assert.equal(describeActionUpdate(pin, 7, { pinnedTag: sha("a"), newestTag: null }), null, "the tag still points at the pin");
  assert.equal(describeActionUpdate(pin, 7, { pinnedTag: null, newestTag: null }), null, "an unresolved tag says nothing");
  assert.equal(
    describeActionUpdate(pin, 7, { pinnedTag: sha("b"), newestTag: null }),
    `- GitHub Action \`actions/checkout\`: its v7 tag moved on from the pinned commit aaaaaaa; pin \`actions/checkout@${sha("b")} # v7\``,
  );
  assert.equal(
    describeActionUpdate(pin, 8, { pinnedTag: sha("b"), newestTag: sha("c") }),
    `- GitHub Action \`actions/checkout\` v7 → v8: pin \`actions/checkout@${sha("c")} # v8\``,
    "a new major wins over a moved tag",
  );
  assert.match(describeActionUpdate(pin, 8, { pinnedTag: null, newestTag: null }) ?? "", /v7 → v8: pin the commit of its v8 tag$/);
});

test("every third-party action in the workflows is pinned to a full commit with its version in a comment", () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  let seen = 0;
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(new URL(file, dir), "utf8").split("\n")) {
      const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1];
      if (!uses || uses.startsWith("./")) continue;
      seen++;
      assert.match(line, /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+$/, `${file}: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0);
});
