// Acceptance journey for Home's lists, reading progress, muted words and list filters, against the real API
// serving the built web app (no FreshRSS, egress or worker: no podman and no network). Seeded like tests/acceptance/offline.ts:
// sources and items posted through the sync path the worker uses, written to the throwaway database before the API starts.
//
// Checks, in a desktop browser unless said: reading progress counts only a person's own scrolling (a script's jump to the end and
// Tab moving focus to the bottom save nothing; the wheel does), reopening goes back to where the item was left, an item that fits
// the screen counts after twenty seconds; Home's rows above the boxes start closed and stay open once opened; To read lists what was put aside, a collection hidden on Home is left out of
// it, and the boxes below do not repeat what is above them; a muted word is saved in Settings and lists say how many items it
// leaves out and can show them; the filter menu's Short length and a collection's Sources drop-down narrow a list; a row
// action's tip shows on mouse hover and keyboard focus but not after a tap on a phone, where the undo toast says what happened; on a
// phone the open drawer's Settings and capacity sit at its bottom.
// Keyboard focus never falls to the page: a row that leaves its list (Ignore, `r`) hands it to a row that stays or to the list's heading,
// with and without reduced motion; choosing a show in Add source, downloading an export and the open phone drawer move or keep it too (the
// drawer takes focus, makes the page behind inert, keeps Tab inside it, and gives focus back). Search's "Show more results" reaches past the first eight.
// A video put aside is in its own To watch row, not in To read, and a row with nothing in it is not shown (To listen here); a source followed from now
// has its back catalogue Ignored: off Home, and its own page says so ("Ignored items are hidden") and shows it on request, and search finds it.
// The queue is what was put aside and what was started: an article In progress is in Home's To read row, first and marked In progress, and on the
// "To read, watch and listen" page, whose In progress filter shows it; a Home row marked To read keeps focus on a row that stays, and Play here moves
// focus to the player; the account button, Sign out and the bell never sit on Customise, the page's tools or a row's buttons (desktop with a long
// name and Sign out on a shared computer, with the reading pane open, with larger text, and on a phone).
// Run: node tests/acceptance/home.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createCollection } from "../../apps/api/src/services/collections.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { changeState } from "../../apps/api/src/services/state.ts";
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

type Seed = { ids: Record<string, string>; reading: string; radio: string; almanac: string; focus: string; channel: string };
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
      entry("feed/1", { title: "Short film", summaryHtml: "<p>A film about low water.</p>", publishedAt: at(25), crawledAt: at(24) }),
      ...["Night forecast", "Crackle on long wave", "Numbers stations"].map((title, i) => entry("feed/2", { title, summaryHtml: `<p>${title}: an hour of quiet radio, football edition.</p>`, publishedAt: at(40 + i), crawledAt: at(39 + i) })),
      ...Array.from({ length: 14 }, (_, i) => entry("feed/3", { title: `Wire story ${i + 1}`, summaryHtml: `<p>Busy wire story ${i + 1}.</p>`, publishedAt: at(1 + i), crawledAt: at(i) })),
    ]));
    // A source followed from now: what its feed already had is stored as Ignored, and stays off Home.
    const almanac = makeSource(app, p, "Old Almanac", "feed/4", { settled: false, startFrom: "now" });
    applySyncBatch(app, eu, batch(["Yearbook 1913", "Yearbook 1921", "Yearbook 1934"].map((title, i) => entry("feed/4", { title, summaryHtml: `<p>${title}: tables of tides.</p>`, publishedAt: at((40 + i) * 1440), crawledAt: at(39 * 1440) }))));
    // A source to triage on without changing what Home says: its posts are not New, and its collection is not on Home.
    const focus = makeSource(app, p, "Focus Notes", "feed/6");
    applySyncBatch(app, eu, batch(["Focus note 1", "Focus note 2", "Focus note 3"].map((title, i) => entry("feed/6", { title, summaryHtml: `<p>${title}.</p>`, publishedAt: at(60 + i), crawledAt: at(59 + i) }))));
    app.db.run("UPDATE item_state SET fresh = 0 WHERE item_id IN (SELECT id FROM items WHERE source_id = ?)", focus);
    const focusBox = createCollection(app, p, { name: "Focus", emoji: null, mode: "sources", view: "list", sourceIds: [focus], query: null } as Parameters<typeof createCollection>[2]);
    app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", focusBox.id);
    // A channel with one video whose page YouTube can play in the reader (Play here).
    const channel = makeSource(app, p, "Art Channel", "feed/5", { kind: "youtube" });
    applySyncBatch(app, eu, batch([entry("feed/5", { title: "Escher at work", url: "https://www.youtube.com/watch?v=abcdefghijk", summaryHtml: "<p>A film about prints.</p>", publishedAt: at(50), crawledAt: at(49) })]));
    const reading = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", view: "list", sourceIds: [tidal, busy], query: null } as Parameters<typeof createCollection>[2]);
    const hidden = createCollection(app, p, { name: "Radio", emoji: null, mode: "sources", view: "list", sourceIds: [radio], query: null } as Parameters<typeof createCollection>[2]);
    app.db.run("UPDATE collections SET show_on_home = 0 WHERE id = ?", hidden.id);
    const id = (title: string) => app.db.get<{ id: string }>("SELECT id FROM items WHERE title = ?", title)!.id;
    const rev = (itemId: string) => app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", itemId)!.revision;
    changeState(app, p, id("Night forecast"), { workflow: "inprogress", expectedRevision: rev(id("Night forecast")) });
    changeState(app, p, id("Medium note"), { progress: 0.4, expectedRevision: rev(id("Medium note")) });
    changeState(app, p, id("Medium note"), { workflow: "toread", expectedRevision: rev(id("Medium note")) });
    app.db.run("UPDATE items SET kind = 'video' WHERE title = 'Short film'");
    changeState(app, p, id("Short film"), { workflow: "toread", expectedRevision: rev(id("Short film")) });
    return { ids: Object.fromEntries(TITLES.map((t) => [t, id(t)])), reading: reading.id, radio: hidden.id, almanac, focus, channel };
  } finally {
    app.db.close();
  }
}

