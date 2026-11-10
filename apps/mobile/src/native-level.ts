import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The native level (plan/39): a number for the app's native code. A live update carries the level it was
 * built with, and the app installs it only when that equals its own, so an interface that calls native code
 * the installed app doesn't have is never installed. Raise it in native-level.json when the native side
 * changes in a way the interface depends on (a plugin added, removed or upgraded, the app's own plugins'
 * methods); the fingerprint there makes the tests notice any change to the native side, so it is a
 * decision each time, never forgotten.
 */

export const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_LEVEL_FILE = path.join(MOBILE_DIR, "native-level.json");

export type NativeLevel = { level: number; fingerprint: string };

export function readNativeLevel(file = NATIVE_LEVEL_FILE): NativeLevel {
  return JSON.parse(readFileSync(file, "utf8")) as NativeLevel;
}

/**
 * A hash of what makes up the native app: every tracked file of the Android and iOS projects, the
 * plugins (this package's dependencies), the app's patches to them and the Capacitor configuration.
 */
export function nativeFingerprint(dir = MOBILE_DIR): string {
  return fingerprintOf(dir, ["android", "ios", "patches", "capacitor.config.ts"]);
}

/** A hash of the tracked files under `paths` (relative to `dir`) and the dependencies in `dir`'s package.json. The desktop app's level uses it too (plan/42). */
export function fingerprintOf(dir: string, paths: string[]): string {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: dir, encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(f).update("\0").update(readFileSync(path.join(dir, f))).update("\0");
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  hash.update(JSON.stringify(Object.entries(pkg.dependencies ?? {}).sort()));
  return hash.digest("hex").slice(0, 16);
}
