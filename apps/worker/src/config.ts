import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_KINDS } from "@purss/domain";
import { DEFAULT_BRIDGE_ENGINE_URL } from "./secrets.ts";
import type { JobKind } from "@purss/domain";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type WorkerConfig = {
  internalUrl: string;
  dataDir: string;
  secretsDir: string;
  /** Where the engine reaches the bridge router (plan/41). */
  bridgeEngineUrl: string;
  serviceTokenFile: string;
  engineUsersDir: string;
  concurrency: number;
  pollIntervalMs: number;
  maxBackoffMs: number;
  drainTimeoutMs: number;
  requestTimeoutMs: number;
  syncPageSize: number;
  syncOverlapSeconds: number;
  syncMaxBatchBytes: number;
  kinds: readonly JobKind[];
};

function int(v: string | undefined, d: number, min: number, max: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const dataDir = path.resolve(env.PURSS_DATA_DIR ?? path.join(REPO, "data"));
  const secretsDir = path.join(dataDir, "secrets");
  return {
    internalUrl: (env.PURSS_INTERNAL_URL ?? "http://127.0.0.1:8948").replace(/\/+$/, ""),
    dataDir,
    secretsDir,
    bridgeEngineUrl: env.PURSS_BRIDGE_ENGINE_URL ?? DEFAULT_BRIDGE_ENGINE_URL,
    serviceTokenFile: path.join(secretsDir, "service-token"),
    engineUsersDir: path.join(secretsDir, "engine-users"),
    concurrency: int(env.PURSS_WORKER_CONCURRENCY, 4, 1, 32),
    pollIntervalMs: int(env.PURSS_WORKER_POLL_MS, 2000, 50, 60_000),
    maxBackoffMs: int(env.PURSS_WORKER_MAX_BACKOFF_MS, 60_000, 1000, 600_000),
    drainTimeoutMs: int(env.PURSS_WORKER_DRAIN_MS, 25_000, 0, 600_000),
    requestTimeoutMs: int(env.PURSS_WORKER_REQUEST_TIMEOUT_MS, 30_000, 1000, 300_000),
    syncPageSize: int(env.PURSS_SYNC_PAGE_SIZE, 200, 1, 500),
    syncOverlapSeconds: int(env.PURSS_SYNC_OVERLAP_SECONDS, 3600, 0, 7 * 86_400),
    syncMaxBatchBytes: int(env.PURSS_SYNC_MAX_BATCH_BYTES, 700_000, 10_000, 5_000_000),
    kinds: JOB_KINDS,
  };
}

/** Reads the service token on demand so a rotated token is picked up after a 401. */
export function fileTokenProvider(file: string): { get(): string; invalidate(): void } {
  let cached: string | null = null;
  return {
    get() {
      if (cached) return cached;
      let text: string;
      try {
        text = readFileSync(file, "utf8").trim();
      } catch {
        throw new Error("The service token file is missing. Start the API first; it creates data/secrets/service-token.");
      }
      if (!text) throw new Error("The service token file is empty.");
      cached = text;
      return text;
    },
    invalidate() {
      cached = null;
    },
  };
}
