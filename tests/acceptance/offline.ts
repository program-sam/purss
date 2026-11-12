// Acceptance journey for installing the app and reading offline, against the real API serving the
// built web app (no FreshRSS, egress or worker, so no podman and no network): sign in with an email address
// and password, mark an item To read, turn offline reading on, let the pack save, go offline, reload, read the
// item's text, see that changes fail plainly, come back online, switch to a new build, turn the
// setting off and on, sign out, and check that no copies stay. Along the way: highlight and comment on
// text (pointer and keyboard), see the highlight offline, write a note offline that waits to sync across
// a reload and is sent when the connection returns, and see unsynced notes deleted at sign-out.
// Run: node tests/acceptance/offline.ts (after npm run build)
//
// The library comes from the API's own test fixtures (sources and items posted through the same sync
// path the worker uses), written to the throwaway database before the API starts.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createCollection } from "../../apps/api/src/services/collections.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-offline-"));
const dataDir = path.join(work, "data");
const webDist = path.join(work, "dist");
const PORT = 19940;
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: "19948",
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: webDist,
  PURSS_DISK_RESERVE_BYTES: "0",
};
const EMAIL = "reader@example.test";
const step = (s: string) => console.log(`✓ ${s}`);

let api: ChildProcess | null = null;
function startApi(): void {
  api = spawn(process.execPath, ["apps/api/src/main.ts"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  api.stdout!.on("data", (d) => { log += d; });
  api.stderr!.on("data", (d) => { log += d; });
  api.on("exit", (code) => { if (code && !stopping) console.error(`[api] exited ${code}\n${log.slice(-2000)}`); });
}
let stopping = false;
/** The row titled "Tidal flats and sediment" exactly: every seeded summary mentions tidal flats, so a plain text match is ambiguous. */
function tidalRow(page: Page) {
  return page.locator("main .irow").filter({ has: page.locator(".title", { hasText: /^Tidal flats and sediment$/ }) });
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

/** The throwaway library: two sources in one collection, one article with a long text. Returns what the journey needs. */
function prepare(): { accountId: string } {
  const config = loadConfig({ ...env, PURSS_DATA_DIR: dataDir } as Record<string, string>);
  const app = createApp(config);
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId } = claim(app, code, EMAIL, "Reader", testPassword());
    const row = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal & { engineUserId: string } = { accountId, workspaceId: row.id, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString(), engineUserId: eu.id };
    const tidal = makeSource(app, p, "Tidal Notes", "feed/1");
    const radio = makeSource(app, p, "Slow Radio", "feed/2");
    const long = (n: number) => `<p>The tide leaves thin layers of silt across the flats, and each layer tells the story of one storm (${n}).</p><p>Walking out at low water, the surface is firm, ribbed, and cold underfoot.</p>`;
    const posts = [
      entry("feed/1", { title: "Tidal flats and sediment", contentHtml: long(1) }),
      ...["Reading the ripples", "Salt marsh edges", "Mud and memory", "A winter survey"].map((title, i) => entry("feed/1", { title, contentHtml: long(i + 2) })),
      ...["Night shipping forecast", "Crackle on the long wave", "Numbers stations"].map((title) => entry("feed/2", { title, summaryHtml: `<p>${title}: an hour of quiet radio.</p>` })),
    ];
    applySyncBatch(app, eu.id, batch(posts));
    createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", view: "list", sourceIds: [tidal, radio], query: null } as Parameters<typeof createCollection>[2]);
    return { accountId };
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
  if (await notNow.isVisible().catch(() => false)) {
    await notNow.click();
    await firstVisit.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "Add source" }).first().waitFor();
}

async function openSettings(page: Page): Promise<void> {
  // On a phone Settings has a button in the header; elsewhere it is at the foot of the sidebar.
  const inHeader = page.locator("header").getByRole("button", { name: "Settings" });
  if (await inHeader.isVisible()) await inHeader.click();
  else await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog").waitFor();
}
const offlineBox = (page: Page) => page.getByRole("checkbox", { name: /Offline reading on this device/ });
/** The checkbox itself is drawn by a styled box on top of it, so a person (and this journey) clicks its label. */
async function setOfflineReading(page: Page, on: boolean): Promise<void> {
  if ((await offlineBox(page).isChecked()) !== on) await page.locator("label.chk", { hasText: "Offline reading on this device" }).click();
  assert.equal(await offlineBox(page).isChecked(), on);
}

/** Names of the caches this origin holds. */
const cacheNames = (page: Page) => page.evaluate(() => caches.keys());
const hasWorkerControl = (page: Page) => page.evaluate(() => !!navigator.serviceWorker.controller);

/** Select a phrase in the open article, the way a person drags across it (or extends a selection with the keyboard). */
async function selectInArticle(page: Page, phrase: string): Promise<void> {
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector("#panel-in .prose")!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const i = n.data.indexOf(text);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + text.length);
      const s = document.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    throw new Error(`"${text}" isn't in the article`);
  }, phrase);
}
/** The outbox entries this browser holds, read straight from IndexedDB. */
const outboxEntries = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const req = indexedDB.open("purss-annotations", 1);
  req.onupgradeneeded = () => { req.result.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }); };
  req.onsuccess = () => {
    const count = req.result.transaction("outbox").objectStore("outbox").count();
    count.onsuccess = () => { req.result.close(); resolve(count.result); };
  };
}));
const annotationsOf = (page: Page, itemId: string) => page.evaluate(async (id) => (await (await fetch(`/api/items/${id}/annotations`, { cache: "no-store" })).json()).annotations as { kind: string; body: string | null; quote: { exact: string } | null }[], itemId);

