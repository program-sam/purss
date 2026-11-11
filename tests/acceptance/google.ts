// Acceptance journey for signing in with Google (an external OpenID Connect provider, here a local fake issuer), against the
// real API serving the built web app on a hosted installation with open sign-up and a local SMTP server (no FreshRSS, worker or
// network): a stranger makes an account with "Continue with Google" (no username or password), reaches Home, signs out and in
// again with Google, and — with the sign-in older than the step-up window — adds a password after confirming it's them with
// Google. Someone whose Google email already belongs to an account is refused, with nothing linked or made. The phone app's
// browser path (what ConnectScreen opens) signs a third person up through Google, lands on the approval page, hands the code
// to purss://connect and gets a device token; the same app then confirms it's it with Google through a ticket and the
// system browser. Screenshots go to .output/google-signin/. Run: node tests/acceptance/google.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Server } from "oauth2-mock-server";
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { claim, createAccount, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { startSmtpSink } from "../../apps/api/src/mail/testing.ts";
import { TEST_PASSWORD, testPassword } from "../../apps/api/src/testing.ts";
import { pkce, providerStartUrl, providersOffered, readAppCode, readCallback, REDIRECT_URI } from "../../apps/web/src/platform/native/connect.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-google-"));
const dataDir = path.join(work, "data");
const shots = path.join(repo, ".output/google-signin");
mkdirSync(shots, { recursive: true });
const step = (s: string) => console.log(`✓ ${s}`);

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}
const PORT = await freePort();
const origin = `http://localhost:${PORT}`;

let api: ChildProcess | null = null;
let stopping = false;
let apiLog = "";
function startApi(env: NodeJS.ProcessEnv): void {
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
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Direct access to the API's database, for what a real clock or a real operator would do. */
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dataDir, "product.db"), { timeout: 5000 });
  try { return fn(db); } finally { db.close(); }
}
const count = (sql: string) => withDb((db) => (db.prepare(sql).get() as { n: number }).n);
const makeStale = () => withDb((db) => {
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  db.prepare("UPDATE sessions SET auth_at = ?").run(old);
  db.prepare("UPDATE device_tokens SET auth_at = ?").run(old);
});

/** The claims the fake Google puts in the next ID token. */
let claims: Record<string, unknown> = {};

async function dismissFirstVisit(page: Page): Promise<void> {
  const later = page.getByRole("button", { name: "Not now" });
  const add = page.getByRole("button", { name: "Add source" }).first();
  await later.or(add).first().waitFor();
  if (await later.isVisible()) await later.click();
  await add.waitFor();
}

let currentPage: Page | null = null;

