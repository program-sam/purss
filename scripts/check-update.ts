#!/usr/bin/env node
/**
 * Is a weekly dependency update only what scripts/update-dependencies.ts may change? The publishing
 * job applies the update to the index (`git apply --index`) and runs this, never any updated code.
 * It compares the staged result with HEAD, not the patch text, so a patch can't hide anything:
 *
 * - only existing files change: the workspaces' package.json files, package-lock.json, infra/compose.yaml;
 * - a package.json changes only the version of a dependency it already has (same name, same section),
 *   written exactly or with ^;
 * - package-lock.json: the root and workspace entries stay and follow the same rule; an installed
 *   package whose version stays is unchanged; one that changes is the registry's own tarball of its
 *   name and version (the address rebuilt from the entry's path and version), with the integrity hash
 *   and dependencies the registry publishes for that version (asked from registry.npmjs.org: the
 *   tarball's hash says nothing about the lockfile's dependency lists), holds only the fields npm
 *   writes for one (npm would run `scripts` written into an entry, or read a lockfile inside it), and
 *   gains no install script and no link;
 * - infra/compose.yaml changes only the RSS-Bridge image digest.
 *
 *   node scripts/check-update.ts      exit 0 when acceptable, 1 with the reasons
 */
import { execFileSync } from "node:child_process";

type Json = Record<string, unknown>;

const PACKAGE_JSON = /^(?:package\.json|(?:apps|packages)\/[a-z0-9-]+\/package\.json)$/;
const ALLOWED = (p: string) => PACKAGE_JSON.test(p) || p === "package-lock.json" || p === "infra/compose.yaml";
/** How a workspace writes a dependency: an exact version or a caret range of one (strict semver, checked below). */
const isWrittenVersion = (v: unknown): boolean => typeof v === "string" && SEMVER.test(v.replace(/^\^/, ""));
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const BRIDGE_IMAGE_LINE = /^ {4}image: docker\.io\/rssbridge\/rss-bridge@sha256:[0-9a-f]{64}$/;

/**
 * The fields npm writes for an installed registry package. Anything else is refused: `scripts` (npm runs
 * them) and `hasShrinkwrap` (npm would read a lockfile inside the package, which nothing here checks).
 */
const LOCK_ENTRY_FIELDS = new Set([
  "version", "resolved", "integrity", "dev", "optional", "devOptional", "peer", "license", "engines", "os", "cpu", "libc",
  "bin", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "funding", "deprecated", "hasInstallScript",
]);

