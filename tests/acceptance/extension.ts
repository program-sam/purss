// Acceptance journey for the browser extension and the bookmarklets (plan/32), against the real API
// serving the built web app (no FreshRSS, egress or worker: no podman, no network). The built Chromium
// extension is loaded unpacked into Chromium's new headless mode. A local "publisher" site serves a
// blog post that advertises a feed. Covered: a Keep deep link survives signing in; the extension
// connects through launchWebAuthFlow and the approval page with PKCE; the popup on the post offers its
// feed, keeps the page with the text as the browser shows it, then shows it as kept (also on the
// toolbar); PURSS labels that text "Captured in your browser"; "Add as a source" opens Add
// source filled in without looking anything up; Settings offers the bookmarklets, and running one opens
// Add source; disconnecting stops the token. The right-click menu and the address-bar keyword can't be
// driven by Playwright and are covered by unit tests (apps/extension/src/lib/background.test.ts).
// Run: node tests/acceptance/extension.ts (after npm run build and npm run build:extension)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { setPreferences } from "../../apps/api/src/services/preferences.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createBasket } from "../../apps/api/src/services/collections.ts";
import { OFFICIAL_WORKSPACE_ORIGIN } from "../../packages/domain/src/distribution.ts";

declare const chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- evaluated inside extension pages

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-extension-"));
const dataDir = path.join(work, "data");
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}
const PORT = await freePort();
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: String(await freePort()),
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: path.join(repo, "apps/web/dist"),
  PURSS_DISK_RESERVE_BYTES: "0",
};
const step = (s: string) => console.log(`✓ ${s}`);

