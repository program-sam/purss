import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_DOWNLOADS, DESKTOP_PACKAGES } from "../../../packages/domain/src/distribution.ts";
import { updateManifest } from "./release.ts";

const signatures = Object.fromEntries(DESKTOP_PACKAGES.map((p) => [p.file, `sig of ${p.file}\n`]));

test("latest.json points every system and package at its file in this release, with its signature", () => {
  const m = updateManifest({ version: "26.312.14", notes: "n", date: new Date("2026-11-08T06:00:00Z"), downloadBase: "https://github.com/o/r/releases/download/desktop-26.312.14", signatures });
  assert.equal(m.version, "26.312.14");
  assert.equal(m.pub_date, "2026-11-08T06:00:00.000Z");
  assert.deepEqual(m.platforms["linux-x86_64-appimage"], { signature: "sig of PURSS-linux-x86_64.AppImage", url: "https://github.com/o/r/releases/download/desktop-26.312.14/PURSS-linux-x86_64.AppImage" });
  assert.equal(m.platforms["linux-x86_64-deb"]!.url.endsWith("/PURSS-linux-amd64.deb"), true);
  assert.equal(m.platforms["linux-x86_64-rpm"]!.url.endsWith(".rpm"), true);
  assert.equal(m.platforms["windows-x86_64-nsis"]!.url.endsWith("-setup.exe"), true);
  for (const k of ["darwin-aarch64-app", "darwin-x86_64-app", "darwin-aarch64", "darwin-x86_64"]) assert.equal(m.platforms[k]!.url.endsWith("/PURSS-macos.app.tar.gz"), true, k);
  assert.equal(m.platforms["linux-x86_64"]!.url.endsWith(".AppImage"), true, "a Linux app that names no package takes the AppImage");
});

test("a release without an updater signature fails instead of stopping updates", () => {
  assert.throws(() => updateManifest({ version: "1.2.3", notes: "", date: new Date(), downloadBase: "x", signatures: { ...signatures, "PURSS-windows-x64-setup.exe": undefined } }), /no updater signature/);
});

test("people download installers, not the macOS update archive; file names never carry a version", () => {
  assert.ok(DESKTOP_DOWNLOADS.every((p) => !p.file.endsWith(".tar.gz")));
  assert.ok(DESKTOP_PACKAGES.every((p) => !/\d+\.\d+\.\d+/.test(p.file)));
  assert.deepEqual([...new Set(DESKTOP_DOWNLOADS.map((p) => p.os))].sort(), ["linux", "macos", "windows"]);
});
