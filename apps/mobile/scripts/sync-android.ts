// Build the web app and sync Capacitor plugins for one Android distribution.
// The FOSS sync prunes generated push registration and removes Google-backed optional APIs from
// npm plugin sources before Gradle resolves the release classpath.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = path.resolve(MOBILE_DIR, "../..");
const PLUGIN = "capacitor-push-notifications";

const FOSS_PLUGIN_FILES = [
  { pkg: "@capgo/capacitor-passkey", file: "android/build.gradle" },
  { pkg: "@capgo/capacitor-updater", file: "android/build.gradle" },
  { pkg: "@capgo/capacitor-updater", file: "android/src/main/java/ee/forgr/capacitor_updater/CapacitorUpdaterPlugin.java" },
] as const;

function editAndroidFile(file: string, transform: (text: string) => string): void {
  const before = readFileSync(file, "utf8");
  const after = transform(before);
  writeFileSync(file, after);
}

function removeOne(text: string, pattern: RegExp, what: string): string {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = [...text.matchAll(global)];
  assert.equal(matches.length, 1, `Expected one generated ${what}, found ${matches.length}.`);
  const match = matches[0]!;
  return text.slice(0, match.index) + text.slice(match.index + match[0].length);
}

function replaceOne(text: string, pattern: RegExp, replacement: string, what: string): string {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = [...text.matchAll(global)];
  assert.equal(matches.length, 1, `Expected one ${what}, found ${matches.length}.`);
  const match = matches[0]!;
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

function fossPluginFile(mobileDir: string, pkg: string, file: string): { target: string; backup: string } {
  const packageDir = path.resolve(mobileDir, "../..", "node_modules", ...pkg.split("/"));
  const version = (JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string }).version;
  return {
    target: path.join(packageDir, file),
    backup: path.join(mobileDir, "../../.output/foss-plugin-originals", `${pkg.replace("/", "+")}-${version}`, file),
  };
}

