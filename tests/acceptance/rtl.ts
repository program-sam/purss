// Acceptance journey for right-to-left and mixed-direction text, against the real API serving the built web app (no FreshRSS,
// egress or worker: no podman and no network). A person whose display name starts in Arabic follows Arabic and mixed-script
// sources in one collection. Checked in the real page: the source names on Home's collection box keep their order with each separator
// right after the name before it; the Front page lays a New Arabic headline out right to left (the screen-reader "New." is not what
// decides its direction); a podcast's notes whose publisher joined every word with a no-break space wrap at spaces, so no word is
// cut in half; and the phone's top bar reads the name in its own direction, so the Arabic start of it shows.
// Run: node tests/acceptance/rtl.ts (after npm run build)
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode } from "../../apps/api/src/auth/accounts.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/main.ts";
import { createCollection } from "../../apps/api/src/services/collections.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { TEST_PASSWORD, batch, entry, makeSource, testPassword } from "../../apps/api/src/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-rtl-"));
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
  ...process.env, PURSS_DATA_DIR: dataDir, PURSS_PORT: String(PORT), PURSS_INTERNAL_PORT: String(await freePort()), PURSS_PUBLIC_ORIGIN: origin, PURSS_WEB_DIST: webDist, PURSS_DISK_RESERVE_BYTES: "0",
};
const EMAIL = "dalia@example.test";
const NAME = "داليا Dalia Lekhal";
const step = (s: string) => console.log(`✓ ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What some publishers send: every word of a paragraph joined to the next with a no-break space. */
const joined = (text: string) => text.replaceAll(" ", "&nbsp;");
const EPISODE = "الإجهاض وأحاديث مؤجلة - سلام";
const SOURCES = ["Raseef22 - عربي", "Almodon - All", "BBC Arabic", "Eib | عيب", "حبر"];

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

function prepare(): void {
  const app = createApp(loadConfig({ ...env, PURSS_DATA_DIR: dataDir } as Record<string, string>));
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId } = claim(app, code, EMAIL, NAME, testPassword());
    const ws = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!.id;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu);
    const p: Principal & { engineUserId: string } = { accountId, workspaceId: ws, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString(), engineUserId: eu };
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const ids = SOURCES.map((title, i) => makeSource(app, p, title, `feed/${i + 1}`));
    applySyncBatch(app, eu, batch([
      entry("feed/1", { title: "ما بعد الحرب: أسئلة اللجوء", summaryHtml: "<p>مقال عن اللجوء.</p>", publishedAt: at(10), crawledAt: at(9) }),
      entry("feed/2", { title: "مقال عن الاقتصاد", summaryHtml: "<p>ملخص.</p>", publishedAt: at(20), crawledAt: at(19) }),
      entry("feed/3", { title: "\"كل ما درسته كان بلا جدوى\" : كيف يغير الذكاء الاصطناعي مساراتنا المهنية؟", summaryHtml: "<p>ملخص.</p>", publishedAt: at(5), crawledAt: at(4) }),
      entry("feed/4", {
        title: EPISODE, publishedAt: at(30), crawledAt: at(29),
        contentHtml: `<p>${joined("خاضت نور تجربة إجهاض قسري تركت أثرًا عميقًا في علاقتها بجسدها وأمومتها ونفسها. وبعد شهرين، كانت لا تزال تحاول استيعاب ما خلّفته التجربة من مشاعر.")}</p>`
          + `<p>${joined("في هذه الحلقة من عيب، نتناول الحزن الذي يلي الإجهاض، وكيف يمكن أن تتحوّل تجربة الفقد إلى عبء إضافي حين تُطالَب النساء بإثبات مشروعية مشاعرهنّ.")}</p>`,
      }),
      entry("feed/5", { title: "عنوان من حبر", summaryHtml: "<p>ملخص.</p>", publishedAt: at(40), crawledAt: at(39) }),
    ]));
    app.db.run("UPDATE items SET kind = 'podcast' WHERE title = ?", EPISODE);
    createCollection(app, p, { name: "قراءات", emoji: null, mode: "sources", view: "list", sourceIds: ids, query: null } as Parameters<typeof createCollection>[2]);
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
  const firstVisit = page.getByRole("dialog", { name: "How often do you want to hear about new items?" });
  const notNow = firstVisit.getByRole("button", { name: "Not now", exact: true });
  await notNow.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  if (await notNow.isVisible().catch(() => false)) { await notNow.click(); await firstVisit.waitFor({ state: "hidden" }); }
  await page.getByRole("heading", { name: "Home" }).waitFor();
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/sw.js"))) throw new Error("Build the web app first: npm run build");
  cpSync(path.join(repo, "apps/web/dist"), webDist, { recursive: true });
  prepare();
  startApi();
  for (let i = 0; i < 120; i++) { if (await fetch(`${origin}/api/session`).then((r) => r.ok).catch(() => false)) break; await sleep(250); }
  step("API started on its own port and data with Arabic and mixed-script sources");

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signIn(page);

    // ---------- the source names on a collection's box ----------
    const one = page.locator(".mod-t .one").first();
    await one.waitFor();
    const parts = await one.evaluate((box) => [...box.children].map((span) => {
      const name = span.querySelector("bdi")!;
      const at = name.getBoundingClientRect();
      const sep = [...span.childNodes].find((n) => n.nodeType === 3);
      const range = document.createRange();
      if (sep) range.selectNodeContents(sep);
      const sepAt = sep ? range.getBoundingClientRect() : null;
      return { name: name.textContent ?? "", left: at.left, right: at.right, sepLeft: sepAt?.left ?? null, sepRight: sepAt?.right ?? null };
    }));
    assert.deepEqual(parts.map((p) => p.name).sort(), [...SOURCES].sort(), "every source is named once");
    const rendered = [...parts].sort((a, b) => a.left - b.left);
    for (let i = 1; i < rendered.length; i++) {
      const gap = rendered[i]!.sepLeft!;
      assert.ok(Math.abs(gap - rendered[i - 1]!.right) < 3, `the separator before "${rendered[i]!.name}" starts where "${rendered[i - 1]!.name}" ends (${gap} vs ${rendered[i - 1]!.right})`);
      assert.ok(rendered[i]!.sepRight! <= rendered[i]!.left + 3, `and ends before "${rendered[i]!.name}" begins`);
    }
    step("a collection box names its sources in order, each separator right after the name before it, mixed scripts included");

    // ---------- the Front page ----------
    await page.getByRole("button", { name: "Customise" }).click();
    await page.locator("label.lopt", { hasText: "Front page" }).click();
    await page.locator('input[name="lay"][value="front"]').waitFor({ state: "attached" });
    await page.waitForFunction(() => (document.querySelector('input[name="lay"][value="front"]') as HTMLInputElement | null)?.checked === true);
    await page.keyboard.press("Escape");
    await page.locator(".hl .hli").first().waitFor();
    const headline = page.locator(".hl .hli", { hasText: "كل ما درسته" }).locator(".title");
    const look = await headline.evaluate((el) => ({ direction: getComputedStyle(el).direction, align: getComputedStyle(el).textAlign, announced: !!el.querySelector(".sr"), dotOutside: !!el.parentElement?.querySelector(":scope > .dot") }));
    assert.deepEqual(look, { direction: "rtl", align: "start", announced: false, dotOutside: true }, "a New Arabic headline reads right to left: the screen-reader 'New.' and the dot sit outside the text that decides its direction");
    const box = await headline.evaluate((el) => { const t = el.getBoundingClientRect(), c = el.closest(".hl")!.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(el); const text = range.getBoundingClientRect(); return { textRight: text.right, columnRight: c.right, textLeft: text.left, columnLeft: c.left, titleWidth: t.width }; });
    assert.ok(box.columnRight - box.textRight < 4, `the headline starts at the column's right edge (${box.columnRight - box.textRight}px short of it)`);
    step("on the Front page a New Arabic headline is laid out right to left, from the column's right edge");

    // ---------- podcast notes ----------
    await page.getByText(EPISODE).first().click();
    const notes = page.locator("#panel-in .prose p").first();
    await notes.waitFor();
    const text = await notes.innerText();
    assert.ok(!text.includes(" "), "the notes' words are separated by ordinary spaces");
    const cut = await notes.evaluate((p) => {
      // Each word is whole on one line: no word's box spans two lines.
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const split: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        for (const m of t.data.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(t, m.index!); r.setEnd(t, m.index! + m[0].length);
          if (r.getClientRects().length > 1) split.push(m[0]);
        }
      }
      return split;
    });
    assert.deepEqual(cut, [], "no word of the notes is cut in half at the end of a line");
    step("a podcast's notes that the publisher joined with no-break spaces wrap at the spaces, with no word cut in half");
    await page.getByRole("button", { name: "Close details" }).click();

    // ---------- the phone's top bar ----------
    const phone = await browser.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true });
    const phonePage = await phone.newPage();
    await signIn(phonePage);
    const who = phonePage.locator(".bar .brand .who");
    await who.waitFor();
    assert.equal(await who.evaluate((el) => getComputedStyle(el).direction), "rtl", "a name that starts in Arabic reads, and is cut, right to left");
    // The start of the name (the Arabic) is what stays when it doesn't fit.
    const startShown = await who.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, 5);
      const first = range.getBoundingClientRect(), box = el.getBoundingClientRect();
      return first.left >= box.left - 1 && first.right <= box.right + 1;
    });
    assert.equal(startShown, true, "the Arabic first name is inside the box, not clipped away");
    step("on a phone the top bar's name that starts in Arabic keeps its start when it doesn't fit");
    await phone.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log("Right-to-left journey passed");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await stopApi();
  rmSync(work, { recursive: true, force: true });
}
