#!/usr/bin/env node
/**
 * The weekly dependency update (.github/workflows/weekly-updates.yml). It changes only what is safe to
 * take after the tests pass, and reports the rest for a person:
 *
 * - npm: every dependency of every workspace goes to its newest release within its major version
 *   (within its minor for 0.x), never above the package's `latest` tag, keeping the way it is written
 *   (exact or ^); then the lockfile's indirect dependencies are refreshed within their ranges. A newer
 *   major is reported.
 * - The phone apps' native plugins (everything apps/mobile depends on) are only reported: a new
 *   version can need a store release (plan/39).
 * - RSS-Bridge (infra/compose.yaml) moves to the newest image; the workflow then compares the two
 *   images on every bridged service before keeping it.
 * - FreshRSS is only reported, both a new version and a rebuilt image of the pinned one: the engine
 *   tests that would check it need podman networking a CI runner lacks, and a new version needs the
 *   engine allowlist and reference commit checked (docs/development.md).
 * - GitHub Actions with a newer major version are reported.
 *
 *   node scripts/update-dependencies.ts [--summary <file.md>] [--manual <file.md>] [--outputs <file>] [--message <file>]
 *
 * --outputs writes `changed`, `bridge_old`, `bridge_new` and `manual` lines (GITHUB_OUTPUT format).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- versions (pure, tested in update-dependencies.test.mjs)

type Version = [number, number, number];

/** A plain release version (1.2.3), or null for pre-releases, ranges and anything else. */
export function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** How a dependency is written: an exact version or a caret range of one; anything else isn't touched. */
export function parseSpec(spec: string): { prefix: "" | "^"; version: Version } | null {
  const m = /^(\^?)(\d+\.\d+\.\d+)$/.exec(spec.trim());
  const version = m ? parseVersion(m[2]!) : null;
  return m && version ? { prefix: m[1] as "" | "^", version } : null;
}

