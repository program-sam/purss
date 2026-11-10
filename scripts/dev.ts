// Run the whole stack locally: FreshRSS (podman), egress proxy, API (serving the built
// web app) and worker. Ctrl+C stops everything, including the engine container unless
// --keep-engine is given. Usage: npm run dev [-- --no-build] [-- --keep-engine]
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../apps/api/src/config.ts";
import { ensureDir, ensureSecret } from "../apps/api/src/secrets.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const children: { name: string; proc: ChildProcess }[] = [];
let stopping = false;

function run(name: string, cmd: string, argv: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const proc = spawn(cmd, argv, { cwd: repo, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (line: string) => `${name.padEnd(7)}| ${line}`;
  for (const stream of [proc.stdout!, proc.stderr!]) {
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (!/ExperimentalWarning|--trace-warnings/.test(l)) console.log(prefix(l));
    });
  }
  proc.on("exit", (code, signal) => {
    if (!stopping) {
      console.log(prefix(`exited (${signal ?? code}); stopping the stack`));
      void shutdown(1);
    }
  });
  children.push({ name, proc });
  return proc;
}

function engine(command: "up" | "down"): boolean {
  const r = spawnSync(process.execPath, ["scripts/engine.ts", command], { cwd: repo, stdio: "inherit" });
  return r.status === 0;
}
function bridge(command: "up" | "down"): boolean {
  const r = spawnSync(process.execPath, ["scripts/bridge.ts", command], { cwd: repo, stdio: "inherit" });
  return r.status === 0;
}

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
  if (!args.has("--keep-engine")) {
    engine("down");
    bridge("down");
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

if (!args.has("--no-build")) {
  const b = spawnSync("npm", ["run", "build", "-w", "@purss/web"], { cwd: repo, stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
// Shared secrets the services read at start-up (the API would also create them, but egress starts first).
const config = loadConfig();
ensureDir(config.secretsDir);
ensureSecret(config.secretsDir, "service-token");
ensureSecret(config.secretsDir, "bridge-key");
// The bridge (plan/41): RSS-Bridge in podman behind the egress router. Without it the stack runs and those services say they have no feeds.
const bridgePort = Number(process.env.PURSS_BRIDGE_BACKEND_PORT ?? 8944);
if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
  console.error("PURSS_BRIDGE_BACKEND_PORT must be a port number.");
  process.exit(1);
}
const bridgeEnv: NodeJS.ProcessEnv = bridge("up") ? { EGRESS_BRIDGE_BACKEND: `http://127.0.0.1:${bridgePort}` } : {};
if (!bridgeEnv.EGRESS_BRIDGE_BACKEND) console.error("The bridge didn't start; Telegram, Bandcamp and the other bridged services can't be followed in this run.");
run("egress", process.execPath, ["apps/egress/src/main.ts"], bridgeEnv);
if (!engine("up")) {
  console.error("The FreshRSS engine didn't start; see the messages above.");
  await shutdown(1);
}
run("api", process.execPath, ["apps/api/src/main.ts"], bridgeEnv.EGRESS_BRIDGE_BACKEND ? { PURSS_BRIDGE_URL: "http://127.0.0.1:8945" } : {});
await new Promise((r) => setTimeout(r, 800));
run("worker", process.execPath, ["apps/worker/src/main.ts"]);
