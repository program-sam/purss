import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EngineAdmin, EngineLifecycle, GReaderClient, loadEngineConfig, randomHex } from "@purss/freshrss";
import type { EngineConfig } from "@purss/freshrss";
import { FeedServer } from "./feed-server.ts";
import { TestProxy } from "./proxy.ts";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export type TestEngine = {
  life: EngineLifecycle;
  cfg: EngineConfig;
  admin: EngineAdmin;
  feeds: FeedServer;
  proxy: TestProxy;
  baseUrl: string;
  /** Creates an engine user and returns a logged-in client for it. */
  newUser(label?: string): Promise<{ username: string; apiPassword: string; client: GReaderClient }>;
  /** Runs a fixed read-only PHP snippet inside the container as the web user (for observations only). */
  php(code: string, ...args: string[]): Promise<string>;
  /**
   * Forces a re-fetch of one feed now. The engine keeps a feed document in its own cache (at least 800 s) and only refreshes
   * feeds that are due, so tests drop the cached documents and name the feed.
   */
  refresh(username: string, streamId: string): Promise<{ feeds: number; newArticles: number }>;
  /** Drops the engine's cached feed documents, as if their cache time had passed (the engine holds a fetch for at least 800 s). */
  dropFetchCache(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Starts an isolated engine (own container name, port, data dir and secrets under data/test-engine) with a local feed
 * server and a recording test proxy as its only way out. Stops and deletes everything on `stop()`.
 */
export async function startTestEngine(over: Partial<EngineConfig> = {}): Promise<TestEngine> {
  const id = randomHex(4);
  const root = path.join(REPO, "data", "test-engine", id);
  mkdirSync(root, { recursive: true });
  const feeds = new FeedServer();
  await feeds.start();
  const proxy = new TestProxy([`127.0.0.1:${feeds.port}`]);
  await proxy.start();
  const cfg = loadEngineConfig(REPO, { PURSS_DATA_DIR: root }, {
    containerName: `purss-freshrss-test-${id}`,
    hostPort: await freePort(),
    egressProxy: `http://host.containers.internal:${proxy.port}`,
    ...over,
  });
  const life = new EngineLifecycle(cfg, { log: () => {} });
  try {
    await life.up();
  } catch (e) {
    await cleanup();
    throw e;
  }
  const admin = life.admin();

  async function cleanup(): Promise<void> {
    await life.down().catch(() => {});
    await run("podman", ["unshare", "rm", "-rf", "--", root]).catch(() => rmSync(root, { recursive: true, force: true }));
    await proxy.stop();
    await feeds.stop();
  }

  const dropFetchCache = async () => {
    await run("podman", ["exec", "--user", "www-data", cfg.containerName, "sh", "-c", "rm -f /var/www/FreshRSS/data/cache/*.spc"]);
  };

  return {
    life,
    cfg,
    admin,
    feeds,
    proxy,
    baseUrl: life.baseUrl,
    async newUser(label = "u") {
      const username = `t${label}${randomHex(3)}`;
      const apiPassword = randomHex(16);
      await admin.ensureUser({ username, apiPassword });
      const client = new GReaderClient({ baseUrl: life.baseUrl, username, apiPassword, requestTimeoutMs: 60_000 });
      await client.login();
      return { username, apiPassword, client };
    },
    async php(code, ...args) {
      const { stdout } = await run("podman", ["exec", "--user", "www-data", cfg.containerName, "php", "-r", code, ...args]);
      return stdout;
    },
    dropFetchCache,
    async refresh(username, streamId) {
      await dropFetchCache();
      return admin.actualize({ username, feedId: Number(streamId.replace("feed/", "")) });
    },
    stop: cleanup,
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs: number; everyMs?: number; what: string }): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > opts.timeoutMs) throw new Error(`timed out waiting for ${opts.what}`);
    await sleep(opts.everyMs ?? 1000);
  }
}
