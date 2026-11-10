import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { createBasket } from "./collections.ts";
import { keepItem } from "./state.ts";
import { setPreferences } from "./preferences.ts";
import { addDays, isAnniversary, listReminders, reminderAction, remindersForToday, runReminderPass } from "./reminders.ts";
import { HttpError } from "../http.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Sediment Letters", "feed/1");
  const basket = createBasket(app, p, { name: "Keepers", captureMode: "metadata" }).id;
  return { app, p, basket, cleanup };
}

/** Keep a fresh item and backdate the recorded keep time. */
function keptOn(app: App, p: Principal & { engineUserId: string }, basket: string, keptAt: string, title: string): string {
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title })]));
  const id = app.db.get<{ id: string }>("SELECT id FROM items WHERE title = ?", title)!.id;
  keepItem(app, p, id, basket);
  app.db.run("UPDATE basket_items SET kept_at = ? WHERE item_id = ?", keptAt, id);
  return id;
}

const NOW = new Date("2026-11-03T12:00:00.000Z");

test("anniversary: earlier years on this month and day only", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Two years ago");
  keptOn(app, p, basket, "2025-11-03T10:00:00.000Z", "One year ago");
  keptOn(app, p, basket, "2026-11-03T08:00:00.000Z", "Kept today");
  keptOn(app, p, basket, "2025-11-04T10:00:00.000Z", "Wrong day");
  const titles = listReminders(app, p, NOW).map((r) => r.title).sort();
  assert.deepEqual(titles, ["One year ago", "Two years ago"]);
  const r = listReminders(app, p, NOW)[0]!;
  assert.equal(r.basketName, "Keepers");
  assert.equal(r.captureLabel, "Saved details (title, link and summary)");
  assert.equal(r.sourceTitle, "Sediment Letters");
});

test("ignored items, unkept items and other PURSSes are not reminded", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  const ignored = keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Ignored one");
  const unkept = keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Unkept one");
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Visible one");
  app.db.run("UPDATE item_state SET workflow = 'ignored' WHERE item_id = ?", ignored);
  assert.deepEqual(listReminders(app, p, NOW).map((r) => r.title).sort(), ["Unkept one", "Visible one"]);
  // Removing the pin after the reminder exists hides it too.
  app.db.run("DELETE FROM basket_items WHERE item_id = ?", unkept);
  assert.deepEqual(listReminders(app, p, NOW).map((r) => r.title), ["Visible one"]);
  const other = makeOwner(app, { admin: false });
  assert.deepEqual(listReminders(app, other, NOW), []);
  assert.throws(() => reminderAction(app, other, listReminders(app, p, NOW)[0]!.id, "hide", NOW), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test("the user's time zone decides the date", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  // 23:30 UTC on Nov 3 is already Nov 4 in Auckland (UTC+13 in November).
  keptOn(app, p, basket, "2024-11-03T23:30:00.000Z", "Late keep");
  setPreferences(app, p.workspaceId, { timezone: "Pacific/Auckland" });
  assert.equal(listReminders(app, p, new Date("2026-11-03T09:00:00.000Z")).length, 0, "still Nov 3 locally at 22:00 NZDT");
  assert.equal(listReminders(app, p, new Date("2026-11-04T09:00:00.000Z")).length, 1, "Nov 4 locally");
  setPreferences(app, p.workspaceId, { timezone: "UTC" });
  assert.equal(listReminders(app, p, new Date("2026-11-03T12:00:00.000Z")).length, 1, "in UTC the keep date is Nov 3");
  assert.equal(listReminders(app, p, new Date("2026-11-04T09:00:00.000Z")).length, 0);
});

test("an unknown time zone falls back to UTC instead of failing", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Fine");
  app.db.run("INSERT INTO preferences (workspace_id, value, updated_at) VALUES (?, ?, ?)", p.workspaceId, JSON.stringify({ timezone: "Mars/Olympus" }), "x");
  assert.equal(listReminders(app, p, NOW).length, 1);
});

test("leap day: Feb 29 keeps return on Feb 28 in common years and on Feb 29 in leap years", () => {
  const kept = { y: 2024, m: 2, d: 29 };
  assert.equal(isAnniversary(kept, { y: 2027, m: 2, d: 28 }), true);
  assert.equal(isAnniversary(kept, { y: 2027, m: 3, d: 1 }), false);
  assert.equal(isAnniversary(kept, { y: 2028, m: 2, d: 29 }), true);
  assert.equal(isAnniversary(kept, { y: 2028, m: 2, d: 28 }), false, "leap years use the real day");
  assert.equal(isAnniversary({ y: 2024, m: 2, d: 28 }, { y: 2027, m: 2, d: 28 }), true, "an ordinary Feb 28 keep still returns on Feb 28");
  assert.equal(isAnniversary(kept, { y: 2024, m: 2, d: 29 }), false, "never in the same year");
});

