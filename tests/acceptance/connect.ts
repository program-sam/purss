// Acceptance journey for connected apps (plan/24), against the real API serving the built web app (no
// FreshRSS, egress or worker, so no podman and no network): a browser extension asks to connect while
// the person is signed out, they sign in and come back, approve, and the extension exchanges the typed
// code with PKCE; its token looks up a kept page, keeps links without duplicates and is refused
// elsewhere. The phone app's request is approved and declined through its purss:// return address.
// Settings → Connected apps lists both and disconnects them. Once the sign-in is more than ten minutes
// old, changing the password asks the person to confirm it's you, and the password does. Run:
// node tests/acceptance/connect.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession, type Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { setPreferences } from "../../apps/api/src/services/preferences.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createBasket } from "../../apps/api/src/services/collections.ts";
import { keepItem } from "../../apps/api/src/services/state.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-connect-"));
const dataDir = path.join(work, "data");
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
  ...process.env,
  PURSS_DATA_DIR: dataDir,
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: String(await freePort()),
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: path.join(repo, "apps/web/dist"),
  PURSS_DISK_RESERVE_BYTES: "0",
};
const USERNAME = "reader";
const step = (s: string) => console.log(`✓ ${s}`);
// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const KEPT_URL = "https://tidal.example/notes/flats";

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
async function waitFor(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A claimed installation with one source, its article kept in a basket. */
function prepare(): void {
  const app = createApp(loadConfig({ ...env } as Record<string, string>));
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId } = claim(app, code, "Reader", testPassword(USERNAME));
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id, { welcomeAsked: true });
    const workspaceId = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, workspaceId, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    const src = makeSource(app, p, "Tidal Notes", "feed/1");
    app.db.run("UPDATE sources SET site_url = 'https://tidal.example/notes/' WHERE id = ?", src);
    applySyncBatch(app, eu.id, batch([entry("feed/1", { title: "Tidal flats and sediment", url: KEPT_URL })]));
    const item = app.db.get<{ id: string }>("SELECT id FROM items WHERE source_id = ?", src)!.id;
    keepItem(app, p, item, createBasket(app, p, { name: "Read later", captureMode: "metadata" }).id);
  } finally {
    app.db.close();
  }
}

const connectUrl = (params: Record<string, string>) =>
  `${origin}/app/connect?${new URLSearchParams({ code_challenge: CHALLENGE, code_challenge_method: "S256", ...params })}`;

