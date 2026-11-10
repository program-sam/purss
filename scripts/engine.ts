#!/usr/bin/env node
/**
 * Lifecycle of the development FreshRSS engine (podman). See infra/engine/README.md.
 *
 *   node scripts/engine.ts up                    start (or resume) the engine; idempotent
 *   node scripts/engine.ts down                  stop and remove the container; data is kept
 *   node scripts/engine.ts status [--json]       health, egress enforcement, retention policy
 *   node scripts/engine.ts reset-confirm [--confirm <container-name>]
 *                                                destroy the engine's data (explicit, never implied)
 *
 * Environment: PURSS_DATA_DIR, PURSS_ENGINE_PORT (8941), PURSS_ENGINE_CONTAINER (purss-freshrss),
 * PURSS_EGRESS_PROXY (http://host.containers.internal:8946), PURSS_ENGINE_CRON_MIN.
 */
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { EngineError, EngineLifecycle, loadEngineConfig } from "@purss/freshrss";
import type { EngineStatus } from "@purss/freshrss";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function printStatus(s: EngineStatus): void {
  const mark = (ok: boolean) => (ok ? "ok" : "PROBLEM");
  console.log(`engine      ${s.container.name}: ${s.container.status}${!s.container.exists || s.container.specCurrent ? "" : " (settings differ from current configuration)"}`);
  console.log(`url         ${s.url}   (loopback only)`);
  console.log(`installed   ${mark(s.installed)}`);
  console.log(`api         reachable=${s.api.reachable} operator-login=${s.api.adminLogin}`);
  console.log(`identity    ${s.identity ?? "unknown"}`);
  console.log(`users       ${s.users ? s.users.join(", ") || "(none)" : "unknown"}`);
  console.log(`egress      all feed fetches via ${s.egress.proxy}: ${s.egress.enforced}`);
  const a = s.policy.archiving;
  console.log(`refresh     cron minutes ${s.policy.cronMin}; feed ttl ${s.policy.ttlDefaultSeconds}s`);
  console.log(`retention   keep newest ${a.keep_min}/feed; purge when unseen > ${a.keep_period} or beyond ${a.keep_max}/feed (favourites, labels, unread not exempt)`);
  console.log(s.healthy ? "healthy" : `UNHEALTHY: ${s.problems.join("; ")}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const lifecycle = new EngineLifecycle(loadEngineConfig(repoRoot), { log: (l) => console.log(l) });
  switch (command) {
    case "up": {
      const s = await lifecycle.up();
      printStatus(s);
      return 0;
    }
    case "down": {
      const r = await lifecycle.down();
      console.log(r.removed ? `removed container ${lifecycle.cfg.containerName}; data kept in ${lifecycle.cfg.engineDir}` : "no engine container to remove");
      return 0;
    }
    case "status": {
      const s = await lifecycle.status();
      if (rest.includes("--json")) console.log(JSON.stringify(s, null, 2));
      else printStatus(s);
      return s.healthy ? 0 : 1;
    }
    case "reset-confirm": {
      const d = lifecycle.describeReset();
      console.log("This permanently deletes the engine's data:");
      console.log(`  container  ${d.container}`);
      console.log(`  data       ${d.engineDir}${d.engineDirExists ? "" : " (does not exist)"}`);
      for (const f of d.secretFiles) console.log(`  secret     ${f}`);
      console.log("Product items already imported are not affected; the engine gets a new identity.");
      let confirm: string | undefined;
      const i = rest.indexOf("--confirm");
      if (i >= 0) confirm = rest[i + 1];
      else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        confirm = await rl.question(`Type the container name (${d.container}) to confirm: `);
        rl.close();
      }
      const r = await lifecycle.reset((confirm ?? "").trim());
      console.log(`deleted engine data: ${r.deletedEngineDir}; deleted ${r.deletedSecrets} secret file(s)`);
      return 0;
    }
    default:
      console.error("usage: node scripts/engine.ts up|down|status [--json]|reset-confirm [--confirm <container-name>]");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof EngineError ? `error: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
