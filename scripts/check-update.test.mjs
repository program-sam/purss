import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { composeProblems, isRange, lockProblems as check, manifestProblems, stagedProblems } from "./check-update.ts";

const manifest = { name: "x", scripts: { build: "vite build" }, dependencies: { vite: "^8.3.5", zod: "4.6.7" } };
const HASH = `sha512-${"A".repeat(86)}==`;
const tarball = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const reg = (name, version, extra = {}) => ({ version, resolved: tarball(name, version), integrity: HASH, ...extra });
const lock = (vite = "8.3.5", spec = "^8.3.5", more = {}) => ({
  name: "x", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "x", dependencies: { vite: spec, zod: "4.6.7" } },
    "node_modules/vite": reg("vite", vite),
    "node_modules/zod": reg("zod", "4.6.7"),
    "node_modules/fsevents": reg("fsevents", "2.3.3", { hasInstallScript: true, optional: true }),
    "node_modules/@purss/api": { resolved: "apps/api", link: true },
    ...more,
  },
});
/** A registry that publishes exactly what an entry says (so only the local rules are tested), unless told otherwise. */
const truthful = (lockfile, overrides = {}) => async (name, version) => {
  const key = `${name}@${version}`;
  if (key in overrides) return overrides[key];
  const entry = Object.entries(lockfile.packages).find(([p, e]) => p.endsWith(`node_modules/${name}`) && e.version === version)?.[1];
  if (!entry) return null;
  const { integrity, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu, libc } = entry;
  return { integrity, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu, libc };
};
const lockProblems = (before, after, overrides) => check(before, after, truthful(after, overrides));
const image = (c) => `services:\n  bridge:\n    image: docker.io/rssbridge/rss-bridge@sha256:${c.repeat(64)}\n    restart: unless-stopped\n`;

test("a version bump of an existing dependency is accepted; anything else in a package.json isn't", () => {
  assert.deepEqual(manifestProblems("p", manifest, { ...manifest, dependencies: { vite: "^8.3.6", zod: "4.6.8" } }), []);
  const bad = [
    { ...manifest, scripts: { build: "vite build", preinstall: "1.2.3" } },
    { ...manifest, dependencies: { vite: "^8.3.6", zod: "4.6.7", evil: "1.0.0" } },
    { ...manifest, dependencies: { evil: "^8.3.5", zod: "4.6.7" } },
    { ...manifest, dependencies: { vite: "git+https://evil/x", zod: "4.6.7" } },
    { ...manifest, dependencies: { vite: "file:../x", zod: "4.6.7" } },
    { ...manifest, devDependencies: { vite: "^8.3.5" } },
  ];
  for (const m of bad) assert.ok(manifestProblems("p", manifest, m).length > 0, JSON.stringify(m));
});

