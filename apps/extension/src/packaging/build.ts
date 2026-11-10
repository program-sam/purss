import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { build } from "vite";
import { TARGETS, manifestFor } from "./manifest.ts";
import { readVersion } from "../../../../scripts/version.ts";
import { zip } from "./zip.ts";

/*
 * Builds the extension for Chrome and Edge (chromium), Firefox and Safari from the same code:
 *   dist/<target>/                     the unpacked extension (load it in the browser)
 *   dist/purss-<target>.zip  what the owner uploads to a store
 * Vite (already the web app's build tool) bundles the scripts; the popup and options pages are
 * ordinary pages, the background and the page readers single classic scripts. The icons are drawn
 * from the web app's icon. Output is not minified, so store reviewers can read it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const stage = path.join(dist, ".stage");
const TARGET = "es2022";
const release = readVersion()?.version ?? null;

rmSync(dist, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The popup and options pages.
await build({
  configFile: false, root: src, base: "./", publicDir: false, logLevel: "warn",
  build: {
    outDir: stage, emptyOutDir: false, target: TARGET, minify: false, sourcemap: false, modulePreload: false,
    rollupOptions: { input: { popup: path.join(src, "popup/popup.html"), options: path.join(src, "options/options.html") } },
  },
});

// The background and the two page readers: one classic script each, no imports at run time.
const scripts: [entry: string, out: string][] = [["background.ts", "background.js"], ["content/page-info.ts", "content/page-info.js"], ["content/capture.ts", "content/capture.js"]];
for (const [entry, out] of scripts) {
  await build({
    configFile: false, root: src, publicDir: false, logLevel: "warn",
    build: {
      outDir: stage, emptyOutDir: false, target: TARGET, minify: false, sourcemap: false, copyPublicDir: false,
      lib: { entry: path.join(src, entry), formats: ["iife"], name: "purss", fileName: () => out },
      // The page reader bundles Mozilla Readability (Apache-2.0): ship its licence with the extension.
      ...(out === "content/capture.js" ? { license: { fileName: "licenses.md" } } : {}),
    },
  });
}

// Icons, drawn from the web app's icon at each size the browsers ask for.
const svg = readFileSync(path.resolve(root, "../web/public/icon.svg"));
mkdirSync(path.join(stage, "icons"));
for (const size of [16, 32, 48, 128]) await sharp(svg, { density: 72 * Math.ceil(size / 24) * 2 }).resize(size, size).png().toFile(path.join(stage, "icons", `${size}.png`));

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));

for (const target of TARGETS) {
  const out = path.join(dist, target);
  cpSync(stage, out, { recursive: true });
  writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifestFor(target, release), null, 2)}\n`);
  for (const needed of ["manifest.json", "background.js", "content/page-info.js", "content/capture.js", "popup/popup.html", "options/options.html"]) {
    if (!existsSync(path.join(out, needed))) throw new Error(`Build for ${target} is missing ${needed}`);
  }
  const archive = path.join(dist, `purss-${target}.zip`);
  writeFileSync(archive, zip(files(out).map((name) => ({ name, data: readFileSync(path.join(out, name)) }))));
  console.log(`${target}: ${path.relative(process.cwd(), out)}/ and ${path.relative(process.cwd(), archive)}`);
}
rmSync(stage, { recursive: true, force: true });