let api: ChildProcess | null = null;
let stopping = false;
let apiLog = "";
function startApi(): void {
  api = spawn(process.execPath, ["apps/api/src/main.ts"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  api.stdout!.on("data", (d) => { apiLog += d; });
  api.stderr!.on("data", (d) => { apiLog += d; });
  api.on("exit", (code) => { if (code && !stopping) console.error(`[api] exited ${code}\n${apiLog.slice(-2000)}`); });
}
async function stopApi(): Promise<void> {
  if (!api || api.exitCode !== null) return;
  api.kill("SIGTERM");
  await new Promise((r) => api!.once("exit", r));
}
async function waitFor(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A claimed installation with two baskets. */
function prepare(): { recoveryCodes: string[] } {
  const app = createApp(loadConfig({ ...env } as Record<string, string>));
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId, recoveryCodes } = claim(app, code, "Reader");
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id, { welcomeAsked: true });
    const workspaceId = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    const p: Principal = { accountId, workspaceId, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    createBasket(app, p, { name: "Read later", captureMode: "metadata" });
    createBasket(app, p, { name: "Papers", captureMode: "metadata" });
    return { recoveryCodes };
  } finally {
    app.db.close();
  }
}

/** The publisher's site: a post that advertises its feed, and a plain page. */
const POST_TEXT = "The estuary keeps a record of storms in thin layers of silt, one for every flood tide that reached the marsh. ";
function startPublisher(): Promise<{ server: Server; base: string }> {
  const server = createHttpServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/blog/storm-layers") {
      res.end(`<!doctype html><html><head><title>Storm layers · Quiet Harbour</title>
        <link rel="alternate" type="application/rss+xml" title="Quiet Harbour" href="/feed.xml"></head>
        <body><nav><a href="/">Home</a></nav><article><h1>Storm layers</h1>${`<p>${POST_TEXT.repeat(3)}</p>`.repeat(5)}</article><footer>Copyright</footer></body></html>`);
    } else {
      res.end("<!doctype html><title>Plain page</title><p>Nothing to follow here.</p>");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

/** The built Chromium extension, given access to the publisher's site to stand in for the activeTab grant a click on the toolbar button gives. */
function extensionCopy(publisher: string): string {
  const built = path.join(repo, "apps/extension/dist/chromium");
  if (!existsSync(path.join(built, "manifest.json"))) throw new Error("Build the extension first: npm run build:extension");
  const dir = path.join(work, "extension");
  cpSync(built, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = [`${publisher}/*`];
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

async function signIn(page: Page, code: string): Promise<void> {
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Sign in with this code" }).click();
}

async function main(): Promise<void> {
  for (const f of ["apps/web/dist/index.html", "apps/extension/dist/chromium/manifest.json"]) {
    if (!existsSync(path.join(repo, f))) throw new Error(`Missing ${f}: run npm run build and npm run build:extension first`);
  }
  const { recoveryCodes } = prepare();
  const publisher = await startPublisher();
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("API started on its own port and data; a publisher site serves a post with a feed");

  const extDir = extensionCopy(publisher.base);
  // Extensions need Chromium itself (not the headless shell): its new headless mode runs them.
  const ctx: BrowserContext = await chromium.launchPersistentContext(path.join(work, "profile"), {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let page: Page | null = null;
  try {
    const sw: Worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
    const extId = new URL(sw.url()).host;
    const discoverCalls: string[] = [];
    ctx.on("request", (r) => { if (r.url().includes("/api/discover")) discoverCalls.push(r.url()); });
    const errors: string[] = [];

    // 1. A "Keep this page" deep link opened while signed out survives signing in.
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const plain = `${publisher.base}/plain?ref=bookmarklet`;
    await page.goto(`${origin}/app/?dialog=keep&url=${encodeURIComponent(plain)}&title=1984`);
    await page.waitForURL(/\/signin\?next=/);
    await signIn(page, recoveryCodes[0]!);
    await page.getByRole("dialog", { name: "Keep this page" }).waitFor();
    assert.equal(await page.getByLabel("Title (optional)").inputValue(), "1984", "a number-like title stays text");
    assert.ok(!new URL(page.url()).searchParams.has("url"), "the address is tidied");
    await page.getByLabel("Basket", { exact: true }).selectOption({ label: "Papers" });
    await page.getByRole("button", { name: "Keep", exact: true }).click();
    await page.locator("#toasts").getByText("Kept the link in Papers").waitFor();
    step("a Keep deep link opened while signed out comes back after sign-in, and keeps after confirming");

    // 2. Connect the extension from its options page: launchWebAuthFlow opens the approval page.
    const options = await ctx.newPage();
    options.on("pageerror", (e) => errors.push(`options: ${e.message}`));
    await options.goto(`chrome-extension://${extId}/options/options.html`);
    // The official server is preselected; another one is a small "Change server" away.
    await options.locator("#server").getByText(`Server: ${new URL(OFFICIAL_WORKSPACE_ORIGIN).host}`).waitFor();
    assert.ok(!(await options.locator("#address").isVisible()), "no address field until the person changes server");
    await options.locator("#change-server").click();
    await options.locator("#address").fill(origin.replace("http://", ""));
    const approvalOpened = ctx.waitForEvent("page");
    await options.locator("#connect").click();
    const approval = await approvalOpened;
    await approval.getByText("Connect the browser extension?").waitFor();
    assert.match(await approval.getByLabel("Name, so you recognise it later").inputValue(), /^Chrome on Linux$/);
    await approval.getByRole("button", { name: "Connect", exact: true }).click();
    await options.locator("#connected").waitFor();
    assert.match(await options.locator("#connected").innerText(), new RegExp(`Connected to ${origin}`));
    step("the official server is preselected; the extension connects to another through launchWebAuthFlow, the approval page and PKCE");

    // Helpers that drive the toolbar popup: it is opened by the extension itself on the active tab and
    // read through the options page, which can reach the popup's document.
    const openPopup = async (tab: Page) => {
      await options.evaluate(() => chrome.extension.getViews({ type: "popup" }).forEach((w: Window) => w.close()));
      await tab.bringToFront();
      await sw.evaluate(() => chrome.action.openPopup());
      await waitFor("the popup", () => options.evaluate(() => chrome.extension.getViews({ type: "popup" }).length === 1));
    };
    const popupText = (selector: string) => options.evaluate((s) => chrome.extension.getViews({ type: "popup" })[0]?.document.querySelector(s)?.textContent ?? null, selector);
    const waitText = (what: string, selector: string, re: RegExp) => waitFor(what, async () => re.test((await popupText(selector)) ?? ""));
    const popupDo = (selector: string, act: "click" | "check" | `select:${string}`) => options.evaluate(([s, a]) => {
      const el = chrome.extension.getViews({ type: "popup" })[0]?.document.querySelector(s);
      if (!el) throw new Error(`No ${s} in the popup`);
      if (a === "click") el.click();
      else if (a === "check") { el.checked = true; el.dispatchEvent(new Event("change")); }
      else { el.value = [...el.options].find((o: HTMLOptionElement) => o.text === a.slice(7)).value; el.dispatchEvent(new Event("change")); }
    }, [selector, act] as const);

    // 3. The popup on a blog post: not kept yet, its feed offered; keep it with its text.
    const post = await ctx.newPage();
    await post.goto(`${publisher.base}/blog/storm-layers`);
    await openPopup(post);
    await waitText("the page's status", "#status", /Not in your PURSS yet/);
    await waitText("the feed offer", "#add-source", /Follow “Quiet Harbour”/);
    await popupDo("#basket", "select:Read later");
    assert.equal(await popupText("#keep"), "Keep in Read later");
    await popupDo("#keep-text", "check");
    await popupDo("#keep", "click");
    await waitText("the result", "#result", /Kept in Read later\. Its text was saved as your browser shows it\./);
    await waitText("the new status", "#status", /Kept in Read later/);
    step("the popup offers the post's feed and keeps the page with the text as the browser shows it");

    // 4. Opened again on the same page, it says so at once, and so does the toolbar button.
    await openPopup(post);
    await waitText("the kept status", "#status", /✓ Kept in Read later/);
    assert.equal(await popupText("#keep"), "Keep its text", "keeping the text is remembered; the page is already in the basket");
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${publisher.base}/blog/storm-layers`);
    assert.equal(await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), "✓");
    await waitText("the replace hint", "#keep-text-hint", /Replaces the text kept from your browser on/);
    step("an already-kept page shows as kept in the popup and on the toolbar button");

    // 5. PURSS shows the text, labelled as captured in the browser.
    const itemOpened = ctx.waitForEvent("page");
    await popupDo("#open-item", "click");
    const item = await itemOpened;
    await item.waitForURL(/\/b\/[^?]+\?item=/);
    await item.getByText(/Captured in your browser on (?:\d+ [A-Z][a-z]+|[A-Z][a-z]+ \d+)/).waitFor(); // the date in the browser's own format
    await item.getByText("as your browser showed it", { exact: false }).waitFor();
    await item.locator(".prose").getByText("record of storms", { exact: false }).first().waitFor();
    assert.equal(await item.locator(".prose").getByText("Copyright").count(), 0, "only the readable part");
    step("PURSS shows the kept text, labelled “Captured in your browser” with its date");

    // 6. "Add as a source" hands the feed to Add source, filled in, and nothing is looked up.
    await openPopup(post);
    await waitText("the feed offer", "#add-source", /Quiet Harbour/);
    const addOpened = ctx.waitForEvent("page");
    await popupDo("#add-source", "click");
    const add = await addOpened;
    await add.getByRole("dialog", { name: "Add source" }).waitFor();
    assert.equal(await add.locator("#as-url").inputValue(), `${publisher.base}/feed.xml`);
    await add.waitForTimeout(1000);
    assert.equal(await add.getByText("Looking…").count(), 0);
    assert.deepEqual(discoverCalls, [], "nothing is looked up until Find");
    step("“Add as a source” opens Add source with the feed filled in, and looks nothing up by itself");

    // 7. Settings offers the bookmarklets and lists the extension; the "Add as source" one opens Add source.
    await add.getByRole("button", { name: "Cancel" }).click();
    await add.goto(`${origin}/app/?dialog=apps`);
    await add.getByText("Chrome on Linux").waitFor();
    const code = await add.getByRole("link", { name: "Add as source" }).getAttribute("href");
    assert.ok(code?.startsWith("javascript:"), "a draggable bookmarklet");
    const plainPage = await ctx.newPage();
    await plainPage.goto(plain);
    const fromBookmarklet = ctx.waitForEvent("page");
    await plainPage.evaluate((source) => (0, eval)(source), decodeURIComponent(code!.slice("javascript:".length)));
    const handed = await fromBookmarklet;
    await handed.getByRole("dialog", { name: "Add source" }).waitFor();
    assert.equal(await handed.locator("#as-url").inputValue(), plain);
    assert.deepEqual(discoverCalls, []);
    step("Settings offers the bookmarklets; running one opens Add source with the page filled in");

    // 8. Disconnecting revokes the token; the popup asks to connect again.
    await options.bringToFront();
    await options.locator("#disconnect").click();
    await options.locator("#address").waitFor();
    assert.equal(await options.locator("#address").inputValue(), origin, "the chosen server is remembered");
    await openPopup(post);
    await waitText("the connect prompt", "#connect", /Connect/);
    await add.goto(`${origin}/app/?dialog=apps`);
    await add.getByText("Nothing connected.", { exact: false }).waitFor();
    step("disconnecting revokes the extension's token and the popup asks to connect again");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), "purss-extension-failure.png") }).catch(() => undefined);
    console.error(apiLog.slice(-2000));
    throw err;
  } finally {
    await ctx.close();
    publisher.server.close();
  }
}

try {
  await main();
  console.log("\nBrowser extension journey passed.");
} catch (err) {
  console.error("\nBrowser extension journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
