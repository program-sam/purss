import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { classifyAddress } from "@purss/connectors";

/*
 * Egress configuration. Everything here is operator configuration read once at
 * startup. None of it can relax the address rules applied to user-controlled
 * destinations: the only exceptions are the exact internal destinations listed in
 * `internalDestinations`, matched by host name AND port and connected to a fixed IP.
 */

export type InternalDestination = {
  /** Host name the engine uses in feed URLs, matched exactly (lower-case). */
  host: string;
  port: number;
  /** Fixed address the proxy actually connects to; never resolved through DNS. */
  connectHost: string;
  connectPort: number;
};

export type EgressConfig = {
  proxy: { host: string; port: number };
  gateway: { host: string; port: number };
  control: { host: string; port: number };
  /** The bridge router (plan/41); null when no backend is configured, so nothing listens. */
  bridge: {
    host: string;
    port: number;
    backendUrl: string;
    secret: string;
    dbPath: string;
    /** Egress's own address on the bridge container's network: the proxy and a DNS resolver also listen there. */
    net: { host: string; dnsPort: number } | null;
  } | null;
  dataDir: string;
  serviceToken: string;
  gatewayDbPath: string;
  internalDestinations: InternalDestination[];
  limits: {
    maxConnections: number;
    connectTimeoutMs: number;
    idleTimeoutMs: number;
    requestTimeoutMs: number;
    maxResponseBytes: number;
    maxRequestBodyBytes: number;
    maxTunnelBytes: number;
    maxTunnelMs: number;
  };
};

export class ConfigError extends Error {}

function isLoopback(ip: string): boolean {
  return ip === "::1" || /^127\./.test(ip);
}

/**
 * A listener may bind loopback or a private (RFC 1918 / ULA / link-local) address, so
 * a container network can reach it. Wildcard and public addresses are refused: a
 * proxy or gateway must never be exposed by accident.
 */
export function assertInternalBind(host: string, what: string, opts: { loopbackOnly?: boolean } = {}): void {
  if (isIP(host) === 0) throw new ConfigError(`${what}: "${host}" must be an IP address (use 127.0.0.1 or a private address).`);
  if (isLoopback(host)) return;
  if (opts.loopbackOnly) throw new ConfigError(`${what}: "${host}" is not loopback; this listener only binds 127.0.0.1 or ::1.`);
  if (host === "0.0.0.0" || host === "::") throw new ConfigError(`${what}: refusing to listen on every interface (${host}).`);
  const verdict = classifyAddress(host);
  const isPrivate = !verdict.allowed && /private|link-local|unique local/.test(verdict.range);
  if (!isPrivate) throw new ConfigError(`${what}: "${host}" is not a loopback or private address, so it could be reachable from the internet.`);
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

function portEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const port = intEnv(env, name, fallback, 0, 65535);
  return port;
}

/** `alias.internal:8947=127.0.0.1:8947;other.internal:3000=10.89.0.5:3000` */
export function parseInternalDestinations(value: string | undefined): InternalDestination[] {
  if (!value?.trim()) return [];
  const out: InternalDestination[] = [];
  for (const entry of value.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9.-]*):(\d{1,5})=((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(entry);
    if (!m) throw new ConfigError(`Invalid internal destination "${entry}". Use name:port=ip:port.`);
    const connectHost = m[3]!.replace(/^\[|\]$/g, "");
    const port = Number(m[2]);
    const connectPort = Number(m[4]);
    if (port < 1 || port > 65535 || connectPort < 1 || connectPort > 65535) throw new ConfigError(`Invalid port in internal destination "${entry}".`);
    out.push({ host: m[1]!.toLowerCase(), port, connectHost, connectPort });
  }
  return out;
}

function readSecret(path: string, what: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`The ${what} file ${path} could not be read. Run the installer to generate secrets.`);
  }
  const value = raw.trim();
  if (value.length < 32) throw new ConfigError(`The ${what} in ${path} is too short (at least 32 characters are required).`);
  return value;
}

/** The backend must be a plain http address on this machine or a private network: the router talks to it directly. */
function backendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("EGRESS_BRIDGE_BACKEND must be an address such as http://172.31.89.20:80.");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search) {
    throw new ConfigError("EGRESS_BRIDGE_BACKEND must be a plain http://host:port address.");
  }
  assertInternalBind(url.hostname.replace(/^\[|\]$/g, ""), "EGRESS_BRIDGE_BACKEND");
  return url.origin;
}


