import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchState, patches } from "../scripts/patch-plugins.ts";

test("every patch to a native plugin fits the installed version, or is already applied", () => {
  const list = patches();
  assert.ok(list.some((p) => p.pkg === "@mediagrid/capacitor-native-audio"), "the native audio plugin is patched");
  for (const p of list) assert.notEqual(patchState(p.pkgDir, p.file), "broken", `${path.basename(p.file)} no longer fits ${p.pkg}`);
});

test("a patch is told apart as fitting, applied, or no longer fitting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-patch-"));
  try {
    const patch = path.join(dir, "x.patch");
    writeFileSync(patch, "--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+zwei\n");
    const pkg = path.join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(path.join(pkg, "f.txt"), "one\ntwo\n");
    assert.equal(patchState(pkg, patch), "fits");
    writeFileSync(path.join(pkg, "f.txt"), "one\nzwei\n");
    assert.equal(patchState(pkg, patch), "applied");
    writeFileSync(path.join(pkg, "f.txt"), "one\ndrei\n");
    assert.equal(patchState(pkg, patch), "broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