function withoutFossGoogleDependencies(pkg: string, file: string, original: string): string {
  if (pkg === "@capgo/capacitor-passkey") {
    return removeOne(original, /^\s*implementation "androidx\.credentials:credentials-play-services-auth:1\.5\.0"\r?\n/m, "passkey Play Services dependency");
  }
  if (pkg === "@capgo/capacitor-updater" && file === "android/build.gradle") {
    let text = removeOne(original, /^\s*implementation "com\.google\.android\.gms:play-services-tasks:18\.4\.1"\r?\n/m, "updater Play Services Tasks dependency");
    text = removeOne(text, /^\s*implementation 'com\.google\.android\.play:app-update:2\.1\.0'\r?\n/m, "updater Play in-app update dependency");
    return replaceOne(text, /\r?\nrepositories \{\r?\n/, "\nandroid.sourceSets.main.java.exclude 'ee/forgr/capacitor_updater/NativeUpdatePrompt.java'\n\nrepositories {\n", "updater FOSS source exclusion");
  }
  assert.equal(pkg, "@capgo/capacitor-updater");
  assert.equal(file, "android/src/main/java/ee/forgr/capacitor_updater/CapacitorUpdaterPlugin.java");
  let text = removeOne(original, /^import com\.google\.android\.gms\.tasks\.Task;\r?\n\/\/ Play Store In-App Updates\r?\n(?:import com\.google\.android\.play\.core\.[^\n]+\r?\n)+/m, "updater Play Services imports");
  text = removeOne(text, /^    \/\/ Play Store In-App Updates\r?\n    private AppUpdateManager appUpdateManager;\r?\n    private PluginCall pendingAppUpdateCall;\r?\n    private AppUpdateInfo cachedAppUpdateInfo;\r?\n    static final int APP_UPDATE_REQUEST_CODE = 9001;\r?\n    private InstallStateUpdatedListener installStateUpdatedListener;\r?\n    private NativeUpdatePrompt nativeUpdatePrompt;\r?\n/m, "updater Play Store fields");
  text = replaceOne(text, /    private boolean shouldNotifyBreakingEvents\(final JSObject response\) \{\r?\n[\s\S]*?\r?\n    \}/, `    private boolean shouldNotifyBreakingEvents(final JSObject response) {
        if (response == null) return false;
        if (response.optBoolean("breaking", false)) return true;
        if ("store_update_required".equals(response.optString("message", ""))) return true;
        return response.optString("error", "").startsWith("disable_auto_update");
    }`, "updater breaking update check");
  text = removeOne(text, /        if \(this\.nativeUpdatePrompt != null\) \{\r?\n            this\.nativeUpdatePrompt\.maybeShowForUpdateBlock\(response\);\r?\n        \}\r?\n/, "updater Play Store prompt call");
  text = removeOne(text, /        this\.nativeUpdatePrompt = new NativeUpdatePrompt\([\s\S]*?\r?\n        \);\r?\n(?=        this\.previewSessionEnabled)/, "updater Play Store prompt setup");
  return replaceOne(text, /^    \/\/ ={40,}\r?\n    \/\/ Play Store In-App Update Methods\r?\n    \/\/ ={40,}\r?\n[\s\S]*?(?=    private void handleOnDestroyInternal\(\) \{)/m, `    @Override
    protected void handleOnDestroy() {
        handleOnDestroyInternal();
    }

`, "updater Play Store API block");
}

/** Remove Google-backed provider/store APIs from npm plugin sources for F-Droid, preserving core passkeys and live bundle updates. */
export function prepareFossPluginSources(mobileDir = MOBILE_DIR): void {
  for (const { pkg, file } of FOSS_PLUGIN_FILES) {
    const { target, backup } = fossPluginFile(mobileDir, pkg, file);
    assert.ok(existsSync(target), `Missing installed ${pkg}/${file}; run npm ci before the FOSS sync.`);
    const current = readFileSync(target, "utf8");
    let original: string;
    if (existsSync(backup)) original = readFileSync(backup, "utf8");
    else {
      original = current;
      mkdirSync(path.dirname(backup), { recursive: true });
      writeFileSync(backup, original);
    }
    const expected = withoutFossGoogleDependencies(pkg, file, original);
    if (current === original) writeFileSync(target, expected);
    else assert.equal(current, expected, `${pkg}/${file} differs from its expected FOSS form; restore it with the regular mobile sync.`);
  }
}

/** Restore npm plugin sources before a full build, which keeps its Play Store and provider integrations intact. */
export function restoreFullPluginSources(mobileDir = MOBILE_DIR): void {
  for (const { pkg, file } of FOSS_PLUGIN_FILES) {
    const { target, backup } = fossPluginFile(mobileDir, pkg, file);
    if (!existsSync(backup)) continue;
    const original = readFileSync(backup, "utf8");
    const current = readFileSync(target, "utf8");
    const expected = withoutFossGoogleDependencies(pkg, file, original);
    assert.ok(current === original || current === expected, `${pkg}/${file} changed after its FOSS form was prepared.`);
    copyFileSync(backup, target);
  }
  rmSync(path.join(mobileDir, "../../.output/foss-plugin-originals"), { recursive: true, force: true });
}

/** Remove the Firebase-backed Capacitor plugin from the FOSS Android project. */
export function prepareFossAndroid(androidDir: string): void {
  editAndroidFile(path.join(androidDir, "app/capacitor.build.gradle"), (text) =>
    removeOne(text, /^\s*implementation project\(':capacitor-push-notifications'\)\s*\n/m, `${PLUGIN} app dependency`));

  editAndroidFile(path.join(androidDir, "capacitor.settings.gradle"), (text) =>
    removeOne(text, /^include ':capacitor-push-notifications'\r?\nproject\(':capacitor-push-notifications'\)\.projectDir = .*\r?\n/m, `${PLUGIN} project include`));

  const pluginListFile = path.join(androidDir, "app/src/main/assets/capacitor.plugins.json");
  const plugins = JSON.parse(readFileSync(pluginListFile, "utf8")) as { pkg?: string }[];
  const pushPlugins = plugins.filter((plugin) => plugin.pkg === "@capacitor/push-notifications");
  assert.equal(pushPlugins.length, 1, `Expected one generated @capacitor/push-notifications registration, found ${pushPlugins.length}.`);
  writeFileSync(pluginListFile, `${JSON.stringify(plugins.filter((plugin) => plugin.pkg !== "@capacitor/push-notifications"), null, 2)}\n`);
}

/** The regular Android release must keep the generated push dependency and plugin registration. */
export function verifyFullAndroid(androidDir: string): void {
  const gradle = readFileSync(path.join(androidDir, "app/capacitor.build.gradle"), "utf8");
  assert.match(gradle, /implementation project\(':capacitor-push-notifications'\)/, "Full sync must include the Capacitor push dependency.");
  const plugins = JSON.parse(readFileSync(path.join(androidDir, "app/src/main/assets/capacitor.plugins.json"), "utf8")) as { pkg?: string }[];
  assert.equal(plugins.filter((plugin) => plugin.pkg === "@capacitor/push-notifications").length, 1, "Full sync must register the Capacitor push plugin.");
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

function main(): void {
  const distribution = process.argv[2];
  assert.ok(distribution === "full" || distribution === "foss", "Usage: sync-android.ts full|foss");
  if (distribution === "foss") prepareFossPluginSources();
  else restoreFullPluginSources();
  const env = {
    ...process.env,
    PURSS_WEB_BASE: "/",
    VITE_PURSS_PHONE_PUSH: distribution === "foss" ? "disabled" : "enabled",
  };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npm, ["run", "build", "-w", "@purss/web"], ROOT_DIR, env);
  run(npx, distribution === "foss" ? ["cap", "sync", "android"] : ["cap", "sync"], MOBILE_DIR, env);
  const androidDir = path.join(MOBILE_DIR, "android");
  if (distribution === "foss") prepareFossAndroid(androidDir);
  else verifyFullAndroid(androidDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
