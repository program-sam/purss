/**
 * Background worker. Leases jobs from the API's internal listener, talks to the FreshRSS engine, and posts results
 * back. It never opens the product database.
 *
 *   node apps/worker/src/main.ts
 *
 * Environment: PURSS_INTERNAL_URL (http://127.0.0.1:8948), PURSS_DATA_DIR (<repo>/data), PURSS_ENGINE_ADMIN_URL or PURSS_ENGINE_EXEC
 * (podman exec --user www-data purss-freshrss), PURSS_WORKER_CONCURRENCY (4), see config.ts for the rest.
 */
import { captureReadable, fetchPictures, jevConfigFromEnv } from "@purss/connectors";
import { EngineAdmin } from "@purss/freshrss";
import { fileTokenProvider, loadWorkerConfig } from "./config.ts";
import { createHandlers, defaultMakeClient } from "./handlers.ts";
import { InternalApi } from "./internal-api.ts";
import { createLogger } from "./log.ts";
import { Worker } from "./runner.ts";
import { EngineUserSecrets } from "./secrets.ts";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = createLogger();
  const token = fileTokenProvider(config.serviceTokenFile);
  const api = new InternalApi({ baseUrl: config.internalUrl, token, timeoutMs: config.requestTimeoutMs });
  const handlers = createHandlers({
    api,
    secrets: new EngineUserSecrets(config.engineUsersDir),
    secretsDir: config.secretsDir,
    bridgeEngineUrl: config.bridgeEngineUrl,
    admin: EngineAdmin.fromEnv(process.env, process.env.PURSS_ENGINE_ADMIN_URL ? { adminToken: token.get() } : {}),
    log,
    makeClient: defaultMakeClient(config.requestTimeoutMs),
    capture: captureReadable,
    pictures: fetchPictures,
    // Loaded on the first icon job: the image library is slow to load and only this job needs it.
    icon: async (input, opts) => (await import("@purss/connectors/icons")).resolveSourceIcon(input, opts),
    jev: { config: jevConfigFromEnv() },
    syncPageSize: config.syncPageSize,
    syncOverlapSeconds: config.syncOverlapSeconds,
    syncMaxBatchBytes: config.syncMaxBatchBytes,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const kinds = config.kinds.filter((k) => k in handlers);

  const worker = new Worker({
    api,
    handlers,
    log,
    kinds,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    drainTimeoutMs: config.drainTimeoutMs,
  });

  let draining = false;
  const onSignal = (signal: string) => {
    if (draining) {
      log("error", "second signal received; exiting immediately", { signal });
      process.exit(1);
    }
    draining = true;
    log("info", "draining", { signal, inFlight: worker.inFlight });
    void worker.drain().then(
      () => {
        log("info", "drained");
        process.exit(0);
      },
      (e: unknown) => {
        log("error", "drain failed", { error: e instanceof Error ? e.message : "unknown" });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  await worker.run();
}

main().catch((e: unknown) => {
  console.error(`worker failed to start: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
});