test("lockfile: registry packages may move; nothing may lose its hash, gain an install script, become a link or come from elsewhere", async () => {
  assert.deepEqual(await lockProblems(lock(), lock("8.3.6", "^8.3.6")), []);
  assert.deepEqual(await lockProblems(lock(), lock("8.3.6", "^8.3.5", { "node_modules/new-dep": reg("new-dep", "1.0.0") })), [], "a new indirect dependency from the registry");
  const moved = lock("8.3.6");
  moved.packages["node_modules/vite"].hasInstallScript = true;
  delete moved.packages["node_modules/fsevents"];
  assert.ok((await lockProblems(lock(), moved)).length > 0, "an install script moved from one package to another");
  const noHash = lock("8.3.5");
  delete noHash.packages["node_modules/zod"].integrity;
  noHash.packages["node_modules/zod"].version = "4.6.8";
  assert.ok((await lockProblems(lock(), noHash)).length > 0, "an integrity hash removed");
  assert.ok((await lockProblems(lock(), lock("8.3.6", "^8.3.6", { "node_modules/x": { version: "1.0.0", resolved: "https://evil.example/x.tgz", integrity: "sha512-x" } }))).length > 0);
  assert.ok((await lockProblems(lock(), lock("8.3.5", "^8.3.5", { "node_modules/x": { resolved: "../x", link: true } }))).length > 0);
  // npm runs lifecycle scripts written straight into a lock entry, with or without hasInstallScript.
  const injected = lock();
  injected.packages["node_modules/zod"].scripts = { postinstall: "echo marker" };
  assert.ok((await lockProblems(lock(), injected)).length > 0, "scripts injected into an unchanged registry entry");
  const injectedBump = lock("8.3.6", "^8.3.6");
  injectedBump.packages["node_modules/vite"].scripts = { postinstall: "echo marker" };
  assert.ok((await lockProblems(lock(), injectedBump)).some((p) => p.includes('"scripts"')), "scripts in a bumped entry");
  for (const value of ["true", 1, {}, [], false]) {
    const flagged = lock();
    flagged.packages["node_modules/zod"].hasInstallScript = value;
    assert.ok((await lockProblems(lock(), flagged)).length > 0, `hasInstallScript: ${JSON.stringify(value)}`);
  }
  const keepsFlag = lock("8.3.6", "^8.3.6");
  Object.assign(keepsFlag.packages["node_modules/fsevents"], { version: "2.3.4", resolved: tarball("fsevents", "2.3.4") });
  assert.deepEqual(await lockProblems(lock(), keepsFlag), [], "a package that already had install scripts keeps its flag through an update");
  const shrinkwrap = lock();
  shrinkwrap.packages["node_modules/zod"].hasShrinkwrap = true;
  assert.ok((await lockProblems(lock(), shrinkwrap)).length > 0, "a package lockfile npm would read unchecked");
  const shrinkwrapBump = lock("8.3.6", "^8.3.6");
  shrinkwrapBump.packages["node_modules/vite"].hasShrinkwrap = true;
  assert.ok((await lockProblems(lock(), shrinkwrapBump)).some((p) => p.includes("hasShrinkwrap")), "hasShrinkwrap in a bumped entry");
  const unknown = lock("8.3.6", "^8.3.6");
  unknown.packages["node_modules/vite"].gypfile = true;
  assert.ok((await lockProblems(lock(), unknown)).length > 0, "any field npm doesn't write for a registry package");
  // A package swapped for another's tarball, a made-up version or hash, and wiring changes.
  const swapped = lock();
  swapped.packages["node_modules/vite"] = { ...swapped.packages["node_modules/vite"], resolved: tarball("zod", "4.6.7") };
  assert.ok((await lockProblems(lock(), swapped)).length > 0, "another package's tarball");
  for (const change of [{ version: "not-a-version" }, { integrity: "sha512-" }, { dependencies: { x: "file:../../outside" } }, { dependencies: { x: "git+https://example.com/x.git" } }, { dependencies: { x: "npm:other@1.0.0" } }, { dependencies: "x" }]) {
    const changed = lock();
    Object.assign(changed.packages["node_modules/zod"], change);
    assert.ok((await lockProblems(lock(), changed)).length > 0, JSON.stringify(change));
  }
  const ranges = lock("8.3.6", "^8.3.6");
  ranges.packages["node_modules/vite"].dependencies = { a: "^1.2.0", b: ">=2.0.0 <3.0.0", c: "*", d: "1.x || 2.x" };
  assert.deepEqual(await lockProblems(lock(), ranges), [], "ordinary ranges are fine");
  // Destructive changes.
  const noRoot = lock();
  delete noRoot.packages[""];
  assert.ok((await lockProblems(lock(), noRoot)).length > 0, "the root entry deleted");
  assert.ok((await lockProblems(lock(), { ...lock(), packages: undefined })).length > 0, "packages deleted");
  const dropped = lock();
  delete dropped.packages["node_modules/zod"];
  assert.deepEqual(await lockProblems(lock(), dropped), [], "an installed package nothing needs may go");
  const rootScript = lock();
  rootScript.packages[""].scripts = { preinstall: "x" };
  assert.ok((await lockProblems(lock(), rootScript)).length > 0, "a root entry gains scripts");
});

test("compose: only the RSS-Bridge image line may change", () => {
  assert.deepEqual(composeProblems(image("a"), image("b")), []);
  assert.ok(composeProblems(image("a"), image("b").replace("unless-stopped", "always")).length > 0);
  assert.ok(composeProblems(image("a"), `${image("b")}    privileged: true\n`).length > 0);
});

