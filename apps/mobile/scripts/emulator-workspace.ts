// A throwaway PURSS for trying the apps on an emulator or a phone over USB, like the hermetic acceptance
// journeys: the real API serving the built web app (no FreshRSS, egress or network), its own data directory,
// and a small seeded library: a podcast with two episodes (their files are the publisher's: the PURSS keeps
// none, and the sample addresses play nothing) and articles with readable text, some To read. Everything is
// deleted when it stops.
//
//   npm run build && node apps/mobile/scripts/emulator-workspace.ts [port]
//   adb reverse tcp:<port> tcp:<port>     # the emulator's localhost is then this computer's
//
// Connect the app to http://localhost:<port> and sign in with a recovery code it prints. Ctrl+C stops it.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Principal } from "../../api/src/app.ts";
import { claim, ensureClaimCode } from "../../api/src/auth/accounts.ts";
import { loadConfig } from "../../api/src/config.ts";
import { createApp } from "../../api/src/main.ts";
import { changeState } from "../../api/src/services/state.ts";
import { applySyncBatch } from "../../api/src/services/sync.ts";
import { batch, entry, makeSource } from "../../api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.argv[2] ?? 19990);
const INTERNAL = PORT + 8;
const work = mkdtempSync(path.join(os.tmpdir(), "purss-emulator-"));
const dataDir = path.join(work, "data");
const webDist = path.join(work, "dist");
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(INTERNAL),
  PURSS_PUBLIC_ORIGIN: origin, PURSS_WEB_DIST: webDist, PURSS_DISK_RESERVE_BYTES: "0",
};

const ARTICLE = (title: string) => `<p>${title}. The tide comes in twice a day over the flats, and the channels fill first.</p>`
  + Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}: sediment settles where the water slows, so the banks grow on the inside of each bend and the mud shifts with every storm. Walkers follow the posts across, and the posts move too.</p>`).join("");

function prepare(): { recoveryCodes: string[] } {
  const app = createApp(loadConfig(env as Record<string, string>));
  try {
    const code = ensureClaimCode(app)!;
    const { accountId, recoveryCodes } = claim(app, code, "Phone tester");
    const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, workspaceId: ws.id, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
    makeSource(app, p, "Tidal Notes", "feed/2");
    applySyncBatch(app, eu.id, batch([
      entry("feed/1", { title: "Night shipping forecast", enclosures: [{ url: "https://cdn.example.invalid/forecast.wav", type: "audio/wav", length: 5_000_000 }] }),
      entry("feed/1", { title: "Crackle on the long wave", enclosures: [{ url: "https://cdn.example.invalid/crackle.mp3", type: "audio/mpeg", length: 5_000_000 }] }),
      entry("feed/2", { title: "Reading the tide tables", contentHtml: ARTICLE("Reading the tide tables") }),
      entry("feed/2", { title: "Where the channels run", contentHtml: ARTICLE("Where the channels run") }),
      entry("feed/2", { title: "Mud, posts and storms", contentHtml: ARTICLE("Mud, posts and storms") }),
    ]));
    const items = app.db.all<{ id: string; title: string; revision: number }>("SELECT id, title, revision FROM items i JOIN item_state s ON s.item_id = i.id");
    for (const it of items) if (it.title !== "Crackle on the long wave" && it.title !== "Mud, posts and storms") changeState(app, p, it.id, { workflow: "toread", expectedRevision: it.revision });
    return { recoveryCodes };
  } finally {
    app.db.close();
  }
}

let api: ChildProcess | null = null;
async function stop(): Promise<void> {
  if (api && api.exitCode === null) {
    api.kill("SIGTERM");
    await new Promise((r) => api!.once("exit", r));
  }
  rmSync(work, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const { recoveryCodes } = prepare();
  api = spawn(process.execPath, ["apps/api/src/main.ts"], { cwd: repo, env, stdio: ["ignore", "inherit", "inherit"] });
  const until = Date.now() + 30_000;
  for (;;) {
    if (await fetch(`${origin}/api/session`).then((r) => r.ok, () => false)) break;
    if (Date.now() > until) throw new Error("The API didn't start");
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`\nWorkspace ready at ${origin}\nRecovery codes (each works once; connecting asks for a second one when the sign-in is over ten minutes old):\n${recoveryCodes.slice(0, 4).join("\n")}\nOn the emulator: adb reverse tcp:${PORT} tcp:${PORT}, then connect the app to ${origin}\n`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void stop().then(() => process.exit(0)));
}

main().catch(async (err) => { console.error(err); await stop(); process.exit(1); });
