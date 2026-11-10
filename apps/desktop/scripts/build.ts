// Builds the desktop app (plan/42): the interface for the app's root (apps/web/app-dist), then the Tauri app with
// the product's version (plan/40) in its dotted spelling, which Tauri and the updater read as semver (26.312.14).
// A checkout without history builds as 0.0.0, which never updates itself. Extra arguments go to `tauri build`
// (for example `--bundles appimage` or `--target universal-apple-darwin`).
//
//   node apps/desktop/scripts/build.ts [tauri build arguments]
//
// Signing the updater files needs TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) in the environment; without it, pass
// `--no-updater` and no update files are made.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dottedVersion } from "../../../packages/domain/src/version.ts";
import { readVersion } from "../../../scripts/version.ts";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "../..");
const args = process.argv.slice(2);
const noUpdater = args.includes("--no-updater");
const passed = args.filter((a) => a !== "--no-updater");

const release = readVersion()?.version ?? null;
const version = (release && dottedVersion(release)) ?? "0.0.0";
console.log(`desktop app version ${version}${release ? ` (${release})` : " (no history: never updates itself)"}`);

// Node runs the tools' own scripts, so nothing goes through a shell (the same on Windows).
const node = (script: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(process.execPath, [path.join(root, "node_modules", script), ...argv], { cwd, stdio: "inherit", env: { ...process.env, ...env } });

node("vite/bin/vite.js", ["build", "--outDir", "app-dist"], path.join(root, "apps/web"), { PURSS_WEB_BASE: "/" });
const temp = mkdtempSync(path.join(os.tmpdir(), "purss-desktop-"));
const config = path.join(temp, "release.json");
writeFileSync(config, JSON.stringify({ version, ...(noUpdater ? { bundle: { createUpdaterArtifacts: false } } : {}) }));
try {
  node("@tauri-apps/cli/tauri.js", ["build", "--config", config, ...passed], desktop);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
