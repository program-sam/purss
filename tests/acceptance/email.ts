// Acceptance journey for account email on a hosted installation, against the real API serving the built
// web app and a local SMTP server (no FreshRSS, worker or network): open sign-up waits for working email,
// a new person signs up with an address and a password, confirms the address from the email, forgets the
// password, gets a reset link by email, chooses a new password, is signed out elsewhere, and signs in
// with the new one. Run: node tests/acceptance/email.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { startSmtpSink, textOf, type SmtpSink } from "../../apps/api/src/mail/testing.ts";
import { testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-email-"));
const dataDir = path.join(work, "data");
const PORT = 19980;
const origin = `http://localhost:${PORT}`;
const step = (s: string) => console.log(`✓ ${s}`);

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
const linkIn = (sink: SmtpSink, n: number, pathname: string) => {
  const m = new RegExp(`${origin}${pathname}\\?token=[\\w%-]+`).exec(textOf(sink.received[n]!));
  assert.ok(m, `a ${pathname} link in message ${n}`);
  return m[0];
};

let currentPage: Page | null = null;

async function main(sink: SmtpSink): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  const env: NodeJS.ProcessEnv = {
    ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: "19988", PURSS_PUBLIC_ORIGIN: origin,
    PURSS_WEB_DIST: path.join(repo, "apps/web/dist"), PURSS_DISK_RESERVE_BYTES: "0", PURSS_MODE: "hosted", PURSS_SIGNUP: "open",
    PURSS_SMTP_HOST: "127.0.0.1", PURSS_SMTP_PORT: String(sink.port), PURSS_SMTP_SECURITY: "none", PURSS_MAIL_FROM: "PURSS <ws@example.org>",
  };
  // The operator's own account exists; the journey is about a stranger signing up.
  const app = createApp(loadConfig(env));
  try { claim(app, ensureClaimCode(app)!, "Operator", testPassword("operator")); } finally { app.db.close(); }
  startApi(env);
  await waitFor("open sign-up, once the mail server check passes", async () => (await (await fetch(`${origin}/api/session`)).json()).installation.signup === "open", 30_000);
  assert.match(apiLog, /outgoing email works/);
  step("open sign-up opened only after the mail server answered");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    currentPage = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${origin}/app/signin`);
    await page.getByRole("link", { name: "create an account" }).click();
    await page.getByLabel("Email address").fill("robin@example.org");
    await page.getByLabel("Display name (optional)").fill("Robin");
    await page.getByRole("textbox", { name: "Username" }).fill("robin");
    await page.getByLabel("Password", { exact: true }).fill("tidal flats at low water");
    await page.getByLabel("Password again").fill("tidal flats at low water");
    await page.getByRole("button", { name: "Continue" }).click();
    // Where the browser supports passkeys the account offers one; this journey is about the password.
    const skipPasskey = page.getByRole("button", { name: "Skip for now" });
    const addSource = page.getByRole("button", { name: "Add source" }).first();
    await skipPasskey.or(addSource).waitFor();
    if (await skipPasskey.isVisible()) await skipPasskey.click();
    await addSource.waitFor();
    step("signed up with an email address and a password");

    await waitFor("the confirmation email", async () => sink.received.length >= 1, 15_000);
    assert.deepEqual(sink.received[0]!.to, ["<robin@example.org>"]);
    assert.match(sink.received[0]!.data, /^Subject: Confirm your email address/m);
    await page.goto(linkIn(sink, 0, "/app/verify-email"));
    await page.getByText("Your email address is confirmed.").waitFor();
    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByText("robin@example.org").waitFor();
    await page.getByText("confirmed", { exact: false }).first().waitFor();
    step("the link in the email confirmed the address, and Settings → Security shows it");

    // Elsewhere, signed out, the password is forgotten.
    const other = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const phone = await other.newPage();
    currentPage = phone;
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${origin}/app/signin`);
    await phone.getByRole("link", { name: "Reset your password by email" }).click();
    await phone.getByLabel("Username or email address").fill("someone-else");
    await phone.getByRole("button", { name: "Send a link" }).click();
    await phone.getByText("If that account has a confirmed email, we").waitFor();
    await phone.goto(`${origin}/app/reset-password`);
    await phone.getByLabel("Username or email address").fill("Robin@Example.org");
    await phone.getByRole("button", { name: "Send a link" }).click();
    await phone.getByText("If that account has a confirmed email, we").waitFor();
    await waitFor("the reset email", async () => sink.received.length >= 2, 15_000);
    assert.equal(sink.received.length, 2, "an unknown username got nothing, and the same answer");
    assert.match(sink.received[1]!.data, /^Subject: Reset your password/m);
    assert.match(textOf(sink.received[1]!), /username robin\b/);
    await phone.goto(linkIn(sink, 1, "/app/reset-password"));
    await phone.getByLabel("New password", { exact: true }).fill("salt marsh in winter light");
    await phone.getByLabel("New password again").fill("salt marsh in winter light");
    await phone.getByRole("button", { name: "Save new password" }).click();
    await phone.getByText("Your password is changed.").waitFor();
    await waitFor("the password-changed notice", async () => sink.received.length >= 3, 15_000);
    assert.match(sink.received[2]!.data, /^Subject: Your password was changed/m);
    step("a reset link by email set a new password, and the address was told");

    await page.reload();
    await page.waitForURL(/\/signin/);
    step("the browser signed in before the reset was signed out");

    await phone.getByRole("link", { name: "Sign in" }).click();
    await phone.getByRole("textbox", { name: "Username" }).fill("robin");
    await phone.getByLabel("Password", { exact: true }).fill("tidal flats at low water");
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await phone.getByText("That username and password don't match.").waitFor();
    await phone.getByLabel("Password", { exact: true }).fill("salt marsh in winter light");
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await phone.getByRole("button", { name: "Add source" }).first().waitFor();
    step("the old password no longer works; the new one does");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    const shot = path.join(os.tmpdir(), "purss-email-failure.png");
    await currentPage?.screenshot({ path: shot, fullPage: true }).then(() => console.error(`Screenshot: ${shot}`), () => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

const sink = await startSmtpSink();
try {
  await main(sink);
  console.log("\nEmail journey passed.");
} catch (err) {
  console.error("\nEmail journey FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopApi();
  await sink.close();
  rmSync(work, { recursive: true, force: true });
}
