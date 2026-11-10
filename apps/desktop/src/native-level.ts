import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../../mobile/src/native-level.ts";
import type { NativeLevel } from "../../mobile/src/native-level.ts";

/*
 * The desktop app's native level (plan/39, plan/42): the number a live update of the interface must carry to be
 * installed in this app. Raise it in native-level.json when the Rust side changes in a way the interface depends
 * on (a command added, removed or changed, a plugin); the fingerprint makes the tests notice any change, so it is
 * a decision each time. The phones have their own level (apps/mobile/native-level.json).
 */

export const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP_LEVEL_FILE = path.join(DESKTOP_DIR, "native-level.json");

export function readDesktopLevel(file = DESKTOP_LEVEL_FILE): NativeLevel {
  return JSON.parse(readFileSync(file, "utf8")) as NativeLevel;
}

/** A hash of the Rust side: the crate, its lock file, configuration, capabilities and code, and this package's dependencies. */
export function desktopFingerprint(dir = DESKTOP_DIR): string {
  return fingerprintOf(dir, ["src-tauri/src", "src-tauri/build.rs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/capabilities"]);
}
