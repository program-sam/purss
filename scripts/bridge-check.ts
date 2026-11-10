#!/usr/bin/env node
/**
 * Does an RSS-Bridge image still serve every bridged service (plan/41)? Runs the image with the
 * settings Compose uses, asks it for each service's example account through the real bridge router,
 * and, given a baseline image, compares: a service that works on the baseline and fails on the
 * candidate (also when asked again) is a regression. A service failing on both is the service's
 * problem, not the update's, and is only reported. An image that doesn't start, or a baseline on
 * which no service works, says nothing about the update: that is inconclusive. Used by the weekly
 * update check. Exit 0: no regression; 1: a regression; 2: inconclusive.
 *
 *   node scripts/bridge-check.ts --candidate <image> [--baseline <image>] [--summary <file.md>]
 *
 * Needs docker or podman. Requests go straight out (no egress proxy), as on a CI runner.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_SERVICES, bridgeRoutePath } from "@purss/connectors";
import { BridgeLog } from "../apps/egress/src/bridge/log.ts";
import { BridgeRouter, rssBridgeBackend } from "../apps/egress/src/bridge/router.ts";
import { composeBridge } from "./bridge-config.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const engine = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0 ? "docker" : "podman";
const run = (args: string[]) => spawnSync(engine, args, { encoding: "utf8" });

type Result = { status: number; entries: number; outcome: string };

class Inconclusive extends Error {}

const ATTEMPTS = 3;

async function check(image: string, port: number): Promise<Map<string, Result>> {
  const name = `purss-bridge-check-${port}`;
  run(["rm", "-f", name]);
  // The proxy setting points at egress, which a check run doesn't have.
  const env = composeBridge(repo).env.filter(([k]) => k !== "RSSBRIDGE_proxy_url" && k !== "RSSBRIDGE_proxy_by_bridge");
  const started = run(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:80`, ...env.flatMap(([k, v]) => ["-e", `${k}=${v}`]), image]);
  if (started.status !== 0) throw new Error(`${image} didn't start: ${started.stderr.trim()}`);
  try {
    const base = `http://127.0.0.1:${port}`;
    // One minute in all to answer, each try at most five seconds (an image can accept and then say nothing).
    const deadline = Date.now() + 60_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(base, { signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now()))) }).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) throw new Inconclusive(`${image} didn't answer within a minute.`);
    const secret = randomBytes(32).toString("base64url");
    const log = new BridgeLog();
    const results = new Map<string, Result>();
    for (const s of BRIDGE_SERVICES) {
      // A failure is asked again (a fresh router each time, so no back-off) before it counts: services have bad minutes.
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const router = new BridgeRouter({ secret, backends: [rssBridgeBackend(base)], log });
        const a = await router.serve(s.id, s.example, bridgeRoutePath(secret, s.id, s.example).split("/").at(-1)!);
        const last = log.db.prepare("SELECT outcome, entries FROM bridge_fetches WHERE service = ? ORDER BY id DESC LIMIT 1").get(s.id) as { outcome: string; entries: number } | undefined;
        results.set(s.id, { status: a.status, entries: last?.entries ?? 0, outcome: last?.outcome ?? "none" });
        if (a.status === 200) break;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    log.close();
    return results;
  } finally {
    run(["rm", "-f", name]);
  }
}

const candidate = arg("candidate");
if (!candidate) {
  console.error("usage: node scripts/bridge-check.ts --candidate <image> [--baseline <image>] [--summary <file.md>]");
  process.exit(2);
}
const baselineImage = arg("baseline");
const summaryFile = arg("summary");
let after: Map<string, Result>;
let before: Map<string, Result> | null;
try {
  after = await check(candidate, 18944);
  before = baselineImage ? await check(baselineImage, 18945) : null;
  if (before && ![...before.values()].some((r) => r.status === 200)) throw new Inconclusive("No service works on the current image either, so the new one can't be judged.");
} catch (e) {
  const message = `RSS-Bridge check inconclusive: ${e instanceof Error ? e.message : String(e)}`;
  console.error(message);
  if (summaryFile) appendFileSync(summaryFile, `${message}\n`);
  process.exit(2);
}

const shown = (r: Result | undefined) => (!r ? "–" : r.status === 200 ? `${r.entries} posts` : `failed (${r.outcome})`);
const lines = ["| Service | Account | " + (before ? "Current image | " : "") + "New image |", "| --- | --- | " + (before ? "--- | " : "") + "--- |"];
const regressions: string[] = [];
const failingBoth: string[] = [];
for (const s of BRIDGE_SERVICES) {
  const a = after.get(s.id);
  const b = before?.get(s.id);
  lines.push(`| ${s.name} | ${s.example} | ${before ? `${shown(b)} | ` : ""}${shown(a)} |`);
  if (a?.status !== 200 && (!before || b?.status === 200)) regressions.push(s.name);
  else if (a?.status !== 200) failingBoth.push(s.name);
}
const report = [
  `RSS-Bridge check of \`${candidate}\`${baselineImage ? ` against \`${baselineImage}\`` : ""}:`,
  "",
  ...lines,
  "",
  regressions.length ? `**Fails on the new image only:** ${regressions.join(", ")}.` : "No service fails on the new image that works on the current one.",
  ...(failingBoth.length ? [`Failing on both (the service, not the update): ${failingBoth.join(", ")}.`] : []),
  "",
].join("\n");
console.log(report);
if (summaryFile) appendFileSync(summaryFile, `${report}\n`);
process.exit(regressions.length ? 1 : 0);