/** A version as semver.org defines it: no leading zeros, no empty pre-release parts. */
const NUM = "(?:0|[1-9]\\d*)";
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+${BUILD})?$`);
const PART = `(?:${NUM}|[xX*])`;
const PARTIAL = `v?${PART}(?:\\.${PART}(?:\\.${PART}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+${BUILD})?)?)?`;
const COMPARATOR = new RegExp(`^(?:\\^|~|>=|<=|>|<|=)?${PARTIAL}$`);
const HYPHEN = new RegExp(`^(${PARTIAL})\\s+-\\s+(${PARTIAL})$`);
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** A version range in npm's grammar (`^1.2.0`, `>=2 <3`, `1.x || 2.x`, `1.0.0 - 2.0.0`, `*`), not a tag, path or URL. */
export function isRange(spec: string): boolean {
  // npm allows a space after an operator (`>= 2`).
  const s = spec.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
  if (s === "" || s === "*") return true;
  return s.split("||").every((part) => {
    const p = part.trim();
    if (!p) return false;
    if (HYPHEN.test(p)) return true;
    return p.split(/\s+/).every((c) => COMPARATOR.test(c));
  });
}

/** What the registry publishes for one version of a package. */
export type RegistryVersion = {
  integrity: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  bin?: string | Record<string, string>;
  engines?: unknown;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
};
export type Registry = (name: string, version: string) => Promise<RegistryVersion | null>;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/** The package name an installed entry's path stands for (`node_modules/a/node_modules/@s/b` → `@s/b`). */
export function packageName(lockPath: string): string {
  return lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
}

/** Flags npm derives from where a package sits in the tree, not from the package. */
const TREE_FLAGS = new Set(["dev", "optional", "devOptional", "peer"]);

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Changes between two manifests (or lockfile root/workspace entries) other than dependency versions. */
export function manifestProblems(where: string, before: Json, after: Json): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SECTIONS.includes(key) && isObject(before[key]) && isObject(after[key])) {
      const b = before[key] as Record<string, unknown>;
      const a = after[key] as Record<string, unknown>;
      if (!same(Object.keys(b).sort(), Object.keys(a).sort())) out.push(`${where}: ${key} gains or loses a dependency`);
      for (const name of Object.keys(a)) {
        if (b[name] === a[name]) continue;
        if (!isWrittenVersion(a[name]) || !isWrittenVersion(b[name])) {
          out.push(`${where}: ${key}.${name} changes to something other than a version`);
        }
      }
    } else if (!same(before[key], after[key])) {
      out.push(`${where}: "${key}" changes`);
    }
  }
  return out;
}

/** Changes between two lockfiles that aren't registry packages moving to other versions. */
export async function lockProblems(before: Json, after: Json, registry: Registry): Promise<string[]> {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== "packages" && !same(before[key], after[key])) out.push(`package-lock.json: "${key}" changes`);
  }
  if (!isObject(after.packages)) return [...out, "package-lock.json: has no packages"];
  const b = (isObject(before.packages) ? before.packages : {}) as Record<string, Json>;
  const a = after.packages as Record<string, Json>;
  const checks: { path: string; name: string; version: string; entry: Json }[] = [];
  // The root and the workspaces stay; installed packages may go when nothing needs them any more.
  for (const path of Object.keys(b)) {
    if (!path.includes("node_modules/") && !(path in a)) out.push(`package-lock.json: the entry "${path || "(root)"}" is gone`);
  }
  for (const [path, entry] of Object.entries(a)) {
    const old = b[path];
    if (!path.startsWith("node_modules/") && !path.includes("/node_modules/")) {
      // The root and the workspaces: like their package.json files.
      if (!old) out.push(`package-lock.json: a new workspace entry "${path}"`);
      else out.push(...manifestProblems(`package-lock.json "${path || "(root)"}"`, old, entry));
      continue;
    }
    if (same(old, entry)) continue;
    if (entry.link === true) { out.push(`package-lock.json: "${path}" becomes a link`); continue; }
    if (old && old.version === entry.version) {
      // The same version: only what npm works out from the tree around it may change, the dev/optional/peer
      // flags, and the libc it now records for a platform package (checked against the registry below).
      const fixed = (e: Json) => Object.fromEntries(Object.entries(e).filter(([k]) => !TREE_FLAGS.has(k) && k !== "libc"));
      if (!same(fixed(old), fixed(entry))) { out.push(`package-lock.json: "${path}" changes without a new version`); continue; }
      for (const flag of TREE_FLAGS) if (flag in entry && entry[flag] !== true) out.push(`package-lock.json: "${path}" ${flag} isn't true`);
      if (!same(old.libc, entry.libc)) checks.push({ path, name: packageName(path), version: String(entry.version), entry });
      continue;
    }
    for (const field of Object.keys(entry)) if (!LOCK_ENTRY_FIELDS.has(field)) out.push(`package-lock.json: "${path}" has a "${field}" field`);
    const name = packageName(path);
    const version = typeof entry.version === "string" ? entry.version : "";
    if (!SEMVER.test(version)) out.push(`package-lock.json: "${path}" has no plain version`);
    else if (entry.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`) out.push(`package-lock.json: "${path}" isn't the registry's tarball of ${name}@${version}`);
    if (typeof entry.integrity !== "string" || !SHA512.test(entry.integrity)) out.push(`package-lock.json: "${path}" has no complete sha512 hash`);
    for (const field of DEPENDENCY_FIELDS) {
      if (field in entry && !isObject(entry[field])) out.push(`package-lock.json: "${path}" ${field} isn't a list of dependencies`);
      for (const [dep, spec] of Object.entries(isObject(entry[field]) ? (entry[field] as Json) : {})) {
        if (typeof spec !== "string" || !isRange(spec)) out.push(`package-lock.json: "${path}" depends on ${dep} by something other than a version range`);
      }
    }
    // npm treats any truthy value as "has install scripts": only the exact `true` a package already had may stay.
    if ("hasInstallScript" in entry && !(entry.hasInstallScript === true && old?.hasInstallScript === true)) out.push(`package-lock.json: "${path}" gains an install script`);
    if (SEMVER.test(version)) checks.push({ path, name, version, entry });
  }
  // What the registry publishes for each new version: the hash and the dependency lists must be its own.
  const queue = [...checks];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const published = await registry(c.name, c.version).catch(() => null);
      if (!published) { out.push(`package-lock.json: the registry doesn't answer for ${c.name}@${c.version}`); continue; }
      if (published.integrity !== c.entry.integrity) out.push(`package-lock.json: "${c.path}" has another hash than the registry's for ${c.name}@${c.version}`);
      for (const field of [...DEPENDENCY_FIELDS, "peerDependenciesMeta"]) {
        if (!same(sorted(published[field as keyof RegistryVersion] as Record<string, unknown> | undefined), sorted(c.entry[field] as Record<string, unknown> | undefined))) {
          out.push(`package-lock.json: "${c.path}" ${field} differ from what the registry publishes for ${c.name}@${c.version}`);
        }
      }
      // What it installs as commands and where it may install: as published. npm leaves libc out of a lockfile, so only a written one is compared.
      if (!same(binMap(c.name, published.bin), binMap(c.name, c.entry.bin))) out.push(`package-lock.json: "${c.path}" bin differs from what the registry publishes for ${c.name}@${c.version}`);
      for (const field of ["engines", "os", "cpu"] as const) {
        if (!same(published[field] ?? null, c.entry[field] ?? null)) out.push(`package-lock.json: "${c.path}" ${field} differs from what the registry publishes for ${c.name}@${c.version}`);
      }
      if ("libc" in c.entry && !same(published.libc ?? null, c.entry.libc)) out.push(`package-lock.json: "${c.path}" libc differs from what the registry publishes for ${c.name}@${c.version}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** A list in key order, an empty one as none. */
function sorted(deps: Record<string, unknown> | undefined): [string, unknown][] {
  return Object.entries(deps ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** Commands a package installs, as npm records them: a single path means the package's own name; paths without a leading ./ */
function binMap(name: string, bin: unknown): [string, unknown][] {
  if (bin === undefined || bin === null) return [];
  const map = typeof bin === "string" ? { [name.split("/").pop()!]: bin } : isObject(bin) ? bin : { "(invalid)": bin };
  return sorted(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === "string" ? v.replace(/^\.\//, "") : v])));
}

/** The npm registry's record of one version. */
export const npmRegistry: Registry = async (name, version) => {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const doc = (await res.json()) as Omit<RegistryVersion, "integrity"> & { dist?: { integrity?: string } };
  if (!doc.dist?.integrity) return null;
  const { optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu, libc } = doc;
  // A published manifest lists an optional dependency under dependencies too; npm's lockfile keeps it only as optional.
  const dependencies = doc.dependencies && Object.fromEntries(Object.entries(doc.dependencies).filter(([k]) => !(optionalDependencies && k in optionalDependencies)));
  return { integrity: doc.dist.integrity, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu, libc };
};

/** The single changed line of compose.yaml must be the RSS-Bridge image. */
export function composeProblems(before: string, after: string): string[] {
  const b = before.split("\n");
  const a = after.split("\n");
  if (b.length !== a.length) return ["infra/compose.yaml: lines are added or removed"];
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(BRIDGE_IMAGE_LINE.test(a[i]!) && BRIDGE_IMAGE_LINE.test(b[i]!))) out.push(`infra/compose.yaml: line ${i + 1} changes and isn't the RSS-Bridge image`);
  }
  return out;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Everything wrong with what is staged, compared with HEAD. */
