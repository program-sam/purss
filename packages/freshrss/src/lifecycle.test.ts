import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ENGINE_FETCH_CACHE_MIN_SECONDS } from "./admin.ts";
import type { ExecRunner } from "./admin.ts";
import { EngineError } from "./errors.ts";
import { DEFAULT_ARCHIVING, ENGINE_IMAGE, EngineLifecycle, buildContainerSpec, loadEngineConfig, renderSystemConfig, renderUserConfig, resolveEgressProxy } from "./lifecycle.ts";
import type { EngineConfig } from "./lifecycle.ts";

test("the engine image is pinned by digest, never by tag alone", () => {
  assert.match(ENGINE_IMAGE, /^docker\.io\/freshrss\/freshrss@sha256:[0-9a-f]{64}$/);
});

test("egress proxy: only an http URL naming an IPv4 address or the container's host alias is accepted", () => {
  assert.deepEqual(resolveEgressProxy("http://host.containers.internal:8946"), { hostPort: "169.254.1.2:8946", display: "http://169.254.1.2:8946" });
  assert.equal(resolveEgressProxy("http://10.89.0.5:3128").hostPort, "10.89.0.5:3128");
  for (const bad of ["https://10.0.0.1:1", "http://egress:8946", "http://user:pw@10.0.0.1:1", "http://10.0.0.1:1/path", "socks5://10.0.0.1:1", "not a url", "http://10.0.0.1:1?x=1"]) {
    assert.throws(() => resolveEgressProxy(bad), EngineError, bad);
  }
});

test("generated engine settings route every fetch through the proxy and allow nothing else internal", () => {
  const php = renderSystemConfig("169.254.1.2:8946");
  assert.match(php, /CURLOPT_PROXYTYPE => CURLPROXY_HTTP/);
  assert.match(php, /CURLOPT_PROXY => '169\.254\.1\.2:8946'/);
  assert.match(php, /'internal_host_allowlist' => \['169\.254\.1\.2:8946'\]/);
  assert.ok(!php.includes("'*'") && !php.includes("0.0.0.0/0"), "SSRF checks are not switched off");
  const user = renderUserConfig(DEFAULT_ARCHIVING, 900);
  assert.match(user, /'keep_period' => 'P90D'/);
  assert.match(user, /'keep_favourites' => false/);
  assert.match(user, /'ttl_default' => 900/);
  assert.match(renderUserConfig(DEFAULT_ARCHIVING, 5), /'ttl_default' => 60/, "never below the engine's cache floor");
});

test("generated engine settings keep every fetch in the shared cache for longer than a refresh run, and set nothing else in limits", () => {
  const php = renderSystemConfig("169.254.1.2:8946");
  assert.match(php, /'limits' => \[\s*'cache_duration_min' => 800,\s*\]/);
  assert.equal(php.match(/'limits' =>/g)!.length, 1);
  assert.equal(ENGINE_FETCH_CACHE_MIN_SECONDS, 800);
  assert.ok(ENGINE_FETCH_CACHE_MIN_SECONDS < 900, "less than the 15-minute refresh cadence, so nothing goes stale");
});

function cfgFor(dir: string, over: Partial<EngineConfig> = {}): EngineConfig {
  return loadEngineConfig("/repo", { PURSS_DATA_DIR: dir }, over);
}