/** The newest release that is no breaking change from `current`: same major, or same minor for 0.x. */
export function newestCompatible(current: Version, versions: string[]): Version | null {
  let best: Version | null = null;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (!v || v[0] !== current[0] || (current[0] === 0 && v[1] !== current[1])) continue;
    if (compareVersions(v, current) > 0 && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** The newest release of all, when it is a breaking change from `current`. */
export function newestBreaking(current: Version, versions: string[]): Version | null {
  let best: Version | null = null;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (!v) continue;
    const breaking = v[0] > current[0] || (current[0] === 0 && v[0] === 0 && v[1] > current[1]);
    if (breaking && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

export const showVersion = (v: Version): string => v.join(".");

/**
 * The versions a package offers: none above its `latest` tag. A version above it is no release of the
 * line people install (a mistaken or abandoned publish, such as @capgo/capacitor-updater 10.0.0 for
 * Capacitor 5); a `latest` that is no plain release leaves the list as it is.
 */
export function offered(versions: string[], latest: string | undefined): string[] {
  const top = latest ? parseVersion(latest) : null;
  return top ? versions.filter((raw) => { const v = parseVersion(raw); return !v || compareVersions(v, top) <= 0; }) : versions;
}

// ---------- registries

/**
 * What an image tag points at now on Docker Hub: its digest (the multi-platform index when there is one)
 * and the digests of the platform images inside it. A pin of either kind is current while it is among them.
 */
export async function hubDigests(repository: string, tag: string): Promise<{ digest: string; all: Set<string> }> {
  const token = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`).then((r) => r.json() as Promise<{ token: string }>);
  const res = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  const digest = res.headers.get("docker-content-digest");
  if (!res.ok || !digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`No digest for ${repository}:${tag} (HTTP ${res.status}).`);
  const body = (await res.json()) as { manifests?: { digest: string }[] };
  return { digest, all: new Set([digest, ...(body.manifests ?? []).map((m) => m.digest)]) };
}

async function github(pathname: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "purss-weekly-updates" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${pathname}: HTTP ${res.status}`);
  return res.json();
}

function npmVersions(name: string): string[] {
  const r = spawnSync("npm", ["view", name, "versions", "dist-tags", "--json"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm view ${name} failed: ${r.stderr.trim().split("\n").at(-1)}`);
  const parsed = JSON.parse(r.stdout) as { versions: string[] | string; "dist-tags"?: { latest?: string } };
  return offered([parsed.versions].flat(), parsed["dist-tags"]?.latest);
}

// ---------- the update

type Manifest = { file: string; json: Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } };

function manifests(): Manifest[] {
  const files = ["package.json"];
  for (const dir of ["apps", "packages"]) {
    for (const name of readdirSync(path.join(repo, dir))) {
      try { readFileSync(path.join(repo, dir, name, "package.json")); files.push(path.join(dir, name, "package.json")); } catch { /* not a package */ }
    }
  }
  return files.map((file) => ({ file, json: JSON.parse(readFileSync(path.join(repo, file), "utf8")) }));
}

async function main(): Promise<void> {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const updated: string[] = [];
  const manual: string[] = [];
  const outputs: Record<string, string> = { changed: "false", bridge_old: "", bridge_new: "", manual: "false" };

  // npm
  const all = manifests();
  const mobile = all.find((m) => m.file === path.join("apps", "mobile", "package.json"));
  const native = new Set(Object.keys({ ...mobile?.json.dependencies, ...mobile?.json.devDependencies }).filter((n) => !n.startsWith("@purss/")));
  const versions = new Map<string, string[]>();
  const reported = new Set<string>();
  for (const m of all) {
    let changed = false;
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = m.json[field];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const parsed = name.startsWith("@purss/") ? null : parseSpec(spec);
        if (!parsed) continue;
        if (!versions.has(name)) versions.set(name, npmVersions(name));
        const list = versions.get(name)!;
        const breaking = newestBreaking(parsed.version, list);
        const compatible = newestCompatible(parsed.version, list);
        if (native.has(name)) {
          const newer = breaking ?? compatible;
          if (newer && !reported.has(name)) {
            reported.add(name);
            manual.push(`- \`${name}\` ${showVersion(parsed.version)} → ${showVersion(newer)}: a phone app native plugin, so it needs an app release (plan/39)`);
          }
          continue;
        }
        if (compatible) {
          deps[name] = `${parsed.prefix}${showVersion(compatible)}`;
          updated.push(`- \`${name}\` ${showVersion(parsed.version)} → ${showVersion(compatible)} (${m.file})`);
          changed = true;
        }
        if (breaking && !reported.has(name)) {
          reported.add(name);
          manual.push(`- \`${name}\` ${showVersion(compatible ?? parsed.version)} → ${showVersion(breaking)}: a new major version`);
        }
      }
    }
    if (changed) writeFileSync(path.join(repo, m.file), `${JSON.stringify(m.json, null, 2)}\n`);
  }
  const lockBefore = readFileSync(path.join(repo, "package-lock.json"), "utf8");
  for (const args of [["install"], ["update"]]) {
    const r = spawnSync("npm", [...args, "--no-audit", "--no-fund"], { cwd: repo, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`npm ${args[0]} failed`);
  }
  if (readFileSync(path.join(repo, "package-lock.json"), "utf8") !== lockBefore && !updated.length) updated.push("- Indirect npm dependencies refreshed within their ranges (package-lock.json)");

  // RSS-Bridge
  const composeFile = path.join(repo, "infra/compose.yaml");
  const compose = readFileSync(composeFile, "utf8");
  const bridge = /docker\.io\/rssbridge\/rss-bridge@(sha256:[0-9a-f]{64})/.exec(compose);
  if (bridge) {
    const { digest: latest, all } = await hubDigests("rssbridge/rss-bridge", "latest");
    if (!all.has(bridge[1]!)) {
      writeFileSync(composeFile, compose.replace(bridge[1]!, latest));
      outputs.bridge_old = `docker.io/rssbridge/rss-bridge@${bridge[1]}`;
      outputs.bridge_new = `docker.io/rssbridge/rss-bridge@${latest}`;
      updated.push(`- RSS-Bridge image ${bridge[1]!.slice(7, 19)} → ${latest.slice(7, 19)} (infra/compose.yaml)`);
    }
  }

  // FreshRSS: reported only (see above).
  const containerText = readFileSync(path.join(repo, "infra/engine/image/Containerfile"), "utf8");
  const engine = /docker\.io\/freshrss\/freshrss:(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})/.exec(containerText);
  if (engine) {
    const [, version, digest] = engine;
    const { digest: current, all } = await hubDigests("freshrss/freshrss", version!);
    if (!all.has(digest!)) {
      manual.push(`- FreshRSS ${version} image rebuilt upstream (${digest!.slice(7, 19)} → ${current.slice(7, 19)}): update infra/engine/image/Containerfile and packages/freshrss/src/lifecycle.ts, then run the engine tests`);
    }
    const release = (await github("/repos/FreshRSS/FreshRSS/releases/latest")) as { tag_name: string };
    const latest = parseVersion(release.tag_name);
    const pinned = parseVersion(version!);
    if (latest && pinned && compareVersions(latest, pinned) > 0) {
      manual.push(`- FreshRSS ${version} → ${showVersion(latest)}: check the engine allowlist and reference commit (docs/development.md), then run the engine tests`);
    }
  }

  // GitHub Actions: majors only, reported.
  const workflows = path.join(repo, ".github/workflows");
  const uses = new Map<string, number>();
  for (const f of readdirSync(workflows)) {
    for (const m of readFileSync(path.join(workflows, f), "utf8").matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@v(\d+)\b/g)) uses.set(m[1]!, Number(m[2]));
  }
  for (const [action, major] of uses) {
    const release = (await github(`/repos/${action}/releases/latest`).catch(() => null)) as { tag_name?: string } | null;
    const latest = Number(/^v(\d+)/.exec(release?.tag_name ?? "")?.[1]);
    if (latest > major) manual.push(`- GitHub Action \`${action}\` v${major} → v${latest}`);
  }

  outputs.changed = String(updated.length > 0);
  outputs.manual = String(manual.length > 0);
  const summary = [
    "## Weekly dependency update",
    "",
    updated.length ? "Taken, if the checks pass:" : "Nothing to take this week.",
    ...updated,
    "",
    manual.length ? "Needs a person:" : "Nothing needs a person.",
    ...manual,
    "",
  ].join("\n");
  console.log(summary);
  const out = (name: string, text: string) => { const f = arg(name); if (f) appendFileSync(f, text); };
  out("summary", `${summary}\n`);
  out("manual", manual.length ? `Found by the weekly update check on ${new Date().toISOString().slice(0, 10)}. These aren't taken automatically:\n\n${manual.join("\n")}\n` : "");
  out("message", `Weekly dependency update\n\n${updated.join("\n")}\n`);
  out("outputs", Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
