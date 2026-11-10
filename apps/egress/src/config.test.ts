import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, parseInternalDestinations } from "./config.ts";
import { control, TOKEN } from "./testing.ts";

function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "purss-egress-cfg-"));
  try {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "service-token"), `${TOKEN}\n`, { mode: 0o600 });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults bind loopback ports 8946/8947/8949 and register the gateway as the one internal destination", () => {
  withDataDir((dir) => {
    const c = loadConfig({ PURSS_DATA_DIR: dir }, "/");
    assert.deepEqual(c.proxy, { host: "127.0.0.1", port: 8946 });
    assert.deepEqual(c.gateway, { host: "127.0.0.1", port: 8947 });
    assert.deepEqual(c.control, { host: "127.0.0.1", port: 8949 });
    assert.equal(c.serviceToken, TOKEN);
    assert.equal(c.gatewayDbPath, join(dir, "egress", "gateway.db"));
    assert.deepEqual(c.internalDestinations, [{ host: "feed-gateway.internal", port: 8947, connectHost: "127.0.0.1", connectPort: 8947 }]);
    assert.equal(c.limits.maxResponseBytes, 32 * 1024 * 1024);
  });
});

test("listeners refuse wildcard and public addresses; control may use a private internal address", () => {
  withDataDir((dir) => {
    for (const [name, value] of [["EGRESS_PROXY_HOST", "0.0.0.0"], ["EGRESS_GATEWAY_HOST", "::"], ["EGRESS_PROXY_HOST", "8.8.8.8"], ["EGRESS_CONTROL_HOST", "8.8.4.4"], ["EGRESS_CONTROL_HOST", "0.0.0.0"], ["EGRESS_PROXY_HOST", "example.com"]] as const) {
      assert.throws(() => loadConfig({ PURSS_DATA_DIR: dir, [name]: value }, "/"), ConfigError, `${name}=${value}`);
    }
    assert.equal(loadConfig({ PURSS_DATA_DIR: dir, EGRESS_CONTROL_HOST: "10.0.0.1" }, "/").control.host, "10.0.0.1");
    const c = loadConfig({ PURSS_DATA_DIR: dir, EGRESS_PROXY_HOST: "10.89.0.1", EGRESS_GATEWAY_HOST: "10.89.0.1" }, "/");
    assert.equal(c.internalDestinations[0]!.connectHost, "10.89.0.1");
  });
});

test("the service token must exist and be long enough; ports and limits are range-checked", () => {
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/nonexistent-purss" }, "/"), /service token file/);
  withDataDir((dir) => {
    writeFileSync(join(dir, "secrets", "service-token"), "short");
    assert.throws(() => loadConfig({ PURSS_DATA_DIR: dir }, "/"), /too short/);
    writeFileSync(join(dir, "secrets", "service-token"), TOKEN);
    assert.throws(() => loadConfig({ PURSS_DATA_DIR: dir, EGRESS_PROXY_PORT: "70000" }, "/"), ConfigError);
    assert.throws(() => loadConfig({ PURSS_DATA_DIR: dir, EGRESS_MAX_RESPONSE_BYTES: "12" }, "/"), ConfigError);
    assert.throws(() => loadConfig({ PURSS_DATA_DIR: dir, EGRESS_IDLE_TIMEOUT_MS: "abc" }, "/"), ConfigError);
  });
});

test("internal destinations are exact name:port mappings to fixed IP addresses", () => {
  assert.deepEqual(parseInternalDestinations("Bridge.internal:3000=10.89.0.5:3000; other.internal:81=[fd00::5]:81"), [
    { host: "bridge.internal", port: 3000, connectHost: "10.89.0.5", connectPort: 3000 },
    { host: "other.internal", port: 81, connectHost: "fd00::5", connectPort: 81 },
  ]);
  for (const bad of ["bridge:3000", "bridge.internal:3000=somehost:3000", "*.internal:3000=10.0.0.1:3000", "a.internal:0=10.0.0.1:1", "a.internal:70000=10.0.0.1:1", "a.internal=10.0.0.1:1"]) {
    assert.throws(() => parseInternalDestinations(bad), ConfigError, bad);
  }
});