async function pngSize(url: string): Promise<{ w: number; h: number; type: string | null }> {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), "PNG", `${url} is a PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: res.headers.get("content-type") };
}

async function checkInstallable(): Promise<void> {
  const manifestUrl = `${origin}/app/manifest.webmanifest`;
  const res = await fetch(manifestUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/manifest\+json/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const m = (await res.json()) as { name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] };
  assert.equal(m.name, "PURSS");
  assert.equal(m.short_name, "PURSS");
  assert.equal(m.start_url, "/app/");
  assert.equal(m.scope, "/app/");
  assert.equal(m.display, "standalone");
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  for (const sizes of ["192x192", "512x512"]) assert.ok(m.icons.some((i) => i.sizes === sizes && (i.purpose ?? "any") === "any"), `an ${sizes} icon`);
  assert.ok(m.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512"), "a maskable 512 icon");
  for (const icon of m.icons) {
    const r = await fetch(new URL(icon.src, manifestUrl));
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get("content-type")?.split(";")[0], icon.type, icon.src);
    if (icon.type === "image/png") {
      const { w, h } = await pngSize(new URL(icon.src, manifestUrl).href);
      assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} is the size the manifest says`);
    }
  }
  const apple = await pngSize(`${origin}/app/apple-touch-icon.png`);
  assert.deepEqual([apple.w, apple.h], [180, 180]);

  const sw = await fetch(`${origin}/app/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  assert.match(sw.headers.get("content-security-policy") ?? "", /default-src 'self'/);

  const html = await (await fetch(`${origin}/app/`)).text();
  assert.match(html, /<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/app\/apple-touch-icon\.png">/);
  assert.match(html, /apple-mobile-web-app-capable/);
}

let currentPage: Page | null = null;
async function diagnose(): Promise<void> {
  const shot = path.join(os.tmpdir(), "purss-offline-failure.png");
  await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/sw.js"))) throw new Error("Build the web app first: npm run build");
  // The API serves a private copy of the build, so the journey can swap in a new worker script later.
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const { accountId } = prepare();
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("API started on its own port and data with a seeded library");

  await checkInstallable();
  step("the manifest, icons, worker script and page tags are served with the right types and caching");

  const browser = await chromium.launch();
  try {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    currentPage = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signIn(page);
    await waitFor("the worker to take charge of the page", () => hasWorkerControl(page), 20_000);
    assert.deepEqual((await cacheNames(page)).filter((n) => n.startsWith("purss-api:")), [], "an ordinary browser tab keeps nothing until offline reading is turned on");
    assert.ok((await cacheNames(page)).some((n) => n.startsWith("purss-shell:")), "the app itself is saved");
    step("signed in with an email address and password; the app shell is saved and no personal data is");

    // The browser itself agrees the page is installable.
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    assert.deepEqual(manifest.errors, [], "the manifest parses without problems");
    assert.equal(manifest.url, `${origin}/app/manifest.webmanifest`);
    const installable = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installable.installabilityErrors, [], "the browser finds nothing in the way of installing");
    step("the browser reads the manifest without errors and reports the app installable");

    // To read.
    await page.getByText("Reading", { exact: true }).first().click();
    await page.locator("main .irow").first().waitFor();
    await tidalRow(page).first().click();
    await page.waitForURL(/item=/);
    await page.locator("#panel-in .p-title", { hasText: "Tidal flats and sediment" }).waitFor();
    await page.getByRole("button", { name: /^(State: |Set status)/ }).click();
    await page.getByRole("menuitemradio", { name: "To read" }).click();
    await page.locator("#toasts").getByText("Marked To read").waitFor();
    step("opened “Tidal flats and sediment” and marked it To read");

    // Highlights: with the pointer (the bar under the selection) and with the keyboard (c comments).
    const itemId = new URL(page.url()).searchParams.get("item")!;
    await page.locator("#panel-in .prose").getByText(/thin layers of silt/).waitFor();
    await selectInArticle(page, "thin layers of silt");
    await page.getByRole("toolbar", { name: "Selected text" }).getByRole("button", { name: "Highlight" }).click();
    await page.locator("#toasts").getByText("Highlighted").waitFor();
    await page.locator("#panel-in .prose mark.anno", { hasText: "thin layers of silt" }).waitFor();
    await selectInArticle(page, "firm, ribbed, and cold");
    await page.keyboard.press("c");
    const comment = page.getByRole("dialog", { name: "Add a comment" });
    await comment.getByLabel("Comment").fill("Compare with the winter survey");
    await comment.getByRole("button", { name: "Save highlight" }).click();
    await page.locator("#toasts").getByText("Highlighted with your comment").waitFor();
    await waitFor("both highlights to reach the server", async () => (await annotationsOf(page, itemId)).length === 2, 10_000);
    // Pressing a highlight opens it; Enter on it does the same.
    await page.locator("#panel-in .prose mark[data-anno-start]", { hasText: "firm, ribbed" }).click();
    await page.getByRole("dialog", { name: "Your highlight" }).getByLabel("Comment").waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Your highlight" }).getByLabel("Comment").inputValue(), "Compare with the winter survey");
    await page.keyboard.press("Escape");
    await page.locator("#panel-in .prose mark[data-anno-start]", { hasText: "thin layers" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Your highlight" }).waitFor();
    await page.keyboard.press("Escape");
    const found = await page.evaluate(async () => (await (await fetch("/api/search?q=winter%20survey")).json()).items.map((i: { title: string }) => i.title));
    assert.ok(found.includes("Tidal flats and sediment"), "search finds the item by the comment");
    step("highlighted a passage with the selection bar, commented on another with the keyboard, reopened both; search finds the comment");

    // Settings: off here by default, on by choice.
    await openSettings(page);
    const box = offlineBox(page);
    await box.waitFor();
    assert.equal(await box.isChecked(), false, "offline reading is off in an ordinary browser tab");
    await page.getByText("Remove offline copies").waitFor({ state: "detached", timeout: 1000 });
    await setOfflineReading(page, true);
    await page.getByText(/\d+ items? saved, last updated/).waitFor({ timeout: 30_000 });
    const summary = await page.getByText(/\d+ items? saved/).first().innerText();
    assert.match(summary, /^[1-9]\d* items? saved/, "the queue was saved");
    await page.getByText(/Using .* of this device's browser storage/).waitFor();
    const names = await cacheNames(page);
    assert.ok(names.includes(`purss-api:${accountId}`), "copies live in a cache named for the account");
    const saved = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search), `purss-api:${accountId}`);
    assert.ok(saved.includes("/api/session") && saved.includes("/api/bootstrap"), "the app's start-up answers are saved");
    assert.ok(saved.some((u) => /^\/api\/items\/[^/]+$/.test(u)), "item text is saved");
    assert.ok(saved.includes(`/api/items/${itemId}/annotations`), "the item's highlights are saved with it");
    assert.ok(!saved.some((u) => u.startsWith("/api/items?scope=all")), "the queue look-ups themselves are not kept");
    assert.ok(!saved.some((u) => /\/api\/(events|auth|admin|export|account)/.test(u)), "nothing sensitive is kept");
    step(`offline reading turned on: ${summary}`);
    await page.keyboard.press("Escape");

    // Offline: reload, read.
    await context.setOffline(true);
    await page.reload();
    await page.getByRole("button", { name: "Add source" }).first().waitFor({ timeout: 20_000 });
    await page.getByText("Offline · showing what this device saved").waitFor();
    const served = await page.evaluate(async () => { const r = await fetch("/api/bootstrap"); return { status: r.status, savedAt: r.headers.get("x-purss-offline") }; });
    assert.equal(served.status, 200);
    assert.match(served.savedAt ?? "", /^\d{4}-\d\d-\d\dT/, "the worker answered from this device's copy and said when it was saved");
    const session = await page.evaluate(async () => (await fetch("/api/session")).json());
    assert.equal(session.csrf, null, "the saved session doesn't hold the page's change token");
    step("reloaded offline: the app opens with the saved lists and says it is offline");

    await page.getByText("Reading", { exact: true }).first().click();
    await tidalRow(page).first().waitFor();
    await tidalRow(page).first().click();
    await page.locator("#panel-in .p-title", { hasText: "Tidal flats and sediment" }).waitFor();
    await page.locator("#panel-in .prose p", { hasText: "thin layers of silt" }).first().waitFor();
    await page.locator("#panel-in .prose mark.anno", { hasText: "thin layers of silt" }).waitFor();
    await page.locator("#panel-in").getByText("Compare with the winter survey").waitFor();
    step("opened the To read item offline and read its text, with its highlights and comment");

    // A note written offline waits on the device, survives a reload, and is sent when the connection returns.
    await page.getByRole("button", { name: "Add a note" }).click();
    await page.getByLabel("Note", { exact: true }).fill("Written on the train, offline");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.locator("#panel-in").getByText("Written on the train, offline").waitFor();
    await page.locator("#panel-in").getByText("Waiting to sync", { exact: true }).waitFor();
    await page.locator("#panel-in").getByText(/1 change is waiting to sync/).waitFor();
    assert.equal(await outboxEntries(page), 1, "kept in this device's outbox");
    await page.reload();
    await page.locator("#panel-in").getByText("Written on the train, offline").waitFor({ timeout: 20_000 });
    await page.locator("#panel-in").getByText("Waiting to sync", { exact: true }).waitFor();
    step("wrote a note offline: it shows as waiting to sync, and is still there after reloading offline");

    // A change made offline is kept on this device and sent once the PURSS can be reached.
    await page.getByRole("button", { name: /^(State: |Set status)/ }).click();
    await page.getByRole("menuitemradio", { name: "Finished" }).click();
    await page.locator("#toasts").getByText(/Not sent yet/).first().waitFor();
    await page.locator("#panel-in .p-pend").waitFor();
    step("changing it offline keeps the change on this device, marked as not sent yet");

    // Back online: the notice goes away and the change goes out.
    await context.setOffline(false);
    await page.getByText("Offline · showing what this device saved").waitFor({ state: "detached", timeout: 20_000 });
    await page.locator("#panel-in .p-pend").waitFor({ state: "detached", timeout: 20_000 });
    const sent = await page.evaluate(async () => {
      const r = await fetch("/api/items?scope=all&filter=all&limit=200", { credentials: "same-origin" });
      const body = await r.json() as { items: { title: string; workflow: string }[] };
      return body.items.find((i) => i.title.includes("Tidal flats and sediment"))?.workflow ?? null;
    });
    assert.equal(sent, "finished", "the change made offline reached the PURSS");
    await page.locator("#panel-in").getByText("Waiting to sync", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await outboxEntries(page), 0, "the annotation outbox is empty once sent");
    const notes = (await annotationsOf(page, itemId)).filter((a) => a.kind === "note").map((a) => a.body);
    assert.deepEqual(notes, ["Written on the train, offline"], "the server has the note written offline");
    // Back to To read, so the offline copy still has something to keep in the steps below.
    await page.getByRole("button", { name: /^(State: |Set status)/ }).click();
    await page.getByRole("menuitemradio", { name: "To read" }).click();
    await page.locator("#toasts").getByText("Marked To read").waitFor();
    step("back online: the notice goes away, and the change and the note made offline are sent");

    // A new build waits, then switches on request.
    await page.goBack().catch(() => undefined);
    appendFileSync(path.join(webDist, "sw.js"), "\n/* next build */\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await page.locator("#toasts").getByText("A new version is ready").waitFor({ timeout: 20_000 });
    const before = await page.evaluate(() => performance.timeOrigin);
    await page.locator("#toasts").getByRole("button", { name: "Reload" }).click();
    await waitFor("the page to reload once", async () => (await page.evaluate(() => performance.timeOrigin)) !== before, 20_000);
    await page.getByRole("button", { name: "Add source" }).first().waitFor();
    await waitFor("the new worker to take charge", () => hasWorkerControl(page), 10_000);
    step("a new version waits behind a toast, and Reload switches to it");

    // Turning it off wipes; turning it on saves again.
    await openSettings(page);
    await setOfflineReading(page, false);
    await waitFor("the copies to be removed", async () => (await cacheNames(page)).filter((n) => n.startsWith("purss-api:")).length === 0, 10_000);
    assert.ok((await cacheNames(page)).some((n) => n.startsWith("purss-shell:")), "the app shell stays");
    await setOfflineReading(page, true);
    await page.getByText(/\d+ items? saved, last updated/).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Remove offline copies" }).click();
    await page.locator("#toasts").getByText(/Removed the offline copies/).waitFor();
    assert.equal(await offlineBox(page).isChecked(), false, "removing the copies also turns offline reading off");
    assert.deepEqual((await cacheNames(page)).filter((n) => n.startsWith("purss-api:")), []);
    await setOfflineReading(page, true);
    await page.getByText(/\d+ items? saved, last updated/).waitFor({ timeout: 30_000 });
    step("turning offline reading off or removing the copies wipes them; turning it on saves again");

    // A note the server can't take yet waits; signing out warns about it and deletes it with the other copies.
    await page.keyboard.press("Escape");
    await context.route("**/api/items/*/annotations/*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 503, body: "" }) : route.continue()));
    await tidalRow(page).first().click();
    await page.getByRole("button", { name: "Add a note" }).click();
    await page.getByLabel("Note", { exact: true }).fill("Never reaches the server");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.locator("#panel-in").getByText("Waiting to sync", { exact: true }).waitFor();
    assert.equal(await outboxEntries(page), 1);
    await openSettings(page);

    // Sign out: nothing personal stays on the device.
    await page.getByRole("tab", { name: "Security" }).or(page.getByRole("button", { name: "Security" })).first().click();
    await page.getByText(/1 highlight or note hasn't synced yet/).waitFor();
    await page.getByRole("button", { name: "Sign out of this browser" }).click();
    await page.waitForURL(/\/signin/);
    await waitFor("the copies to be wiped at sign-out", async () => (await cacheNames(page)).filter((n) => n.startsWith("purss-api:")).length === 0, 10_000);
    assert.ok((await cacheNames(page)).some((n) => n.startsWith("purss-shell:")), "the app shell stays after sign-out");
    const leftovers = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("purss:offline-pack:")));
    assert.deepEqual(leftovers, [], "the pack's record is gone");
    assert.equal(await outboxEntries(page), 0, "unsynced notes are deleted at sign-out");
    await context.unroute("**/api/items/*/annotations/*");
    // Opened offline with nobody signed in and nothing saved, the app says so plainly instead of failing blank.
    await context.setOffline(true);
    await page.reload();
    await page.getByText(/Can't reach PURSS right now/).waitFor({ timeout: 20_000 });
    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("button", { name: /Sign in/ }).first().waitFor();
    step("signed out: every saved copy is gone, the app shell stays, and opening it offline says why it can't sign in");

    // Run as an installed app, offline reading starts on its own: it is on by default only there.
    const installed = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installed.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      const standalone = (q: string) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
      window.matchMedia = (q: string) => (q === "(display-mode: standalone)" ? (standalone(q) as unknown as MediaQueryList) : real(q));
    });
    const app = await installed.newPage();
    currentPage = app;
    app.on("pageerror", (e) => errors.push(e.message));
    await signIn(app);
    await waitFor("the installed app to save its reading list on its own", async () => (await cacheNames(app)).includes(`purss-api:${accountId}`), 30_000);
    await openSettings(app);
    assert.equal(await offlineBox(app).isChecked(), true, "offline reading is on by default in an installed app");
    await app.getByText("You're using the installed app.").waitFor();
    await app.getByText(/\d+ items? saved/).first().waitFor();
    await installed.close();
    step("as an installed app, offline reading is on by default and saves by itself");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    await diagnose();
    throw err;
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("\nOffline journey passed.");
} catch (err) {
  console.error("\nOffline journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
