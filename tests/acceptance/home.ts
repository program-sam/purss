// Acceptance journey for Home's lists, reading progress, muted words and list filters (plan/34), against the real API
// serving the built web app (no FreshRSS, egress or worker: no podman and no network). Seeded like tests/acceptance/offline.ts:
// sources and items posted through the sync path the worker uses, written to the throwaway database before the API starts.
//
// Checks, in a desktop browser unless said: reading progress counts only a person's own scrolling (a script's jump to the end and
// Tab moving focus to the bottom save nothing; the wheel does), reopening goes back to where the item was left, an item that fits
// the screen counts after twenty seconds; Home's rows above the boxes start closed and stay open once opened; To read lists what was put aside, Recently kept leaves out a collection hidden on
// Home, and the boxes below do not repeat what is above them; a muted word is saved in Settings and lists say how many items it
// leaves out and can show them; the filter menu's Short length and a collection's Sources drop-down narrow a list; a row
// action's tip shows on mouse hover and keyboard focus but not after a tap on a phone, where the undo toast says what happened.
// Run: node tests/acceptance/home.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createBasket, createCollection } from "../../apps/api/src/services/collections.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { changeState, keepItem } from "../../apps/api/src/services/state.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-home-"));
const dataDir = path.join(work, "data");
const webDist = path.join(work, "dist");
const PORT = 19960;
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: "19968",
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: webDist,
  PURSS_DISK_RESERVE_BYTES: "0",
};
const EMAIL = "reader@example.test";
const step = (s: string) => console.log(`✓ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  stopping = true;
  if (!api || api.exitCode !== null) return;
  api.kill("SIGTERM");
  await new Promise((r) => api!.once("exit", r));
}
async function waitFor(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

type Seed = { ids: Record<string, string>; reading: string; radio: string };
const TITLES = ["Long essay", "Second essay", "Medium note", "Tiny abstract", "Night forecast", "Wire story 3"];

/** The throwaway library: a collection shown on Home with a long article, a medium one, a tiny abstract and a busy source; one hidden from Home. */
function prepare(): Seed {
  const config = loadConfig({ ...env, PURSS_DATA_DIR: dataDir } as Record<string, string>);
  const app = createApp(config);
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId } = claim(app, code, EMAIL, "Reader", testPassword());
    const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!.id;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu);
    const p: Principal & { engineUserId: string } = { accountId, workspaceId: ws, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString(), engineUserId: eu };
    const para = (n: number) => `<p>${Array.from({ length: 60 }, (_, i) => `word${(n * 7 + i) % 97}`).join(" ")}.</p>`;
    const paras = (count: number) => Array.from({ length: count }, (_, i) => para(i)).join("\n");
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const tidal = makeSource(app, p, "Tidal Notes", "feed/1");
    const radio = makeSource(app, p, "Slow Radio", "feed/2");
    const busy = makeSource(app, p, "Busy Wire", "feed/3");
    applySyncBatch(app, eu, batch([
      entry("feed/1", { title: "Long essay", contentHtml: paras(40), publishedAt: at(10), crawledAt: at(9) }),
      entry("feed/1", { title: "Second essay", contentHtml: paras(40), publishedAt: at(15), crawledAt: at(14) }),
      entry("feed/1", { title: "Medium note", contentHtml: paras(14), publishedAt: at(20), crawledAt: at(19) }),
      entry("feed/1", { title: "Tiny abstract", contentHtml: "<p>A very short abstract of three lines that fits the screen without any scrolling at all.</p>", publishedAt: at(30), crawledAt: at(29) }),
      ...["Night forecast", "Crackle on long wave", "Numbers stations"].map((title, i) => entry("feed/2", { title, summaryHtml: `<p>${title}: an hour of quiet radio, football edition.</p>`, publishedAt: at(40 + i), crawledAt: at(39 + i) })),
      ...Array.from({ length: 14 }, (_, i) => entry("feed/3", { title: `Wire story ${i + 1}`, summaryHtml: `<p>Busy wire story ${i + 1}.</p>`, publishedAt: at(1 + i), crawledAt: at(i) })),
    ]));
    const reading = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", view: "list", sourceIds: [tidal, busy], query: null } as Parameters<typeof createCollection>[2]);
    const hidden = createCollection(app, p, { name: "Radio", emoji: null, mode: "sources", view: "list", sourceIds: [radio], query: null } as Parameters<typeof createCollection>[2]);
    app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hidden.id);
    const id = (title: string) => app.db.get<{ id: string }>("SELECT id FROM items WHERE title = ?", title)!.id;
    const rev = (itemId: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", itemId)!.revision;
    changeState(app, p, id("Night forecast"), { workflow: "inprogress", expectedRevision: rev(id("Night forecast")) });
    const basket = createBasket(app, p, { name: "Keepers", captureMode: "metadata" });
    keepItem(app, p, id("Night forecast"), basket.id);
    keepItem(app, p, id("Wire story 3"), basket.id);
    changeState(app, p, id("Medium note"), { progress: 0.4, expectedRevision: rev(id("Medium note")) });
    changeState(app, p, id("Medium note"), { workflow: "toread", expectedRevision: rev(id("Medium note")) });
    return { ids: Object.fromEntries(TITLES.map((t) => [t, id(t)])), reading: reading.id, radio: hidden.id };
  } finally {
    app.db.close();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/app/`);
  await page.waitForURL(/\/signin/);
  await page.getByRole("textbox", { name: "Email address" }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const firstVisit = page.getByRole("dialog", { name: "How should we keep you posted?" });
  const notNow = firstVisit.getByRole("button", { name: "Not now", exact: true });
  await notNow.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await notNow.isVisible().catch(() => false)) { await notNow.click(); await firstVisit.waitFor({ state: "hidden" }); }
  await page.getByRole("heading", { name: "Home" }).waitFor();
}

