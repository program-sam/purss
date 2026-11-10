import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_FETCH_CACHE_MIN_SECONDS, EngineAdmin, nodeExec } from "./admin.ts";
import type { ExecResult, ExecRunner } from "./admin.ts";
import { EngineError } from "./errors.ts";
import { GReaderClient } from "./greader.ts";
import { redactText } from "./redact.ts";

/**
 * Development/self-host lifecycle of the pinned FreshRSS engine container (podman, rootless).
 * Operator tooling only: the worker never starts or stops the engine. See infra/engine/README.md.
 */

export const ENGINE_VERSION = "1.30.4";
export const ENGINE_IMAGE_DIGEST = "sha256:a003730e81c89abf86c3ca9c8b263c818804734b574469d59586234364f425b0";
export const ENGINE_IMAGE = `docker.io/freshrss/freshrss@${ENGINE_IMAGE_DIGEST}`;
/** Upstream commit the integration notes were checked against (docs and source of the pinned release). */
export const ENGINE_REFERENCE_COMMIT = "08f97bd497ace733c151ea1c709d85cd5b65cc53";
/** Address under which the container reaches the host's loopback (pasta `--map-host-loopback`). */
export const HOST_LOOPBACK_ALIAS = "169.254.1.2";
export const DEFAULT_EGRESS_PROXY = "http://host.containers.internal:8946";
export const DEFAULT_ENGINE_PORT = 8941;
export const DEFAULT_CONTAINER = "purss-freshrss";

export type ArchivingPolicy = {
  keep_period: string; // ISO-8601 duration
  keep_max: number;
  keep_min: number;
  keep_favourites: boolean;
  keep_labels: boolean;
  keep_unreads: boolean;
};

/**
 * Upstream retention of the engine, applied to every user created after the policy file is written.
 * FreshRSS removes an entry only when it is no longer among the feed's newest `keep_min` by last-seen time,
 * was seen before the feed's most recent refresh, and is either older than `keep_period` or beyond `keep_max`.
 * The engine is a transit buffer; baskets and kept items live in the product database.
 */
export const DEFAULT_ARCHIVING: ArchivingPolicy = {
  keep_period: "P90D",
  keep_max: 1000,
  keep_min: 50,
  keep_favourites: false,
  keep_labels: false,
  keep_unreads: false,
};

export type EngineConfig = {
  containerName: string;
  hostPort: number;
  /** Bind-mounted FreshRSS data directory (config, users, SQLite files). */
  engineDir: string;
  secretsDir: string;
  /** HTTP forward proxy all feed fetches must use. Host must be an IP literal or `host.containers.internal`. */
  egressProxy: string;
  cronMin: string;
  adminUsername: string;
  archiving: ArchivingPolicy;
  ttlDefaultSeconds: number;
  memoryLimit: string;
};

export function loadEngineConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env, overrides: Partial<EngineConfig> = {}): EngineConfig {
  const dataDir = path.resolve(env.PURSS_DATA_DIR ?? path.join(repoRoot, "data"));
  const port = Number(env.PURSS_ENGINE_PORT ?? DEFAULT_ENGINE_PORT);
  return {
    containerName: env.PURSS_ENGINE_CONTAINER ?? DEFAULT_CONTAINER,
    hostPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_ENGINE_PORT,
    engineDir: path.join(dataDir, "engine"),
    secretsDir: path.join(dataDir, "secrets"),
    egressProxy: env.PURSS_EGRESS_PROXY ?? DEFAULT_EGRESS_PROXY,
    cronMin: env.PURSS_ENGINE_CRON_MIN ?? "3,18,33,48",
    adminUsername: "purss-engine-admin",
    archiving: DEFAULT_ARCHIVING,
    ttlDefaultSeconds: 900,
    memoryLimit: "1g",
    ...overrides,
  };
}

export type EngineAdminSecret = { username: string; password: string; apiPassword: string };

