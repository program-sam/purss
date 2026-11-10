import { DESKTOP_PACKAGES } from "../../../packages/domain/src/distribution.ts";

/*
 * The updater's latest.json for a desktop release (plan/42, .github/workflows/desktop.yml). The files and their
 * fixed names are in packages/domain/src/distribution.ts, shared with the website and Settings.
 */

export type UpdateManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/**
 * latest.json for a release: each package's signature (its `.sig` file's text) under every key it answers, with the
 * address of the file in that release (not `latest`, so an update in progress never mixes two releases).
 * Throws when a package with update keys has no signature: a release without them would stop apps updating.
 */
export function updateManifest(o: { version: string; notes: string; date: Date; downloadBase: string; signatures: Record<string, string | undefined> }): UpdateManifest {
  const platforms: UpdateManifest["platforms"] = {};
  for (const p of DESKTOP_PACKAGES) {
    if (!p.updates.length) continue;
    const signature = o.signatures[p.file]?.trim();
    if (!signature) throw new Error(`${p.file} has no updater signature (${p.file}.sig). Is TAURI_SIGNING_PRIVATE_KEY set?`);
    for (const key of p.updates) platforms[key] = { signature, url: `${o.downloadBase}/${p.file}` };
  }
  return { version: o.version, notes: o.notes, pub_date: o.date.toISOString(), platforms };
}