async function signIn(page: Page, o: { shared?: boolean } = {}): Promise<void> {
  await page.goto(`${origin}/app/`);
  await page.waitForURL(/\/signin/);
  await page.getByRole("textbox", { name: "Email address" }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  if (o.shared) await page.getByRole("checkbox", { name: /This is a shared computer/ }).check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const firstVisit = page.getByRole("dialog", { name: "How often do you want to hear about new items?" });
  const notNow = firstVisit.getByRole("button", { name: "Not now", exact: true });
  await notNow.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await notNow.isVisible().catch(() => false)) { await notNow.click(); await firstVisit.waitFor({ state: "hidden" }); }
  await page.getByRole("heading", { name: "Home" }).waitFor();
}

const progressOf = (page: Page, id: string) => page.evaluate(async (i) => (await (await fetch(`/api/items/${i}`, { cache: "no-store" })).json()).progress as number, id);
const scrollState = (page: Page) => page.evaluate(() => { const el = document.getElementById("panel-body")!; return { top: el.scrollTop, range: el.scrollHeight - el.clientHeight }; });
const row = (page: Page, title: string) => page.locator("main .irow").filter({ has: page.locator(".title", { hasText: new RegExp(`^${title}$`) }) }).first();
const homeTitles = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim().replace(/^New\.\s*/, "")));

async function checkAccountMenu(page: Page): Promise<void> {
  const account = page.getByRole("button", { name: "Account menu for Reader" });
  await account.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Account" });
  await menu.waitFor({ state: "visible" });
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).waitFor();
  const signOut = menu.getByRole("menuitem", { name: "Sign out", exact: true });
  await signOut.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Sign out");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Account menu for Reader");
  assert.equal(await account.evaluate((el) => el === document.activeElement), true, "Escape restores focus to the named account button");
}

async function openItem(page: Page, title: string): Promise<void> {
  await row(page, title).click();
  await page.locator("#panel-in .p-title", { hasText: title }).waitFor();
  await sleep(400);
}
const closeItem = async (page: Page) => { await page.getByRole("button", { name: "Close details" }).click(); await sleep(300); };


/**
 * The corner's buttons (the account menu, Sign out on a shared computer, the bell) sit clear of what the page puts beside them: Customise, a
 * list's tools and the top bar's own parts, and, with the reading pane open, of the rows' buttons. The name is a long one (the display name is
 * stood in for in the browser: the layout depends only on its text) and the computer is a shared one, so every button is there.
 */
