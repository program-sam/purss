import test from "node:test";
import assert from "node:assert/strict";
import type { App, Principal } from "../app.ts";
import { call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { Library, TestSession } from "../features-testing.ts";
import { HttpError, nowIso } from "../http.ts";
import { settleMail, useTransport } from "../mail/mailer.ts";
import type { Message } from "../mail/mailer.ts";
import { extraRouters } from "../routes/index.ts";
import { publicRouter } from "../routes/public.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { comingUp, getItemReminder, pruneItemReminders, removeItemReminder, runItemReminders, setItemReminder } from "./item-reminders.ts";
import { runReturningPass } from "./returning.ts";
import { deleteItems, deletePreview } from "./collections.ts";
import { setPreferences } from "./preferences.ts";
import { unkeepItem } from "./state.ts";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const MAIL = { PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>", PURSS_PUBLIC_ORIGIN: "https://ws.example.org" };

type Owner = Principal & { engineUserId: string };
function setup(env: Record<string, string> = {}) {
  const { app, cleanup } = makeTestApp(env);
  const p: Owner = makeOwner(app);
  const lib = seedLibrary(app, p);
  setPreferences(app, p.workspaceId, { timezone: "UTC" });
  return { app, p, lib, cleanup };
}
const kept = (lib: Library) => lib.keptIds[0]!;
const notes = (app: App, p: Principal) => app.db.all<{ kind: string; title: string; body: string | null; item_id: string | null }>(
  "SELECT kind, title, body, item_id FROM notifications WHERE workspace_id = ? AND kind = 'reminder' ORDER BY created_at, rowid", p.workspaceId);

test("a kept item gets one reminder: a day and a note, changed or removed later", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  assert.equal(getItemReminder(app, p, kept(lib)), null);
  const set = setItemReminder(app, p, kept(lib), { remindOn: "2026-11-14", note: "  Book the train  " }, NOW);
  assert.deepEqual([set.remindOn, set.note, set.title, set.sourceTitle], ["2026-11-14", "Book the train", "Tidal flats (corrected)", "Sediment Letters"]);
  const changed = setItemReminder(app, p, kept(lib), { remindOn: "2026-11-20", note: null }, NOW);
  assert.equal(changed.id, set.id, "one per item");
  assert.deepEqual([changed.remindOn, changed.note], ["2026-11-20", null]);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_reminders")!.n, 1);
  assert.deepEqual(removeItemReminder(app, p, kept(lib)), { ok: true });
  assert.equal(getItemReminder(app, p, kept(lib)), null);
});

test("a reminder needs a kept item, a real day from today to five years ahead, and an item of this PURSS", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const notKept = lib.itemIds.find((id) => !lib.keptIds.includes(id))!;
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof HttpError ? e.code : String(e); } return "ok"; };
  assert.equal(code(() => setItemReminder(app, p, notKept, { remindOn: "2026-11-14", note: null }, NOW)), "not_kept");
  assert.equal(code(() => setItemReminder(app, p, kept(lib), { remindOn: "2026-11-09", note: null }, NOW)), "past_date", "yesterday");
  assert.equal(code(() => setItemReminder(app, p, kept(lib), { remindOn: "2026-11-10", note: null }, NOW)), "ok", "today is fine");
  assert.equal(code(() => setItemReminder(app, p, kept(lib), { remindOn: "2026-02-30", note: null }, NOW)), "bad_date");
  assert.equal(code(() => setItemReminder(app, p, kept(lib), { remindOn: "2031-11-10", note: null }, NOW)), "ok", "exactly five years ahead");
  assert.equal(code(() => setItemReminder(app, p, kept(lib), { remindOn: "2031-11-11", note: null }, NOW)), "far_date");
  assert.equal(code(() => setItemReminder(app, p, "itm_nope", { remindOn: "2026-11-14", note: null }, NOW)), "not_found");
  const other = makeOwner(app);
  assert.equal(code(() => getItemReminder(app, other, kept(lib))), "not_found", "another PURSS's item is not found, never read or written");
  assert.equal(code(() => setItemReminder(app, other, kept(lib), { remindOn: "2026-11-14", note: null }, NOW)), "not_found");
  assert.equal(code(() => removeItemReminder(app, other, kept(lib))), "not_found");
});

