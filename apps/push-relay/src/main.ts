import path from "node:path";
import { ConfigError, loadConfig, loadHandleSecret } from "./config.ts";
import { createApns } from "./apns.ts";
import { createFcm } from "./fcm.ts";
import type { LogEvent } from "./provider.ts";
import { createRelay } from "./server.ts";
import { Store } from "./store.ts";

/*
 * Push relay entry point: `node apps/push-relay/src/main.ts`.
 * Configuration comes from environment variables (see apps/push-relay/README.md). Logs are
 * JSON lines on stdout: start and stop, provider trouble by status code, and an hourly count
 * of outcomes. Tokens, handles and scopes are never logged.
 */

const SWEEP_MS = 3_600_000;

function log(event: LogEvent): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

function main(): void {
  const clock = () => Date.now();
  let config;
  let providers;
  let secret;
  try {
    config = loadConfig();
    secret = loadHandleSecret(config.secretFile);
    providers = {
      ...(config.fcm ? { fcm: createFcm(config.fcm, clock, log) } : {}),
      ...(config.apns ? { apns: createApns(config.apns, clock, log) } : {}),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`push-relay: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const store = new Store(path.join(config.dataDir, "relay.db"));
  let counts: Record<string, number> = {};
  const server = createRelay({
    store, providers, clock, secret, config, log,
    count: (outcome) => { counts[outcome] = (counts[outcome] ?? 0) + 1; },
  });

  const sweep = setInterval(() => {
    const expired = store.expire(clock());
    log({ event: "relay.sweep", expired, devices: store.count(), ...counts });
    counts = {};
  }, SWEEP_MS);

  server.listen(config.port, config.host, () => {
    const address = server.address();
    log({ event: "relay.listening", port: typeof address === "object" && address ? address.port : config.port, fcm: Boolean(providers.fcm), apns: Boolean(providers.apns) });
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ event: "relay.stopping", signal });
    clearInterval(sweep);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    server.close(() => {
      providers.fcm?.close();
      providers.apns?.close();
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
