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
import { app as copy } from "@purss/translations/app";
import { server } from "@purss/translations/server";
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

// The words the page and the emails show come from the translation files, so rewording one never breaks this journey.
const auth = copy.auth;
const mails = server.api.mailTemplates;
const question = copy.dialogs.firstVisitQuestion;
const notifications = copy.dialogs.notificationSettings;
const never = copy.lib.returning.frequency.off;
const emailSection = auth.accountEmailSection;
/** Catalogue text as a regular expression source; a run of spaces matches any whitespace, as the page shows it. */
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
/** A catalogue message with its one value, which the journey does not care about, left open. */
const withAny = (message: (value: string) => string) => message("\u0000").split("\u0000").map(esc).join(".*");
/** The Subject line of a message, whatever product name it carries. */
const subjectLine = (subject: string) => new RegExp(`^Subject: ${subject}`, "m");
/** The sidebar's Add source button, or the tab bar's on a phone. */
const ADD_SOURCE = new RegExp(`${esc(copy.words.addSource)}|${esc(copy.words.addSource)}`);

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
  const first = page.getByRole("dialog", { name: question.title });
  const later = page.getByRole("button", { name: copy.words.notNow });
  const add = page.getByRole("button", { name: ADD_SOURCE }).first();
  await later.or(add).first().waitFor();
  if (await later.isVisible()) {
    const share = first.getByRole("checkbox", { name: new RegExp(esc(copy.words.shareMySources)) });
    assert.equal(await share.isChecked(), true, "sharing starts checked on the hosted first question");
    await first.getByText(copy.words.purssCountsSourcesFollowedByPeople, { exact: true }).waitFor();
    await first.getByRole("radio", { name: new RegExp(`^${esc(never.label)}`) }).check();
    await first.getByText(question.digestOff, { exact: true }).waitFor();
    await share.uncheck();
    await later.click();
    await first.waitFor({ state: "hidden" });
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
  // The administrator's own account exists; the journey is about a stranger signing up.
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
    await page.getByRole("link", { name: copy.words.createAnAccount }).click();
    await page.getByLabel(copy.words.emailAddress).fill("robin@example.org");
    await page.getByRole("button", { name: copy.words.sendMeTheLink }).click();
    await page.getByText(new RegExp(withAny(auth.signup.sentTo))).waitFor();
    const signupMail = await mailTo(sink, "robin@example.org", subjectLine(withAny(mails.signupSubject)));
    assert.equal(sentTo(sink, "robin@example.org").length, 1, "only the sign-up link was sent to the address");
    step("an address alone gets a link, and no account is made yet");

    await page.goto(linkIn(signupMail, "/app/signup"));
    const address = page.getByLabel(copy.words.emailAddress);
    assert.equal(await address.inputValue(), "robin@example.org", "the page shows the address the link is for");
    assert.equal(await address.isEditable(), false, "and it can't be changed there");
    await page.getByLabel(copy.words.displayNameOptional).fill("Robin");
    await page.getByLabel(copy.words.password, { exact: true }).fill("tidal flats at low water");
    await page.getByLabel(auth.passwordForm.passwordAgain).fill("tidal flats at low water");
    await page.getByRole("button", { name: auth.signup.create }).click();
    // Where the browser supports passkeys the account offers one; this journey is about the password.
    const skipPasskey = page.getByRole("button", { name: auth.passkeyStep.skip });
    const addSource = page.getByRole("button", { name: ADD_SOURCE }).first();
    await skipPasskey.or(addSource).waitFor();
    if (await skipPasskey.isVisible()) await skipPasskey.click();
    await dismissFirstVisit(page);
    step("the link finished the account with a password, and Home opened");

    await page.goto(`${origin}/app/?dialog=settings`);
    const notificationSettings = page.getByRole("dialog", { name: copy.words.settings });
    await notificationSettings.waitFor();
    await notificationSettings.getByRole("button", { name: copy.dialogs.settings.dialog.tabs.notifications }).click();
    const neverRadio = notificationSettings.getByRole("radio", { name: new RegExp(esc(never.label)) });
    // The choice shows once it is saved, so click and wait for it rather than expecting the radio to flip at once.
    if (!await neverRadio.isChecked()) await neverRadio.click();
    await waitFor("Never chosen", async () => await neverRadio.isChecked(), 10_000);
    await notificationSettings.getByText(never.blurb, { exact: true }).waitFor();
    await waitFor("Never setting", async () => await page.evaluate(async () => (await (await fetch("/api/preferences")).json()).notifications.frequency === "off"), 5000);
    for (const label of [notifications.reminders, notifications.problems, notifications.captures].map((text) => new RegExp(`^${esc(text)}`))) {
      assert.equal(await notificationSettings.getByRole("checkbox", { name: label }).isEnabled(), true, `${label} stays available under Never`);
    }
    const emailReminders = notificationSettings.getByRole("checkbox", { name: new RegExp(`^${esc(notifications.emailReminders)}`) });
    await emailReminders.waitFor();
    // Like Never above: the box shows ticked once the change is saved, so click and wait for it.
    if (!await emailReminders.isChecked()) await emailReminders.click();
    await waitFor("Email me reminders ticked", async () => await emailReminders.isChecked(), 10_000);
    await waitFor("reminder email enabled under Never", async () => await page.evaluate(async () => {
      const n = (await (await fetch("/api/preferences")).json()).notifications;
      return n.frequency === "off" && n.emailReminders === true;
    }), 5000);
    step("Never leaves reminder, source-problem and saved-text controls enabled, including reminder email");

    // The administrator account is hosted too. Saving the unticked choice changes its preference.
    const operatorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const operatorPage = await operatorContext.newPage();
      currentPage = operatorPage;
      await operatorPage.goto(`${origin}/app/signin`);
      await operatorPage.getByRole("textbox", { name: copy.words.emailAddress }).fill("operator@example.test");
      await operatorPage.getByLabel(copy.words.password, { exact: true }).fill(TEST_PASSWORD);
      await operatorPage.getByRole("button", { name: copy.words.signIn, exact: true }).click();
      const first = operatorPage.getByRole("dialog", { name: question.title });
      const share = first.getByRole("checkbox", { name: new RegExp(esc(copy.words.shareMySources)) });
      await share.waitFor();
      assert.equal(await share.isChecked(), true, "the hosted choice is checked before saving");
      await share.uncheck();
      await first.getByRole("button", { name: copy.words.save, exact: true }).click();
      await first.waitFor({ state: "hidden" });
      const prefs = await operatorPage.evaluate(async () => (await (await fetch("/api/preferences")).json()).discoveryShare as boolean);
      assert.equal(prefs, false, "Save persists the unticked choice");
      step("the hosted first question explains anonymous source sharing; Not now preserves the default, Save keeps an opt-out");
    } finally { await operatorContext.close(); }
    currentPage = page;

    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByText("robin@example.org").first().waitFor();
    await page.getByText(emailSection.addressStatus(true).trim()).first().waitFor();
    assert.equal(sentTo(sink, "robin@example.org").length, 1, "the address was confirmed by the sign-up link; no second message");
    step("Settings → Security shows the address as confirmed, with no confirmation email");

    // A new address takes over only once its link is used; the current one signs in until then.
    await page.getByRole("button", { name: emailSection.changeAddress }).click();
    await page.getByLabel(emailSection.newAddress.label).fill("robin@example.net");
    await page.getByRole("button", { name: copy.words.save, exact: true }).click();
    await page.getByText(emailSection.waitingToConfirm("robin@example.net", "robin@example.org")).waitFor();
    const verifyMail = await mailTo(sink, "robin@example.net", subjectLine(esc(mails.confirmSubject)));
    await page.goto(linkIn(verifyMail, "/app/verify-email"));
    await page.getByText(auth.emailLinks.verify.confirmed).waitFor();
    await page.goto(`${origin}/app/?dialog=security`);
    await page.getByText("robin@example.net").first().waitFor();
    await mailTo(sink, "robin@example.org", subjectLine(esc(mails.emailChangedSubject)));
    step("a new address waited for its link, then replaced the old one, which was told");

    // Elsewhere, signed out: the spent sign-up link says so and offers a fresh start.
    const other = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const phone = await other.newPage();
    currentPage = phone;
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(linkIn(signupMail, "/app/signup"));
    await phone.getByText(server.api.signup.linkSpent).waitFor();
    await phone.getByRole("link", { name: copy.words.startAgain }).click();
    // An address that already has an account gets the same page, and an email that says so.
    await phone.getByLabel(copy.words.emailAddress).fill("Robin@Example.net");
    await phone.getByRole("button", { name: copy.words.sendMeTheLink }).click();
    await phone.getByText(new RegExp(withAny(auth.signup.sentTo))).waitFor();
    // The mail server is told the address as typed, but for the case of its domain.
    const exists = await mailTo(sink, "Robin@example.net", subjectLine(withAny(mails.existsSubject)));
    assert.doesNotMatch(textOf(exists), /token=/, "no sign-up link was sent for an address that has an account");
    step("signing up again with an address that has an account looks the same, and the email says it has one");

    // The password is forgotten.
    await phone.goto(`${origin}/app/signin`);
    await phone.getByRole("link", { name: auth.signIn.reset.link }).click();
    await phone.getByLabel(copy.words.emailAddress).fill("someone-else@example.org");
    await phone.getByRole("button", { name: auth.emailLinks.reset.sendLink }).click();
    await phone.getByText(auth.emailLinks.reset.sent).waitFor();
    await phone.goto(`${origin}/app/reset-password`);
    await phone.getByLabel(copy.words.emailAddress).fill("Robin@Example.net");
    await phone.getByRole("button", { name: auth.emailLinks.reset.sendLink }).click();
    await phone.getByText(auth.emailLinks.reset.sent).waitFor();
    const reset = await mailTo(sink, "robin@example.net", subjectLine(esc(server.words.resetYourPassword)));
    assert.equal(sentTo(sink, "someone-else@example.org").length, 0, "an unknown address got nothing, and the same answer");
    assert.match(textOf(reset), new RegExp(withAny(mails.resetIntro)));
    await phone.goto(linkIn(reset, "/app/reset-password"));
    await phone.getByLabel(copy.words.newPassword, { exact: true }).fill("salt marsh in winter light");
    await phone.getByLabel(copy.words.newPasswordAgain).fill("salt marsh in winter light");
    await phone.getByRole("button", { name: copy.words.saveNewPassword }).click();
    await phone.getByText(auth.emailLinks.reset.changed).waitFor();
    await mailTo(sink, "robin@example.net", subjectLine(esc(mails.changedSubject)));
    step("a reset link by email set a new password, and the address was told");

    await page.reload();
    await page.waitForURL(/\/signin/);
    step("the browser signed in before the reset was signed out");

    await phone.getByRole("link", { name: copy.words.signIn }).click();
    await phone.getByRole("textbox", { name: copy.words.emailAddress }).fill("robin@example.net");
    await phone.getByLabel(copy.words.password, { exact: true }).fill("tidal flats at low water");
    await phone.getByRole("button", { name: copy.words.signIn, exact: true }).click();
    await phone.getByText(server.api.shared.badPassword).waitFor();
    await phone.getByLabel(copy.words.password, { exact: true }).fill("salt marsh in winter light");
    await phone.getByRole("button", { name: copy.words.signIn, exact: true }).click();
    await phone.getByRole("button", { name: ADD_SOURCE }).first().waitFor();
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
