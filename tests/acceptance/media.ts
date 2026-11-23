// Acceptance journey for the in-app player and playback positions, against the real API serving the built web
// app (no FreshRSS, egress or network). The server keeps no audio or video files: an episode plays from the
// publisher's own address (here a browser-side stand-in, since the page may only play https files), the mini-player
// keeps playing while moving around, pausing saves the position on the server, a reload offers to resume, speed is
// remembered, the sleep timer can be set and turned off, the player can be made smaller, an unreachable publisher file fails plainly, and nothing offers to save or download the file on
// the server or, in a browser, to this device, and playing moves an episode to In progress and Finished by itself, quietly,
// and only for real playing: jumping to the end is not finishing. Media folders left by an earlier version are removed at start.
// An episode with no picture of its own plays with the show's art in the player (not initials).
// Listen leads the episode's panel; "Open original" is the episode's page and never the audio file itself: an episode whose
// link is only its file offers the show's website or nothing, in the panel and in the row's menu, and its byline has no e-mail address.
// A private source's episode whose link is its file (an address with no file name, carrying a token) is judged the same way.
// Run: node tests/acceptance/media.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { app } from "@purss/translations/app";
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
const SERIAL = "https://cdn.example.invalid/serial.wav";
const TIDES = "https://cdn.example.invalid/tides.mp3";
const STATIC = "https://cdn.example.invalid/static.mp3";
const SHOW_SITE = "https://slow-radio.example.invalid/";
// A private source's episode, whose link is its file: the address names no file and carries a token.
const MEMBERS_FILE = "https://members.example.invalid/play?id=7&token=SECRET";
const MEMBERS_SITE = "https://members.example.invalid/";
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(INTERNAL),
  PURSS_PUBLIC_ORIGIN: origin, PURSS_WEB_DIST: webDist, PURSS_DISK_RESERVE_BYTES: "0",
};
const EMAIL = "listener@example.test";
const step = (s: string) => console.log(`✓ ${s}`);
// The words people read come from the catalogs, so rewording one cannot break this journey. What stays written out here is
// what the app keeps in code: the labels only screen readers announce (the player's buttons and slider, a row's "Actions for").
const signInCopy = app.auth.signIn;
const mediaCopy = app.player.media;
const panelCopy = app.shell.itemPanel;
const menuCopy = app.state.itemMenus;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name that starts with the catalog's words. */
const startsWith = (s: string) => new RegExp(`^${escapeRe(s)}`);
/** What a button that offers or shows a download to this device is called, on a row or in the panel. */
const downloadButton = new RegExp([app.downloads.downloadSection.download, app.downloads.downloadSection.downloading, ...Object.values(app.components.itemRow.downloadTips)].map(escapeRe).join("|"));

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
/** Two and a half minutes: long enough that 30 seconds of playing is not near its end, which starts at 1:15 (half way, the earlier of 95% and the last two minutes being earlier still). */
const SERIAL_WAV = silentWav(150);

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

