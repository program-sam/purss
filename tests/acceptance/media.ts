// Acceptance journey for the in-app player and playback positions, against the real API serving the built web
// app (no FreshRSS, egress or network). The server keeps no audio or video files: an episode plays from the
// publisher's own address (here a browser-side stand-in, since the page may only play https files), the mini-player
// keeps playing while moving around, pausing saves the position on the server, a reload offers to resume, speed is
// remembered, the sleep timer can be set and turned off, the player can be made smaller, an unreachable publisher file fails plainly, and nothing offers to save or download the file on
// the server or, in a browser, to this device. Media folders left by an earlier version are removed at start.
// Run: node tests/acceptance/media.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { setPreferences } from "../../apps/api/src/services/preferences.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";
import type { Principal } from "../../apps/api/src/app.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-media-e2e-"));
const dataDir = path.join(work, "data");
const webDist = path.join(work, "dist");
const PORT = 19960;
const INTERNAL = 19968;
const FORECAST = "https://cdn.example.invalid/forecast.wav";
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(INTERNAL),
  PURSS_PUBLIC_ORIGIN: origin, PURSS_WEB_DIST: webDist, PURSS_DISK_RESERVE_BYTES: "0",
};
const USERNAME = "listener";
const step = (s: string) => console.log(`✓ ${s}`);

