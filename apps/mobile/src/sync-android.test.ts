import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareFossAndroid, prepareFossPluginSources, restoreFullPluginSources, verifyFullAndroid } from "../scripts/sync-android.ts";

function generatedAndroid(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "purss-capacitor-sync-"));
  mkdirSync(path.join(root, "app/src/main/assets"), { recursive: true });
  writeFileSync(path.join(root, "app/capacitor.build.gradle"), "dependencies {\n  implementation project(':capacitor-app')\n  implementation project(':capacitor-push-notifications')\n}\n");
  writeFileSync(path.join(root, "capacitor.settings.gradle"), "include ':capacitor-app'\nproject(':capacitor-app').projectDir = new File('app')\n\ninclude ':capacitor-push-notifications'\nproject(':capacitor-push-notifications').projectDir = new File('push')\n");
  writeFileSync(path.join(root, "app/src/main/assets/capacitor.plugins.json"), `${JSON.stringify([
    { pkg: "@capacitor/app", classpath: "com.capacitorjs.plugins.app.AppPlugin" },
    { pkg: "@capacitor/push-notifications", classpath: "com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin" },
  ])}\n`);
  return root;
}

test("the FOSS sync removes the push project, dependency, and reflective registration", () => {
  const root = generatedAndroid();
  try {
    prepareFossAndroid(root);
    const gradle = readFileSync(path.join(root, "app/capacitor.build.gradle"), "utf8");
    const settings = readFileSync(path.join(root, "capacitor.settings.gradle"), "utf8");
    const plugins = JSON.parse(readFileSync(path.join(root, "app/src/main/assets/capacitor.plugins.json"), "utf8")) as { pkg?: string }[];
    assert.doesNotMatch(gradle, /capacitor-push-notifications/);
    assert.doesNotMatch(settings, /capacitor-push-notifications/);
    assert.deepEqual(plugins.map((plugin) => plugin.pkg), ["@capacitor/app"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full sync keeps the Capacitor push dependency and registration", () => {
  const root = generatedAndroid();
  try {
    verifyFullAndroid(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the FOSS plugin sync removes Play Services APIs and restores the full sources", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "purss-foss-plugins-"));
  const mobile = path.join(temp, "apps/mobile");
  const installedMobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plugins = [
    { pkg: "@capgo/capacitor-passkey", files: ["android/build.gradle"] },
    { pkg: "@capgo/capacitor-updater", files: ["android/build.gradle", "android/src/main/java/ee/forgr/capacitor_updater/CapacitorUpdaterPlugin.java"] },
  ];
  const originals = new Map<string, string>();
  try {
    for (const plugin of plugins) {
      const installed = path.resolve(installedMobile, "../../node_modules", ...plugin.pkg.split("/"));
      const target = path.resolve(mobile, "../../node_modules", ...plugin.pkg.split("/"));
      mkdirSync(target, { recursive: true });
      copyFileSync(path.join(installed, "package.json"), path.join(target, "package.json"));
      for (const file of plugin.files) {
        const targetFile = path.join(target, file);
        mkdirSync(path.dirname(targetFile), { recursive: true });
        copyFileSync(path.join(installed, file), targetFile);
        originals.set(`${plugin.pkg}/${file}`, readFileSync(targetFile, "utf8"));
      }
    }

    prepareFossPluginSources(mobile);
    prepareFossPluginSources(mobile);
    const readPlugin = (pkg: string, file: string) => readFileSync(path.resolve(mobile, "../../node_modules", ...pkg.split("/"), file), "utf8");
    assert.doesNotMatch(readPlugin("@capgo/capacitor-passkey", "android/build.gradle"), /credentials-play-services-auth/);
    assert.doesNotMatch(readPlugin("@capgo/capacitor-updater", "android/build.gradle"), /com\.google\.android\.(?:gms|play)/);
    assert.match(readPlugin("@capgo/capacitor-updater", "android/build.gradle"), /NativeUpdatePrompt\.java/);
    const updater = readPlugin("@capgo/capacitor-updater", "android/src/main/java/ee/forgr/capacitor_updater/CapacitorUpdaterPlugin.java");
    assert.doesNotMatch(updater, /com\.google\.android\.(?:gms|play)|NativeUpdatePrompt|AppUpdateManager/);
    assert.match(updater, /public void download\(/);
    assert.match(updater, /public void notifyAppReady\(/);

    restoreFullPluginSources(mobile);
    for (const plugin of plugins) {
      for (const file of plugin.files) assert.equal(readPlugin(plugin.pkg, file), originals.get(`${plugin.pkg}/${file}`));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
