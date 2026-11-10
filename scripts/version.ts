// The version of this checkout (plan/40), from main's history: the commit's UTC day and its place among that
// day's commits on the first-parent line. Builds read it through readVersion(); where there is no history
// (the deploy's archive, a downloaded copy) they read version.json, which this script writes:
//
//   node scripts/version.ts                     print it (JSON)
//   node scripts/version.ts --plain | --dotted  print only the number (2631214) or the stores' spelling (26.312.14)
//   node scripts/version.ts --write [--from <dir>]   write version.json here, from <dir>'s history or its version.json
//
// Node's own modules only (the server image runs it before installing packages).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dottedVersion, versionOf } from "../packages/domain/src/version.ts";
import type { BuildVersion } from "../packages/domain/src/version.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = "version.json";

export type Commit = { hash: string; committedAt: Date; subject: string; merge: boolean };

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Main's first-parent line from `ref` back, newest first (up to `limit`). */
export function firstParents(dir: string, ref = "HEAD", limit?: number): Commit[] {
  const out = execFileSync("git", ["-c", "safe.directory=*", "-C", dir, "log", "--first-parent", "--format=%H%x09%ct%x09%P%x09%s", ...(limit ? ["-n", String(limit)] : []), ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, ct, parents, ...subject] = line.split("\t");
    return { hash: hash!, committedAt: new Date(Number(ct) * 1000), subject: subject.join("\t"), merge: (parents ?? "").split(" ").length > 1 };
  });
}

/** The version of every commit in a newest-first first-parent list: a day's oldest commit is its 1st. */
export function versionsOf(commits: Commit[]): { commit: Commit; version: string }[] {
  const perDay = new Map<string, number>();
  for (const c of commits) perDay.set(utcDay(c.committedAt), (perDay.get(utcDay(c.committedAt)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return commits.map((c) => {
    const day = utcDay(c.committedAt);
    const before = seen.get(day) ?? 0;
    seen.set(day, before + 1);
    return { commit: c, version: versionOf(c.committedAt, perDay.get(day)! - before) };
  });
}

/** The version of `dir`'s checkout from its history; null without git or history. */
export function gitVersion(dir: string): BuildVersion | null {
  let commits: Commit[];
  try { commits = firstParents(dir, "HEAD", 200); } catch { return null; }
  const head = commits[0];
  if (!head) return null;
  // Only the head's own day matters; a shallow history that ends inside that day can't count it.
  const day = utcDay(head.committedAt);
  const sameDay = commits.filter((c) => utcDay(c.committedAt) === day);
  if (sameDay.length === commits.length && commits.length < 200 && isShallow(dir)) return null;
  return { version: versionsOf(sameDay)[0]!.version, commit: head.hash, committedAt: head.committedAt.toISOString() };
}

function isShallow(dir: string): boolean {
  try { return execFileSync("git", ["-c", "safe.directory=*", "-C", dir, "rev-parse", "--is-shallow-repository"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; } catch { return false; }
}

function fromFile(dir: string): BuildVersion | null {
  try {
    const v = JSON.parse(readFileSync(path.join(dir, VERSION_FILE), "utf8")) as Partial<BuildVersion> | null;
    return v && typeof v.version === "string" && typeof v.commit === "string" && typeof v.committedAt === "string" ? { version: v.version, commit: v.commit, committedAt: v.committedAt } : null;
  } catch { return null; }
}

/** This build's version: from the history where there is one, else from version.json, else null. */
export function readVersion(dir = ROOT): BuildVersion | null {
  return gitVersion(dir) ?? fromFile(dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = args.includes("--from") ? path.resolve(args[args.indexOf("--from") + 1] ?? ".") : ROOT;
  const version = existsSync(from) ? readVersion(from) : null;
  if (args.includes("--plain") || args.includes("--dotted")) {
    if (!version) { console.error("version unknown: no history and no version.json"); process.exit(1); }
    console.log(args.includes("--dotted") ? dottedVersion(version.version) : version.version);
  } else if (args.includes("--write")) {
    writeFileSync(path.join(ROOT, VERSION_FILE), `${JSON.stringify(version)}\n`);
    console.log(version ? `version ${version.version} (${version.commit.slice(0, 7)})` : "version unknown: no history and no version.json");
  } else {
    console.log(JSON.stringify(version, null, 2));
  }
}
