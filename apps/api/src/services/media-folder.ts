import { lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";

/** The last failure reported, so a folder that can't be removed is reported once, not on every tick. */
let lastFailure = "";

/**
 * The server keeps no audio or video files for users. A data directory that still has the `media`
 * folder an earlier version filled gets it removed: that folder and nothing outside it (a symlink at
 * that name is unlinked, never followed). It runs when the API starts and on every maintenance tick,
 * so a download an older worker finishes during an upgrade, or a folder that couldn't be removed,
 * goes too. With no folder it does nothing and says nothing.
 */
export function removeMediaFolder(dataDir: string): { files: number; bytes: number } | null {
  const folder = path.join(dataDir, "media");
  let entry;
  try { entry = lstatSync(folder); } catch { return null; }
  try {
    if (entry.isSymbolicLink()) {
      unlinkSync(folder);
      console.log(`[api] ${folder} was a link; it was removed and what it pointed to was left alone. The server no longer keeps media files.`);
      return { files: 0, bytes: 0 };
    }
    const totals = { files: 0, bytes: 0 };
    count(folder, totals);
    rmSync(folder, { recursive: true, force: true });
    lastFailure = "";
    console.log(`[api] removed ${totals.files} media file${totals.files === 1 ? "" : "s"} (${Math.round(totals.bytes / 1024 ** 2)} MB) that an earlier version saved on this server; it no longer keeps any.`);
    return totals;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== lastFailure) console.error(`[api] couldn't remove ${folder}; trying again until it can:`, message);
    lastFailure = message;
    return null;
  }
}

/** Files and bytes under a folder, without following links. */
function count(dir: string, totals: { files: number; bytes: number }): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) count(full, totals);
    else if (e.isFile()) { totals.files++; totals.bytes += lstatSync(full).size; }
  }
}