test("no environment variable turns the address rules off", () => {
  withDataDir((dir) => {
    const c = loadConfig({ PURSS_DATA_DIR: dir, EGRESS_ALLOW_PRIVATE: "1", EGRESS_DISABLE_SSRF: "true", PURSS_ALLOW_PRIVATE_ADDRESSES: "1", EGRESS_ALLOW_ALL: "yes" }, "/");
    assert.deepEqual(Object.keys(c).sort(), ["bridge", "control", "dataDir", "gateway", "gatewayDbPath", "internalDestinations", "limits", "proxy", "serviceToken"]);
    assert.equal(c.internalDestinations.length, 1);
  });
});

test("main.ts starts the three listeners, answers the control status, and stops cleanly on SIGTERM", async () => {
  await withDataDirAsync(async (dir) => {
    const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "main.ts")], {
      env: { PATH: process.env.PATH ?? "", PURSS_DATA_DIR: dir, EGRESS_PROXY_PORT: "0", EGRESS_GATEWAY_PORT: "0", EGRESS_CONTROL_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      // A loaded machine (the full suite runs files in parallel) can take well over the usual second to start a process.
      const line = await new Promise<string>((resolve, reject) => {
        let waiting = true;
        const timer = setTimeout(() => {
          waiting = false;
          reject(new Error(`no start line; stderr: ${err}`));
        }, 30_000);
        const check = () => {
          if (!waiting) return;
          const l = out.split("\n").find((x) => x.includes("egress.listening"));
          if (l) {
            waiting = false;
            clearTimeout(timer);
            resolve(l);
          } else setTimeout(check, 25);
        };
        check();
      });
      const event = JSON.parse(line) as { control: string; proxy: string };
      const controlPort = Number(event.control.split(":")[1]);
      const status = await control(controlPort, "GET", "/status");
      assert.deepEqual(status.json, { status: "ok", blockedLastHour: 0, allowedLastHour: 0 });
      assert.doesNotMatch(out, new RegExp(TOKEN), "the service token is never logged");
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.match(out, /egress\.stopping/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});

test("main.ts exits with a plain message when the service token is missing", async () => {
  const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "main.ts")], { env: { PATH: process.env.PATH ?? "", PURSS_DATA_DIR: "/nonexistent-purss-dir" }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(err, /service token file .* could not be read/);
});

async function withDataDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "purss-egress-main-"));
  try {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "service-token"), TOKEN, { mode: 0o600 });
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the bridge router runs only with a backend; it needs the bridge key and is reachable from the engine by its alias only", () => {
  withDataDir((dir) => {
    assert.equal(loadConfig({ PURSS_DATA_DIR: dir }, "/").bridge, null, "no backend, no router");
    const env = { PURSS_DATA_DIR: dir, EGRESS_BRIDGE_BACKEND: "http://172.31.89.20:80" };
    assert.throws(() => loadConfig(env, "/"), /bridge key/, "the key is required");
    writeFileSync(join(dir, "secrets", "bridge-key"), "short", { mode: 0o600 });
    assert.throws(() => loadConfig(env, "/"), /too short/);
    writeFileSync(join(dir, "secrets", "bridge-key"), `${"b".repeat(43)}\n`, { mode: 0o600 });
    const c = loadConfig({ ...env, EGRESS_BRIDGE_HOST: "172.31.88.10" }, "/");
    assert.deepEqual(c.bridge, { host: "172.31.88.10", port: 8945, backendUrl: "http://172.31.89.20", secret: "b".repeat(43), dbPath: join(dir, "egress", "bridge.db"), net: null });
    assert.deepEqual(loadConfig({ ...env, EGRESS_BRIDGE_NET_HOST: "172.31.89.10" }, "/").bridge?.net, { host: "172.31.89.10", dnsPort: 53 });
    assert.throws(() => loadConfig({ ...env, EGRESS_BRIDGE_NET_HOST: "8.8.8.8" }, "/"), ConfigError);
    assert.deepEqual(c.internalDestinations.at(-1), { host: "feed-bridge.internal", port: 8945, connectHost: "172.31.88.10", connectPort: 8945 });
    for (const backend of ["https://172.31.89.20", "http://example.com", "http://8.8.8.8", "http://u:p@10.0.0.2", "http://10.0.0.2/x"]) {
      assert.throws(() => loadConfig({ ...env, EGRESS_BRIDGE_BACKEND: backend }, "/"), ConfigError, backend);
    }
    assert.throws(() => loadConfig({ ...env, EGRESS_BRIDGE_HOST: "0.0.0.0" }, "/"), ConfigError);
  });
});