/** A 30-second silent WAV: every browser can play it, and it is long enough to pause partway. */
function silentWav(seconds = 30, rate = 8000): Buffer {
  const data = Buffer.alloc(seconds * rate * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = silentWav();

let api: ChildProcess | null = null;
let stopping = false;
function startApi(): void {
  api = spawn(process.execPath, ["apps/api/src/main.ts"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  api.stdout!.on("data", (d) => { log += d; });
  api.stderr!.on("data", (d) => { log += d; });
  api.on("exit", (code) => { if (code && !stopping) console.error(`[api] exited ${code}\n${log.slice(-2000)}`); });
}
async function stopApi(): Promise<void> {
  if (!api || api.exitCode !== null) return;
  api.kill("SIGTERM");
  await new Promise((r) => api!.once("exit", r));
}
async function waitFor(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A podcast source with two episodes; the publisher's addresses are unreachable on purpose. */
function prepare(): { sourceId: string } {
  const app = createApp(loadConfig(env as Record<string, string>));
  try {
    const code = ensureClaimCode(app)!;
    const { accountId } = claim(app, code, "Listener", testPassword(USERNAME));
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id, { welcomeAsked: true });
    const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, workspaceId: ws.id, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    const sourceId = makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
    applySyncBatch(app, eu.id, batch([
      entry("feed/1", { title: "Night shipping forecast", enclosures: [{ url: FORECAST, type: "audio/wav", length: WAV.length }] }),
      entry("feed/1", { title: "Crackle on the long wave", enclosures: [{ url: "https://cdn.example.invalid/crackle.mp3", type: "audio/mpeg", length: 5_000_000 }] }),
    ]));
    return { sourceId };
  } finally {
    app.db.close();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/app/`);
  await page.waitForURL(/\/signin/);
  await page.getByRole("textbox", { name: "Username" }).fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Add source" }).first().waitFor();
}

async function openEpisode(page: Page, sourceId: string, title: string): Promise<void> {
  await page.goto(`${origin}/app/s/${sourceId}`);
  await page.locator("main .irow", { hasText: title }).first().click();
  await page.getByRole("heading", { name: title }).waitFor();
}

const itemDetail = async (page: Page, title: string) => {
  const list = await (await page.request.get(`${origin}/api/items?scope=all&filter=all&sort=newest`)).json() as { items: { id: string; title: string }[] };
  const id = list.items.find((i) => i.title === title)!.id;
  return (await page.request.get(`${origin}/api/items/${id}`)).json() as Promise<{ id: string; playback: { positionSeconds: number } | null; media: Record<string, unknown> }>;
};

let currentPage: Page | null = null;

/** The publisher's file, answered in the browser (with the Range support players ask for), since the page may only play https files. */
async function publisherServes(page: Page): Promise<void> {
  await page.route(FORECAST, async (route) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : WAV.length - 1, WAV.length - 1);
    await route.fulfill(range
      ? { status: 206, body: WAV.subarray(start, end + 1), headers: { "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${WAV.length}` } }
      : { status: 200, body: WAV, headers: { "content-type": "audio/wav", "accept-ranges": "bytes" } });
  });
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const { sourceId } = prepare();
  // What an earlier version kept on this server: saved files and a download in progress.
  mkdirSync(path.join(dataDir, "media", "incoming"), { recursive: true });
  mkdirSync(path.join(dataDir, "media", "acc_0123456789abcdefghjkmnpqrs"), { recursive: true });
  writeFileSync(path.join(dataDir, "media", "incoming", "med_0123456789abcdefghjkmnpqrs.part"), "partial");
  writeFileSync(path.join(dataDir, "media", "acc_0123456789abcdefghjkmnpqrs", "med_0123456789abcdefghjkmnpqrt"), WAV);
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  assert.equal(existsSync(path.join(dataDir, "media")), false, "the media folder an earlier version filled is removed when the API starts");
  const csp = (await fetch(`${origin}/app/`)).headers.get("content-security-policy") ?? "";
  assert.match(csp, /media-src https:;/, "the page may play publishers' https files, nothing else: PURSS serves none");
  step("API started with a podcast source and two episodes; leftover media files were removed");

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    currentPage = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await publisherServes(page);
    await signIn(page);

    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByText(/Streams from the publisher's site/).waitFor();
    assert.equal(await page.getByText(/Save on the server|Saved on the server|Remove saved copy|saved copy/i).count(), 0, "nothing offers to keep the file on the server");
    assert.equal(await page.getByRole("button", { name: /^Download/ }).count(), 0, "a browser has no device downloads, so no download button");
    const media = (await itemDetail(page, "Night shipping forecast")).media;
    assert.deepEqual(media, { url: FORECAST, kind: "audio", type: "audio/wav", length: WAV.length }, "the item reports the publisher's file and nothing about a server copy");
    step("the reader offers to play the publisher's file and nothing to save or download it");

    await page.getByRole("button", { name: "Listen", exact: true }).click();
    const bar = page.getByRole("region", { name: "Player" });
    await bar.getByText("Streaming from the publisher").waitFor();
    await waitFor("playback to move", async () => Number(await bar.getByRole("slider", { name: "Position" }).inputValue()) >= 2, 15_000);
    step("the publisher's file plays in the mini-player");

    // Nothing sits under the player, in any layout: what the layout shows ends above its top edge.
    const clearOfPlayer = async (what: string, selector: string) => {
      const p = await bar.boundingBox();
      const b = await page.locator(selector).first().boundingBox();
      assert.ok(p && b, `${what} and the player are on screen`);
      assert.ok(b.y + b.height <= p.y + 0.5, `${what} ends above the player (${b.y + b.height} > ${p.y})`);
    };
    await clearOfPlayer("the sidebar rail", "#side");
    await clearOfPlayer("the reader", "aside.panel");
    await clearOfPlayer("the list", "#main");
    step("on a laptop the rail, the reader and the list end above the player");

    // With the reader open, a laptop's sidebar steps back to its rail, where Home is an icon button.
    await page.locator("#side").getByRole("button", { name: "Home", exact: true }).first().click();
    await page.waitForURL(`${origin}/app/`);
    assert.ok(await bar.isVisible(), "the player stays while moving around");
    await clearOfPlayer("the full sidebar", "#side");
    await clearOfPlayer("the list", "#main");
    // Past the first few seconds, so that resuming starts from the saved position rather than the beginning.
    // The slider shows whole seconds, so wait for one more than needed.
    await waitFor("playback to keep going", async () => Number(await bar.getByRole("slider", { name: "Position" }).inputValue()) >= 9, 20_000);
    await bar.getByRole("button", { name: "Pause" }).click();
    await waitFor("the position to be saved on the server", async () => ((await itemDetail(page, "Night shipping forecast")).playback?.positionSeconds ?? 0) >= 7.5, 10_000);
    step("kept playing across pages; pausing saved the position on the server");

    await bar.getByRole("button", { name: /^Speed/ }).click();
    await page.getByRole("menuitemradio", { name: "1.5×" }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("purss-player-rate")), "1.5");
    step("speed changed and remembered on this device");

    await bar.getByRole("button", { name: "Sleep timer" }).click();
    await page.getByRole("menuitemradio", { name: "In 15 minutes" }).click();
    await bar.getByRole("button", { name: "Sleep timer: pauses in 15 min" }).click();
    await page.getByRole("menuitemradio", { name: "Off" }).click();
    await bar.getByRole("button", { name: "Sleep timer" }).waitFor();
    step("the sleep timer shows its time left and turns off");

    const fullHeight = (await bar.boundingBox())!.height;
    await bar.getByRole("button", { name: "Make the player smaller" }).click();
    await bar.getByRole("button", { name: "Show the full player" }).waitFor();
    assert.equal(await bar.getByRole("slider", { name: "Position" }).isVisible(), false, "the smaller player has no position slider");
    assert.ok(await bar.getByRole("button", { name: /^(Play|Pause)$/ }).isVisible(), "the smaller player keeps play and pause");
    assert.ok((await bar.boundingBox())!.height < fullHeight - 20, "the smaller player takes less room");
    await clearOfPlayer("the list", "#main");
    assert.equal(await page.evaluate(() => localStorage.getItem("purss-player-mini")), "1", "remembered on this device");
    await bar.getByRole("button", { name: "Show the full player" }).click();
    await bar.getByRole("slider", { name: "Position" }).waitFor();
    step("the player can be made smaller and shown in full again, and remembers which");

    await page.reload();
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByRole("button", { name: /^Listen from \d:\d\d$/ }).waitFor();
    step("after a reload the episode offers to resume where it stopped");

    await openEpisode(page, sourceId, "Crackle on the long wave");
    await page.getByText(/Streams from the publisher's site/).waitFor();
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    await bar.getByText("Streaming from the publisher").waitFor();
    await bar.getByText(/publisher's file couldn't be played here/).waitFor({ timeout: 20_000 });
    await bar.getByRole("button", { name: "Close the player" }).click();
    await bar.waitFor({ state: "detached" });
    step("an unreachable publisher file says so plainly");

    // Rows and the source page offer no download or saving in a browser.
    await page.goto(`${origin}/app/s/${sourceId}`);
    const row = page.locator("main .irow", { hasText: "Night shipping forecast" }).first();
    await row.waitFor();
    assert.equal(await row.getByRole("button", { name: /Download/ }).count(), 0, "no download button on a row");
    assert.equal(await page.getByRole("button", { name: /Save new episodes/ }).count(), 0, "a source can't save its episodes on the server");
    await row.getByRole("button", { name: /^To read:/ }).waitFor();
    step("rows and the source page offer no saving or downloading in a browser");

    // A phone-sized screen: the bar fits, and the reader, the list, the menu drawer (down to Settings) and
    // the e-ink page buttons all end above it, with the tab bar below it.
    await page.setViewportSize({ width: 390, height: 844 });
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByRole("button", { name: /^Listen/ }).click();
    const box = await bar.boundingBox();
    assert.ok(box && box.width <= 390 && box.y + box.height <= 844, "the player fits a phone screen");
    await clearOfPlayer("the reader", "aside.panel");
    await page.keyboard.press("Escape");
    await page.locator("aside.panel").waitFor({ state: "hidden" });
    await clearOfPlayer("the list", "#main");
    const tabs = await page.getByRole("navigation", { name: "Main" }).boundingBox();
    const played = await bar.boundingBox();
    assert.ok(tabs && played && played.y + played.height <= tabs.y + 0.5, "the player sits above the tab bar");
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Collections" }).click();
    await page.locator('.app[data-drawer="open"]').waitFor();
    await clearOfPlayer("the menu drawer", "#side");
    await clearOfPlayer("Settings in the menu", "#side .side-foot .set");
    await page.locator("#side .side-foot .set").click(); // fails if anything covers it
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
    await page.evaluate(() => localStorage.setItem("purss:display", "eink"));
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByRole("button", { name: /^Listen/ }).click();
    await page.keyboard.press("Escape");
    await page.locator("aside.panel").waitFor({ state: "hidden" });
    await clearOfPlayer("the e-ink page buttons", ".stage > .pagenav");
    await page.evaluate(() => localStorage.removeItem("purss:display"));
    await bar.getByRole("button", { name: "Close the player" }).click();
    step("on a phone the reader, the list, the menu down to Settings and the e-ink page buttons end above the player");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    const shot = path.join(os.tmpdir(), "purss-media-failure.png");
    await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("\nPlayer journey passed.");
} catch (err) {
  console.error("\nPlayer journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
