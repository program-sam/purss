// What changed between two versions (plan/40), as Markdown to edit into an update post or a report: the
// commit subjects on main (written as plain sentences about what people get), grouped by day, newest first,
// each with its version. A merged branch lists its own commits under the merge's version.
//
//   node scripts/release-notes.ts <since> [<until>]     after version <since>, up to <until> (default: now)
//
// Run it in a checkout with main's history (git fetch first).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion, versionDay } from "../packages/domain/src/version.ts";
import { ROOT, firstParents, versionsOf } from "./version.ts";
import type { Commit } from "./version.ts";

export type NoteDay = { day: Date; from: string; to: string; entries: { version: string; subjects: string[] }[] };

/** The subjects a first-parent commit stands for: its own, or for a merge the merged commits' (oldest first). */
function subjectsOf(dir: string, c: Commit): string[] {
  if (!c.merge) return [c.subject];
  const out = execFileSync("git", ["-c", "safe.directory=*", "-C", dir, "log", "--reverse", "--no-merges", "--format=%s", `${c.hash}^1..${c.hash}`], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

export function releaseNotes(dir: string, since: string, until: string | null, ref = "HEAD"): NoteDay[] {
  const all = versionsOf(firstParents(dir, ref));
  const picked = all.filter(({ version }) => Number(version) > Number(since) && (until === null || Number(version) <= Number(until)));
  const days: NoteDay[] = [];
  for (const { commit, version } of picked) {
    const key = version.slice(0, 5);
    let day = days.at(-1);
    if (!day || day.from.slice(0, 5) !== key) {
      day = { day: versionDay(version)!, from: version, to: version, entries: [] };
      days.push(day);
    }
    day.from = version;
    day.entries.push({ version, subjects: subjectsOf(dir, commit) });
  }
  return days;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function toMarkdown(days: NoteDay[], since: string, until: string | null): string {
  const last = days[0]?.to ?? until ?? since;
  const lines = [`# Changes after ${since}, up to ${last}`, ""];
  if (!days.length) lines.push("Nothing changed.", "");
  for (const d of days) {
    lines.push(`## ${DATE.format(d.day)} (${d.from === d.to ? d.to : `${d.from} to ${d.to}`})`, "");
    for (const e of d.entries) for (const s of e.subjects) lines.push(`- ${s} (${e.version})`);
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [since, until] = process.argv.slice(2);
  if (!since || !parseVersion(since) || (until && !parseVersion(until))) {
    console.error("usage: node scripts/release-notes.ts <since version, e.g. 2631201> [<until version>]");
    process.exit(2);
  }
  process.stdout.write(toMarkdown(releaseNotes(ROOT, since, until ?? null), since, until ?? null));
}
