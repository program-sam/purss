/**
 * Interrupted first-run recovery against the real container (plan/06 gate: "idempotent installation and interrupted-setup
 * recovery"). Each scenario builds a half-finished engine on disk, then checks that `up` completes it without deleting
 * anything and without changing the credentials it already generated.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { EngineLifecycle, GReaderClient, buildContainerSpec, loadEngineConfig, randomHex, renderSystemConfig, renderUserConfig, resolveEgressProxy } from "@purss/freshrss";
import type { EngineConfig } from "@purss/freshrss";
import { TestProxy } from "./support/proxy.ts";
import { waitFor } from "./support/harness.ts";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const lifecycles: EngineLifecycle[] = [];
let proxy: TestProxy;

before(async () => {
  proxy = new TestProxy([]);
  await proxy.start();
});

after(async () => {
  for (const l of lifecycles) await l.down().catch(() => {});
  for (const r of roots) await run("podman", ["unshare", "rm", "-rf", "--", r]).catch(() => rmSync(r, { recursive: true, force: true }));
  await proxy.stop();
}, { timeout: 120_000 });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function fresh(): Promise<{ cfg: EngineConfig; life: EngineLifecycle }> {
  const id = randomHex(4);
  const root = path.join(REPO, "data", "test-engine", `resume-${id}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const cfg = loadEngineConfig(REPO, { PURSS_DATA_DIR: root }, {
    containerName: `purss-freshrss-resume-${id}`,
    hostPort: await freePort(),
    egressProxy: `http://host.containers.internal:${proxy.port}`,
  });
  const life = new EngineLifecycle(cfg, { log: () => {} });
  lifecycles.push(life);
  return { cfg, life };
}

/** Starts the engine container the way `up` would, but without the entrypoint's user-creation step (an install that stopped early). */
async function startInstallOnly(life: EngineLifecycle, cfg: EngineConfig): Promise<void> {
  const secret = { password: randomHex(16), apiPassword: randomHex(16) };
  // `up` writes these first; reproduce its order so the install picks them up.
  mkdirSync(cfg.secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(life.adminSecretFile, `${JSON.stringify({ username: cfg.adminUsername, ...secret }, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(cfg.engineDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(cfg.engineDir, "config.custom.php"), renderSystemConfig(resolveEgressProxy(cfg.egressProxy).hostPort));
  writeFileSync(path.join(cfg.engineDir, "config-user.custom.php"), renderUserConfig(cfg.archiving, cfg.ttlDefaultSeconds));
  const args = buildContainerSpec(cfg).args;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]?.startsWith("FRESHRSS_USER=")) {
      i += 1;
      continue;
    }
    filtered.push(args[i]!);
  }
  await run("podman", filtered, { env: { ...process.env, PURSS_ENGINE_ADMIN_PASSWORD: secret.password, PURSS_ENGINE_ADMIN_API_PASSWORD: secret.apiPassword } });
  await waitFor(async () => existsSync(path.join(cfg.engineDir, "applied_migrations.txt")), { timeoutMs: 120_000, everyMs: 1000, what: "the install to finish" });
  await run("podman", ["rm", "--force", "--time", "10", cfg.containerName]);
}

describe("interrupted first run", () => {
  test("install finished but the operator user was never created: up completes it and keeps the generated credentials", { timeout: 300_000 }, async () => {
    const { cfg, life } = await fresh();
    await startInstallOnly(life, cfg);
    assert.equal(existsSync(path.join(cfg.engineDir, "users", cfg.adminUsername)), false, "precondition: no operator user yet");
    const secretBefore = readFileSync(life.adminSecretFile, "utf8");
    const saltBefore = readFileSync(path.join(cfg.engineDir, "config.php"), "utf8").match(/'salt' => '([0-9a-f]+)'/)?.[1];

    const status = await life.up();
    assert.equal(status.healthy, true, status.problems.join("; "));
    assert.equal(readFileSync(life.adminSecretFile, "utf8"), secretBefore, "credentials unchanged");
    assert.equal(readFileSync(path.join(cfg.engineDir, "config.php"), "utf8").match(/'salt' => '([0-9a-f]+)'/)?.[1], saltBefore, "the install was not redone");
    const secret = life.readAdminSecret()!;
    await new GReaderClient({ baseUrl: life.baseUrl, username: secret.username, apiPassword: secret.apiPassword }).login();
  });

  test("install marker lost before the user existed: the install is redone cleanly and the engine comes up", { timeout: 300_000 }, async () => {
    const { cfg, life } = await fresh();
    await startInstallOnly(life, cfg);
    rmSync(path.join(cfg.engineDir, "applied_migrations.txt"), { force: true });
    assert.ok(existsSync(path.join(cfg.engineDir, "config.php")), "precondition: a config exists without the completion marker");
    const status = await life.up();
    assert.equal(status.healthy, true, status.problems.join("; "));
    assert.ok(existsSync(path.join(cfg.engineDir, "applied_migrations.txt")));
  });

  test("operator user directory removed from a stopped engine: the next start recreates it, nothing else is touched", { timeout: 300_000 }, async () => {
    const { cfg, life } = await fresh();
    await life.up();
    const identity = await life.admin().engineIdentity();
    const other = await life.admin().ensureUser({ username: "bystander", apiPassword: randomHex(16) });
    assert.equal(other.created, true);
    await run("podman", ["stop", "--time", "20", cfg.containerName]);
    await run("podman", ["unshare", "rm", "-rf", "--", path.join(cfg.engineDir, "users", cfg.adminUsername)]);
    assert.equal(readdirSync(path.join(cfg.engineDir, "users")).includes("bystander"), true);

    const status = await life.up();
    assert.equal(status.healthy, true, status.problems.join("; "));
    assert.equal(await life.admin().engineIdentity(), identity, "same engine");
    assert.equal(readdirSync(path.join(cfg.engineDir, "users")).includes("bystander"), true, "other users untouched");
  });

  test("running up again changes nothing: same container, same credentials", { timeout: 300_000 }, async () => {
    const { life } = await fresh();
    await life.up();
    const idOf = async () => (await run("podman", ["container", "inspect", life.cfg.containerName, "--format", "{{.Id}}"])).stdout.trim();
    const before = { id: await idOf(), secret: readFileSync(life.adminSecretFile, "utf8") };
    await life.up();
    await life.up();
    assert.equal(await idOf(), before.id, "the container was not recreated");
    assert.equal(readFileSync(life.adminSecretFile, "utf8"), before.secret);
  });
});