export async function stagedProblems(registry: Registry = npmRegistry): Promise<string[]> {
  const out: string[] = [];
  const staged = git("diff", "--cached", "--name-status", "--no-renames", "-z").split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let i = 0; i < staged.length; i += 2) {
    const [status, path] = [staged[i]!, staged[i + 1]!];
    if (status !== "M") out.push(`${path}: ${status === "A" ? "added" : status === "D" ? "deleted" : `status ${status}`}; only existing files may change`);
    else if (!ALLOWED(path)) out.push(`${path}: not a file the update may change`);
    else changed.push(path);
  }
  if (git("diff", "--cached", "--summary").trim()) out.push("a file's mode changes");
  for (const path of changed) {
    const before = git("show", `HEAD:${path}`);
    const after = git("show", `:${path}`);
    try {
      if (path === "infra/compose.yaml") out.push(...composeProblems(before, after));
      else if (path === "package-lock.json") out.push(...(await lockProblems(JSON.parse(before), JSON.parse(after), registry)));
      else out.push(...manifestProblems(path, JSON.parse(before), JSON.parse(after)));
    } catch {
      out.push(`${path}: isn't valid JSON`);
    }
  }
  if (!changed.length && !out.length) out.push("nothing is staged");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = await stagedProblems();
  if (found.length) {
    console.error(`The update changes more than it may:\n${found.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("The update changes only dependency versions, registry packages in the lockfile and the RSS-Bridge image.");
}
