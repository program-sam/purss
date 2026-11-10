import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleVersion, desktopOffer, parseOffer } from "@purss/domain/app-bundle";
import { makeTestApp } from "../testing.ts";
import { startTestServer } from "../features-testing.ts";
import { appBundleRouter } from "./app-bundle.ts";

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-app-bundle-"));
  const { app, cleanup } = makeTestApp({ PURSS_APP_BUNDLE_DIR: dir });
  const server = await startTestServer(app, [appBundleRouter()]);
  return { dir, base: server.base, close: async () => { await server.close(); cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}

function pack(dir: string, manifest: Record<string, unknown> = {}) {
  const zip = Buffer.from("PK zip bytes");
  const version = bundleVersion({ native: 1, built: 1_762_000_000 });
  const file = `${version}.zip`;
  writeFileSync(path.join(dir, file), zip);
  const full = { version, native: 1, built: 1_762_000_000, file, checksum: createHash("sha256").update(zip).digest("hex"), size: zip.length, ...manifest };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(full));
  return { zip, version, file, checksum: full.checksum };
}

test("without a packed interface, the PURSS offers no update", async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await fetch(`${s.base}/api/app/bundle`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "no_app_bundle");
});

test("the packed interface is offered to the apps, cross-origin and without signing in, and only its zip is served", async (t) => {
  const s = await setup();
  t.after(s.close);
  const b = pack(s.dir);
  writeFileSync(path.join(s.dir, "other.zip"), "not on offer");
  const res = await fetch(`${s.base}/api/app/bundle`, { headers: { origin: "https://localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://localhost");
  assert.deepEqual(await res.json(), { version: b.version, native: 1, built: 1_762_000_000, path: `/api/app/bundle/${b.file}`, checksum: b.checksum, size: b.zip.length });

  const zip = await fetch(`${s.base}/api/app/bundle/${b.file}`, { headers: { origin: "tauri://localhost" } });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("access-control-allow-origin"), "tauri://localhost", "the desktop app's page fetches the zip itself (plan/42)");
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.deepEqual(Buffer.from(await zip.arrayBuffer()), b.zip);
  assert.equal((await fetch(`${s.base}/api/app/bundle/other.zip`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/app/bundle/manifest.json`)).status, 404);
});

test("a build that names the desktop level offers it, and the desktop reads the offer at its own level", async (t) => {
  const s = await setup();
  t.after(s.close);
  const b = pack(s.dir, { desktop: 3 });
  const offer = parseOffer(await (await fetch(`${s.base}/api/app/bundle`)).json());
  assert.ok(offer);
  assert.equal(offer.desktop, 3);
  assert.equal(offer.version, b.version, "the phones read the offer as before");
  assert.deepEqual(desktopOffer(offer), { ...offer, native: 3, version: bundleVersion({ native: 3, built: 1_762_000_000 }) });
  assert.equal(desktopOffer({ ...offer, desktop: undefined }), null, "a build without a desktop level: the desktop keeps its own interface");
  pack(s.dir, { desktop: "3" });
  assert.equal((await (await fetch(`${s.base}/api/app/bundle`)).json()).desktop, undefined, "a malformed desktop level is left out");
});

test("a malformed manifest offers nothing", async (t) => {
  const s = await setup();
  t.after(s.close);
  pack(s.dir, { checksum: "nope" });
  assert.equal((await fetch(`${s.base}/api/app/bundle`)).status, 404);
  pack(s.dir, { file: "../secrets.zip" });
  assert.equal((await fetch(`${s.base}/api/app/bundle`)).status, 404);
});