test("the day is the person's own: today is decided by their time zone", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const lateEvening = new Date("2026-11-10T23:30:00.000Z"); // already the 11th in Auckland, still the 10th in UTC
  setPreferences(app, p.workspaceId, { timezone: "Pacific/Auckland" });
  assert.throws(() => setItemReminder(app, p, kept(lib), { remindOn: "2026-11-10", note: null }, lateEvening), (e: unknown) => e instanceof HttpError && e.code === "past_date");
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-11", note: null }, lateEvening);
  assert.equal(comingUp(app, p, lateEvening).today, "2026-11-11");
  assert.deepEqual(comingUp(app, p, lateEvening).reminders.map((r) => r.remindOn), ["2026-11-11"]);
  setPreferences(app, p.workspaceId, { timezone: "UTC" });
  assert.equal(comingUp(app, p, lateEvening).today, "2026-11-10");
});

test("Coming up lists today and the next six days, soonest first, for items that are still kept", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const [a, b, c] = lib.keptIds as [string, string, string];
  setItemReminder(app, p, a, { remindOn: "2026-11-16", note: "last day listed" }, NOW);
  setItemReminder(app, p, b, { remindOn: "2026-11-10", note: null }, NOW);
  setItemReminder(app, p, c, { remindOn: "2026-11-17", note: "one day too far" }, NOW);
  const list = comingUp(app, p, NOW);
  assert.deepEqual([list.today, list.days], ["2026-11-10", 7]);
  assert.deepEqual(list.reminders.map((r) => [r.remindOn, r.itemId]), [["2026-11-10", b], ["2026-11-16", a]]);
  // Taking the item out of every basket takes it off the list, and keeping it again brings it back.
  const basket = app.db.get<{ basket_id: string }>("SELECT basket_id FROM basket_items WHERE item_id = ?", b)!.basket_id;
  unkeepItem(app, p, b, basket);
  assert.deepEqual(comingUp(app, p, NOW).reminders.map((r) => r.itemId), [a]);
  // Another PURSS sees none of it.
  assert.deepEqual(comingUp(app, makeOwner(app), NOW).reminders, []);
});

test("on the day the bell says so once, however often the check runs; a new day is told again", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-12", note: "Call the gallery" }, NOW);
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-11T23:59:00.000Z")), 0, "not before its day");
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-12T00:05:00.000Z")), 1);
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-12T00:10:00.000Z")), 0, "not twice");
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-12T18:00:00.000Z")), 0);
  const list = notes(app, p);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "reminder");
  assert.equal(list[0]!.item_id, kept(lib), "it opens the item");
  // Moving the day to another one tells again on that day.
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-13", note: null }, new Date("2026-11-12T10:00:00.000Z"));
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-13T08:00:00.000Z")), 1);
  assert.equal(notes(app, p).length, 2);
  // The same day with a different note is not a new reminder.
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-13", note: "different" }, new Date("2026-11-13T09:00:00.000Z"));
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-13T10:00:00.000Z")), 0);
});

test("titles and notes stay out of the bell unless titles are on, and never for a private source", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const day = new Date("2026-11-12T08:00:00.000Z");
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-12", note: "Secret errand" }, NOW);
  runItemReminders(app, p.workspaceId, p.accountId, day);
  assert.deepEqual(notes(app, p).map((n) => [n.title, n.body]), [["A reminder you set is due", null]]);
  // With titles on: the title and the note.
  setPreferences(app, p.workspaceId, { notifications: { previews: true } });
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-13", note: "Secret errand" }, day);
  runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-13T08:00:00.000Z"));
  assert.deepEqual(notes(app, p).map((n) => [n.title, n.body]).at(-1), ["Reminder: Tidal flats (corrected)", "Secret errand"]);
  // A private source's item says nothing about itself even then.
  setItemReminder(app, p, lib.privateItemId, { remindOn: "2026-11-14", note: "Private errand" }, new Date("2026-11-13T09:00:00.000Z"));
  runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-14T08:00:00.000Z"));
  const last = notes(app, p).at(-1)!;
  assert.deepEqual([last.title, last.body], ["A reminder you set is due", null]);
  // Several on one day become one line with a count.
  setItemReminder(app, p, lib.keptIds[0]!, { remindOn: "2026-11-15", note: null }, new Date("2026-11-14T09:00:00.000Z"));
  setItemReminder(app, p, lib.keptIds[1]!, { remindOn: "2026-11-15", note: null }, new Date("2026-11-14T09:00:00.000Z"));
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-15T08:00:00.000Z")), 2);
  const group = notes(app, p).at(-1)!;
  assert.deepEqual([group.title, group.body, group.item_id], ["2 reminders you set are due", null, null]);
});

