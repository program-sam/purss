import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineAllowlist } from "./allowlist.ts";

test("the engine image's admin allowlist matches the worker's fixed operations", () => {
  const committed = JSON.parse(readFileSync(new URL("../../../infra/engine/image/allowlist.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, engineAllowlist(), "run: node scripts/gen-engine-allowlist.ts");
});

test("the engine image's admin helper may delete engine users, as account deletion needs", () => {
  const committed = JSON.parse(readFileSync(new URL("../../../infra/engine/image/allowlist.json", import.meta.url), "utf8")) as { cliScripts: string[] };
  assert.ok(committed.cliScripts.includes("delete-user.php"));
});
