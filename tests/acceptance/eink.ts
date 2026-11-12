// Acceptance check for the e-ink display, against the real API serving the built web app (no FreshRSS,
// egress or worker, so no podman and no network): the standard look first, then E-ink display turned on
// in Settings is pure black on white with nothing moving and no shadows, keeps row actions visible,
// pages the list and the article one screen at a time, stays on after a reload and over a dark theme,
// and when turned off leaves the standard look exactly as it was. Run: node tests/acceptance/eink.ts
// (after npm run build). Screenshots of both looks are saved to the system temp directory.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { setPreferences } from "../../apps/api/src/services/preferences.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createCollection } from "../../apps/api/src/services/collections.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-eink-"));
const dataDir = path.join(work, "data");
const PORT = 19970;
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: "19978",
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: path.join(repo, "apps/web/dist"),
  PURSS_DISK_RESERVE_BYTES: "0",
};
const shots = os.tmpdir();
const EMAIL = "reader@example.test";
const step = (s: string) => console.log(`✓ ${s}`);

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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A library long enough to page through: one source with 40 posts, the first with a long article. */
function prepare(): { sourceId: string; longItemId: string } {
  const config = loadConfig({ ...env, PURSS_DATA_DIR: dataDir } as Record<string, string>);
  const app = createApp(config);
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId } = claim(app, code, EMAIL, "Reader", testPassword());
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id, { welcomeAsked: true });
    const row = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, workspaceId: row.id, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    const sourceId = makeSource(app, p, "Tidal Notes", "feed/1");
    const paragraph = (n: number) => `<p>Paragraph ${n}. The tide leaves thin layers of silt across the flats, and each layer tells the story of one storm. Walking out at low water, the surface is firm, ribbed, and cold underfoot.</p>`;
    const long = Array.from({ length: 60 }, (_, i) => paragraph(i + 1)).join("");
    const posts = [
      entry("feed/1", { title: "A very long walk across the flats", contentHtml: long, publishedAt: "2026-11-04T10:00:00Z" }),
      ...Array.from({ length: 39 }, (_, i) => entry("feed/1", { title: `Low water notes ${i + 1}`, summaryHtml: `<p>Short note ${i + 1}.</p>`, publishedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T08:00:00Z` })),
    ];
    applySyncBatch(app, eu.id, batch(posts));
    createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", view: "list", sourceIds: [sourceId], query: null } as Parameters<typeof createCollection>[2]);
    const longItemId = app.db.get<{ id: string }>("SELECT id FROM items WHERE title = 'A very long walk across the flats'")!.id;
    return { sourceId, longItemId };
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
  await page.getByRole("button", { name: "Add source" }).first().waitFor();
}

async function openSettings(page: Page): Promise<void> {
  // On a phone Settings has a button in the header; elsewhere it is at the foot of the sidebar.
  const inHeader = page.locator("header").getByRole("button", { name: "Settings", exact: true });
  if (await inHeader.isVisible()) await inHeader.click();
  else await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").waitFor();
}
const einkBox = (page: Page) => page.getByRole("checkbox", { name: /E-ink display/ });
async function setEink(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  if ((await einkBox(page).isChecked()) !== on) await page.locator("label.chk", { hasText: "E-ink display" }).click();
  assert.equal(await einkBox(page).isChecked(), on);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

/** Computed styles that tell the two looks apart, from parts every list page has. */
async function look(page: Page) {
  return page.evaluate(() => {
    const css = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`missing ${sel}`);
      return getComputedStyle(el);
    };
    const row = css(".row-main");
    const btn = css(".btn.primary");
    const action = css(".racts .rq");
    const chevron = css(".chev .ic");
    const list = css(".list");
    const tool = css(".ltools .mbtn");
    return {
      display: document.documentElement.dataset.display ?? null,
      theme: document.documentElement.dataset.theme ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyInk: getComputedStyle(document.body).color,
      rowInk: row.color,
      primaryBg: btn.backgroundColor,
      primaryImage: btn.backgroundImage,
      chevronTransition: chevron.transitionDuration,
      listShadow: list.boxShadow,
      listBorder: list.borderTopColor,
      toolImage: tool.backgroundImage,
      actionOpacity: action.opacity,
      pageNav: !!document.querySelector(".pagenav"),
      themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
    };
  });
}

/** No shading: no background image, or a gradient whose colours are all the same. */
const flat = (image: string) => image === "none" || new Set(image.match(/rgba?\([^)]*\)/g) ?? []).size <= 1;

const scrollOf = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector<HTMLElement>(s)!;
  return { top: el.scrollTop, height: el.clientHeight, max: el.scrollHeight - el.clientHeight };
}, sel);

let currentPage: Page | null = null;

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  const { sourceId, longItemId } = prepare();
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("API started on its own port and data with a 40-item library");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    currentPage = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signIn(page);
    await page.goto(`${origin}/app/s/${sourceId}`);
    await page.locator(".row-main").first().waitFor();
    const standard = await look(page);
    assert.equal(standard.display, null, "the standard look carries no e-ink marker");
    assert.equal(standard.pageNav, false, "no page buttons in the standard look");
    assert.notEqual(standard.chevronTransition, "0s", "the standard look keeps its transitions");
    assert.notEqual(standard.listShadow, "none", "the standard look keeps its shadows");
    await page.screenshot({ path: path.join(shots, "purss-eink-standard.png") });
    step("the standard look: no marker, no page buttons, shadows and transitions as designed");

    await setEink(page, true);
    const eink = await look(page);
    assert.equal(eink.display, "eink");
    assert.equal(eink.theme, "light");
    assert.equal(eink.bodyBg, "rgb(255, 255, 255)", "white page");
    assert.equal(eink.bodyInk, "rgb(0, 0, 0)", "black text");
    assert.equal(eink.rowInk, "rgb(0, 0, 0)", "black item titles");
    assert.equal(eink.primaryBg, "rgb(0, 0, 0)", "the main action is solid black");
    assert.ok(flat(eink.primaryImage), `no gloss on the main action (${eink.primaryImage})`);
    assert.ok(flat(eink.toolImage), `no shading on the list's toolbar buttons (${eink.toolImage})`);
    assert.ok(!flat(standard.toolImage), "the standard toolbar buttons keep their shading");
    assert.equal(eink.chevronTransition, "0s", "nothing animates");
    assert.equal(eink.listShadow, "none", "no shadows");
    assert.equal(eink.listBorder, "rgb(0, 0, 0)", "black borders");
    assert.equal(eink.actionOpacity, "1", "row actions are shown without hovering");
    assert.equal(eink.themeColor, "#ffffff");
    assert.equal(eink.pageNav, true);
    await page.screenshot({ path: path.join(shots, "purss-eink-on.png") });
    step("E-ink display: black on white, no gradients, shadows or transitions, row actions always shown");

    // The list moves one screen per press, at once.
    const before = await scrollOf(page, "#main");
    assert.equal(before.top, 0);
    assert.ok(before.max > before.height, "the list is longer than one screen");
    const listNav = page.getByRole("group", { name: "Page through the list" });
    assert.equal(await listNav.getByRole("button", { name: "Page up" }).isDisabled(), true, "nothing above the top");
    await listNav.getByRole("button", { name: "Page down" }).click();
    const after = await scrollOf(page, "#main");
    assert.equal(after.top, before.height - 40, "one screen down, keeping one line of the last one, with no smooth scroll");
    await listNav.getByRole("button", { name: "Page up" }).click();
    assert.equal((await scrollOf(page, "#main")).top, 0);
    step("Page down and Page up move the list exactly one screen at once");

    // The article pages the same way, and the dialog opens without animating.
    await page.goto(`${origin}/app/s/${sourceId}?item=${longItemId}`);
    await page.locator("#panel-body .prose").waitFor();
    const articleNav = page.getByRole("group", { name: "Page through the article" });
    const a0 = await scrollOf(page, "#panel-body");
    await articleNav.getByRole("button", { name: "Page down" }).click();
    const a1 = await scrollOf(page, "#panel-body");
    assert.equal(a1.top, a0.height - 40, "the article moves one screen");
    await page.screenshot({ path: path.join(shots, "purss-eink-article.png") });
    await openSettings(page);
    assert.equal(await page.locator(".dlg").evaluate((el) => getComputedStyle(el).animationName), "none", "dialogs appear without animation");
    await page.keyboard.press("Escape");
    // Close the article again: with the reader open a laptop's sidebar steps back to its rail, and the
    // looks below are compared with the list as it was at the start.
    await page.getByRole("button", { name: "Close details" }).click();
    await page.waitForURL((u) => !u.searchParams.has("item"));
    step("the article pages one screen at a time; dialogs appear without animation");

    // A dark theme on the account doesn't reach this device; a reload keeps the choice.
    await openSettings(page);
    await page.getByRole("button", { name: "Dark" }).click();
    await page.getByText("This device uses the e-ink display").waitFor();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.locator(".row-main").first().waitFor();
    const reloaded = await look(page);
    assert.equal(reloaded.display, "eink", "saved on this device");
    assert.equal(reloaded.theme, "light", "a dark account theme doesn't apply on an e-ink display");
    assert.equal(reloaded.bodyBg, "rgb(255, 255, 255)");
    step("after a reload, still e-ink and still white although the account chose Dark");

    // Turning it off restores the account's own look; with Light again it matches the start exactly.
    await setEink(page, false);
    assert.equal((await look(page)).theme, "dark", "the account's dark theme returns");
    await openSettings(page);
    await page.getByRole("button", { name: "Light" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.goto(`${origin}/app/s/${sourceId}`);
    await page.locator(".row-main").first().waitFor();
    assert.deepEqual(await look(page), standard, "the standard look is exactly as before");
    step("turned off, the standard look is exactly as it was");

    // A phone-sized e-reader gets the same buttons.
    const phone = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const small = await phone.newPage();
    currentPage = small;
    await signIn(small);
    await setEink(small, true);
    await small.goto(`${origin}/app/s/${sourceId}`);
    await small.locator(".row-main").first().waitFor();
    await small.getByRole("group", { name: "Page through the list" }).getByRole("button", { name: "Page down" }).click();
    assert.ok((await scrollOf(small, "#main")).top > 0);
    await small.screenshot({ path: path.join(shots, "purss-eink-phone.png") });
    await phone.close();
    step("on a phone-sized screen the page buttons work too");

    assert.deepEqual(errors, [], "no uncaught page errors");
    console.log(`Screenshots: ${path.join(shots, "purss-eink-*.png")}`);
  } catch (err) {
    const shot = path.join(shots, "purss-eink-failure.png");
    await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("\nE-ink check passed.");
} catch (err) {
  console.error("\nE-ink check FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
