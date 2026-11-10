// Applies the app's changes to native plugins (apps/mobile/patches) to the installed packages, before the native
// projects are built. A patch named `@scope+name.patch` changes the package `@scope/name`. Applying twice is
// harmless; a patch that no longer fits the installed version fails loudly, so a plugin upgrade can't drop it.
// Run: node apps/mobile/scripts/patch-plugins.ts (part of `npm run sync -w @purss/mobile`)
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PATCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../patches");

export type PatchState = "applied" | "fits" | "broken";

/** The patches, each with the installed package's folder. */
export function patches(dir = PATCH_DIR): { file: string; pkg: string; pkgDir: string }[] {
  const require = createRequire(path.join(dir, "..", "package.json"));
  return readdirSync(dir).filter((f) => f.endsWith(".patch")).sort().map((f) => {
    const pkg = f.slice(0, -".patch".length).replace("+", "/");
    return { file: path.join(dir, f), pkg, pkgDir: path.dirname(require.resolve(`${pkg}/package.json`)) };
  });
}

/** `git apply` on the package's folder, which lies outside any tracked tree (node_modules is ignored). */
function gitApply(pkgDir: string, file: string, args: string[]): boolean {
  try {
    execFileSync("git", ["apply", ...args, file], { cwd: pkgDir, stdio: "pipe", env: { ...process.env, GIT_DIR: path.join(pkgDir, ".no-git") } });
    return true;
  } catch {
    return false;
  }
}

export function patchState(pkgDir: string, file: string): PatchState {
  if (gitApply(pkgDir, file, ["--check", "--reverse"])) return "applied";
  return gitApply(pkgDir, file, ["--check"]) ? "fits" : "broken";
}

function main(): void {
  for (const { file, pkg, pkgDir } of patches()) {
    const state = patchState(pkgDir, file);
    if (state === "broken") throw new Error(`${path.basename(file)} doesn't fit the installed ${pkg}; update the patch for this version.`);
    if (state === "fits" && !gitApply(pkgDir, file, [])) throw new Error(`Couldn't apply ${path.basename(file)} to ${pkg}.`);
    console.log(`${pkg}: ${state === "applied" ? "already patched" : "patched"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
