import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { APP_PATH } from "@purss/domain/paths";
import { bundleVersion } from "@purss/domain/app-bundle";
import type { AppBuild } from "@purss/domain/app-bundle";
import { readVersion } from "../../scripts/version.ts";
import { PAGE_POLICY } from "./src/platform/csp.ts";

// Development: the API runs separately and `/api` is proxied to it, so the browser stays same-origin.
// Start the API with PURSS_PUBLIC_ORIGIN set to this server's origin (default http://localhost:5173)
// so its origin and passkey checks match. PURSS_API_URL and PURSS_WEB_PORT override the defaults.
const apiUrl = process.env.PURSS_API_URL ?? "http://127.0.0.1:8940";
const port = Number(process.env.PURSS_WEB_PORT ?? 5173);

/**
 * Builds src/sw/sw.ts into sw.js at the app's root (/app/sw.js), after the app itself, with the list of files to
 * save for offline use (the page, every built file, the manifest and icons) and a name for this build
 * made from their contents. Nothing is registered in `vite dev`.
 */
function serviceWorker(): Plugin {
  let root = "";
  let outDir = "";
  let base = "/";
  return {
    name: "purss-service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      base = config.base;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      // What was just written is exactly what the server will serve: the page, built files and public files.
      const names = (readdirSync(outDir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => path.relative(outDir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
        .filter((n) => n !== "sw.js" && n !== "licenses.md" && !n.endsWith(".map"))
        .sort();
      const urls = names.map((n) => `${base}${n}`);
      const hash = createHash("sha256");
      for (const n of names) hash.update(n).update(readFileSync(path.join(outDir, n)));
      await build({
        configFile: false,
        root,
        logLevel: "warn",
        define: { __PURSS_BUILD__: JSON.stringify(hash.digest("hex").slice(0, 16)), __PURSS_PRECACHE__: JSON.stringify(urls) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          target: "es2022",
          lib: { entry: path.resolve(root, "src/sw/sw.ts"), formats: ["iife"], name: "purssServiceWorker", fileName: () => "sw.js" },
        },
      });
    },
  };
}

/**
 * Which build this is, for the apps' live updates (plan/39, plan/42): the native levels it was built against
 * (apps/mobile/native-level.json for the phones, apps/desktop/native-level.json for the desktop app) and when it
 * was made (in seconds). Written to app-build.json, which the apps (their own version) and the packing script read.
 */
function appBuild(): AppBuild {
  const level = (app: string) => (JSON.parse(readFileSync(new URL(`../${app}/native-level.json`, import.meta.url), "utf8")) as { level: number }).level;
  return { native: level("mobile"), desktop: level("desktop"), built: Math.floor(Date.now() / 1000) };
}
const thisBuild = appBuild();
/** The product's version (plan/40), compiled into the page as `__PURSS_VERSION__` and written to app-build.json as `release`. */
const release = readVersion()?.version ?? null;

function appBuildFile(): Plugin {
  let outDir = "";
  return {
    name: "purss-app-build",
    apply: "build",
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    writeBundle() { writeFileSync(path.join(outDir, "app-build.json"), `${JSON.stringify({ ...thisBuild, version: bundleVersion(thisBuild), release })}\n`); },
  };
}

/**
 * Puts the page's Content-Security-Policy (src/platform/csp.ts) into the built index.html, first in
 * <head>, for the apps, which have no server header. Not in `vite dev`, whose scripts are inline.
 */
function pagePolicy(): Plugin {
  return {
    name: "purss-page-policy",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: PAGE_POLICY }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  // The public website has the root; the app is served under /app/ (also in `vite dev`). The phone
  // apps serve the build from their own root: they build it with PURSS_WEB_BASE=/.
  base: process.env.PURSS_WEB_BASE ?? `${APP_PATH}/`,
  plugins: [react(), serviceWorker(), pagePolicy(), appBuildFile()],
  define: {
    __PURSS_VERSION__: JSON.stringify(release),
    __PURSS_PHONE_PUSH_ENABLED__: JSON.stringify(process.env.VITE_PURSS_PHONE_PUSH !== "disabled"),
  },
  server: {
    port,
    strictPort: true,
    proxy: { "/api": { target: apiUrl, changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    // Ship the licences of every bundled dependency (e.g. cuelume, MIT) with the app.
    license: { fileName: "licenses.md" },
  },
});
