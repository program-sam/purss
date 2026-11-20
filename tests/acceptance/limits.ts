// Acceptance journey for a hosted Free account at its collection limit, against the real API serving the built web app (no FreshRSS,
// egress or worker: no podman and no network). The account is not an administrator, so the Free plan's 5 collections apply. Checked in
// the real page: when the server refuses a new collection after all (another tab took the last place), the reason appears and has
// focus; once all 5 are made, New collection says so before asking for a name, with a link to the plan, and Add source's
// "New collection…" choice is unavailable with the same words under it.
// Run: node tests/acceptance/limits.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { app } from "@purss/copy/app";
import { common } from "@purss/copy/common";
import { server } from "@purss/copy/server";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createCollection } from "../../apps/api/src/services/collections.ts";
import { TEST_PASSWORD, makeOwner } from "../../apps/api/src/testing.ts";
import { plural } from "../../apps/web/src/lib/format.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-limits-"));
const dataDir = path.join(work, "data");
const webDist = path.join(work, "dist");
/** A port nothing is listening on now (other worktrees run their journeys in parallel). */
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
  ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(await freePort()), PURSS_PUBLIC_ORIGIN: origin, PURSS_WEB_DIST: webDist,
  PURSS_DISK_RESERVE_BYTES: "0", PURSS_MODE: "hosted",
};
const step = (s: string) => console.log(`✓ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The words people read come from the catalogs, so rewording one cannot break this journey.
const signInCopy = app.auth.signIn;
const newCollectionCopy = app.dialogs.collections.newCollection;
const addSourceCopy = app.dialogs.addSource;
const settingsTitle = app.words.settings;
const yourPlanFree = app.account.planTab.yourPlan(common.plans.free);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What the Free plan says at 5 of 5 collections: before the form, and under Add source's choice. */
const NOTE = app.lib.planLimits.collectionLimit(common.plans.free, plural(5, app.words.collectionLower), 5, app.lib.planLimits.plusNoLimit);

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

/** A hosted account on the Free plan with four of its five collections. */
function prepare(): string {
  const app = createApp(loadConfig({ ...env, PURSS_DATA_DIR: dataDir } as Record<string, string>));
  try {
    const owner = makeOwner(app, { admin: false });
    for (const name of ["Reading", "Radio", "Friends", "Recipes"]) createCollection(app, owner, { name, emoji: null, mode: "sources", view: "list", sourceIds: [], query: null } as Parameters<typeof createCollection>[2]);
    return app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", owner.accountId)!.email;
  } finally {
    app.db.close();
  }
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${origin}/app/`);
  await page.waitForURL(/\/signin/);
  await page.getByRole("textbox", { name: app.words.emailAddress }).fill(email);
  await page.getByLabel(app.words.password, { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: app.words.signIn, exact: true }).click();
  const firstVisit = page.getByRole("dialog", { name: app.dialogs.firstVisitQuestion.title });
  const notNow = firstVisit.getByRole("button", { name: app.words.notNow, exact: true });
  await notNow.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await notNow.isVisible().catch(() => false)) { await notNow.click(); await firstVisit.waitFor({ state: "hidden" }); }
  await page.getByRole("heading", { name: app.words.home }).waitFor();
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/sw.js"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  const email = prepare();
  startApi();
  for (let i = 0; i < 120; i++) { if (await fetch(`${origin}/api/session`).then((r) => r.ok).catch(() => false)) break; await sleep(250); }
  step("a hosted installation with a Free account that has 4 of its 5 collections");

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signIn(page, email);

    // ---------- the server refuses after all: the reason is shown and has focus ----------
    const refused = server.api.plans.collectionsLimit("5", server.api.plans.plusAllowsMore);
    await page.route("**/api/collections", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 403, json: { error: { code: "plan_limit", message: refused } } })
      : route.continue());
    await page.locator("#side").getByRole("button", { name: app.words.newCollection }).click();
    const dialog = page.getByRole("dialog", { name: app.words.newCollection });
    await dialog.getByRole("textbox", { name: app.words.name }).fill("Fifth");
    await dialog.getByRole("button", { name: newCollectionCopy.create }).click();
    const alert = dialog.getByRole("alert");
    await alert.waitFor();
    assert.equal(await alert.innerText(), refused);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "alert", "the refusal has focus, so it is read out and in view");
    await page.keyboard.press("Escape");
    await page.unroute("**/api/collections");
    step("a refused new collection shows why, and focus is on the message rather than the page");

    // ---------- all five made: the limit is said before the form ----------
    await page.locator("#side").getByRole("button", { name: app.words.newCollection }).click();
    await dialog.getByRole("textbox", { name: app.words.name }).fill("Fifth");
    await dialog.getByRole("button", { name: newCollectionCopy.create }).click();
    await dialog.waitFor({ state: "detached" });
    await page.locator("#side").getByText("Fifth", { exact: true }).waitFor();
    await page.locator("#side").getByRole("button", { name: app.words.newCollection }).click();
    await dialog.waitFor();
    assert.equal((await dialog.locator(".dlg-b").innerText()).replace(/\s+/g, " ").trim(), NOTE, "the plan's wording, instead of the form");
    assert.equal(await dialog.getByRole("textbox").count(), 0, "no name to fill in for a collection that can't be made");
    await dialog.getByRole("button", { name: app.words.seePlans }).click();
    await page.getByRole("dialog", { name: settingsTitle }).getByText(yourPlanFree).waitFor();
    await page.keyboard.press("Escape");
    step("at the limit, New collection says so before asking for a name, and links to the plan");

    // ---------- Add source ----------
    await page.route("**/api/discover", (route) => route.fulfill({ json: { ok: true, url: "https://shows.example.test/quiet.xml", candidates: [{ token: "tok_quiet", title: "Quiet Harbour Radio", kind: "feed", origin: "shows.example.test", via: "Posts feed", feedUrl: "https://shows.example.test/quiet.xml", siteUrl: null, cadence: "about 1 post a week", samples: [], summariesOnly: false, alreadyFollowingSourceId: null, privateWarning: null }] } }));
    await page.getByRole("button", { name: app.words.addSource }).first().click();
    await page.getByLabel(addSourceCopy.linkOrName).fill("https://shows.example.test/quiet.xml");
    await page.getByRole("button", { name: addSourceCopy.find, exact: true }).click();
    const choice = page.locator("#as-col");
    await choice.waitFor();
    assert.equal(await choice.locator("option", { hasText: app.words.newCollectionMenu }).isDisabled(), true, "a new collection can't be chosen");
    assert.match(await choice.locator("option", { hasText: app.words.newCollectionMenu }).innerText(), new RegExp(escapeRe(addSourceCopy.limitReached.trim())));
    assert.ok(await page.getByRole("dialog", { name: app.words.addSource }).getByText(NOTE).isVisible(), "the plan's words are under the choice");
    await page.getByRole("dialog", { name: app.words.addSource }).getByRole("button", { name: app.words.seePlans }).click();
    await page.getByRole("dialog", { name: settingsTitle }).getByText(yourPlanFree).waitFor();
    step("at the limit, Add source's New collection… choice is unavailable, with the plan's words and a link under it");
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("Plan limit journey passed");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