test("the staged result is what's checked, however the patch was written (a patch without git headers too)", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-check-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(dir, "scripts", "dev.ts"), "console.log('dev');\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    // A headerless unified patch touching a script, as a compromised job could hand on.
    writeFileSync(path.join(dir, "evil.patch"), "--- a/scripts/dev.ts\n+++ b/scripts/dev.ts\n@@ -1 +1 @@\n-console.log('dev');\n+console.log('owned');\n");
    git("apply", "--index", "evil.patch");
    assert.ok((await stagedProblems(async () => null)).some((p) => p.startsWith("scripts/dev.ts")));
    git("reset", "-q", "--hard");
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ ...manifest, dependencies: { vite: "^8.3.6", zod: "4.6.7" } }, null, 2)}\n`);
    git("add", "package.json");
    assert.deepEqual(await stagedProblems(async () => null), []);
    writeFileSync(path.join(dir, "new.ts"), "x\n");
    git("add", "new.ts");
    assert.ok((await stagedProblems(async () => null)).some((p) => p.startsWith("new.ts")));
  } finally {
    process.chdir(cwd);
  }
});

test("an installed package changes only with a new version, and then carries what the registry publishes for it", async () => {
  const rewired = lock();
  rewired.packages["node_modules/zod"].dependencies = { picomatch: "^4.0.7" };
  assert.ok((await lockProblems(lock(), rewired)).some((p) => p.includes("without a new version")), "dependencies added to an unchanged version");
  const bumped = lock("8.3.6", "^8.3.6");
  bumped.packages["node_modules/vite"].dependencies = { picomatch: "^4.0.7", extra: "^1.0.0" };
  const published = { integrity: HASH, dependencies: { picomatch: "^4.0.7" } };
  assert.ok((await lockProblems(lock(), bumped, { "vite@8.3.6": published })).some((p) => p.includes("dependencies differ")), "a dependency the registry doesn't publish");
  assert.ok((await lockProblems(lock(), lock("8.3.6", "^8.3.6"), { "vite@8.3.6": { integrity: `sha512-${"B".repeat(86)}==` } })).some((p) => p.includes("another hash")), "a hash that isn't the registry's");
  assert.ok((await lockProblems(lock(), lock("8.3.6", "^8.3.6"), { "vite@8.3.6": null })).some((p) => p.includes("doesn't answer")), "a version the registry doesn't know");
});

test("versions and ranges follow npm's grammar", async () => {
  for (const version of ["01.2.3", "1.2.3-01", "1.2.3-..", "1.2.3.4"]) {
    const v = lock();
    Object.assign(v.packages["node_modules/vite"], { version, resolved: tarball("vite", version) });
    assert.ok((await lockProblems(lock(), v)).some((p) => p.includes("no plain version")), version);
  }
  for (const ok of ["^1.2.0", "~1.2", ">=2.0.0 <3.0.0", "1.x || 2.x", "1.0.0 - 2.0.0", "*", "", "1.2.3-beta.1", ">=1.0.0-rc.1", "v1.2.3", ">= 2", ">= 1.2 < 3"]) assert.ok(isRange(ok), ok);
  for (const bad of ["latest", "banana", "1.2.3.4", "file:../x", "npm:x@1", "git+https://x", "^01.2.3", "1.2 ||", "a/b"]) assert.ok(!isRange(bad), bad);
});

test("a new version carries the commands and platforms the registry publishes for it, and manifests use strict versions", async () => {
  const forged = lock("8.3.6", "^8.3.6");
  forged.packages["node_modules/vite"].bin = { "not-published": "index.js" };
  const published = { integrity: HASH, bin: { vite: "bin/vite.js" } };
  assert.ok((await lockProblems(lock(), forged, { "vite@8.3.6": published })).some((p) => p.includes("bin differs")), "a command the registry doesn't publish");
  const asPublished = lock("8.3.6", "^8.3.6");
  asPublished.packages["node_modules/vite"].bin = { vite: "bin/vite.js" };
  assert.deepEqual(await lockProblems(lock(), asPublished, { "vite@8.3.6": { integrity: HASH, bin: "./bin/vite.js" } }), [], "the registry's single path and ./ are the same command");
  const platform = lock("8.3.6", "^8.3.6");
  platform.packages["node_modules/vite"].os = ["linux"];
  assert.ok((await lockProblems(lock(), platform, { "vite@8.3.6": { integrity: HASH } })).some((p) => p.includes("os differs")));
  const noLibc = lock("8.3.6", "^8.3.6");
  assert.deepEqual(await lockProblems(lock(), noLibc, { "vite@8.3.6": { integrity: HASH, libc: ["glibc"] } }), [], "npm leaves libc out of a lockfile");
  for (const bad of ["^01.2.3", "1.2.3-01", "^1.2"]) {
    assert.ok(manifestProblems("p", manifest, { ...manifest, dependencies: { vite: bad, zod: "4.6.7" } }).length > 0, bad);
  }
  assert.deepEqual(manifestProblems("p", manifest, { ...manifest, dependencies: { vite: "^8.4.0-beta.1", zod: "4.6.7" } }), [], "a pre-release is a version");
});

test("the same version may change only the tree flags npm works out, and a libc the registry confirms (npm 11 on a CI runner)", async () => {
  const recomputed = lock();
  recomputed.packages["node_modules/zod"].peer = true;
  delete recomputed.packages["node_modules/fsevents"].optional;
  assert.deepEqual(await lockProblems(lock(), recomputed), []);
  const libc = lock();
  libc.packages["node_modules/zod"].libc = ["glibc"];
  assert.deepEqual(await lockProblems(lock(), libc, { "zod@4.6.7": { integrity: HASH, libc: ["glibc"] } }), [], "as published");
  assert.ok((await lockProblems(lock(), libc, { "zod@4.6.7": { integrity: HASH } })).some((p) => p.includes("libc differs")), "not as published");
  const flag = lock();
  flag.packages["node_modules/zod"].dev = "yes";
  assert.ok((await lockProblems(lock(), flag)).some((p) => p.includes("dev isn't true")));
});