test("leap-day keeps surface through the service on Feb 28 of a common year", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-02-29T10:00:00.000Z", "Leap keep");
  keptOn(app, p, basket, "2025-02-28T10:00:00.000Z", "Feb 28 keep");
  assert.deepEqual(listReminders(app, p, new Date("2027-02-28T12:00:00.000Z")).map((r) => r.title).sort(), ["Feb 28 keep", "Leap keep"]);
  assert.deepEqual(listReminders(app, p, new Date("2028-02-29T12:00:00.000Z")).map((r) => r.title), ["Leap keep"]);
  assert.deepEqual(listReminders(app, p, new Date("2028-02-28T12:00:00.000Z")).map((r) => r.title), ["Feb 28 keep"]);
});

test("a reminder is created once, survives restarts, and one notification is made per day", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Remember me");
  const a = listReminders(app, p, NOW);
  const b = listReminders(app, p, new Date(NOW.getTime() + 3600_000));
  assert.equal(a[0]!.id, b[0]!.id, "same reminder, not re-created");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")!.n, 1);
  runReminderPass(app, NOW);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'")!.n, 1);
  const n = app.db.get<{ title: string; body: string | null }>("SELECT title, body FROM notifications WHERE kind = 'reminder'")!;
  assert.equal(n.title, "On this day: 1 thing you kept");
  assert.equal(n.body, null, "no titles in the notification unless previews are on");
  // Next day, a new date, a new notification (nothing is kept on Nov 4 so there is no reminder).
  assert.equal(listReminders(app, p, new Date("2026-11-04T12:00:00.000Z")).length, 0);
});

test("hide is permanent for that day's reminder; snooze returns it tomorrow only", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Hide me");
  keptOn(app, p, basket, "2023-11-03T10:00:00.000Z", "Snooze me");
  const [hide, snooze] = (() => { const l = listReminders(app, p, NOW); return [l.find((r) => r.title === "Hide me")!, l.find((r) => r.title === "Snooze me")!]; })();
  reminderAction(app, p, hide.id, "hide", NOW);
  reminderAction(app, p, snooze.id, "snooze", NOW);
  assert.deepEqual(listReminders(app, p, NOW), [], "both gone for today");
  assert.deepEqual(listReminders(app, p, new Date("2026-11-03T22:00:00.000Z")), [], "and still gone later today");
  const tomorrow = listReminders(app, p, new Date("2026-11-04T08:00:00.000Z"));
  assert.deepEqual(tomorrow.map((r) => r.title), ["Snooze me"]);
  assert.deepEqual(listReminders(app, p, new Date("2026-11-05T08:00:00.000Z")), [], "a snooze is for one day");
  // Restart safety: a hidden reminder is not re-created for the same date.
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders WHERE for_date = '2026-11-03'")!.n, 2);
  assert.deepEqual(listReminders(app, p, NOW), []);
});

test("switching reminders off returns nothing and creates nothing; notifications off creates no notification", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  keptOn(app, p, basket, "2024-11-03T10:00:00.000Z", "Quiet");
  setPreferences(app, p.workspaceId, { reminders: false });
  assert.deepEqual(listReminders(app, p, NOW), []);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")!.n, 0);
  setPreferences(app, p.workspaceId, { reminders: true, notifications: { mode: "off", quietStart: null, quietEnd: null, previews: false } });
  assert.equal(listReminders(app, p, NOW).length, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'")!.n, 0);
});

test("capture label reflects what was actually kept, and no network is involved", (t) => {
  const { app, p, basket, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "With feed content", contentHtml: "<p>full</p>" })]));
  const id = app.db.get<{ id: string }>("SELECT id FROM items WHERE title = 'With feed content'")!.id;
  keepItem(app, p, id, basket);
  app.db.run("UPDATE basket_items SET kept_at = '2024-11-03T10:00:00.000Z' WHERE item_id = ?", id);
  assert.equal(remindersForToday(app, p.workspaceId, p.accountId, NOW)[0]!.captureLabel, "Feed content saved");
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, created_at) VALUES (?, ?, ?, 'fulltext', 'done', ?)", newId("cap"), p.workspaceId, id, "2024-11-03T10:05:00.000Z");
  assert.equal(remindersForToday(app, p.workspaceId, p.accountId, NOW)[0]!.captureLabel, "Full text captured");
});

test("date arithmetic helper rolls over months and years", () => {
  assert.deepEqual(addDays({ y: 2026, m: 12, d: 31 }, 1), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(addDays({ y: 2028, m: 2, d: 28 }, 1), { y: 2028, m: 2, d: 29 });
});
