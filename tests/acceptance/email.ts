// Acceptance journey for account email on a hosted installation, against the real API serving the built
// web app and a local SMTP server (no FreshRSS, worker or network): open sign-up waits for working email,
// a new person gives an address, finishes the account from the link in the email (the address is confirmed
// by it) with a password, changes the address (the new one takes over once its link is used), finds that a
// second sign-up with that address gets the same page and an email saying it has an account, forgets the
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
import { startSmtpSink, textOf, type Received, type SmtpSink } from "../../apps/api/src/mail/testing.ts";
import { TEST_PASSWORD, testPassword } from "../../apps/api/src/testing.ts";

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
const linkIn = (message: Received, pathname: string) => {
  const m = new RegExp(`${origin}${pathname}\\?token=[\\w%-]+`).exec(textOf(message));
  assert.ok(m, `a ${pathname} link in the message "${/^Subject: (.*)$/m.exec(message.data)?.[1]}"`);
  return m[0];
};
const sentTo = (sink: SmtpSink, to: string) => sink.received.filter((m) => m.to.includes(`<${to}>`));
/** The nth message with this subject sent to this address, once it has arrived. */
async function mailTo(sink: SmtpSink, to: string, subject: RegExp, nth = 0): Promise<Received> {
  let found: Received | undefined;
  const seen = () => sink.received.map((m) => `${m.to.join(",")}: ${/^Subject: (.*)$/m.exec(m.data)?.[1]}`).join("; ");
  await waitFor(`${subject} to ${to} (the mail server got: ${seen()})`, async () => { found = sink.received.filter((m) => m.to.includes(`<${to}>`) && subject.test(m.data))[nth]; return !!found; }, 15_000);
  return found!;
}

