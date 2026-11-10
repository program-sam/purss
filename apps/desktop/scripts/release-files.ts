// The release workflow's helper (plan/42, .github/workflows/desktop.yml).
//
//   node apps/desktop/scripts/release-files.ts collect <bundle folder> <out folder> <windows|macos|linux> [--no-updater]
//       copies what Tauri made for that system to the release's fixed names, with their .sig files; with
//       --no-updater (a build without the updater key) the files made only for the updater aren't expected
//   node apps/desktop/scripts/release-files.ts manifest <folder with every system's files> <dotted version> <release download address>
//       writes latest.json there; fails when a file the updater needs has no signature
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP_PACKAGES } from "../../../packages/domain/src/distribution.ts";
import { updateManifest } from "../src/release.ts";

const [command, ...rest] = process.argv.slice(2);

function find(folder: string, ending: string): string | null {
  if (!existsSync(folder)) return null;
  const hit = readdirSync(folder).find((f) => f.endsWith(ending) && !f.endsWith(".sig"));
  return hit ? path.join(folder, hit) : null;
}

if (command === "collect") {
  const [bundle, out, os, flag] = rest;
  const noUpdater = flag === "--no-updater";
  if (!bundle || !out || !os) throw new Error("collect <bundle folder> <out folder> <os>");
  mkdirSync(out, { recursive: true });
  for (const p of DESKTOP_PACKAGES.filter((x) => x.os === os && !(noUpdater && x.updaterOnly))) {
    const made = find(path.join(bundle, p.made.folder), p.made.ending);
    if (!made) throw new Error(`Tauri made no ${p.made.ending} in ${path.join(bundle, p.made.folder)}`);
    copyFileSync(made, path.join(out, p.file));
    if (existsSync(`${made}.sig`)) copyFileSync(`${made}.sig`, path.join(out, `${p.file}.sig`));
    console.log(`${p.file} ← ${path.basename(made)}${existsSync(`${made}.sig`) ? " (signed for the updater)" : ""}`);
  }
} else if (command === "manifest") {
  const [dir, version, downloadBase] = rest;
  if (!dir || !version || !downloadBase) throw new Error("manifest <folder> <version> <download address>");
  const signatures = Object.fromEntries(DESKTOP_PACKAGES.map((p) => {
    const sig = path.join(dir, `${p.file}.sig`);
    return [p.file, existsSync(sig) ? readFileSync(sig, "utf8") : undefined];
  }));
  const manifest = updateManifest({ version, notes: `Version ${version}`, date: new Date(), downloadBase, signatures });
  writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
} else {
  throw new Error("collect … | manifest …");
}
