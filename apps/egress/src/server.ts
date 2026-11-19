import { chmodSync, mkdirSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { Resolver } from "@purss/connectors";
import { createBridgeServer } from "./bridge/http.ts";
import { BridgeLog } from "./bridge/log.ts";
import { crossrefBackend } from "./bridge/crossref.ts";
import { BridgeRouter, rssBridgeBackend } from "./bridge/router.ts";
import type { BridgeBackend } from "./bridge/router.ts";
import type { EgressConfig } from "./config.ts";
import { createControlServer, loopbackHosts } from "./control.ts";
import { createDnsServer } from "./dns.ts";
import { createGatewayServer } from "./gateway/http.ts";
import { TrimService } from "./gateway/trim-service.ts";
import type { TrimServeOptions } from "./gateway/trim-service.ts";
import { createProxyServer } from "./proxy.ts";
import type { Logger } from "./proxy.ts";
import { EgressStats } from "./stats.ts";

export type StartDeps = {
  log?: Logger;
  /** TEST ONLY, in-process: let the proxy reach local upstream servers. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, in-process DNS stand-in. */
  resolver?: Resolver;
  now?: () => number;
  /** TEST ONLY: replaces the bridge router's backends (RSS-Bridge's and Crossref's). */
  bridgeBackends?: readonly BridgeBackend[];
  /** TEST ONLY: limits of the trimming of big feeds. */
  trimLimits?: TrimServeOptions;
};

export type RunningEgress = {
  ports: { proxy: number; gateway: number; control: number; bridge: number | null };
  stats: EgressStats;
  /** The trimming of big feeds; null when this installation has no feed-trim key. */
  trim: TrimService | null;
  bridgeLog: BridgeLog | null;
  stop: () => Promise<void>;
};

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startEgress(config: EgressConfig, deps: StartDeps = {}): Promise<RunningEgress> {
  const stats = new EgressStats(deps.now);

  let bridgeLog: BridgeLog | null = null;
  let bridgeServer: http.Server | null = null;
  if (config.bridge) {
    if (config.bridge.dbPath !== ":memory:") mkdirSync(dirname(config.bridge.dbPath), { recursive: true, mode: 0o700 });
    bridgeLog = new BridgeLog({ path: config.bridge.dbPath, now: deps.now });
    if (config.bridge.dbPath !== ":memory:") chmodSync(config.bridge.dbPath, 0o600);
    const router = new BridgeRouter({ secret: config.bridge.secret, backends: deps.bridgeBackends ?? [
      crossrefBackend({ testAllowAddress: deps.testAllowAddress }),
      ...(config.bridge.backendUrl ? [rssBridgeBackend(config.bridge.backendUrl)] : []),
    ], log: bridgeLog, now: deps.now });
    bridgeServer = createBridgeServer(router, { log: deps.log });
  }
  const proxy = createProxyServer({ config, stats, log: deps.log, testAllowAddress: deps.testAllowAddress, resolver: deps.resolver });
  // On the bridge container's network: the same proxy rules, and the only name resolution it has.
  const bridgeNet = config.bridge?.net ?? null;
  const bridgeProxy = bridgeNet ? createProxyServer({ config, stats, log: deps.log, testAllowAddress: deps.testAllowAddress, resolver: deps.resolver }) : null;
  const dns = bridgeNet ? createDnsServer({ log: deps.log }) : null;
  let dnsBound = false;
  const closeAll = () => {
    bridgeLog?.close();
    if (dnsBound) dns?.close();
  };
  // Big feeds are fetched with the same address rules as the proxy's: safeFetch, with the same in-process test allowances.
  const trim = config.trimKey
    ? new TrimService({ secret: config.trimKey, log: deps.log, now: deps.now, limits: deps.trimLimits, testAllowAddress: deps.testAllowAddress, resolver: deps.resolver })
    : null;
  const gatewayServer = createGatewayServer({ log: deps.log, trim });
  // The API reaches the listener at the address it is bound to (a private one in Compose), so a request addressed there is the
  // listener's own; any other name is refused.
  const controlHost = config.control.host.includes(":") ? `[${config.control.host.toLowerCase()}]` : config.control.host.toLowerCase();
  const control = createControlServer({
    token: config.serviceToken, stats, bridgeLog, log: deps.log,
    allowedHosts: (port) => [...loopbackHosts(port), `${controlHost}:${port}`],
  });
  const started: http.Server[] = [];
  try {
    const gatewayPort = await listen(gatewayServer, config.gateway.host, config.gateway.port);
    started.push(gatewayServer);
    const proxyPort = await listen(proxy, config.proxy.host, config.proxy.port);
    started.push(proxy);
    const controlPort = await listen(control, config.control.host, config.control.port);
    started.push(control);
    let bridgePort: number | null = null;
    if (bridgeServer && config.bridge) {
      bridgePort = await listen(bridgeServer, config.bridge.host, config.bridge.port);
      started.push(bridgeServer);
    }
    if (bridgeProxy && bridgeNet) {
      await listen(bridgeProxy, bridgeNet.host, proxyPort);
      started.push(bridgeProxy);
    }
    if (dns && bridgeNet) {
      await new Promise<void>((resolve, reject) => {
        dns.once("error", reject);
        dns.bind(bridgeNet.dnsPort, bridgeNet.host, () => {
          dns.off("error", reject);
          dnsBound = true;
          resolve();
        });
      });
    }
    return {
      ports: { proxy: proxyPort, gateway: gatewayPort, control: controlPort, bridge: bridgePort },
      stats,
      trim,
      bridgeLog,
      stop: async () => {
        await Promise.all(started.map(close));
        closeAll();
      },
    };
  } catch (error) {
    await Promise.all(started.map(close));
    closeAll();
    throw error;
  }
}