/** A new account is asked once how it wants to be told about new things; this journey is about something else. */
async function dismissFirstVisit(page: Page): Promise<void> {
  const question = page.getByRole("dialog", { name: "How often do you want to hear about new items?" });
  const later = page.getByRole("button", { name: "Not now" });
  const add = page.getByRole("button", { name: "Add source" }).first();
  await later.or(add).first().waitFor();
  if (await later.isVisible()) {
    const share = question.getByRole("checkbox", { name: /Share my sources/ });
    assert.equal(await share.isChecked(), true, "sharing starts checked on the hosted first question");
    await question.getByText("PURSS counts sources followed by people who share, anonymously, to suggest sources followed by people with similar taste. Other people can't see your list, and private sources never count.", { exact: true }).waitFor();
    await question.getByRole("radio", { name: /^Never/ }).check();
    await question.getByText("No digest. Sources set to “Notify me”, reminders and problem notices still show in the bell. Add browser alerts in Settings.", { exact: true }).waitFor();
    await share.uncheck();
    await later.click();
    await question.waitFor({ state: "hidden" });
    const prefs = await page.evaluate(async () => (await (await fetch("/api/preferences")).json()).discoveryShare as boolean);
    assert.equal(prefs, true, "Not now leaves the default sharing preference unchanged");
  }
  await add.waitFor();
}

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
  try { claim(app, ensureClaimCode(app)!, "operator@example.test", "Operator", testPassword()); } finally { app.db.close(); }
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

    // Sign-up starts with the address alone; the account is made when the link in the email is used.
    await page.goto(`${origin}/app/signin`);
    await page.getByRole("link", { name: "create an account" }).click();
    await page.getByLabel("Email address").fill("robin@example.org");
    await page.getByRole("button", { name: "Send me the link" }).click();
    await page.getByText("Check your inbox: we sent a link to finish creating your account").waitFor();
    const signupMail = await mailTo(sink, "robin@example.org", /^Subject: Finish creating your .* account/m);
    assert.equal(sentTo(sink, "robin@example.org").length, 1, "only the sign-up link was sent to the address");
    step("an address alone gets a link, and no account is made yet");

    await page.goto(linkIn(signupMail, "/app/signup"));
    const address = page.getByLabel("Email address");
    assert.equal(await address.inputValue(), "robin@example.org", "the page shows the address the link is for");
    assert.equal(await address.isEditable(), false, "and it can't be changed there");
    await page.getByLabel("Display name (optional)").fill("Robin");
    await page.getByLabel("Password", { exact: true }).fill("tidal flats at low water");
    await page.getByLabel("Password again").fill("tidal flats at low water");
    await page.getByRole("button", { name: "Create my account" }).click();
    // Where the browser supports passkeys the account offers one; this journey is about the password.
    const skipPasskey = page.getByRole("button", { name: "Skip for now" });
    const addSource = page.getByRole("button", { name: "Add source" }).first();
    await skipPasskey.or(addSource).waitFor();
    if (await skipPasskey.isVisible()) await skipPasskey.click();
    await dismissFirstVisit(page);
    step("the link finished the account with a password, and Home opened");

    await page.goto(`${origin}/app/?dialog=settings`);
    const notificationSettings = page.getByRole("dialog", { name: "Settings" });
    await notificationSettings.waitFor();
    await notificationSettings.getByRole("button", { name: "Notifications and New" }).click();
    const never = notificationSettings.getByRole("radio", { name: /Never/ });
    // The choice shows once it is saved, so click and wait for it rather than expecting the radio to flip at once.
    if (!await never.isChecked()) await never.click();
    await waitFor("Never chosen", async () => await never.isChecked(), 10_000);
    await notificationSettings.getByText("No digest. Sources you set to “Notify me”, your reminders and news of a source that stops working still tell you.", { exact: true }).waitFor();
    await waitFor("Never setting", async () => await page.evaluate(async () => (await (await fetch("/api/preferences")).json()).notifications.frequency === "off"), 5000);
    for (const label of [/^Reminders/, /^Sources that stop working/, /^Readable text that failed to save/]) {
      assert.equal(await notificationSettings.getByRole("checkbox", { name: label }).isEnabled(), true, `${label} stays available under Never`);
    }
    const emailReminders = notificationSettings.getByRole("checkbox", { name: /^Email me reminders/ });
    await emailReminders.waitFor();
    // Like Never above: the box shows ticked once the change is saved, so click and wait for it.
    if (!await emailReminders.isChecked()) await emailReminders.click();
    await waitFor("Email me reminders ticked", async () => await emailReminders.isChecked(), 10_000);
    await waitFor("reminder email enabled under Never", async () => await page.evaluate(async () => {
      const n = (await (await fetch("/api/preferences")).json()).notifications;
      return n.frequency === "off" && n.emailReminders === true;
    }), 5000);
    step("Never leaves reminder, source-problem and saved-text controls enabled, including reminder email");

    // The operator account is hosted too. Saving the unticked choice changes its preference.
    const operatorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const operatorPage = await operatorContext.newPage();
      currentPage = operatorPage;
      await operatorPage.goto(`${origin}/app/signin`);
      await operatorPage.getByRole("textbox", { name: "Email address" }).fill("operator@example.test");
      await operatorPage.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
      await operatorPage.getByRole("button", { name: "Sign in", exact: true }).click();
      const question = operatorPage.getByRole("dialog", { name: "How often do you want to hear about new items?" });
      const share = question.getByRole("checkbox", { name: /Share my sources/ });
      await share.waitFor();
      assert.equal(await share.isChecked(), true, "the hosted choice is checked before saving");
      await share.uncheck();
      await question.getByRole("button", { name: "Save", exact: true }).click();
      await question.waitFor({ state: "hidden" });
      const prefs = await operatorPage.evaluate(async () => (await (await fetch("/api/preferences")).json()).discoveryShare as boolean);
      assert.equal(prefs, false, "Save persists the unticked choice");
      step("the hosted first question explains anonymous source sharing; Not now preserves the default, Save keeps an opt-out");
    } finally { await operatorContext.close(); }
    currentPage = page;

    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByText("robin@example.org").first().waitFor();
    await page.getByText("confirmed", { exact: false }).first().waitFor();
    assert.equal(sentTo(sink, "robin@example.org").length, 1, "the address was confirmed by the sign-up link; no second message");
    step("Settings → Security shows the address as confirmed, with no confirmation email");

    // A new address takes over only once its link is used; the current one signs in until then.
    await page.getByRole("button", { name: "Change address" }).click();
    await page.getByLabel("New email address").fill("robin@example.net");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Waiting for you to confirm robin@example.net. You still sign in with robin@example.org until then.").waitFor();
    const verifyMail = await mailTo(sink, "robin@example.net", /^Subject: Confirm your email address/m);
    await page.goto(linkIn(verifyMail, "/app/verify-email"));
    await page.getByText("Your email address is confirmed.").waitFor();
    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByText("robin@example.net").first().waitFor();
    await mailTo(sink, "robin@example.org", /^Subject: Your email address was changed/m);
    step("a new address waited for its link, then replaced the old one, which was told");

    // Elsewhere, signed out: the spent sign-up link says so and offers a fresh start.
    const other = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const phone = await other.newPage();
    currentPage = phone;
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(linkIn(signupMail, "/app/signup"));
    await phone.getByText("That link has expired or was already used.").waitFor();
    await phone.getByRole("link", { name: "Start again" }).click();
    // An address that already has an account gets the same page, and an email that says so.
    await phone.getByLabel("Email address").fill("Robin@Example.net");
    await phone.getByRole("button", { name: "Send me the link" }).click();
    await phone.getByText("Check your inbox: we sent a link to finish creating your account").waitFor();
    // The mail server is told the address as typed, but for the case of its domain.
    const exists = await mailTo(sink, "Robin@example.net", /^Subject: You already have a .* account/m);
    assert.doesNotMatch(textOf(exists), /token=/, "no sign-up link was sent for an address that has an account");
    step("signing up again with an address that has an account looks the same, and the email says it has one");

    // The password is forgotten.
    await phone.goto(`${origin}/app/signin`);
    await phone.getByRole("link", { name: "Reset your password by email" }).click();
    await phone.getByLabel("Email address").fill("someone-else@example.org");
    await phone.getByRole("button", { name: "Send a link" }).click();
    await phone.getByText("If that email address has an account, we").waitFor();
    await phone.goto(`${origin}/app/reset-password`);
    await phone.getByLabel("Email address").fill("Robin@Example.net");
    await phone.getByRole("button", { name: "Send a link" }).click();
    await phone.getByText("If that email address has an account, we").waitFor();
    const reset = await mailTo(sink, "robin@example.net", /^Subject: Reset your password/m);
    assert.equal(sentTo(sink, "someone-else@example.org").length, 0, "an unknown address got nothing, and the same answer");
    assert.match(textOf(reset), /account with this email address/);
    await phone.goto(linkIn(reset, "/app/reset-password"));
    await phone.getByLabel("New password", { exact: true }).fill("salt marsh in winter light");
    await phone.getByLabel("New password again").fill("salt marsh in winter light");
    await phone.getByRole("button", { name: "Save new password" }).click();
    await phone.getByText("Your password is changed.").waitFor();
    await mailTo(sink, "robin@example.net", /^Subject: Your password was changed/m);
    step("a reset link by email set a new password, and the address was told");

    await page.reload();
    await page.waitForURL(/\/signin/);
    step("the browser signed in before the reset was signed out");

    await phone.getByRole("link", { name: "Sign in" }).click();
    await phone.getByRole("textbox", { name: "Email address" }).fill("robin@example.net");
    await phone.getByLabel("Password", { exact: true }).fill("tidal flats at low water");
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await phone.getByText("That email address and password don't match.").waitFor();
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