/** Resolves the proxy URL to the `host:port` FreshRSS will use. FreshRSS validates proxy IPs itself, so no names. */
export function resolveEgressProxy(url: string): { hostPort: string; display: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EngineError("rejected", "PURSS_EGRESS_PROXY is not a valid URL.", { retryable: false });
  }
  if (u.protocol !== "http:") throw new EngineError("rejected", "PURSS_EGRESS_PROXY must be an http:// forward proxy URL.", { retryable: false });
  if (u.username || u.password) throw new EngineError("rejected", "PURSS_EGRESS_PROXY must not contain credentials.", { retryable: false });
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new EngineError("rejected", "PURSS_EGRESS_PROXY must be only scheme, host and port.", { retryable: false });
  const port = u.port ? Number(u.port) : 80;
  let host = u.hostname;
  if (host === "host.containers.internal" || host === "host.docker.internal") host = HOST_LOOPBACK_ALIAS;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new EngineError("rejected", "PURSS_EGRESS_PROXY must use an IPv4 address or host.containers.internal: the engine only resolves proxy names through DNS, not /etc/hosts.", { retryable: false });
  }
  return { hostPort: `${host}:${port}`, display: `http://${host}:${port}` };
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function writeAtomic(file: string, content: string, mode: number): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return true;
}

function phpString(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function renderSystemConfig(proxyHostPort: string): string {
  return `<?php
// Generated by purss (scripts/engine.ts). Read by FreshRSS's installer when it builds data/config.php.
// All feed fetches must use the egress proxy; the proxy's own address is the only internal host allowed.
return [
	'curl_options' => [
		CURLOPT_PROXYTYPE => CURLPROXY_HTTP,
		CURLOPT_PROXY => ${phpString(proxyHostPort)},
	],
	'internal_host_allowlist' => [${phpString(proxyHostPort)}],
	// FreshRSS shares one fetch cache between its users (key: feed address and fetch options). Holding a fetch this long
	// (more than a refresh run, less than the 15-minute cadence) keeps no-cache feeds from being fetched again per user.
	// Only this key of 'limits' is given: FreshRSS merges config.php over its defaults key by key when it reads it.
	'limits' => [
		'cache_duration_min' => ${ENGINE_FETCH_CACHE_MIN_SECONDS},
	],
];
`;
}

export function renderUserConfig(policy: ArchivingPolicy, ttlSeconds: number): string {
  const b = (v: boolean) => (v ? "true" : "false");
  return `<?php
// Generated by purss (scripts/engine.ts). Applied by FreshRSS to every user created after this file exists.
return [
	'archiving' => [
		'keep_period' => ${phpString(policy.keep_period)},
		'keep_max' => ${policy.keep_max},
		'keep_min' => ${policy.keep_min},
		'keep_favourites' => ${b(policy.keep_favourites)},
		'keep_labels' => ${b(policy.keep_labels)},
		'keep_unreads' => ${b(policy.keep_unreads)},
	],
	'ttl_default' => ${Math.max(60, Math.floor(ttlSeconds))},
];
`;
}

export type ContainerSpec = { args: string[]; hash: string };

export function buildContainerSpec(cfg: EngineConfig): ContainerSpec {
  const labels = {
    install:
      "--default-user purss-engine-admin --auth-type form --environment production --base-url " +
      `http://127.0.0.1:${cfg.hostPort} --title purss-engine --language en --api-enabled ` +
      "--allow-anonymous=false --allow-anonymous-refresh=false --allow-robots=false --disable-update",
    user: "--user purss-engine-admin --password $PURSS_ENGINE_ADMIN_PASSWORD --api-password $PURSS_ENGINE_ADMIN_API_PASSWORD --no-default-feeds --language en",
  };
  const stable = [
    ENGINE_IMAGE,
    cfg.containerName,
    cfg.hostPort,
    cfg.engineDir,
    cfg.cronMin,
    cfg.memoryLimit,
    labels,
  ];
  const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24);
  const args = [
    "run",
    "--detach",
    "--name", cfg.containerName,
    "--hostname", cfg.containerName,
    "--label", "purss.engine=freshrss",
    "--label", `purss.engine.spec=${hash}`,
    // Run as root inside a user namespace in which the host user *is* www-data: the entrypoint needs root,
    // Apache/PHP drop to www-data, and the files they create on the bind mount belong to the host user.
    "--userns", "keep-id:uid=33,gid=33",
    "--user", "0:0",
    // The host loopback (where the egress proxy listens) is reachable only at this one address.
    "--network", `pasta:--map-host-loopback,${HOST_LOOPBACK_ALIAS}`,
    "--publish", `127.0.0.1:${cfg.hostPort}:80`,
    "--volume", `${cfg.engineDir}:/var/www/FreshRSS/data:Z`,
    "--memory", cfg.memoryLimit,
    "--pids-limit", "512",
    "--pull", "missing",
    "--env", "TZ=UTC",
    "--env", `CRON_MIN=${cfg.cronMin}`,
    "--env", "ENABLE_ACCESS_LOG=0",
    "--env", `FRESHRSS_INSTALL=${labels.install}`,
    "--env", `FRESHRSS_USER=${labels.user}`,
    // Values come from the podman process environment, not the command line.
    "--env", "PURSS_ENGINE_ADMIN_PASSWORD",
    "--env", "PURSS_ENGINE_ADMIN_API_PASSWORD",
    ENGINE_IMAGE,
  ];
  return { args, hash };
}

