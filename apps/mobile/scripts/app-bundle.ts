// Packs the apps' interface for live updates (the phones, plan/39; the desktop app, plan/42): the web app built for the apps' own root,
// zipped, plus the manifest the PURSS serves at /api/app/bundle. The server image runs it
// (infra/Containerfile); a PURSS without its output offers no update.
//
//   PURSS_WEB_BASE=/ npx vite build --outDir app-dist        (in apps/web)
//   node apps/mobile/scripts/app-bundle.ts apps/web/app-dist apps/web/app-bundle
//
// The output folder is emptied first. Node's own modules only: no packages to install.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundleVersion } from "../../../packages/domain/src/app-bundle.ts";
import type { AppBuild } from "../../../packages/domain/src/app-bundle.ts";
import { zipDirectory } from "../src/bundle.ts";

const [dist, out] = process.argv.slice(2);
if (!dist || !out) {
  console.error("usage: node apps/mobile/scripts/app-bundle.ts <web build for the apps> <output folder>");
  process.exit(2);
}

const build = JSON.parse(readFileSync(path.join(dist, "app-build.json"), "utf8")) as AppBuild;
// The apps load their interface from their own root; a build for the browser (under /app/) would load nothing.
if (/(?:src|href)="\/app\//.test(readFileSync(path.join(dist, "index.html"), "utf8"))) {
  console.error("This is the browser's build. Build the web app with PURSS_WEB_BASE=/ first.");
  process.exit(2);
}

const version = bundleVersion(build);
const zip = zipDirectory(dist);
const file = `${version}.zip`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, file), zip);
const manifest = { version, native: build.native, ...(build.desktop ? { desktop: build.desktop } : {}), built: build.built, file, checksum: createHash("sha256").update(zip).digest("hex"), size: zip.length };
writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`packed interface ${version} (${Math.round(zip.length / 1024)} KiB) in ${out}`);