async function main(smtpPort: number, google: OAuth2Server): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  const env: NodeJS.ProcessEnv = {
    ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(await freePort()), PURSS_PUBLIC_ORIGIN: origin,
    PURSS_WEB_DIST: path.join(repo, "apps/web/dist"), PURSS_DISK_RESERVE_BYTES: "0", PURSS_MODE: "hosted", PURSS_SIGNUP: "open",
    PURSS_SMTP_HOST: "127.0.0.1", PURSS_SMTP_PORT: String(smtpPort), PURSS_SMTP_SECURITY: "none", PURSS_MAIL_FROM: "PURSS <ws@example.org>",
    PURSS_OIDC: JSON.stringify([{ id: "google", label: "Google", issuer: google.issuer.url, clientId: "purss-acceptance", clientSecret: "not-a-secret", stepUp: "choose-account" }]),
  };
  // The operator's account, and Dana, who already has an account with a confirmed email address.
  const prepared = createApp(loadConfig(env));
  try {
    claim(prepared, ensureClaimCode(prepared)!, "Operator", testPassword("operator"));
    const dana = prepared.db.tx(() => createAccount(prepared, { displayName: "Dana", admin: false, allocationBytes: null, grantedBy: null, password: testPassword("dana") }));
    prepared.db.run("UPDATE accounts SET email = 'dana@example.org', email_verified_at = ? WHERE id = ?", new Date().toISOString(), dana.accountId);
  } finally { prepared.db.close(); }
  startApi(env);
  await waitFor("open sign-up", async () => (await (await fetch(`${origin}/api/session`)).json()).installation.signup === "open", 30_000);
  const accounts = count("SELECT COUNT(*) n FROM accounts");
  assert.equal(accounts, 2);
  step("hosted installation with open sign-up and a fake Google configured");

  const browser = await chromium.launch();
  const errors: string[] = [];
  const outside: string[] = [];
  const newPage = async (viewport = { width: 1280, height: 800 }): Promise<Page> => {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    // Nothing loads from anywhere but PURSS itself (the fake Google is only navigated to).
    page.on("request", (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith(google.issuer.url!) && !r.url().startsWith("data:") && !r.url().startsWith("purss:")) outside.push(r.url()); });
    currentPage = page;
    return page;
  };
  try {
    // ---- the buttons
    const page = await newPage();
    await page.goto(`${origin}/app/signin`);
    const button = page.getByRole("link", { name: "Continue with Google" });
    await button.waitFor();
    assert.equal(await button.locator("svg.gsi-mark").count(), 1, "Google's own G, drawn inline");
    assert.equal(await page.locator("img").count(), 0, "no remote image");
    const style = await button.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color, border: c.borderTopColor }; });
    assert.deepEqual(style, { bg: "rgb(255, 255, 255)", color: "rgb(31, 31, 31)", border: "rgb(116, 119, 117)" }, "Google's light button colours");
    await page.screenshot({ path: path.join(shots, "01-signin.png") });
    await page.getByRole("link", { name: "create an account" }).click();
    await page.getByRole("link", { name: "Continue with Google" }).waitFor();
    await page.screenshot({ path: path.join(shots, "02-signup.png") });
    step("sign-in and sign-up pages show Continue with Google, white with the multicolour G");

    // ---- make an account with Google
    claims = { sub: "google-ana", email: "Ana@Example.org", email_verified: true, name: "Ana Reader" };
    await page.getByRole("link", { name: "Continue with Google" }).click();
    await page.waitForURL(`${origin}/app/`);
    await dismissFirstVisit(page);
    assert.equal(count("SELECT COUNT(*) n FROM accounts"), accounts + 1);
    step("Continue with Google made an account (no username or password) and shows Home");

    await page.goto(`${origin}/app/?dialog=security`);
    const security = page.getByRole("dialog");
    await security.getByText("Google", { exact: true }).waitFor();
    await security.getByRole("button", { name: "Add a password" }).waitFor();
    assert.equal(await security.getByRole("button", { name: "Remove google" }).count(), 1, "the provider can be removed (the server refuses the last way in)");
    await page.screenshot({ path: path.join(shots, "03-security.png") });
    const ana = withDb((db) => db.prepare("SELECT display_name, email, email_verified_at FROM accounts WHERE email = 'Ana@Example.org'").get() as { display_name: string; email: string; email_verified_at: string | null });
    assert.equal(ana.display_name, "Ana Reader");
    assert.ok(ana.email_verified_at, "the address came confirmed");
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'password' AND label = 'ana'"), 0);
    await security.getByRole("button", { name: "Remove google" }).click();
    await security.getByText("This is your last way to sign in. Add a password first.").waitFor();
    step("Settings → Security lists Google as the way in; removing the last way in is refused");

    // ---- sign out and in again with Google
    await security.getByRole("button", { name: "Sign out of this browser" }).click();
    await page.waitForURL(/\/signin/);
    await page.getByRole("link", { name: "Continue with Google" }).click();
    await page.waitForURL(`${origin}/app/`);
    await dismissFirstVisit(page);
    assert.equal(count("SELECT COUNT(*) n FROM accounts"), accounts + 1, "the same account, not another");
    step("signed out, then Continue with Google signs the same account in again");

    // ---- confirm it's you with Google: a sign-in older than the step-up window, no password, no passkey
    makeStale();
    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByRole("dialog").getByRole("button", { name: "Add a password" }).click();
    await page.getByText("For your safety, confirm it's you before this change.").waitFor();
    assert.equal(await page.getByLabel("Your password").count(), 0, "no password to type");
    await page.getByRole("button", { name: "Confirm with Google" }).waitFor();
    await page.screenshot({ path: path.join(shots, "04-confirm-with-google.png") });
    await page.getByRole("button", { name: "Confirm with Google" }).click();
    await page.waitForURL(/\/app\/\?dialog=security/);
    await page.locator("#toasts").getByText("Confirmed with Google.").waitFor();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add a password" }).click();
    await page.getByLabel("Username").fill("ana");
    await page.getByLabel("Password", { exact: true }).fill("tidal flats at low water");
    await page.getByLabel("Password again").fill("tidal flats at low water");
    await page.getByRole("button", { name: "Add password" }).click();
    await page.locator("#toasts").getByText("Password added").waitFor();
    await dialog.getByText("Username · added").waitFor();
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'password' AND label = 'ana'"), 1);
    step("Confirm with Google refreshed the sign-in and the account added a password");

    // ---- an email that already belongs to an account is refused
    const stranger = await newPage();
    claims = { sub: "google-dana", email: "DANA@example.org", email_verified: true, name: "Dana Again" };
    const before = count("SELECT COUNT(*) n FROM accounts");
    await stranger.goto(`${origin}/app/signin`);
    await stranger.getByRole("link", { name: "Continue with Google" }).click();
    const refusal = stranger.getByRole("alert");
    await refusal.getByText("An account with this email address already exists. Sign in with your username and password, then connect Google in Settings → Security.").waitFor();
    await stranger.screenshot({ path: path.join(shots, "05-email-in-use.png") });
    assert.equal(count("SELECT COUNT(*) n FROM accounts"), before, "no second account");
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'google-dana'"), 0, "and nothing linked");
    // An address the provider doesn't vouch for makes nothing either.
    claims = { sub: "google-new", email: "new@example.org", email_verified: false, name: "New" };
    await stranger.getByRole("link", { name: "Continue with Google" }).click();
    await stranger.getByText("didn't give PURSS a verified email address").waitFor();
    assert.equal(count("SELECT COUNT(*) n FROM accounts"), before);
    step("an existing email, or one Google doesn't vouch for, is refused: nothing linked, nothing made");

    // ---- the phone app's browser path
    const infoRes = await (await fetch(`${origin}/api/connect/info`)).json();
    const providers = providersOffered(infoRes);
    assert.deepEqual(providers, [{ id: "google", label: "Google", start: `${origin}/api/auth/oidc/google/start` }]);
    const phoneBrowser = await newPage({ width: 412, height: 915 });
    const navigations: string[] = [];
    const cdp: CDPSession = await phoneBrowser.context().newCDPSession(phoneBrowser);
    await cdp.send("Page.enable");
    cdp.on("Page.frameRequestedNavigation", (e: { url: string }) => navigations.push(e.url));
    const p = await pkce();
    claims = { sub: "google-pat", email: "pat@example.org", email_verified: true, name: "Pat" };
    await phoneBrowser.goto(providerStartUrl(providers[0]!.start, infoRes.connect.page, { challenge: p.challenge, state: p.state, deviceName: "Pixel 8" }));
    await phoneBrowser.getByText("Connect the PURSS app?").waitFor();
    assert.equal(await phoneBrowser.getByLabel("Name, so you recognise it later").inputValue(), "Pixel 8");
    await phoneBrowser.screenshot({ path: path.join(shots, "06-approve-app.png") });
    await phoneBrowser.getByRole("button", { name: "Connect", exact: true }).click();
    await waitFor("the redirect to the app", async () => navigations.some((u) => u.startsWith(`${REDIRECT_URI}?code=`)), 10_000);
    const back = readCallback(navigations.find((u) => u.startsWith(`${REDIRECT_URI}?code=`))!, { state: p.state, issuer: origin });
    assert.equal(back.kind, "code");
    const exchanged = await fetch(`${origin}/api/connect/token`, { method: "POST", headers: { "content-type": "application/json", origin: "capacitor://localhost" },
      body: JSON.stringify({ client: "mobile", code: (back as { code: string }).code, codeVerifier: p.verifier, redirectUri: REDIRECT_URI }) });
    assert.equal(exchanged.status, 200);
    const token = ((await exchanged.json()) as { token: string }).token;
    const asApp = (method: string, pathname: string, body?: unknown) => fetch(`${origin}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, origin: "capacitor://localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const me = await (await asApp("GET", "/api/session")).json() as { state: string; account: { displayName: string; hasPassword: boolean; linkedProviders: { id: string }[] } };
    assert.deepEqual([me.state, me.account.displayName, me.account.hasPassword, me.account.linkedProviders.map((x) => x.id)], ["signed_in", "Pat", false, ["google"]]);
    step("the app's Continue with Google ran in the system browser: sign-up, approval, purss://connect, token — a signed-in provider-only account");

    // ---- the app confirms it's it with Google: the system browser changes nothing, the code it sends back to the app does
    makeStale();
    const security0 = await (await asApp("GET", "/api/account/security")).json() as { recentAuth: boolean };
    assert.equal(security0.recentAuth, false);
    const confirm = await pkce();
    const confirmTicket = await (await asApp("POST", "/api/auth/oidc/google/ticket", { purpose: "stepup", codeChallenge: confirm.challenge, state: confirm.state })).json() as { url: string };
    const systemBrowser = await newPage({ width: 412, height: 915 });
    await systemBrowser.goto(confirmTicket.url);
    const backToApp = systemBrowser.getByRole("link", { name: "Go back to the PURSS app" });
    await backToApp.waitFor();
    await systemBrowser.screenshot({ path: path.join(shots, "07-app-confirm-page.png") });
    assert.equal(((await (await asApp("GET", "/api/account/security")).json()) as { recentAuth: boolean }).recentAuth, false, "whoever finished it in the browser confirmed nothing");
    const confirmed = readAppCode((await backToApp.getAttribute("href"))!, "confirm", { state: confirm.state, issuer: origin });
    assert.equal(confirmed.kind, "code");
    const redeemConfirm = (code: string, verifier: string) => asApp("POST", "/api/auth/oidc/google/confirm", { code, codeVerifier: verifier });
    assert.equal((await redeemConfirm((confirmed as { code: string }).code, (await pkce()).verifier)).status, 400, "not without the app's own verifier");
    assert.equal((await redeemConfirm((confirmed as { code: string }).code, confirm.verifier)).status, 400, "and that attempt spent the code");
    assert.equal(((await (await asApp("GET", "/api/account/security")).json()) as { recentAuth: boolean }).recentAuth, false);
    const spent = await systemBrowser.goto(confirmTicket.url);
    assert.equal(spent?.status(), 400, "a ticket works once");
    // Again, and this time the app redeems what the browser sent with its verifier.
    const second = await pkce();
    const secondTicket = await (await asApp("POST", "/api/auth/oidc/google/ticket", { purpose: "stepup", codeChallenge: second.challenge, state: second.state })).json() as { url: string };
    await systemBrowser.goto(secondTicket.url);
    const second2 = readAppCode((await systemBrowser.getByRole("link", { name: "Go back to the PURSS app" }).getAttribute("href"))!, "confirm", { state: second.state, issuer: origin });
    assert.equal(second2.kind, "code");
    assert.equal((await redeemConfirm((second2 as { code: string }).code, second.verifier)).status, 200);
    assert.equal(((await (await asApp("GET", "/api/account/security")).json()) as { recentAuth: boolean }).recentAuth, true, "the app that asked is confirmed");
    step("the app's connection was confirmed only by redeeming the browser's code with its own verifier");

    // ---- the app asks for its address after a refusal: a plain page that leads back to the app
    const refusedApp = await newPage({ width: 412, height: 915 });
    const again = await pkce();
    claims = { sub: "google-dana-refused", email: "dana@example.org", email_verified: true, name: "Dana Refused" };
    await refusedApp.goto(providerStartUrl(providers[0]!.start, infoRes.connect.page, { challenge: again.challenge, state: again.state, deviceName: "Pixel 8" }));
    await refusedApp.getByRole("heading", { name: "That didn't work" }).waitFor();
    await refusedApp.getByText("An account with this email address already exists.").waitFor();
    await refusedApp.getByText("Go back to the PURSS app").waitFor();
    await refusedApp.screenshot({ path: path.join(shots, "08-app-refused.png") });
    step("a refusal in the app's browser is a plain page that says why and leads back to the app");

    // ---- the app links Google: whoever signs in in the browser links nothing; the app redeems the code that came back
    const signedIn = await fetch(`${origin}/api/connect/signin`, { method: "POST", headers: { "content-type": "application/json", origin: "capacitor://localhost" },
      body: JSON.stringify({ method: "password", username: "dana", password: TEST_PASSWORD, client: "mobile", deviceName: "Dana's phone" }) });
    assert.equal(signedIn.status, 200);
    const danaToken = ((await signedIn.json()) as { token: string }).token;
    const asDana = (method: string, pathname: string, body?: unknown) => fetch(`${origin}${pathname}`, {
      method, headers: { authorization: `Bearer ${danaToken}`, origin: "capacitor://localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const link = await pkce();
    const linkTicket = await (await asDana("POST", "/api/auth/oidc/google/ticket", { purpose: "link", codeChallenge: link.challenge, state: link.state })).json() as { url: string };
    claims = { sub: "google-dana-work", email: "dana.work@example.org", email_verified: true, name: "Dana Work" };
    const linkBrowser = await newPage({ width: 412, height: 915 });
    await linkBrowser.goto(linkTicket.url);
    const goBack = linkBrowser.getByRole("link", { name: "Go back to the PURSS app" });
    await goBack.waitFor();
    await linkBrowser.screenshot({ path: path.join(shots, "09-app-link-page.png") });
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'google-dana-work'"), 0, "the browser linked nothing");
    const handed = readAppCode((await goBack.getAttribute("href"))!, "link", { state: link.state, issuer: origin });
    assert.equal(handed.kind, "code");
    const wrong = await asDana("POST", "/api/auth/oidc/google/link", { code: (handed as { code: string }).code, codeVerifier: (await pkce()).verifier });
    assert.equal(wrong.status, 400, "not without the app's own verifier");
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'google-dana-work'"), 0);
    // The wrong try spent the code: the app starts again, and this time redeems with its verifier.
    const retry = await pkce();
    const retryTicket = await (await asDana("POST", "/api/auth/oidc/google/ticket", { purpose: "link", codeChallenge: retry.challenge, state: retry.state })).json() as { url: string };
    await linkBrowser.goto(retryTicket.url);
    const code = readAppCode((await linkBrowser.getByRole("link", { name: "Go back to the PURSS app" }).getAttribute("href"))!, "link", { state: retry.state, issuer: origin });
    assert.equal(code.kind, "code");
    const redeemed = await asDana("POST", "/api/auth/oidc/google/link", { code: (code as { code: string }).code, codeVerifier: retry.verifier });
    assert.equal(redeemed.status, 200);
    assert.equal(count("SELECT COUNT(*) n FROM sign_in_methods WHERE kind = 'oidc' AND subject = 'google-dana-work'"), 1);
    step("the app linked Google: the browser's half linked nothing, and only the app's code and verifier did");

    assert.deepEqual(errors, [], "no uncaught page errors");
    assert.deepEqual(outside, [], "nothing loaded from outside PURSS and the issuer");
  } catch (err) {
    const shot = path.join(os.tmpdir(), "purss-google-failure.png");
    await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

const sink = await startSmtpSink();
const google = new OAuth2Server();
await google.issuer.keys.generate("RS256");
google.service.on("beforeTokenSigning", (token) => { Object.assign(token.payload, claims); });
await google.start(0, "127.0.0.1");
try {
  await main(sink.port, google);
  console.log("\nGoogle sign-in journey passed.");
} catch (err) {
  console.error("\nGoogle sign-in journey FAILED:", err instanceof Error ? err.message : err);
  console.error(apiLog.slice(-1500));
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  await google.stop();
  await sink.close();
  rmSync(work, { recursive: true, force: true });
}