/** Navigations the page asks for, including to the app's purss:// address, which the browser can't open itself. */
async function watchNavigations(cdp: CDPSession): Promise<string[]> {
  const seen: string[] = [];
  await cdp.send("Page.enable");
  cdp.on("Page.frameRequestedNavigation", (e: { url: string }) => seen.push(e.url));
  return seen;
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  prepare();
  startApi();
  await waitFor("the API", async () => (await fetch(`${origin}/api/session`)).ok, 30_000);
  step("API started on its own port and data with a kept article");

  const browser = await chromium.launch();
  let page: Page | null = null;
  try {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const navigations = await watchNavigations(await page.context().newCDPSession(page));

    // The extension asks to connect (no return address: it will take a typed code) while signed out.
    await page.goto(connectUrl({ client: "extension", device_name: "Firefox on the laptop" }));
    await page.waitForURL(/\/signin\?next=/);
    await page.getByRole("textbox", { name: "Username" }).fill(USERNAME);
    await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/connect\?/);
    await page.getByText("Connect the browser extension?").waitFor();
    assert.equal(await page.getByLabel("Name, so you recognise it later").inputValue(), "Firefox on the laptop");
    step("a signed-out connection request goes through sign-in and comes back to the approval page");

    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Type this code into the app").waitFor();
    const code = (await page.locator("code.fx-url").first().innerText()).trim();
    assert.match(code, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    const extOrigin = "moz-extension://8c1f3c3a-1111-2222-3333-444455556666";
    const exchange = await fetch(`${origin}/api/connect/token`, { method: "POST", headers: { "content-type": "application/json", origin: extOrigin }, body: JSON.stringify({ client: "extension", code: code.toUpperCase(), codeVerifier: VERIFIER }) });
    assert.equal(exchange.status, 200, await exchange.clone().text());
    assert.equal(exchange.headers.get("access-control-allow-origin"), extOrigin);
    const token = ((await exchange.json()) as { token: string }).token;
    step("approved; the typed code and the PKCE verifier give the extension its token");

    const ext = (method: string, p: string, body?: unknown) => fetch(`${origin}${p}`, {
      method, headers: { authorization: `Bearer ${token}`, origin: extOrigin, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const lookup = (await (await ext("GET", `/api/items/lookup?url=${encodeURIComponent(`${KEPT_URL}/?utm_source=mastodon#comments`)}`)).json()) as { item: { title: string; baskets: { id: string; name: string }[] } | null; followedSources: { title: string }[] };
    assert.equal(lookup.item?.title, "Tidal flats and sediment");
    assert.deepEqual(lookup.item?.baskets.map((b) => b.name), ["Read later"]);
    assert.deepEqual(lookup.followedSources.map((s) => s.title), ["Tidal Notes"]);
    const basketId = lookup.item!.baskets[0]!.id;
    const first = (await (await ext("POST", "/api/items/manual", { url: "https://elsewhere.example/essay?utm_medium=email", basketId })).json()) as { itemId: string; existing: boolean };
    const again = (await (await ext("POST", "/api/items/manual", { url: "http://elsewhere.example/essay/", basketId })).json()) as { itemId: string; existing: boolean; alreadyInBasket: boolean };
    assert.deepEqual([first.existing, again.existing, again.alreadyInBasket, again.itemId], [false, true, true, first.itemId]);
    assert.equal((await ext("GET", "/api/bootstrap")).status, 403);
    assert.equal((await ext("GET", "/api/account/security")).status, 403);
    step("the extension looks up the kept page, keeps a link once, and is refused elsewhere");

    // The phone app: approve, and the page hands the code to purss://connect.
    await page.goto(connectUrl({ client: "mobile", redirect_uri: "purss://connect", state: "98765432109876543210", device_name: "Pixel 8" }));
    await page.getByText("Connect the PURSS app?").waitFor();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await waitFor("the redirect to the app", async () => navigations.some((u) => u.startsWith("purss://connect?code=")), 10_000);
    const back = new URL(navigations.find((u) => u.startsWith("purss://connect?code="))!);
    assert.equal(back.searchParams.get("state"), "98765432109876543210", "a numeric state comes back exactly as sent");
    const phone = await fetch(`${origin}/api/connect/token`, { method: "POST", headers: { "content-type": "application/json", origin: "capacitor://localhost" }, body: JSON.stringify({ client: "mobile", code: back.searchParams.get("code"), codeVerifier: VERIFIER, redirectUri: "purss://connect" }) });
    assert.equal(phone.status, 200, await phone.clone().text());
    const phoneToken = ((await phone.json()) as { token: string }).token;
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { authorization: `Bearer ${phoneToken}`, origin: "capacitor://localhost" } })).status, 200);
    step("the phone app's request is approved, its code arrives at purss://connect, and its token reads the PURSS");

    await page.goto(connectUrl({ client: "mobile", redirect_uri: "purss://connect", state: "phone-state-2" }));
    await page.getByRole("button", { name: "Don't connect" }).click();
    await waitFor("the refusal to reach the app", async () => navigations.some((u) => u.includes("error=access_denied") && u.includes("state=phone-state-2")), 10_000);
    await page.goto(connectUrl({ client: "mobile", redirect_uri: "https://evil.example/cb", state: "phone-state-3" }));
    await page.getByText("This connection link doesn't work").waitFor();
    assert.ok(!navigations.some((u) => u.startsWith("https://evil.example")), "never sent anywhere else");
    step("declining tells the app; a request with a foreign return address is refused on the page");

    // Settings → Connected apps.
    await page.goto(`${origin}/app/`);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Connected apps" }).click();
    await page.getByText("Firefox on the laptop").waitFor();
    await page.getByText("Pixel 8").waitFor();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Disconnect Firefox on the laptop" }).click();
    await page.locator("#toasts").getByText("Disconnected Firefox on the laptop").waitFor();
    assert.equal((await ext("GET", "/api/baskets")).status, 401);
    assert.equal((await fetch(`${origin}/api/session`, { headers: { authorization: `Bearer ${phoneToken}` } })).status, 200, "the other app stays connected");
    step("Settings lists both apps; disconnecting the extension stops its token at once");

    // A sign-in older than the step-up window (made so here) asks to confirm it's you before the password can change.
    const db = new DatabaseSync(path.join(dataDir, "product.db"), { timeout: 5000 });
    try { db.prepare("UPDATE sessions SET auth_at = ?").run(new Date(Date.now() - 11 * 60_000).toISOString()); } finally { db.close(); }
    await page.getByRole("button", { name: "Security" }).click();
    await page.getByRole("button", { name: "Change username or password" }).click();
    await page.getByText("For your safety, confirm it's you before this change.").waitFor();
    await page.getByLabel("Your password").fill("not the password");
    await page.getByRole("button", { name: "Confirm with password" }).click();
    await page.getByText("That password isn't right.").waitFor();
    await page.getByLabel("Your password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Confirm with password" }).click();
    await page.getByRole("button", { name: "Save new password" }).waitFor();
    step("an older sign-in asks to confirm it's you before the password can change; the password does, and a wrong one does not");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), "purss-connect-failure.png") }).catch(() => undefined);
    console.error(apiLog.slice(-2000));
    throw err;
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("\nConnected apps journey passed.");
} catch (err) {
  console.error("\nConnected apps journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