export type ContainerState = {
  exists: boolean;
  running: boolean;
  status: string;
  specHash: string | null;
};

export type EngineStatus = {
  container: ContainerState & { name: string; specCurrent: boolean };
  installed: boolean;
  url: string;
  api: { reachable: boolean; adminLogin: boolean };
  identity: string | null;
  users: string[] | null;
  egress: { proxy: string; enforced: "ok" | "drift" | "unknown" };
  policy: { archiving: ArchivingPolicy; ttlDefaultSeconds: number; cronMin: string; effectiveAdmin: Record<string, unknown> | null };
  healthy: boolean;
  problems: string[];
};

export type LifecycleDeps = {
  run?: ExecRunner;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Command prefix for fixed admin operations; defaults to `podman exec --user www-data <container>`. */
  execPrefix?: readonly string[];
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EngineLifecycle {
  readonly cfg: EngineConfig;
  readonly #run: ExecRunner;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #prefix: readonly string[];

  constructor(cfg: EngineConfig, deps: LifecycleDeps = {}) {
    this.cfg = cfg;
    this.#run = deps.run ?? nodeExec;
    this.#fetch = deps.fetch ?? fetch;
    this.#log = deps.log ?? (() => {});
    this.#sleep = deps.sleep ?? sleepMs;
    this.#prefix = deps.execPrefix ?? ["podman", "exec", "--user", "www-data", cfg.containerName];
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.cfg.hostPort}`;
  }
  get adminSecretFile(): string {
    return path.join(this.cfg.secretsDir, "engine-admin");
  }
  get stateFile(): string {
    return path.join(this.cfg.engineDir, "purss-engine.json");
  }

  admin(): EngineAdmin {
    return new EngineAdmin({ prefix: this.#prefix, run: this.#run });
  }

  readAdminSecret(): EngineAdminSecret | null {
    if (!existsSync(this.adminSecretFile)) return null;
    const parsed = JSON.parse(readFileSync(this.adminSecretFile, "utf8")) as Partial<EngineAdminSecret>;
    if (!parsed.username || !parsed.password || !parsed.apiPassword) throw new EngineError("rejected", "The engine admin secret file is incomplete.", { retryable: false });
    return { username: parsed.username, password: parsed.password, apiPassword: parsed.apiPassword };
  }

  async up(): Promise<EngineStatus> {
    const proxy = resolveEgressProxy(this.cfg.egressProxy);
    await this.#preflight();

    mkdirSync(this.cfg.secretsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.cfg.engineDir, { recursive: true, mode: 0o700 });

    // Secrets and generated settings exist BEFORE the container's first start, so an interrupted first start
    // resumes with the same credentials and the very first fetch already goes through the proxy.
    let secret = this.readAdminSecret();
    if (!secret) {
      secret = { username: this.cfg.adminUsername, password: randomHex(16), apiPassword: randomHex(16) };
      writeAtomic(this.adminSecretFile, `${JSON.stringify(secret, null, 2)}\n`, 0o600);
      this.#log("generated engine admin credentials (data/secrets/engine-admin)");
    }
    writeAtomic(path.join(this.cfg.engineDir, "config.custom.php"), renderSystemConfig(proxy.hostPort), 0o640);
    writeAtomic(path.join(this.cfg.engineDir, "config-user.custom.php"), renderUserConfig(this.cfg.archiving, this.cfg.ttlDefaultSeconds), 0o640);
    writeAtomic(
      this.stateFile,
      `${JSON.stringify(
        {
          engine: "freshrss",
          version: ENGINE_VERSION,
          image: ENGINE_IMAGE,
          referenceCommit: ENGINE_REFERENCE_COMMIT,
          egressProxy: proxy.display,
          cronMin: this.cfg.cronMin,
          archiving: this.cfg.archiving,
          ttlDefaultSeconds: this.cfg.ttlDefaultSeconds,
        },
        null,
        2,
      )}\n`,
      0o640,
    );

    const spec = buildContainerSpec(this.cfg);
    let state = await this.#inspect();
    if (state.exists && state.specHash !== spec.hash) {
      this.#log("container settings changed; recreating the container (data directory is kept)");
      await this.#podman(["rm", "--force", "--time", "20", this.cfg.containerName]);
      state = { exists: false, running: false, status: "absent", specHash: null };
    }
    if (!state.exists) {
      this.#log(`starting ${this.cfg.containerName}`);
      await this.#podman(spec.args, { env: { PURSS_ENGINE_ADMIN_PASSWORD: secret.password, PURSS_ENGINE_ADMIN_API_PASSWORD: secret.apiPassword } });
    } else if (!state.running) {
      this.#log(`starting existing ${this.cfg.containerName}`);
      await this.#podman(["start", this.cfg.containerName]);
    }

    await this.#waitForApi();
    await this.#ensureAdmin(secret);
    await this.#reconcileEgress(proxy.hostPort);
    const status = await this.status();
    if (!status.healthy) throw new EngineError("unavailable", `The engine started but is not healthy: ${status.problems.join("; ")}`, { retryable: false });
    return status;
  }

  async down(): Promise<{ removed: boolean }> {
    const state = await this.#inspect();
    if (!state.exists) return { removed: false };
    await this.#podman(["rm", "--force", "--time", "20", this.cfg.containerName]);
    return { removed: true };
  }

  async status(): Promise<EngineStatus> {
    const state = await this.#inspect();
    const spec = buildContainerSpec(this.cfg);
    const secret = this.#tryReadSecret();
    const problems: string[] = [];
    const installed = existsSync(path.join(this.cfg.engineDir, "applied_migrations.txt"));
    if (!state.exists) problems.push("container does not exist");
    else if (!state.running) problems.push(`container is ${state.status}`);
    else if (state.specHash !== spec.hash) problems.push("container settings differ from the current configuration (run `up` to recreate it)");
    if (!installed) problems.push("engine is not installed yet");

    let reachable = false;
    let adminLogin = false;
    if (state.running) {
      reachable = await this.#apiOk();
      if (reachable && secret) {
        try {
          await new GReaderClient({ baseUrl: this.baseUrl, username: secret.username, apiPassword: secret.apiPassword, fetch: this.#fetch, requestTimeoutMs: 10_000 }).login();
          adminLogin = true;
        } catch {
          problems.push("operator admin cannot log in to the engine API");
        }
      } else if (!reachable) problems.push("engine API is not answering");
      if (!secret) problems.push("operator admin secret file is missing");
    }

    let identity: string | null = null;
    let users: string[] | null = null;
    let effectiveAdmin: Record<string, unknown> | null = null;
    let enforced: "ok" | "drift" | "unknown" = "unknown";
    if (state.running && reachable) {
      const admin = this.admin();
      try {
        identity = await admin.engineIdentity();
        users = await admin.listUsers();
        effectiveAdmin = secret ? await admin.readUserArchiving(secret.username) : null;
        enforced = (await admin.applyEgressConfig({ proxyHostPort: resolveEgressProxy(this.cfg.egressProxy).hostPort, dryRun: true })) === "unchanged" ? "ok" : "drift";
        if (enforced === "drift") problems.push("engine egress proxy configuration differs from the expected one");
      } catch (e) {
        problems.push(`engine administration check failed: ${e instanceof EngineError ? e.message : "unknown error"}`);
      }
    }
    return {
      container: { ...state, name: this.cfg.containerName, specCurrent: state.exists && state.specHash === spec.hash },
      installed,
      url: this.baseUrl,
      api: { reachable, adminLogin },
      identity,
      users,
      egress: { proxy: resolveEgressProxy(this.cfg.egressProxy).display, enforced },
      policy: { archiving: this.cfg.archiving, ttlDefaultSeconds: this.cfg.ttlDefaultSeconds, cronMin: this.cfg.cronMin, effectiveAdmin },
      healthy: problems.length === 0,
      problems,
    };
  }

  /** What `reset` would delete, for the confirmation prompt. */
  describeReset(): { container: string; engineDir: string; secretFiles: string[]; engineDirExists: boolean } {
    const secretFiles: string[] = [];
    if (existsSync(this.adminSecretFile)) secretFiles.push(this.adminSecretFile);
    const usersDir = path.join(this.cfg.secretsDir, "engine-users");
    if (existsSync(usersDir)) for (const f of readdirSync(usersDir)) secretFiles.push(path.join(usersDir, f));
    return { container: this.cfg.containerName, engineDir: this.cfg.engineDir, secretFiles, engineDirExists: existsSync(this.cfg.engineDir) };
  }

  /** Destroys the engine's data. Only for an explicit operator reset; `up` never does this. */
  async reset(confirm: string): Promise<{ deletedEngineDir: boolean; deletedSecrets: number }> {
    if (confirm !== this.cfg.containerName) throw new EngineError("rejected", `Reset refused: the confirmation must equal the container name (${this.cfg.containerName}).`, { retryable: false });
    const desc = this.describeReset();
    if (desc.engineDirExists && !existsSync(this.stateFile)) {
      throw new EngineError("rejected", "Reset refused: the engine directory does not carry this tool's state marker, so it is not ours to delete.", { retryable: false });
    }
    await this.down();
    let deletedEngineDir = false;
    if (desc.engineDirExists) {
      // `podman unshare` also removes files owned by the container's subordinate ids.
      const r = await this.#run("podman", ["unshare", "rm", "-rf", "--", this.cfg.engineDir], { timeoutMs: 120_000 });
      if (r.exitCode !== 0 && existsSync(this.cfg.engineDir)) rmSync(this.cfg.engineDir, { recursive: true, force: true });
      deletedEngineDir = !existsSync(this.cfg.engineDir);
    }
    for (const f of desc.secretFiles) rmSync(f, { force: true });
    return { deletedEngineDir, deletedSecrets: desc.secretFiles.length };
  }

  // -- steps -----------------------------------------------------------------------------------------------

  async #preflight(): Promise<void> {
    const v = await this.#run("podman", ["--version"], { timeoutMs: 20_000 }).catch(() => null);
    if (!v || v.exitCode !== 0) throw new EngineError("unavailable", "podman is not available on this machine.", { retryable: false });
    const have = await this.#run("podman", ["image", "exists", ENGINE_IMAGE], { timeoutMs: 20_000 });
    if (have.exitCode !== 0) {
      this.#log(`pulling ${ENGINE_IMAGE}`);
      await this.#podman(["pull", ENGINE_IMAGE], { timeoutMs: 600_000 });
    }
  }

  async #inspect(): Promise<ContainerState> {
    const r = await this.#run("podman", ["container", "inspect", this.cfg.containerName, "--format", "{{.State.Status}}|{{index .Config.Labels \"purss.engine.spec\"}}"], { timeoutMs: 20_000 });
    if (r.exitCode !== 0) return { exists: false, running: false, status: "absent", specHash: null };
    const [status = "unknown", spec = ""] = r.stdout.trim().split("|");
    return { exists: true, running: status === "running", status, specHash: spec || null };
  }

  async #podman(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ExecResult> {
    const r = await this.#run("podman", args, { timeoutMs: opts.timeoutMs ?? 120_000, env: opts.env });
    if (r.exitCode !== 0) {
      const detail = redactText(r.stderr.trim().split("\n").slice(-3).join(" | "), []);
      throw new EngineError("unavailable", `podman ${args[0]} failed (exit ${r.exitCode})${detail ? `: ${detail}` : ""}`, { retryable: false });
    }
    return r;
  }

  async #apiOk(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.baseUrl}/api/greader.php`, { signal: AbortSignal.timeout(5000) });
      return res.ok && (await res.text()).trim() === "OK";
    } catch {
      return false;
    }
  }

  async #waitForApi(): Promise<void> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const state = await this.#inspect();
      if (!state.running) {
        const logs = await this.#run("podman", ["logs", "--tail", "15", this.cfg.containerName], { timeoutMs: 20_000 }).catch(() => null);
        const tail = redactText(((logs?.stdout ?? "") + (logs?.stderr ?? "")).trim().split("\n").slice(-6).join(" | "));
        throw new EngineError("unavailable", `The engine container stopped during start-up (${state.status}): ${tail}`, { retryable: false });
      }
      if (existsSync(path.join(this.cfg.engineDir, "applied_migrations.txt")) && (await this.#apiOk())) return;
      if (Date.now() > deadline) throw new EngineError("timeout", "The engine did not become ready within two minutes.", { retryable: false });
      await this.#sleep(1000);
    }
  }

  /** The entrypoint creates the admin at every start when it is missing; repair only if login still fails. */
  async #ensureAdmin(secret: EngineAdminSecret): Promise<void> {
    const login = async () => {
      try {
        await new GReaderClient({ baseUrl: this.baseUrl, username: secret.username, apiPassword: secret.apiPassword, fetch: this.#fetch, requestTimeoutMs: 15_000 }).login();
        return true;
      } catch {
        return false;
      }
    };
    if (await login()) return;
    const admin = this.admin();
    if (!(await admin.userExists(secret.username))) {
      this.#log("operator admin missing after start; restarting so the entrypoint re-runs first-run setup");
      await this.#podman(["restart", "--time", "20", this.cfg.containerName]);
      await this.#waitForApi();
      if (await login()) return;
    }
    if (await admin.userExists(secret.username)) {
      this.#log("operator admin exists but cannot log in; resetting its API password");
      await admin.setApiPassword({ username: secret.username, apiPassword: secret.apiPassword });
      if (await login()) return;
    }
    throw new EngineError("unavailable", "The operator admin could not be created or logged in. Inspect the container logs; `reset-confirm` is the explicit way to start over.", { retryable: false });
  }

  async #reconcileEgress(proxyHostPort: string): Promise<void> {
    const outcome = await this.admin().applyEgressConfig({ proxyHostPort });
    if (outcome === "updated") this.#log("engine egress proxy configuration was out of date and has been corrected in place");
  }

  #tryReadSecret(): EngineAdminSecret | null {
    try {
      return this.readAdminSecret();
    } catch {
      return null;
    }
  }
}