test("container spec: loopback publish only, bind mount of the data dir, no secret on the command line, env pass-through", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-spec-"));
  try {
    const { args, hash } = buildContainerSpec(cfgFor(dir));
    const joined = args.join(" ");
    assert.ok(args.includes("127.0.0.1:8941:80"), "published on loopback only");
    assert.ok(!/\b0\.0\.0\.0\b/.test(joined));
    assert.ok(args.some((a) => a.endsWith(":/var/www/FreshRSS/data:Z")));
    assert.ok(args.includes("PURSS_ENGINE_ADMIN_PASSWORD") && args.includes("PURSS_ENGINE_ADMIN_API_PASSWORD"), "values are inherited from the environment");
    assert.ok(!args.some((a) => /PASSWORD=/.test(a)), "no password value on the command line");
    assert.ok(args.some((a) => a.startsWith("FRESHRSS_INSTALL=") && a.includes("--api-enabled") && a.includes("--disable-update")));
    assert.ok(args.some((a) => a.startsWith("FRESHRSS_USER=") && a.includes("--no-default-feeds")), "no default feeds that would fetch before the proxy is in effect");
    assert.ok(args.some((a) => a === "CRON_MIN=3,18,33,48"));
    assert.equal(args.at(-1), ENGINE_IMAGE);
    assert.notEqual(buildContainerSpec(cfgFor(dir, { hostPort: 9999 })).hash, hash, "a changed setting changes the spec hash");
    assert.equal(buildContainerSpec(cfgFor(dir)).hash, hash, "and the hash is stable otherwise");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A pretend podman + engine, enough to exercise the lifecycle's decisions. */
function fakeHost(dir: string, cfg: EngineConfig) {
  const calls: string[][] = [];
  let container: { running: boolean; spec: string } | null = null;
  let adminExists = true;
  let loginWorks = true;
  let identity = "ab".repeat(32);
  let egress: "unchanged" | "updated" = "unchanged";
  const run: ExecRunner = async (file, args, opts) => {
    calls.push([file, ...args]);
    const [cmd, sub] = args;
    if (file !== "podman") return { exitCode: 127, stdout: "", stderr: "" };
    if (cmd === "--version") return { exitCode: 0, stdout: "podman version 5", stderr: "" };
    if (cmd === "image" && sub === "exists") return { exitCode: 0, stdout: "", stderr: "" };
    if (cmd === "container" && sub === "inspect") return container ? { exitCode: 0, stdout: `${container.running ? "running" : "exited"}|${container.spec}\n`, stderr: "" } : { exitCode: 125, stdout: "", stderr: "no such container" };
    if (cmd === "run") {
      assert.ok(opts.env?.PURSS_ENGINE_ADMIN_PASSWORD, "the password is handed over through the environment");
      const label = args.find((a) => a.startsWith("purss.engine.spec="))!;
      container = { running: true, spec: label.split("=")[1]! };
      writeFileSync(path.join(cfg.engineDir, "applied_migrations.txt"), "x");
      return { exitCode: 0, stdout: "id", stderr: "" };
    }
    if (cmd === "start") { container!.running = true; return { exitCode: 0, stdout: "", stderr: "" }; }
    if (cmd === "restart") { container!.running = true; adminExists = true; loginWorks = true; return { exitCode: 0, stdout: "", stderr: "" }; }
    if (cmd === "rm") { container = null; return { exitCode: 0, stdout: "", stderr: "" }; }
    if (cmd === "unshare") { rmSync(cfg.engineDir, { recursive: true, force: true }); return { exitCode: 0, stdout: "", stderr: "" }; }
    if (cmd === "exec") {
      if (args.includes("./cli/list-users.php")) return { exitCode: 0, stdout: adminExists ? "purss-engine-admin\n" : "", stderr: "" };
      if (args.includes("./cli/update-user.php")) { loginWorks = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args.some((a) => a.includes("applied") || a.includes("salt"))) return { exitCode: 0, stdout: identity, stderr: "" };
      if (args.some((a) => a.includes("curl_options"))) return { exitCode: 0, stdout: egress, stderr: "" };
      if (args.some((a) => a.includes("archiving"))) return { exitCode: 0, stdout: JSON.stringify({ archiving: { keep_period: "P90D" }, ttl_default: 900 }), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (!container?.running) throw new Error("refused");
    if (url.endsWith("/api/greader.php")) return new Response("OK");
    if (url.endsWith("/accounts/ClientLogin")) return loginWorks ? new Response("SID=x\nAuth=x/y\n") : new Response("no", { status: 401 });
    return new Response("nope", { status: 404 });
  };
  return {
    calls, run, fetchFn,
    get container() { return container; },
    set container(v) { container = v; },
    breakAdmin(exists: boolean) { adminExists = exists; loginWorks = false; },
    setEgress(v: "unchanged" | "updated") { egress = v; },
    setIdentity(v: string) { identity = v; },
  };
}

async function lifecycleFor(over: Partial<EngineConfig> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-life-"));
  const cfg = cfgFor(dir, over);
  const host = fakeHost(dir, cfg);
  const logs: string[] = [];
  const life = new EngineLifecycle(cfg, { run: host.run, fetch: host.fetchFn, log: (l) => logs.push(l), sleep: async () => {} });
  return { dir, cfg, host, life, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("first up generates 0600 secrets and settings before the container exists, then reports healthy", async () => {
  const t = await lifecycleFor();
  try {
    const status = await t.life.up();
    assert.equal(status.healthy, true, status.problems.join("; "));
    const secretFile = path.join(t.cfg.secretsDir, "engine-admin");
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    const secret = JSON.parse(readFileSync(secretFile, "utf8"));
    assert.match(secret.password, /^[0-9a-f]{32}$/);
    assert.match(secret.apiPassword, /^[0-9a-f]{32}$/);
    assert.ok(existsSync(path.join(t.cfg.engineDir, "config.custom.php")));
    assert.ok(existsSync(path.join(t.cfg.engineDir, "config-user.custom.php")));
    const record = JSON.parse(readFileSync(path.join(t.cfg.engineDir, "purss-engine.json"), "utf8"));
    assert.equal(record.egressProxy, "http://169.254.1.2:8946");
    assert.equal(record.archiving.keep_max, 1000);
    const runIdx = t.host.calls.findIndex((c) => c[1] === "run");
    assert.ok(runIdx > 0);
    assert.equal(status.identity, `freshrss:${"ab".repeat(16)}`);
  } finally { t.cleanup(); }
});

test("up is idempotent: a running, current container is left alone and the secret is not regenerated", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    const secretBefore = readFileSync(path.join(t.cfg.secretsDir, "engine-admin"), "utf8");
    t.host.calls.length = 0;
    const again = await t.life.up();
    assert.equal(again.healthy, true);
    assert.equal(t.host.calls.some((c) => ["run", "rm", "start", "restart"].includes(c[1]!)), false);
    assert.equal(readFileSync(path.join(t.cfg.secretsDir, "engine-admin"), "utf8"), secretBefore);
  } finally { t.cleanup(); }
});

test("a stopped container is started again without recreating it", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    t.host.container!.running = false;
    t.host.calls.length = 0;
    await t.life.up();
    assert.ok(t.host.calls.some((c) => c[1] === "start"));
    assert.ok(!t.host.calls.some((c) => c[1] === "run" || c[1] === "rm"));
  } finally { t.cleanup(); }
});

test("changed container settings recreate the container but never touch the data directory", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    writeFileSync(path.join(t.cfg.engineDir, "users-marker"), "keep me");
    const changed = new EngineLifecycle({ ...t.cfg, cronMin: "5,35" }, { run: t.host.run, fetch: t.host.fetchFn, sleep: async () => {} });
    t.host.calls.length = 0;
    await changed.up();
    assert.ok(t.host.calls.some((c) => c[1] === "rm"));
    assert.ok(t.host.calls.some((c) => c[1] === "run"));
    assert.ok(!t.host.calls.some((c) => c[1] === "unshare"));
    assert.equal(readFileSync(path.join(t.cfg.engineDir, "users-marker"), "utf8"), "keep me");
  } finally { t.cleanup(); }
});

