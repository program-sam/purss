// Acceptance journey against the real stack: a separate FreshRSS container, egress proxy,
// API and worker on their own ports and a throwaway data directory, following real public
// feeds (network required). Journey: set up with a username and password -> passkey -> paste & follow -> items arrive ->
// browse views -> To read -> keep with text capture -> search -> restart -> sign in again
// with the passkey -> find the kept item -> the sidebar counts the sources -> an invited second account
// asks to be deleted and keeps its account by signing in again with its password. Run: npm run test:e2e
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession, type Page } from "@playwright/test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "purss-acceptance-"));
const PORT = 18940;
const origin = `http://localhost:${PORT}`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: "18948",
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_INTERNAL_URL: "http://127.0.0.1:18948",
  PURSS_ENGINE_CONTAINER: "purss-freshrss-acceptance",
  PURSS_ENGINE_PORT: "18941",
  PURSS_ENGINE_URL: "http://127.0.0.1:18941",
  PURSS_ENGINE_EXEC: "podman exec --user www-data purss-freshrss-acceptance",
  EGRESS_PROXY_PORT: "18946",
  EGRESS_GATEWAY_PORT: "18947",
  EGRESS_CONTROL_PORT: "18949",
  PURSS_EGRESS_PROXY: "http://host.containers.internal:18946",
  PURSS_EGRESS_CONTROL_URL: "http://127.0.0.1:18949/status",
  PURSS_SYNC_INTERVAL: "20",
};
const PASSWORD = "tidal flats at low water";
const FEEDS = [
  { url: "simonwillison.net", collection: "Reading" },
  { url: "https://www.youtube.com/@Computerphile", collection: "Watching" },
];

