import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceHealth } from "@purss/domain";
import { canRetrySource } from "./sources.ts";

test("only a source that failed can be tried again, whatever its text says", () => {
  const all: SourceHealth[] = ["ok", "pending", "error", "login", "quiet", "paused", "reconnect"];
  assert.deepEqual(all.filter((health) => canRetrySource({ health })), ["error"]);
});