test("an interrupted first start resumes: install marker present, secret reused", async () => {
  const t = await lifecycleFor();
  try {
    // first attempt dies after the container started but before it was ready
    t.host.container = null;
    await t.life.up();
    const first = readFileSync(path.join(t.cfg.secretsDir, "engine-admin"), "utf8");
    await t.life.down();
    assert.equal(t.host.container, null);
    await t.life.up();
    assert.equal(readFileSync(path.join(t.cfg.secretsDir, "engine-admin"), "utf8"), first, "the same credentials are used on resume");
  } finally { t.cleanup(); }
});

test("a missing operator admin is repaired by restarting (which re-runs first-run setup), not by deleting data", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    t.host.breakAdmin(false);
    t.host.calls.length = 0;
    const s = await t.life.up();
    assert.equal(s.healthy, true);
    assert.ok(t.host.calls.some((c) => c[1] === "restart"));
    assert.ok(!t.host.calls.some((c) => c[1] === "unshare" || c[1] === "rm"));
  } finally { t.cleanup(); }
});

test("an admin that exists but cannot log in gets its API password reset", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    t.host.breakAdmin(true);
    t.host.calls.length = 0;
    await t.life.up();
    assert.ok(t.host.calls.some((c) => c.includes("./cli/update-user.php")));
  } finally { t.cleanup(); }
});

test("egress drift is corrected in place and reported by status", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    t.host.setEgress("updated");
    const s = await t.life.status();
    assert.equal(s.egress.enforced, "drift");
    assert.equal(s.healthy, false);
  } finally { t.cleanup(); }
});

test("status of a missing engine is unhealthy with a plain reason and does not throw", async () => {
  const t = await lifecycleFor();
  try {
    const s = await t.life.status();
    assert.equal(s.healthy, false);
    assert.ok(s.problems.includes("container does not exist"));
  } finally { t.cleanup(); }
});

test("reset needs the exact container name, only deletes directories carrying this tool's marker, and says what it removes", async () => {
  const t = await lifecycleFor();
  try {
    await t.life.up();
    const desc = t.life.describeReset();
    assert.ok(desc.secretFiles.some((f) => f.endsWith("engine-admin")));
    await assert.rejects(t.life.reset("yes"), (e: unknown) => e instanceof EngineError && /confirmation/.test(e.message));
    assert.ok(existsSync(t.cfg.engineDir));
    const r = await t.life.reset(t.cfg.containerName);
    assert.equal(r.deletedEngineDir, true);
    assert.equal(existsSync(path.join(t.cfg.secretsDir, "engine-admin")), false);
    assert.equal(t.host.container, null);

    // a directory that is not ours is never deleted
    mkdirSync(t.cfg.engineDir, { recursive: true });
    writeFileSync(path.join(t.cfg.engineDir, "important.txt"), "x");
    await assert.rejects(t.life.reset(t.cfg.containerName), (e: unknown) => e instanceof EngineError && /marker/.test(e.message));
    assert.ok(existsSync(path.join(t.cfg.engineDir, "important.txt")));
  } finally { t.cleanup(); }
});
