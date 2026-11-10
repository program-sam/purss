import { chmodSync, mkdirSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { Resolver } from "@purss/connectors";
import { createBridgeServer } from "./bridge/http.ts";
import { BridgeLog } from "./bridge/log.ts";
import { BridgeRouter, rssBridgeBackend } from "./bridge/router.ts";
import type { BridgeBackend } from "./bridge/router.ts";
import type { EgressConfig } from "./config.ts";
import { createControlServer, loopbackHosts } from "./control.ts";
import { createDnsServer } from "./dns.ts";
import { createGatewayServer } from "./gateway/http.ts";
import { GatewayService } from "./gateway/service.ts";
import type { GatewayAdapter } from "./gateway/types.ts";
import { createProxyServer } from "./proxy.ts";
import type { Logger } from "./proxy.ts";
import { EgressStats } from "./stats.ts";

/**
 * Source adapters registered in the running service. None is approved in this build,
 * so the gateway can store credentials and serve staged feeds but cannot create feeds
 * for any connector. Tests pass their own registry explicitly.
 */
export const PRODUCTION_ADAPTERS: readonly GatewayAdapter[] = Object.freeze([]);

export type StartDeps = {
  log?: Logger;
  adapters?: readonly GatewayAdapter[];
  /** TEST ONLY, in-process: let the proxy reach local upstream servers. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, in-process DNS stand-in. */
  resolver?: Resolver;
  now?: () => number;
  /** TEST ONLY: replaces the RSS-Bridge backend of the bridge router. */
  bridgeBackends?: readonly BridgeBackend[];
};

export type RunningEgress = {
  ports: { proxy: number; gateway: number; control: number; bridge: number | null };
  stats: EgressStats;
  gateway: GatewayService;
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
  if (config.gatewayDbPath !== ":memory:") {
    mkdirSync(dirname(config.gatewayDbPath), { recursive: true, mode: 0o700 });
  }
  const gateway = new GatewayService({ path: config.gatewayDbPath, adapters: deps.adapters ?? PRODUCTION_ADAPTERS, now: deps.now });
  if (config.gatewayDbPath !== ":memory:") chmodSync(config.gatewayDbPath, 0o600);

  let bridgeLog: BridgeLog | null = null;
  let bridgeServer: http.Server | null = null;
  if (config.bridge) {
    if (config.bridge.dbPath !== ":memory:") mkdirSync(dirname(config.bridge.dbPath), { recursive: true, mode: 0o700 });
    bridgeLog = new BridgeLog({ path: config.bridge.dbPath, now: deps.now });
    if (config.bridge.dbPath !== ":memory:") chmodSync(config.bridge.dbPath, 0o600);
    const router = new BridgeRouter({ secret: config.bridge.secret, backends: deps.bridgeBackends ?? [rssBridgeBackend(config.bridge.backendUrl)], log: bridgeLog, now: deps.now });
    bridgeServer = createBridgeServer(router, { log: deps.log });
  }
  const proxy = createProxyServer({ config, stats, log: deps.log, testAllowAddress: deps.testAllowAddress, resolver: deps.resolver });
  // On the bridge container's network: the same proxy rules, and the only name resolution it has.
  const bridgeNet = config.bridge?.net ?? null;
  const bridgeProxy = bridgeNet ? createProxyServer({ config, stats, log: deps.log, testAllowAddress: deps.testAllowAddress, resolver: deps.resolver }) : null;
  const dns = bridgeNet ? createDnsServer({ log: deps.log }) : null;
  let dnsBound = false;
  const closeAll = () => {
    gateway.close();
    bridgeLog?.close();
    if (dnsBound) dns?.close();
  };
  const gatewayServer = createGatewayServer(gateway, { log: deps.log, now: deps.now });
  // The API reaches the listener at the address it is bound to (a private one in Compose), so a request addressed there is the
  // listener's own; any other name is refused.
  const controlHost = config.control.host.includes(":") ? `[${config.control.host.toLowerCase()}]` : config.control.host.toLowerCase();
  const control = createControlServer({
    token: config.serviceToken, stats, gateway, bridgeLog, log: deps.log,
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
      gateway,
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
