#!/usr/bin/env node
/**
 * The development RSS-Bridge (podman), the backend of the egress bridge router (plan/41).
 *
 *   node scripts/bridge.ts up      start it (replacing a container with other settings); idempotent
 *   node scripts/bridge.ts down    stop and remove it
 *
 * It runs the image Compose pins, with the same allowlist and settings, and sends every request
 * through the egress proxy on the host. Unlike Compose, the development container is not cut off
 * from the network otherwise (its name lookups use the host's resolver).
 * Environment: PURSS_BRIDGE_BACKEND_PORT (8944), PURSS_BRIDGE_CONTAINER (purss-rss-bridge).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_LOOPBACK_ALIAS } from "@purss/freshrss";
import { composeBridge } from "./bridge-config.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = process.env.PURSS_BRIDGE_CONTAINER ?? "purss-rss-bridge";
const port = Number(process.env.PURSS_BRIDGE_BACKEND_PORT ?? 8944);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PURSS_BRIDGE_BACKEND_PORT must be a port number.");
  process.exit(2);
}

function podman(args: string[], quiet = false): { ok: boolean; out: string } {
  const r = spawnSync("podman", args, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function up(): number {
  const { image, env } = composeBridge(repo);
  // Requests go to the egress proxy on the host's loopback.
  const settings = env.map(([k, v]) => [k, k === "RSSBRIDGE_proxy_url" ? `http://${HOST_LOOPBACK_ALIAS}:8946` : v] as const);
  const label = `purss.spec=${createHash("sha256").update(JSON.stringify([image, port, settings])).digest("hex")}`;
  const current = podman(["inspect", "--format", "{{.State.Running}} {{index .Config.Labels \"purss.spec\"}}", container], true);
  if (current.ok && current.out === `true ${label.slice("purss.spec=".length)}`) {
    console.log(`bridge      ${container} already running on 127.0.0.1:${port}`);
    return 0;
  }
  if (current.ok) podman(["rm", "-f", container], true);
  const run = podman([
    "run", "-d", "--name", container, "--label", label,
    "--memory", "96m", "--pids-limit", "64",
    "--network", `pasta:--map-host-loopback,${HOST_LOOPBACK_ALIAS}`,
    "-p", `127.0.0.1:${port}:80`,
    ...settings.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image,
  ]);
  if (!run.ok) return 1;
  console.log(`bridge      ${container} on 127.0.0.1:${port} (${image.split("@")[0]})`);
  return 0;
}

function down(): number {
  const r = podman(["rm", "-f", container], true);
  console.log(r.ok ? `removed ${container}` : `no ${container} container to remove`);
  return 0;
}

const command = process.argv[2];
process.exit(command === "up" ? up() : command === "down" ? down() : (console.error("usage: node scripts/bridge.ts up|down"), 2));