async function checkCornerRoom(browser: Browser, seed: Seed): Promise<void> {
  const LONG = "Alexandria Papadopoulos-Karamanlis";
  const cases = [
    { name: "desktop", viewport: { width: 1366, height: 860 }, text: "100" },
    { name: "desktop with larger text", viewport: { width: 1366, height: 860 }, text: "130" },
    { name: "tablet", viewport: { width: 820, height: 1000 }, text: "100" },
    { name: "phone", viewport: { width: 412, height: 900 }, text: "100", touch: true },
    { name: "phone with larger text", viewport: { width: 412, height: 900 }, text: "130", touch: true },
  ];
  // One sign-in on a shared computer; every case is that session in a browser of its own size.
  const first = await browser.newContext({ viewport: cases[0]!.viewport });
  await signIn(await first.newPage(), { shared: true });
  const session = await first.storageState();
  await first.close();
  for (const c of cases) {
    // The page is told the long name by a stand-in for the session answer, which the app's own service worker would bypass.
    const context = await browser.newContext({ viewport: c.viewport, storageState: session, serviceWorkers: "block", ...(c.touch ? { hasTouch: true, isMobile: true } : {}) });
    await context.addInitScript((size) => localStorage.setItem("purss:text-size", size), c.text);
    const page = await context.newPage();
    await page.route("**/api/session", async (route) => {
      const res = await route.fetch();
      const body = await res.json() as { account?: { displayName: string | null } };
      if (body.account) body.account.displayName = LONG;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${origin}/app/`);
    const crowded = () => page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".cbtns");
      if (!box) return ["no corner"];
      const r = box.getBoundingClientRect();
      const names = [...box.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim() || b.getAttribute("aria-label") || "");
      const out: string[] = [];
      const mainBox = document.getElementById("main")!.getBoundingClientRect();
      for (const el of document.querySelectorAll<HTMLElement>(".home-top > *, .phead > *, .bar > *, .ltools > *, main .irow .racts > *")) {
        if (el.closest(".cbtns")) continue;
        let e = el.getBoundingClientRect();
        if (!e.width || !e.height) continue;
        if (el.closest("main")) {
          // What the page has scrolled out of view is clipped by the page, so only its visible part can be covered.
          e = new DOMRect(e.left, Math.max(e.top, mainBox.top), e.width, Math.min(e.bottom, mainBox.bottom) - Math.max(e.top, mainBox.top));
          if (e.height <= 0) continue;
        }
        if (e.left < r.right - 0.5 && e.right > r.left + 0.5 && e.top < r.bottom - 0.5 && e.bottom > r.top + 0.5) out.push(`${el.className || el.tagName} (${(el.textContent ?? "").trim().slice(0, 24)}) under ${names.join(" / ")}`);
      }
      return out;
    });
    const name = (await page.locator(".cbtns .bar-acct").first().getAttribute("aria-label")) ?? "";
    assert.match(name, /Alexandria Papadopoulos-Karamanlis/, `${c.name}: the account button carries the long name`);
    assert.equal(await page.locator(".cbtns").getByRole("button", { name: "Sign out", exact: true }).count(), 1, `${c.name}: Sign out is offered on a shared computer`);
    // The page's own start: Home.
    await page.getByRole("heading", { name: "Home" }).waitFor();
    await page.locator(".mod").first().waitFor();
    assert.deepEqual(await crowded(), [], `${c.name}: Home's heading and Customise clear of the corner`);
    // A list page: its tools.
    await page.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await page.locator("main .irow").first().waitFor();
    assert.deepEqual(await crowded(), [], `${c.name}: a list's tools and rows clear of the corner`);
    if (c.viewport.width >= 1200) {
      // With the reading pane open the list column is narrow: scrolled or not, no row button is under the corner.
      await row(page, "Medium note").click();
      await page.locator("#panel-in .p-title", { hasText: "Medium note" }).waitFor();
      await sleep(400);
      assert.deepEqual(await crowded(), [], `${c.name}: with the reading pane open the corner covers no row`);
      await page.evaluate(() => { const m = document.getElementById("main")!; m.scrollTo({ top: 140 }); });
      await sleep(300);
      assert.deepEqual(await crowded(), [], `${c.name}: and none after scrolling the list`);
      const strip = await page.evaluate(() => ({ corner: document.querySelector(".cbtns")!.getBoundingClientRect().bottom, main: document.getElementById("main")!.getBoundingClientRect().top }));
      assert.ok(strip.corner <= strip.main + 1, `${c.name}: the list starts below the corner's buttons (${strip.corner} <= ${strip.main})`);
    }
    await context.close();
    step(`${c.name}: the account button, Sign out and the bell clear the page's own controls`);
  }
}

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
    await checkAccountMenu(page);
    step("the desktop account menu has Settings and Sign out, works by keyboard and returns focus");
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
    assert.equal(await rowToggle("To read").getAttribute("aria-expanded"), "false", "To read starts closed");
    assert.equal(await page.locator(".wb .irow").count(), 0, "a closed row shows no items");
    await rowToggle("To read").click();
    await page.reload();
    await page.locator(".wb:has(h2 :text('To read')) .irow").first().waitFor();
    assert.equal(await rowToggle("To read").getAttribute("aria-expanded"), "true", "a row the user opened stays open");
    step("Home's To read starts closed; once opened it stays open");
    assert.equal(await page.locator(".ccard").count(), 0, "Home has no Continue row");
    const toRead = await homeTitles(page, ".wb:has(h2 :text('To read')) .irow .title");
    assert.deepEqual(toRead, ["Night forecast", "Medium note"], "To read lists what was started first, then what was put aside");
    assert.deepEqual(await page.locator(".wb:has(h2 :text('To read')) .irow .wf").evaluateAll((els) => els.map((e) => e.textContent)), ["In progress", "To read"], "each row says whether it was started");
    const boxes = await homeTitles(page, ".mod:not(.wb) .irow .title");
    for (const title of toRead) assert.ok(!boxes.includes(title), `${title} is shown once, above the boxes`);
    for (const title of ["Night forecast", "Crackle on long wave", "Numbers stations"]) assert.ok(!boxes.includes(title), `${title} (a collection hidden on Home) is not on Home`);
    step("To read lists what was started, then what was put aside, from any collection; the boxes do not repeat what is above");

    // To read is articles; a video put aside is in To watch, and a row with nothing in it (To listen) is not there.
    assert.deepEqual(toRead, ["Night forecast", "Medium note"], "a video is not in To read");
    await rowToggle("To watch").waitFor();
    assert.equal(await rowToggle("To watch").getAttribute("aria-expanded"), "false", "To watch starts closed like the other rows");
    await rowToggle("To watch").click();
    await page.locator(".wb:has(h2 :text('To watch')) .irow").first().waitFor();
    assert.deepEqual(await homeTitles(page, ".wb:has(h2 :text('To watch')) .irow .title"), ["Short film"], "To watch lists the video put aside");
    assert.equal(await rowToggle("To listen").count(), 0, "no podcast was put aside: no To listen row");
    assert.ok(!(await homeTitles(page, ".mod:not(.wb) .irow .title")).includes("Short film"), "a video in To watch is not listed again in the boxes");
    step("a video put aside is in its own To watch row; a row with nothing in it is not shown");

    // The page behind "Show all" and the sidebar's To read: the same queue, with its In progress filter showing what was started.
    await page.goto(`${origin}/app/r/toread`);
    await page.getByRole("heading", { name: "To read, watch and listen" }).waitFor();
    await page.locator("main .irow").first().waitFor();
    assert.deepEqual(await homeTitles(page, "main .irow .title"), ["Night forecast", "Medium note", "Short film"], "the queue page lists what was started first, then what was put aside, newest first");
    await page.getByRole("button", { name: /^Filter: / }).click();
    assert.equal(await page.getByRole("menuitemcheckbox", { name: "Show ignored items" }).count(), 0, "the queue never holds ignored items, so it does not offer them");
    assert.deepEqual((await page.getByRole("menuitemradio").evaluateAll((els) => els.map((e) => e.textContent?.trim()))).slice(0, 4), ["All", "New", "To read", "In progress"], "the page offers the filters that can show something");
    await page.getByRole("menuitemradio", { name: "In progress", exact: true }).click();
    await page.waitForURL(/filter=inprogress/);
    await sleep(600);
    assert.deepEqual(await homeTitles(page, "main .irow .title"), ["Night forecast"], "In progress shows what was started, which an episode half heard is");
    await page.getByRole("button", { name: /^Filter: / }).click();
    await page.getByRole("menuitemradio", { name: "To read", exact: true }).click();
    await page.waitForURL(/filter=toread/);
    await sleep(600);
    assert.deepEqual((await homeTitles(page, "main .irow .title")).sort(), ["Medium note", "Short film"], "To read what was not started");
    await page.goto(`${origin}/app/`);
    await page.getByRole("heading", { name: "Home" }).waitFor();
    step("the To read, watch and listen page holds what was started as well, first, and its In progress filter shows it");

    // A source followed from now: its back catalogue is Ignored, so it is not on Home, in a collection list or in the counts; search finds it, and its own page says so and shows it on request.
    const almanac = ["Yearbook 1913", "Yearbook 1921", "Yearbook 1934"];
    const onHome = await homeTitles(page, "main .irow .title");
    for (const title of almanac) assert.ok(!onHome.includes(title), `${title} (back catalogue of a source followed from now) is not on Home`);
    assert.match(await page.locator(".home-sum").innerText(), /new in|Since your last visit/, "Home still says what is New");
    await page.goto(`${origin}/app/s/${seed.almanac}`);
    await page.getByRole("heading", { name: "No new items for now" }).waitFor();
    assert.equal(await page.locator("main .irow").count(), 0, "the source's own page hides what is Ignored, like every list");
    assert.match(await page.locator("main").innerText(), /Ignored items are hidden\.\s*Show ignored/, "and says so, with the way to see it, when everything the source has is Ignored");
    assert.equal(await page.getByText("Nothing here yet").count(), 0, "it does not say there is nothing");
    await page.getByRole("button", { name: "Show ignored" }).click();
    await page.locator("main .irow").first().waitFor();
    assert.deepEqual((await homeTitles(page, "main .irow .title")).sort(), almanac, "Show ignored has all of it");
    const found = await page.evaluate(async () => ((await (await fetch("/api/items?scope=all&filter=all&q=tides&limit=20", { headers: { accept: "application/json" } })).json()) as { items: { title: string }[] }).items.map((i) => i.title).sort());
    assert.deepEqual(found, almanac, "and a search finds it");
    const held = await page.evaluate(async (id) => ((await (await fetch(`/api/sources/${id}`, { headers: { accept: "application/json" } })).json()) as { itemCount: number }).itemCount, seed.almanac);
    assert.equal(held, 3, "the source counts what it holds");
    await page.goto(`${origin}/app/`);
    await page.getByRole("heading", { name: "Home" }).waitFor();
    step("a source followed from now has its back catalogue Ignored: off Home and out of the counts, found by search, and shown on its own page on request");

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
    await checkAccountMenu(phonePage);
    await phonePage.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await phonePage.locator("main .irow").first().getByRole("button", { name: /^Ignore: / }).tap();
    await phonePage.getByText("Ignored", { exact: true }).waitFor();
    await sleep(500);
    assert.equal(await phonePage.locator(".tip").count(), 0, "a tap shows no tip next to the button: the undo toast says what happened");
    step("hover and keyboard focus name a row action in a tip; a tap on a phone leaves only the undo toast");
    // The open drawer covers the tab bar, so its foot (capacity and Settings) sits at the drawer's bottom with no gap kept for the bar.
    await phonePage.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Collections" }).tap();
    await phonePage.locator(".side-foot .set").waitFor({ state: "visible" });
    await sleep(300);
    const foot = await phonePage.evaluate(() => {
      const side = document.querySelector(".side")!.getBoundingClientRect(), set = document.querySelector(".side-foot .set")!.getBoundingClientRect();
      return { gap: side.bottom - set.bottom };
    });
    assert.ok(foot.gap <= 20, `Settings sits at the bottom of the phone drawer (gap ${foot.gap}px)`);
    step("on a phone the drawer's Settings and capacity sit at its bottom");
    // The phone drawer starts with Add source: the app's name and who is signed in sit in Home's top bar instead.
    assert.equal(await phonePage.locator("#side .brand").count(), 0, "the phone drawer has no logo row");
    assert.equal(await phonePage.locator("#side").getByText("Reader", { exact: true }).count(), 0, "the phone drawer does not repeat the account name");
    // The drawer takes focus, the page behind it can't be reached, Tab stays inside, and closing gives focus back to the tab that opened it.
    const inDrawer = () => phonePage.evaluate(() => !!document.activeElement?.closest("#side"));
    await phonePage.waitForFunction(() => !!document.activeElement?.closest("#side"));
    assert.equal(await phonePage.evaluate(() => document.activeElement?.getAttribute("data-fk")), "add", "the drawer opens with focus on Add source");
    for (const behind of [".stage", ".tabbar"]) assert.equal(await phonePage.locator(behind).evaluate((el) => (el as HTMLElement).inert), true, `${behind} is out of reach while the drawer is open`);
    for (let i = 0; i < 45; i++) { await phonePage.keyboard.press("Tab"); assert.equal(await inDrawer(), true, `Tab ${i + 1} stays in the drawer`); }
    for (let i = 0; i < 3; i++) { await phonePage.keyboard.press("Shift+Tab"); assert.equal(await inDrawer(), true, "Shift+Tab stays in the drawer"); }
    await phonePage.keyboard.press("Escape");
    await phonePage.locator('[data-drawer="open"]').waitFor({ state: "detached" });
    assert.equal(await phonePage.evaluate(() => (document.activeElement?.textContent ?? "").trim()), "Collections", "closing the drawer gives focus back to the tab that opened it");
    for (const behind of [".stage", ".tabbar"]) assert.equal(await phonePage.locator(behind).evaluate((el) => (el as HTMLElement).inert), false, `${behind} works again`);
    await phonePage.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Collections" }).tap();
    await phonePage.getByRole("button", { name: "Close sidebar" }).tap();
    await phonePage.waitForFunction(() => !document.querySelector('[data-drawer="open"]'));
    assert.equal(await phonePage.evaluate(() => (document.activeElement?.textContent ?? "").trim()), "Collections", "the drawer's Close button gives focus back the same way");
    step("on a phone the open drawer takes focus, shuts the page out, keeps Tab inside, and gives focus back when it closes");
    await phonePage.goto(`${origin}/app/`);
    await phonePage.locator(".bar .brand .who", { hasText: "Reader" }).waitFor({ state: "visible" });
    step("on a phone Home's top bar names the app and who is signed in, and the drawer leaves both out");
    await phone.close();

    // ---------- focus after a row leaves its list, with reduced motion (rows leave at once) ----------
    const still = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const stillPage = await still.newPage();
    await signIn(stillPage);
    const activeRow = () => stillPage.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { label: a?.getAttribute("aria-label") ?? null, inRow: !!a?.closest("main [data-item]"), tag: a?.tagName ?? null, inMain: !!a?.closest("main") && a !== document.body };
    });
    await stillPage.goto(`${origin}/app/s/${seed.focus}`);
    await stillPage.locator("main .irow").first().waitFor();
    const ignoreOf = (title: string) => stillPage.locator("main .irow").getByRole("button", { name: `Ignore: ${title}`, exact: true });
    await ignoreOf("Focus note 2").focus();
    await stillPage.keyboard.press("Enter");
    await stillPage.waitForFunction(() => document.querySelectorAll("main .irow").length === 2);
    assert.deepEqual(await activeRow(), { label: "Ignore: Focus note 3", inRow: true, tag: "BUTTON", inMain: true }, "Ignore: focus moves to the same button on the next row");
    await ignoreOf("Focus note 3").focus();
    await stillPage.keyboard.press("Enter");
    await stillPage.waitForFunction(() => document.querySelectorAll("main .irow").length === 1);
    assert.deepEqual(await activeRow(), { label: "Ignore: Focus note 1", inRow: true, tag: "BUTTON", inMain: true }, "the last row leaving hands focus to the row before it");
    await ignoreOf("Focus note 1").focus();
    await stillPage.keyboard.press("Enter");
    await stillPage.waitForFunction(() => document.querySelectorAll("main .irow").length === 0);
    assert.equal((await activeRow()).tag, "H1", "the list emptied: focus is on its heading, not the page");
    step("with reduced motion, Ignore on a row keeps focus on a row that stays, or on the list's heading when none is left");
    await stillPage.goto(`${origin}/app/c/${seed.reading}?filter=fresh`);
    await stillPage.locator("main .irow").first().waitFor();
    const fresh = await stillPage.locator("main .irow").count();
    const first = stillPage.locator("main .irow").first();
    const firstTitle = (await first.locator(".title").innerText()).replace(/^New\.\s*/, "").trim();
    await first.locator("[data-act='open']").focus();
    await stillPage.keyboard.press("r");
    await stillPage.waitForFunction((n) => document.querySelectorAll("main .irow").length === n - 1, fresh);
    const afterR = await activeRow();
    assert.equal(afterR.inRow, true, `r on "${firstTitle}": focus is on a row that stays`);
    step("with reduced motion, the r shortcut on a row keeps focus on a row that stays");

    // A row on Home marked To read leaves its box for the To read row above (which then shows it): focus goes to a row that stays.
    await stillPage.goto(`${origin}/app/`);
    await stillPage.getByRole("heading", { name: "Home" }).waitFor();
    await stillPage.locator(".wb h2:has(:text('To read')) button").click();
    await stillPage.locator(".wb:has(h2 :text('To read')) .irow").first().waitFor();
    const boxRow = stillPage.locator(".mod:not(.wb) .irow").filter({ has: stillPage.locator('button.tr[aria-pressed="false"]') }).first();
    const movedTitle = (await boxRow.locator(".title").innerText()).trim();
    await boxRow.getByRole("button", { name: `To read: ${movedTitle}`, exact: true }).focus();
    await stillPage.keyboard.press("Enter");
    await stillPage.waitForFunction((t) => ![...document.querySelectorAll(".mod:not(.wb) .irow .title")].some((e) => e.textContent?.trim() === t), movedTitle);
    const afterHome = await activeRow();
    assert.equal(afterHome.inMain, true, `To read on "${movedTitle}" in a Home box: focus is not on the page`);
    assert.equal(afterHome.inRow, true, "it is on a row that stays");
    assert.ok((await homeTitles(stillPage, ".wb:has(h2 :text('To read')) .irow .title")).includes(movedTitle), "and the item is in the To read row above");
    step("a Home row marked To read leaves its box for the To read row above and focus goes to a row that stays");

    // Play here puts the platform's player where the button was, and focus goes with it.
    await stillPage.route("https://www.youtube-nocookie.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>player</p>" }));
    await stillPage.goto(`${origin}/app/s/${seed.channel}`);
    await stillPage.locator("main .irow").first().click();
    await stillPage.locator("#panel-in .p-title", { hasText: "Escher at work" }).waitFor();
    const playHere = stillPage.locator("#panel-in").getByRole("button", { name: "Play here: Escher at work" });
    await playHere.focus();
    await stillPage.keyboard.press("Enter");
    await stillPage.locator("#panel-in iframe").waitFor();
    await stillPage.waitForFunction(() => document.activeElement?.tagName === "IFRAME");
    assert.match(await stillPage.evaluate(() => document.activeElement?.getAttribute("title") ?? ""), /YouTube player: Escher at work/, "Play here: focus is on the player, not the page");
    await stillPage.unroute("https://www.youtube-nocookie.com/**");
    step("after Play here focus moves to the player that replaced the button");
    await still.close();

    // ---------- search reaches past the first eight ----------
    const finder = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const findPage = await finder.newPage();
    await signIn(findPage);
    await findPage.keyboard.press("Control+k");
    const searchBox = findPage.getByRole("combobox");
    await searchBox.fill("wire");
    await findPage.getByRole("option", { name: /Show more results/ }).waitFor();
    assert.equal(await findPage.locator('.pal-list [role="option"][id^="po"]', { hasText: "Wire story" }).count(), 8, "the first answer is eight items");
    assert.match(await findPage.locator(".pal-foot").innerText(), /results so far/, "the footer says there are more");
    for (let i = 0; i < 8; i++) await findPage.keyboard.press("ArrowDown");
    assert.equal(await findPage.getByRole("option", { name: /Show more results/ }).getAttribute("aria-selected"), "true", "the arrow keys reach Show more results");
    await findPage.keyboard.press("Enter");
    await findPage.waitForFunction(() => [...document.querySelectorAll('.pal-list [role="option"]')].filter((o) => o.textContent?.includes("Wire story")).length === 14);
    assert.equal(await findPage.locator('.pal-list [role="option"]', { hasText: "Wire story" }).count(), 14, "Enter loads the rest of the matches");
    assert.equal(await findPage.getByRole("option", { name: /Show more results/ }).count(), 0, "and there is nothing more to ask for");
    assert.equal(await findPage.evaluate(() => document.activeElement?.id), "pq", "the search box keeps focus");
    assert.equal(await findPage.getByRole("option", { name: /Wire story/ }).nth(8).getAttribute("aria-selected"), "true", "the highlight is on the first item that was added");
    step("search's Show more results is reached by the arrow keys, loads the rest by Enter, and leaves focus in the search box");
    await findPage.keyboard.press("Escape");

    // ---------- focus after a download, and after choosing a show in Add source ----------
    await findPage.goto(`${origin}/app/settings/data`);
    const download = findPage.waitForEvent("download");
    await findPage.getByRole("button", { name: "Download export" }).click();
    await download;
    await findPage.getByText(/^Saved purss-export/).waitFor();
    assert.notEqual(await findPage.evaluate(() => document.activeElement === document.body), true, "after the export is saved focus is not on the page");
    assert.match(await findPage.evaluate(() => document.activeElement?.textContent ?? ""), /Saved purss-export/, "it is on what was saved, which is read out");
    await findPage.route("**/api/discover/podcasts", (r) => r.fulfill({ json: { ok: true, query: "quiet harbour", hits: [{ name: "Quiet Harbour Radio", author: "Harbour Press", genre: "News", artworkUrl: null, feedUrl: "https://shows.example.test/quiet.xml" }] } }));
    await findPage.route("**/api/discover", (r) => r.fulfill({ json: { ok: true, url: "https://shows.example.test/quiet.xml", candidates: [{ token: "tok_quiet", title: "Quiet Harbour Radio", kind: "feed", origin: "shows.example.test", via: "Posts feed", feedUrl: "https://shows.example.test/quiet.xml", siteUrl: null, cadence: "about 1 post a week", samples: [], summariesOnly: false, alreadyFollowingSourceId: null, privateWarning: null }] } }));
    await findPage.goto(`${origin}/app/`);
    await findPage.getByRole("button", { name: "Add source" }).first().click();
    await findPage.getByLabel("Link or podcast name").fill("quiet harbour");
    await findPage.getByRole("button", { name: "Search podcasts" }).click();
    await findPage.getByRole("button", { name: /Quiet Harbour Radio/ }).click();
    await findPage.getByRole("radio", { name: /Quiet Harbour Radio/ }).waitFor();
    assert.equal(await findPage.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type), "radio", "choosing a show puts focus on the feed that was found");
    step("after the export is saved and after a show is chosen in Add source, focus is on what the step shows");
    await findPage.keyboard.press("Escape");
    await findPage.unroute("**/api/discover");
    await findPage.unroute("**/api/discover/podcasts");

    // ---------- a basket made from an item's Keep menu: focus goes back to Keep, not to the page ----------
    await findPage.goto(`${origin}/app/c/${seed.reading}?filter=active`);
    await row(findPage, "Second essay").click();
    await findPage.locator("#panel-in .p-title", { hasText: "Second essay" }).waitFor();
    const panelKeep = findPage.locator("#panel-in").getByRole("button", { name: /^Keep/ }).first();
    await panelKeep.click();
    await findPage.getByRole("menuitem", { name: "New basket…" }).click();
    const basketDialog = findPage.getByRole("dialog", { name: "New basket" });
    await basketDialog.getByRole("textbox", { name: "Name" }).fill("Focus basket");
    await basketDialog.getByRole("button", { name: "Create basket" }).click();
    await basketDialog.waitFor({ state: "detached" });
    await findPage.waitForFunction(() => !!document.activeElement?.closest("#panel-in"));
    assert.equal(await findPage.evaluate(() => document.activeElement?.tagName), "BUTTON", "after the basket is made focus is back on the reader's Keep button");
    step("a basket made from an item's Keep menu returns focus to the Keep button");
    await finder.close();

    await checkCornerRoom(browser, seed);
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