/** A podcast source with three episodes; the publisher's addresses are unreachable on purpose. */
function prepare(): { sourceId: string; quietId: string; membersId: string } {
  const app = createApp(loadConfig(env as Record<string, string>));
  try {
    const code = ensureClaimCode(app)!;
    const { accountId } = claim(app, code, EMAIL, "Listener", testPassword());
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, accountId, { welcomeAsked: true });
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    const sourceId = makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
    app.db.run("UPDATE sources SET site_url = ? WHERE id = ?", SHOW_SITE, sourceId);
    // A second show with no website of its own.
    const quietId = makeSource(app, p, "Quiet Hours", "feed/2", { kind: "podcast" });
    // A private show: its files' addresses are withheld, so the server alone can say that an episode's link is its file.
    const membersId = makeSource(app, p, "Members Hour", "feed/3", { kind: "podcast", isPrivate: true });
    app.db.run("UPDATE sources SET site_url = ? WHERE id = ?", MEMBERS_SITE, membersId);
    // The show has cover art (a one-pixel WebP stands in for it); its episodes have none of their own.
    const art = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
    app.db.run("INSERT INTO source_icons (source_id, account_id, bytes, digest, found_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      sourceId, accountId, art, createHash("sha256").update(art).digest("hex"), "https://cdn.example.invalid/art.webp", new Date().toISOString());
    applySyncBatch(app, eu.id, batch([
      entry("feed/1", { title: "Night shipping forecast", enclosures: [{ url: FORECAST, type: "audio/wav", length: WAV.length }] }),
      entry("feed/1", { title: "Crackle on the long wave", enclosures: [{ url: "https://cdn.example.invalid/crackle.mp3", type: "audio/mpeg", length: 5_000_000 }] }),
      entry("feed/1", { title: "Long wave serial", enclosures: [{ url: SERIAL, type: "audio/wav", length: SERIAL_WAV.length }] }),
      // Feeds with no page for an episode: the link the engine hands over is the audio file itself.
      entry("feed/1", { title: "Tide tables, read aloud", url: TIDES, author: "radio@slow-radio.example.invalid (Slow Radio); Mara Venn", enclosures: [{ url: TIDES, type: "audio/mpeg", length: 5_000_000 }] }),
      entry("feed/2", { title: "Static on the shortwave", url: STATIC, author: "static@quiet.example.invalid", enclosures: [{ url: STATIC, type: "audio/mpeg", length: 5_000_000 }] }),
      entry("feed/3", { title: "Members only episode", url: MEMBERS_FILE, enclosures: [{ url: MEMBERS_FILE, type: "audio/mpeg", length: 5_000_000 }] }),
    ]));
    return { sourceId, quietId, membersId };
  } finally {
    app.db.close();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/app/`);
  await page.waitForURL(/\/signin/);
  await page.getByRole("textbox", { name: app.words.emailAddress }).fill(EMAIL);
  await page.getByLabel(app.words.password, { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: app.words.signIn, exact: true }).click();
  await page.getByRole("button", { name: app.words.addSource }).first().waitFor();
}

async function openEpisode(page: Page, sourceId: string, title: string): Promise<void> {
  await page.goto(`${origin}/app/s/${sourceId}`);
  await page.locator("main .irow", { hasText: title }).first().click();
  await page.getByRole("heading", { name: title }).waitFor();
}

const itemDetail = async (page: Page, title: string) => {
  const list = await (await page.request.get(`${origin}/api/items?scope=all&filter=all&sort=newest`)).json() as { items: { id: string; title: string }[] };
  const id = list.items.find((i) => i.title === title)!.id;
  return (await page.request.get(`${origin}/api/items/${id}`)).json() as Promise<{ id: string; workflow: string; playback: { positionSeconds: number } | null; media: Record<string, unknown> }>;
};

let currentPage: Page | null = null;

/** The publisher's files, answered in the browser (with the Range support players ask for), since the page may only play https files. */
async function publisherServes(page: Page): Promise<void> {
  for (const [url, wav] of [[FORECAST, WAV], [SERIAL, SERIAL_WAV]] as const) {
    await page.route(url, async (route) => {
      const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range ?? "");
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = Math.min(range?.[2] ? Number(range[2]) : wav.length - 1, wav.length - 1);
      await route.fulfill(range
        ? { status: 206, body: wav.subarray(start, end + 1), headers: { "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${wav.length}` } }
        : { status: 200, body: wav, headers: { "content-type": "audio/wav", "accept-ranges": "bytes" } });
    });
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const { sourceId, quietId, membersId } = prepare();
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
  step("API started with three podcast sources (one private) and six episodes; leftover media files were removed");

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
    await page.getByText(mediaCopy.streams).waitFor();
    assert.equal(await page.getByText(/Save on the server|Saved on the server|Remove saved copy|saved copy/i).count(), 0, "nothing offers to keep the file on the server");
    assert.equal(await page.getByRole("button", { name: downloadButton }).count(), 0, "a browser has no device downloads, so no download button");
    const media = (await itemDetail(page, "Night shipping forecast")).media;
    assert.deepEqual(media, { url: FORECAST, kind: "audio", type: "audio/wav", length: WAV.length }, "the item reports the publisher's file and nothing about a server copy");
    step("the reader offers to play the publisher's file and nothing to save or download it");

    // Listen leads the panel, ahead of the State and Keep row, and is the only primary button; an episode with a page of its own keeps "Open original" for it.
    const panelBox = async (selector: string) => (await page.locator(`aside.panel ${selector}`).first().boundingBox())!;
    assert.ok((await panelBox(".media-box")).y < (await panelBox(".p-acts")).y, "Listen comes before the State and Keep row");
    assert.equal(await page.locator("aside.panel .p-acts .mbtn.go").count(), 0, "no other button is made the primary one beside Listen");
    assert.match((await page.getByRole("link", { name: startsWith(app.words.openOriginal) }).getAttribute("href"))!, /^https:\/\/example\.org\/post\/\d+$/, "an episode with a page opens that page as its original");
    assert.equal(await page.getByRole("link", { name: startsWith(app.words.openTheShowSWebsite) }).count(), 0, "the show's website is only for an episode with no page");
    step("Listen leads the panel and an episode with a page keeps Open original for it");

    // An episode whose link is its audio file: no original, one link to the file, the show's website instead, a clean byline.
    await openEpisode(page, sourceId, "Tide tables, read aloud");
    const panel = page.locator("aside.panel");
    assert.equal(await panel.getByRole("link", { name: startsWith(app.words.openOriginal) }).count(), 0, "the audio file is not offered as the original");
    assert.equal(await panel.locator(`a[href="${TIDES}"]`).count(), 1, "the audio file has one link, Open the audio");
    await panel.getByRole("link", { name: startsWith(panelCopy.openAudio) }).waitFor();
    const site = panel.getByRole("link", { name: startsWith(app.words.openTheShowSWebsite) });
    assert.equal(await site.getAttribute("href"), SHOW_SITE, "the show's website opens instead");
    assert.equal(await panel.locator(".p-acts .mbtn.go").count(), 0, "the website is not the primary button");
    assert.ok((await panelBox(".media-box")).y < (await panelBox(".p-acts")).y, "Listen comes before the State and Keep row");
    await panel.getByRole("button", { name: mediaCopy.listen, exact: true }).waitFor();
    assert.equal((await panel.locator(".p-by").textContent())?.trim(), "Slow Radio, Mara Venn", "the byline has the names without the e-mail address");
    step("an episode whose link is its audio file offers Listen, Open the audio, the show's website and a name-only byline");

    // The row's menu follows the same rule.
    await page.goto(`${origin}/app/s/${sourceId}`);
    const tidesRow = page.locator("main .irow", { hasText: "Tide tables, read aloud" }).first();
    await tidesRow.waitFor();
    await tidesRow.getByRole("button", { name: /^Actions for/ }).click();
    const menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: app.words.openTheShowSWebsite }).waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: app.words.openOriginal }).count(), 0, "the row's menu does not offer the audio file as the original");
    assert.equal(await menu.getByRole("menuitem", { name: app.lib.copyLink.original }).count(), 0, "there is no original page to copy");
    await page.keyboard.press("Escape");
    step("the row's menu offers the show's website, and no original page to open or copy");

    // A show with no website, and an author that is only an address: no original at all and no byline.
    await openEpisode(page, quietId, "Static on the shortwave");
    assert.equal(await panel.getByRole("link", { name: new RegExp(`${startsWith(app.words.openOriginal).source}|${startsWith(app.words.openTheShowSWebsite).source}`) }).count(), 0, "no page and no website: no original button");
    assert.equal(await panel.locator(`a[href="${STATIC}"]`).count(), 1, "the file is still one click away, as Open the audio");
    assert.equal(await panel.locator(".p-by").count(), 0, "an address with no name leaves no byline");
    await panel.getByRole("button", { name: mediaCopy.listen, exact: true }).waitFor();
    step("an episode with neither a page nor a website has no original button, and a bare address is no byline");

    // A private source's episode whose link is its file, an address that names no file: the server says so, though it withholds the file's address, so
    // neither the panel nor the menus offer the file (and its token) as the original, and the show's website is offered instead.
    await openEpisode(page, membersId, "Members only episode");
    assert.equal((await itemDetail(page, "Members only episode")).media, null, "a private source's file address is withheld");
    assert.equal(await panel.getByRole("link", { name: startsWith(app.words.openOriginal) }).count(), 0, "the private file is not offered as the original");
    assert.equal(await panel.locator('a[href*="token="]').count(), 0, "no link in the panel carries the file's token");
    assert.equal(await panel.getByRole("link", { name: startsWith(app.words.openTheShowSWebsite) }).getAttribute("href"), MEMBERS_SITE, "the show's website opens instead");
    await page.goto(`${origin}/app/s/${membersId}`);
    const membersRow = page.locator("main .irow", { hasText: "Members only episode" }).first();
    await membersRow.waitFor();
    await membersRow.getByRole("button", { name: /^Actions for/ }).click();
    const membersMenu = page.getByRole("menu");
    await membersMenu.getByRole("menuitem", { name: app.words.openTheShowSWebsite }).waitFor();
    assert.equal(await membersMenu.getByRole("menuitem", { name: app.words.openOriginal }).count(), 0, "the row's menu does not offer the private file as the original");
    assert.equal(await membersMenu.getByRole("menuitem", { name: app.lib.copyLink.original }).count(), 0, "the private file's address is not copied");
    await page.keyboard.press("Escape");
    step("a private source's file link, which names no file, is not offered as the original either");
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByText(mediaCopy.streams).waitFor();

    await page.getByRole("button", { name: mediaCopy.listen, exact: true }).click();
    const bar = page.getByRole("region", { name: "Player" });
    await bar.getByText(app.player.source.publisher).waitFor();
    await waitFor("playback to move", async () => Number(await bar.getByRole("slider", { name: "Position" }).inputValue()) >= 2, 15_000);
    step("the publisher's file plays in the mini-player");

    // An episode without a picture of its own plays with the show's art, not with initials.
    const artwork = bar.locator(".player-title img");
    await artwork.waitFor();
    assert.match((await artwork.getAttribute("src"))!, /^\/api\/sources\/[\w-]+\/icon\?v=[0-9a-f]+$/, "the player shows the show's art as this app serves it");
    await waitFor("the show's art to load", async () => (await artwork.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)), 5000);
    step("an episode with no picture of its own plays with the show's art");

    // Text hidden for screen readers and live regions make no part of the page lie below the screen: the page itself never scrolls.
    assert.deepEqual(await page.evaluate(() => ({ scrolls: document.documentElement.scrollHeight - innerHeight, y: scrollY })), { scrolls: 0, y: 0 }, "the page is no taller than the screen and has not scrolled");

    // Nothing sits under the player, in any layout: what the layout shows ends above its top edge,
    // and a sidebar beside the content runs to the bottom of the screen with the player clear of it.
    const besidePlayer = async (what: string) => {
      const p = await bar.boundingBox();
      const b = await page.locator("#side").boundingBox();
      const h = page.viewportSize()!.height;
      assert.ok(p && b, `${what} and the player are on screen`);
      assert.ok(Math.abs(b.y + b.height - h) <= 0.5, `${what} runs to the bottom of the screen (${b.y + b.height} of ${h})`);
      assert.ok(b.x + b.width <= p.x + 0.5, `the player is clear of ${what} (${b.x + b.width} > ${p.x})`);
    };
    const clearOfPlayer = async (what: string, selector: string) => {
      const p = await bar.boundingBox();
      const b = await page.locator(selector).first().boundingBox();
      assert.ok(p && b, `${what} and the player are on screen`);
      assert.ok(b.y + b.height <= p.y + 0.5, `${what} ends above the player (${b.y + b.height} > ${p.y})`);
    };
    await besidePlayer("the sidebar rail");
    await clearOfPlayer("the reader", "aside.panel");
    await clearOfPlayer("the list", "#main");
    step("on a laptop the reader and the list end above the player, and the rail runs beside it");

    // With the reader open, a laptop's sidebar steps back to its rail, where Home is an icon button.
    await page.locator("#side").getByRole("button", { name: app.words.home, exact: true }).first().click();
    await page.waitForURL(`${origin}/app/`);
    assert.ok(await bar.isVisible(), "the player stays while moving around");
    await besidePlayer("the full sidebar");
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
    await page.getByRole("menuitemradio", { name: app.player.bar.inMinutes(15) }).click();
    await bar.getByRole("button", { name: "Sleep timer: pauses in 15 min" }).click();
    await page.getByRole("menuitemradio", { name: app.words.off }).click();
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
    await page.getByRole("button", { name: new RegExp(`^${escapeRe(mediaCopy.from(mediaCopy.listen, "\uE000")).replace("\uE000", "\\d:\\d\\d")}$`) }).waitFor();
    step("after a reload the episode offers to resume where it stopped");

    await openEpisode(page, sourceId, "Crackle on the long wave");
    await page.getByText(mediaCopy.streams).waitFor();
    await page.getByRole("button", { name: mediaCopy.listen, exact: true }).click();
    await bar.getByText(app.player.source.publisher).waitFor();
    await bar.getByText(app.player.errors.publisherFailed).waitFor({ timeout: 20_000 });
    await bar.getByRole("button", { name: "Close the player" }).click();
    await bar.waitFor({ state: "detached" });
    step("an unreachable publisher file says so plainly");

    // Playing moves an episode through the states by itself: In progress after 30 seconds of real playing, Finished once it has
    // played into its end, never for a jump to the end, and with no message.
    const toasts = page.locator("#toasts");
    await openEpisode(page, sourceId, "Long wave serial");
    assert.equal((await itemDetail(page, "Long wave serial")).workflow, "undecided");
    await page.getByRole("button", { name: mediaCopy.listen, exact: true }).click();
    const slider = bar.getByRole("slider", { name: "Position" });
    await waitFor("playback to move", async () => Number(await slider.inputValue()) >= 2, 15_000);
    await slider.focus();
    await page.keyboard.press("End");
    await bar.getByRole("button", { name: "Play", exact: true }).waitFor();
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal((await itemDetail(page, "Long wave serial")).workflow, "undecided", "a jump to the end is not listening to it, and a few seconds are not 30");
    step("jumping to the end of an episode changes nothing");

    await bar.getByRole("button", { name: "Play", exact: true }).click();
    await waitFor("the episode to be In progress", async () => (await itemDetail(page, "Long wave serial")).workflow === "inprogress", 60_000);
    assert.equal(await toasts.innerText(), "", "the change is not announced");
    step("after 30 seconds of playing the episode is In progress, without a message");

    await slider.fill("140");
    await waitFor("the episode to be Finished", async () => (await itemDetail(page, "Long wave serial")).workflow === "finished", 30_000);
    assert.equal(await toasts.innerText(), "", "the change is not announced");
    await bar.getByRole("button", { name: "Close the player" }).click();
    await bar.waitFor({ state: "detached" });
    await page.reload();
    await openEpisode(page, sourceId, "Long wave serial");
    await page.getByRole("button", { name: app.lib.statusLabel.menu(app.lib.constants.workflow.finished) }).waitFor();
    step("playing into its end finishes it, and it is still Finished after a reload");

    // Rows and the source page offer no download or saving in a browser.
    await page.goto(`${origin}/app/s/${sourceId}`);
    const row = page.locator("main .irow", { hasText: "Night shipping forecast" }).first();
    await row.waitFor();
    assert.equal(await row.getByRole("button", { name: downloadButton }).count(), 0, "no download button on a row");
    assert.equal(await page.getByRole("button", { name: /Save new episodes/ }).count(), 0, "a source can't save its episodes on the server");
    await row.getByRole("button", { name: new RegExp(`^${escapeRe(app.words.toListen)}:`) }).waitFor(); // an episode's one-click button says To listen
    step("rows and the source page offer no saving or downloading in a browser");

    // A phone-sized screen: the bar fits, and the reader, the list, the menu drawer (down to Settings) and
    // the e-ink page buttons all end above it, with the tab bar below it.
    await page.setViewportSize({ width: 390, height: 844 });
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByRole("button", { name: startsWith(mediaCopy.listen) }).click();
    const box = await bar.boundingBox();
    assert.ok(box && box.width <= 390 && box.y + box.height <= 844, "the player fits a phone screen");
    await clearOfPlayer("the reader", "aside.panel");
    await page.keyboard.press("Escape");
    await page.locator("aside.panel").waitFor({ state: "hidden" });
    await clearOfPlayer("the list", "#main");
    const tabs = await page.getByRole("navigation", { name: "Main" }).boundingBox();
    const played = await bar.boundingBox();
    assert.ok(tabs && played && played.y + played.height <= tabs.y + 0.5, "the player sits above the tab bar");
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: app.words.collections }).click();
    await page.locator('.app[data-drawer="open"]').waitFor();
    await clearOfPlayer("the menu drawer", "#side");
    await clearOfPlayer("Settings in the menu", "#side .side-foot .set");
    await page.locator("#side .side-foot .set").click(); // fails if anything covers it
    await page.getByRole("dialog", { name: app.words.settings }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: app.words.settings }).waitFor({ state: "detached" });
    await page.evaluate(() => localStorage.setItem("purss:display", "eink"));
    await openEpisode(page, sourceId, "Night shipping forecast");
    await page.getByRole("button", { name: startsWith(mediaCopy.listen) }).click();
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