/** Build a validated configuration from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): EgressConfig {
  const dataDir = resolve(cwd, env.PURSS_DATA_DIR || "data");
  const proxy = { host: env.EGRESS_PROXY_HOST || "127.0.0.1", port: portEnv(env, "EGRESS_PROXY_PORT", 8946) };
  const gateway = { host: env.EGRESS_GATEWAY_HOST || "127.0.0.1", port: portEnv(env, "EGRESS_GATEWAY_PORT", 8947) };
  const control = { host: env.EGRESS_CONTROL_HOST || "127.0.0.1", port: portEnv(env, "EGRESS_CONTROL_PORT", 8949) };
  assertInternalBind(proxy.host, "EGRESS_PROXY_HOST");
  assertInternalBind(gateway.host, "EGRESS_GATEWAY_HOST");
  // Token-authenticated; loopback by default, or a private address on an internal network (Compose).
  assertInternalBind(control.host, "EGRESS_CONTROL_HOST");
  const tokenPath = env.EGRESS_SERVICE_TOKEN_FILE || join(dataDir, "secrets", "service-token");
  const alias = (env.EGRESS_GATEWAY_ALIAS || "feed-gateway.internal").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(alias)) throw new ConfigError("EGRESS_GATEWAY_ALIAS must be a plain host name.");
  const internalDestinations = parseInternalDestinations(env.EGRESS_INTERNAL_DESTINATIONS);
  // The gateway listener is the one built-in internal destination.
  if (gateway.port !== 0 && !internalDestinations.some((d) => d.host === alias && d.port === gateway.port)) {
    internalDestinations.unshift({ host: alias, port: gateway.port, connectHost: gateway.host, connectPort: gateway.port });
  }
  let bridge: EgressConfig["bridge"] = null;
  if (env.EGRESS_BRIDGE_BACKEND) {
    const host = env.EGRESS_BRIDGE_HOST || "127.0.0.1";
    const port = portEnv(env, "EGRESS_BRIDGE_PORT", 8945);
    assertInternalBind(host, "EGRESS_BRIDGE_HOST");
    const bridgeAlias = (env.EGRESS_BRIDGE_ALIAS || "feed-bridge.internal").toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(bridgeAlias)) throw new ConfigError("EGRESS_BRIDGE_ALIAS must be a plain host name.");
    bridge = {
      host,
      port,
      backendUrl: backendUrl(env.EGRESS_BRIDGE_BACKEND),
      secret: readSecret(env.EGRESS_BRIDGE_KEY_FILE || join(dataDir, "secrets", "bridge-key"), "bridge key"),
      dbPath: env.EGRESS_BRIDGE_DB || join(dataDir, "egress", "bridge.db"),
      net: env.EGRESS_BRIDGE_NET_HOST ? { host: env.EGRESS_BRIDGE_NET_HOST, dnsPort: portEnv(env, "EGRESS_BRIDGE_DNS_PORT", 53) } : null,
    };
    if (bridge.net) assertInternalBind(bridge.net.host, "EGRESS_BRIDGE_NET_HOST");
    // The engine reaches the router only through the proxy, by this name.
    if (port !== 0 && !internalDestinations.some((d) => d.host === bridgeAlias && d.port === port)) {
      internalDestinations.push({ host: bridgeAlias, port, connectHost: host, connectPort: port });
    }
  }
  for (const d of internalDestinations) {
    if (d.port < 1 || d.port > 65535 || d.connectPort < 1) throw new ConfigError(`Internal destination ${d.host}:${d.port} has an invalid port.`);
  }
  return {
    proxy,
    gateway,
    control,
    bridge,
    dataDir,
    serviceToken: readSecret(tokenPath, "service token"),
    gatewayDbPath: env.EGRESS_GATEWAY_DB || join(dataDir, "egress", "gateway.db"),
    internalDestinations,
    limits: {
      maxConnections: intEnv(env, "EGRESS_MAX_CONNECTIONS", 256, 1, 10_000),
      connectTimeoutMs: intEnv(env, "EGRESS_CONNECT_TIMEOUT_MS", 10_000, 100, 120_000),
      idleTimeoutMs: intEnv(env, "EGRESS_IDLE_TIMEOUT_MS", 30_000, 100, 600_000),
      requestTimeoutMs: intEnv(env, "EGRESS_REQUEST_TIMEOUT_MS", 60_000, 100, 3_600_000),
      maxResponseBytes: intEnv(env, "EGRESS_MAX_RESPONSE_BYTES", 32 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
      maxRequestBodyBytes: intEnv(env, "EGRESS_MAX_REQUEST_BODY_BYTES", 1024 * 1024, 0, 64 * 1024 * 1024),
      maxTunnelBytes: intEnv(env, "EGRESS_MAX_TUNNEL_BYTES", 64 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
      maxTunnelMs: intEnv(env, "EGRESS_MAX_TUNNEL_MS", 120_000, 1000, 3_600_000),
    },
  };
}