test("with notifications off, or Reminders off, nobody is told and the day is not told later", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const [a, b] = lib.keptIds as [string, string, string];
  setItemReminder(app, p, a, { remindOn: "2026-11-12", note: null }, NOW);
  setItemReminder(app, p, b, { remindOn: "2026-11-12", note: null }, NOW);
  setPreferences(app, p.workspaceId, { notifications: { frequency: "off" } });
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-12T08:00:00.000Z")), 0);
  setPreferences(app, p.workspaceId, { notifications: { frequency: "daily" } });
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-12T09:00:00.000Z")), 0, "switching them back on does not tell about a day that has gone");
  assert.equal(notes(app, p).length, 0);
  setPreferences(app, p.workspaceId, { notifications: { include: { reminders: false } } });
  setItemReminder(app, p, a, { remindOn: "2026-11-13", note: null }, new Date("2026-11-12T10:00:00.000Z"));
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-13T08:00:00.000Z")), 0);
  assert.equal(notes(app, p).length, 0);
});

test("a day missed by more than three days (the server was off) is not announced late; an item no longer kept is not announced", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  const [a, b] = lib.keptIds as [string, string, string];
  setItemReminder(app, p, a, { remindOn: "2026-11-11", note: null }, NOW);
  setItemReminder(app, p, b, { remindOn: "2026-11-12", note: null }, NOW);
  const basket = app.db.get<{ basket_id: string }>("SELECT basket_id FROM basket_items WHERE item_id = ?", b)!.basket_id;
  unkeepItem(app, p, b, basket);
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-20T08:00:00.000Z")), 0);
  assert.equal(notes(app, p).length, 0);
  // Three days late still counts.
  setItemReminder(app, p, a, { remindOn: "2026-11-21", note: null }, new Date("2026-11-20T09:00:00.000Z"));
  assert.equal(runItemReminders(app, p.workspaceId, p.accountId, new Date("2026-11-24T08:00:00.000Z")), 1);
});

test("the returning pass tells about reminders and prunes old ones", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-10", note: null }, NOW);
  runReturningPass(app, NOW, { force: true });
  assert.equal(notes(app, p).length, 1);
  assert.equal(pruneItemReminders(app, p.workspaceId, new Date("2026-12-09T00:00:00.000Z")), 0, "30 days later is not yet");
  assert.equal(pruneItemReminders(app, p.workspaceId, new Date("2026-12-11T00:00:00.000Z")), 1);
});

test("a reminder goes with its item", (t) => {
  const { app, p, lib, cleanup } = setup();
  t.after(cleanup);
  setItemReminder(app, p, kept(lib), { remindOn: "2026-11-14", note: null }, NOW);
  deleteItems(app, p, deletePreview(app, p, [kept(lib)]).confirmToken);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_reminders")!.n, 0);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE id = ?", kept(lib))!.n, 0);
});