const procs = new Map<string, ChildProcess>();
function start(name: string, script: string): void {
  const p = spawn(process.execPath, [script], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout!.on("data", (d) => { log += d; });
  p.stderr!.on("data", (d) => { log += d; });
  p.on("exit", (code) => { if (code && !stopping) console.error(`[${name}] exited ${code}\n${log.slice(-2000)}`); });
  procs.set(name, p);
}
async function stop(name: string): Promise<void> {
  const p = procs.get(name);
  if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
}
function engine(cmd: "up" | "down"): void {
  const r = spawnSync(process.execPath, ["scripts/engine.ts", cmd], { cwd: repo, env, stdio: "inherit" });
  assert.equal(r.status, 0, `engine ${cmd} failed`);
}
async function waitFor(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const step = (s: string) => console.log(`✓ ${s}`);

let stopping = false;
async function teardown(): Promise<void> {
  stopping = true;
  for (const name of ["worker", "api", "egress"]) await stop(name);
  engine("down");
  // Engine files belong to the container's user namespace.
  spawnSync("podman", ["unshare", "rm", "-rf", dataDir], { stdio: "inherit" });
}

async function addPasskeyAuthenticator(cdp: CDPSession): Promise<string> {
  await cdp.send("WebAuthn.enable");
  const a = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  return a.authenticatorId;
}

async function follow(page: Page, url: string, collection: string): Promise<void> {
  await page.getByRole("button", { name: "Add source" }).first().click();
  const dlg = page.locator(".dlg");
  const found = dlg.getByText(/\d+ sources? found/);
  const link = dlg.locator("input").first();
  const help = dlg.locator("#as-help");
  await help.waitFor();
  await link.fill(url);
  await page.keyboard.press("Enter");
  await found.waitFor({ timeout: 30_000 });
  assert.equal(await help.count(), 0, "the paste hints give way to what was found");
  // Editing the link forgets the earlier result, so Follow can't act on the old address.
  await link.press("End");
  await link.press("x");
  await found.waitFor({ state: "detached" });
  await help.waitFor();
  assert.equal(await dlg.getByRole("button", { name: "Follow" }).count(), 0, "Follow is gone after the link changes");
  await link.fill(url);
  await page.keyboard.press("Enter");
  await found.waitFor({ timeout: 30_000 });
  const select = dlg.locator("select").first();
  const options = await select.locator("option").allInnerTexts();
  if (options.includes(collection)) await select.selectOption({ label: collection });
  else {
    await select.selectOption({ label: options.find((o) => o.startsWith("New collection"))! });
    // A new collection needs its name before Follow does anything.
    assert.ok(await dlg.getByRole("button", { name: "Follow" }).isDisabled(), "Follow waits for the collection name");
    await dlg.getByLabel("New collection name").fill(collection);
  }
  await dlg.getByRole("button", { name: "Follow" }).click();
  await page.locator("#toasts").getByText(/Following/).waitFor();
}

let currentPage: Page | null = null;

/** On failure: a screenshot and the job/capture state, kept outside the data directory that teardown removes. */
async function diagnose(): Promise<void> {
  const shot = path.join(os.tmpdir(), "purss-acceptance-failure.png");
  await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "product.db"), { readOnly: true });
    console.error("Jobs:", db.prepare("SELECT kind, status, attempts, last_error FROM jobs ORDER BY created_at").all());
    console.error("Captures:", db.prepare("SELECT status, error, length(text) AS text_length FROM captures").all());
    db.close();
  } catch (err) {
    console.error("Could not read the database:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) {
    assert.equal(spawnSync("npm", ["run", "build", "-w", "@purss/web"], { cwd: repo, stdio: "inherit" }).status, 0);
  }
  const { ensureDir, ensureSecret } = await import("../../apps/api/src/secrets.ts");
  ensureDir(path.join(dataDir, "secrets"));
  ensureSecret(path.join(dataDir, "secrets"), "service-token");
  start("egress", "apps/egress/src/main.ts");
  engine("up");
  start("api", "apps/api/src/main.ts");
  start("worker", "apps/worker/src/main.ts");
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("stack started on separate ports and data");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    currentPage = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    const authenticatorId = await addPasskeyAuthenticator(cdp);

    // Set up with the one-time code, a username and a password, then add a passkey.
    await page.goto(`${origin}/app/`);
    await page.waitForURL(/\/setup/);
    await page.getByLabel("Setup code").fill(readFileSync(path.join(dataDir, "secrets/setup-code"), "utf8").trim());
    await page.locator("#pw-u").fill("first-reader");
    await page.locator("#pw-p").fill(PASSWORD);
    await page.locator("#pw-a").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Fingerprint, face or screen lock", { exact: true }).waitFor();
    await page.getByRole("button", { name: /add fingerprint, face or screen lock/i }).first().click();
    await waitFor("a passkey", async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length === 1, 15_000);
    const firstVisit = page.getByRole("dialog", { name: "How should we keep you posted?" });
    const notNow = firstVisit.getByRole("button", { name: "Not now", exact: true });
    await notNow.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
    if (await notNow.isVisible().catch(() => false)) {
      await notNow.click();
      await firstVisit.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: "Add source" }).first().waitFor();
    step("claimed with the setup code, a username and a password, and registered a passkey");

    // Paste, preview, follow; the engine collects through the egress proxy and items arrive.
    for (const f of FEEDS) await follow(page, f.url, f.collection);
    step(`followed ${FEEDS.length} real sources`);
    await waitFor("items from the engine", async () => {
      await page.goto(`${origin}/app/`);
      // Wait for rendering before deciding: a just-loaded page shows nothing yet.
      return page.locator("main .irow").nth(5).waitFor({ timeout: 8000 }).then(() => true, () => false);
    }, 240_000);
    step("items arrived through FreshRSS, egress and the worker");

    // Browse a collection in every view; open an item with the keyboard; mark To read.
    await page.getByText("Reading", { exact: true }).first().click();
    for (const v of ["Cards", "Board", "Table", "Timeline", "List"]) {
      await page.getByRole("button", { name: v, exact: true }).first().click();
      await page.waitForTimeout(300);
    }
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await page.keyboard.press("o");
    await page.waitForURL(/item=/);
    const title = (await page.locator(".p-title").first().innerText()).trim();
    await page.getByRole("button", { name: /^(State: |Set status)/ }).click();
    await page.getByRole("menuitemradio", { name: "To read" }).click();
    await page.locator("#toasts").getByText("Marked To read").waitFor();
    step(`opened “${title.slice(0, 50)}” and marked it To read`);

    // Triage from the list itself: To read and Ignore each take one click on the row.
    const rowById = async (n: number) => {
      const row = page.locator('main .irow.has-acts:has(.rq.tr[aria-pressed="false"])').nth(n);
      return { row: page.locator(`main .irow[data-item="${await row.getAttribute("data-item")}"]`), name: (await row.locator(".title").first().innerText()).trim() };
    };
    const later = await rowById(0);
    await later.row.getByRole("button", { name: `To read: ${later.name}`, exact: true }).click();
    await later.row.locator('.rq.tr[aria-pressed="true"]').waitFor();
    await later.row.getByText("To read", { exact: true }).waitFor();
    const skip = await rowById(0);
    await skip.row.getByRole("button", { name: `Ignore: ${skip.name}`, exact: true }).click();
    await skip.row.waitFor({ state: "detached" });
    await page.locator("#toasts").getByRole("button", { name: "Undo" }).last().click();
    await skip.row.waitFor();
    step("marked a row To read and ignored another with one click each; Undo brought it back");

    // On Home, an ignored item leaves its box at once and the next one takes its place.
    await page.locator("#side").getByRole("button", { name: "Home", exact: true }).first().click();
    const box = page.locator("section.mod:not(.wb)").filter({ has: page.locator(".irow") }).first();
    await box.locator(".irow").nth(1).waitFor();
    const shown = await box.locator(".irow").count();
    const gone = await box.locator(".irow").first().getAttribute("data-item");
    await box.locator(".irow").first().getByRole("button", { name: /^Ignore: / }).click();
    await box.locator(`.irow[data-item="${gone}"]`).waitFor({ state: "detached" });
    assert.equal(await box.locator(".irow").count(), shown, "a spare item fills the ignored one's place");
    await page.locator("#toasts").getByRole("button", { name: "Undo" }).last().click();
    await box.locator(`.irow[data-item="${gone}"]`).waitFor();
    step("ignoring on Home took the item out of its box at once and the next one moved up; Undo put it back");

    // Readable text needs an article: open the longest one so a short live post doesn't decide the run.
    const longest = await page.evaluate(async () => {
      const r = await fetch("/api/items?limit=200", { headers: { accept: "application/json" } });
      const items = ((await r.json()) as { items: { id: string; kind: string; url: string | null; readMinutes: number | null }[] }).items;
      return items.filter((i) => i.url && i.kind !== "video" && i.kind !== "podcast").sort((a, b) => (b.readMinutes ?? 0) - (a.readMinutes ?? 0))[0]?.id;
    });
    if (!longest) throw new Error("no article to keep");
    const at = new URL(page.url());
    at.searchParams.set("item", longest);
    await page.goto(at.toString());
    const kept = (await page.locator(".p-title").first().innerText()).trim();

    // A basket that saves readable text, created from the open item, keeps that item; the capture job completes.
    await page.locator(".p-acts").getByRole("button", { name: "Keep" }).click();
    await page.getByRole("menuitem", { name: "New basket…" }).click();
    await page.locator(".dlg input").first().fill("Read later");
    await page.locator(".dlg").getByRole("radio", { name: /Keep readable text too/ }).check();
    await page.locator(".dlg").getByRole("button", { name: "Create basket" }).click();
    await page.locator(".dlg").waitFor({ state: "detached" });
    // Names in messages are wrapped in direction isolates (U+2068/U+2069) so mixed scripts stay in place.
    await page.locator("#toasts").getByText(/Created \u2068?Read later\u2069? and kept the item in it/).waitFor();
    await waitFor("the readable-text capture", async () => {
      await page.reload();
      return page.getByText("Full text captured").first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    }, 90_000);
    step("kept in a text basket and captured readable text");

    // Search finds it.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.keyboard.type(kept.split(/\s+/).slice(0, 3).join(" "));
    await page.locator("[role=dialog]").last().getByText(kept.slice(0, 30)).first().waitFor();
    await page.keyboard.press("Escape");
    step("search finds the kept item");

    // Restart API and worker; the data, session and basket survive.
    await stop("worker");
    await stop("api");
    start("api", "apps/api/src/main.ts");
    start("worker", "apps/worker/src/main.ts");
    await waitFor("the API after restart", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
    await page.goto(`${origin}/app/`);
    await page.getByRole("button", { name: "Add source" }).first().waitFor();
    step("API and worker restarted; still signed in");

    // Sign out, sign back in with the passkey, find the kept item in its basket.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Security" }).or(page.getByRole("button", { name: "Security" })).first().click();
    await page.getByRole("button", { name: "Sign out of this browser" }).click();
    await page.waitForURL(/\/signin/);
    await page.getByRole("button", { name: /sign in with fingerprint, face or screen lock/i }).first().click();
    await page.getByRole("button", { name: "Add source" }).first().waitFor();
    await page.getByText("Read later", { exact: true }).first().click();
    await page.locator("main").getByText(kept.slice(0, 30)).first().waitFor();
    step("signed in again with the passkey and found the kept item");

    // A basket has no Ignore: an item ignored in its source still shows there, undimmed, with Remove instead of Ignore.
    const ignored = await page.evaluate(async (id) => {
      const { csrf } = (await (await fetch("/api/session")).json()) as { csrf: string };
      const item = (await (await fetch(`/api/items/${encodeURIComponent(id)}`)).json()) as { revision: number };
      const r = await fetch(`/api/items/${encodeURIComponent(id)}/state`, { method: "PATCH", headers: { "content-type": "application/json", "x-purss-csrf": csrf }, body: JSON.stringify({ workflow: "ignored", expectedRevision: item.revision }) });
      return r.ok;
    }, longest);
    assert.ok(ignored, "the kept item was ignored through the API");
    await page.reload();
    const row = page.locator(`main [data-item="${longest}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute("data-wf"), "ignored");
    assert.ok(!(await row.evaluate((el) => el.classList.contains("dim"))), "an ignored item is not dimmed in a basket");
    assert.equal(await row.getByRole("button", { name: /^Ignore:/ }).count(), 0, "no Ignore button in a basket");
    assert.equal(await row.getByRole("button", { name: /^Restore:/ }).count(), 0, "no Restore button in a basket");
    assert.equal(await row.getByRole("button", { name: /^Remove from Read later:/ }).count(), 1);
    assert.equal(await page.getByText("Ignored items are", { exact: false }).count(), 0, "no show or hide ignored note in a basket");
    await page.getByRole("button", { name: /^Filter: All/ }).click();
    const filterMenu = page.getByRole("menu", { name: "Filter items" });
    await filterMenu.waitFor();
    assert.equal(await filterMenu.getByRole("menuitemradio", { name: "Ignored" }).count(), 0, "no Ignored filter in a basket");
    assert.equal(await filterMenu.getByText("Show ignored items").count(), 0, "no Show ignored items in a basket");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: /^Actions for / }).click();
    const rowMenu = page.getByRole("menu").last();
    await rowMenu.getByRole("menuitem", { name: "Remove from basket" }).waitFor();
    assert.equal(await rowMenu.getByRole("menuitem", { name: /^(Ignore|Restore)$/ }).count(), 0, "no Ignore or Restore in a basket's item menu");
    await page.keyboard.press("Escape");
    step("a basket shows an ignored item like any kept item and offers no Ignore");

    const meter = page.locator(".side-foot .stor");
    assert.match(await meter.innerText(), /^[1-9]\d* sources?$/, "the sidebar counts the followed sources");
    await meter.click();
    await page.getByText("No limits are set on this server.").waitFor();
    await page.keyboard.press("Escape");
    step("the sidebar shows the followed sources, without limits on a self-hosted PURSS");

    // A second, invited account asks to be deleted, is signed out, signs in again and keeps its account.
    const invite = spawnSync(process.execPath, ["apps/api/src/cli.ts", "create-invite", "--note", "acceptance"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(invite.status, 0, invite.stderr);
    const inviteCode = /: (\S+)$/.exec(invite.stdout.trim())![1]!;
    const second = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p2 = await second.newPage();
    currentPage = p2;
    p2.on("pageerror", (e) => errors.push(e.message));
    await p2.goto(`${origin}/app/invite?code=${encodeURIComponent(inviteCode)}`);
    await p2.locator("#auth-name").fill("Second Reader");
    await p2.locator("#pw-u").fill("second-reader");
    await p2.locator("#pw-p").fill(PASSWORD);
    await p2.locator("#pw-a").fill(PASSWORD);
    await p2.getByRole("button", { name: "Continue" }).click();
    await p2.getByRole("button", { name: /skip for now/i }).first().click();
    // A new account is asked once how it wants to be told about new things.
    const firstVisit2 = p2.getByRole("dialog", { name: "How should we keep you posted?" });
    await firstVisit2.getByRole("button", { name: "Not now", exact: true }).click();
    await firstVisit2.waitFor({ state: "hidden" });
    await p2.getByRole("button", { name: "Add source" }).first().waitFor();
    await p2.getByRole("button", { name: "Settings" }).click();
    await p2.getByRole("tab", { name: "Account" }).or(p2.getByRole("button", { name: "Account", exact: true })).first().click();
    await p2.getByRole("button", { name: /^Delete account…$/ }).click();
    await p2.locator("#da-confirm").fill("Second Reader");
    await p2.getByRole("button", { name: "Delete account", exact: true }).click();
    await p2.waitForURL(/\/signin/);
    await p2.getByText(/Your account will be deleted on/).waitFor();
    step("a second account asked to be deleted and was signed out");

    await p2.getByRole("textbox", { name: "Username" }).fill("second-reader");
    await p2.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await p2.getByRole("button", { name: "Sign in", exact: true }).click();
    await p2.getByRole("button", { name: "Keep my account" }).click();
    await p2.getByRole("button", { name: "Add source" }).first().waitFor();
    await second.close();
    currentPage = page;
    step("it signed in again and kept the account");
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
  console.log("\nAcceptance journey passed.");
} catch (err) {
  console.error("\nAcceptance journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await teardown();
}
