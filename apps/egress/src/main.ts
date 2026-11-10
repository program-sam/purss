import { ConfigError, loadConfig } from "./config.ts";
import { startEgress } from "./server.ts";
import type { LogEvent } from "./proxy.ts";

/*
 * Egress service entry point: `node apps/egress/src/main.ts`.
 * Configuration comes from environment variables (see apps/egress/README.md) and the
 * service token in <PURSS_DATA_DIR>/secrets/service-token. Logs are JSON lines on stdout
 * without query strings, credentials or content.
 */

function log(event: LogEvent): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`egress: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const running = await startEgress(config, { log });
  log({
    event: "egress.listening",
    proxy: `${config.proxy.host}:${running.ports.proxy}`,
    gateway: `${config.gateway.host}:${running.ports.gateway}`,
    control: `${config.control.host}:${running.ports.control}`,
    bridge: config.bridge ? `${config.bridge.host}:${running.ports.bridge}` : null,
    internalDestinations: config.internalDestinations.map((d) => `${d.host}:${d.port}`).join(","),
  });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ event: "egress.stopping", signal });
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    void running.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`egress: failed to start (${error instanceof Error ? error.name : "error"})\n`);
  process.exit(1);
});