test("email: only when allowed, with outgoing email set up and a confirmed address; links stand alone and titles follow the notification rule", async (t) => {
  const { app, p, lib, cleanup } = setup(MAIL);
  t.after(async () => { await settleMail(app); cleanup(); });
  const sent: Message[] = [];
  useTransport(app, { send: async (m) => { sent.push(m); }, verify: async () => undefined });
  const day = (d: number) => new Date(`2026-11-${d}T08:00:00.000Z`);
  const remind = (id: string, d: number, from: number) => setItemReminder(app, p, id, { remindOn: `2026-11-${d}`, note: "Ask about the loan" }, new Date(`2026-11-${from}T07:00:00.000Z`));
  // Not allowed: the bell only.
  app.db.run("UPDATE accounts SET email = 'me@example.org', email_verified_at = ? WHERE id = ?", nowIso(), p.accountId);
  remind(kept(lib), 12, 10);
  runItemReminders(app, p.workspaceId, p.accountId, day(12));
  await settleMail(app);
  assert.equal(sent.length, 0, "reminders by email are off until the person allows them");
  // Allowed, but the address isn't confirmed.
  setPreferences(app, p.workspaceId, { notifications: { emailReminders: true } });
  app.db.run("UPDATE accounts SET email_verified_at = NULL WHERE id = ?", p.accountId);
  remind(kept(lib), 13, 12);
  runItemReminders(app, p.workspaceId, p.accountId, day(13));
  await settleMail(app);
  assert.equal(sent.length, 0, "an unconfirmed address gets nothing");
  // Allowed and confirmed: one message, links alone, no title while titles are off.
  app.db.run("UPDATE accounts SET email_verified_at = ? WHERE id = ?", nowIso(), p.accountId);
  remind(kept(lib), 14, 13);
  runItemReminders(app, p.workspaceId, p.accountId, day(14));
  await settleMail(app);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "me@example.org");
  assert.ok(!sent[0]!.text.includes("Tidal flats") && !sent[0]!.text.includes("loan"), "no title or note while titles are off");
  const lines = sent[0]!.text.split("\n");
  const link = lines.find((l) => l.startsWith("https://ws.example.org/app/?item="));
  assert.equal(link, `https://ws.example.org/app/?item=${kept(lib)}`, "the link is a line of its own");
  // Titles on: title and note appear.
  setPreferences(app, p.workspaceId, { notifications: { previews: true } });
  remind(kept(lib), 15, 14);
  runItemReminders(app, p.workspaceId, p.accountId, day(15));
  await settleMail(app);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.text, /Tidal flats \(corrected\): Ask about the loan/);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'reminder'")!.n, 2);
  // Running the check again sends nothing more.
  runItemReminders(app, p.workspaceId, p.accountId, day(15));
  await settleMail(app);
  assert.equal(sent.length, 2);
});

test("the routes: set, read, list for Home and remove; a person without a session gets nothing; a stranger's item is not found", async (t) => {
  const { app, p, lib, cleanup } = setup();
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await server.close(); cleanup(); });
  const s: TestSession = signIn(app, p.accountId);
  const req = (method: string, path: string, session: TestSession | null, body?: unknown) => call(app, server.base, method, path, session, body);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await req("GET", `/api/items/${kept(lib)}/reminder`, null)).status, 401);
  assert.deepEqual((await req("GET", `/api/items/${kept(lib)}/reminder`, s)).json, { reminder: null });
  const put = await req("PUT", `/api/items/${kept(lib)}/reminder`, s, { remindOn: soon, note: "Look again" });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.reminder.note, "Look again");
  assert.equal((await req("PUT", `/api/items/${kept(lib)}/reminder`, s, { remindOn: "tomorrow" })).status, 400, "not a date");
  assert.equal((await req("PUT", `/api/items/${kept(lib)}/reminder`, s, { remindOn: soon, note: "x".repeat(301) })).status, 400, "notes are short");
  const list = await req("GET", "/api/item-reminders", s);
  assert.equal(list.json.today, today);
  assert.deepEqual(list.json.reminders.map((r: { itemId: string }) => r.itemId), [kept(lib)]);
  const stranger = makeOwner(app);
  const theirs = signIn(app, stranger.accountId);
  assert.equal((await req("GET", `/api/items/${kept(lib)}/reminder`, theirs)).status, 404);
  assert.deepEqual((await req("GET", "/api/item-reminders", theirs)).json.reminders, []);
  assert.equal((await req("DELETE", `/api/items/${kept(lib)}/reminder`, s)).status, 200);
  assert.deepEqual((await req("GET", `/api/items/${kept(lib)}/reminder`, s)).json, { reminder: null });
});