const progressOf = (page: Page, id: string) => page.evaluate(async (i) => (await (await fetch(`/api/items/${i}`, { cache: "no-store" })).json()).progress as number, id);
const scrollState = (page: Page) => page.evaluate(() => { const el = document.getElementById("panel-body")!; return { top: el.scrollTop, range: el.scrollHeight - el.clientHeight }; });
const row = (page: Page, title: string) => page.locator("main .irow").filter({ has: page.locator(".title", { hasText: new RegExp(`^${title}$`) }) }).first();
const homeTitles = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim().replace(/^New\.\s*/, "")));

async function openItem(page: Page, title: string): Promise<void> {
  await row(page, title).click();
  await page.locator("#panel-in .p-title", { hasText: title }).waitFor();
  await sleep(400);
}
const closeItem = async (page: Page) => { await page.getByRole("button", { name: "Close details" }).click(); await sleep(300); };

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/sw.js"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const seed = prepare();
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("API started on its own port and data with a seeded library");

  const browser = await chromium.launch();
  try {
    // ---------- reading progress ----------
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);
    await page.getByText("Reading", { exact: true }).first().click();
    await page.locator("main .irow").first().waitFor();
    // A collection with new items opens on them; opened items stop being new, so read from everything.
    const show = page.locator("main").getByRole("button", { name: /^Filter: / }).first();
    assert.equal(await show.getAttribute("aria-label"), "Filter: New", "a collection with new items opens on New");
    await show.click();
    await page.getByRole("menuitemradio", { name: "All", exact: true }).click();
    await page.waitForURL(/filter=active/);

    const long = seed.ids["Long essay"]!;
    await openItem(page, "Long essay");
    await sleep(3000);
    assert.equal(await progressOf(page, long), 0, "opening an article and leaving it alone is not reading it");
    await page.evaluate(() => { const el = document.getElementById("panel-body")!; el.scrollTo({ top: el.scrollHeight }); });
    await sleep(3200);
    assert.equal(await progressOf(page, long), 0, "a script moving the page to the end is not a person scrolling");
    await page.evaluate(() => document.getElementById("panel-body")!.scrollTo({ top: 0 }));
    await sleep(2200);
    for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); await sleep(80); }
    await sleep(2800);
    assert.equal(await progressOf(page, long), 0, "Tab moving focus down the page is not reading it");
    // A press somewhere else on the page does not make the next jump the person's: only a press in the reader does.
    await page.evaluate(() => document.getElementById("panel-body")!.scrollTo({ top: 0 }));
    await sleep(1800);
    const where = (await page.locator("#panel-body").boundingBox())!;
    await page.mouse.click(where.x + 5, 4);
    await page.evaluate(() => { const el = document.getElementById("panel-body")!; el.scrollTo({ top: el.scrollHeight }); });
    await sleep(3200);
    assert.equal(await progressOf(page, long), 0, "a press outside the reader, then the page moving itself, is not reading");
    await page.evaluate(() => document.getElementById("panel-body")!.scrollTo({ top: 0 }));
    await sleep(1800);
    step("opening, a script's jump to the end, Tab through the page and a press elsewhere save no reading progress");

    await page.evaluate(() => document.getElementById("panel-body")!.scrollTo({ top: 0 }));
    const box = (await page.locator("#panel-body").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await scrollState(page);
    while ((await scrollState(page)).top < before.range * 0.5) { await page.mouse.wheel(0, 200); await sleep(60); }
    await sleep(2800);
    const saved = await progressOf(page, long);
    assert.ok(saved >= 0.5 && saved < 0.56, `scrolling with the wheel to half-way saves about half (${saved})`);
    await closeItem(page);
    await openItem(page, "Long essay");
    await sleep(1500);
    const again = await scrollState(page);
    assert.ok(Math.abs(again.top / again.range - saved) < 0.03, "reopening goes back to where it was left");
    await closeItem(page);
    await openItem(page, "Medium note");
    await sleep(1500);
    const medium = await scrollState(page);
    assert.ok(Math.abs(medium.top / medium.range - 0.4) < 0.03, "so does an item whose progress was saved before");
    await closeItem(page);
    step("wheel scrolling saves progress, and reopening goes back to the saved place");

    // Keys after one click in the text: focus can be on the page rather than in the reader, yet PageDown and Space still scroll the
    // reader (the browser scrolls what was last pressed).
    const keyed = seed.ids["Second essay"]!;
    await openItem(page, "Second essay");
    await sleep(1500);
    const beforeKeys = await progressOf(page, keyed);
    await page.locator("#panel-in .prose p").nth(2).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "focus is on the page");
    await sleep(3200); // longer than a press counts for on its own
    const keyedFrom = await scrollState(page);
    for (const key of ["PageDown", "PageDown", "Space", "PageDown"]) { await page.keyboard.press(key); await sleep(250); }
    await sleep(2800);
    const keyedTo = await scrollState(page);
    assert.ok(keyedTo.top > keyedFrom.top + 500, "the keys scrolled the reader");
    const afterPage = await progressOf(page, keyed);
    assert.ok(afterPage > Math.max(beforeKeys, keyedFrom.top / keyedFrom.range) + 0.1, `PageDown and Space after a click in the text are reading (${beforeKeys} to ${afterPage})`);
    await closeItem(page);
    step("keys that scroll the reader count after one click in the text, whether focus is on the page or the reader");

    const tiny = seed.ids["Tiny abstract"]!;
    await openItem(page, "Tiny abstract");
    await sleep(5000);
    assert.equal(await progressOf(page, tiny), 0, "an item that fits the screen is not read in a glance");
    await sleep(17_000);
    assert.equal(await progressOf(page, tiny), 1, "after twenty seconds on screen it is");
    await closeItem(page);
    step("an item that fits the screen counts as read after twenty seconds");

    // ---------- Home ----------
    await page.goto(`${origin}/app/`);
    await page.getByRole("heading", { name: "Home" }).waitFor();
    const rowToggle = (name: string) => page.locator(`.wb h2:has(:text('${name}')) button`);
    await rowToggle("To read").waitFor();
    for (const name of ["To read", "Recently kept"]) assert.equal(await rowToggle(name).getAttribute("aria-expanded"), "false", `${name} starts closed`);
    assert.equal(await page.locator(".wb .irow").count(), 0, "a closed row shows no items");
    await rowToggle("To read").click();
    await rowToggle("Recently kept").click();
    await page.reload();
    await page.locator(".wb:has(h2 :text('To read')) .irow").first().waitFor();
    assert.equal(await rowToggle("Recently kept").getAttribute("aria-expanded"), "true", "a row the user opened stays open");
    step("Home's To read and Recently kept start closed; once opened they stay open");
    assert.equal(await page.locator(".ccard").count(), 0, "Home has no Continue row");
    const toRead = await homeTitles(page, ".wb:has(h2 :text('To read')) .irow .title");
    assert.deepEqual(toRead, ["Medium note"], "To read lists what was put aside");
    const kept = await homeTitles(page, ".wb:has(h2 :text('Recently kept')) .irow .title");
    assert.deepEqual(kept, ["Wire story 3"], "Recently kept leaves out the hidden collection's item");
    const boxes = await homeTitles(page, ".mod:not(.wb) .irow .title");
    for (const title of [...toRead, ...kept]) assert.ok(!boxes.includes(title), `${title} is shown once, above the boxes`);
    step("To read lists what was put aside; Recently kept leaves out a collection hidden on Home; the boxes do not repeat what is above");

    // ---------- muted words, filters ----------
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Word or phrase").fill("football");
    await page.getByLabel("How long").selectOption("week");
    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await page.locator('ul[aria-label="Muted words"] li').waitFor();
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/app/c/${seed.radio}?filter=active`);
    await page.locator(".muted-notice").waitFor();
    assert.match(await page.locator(".muted-notice").innerText(), /3 items hidden by muted words/);
    assert.equal(await page.locator("main .irow").count(), 0, "the items stay out of the list");
    await page.getByRole("button", { name: "Show them" }).click();
    await page.locator("main .irow").first().waitFor();
    assert.equal(await page.locator("main .irow").count(), 3, "and come back when asked");
    step("a muted word saved in Settings leaves matching items out of a list, with a count and a way to show them");

    await page.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await page.locator("main .irow").first().waitFor();
    await page.getByRole("button", { name: "Sources: All sources" }).click();
    await page.getByRole("menuitemcheckbox", { name: /Busy Wire/ }).click();
    await page.waitForURL(/[?&](without|source)=/); // whichever list is shorter: the sources left out, or the ones still on
    await page.getByRole("menuitemcheckbox", { name: /Busy Wire/, checked: false }).waitFor(); // the list stays open
    await page.keyboard.press("Escape");
    await sleep(1200);
    const without = await homeTitles(page, "main .irow .title");
    assert.ok(without.length >= 3 && without.every((t) => !t.startsWith("Wire story")), `switching Busy Wire off leaves that source out (${without.join(", ")})`);
    await page.getByRole("button", { name: /^Sources: / }).click();
    await page.getByRole("menuitemradio", { name: "All sources" }).click();
    await page.waitForURL((u) => !/[?&](without|source)=/.test(u.search));
    await page.getByRole("button", { name: /^Filter:/ }).click();
    await page.getByRole("menuitemradio", { name: "Short (up to 5 min)" }).click();
    await page.waitForURL(/length=short/);
    await sleep(1200);
    const short = await homeTitles(page, "main .irow .title");
    assert.ok(short.includes("Medium note") && !short.includes("Long essay"), `Short keeps what takes up to five minutes (${short.join(", ")})`);
    step("switching a source off in a collection's Sources drop-down and the filter menu's Short length narrow its list");
    assert.deepEqual(errors, [], "no page errors");
    await context.close();

    // ---------- an e-ink display: the Page down button ----------
    const eink = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const reader = await eink.newPage();
    await signIn(reader);
    await reader.getByRole("button", { name: "Settings" }).first().click();
    await reader.getByRole("dialog").waitFor();
    await reader.locator("label.chk", { hasText: "E-ink display" }).click();
    await reader.keyboard.press("Escape");
    await reader.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await reader.locator("main .irow").first().waitFor();
    await openItem(reader, "Medium note");
    const medium2 = seed.ids["Medium note"]!;
    const before2 = await progressOf(reader, medium2);
    const down = reader.getByRole("group", { name: "Page through the article" }).getByRole("button", { name: "Page down" });
    await down.focus();
    for (let i = 0; i < 3; i++) { await reader.keyboard.press("Enter"); await sleep(150); }
    await sleep(2800);
    const afterKeys = await progressOf(reader, medium2);
    assert.ok(afterKeys > before2, `Enter on Page down is paging the article (${before2} to ${afterKeys})`);
    await down.evaluate((b) => (b as HTMLButtonElement).click());
    await down.evaluate((b) => (b as HTMLButtonElement).click());
    await sleep(2800);
    assert.ok(await progressOf(reader, medium2) > afterKeys, "so is a click a script or a screen reader makes");
    step("the e-ink Page down button counts as reading however it is pressed");
    await eink.close();

    // ---------- tips: mouse hover and keyboard focus show a row action's name, a tap on a phone does not ----------
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const deskPage = await desk.newPage();
    await signIn(deskPage);
    await deskPage.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    const deskIgnore = deskPage.locator("main .irow").first().getByRole("button", { name: /^Ignore: / });
    await deskIgnore.hover();
    await deskPage.locator(".tip", { hasText: "Ignore" }).waitFor();
    await deskPage.mouse.move(0, 0);
    await deskPage.locator(".tip").waitFor({ state: "detached" });
    await deskIgnore.focus();
    await deskPage.keyboard.press("Shift+Tab");
    await deskPage.keyboard.press("Tab");
    await deskPage.locator(".tip", { hasText: "Ignore" }).waitFor();
    await desk.close();
    const phone = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true });
    const phonePage = await phone.newPage();
    await signIn(phonePage);
    await phonePage.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await phonePage.locator("main .irow").first().getByRole("button", { name: /^Ignore: / }).tap();
    await phonePage.getByText("Ignored", { exact: true }).waitFor();
    await sleep(500);
    assert.equal(await phonePage.locator(".tip").count(), 0, "a tap shows no tip next to the button: the undo toast says what happened");
    step("hover and keyboard focus name a row action in a tip; a tap on a phone leaves only the undo toast");
    await phone.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("Home journey passed");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
