import test from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "./next.ts";

test("only paths on this PURSS are followed after signing in", () => {
  assert.equal(safeNext("/connect?client=mobile&state=abc"), "/connect?client=mobile&state=abc");
  assert.equal(safeNext("/"), "/");
  for (const bad of ["https://evil.example", "//evil.example/x", "/\\evil.example", "/\\/evil.example", "javascript:alert(1)", "connect", "/a\nb", "/a\\b", "", 42, undefined, `/${"x".repeat(4000)}`]) {
    assert.equal(safeNext(bad), undefined, String(bad));
  }
});
