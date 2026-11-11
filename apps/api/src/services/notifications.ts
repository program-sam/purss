import { OTHER_BOX_ID, appUrl, newId } from "@purss/domain";
import type { NotificationDTO, Preferences } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { emit } from "../app.ts";
import { nowIso } from "../http.ts";
import { sendLater } from "../mail/mailer.ts";
import { digestMail } from "../mail/templates.ts";
import type { DigestMail } from "../mail/templates.ts";
import { getPreferences } from "./preferences.ts";
import { addDays, localDate, validTimezone } from "./reminders.ts";
import { boxesBySource } from "./home.ts";
import { settledCopy } from "./capture-state.ts";
import type { BoxLink } from "./home.ts";

/*
 * Notifications (plan/29 §2). One place decides who is told what, when:
 *  - frequency "daily" / "weekly": arrivals wait, and one digest at the chosen time counts what is still New;
 *  - "off": nothing about new items;
 *  - a source set to "Notify me" tells you as its items arrive, whatever the frequency: its new items within an hour
 *    share one notification.
 * Sources set to "muted" never notify. Collections hidden from Home are left out unless chosen.
 * Titles stay out of the text unless previews are on and the source isn't private.
 */

/** How many of a box's newest items a digest email shows. */
const TEASERS = 3;
/** A source's arrivals within this many minutes of its first notification are folded into it. */
const COALESCE_MINUTES = 60;
/** Notifications are kept this long, and at most this many. */
export const NOTIFICATION_KEEP_DAYS = 90;
export const NOTIFICATION_KEEP_COUNT = 500;

type Sourcey = { id: string; title: string; is_private: number; notify: string };

/**
 * The collections a source's new items are told about under the person's choice: every collection shown on Home
 * (or "Other sources" for a source in none, when that box is shown on Home), or only the chosen ones ("Other sources"
 * among them, shown on Home or not). Empty means leave the source out.
 */
function boxesFor(prefs: Preferences, boxes: BoxLink[] | undefined, homeOther: boolean): { id: string; name: string }[] {
  const chosen = prefs.notifications.include.newItems;
  if (!boxes?.length) return (chosen === "all" ? homeOther : chosen.includes(OTHER_BOX_ID)) ? [{ id: OTHER_BOX_ID, name: "Other sources" }] : [];
  if (chosen === "all") return boxes.filter((b) => b.home);
  return boxes.filter((b) => chosen.includes(b.id));
}

/**
 * Record arrival notifications for followed sources (only items that are New: a source's back catalogue is not
 * passed in). Only sources set to "Notify me" tell at once; the rest wait for a digest, made later from what is still
 * New. Delivery timing depends on engine polling.
 */
/** `fromItems`: take each source's preview title from these posts only (a Smart filter's kept posts; plan/36). */
export function notifyArrivals(app: App, workspaceId: string, perSource: [string, number][], _dedupBase?: string, fromItems?: readonly string[]): void {
  const prefs = getPreferences(app, workspaceId);
  const account = app.db.get<{ account_id: string }>("SELECT account_id FROM workspaces WHERE id = ?", workspaceId)!;
  let changed = 0;
  for (const [sourceId, count] of perSource) {
    const s = app.db.get<Sourcey>("SELECT id, title, notify, is_private FROM sources WHERE id = ?", sourceId);
    if (!s || s.notify !== "on") continue;
    // The item stored last that the person will see: the one that just arrived (an engine's crawl times needn't follow
    // arrival order), among an AI filter's kept posts when it ran, else among what isn't Ignored.
    const newest = fromItems
      ? app.db.get<{ id: string; title: string }>("SELECT i.id, i.title FROM json_each(?) j JOIN items i ON i.id = j.value WHERE i.workspace_id = ? AND i.source_id = ? ORDER BY i.seq DESC LIMIT 1", JSON.stringify(fromItems), workspaceId, sourceId)
      : app.db.get<{ id: string; title: string }>("SELECT i.id, i.title FROM items i JOIN item_state st ON st.item_id = i.id WHERE i.workspace_id = ? AND i.source_id = ? AND st.workflow <> 'ignored' ORDER BY i.seq DESC LIMIT 1", workspaceId, sourceId);
    // Private sources' item titles never go into notifications (they can show on a lock screen).
    const latest = prefs.notifications.previews && !s.is_private ? newest?.title ?? null : null;
    changed += upsertArrival(app, workspaceId, s, count, latest, newest?.id ?? null);
  }
  if (changed) emit(app, account.account_id, { type: "notification" });
}

const arrivalTitle = (title: string, count: number) => (count === 1 ? `New from ${title}` : `${count} new from ${title}`);

/** One new item opens that item; several open their source. */
function upsertArrival(app: App, workspaceId: string, s: Sourcey, count: number, latest: string | null, newestId: string | null): number {
  const since = new Date(Date.now() - COALESCE_MINUTES * 60_000).toISOString();
  const open = app.db.get<{ id: string; data: string | null }>(
    "SELECT id, data FROM notifications WHERE workspace_id = ? AND source_id = ? AND kind = 'arrivals' AND created_at >= ? ORDER BY created_at DESC LIMIT 1", workspaceId, s.id, since);
  if (open) {
    const total = (open.data ? (JSON.parse(open.data) as { count: number }).count : 1) + count;
    // More arrived within the hour: the one notification grows (and is unread again) instead of a second one appearing.
    // Its new text is news to a phone that was handed the old one (changed_at, services/push.ts).
    return app.db.run("UPDATE notifications SET title = ?, body = COALESCE(?, body), data = ?, item_id = NULL, read_at = NULL, changed_at = ? WHERE id = ?",
      arrivalTitle(s.title, total), latest, JSON.stringify({ count: total }), nowIso(), open.id).changes;
  }
  return app.db.run(
    "INSERT INTO notifications (id, workspace_id, kind, title, body, item_id, source_id, dedup_key, data, created_at) VALUES (?, ?, 'arrivals', ?, ?, ?, ?, ?, ?, ?)",
    newId("ntf"), workspaceId, arrivalTitle(s.title, count), latest, count === 1 ? newestId : null, s.id, `arrivals:${s.id}:${newId("k")}`, JSON.stringify({ count }), nowIso()).changes;
}

// ---------- digests ----------

export type DigestWindow = { from: string; to: string };
/** An item the digest email shows as a teaser: never one of a private source. */
export type DigestTeaser = { id: string; title: string; source: string; at: string };
export type DigestBox = { id: string; name: string; count: number; titles: string[]; teasers: DigestTeaser[] };
export type Digest = { window: DigestWindow; total: number; boxes: DigestBox[] };

/**
 * What is still New among the items that arrived in a window, counted per Home box under the person's choice of
 * contents, for a digest here or by email. The privacy rules are applied here: `titles` (a few per box, for the bell and
 * the phone, which can show on a shared or locked screen) are filled only when the person has turned on titles in
 * notifications; `teasers` (the newest few per box, for the email, which goes only to the person's own confirmed address)
 * always are. Neither ever holds an item of a private source. A source in two collections is counted in both, and once in
 * `total`.
 */
export function digestFor(app: App, workspaceId: string, window: DigestWindow): Digest {
  const prefs = getPreferences(app, workspaceId);
  const rows = app.db.all<{ source_id: string; n: number; is_private: number; notify: string; source_title: string }>(
    `SELECT i.source_id, COUNT(*) AS n, s.is_private, s.notify, s.title AS source_title FROM items i
       JOIN item_state st ON st.item_id = i.id JOIN sources s ON s.id = i.source_id
     WHERE i.workspace_id = ? AND i.discovered_at > ? AND i.discovered_at <= ? AND st.fresh = 1 AND s.followed = 1 AND s.notify <> 'muted'
     GROUP BY i.source_id`, workspaceId, window.from, window.to);
  const links = boxesBySource(app, workspaceId);
  const boxes = new Map<string, DigestBox>();
  let total = 0;
  for (const r of rows) {
    const mine = boxesFor(prefs, links.get(r.source_id), prefs.homeOther);
    if (!mine.length) continue;
    total += r.n;
    const newest = r.is_private ? [] : app.db.all<{ id: string; title: string; discovered_at: string }>(
      `SELECT i.id, i.title, i.discovered_at FROM items i JOIN item_state st ON st.item_id = i.id
       WHERE i.workspace_id = ? AND i.source_id = ? AND i.discovered_at > ? AND i.discovered_at <= ? AND st.fresh = 1 AND st.workflow <> 'ignored'
       ORDER BY i.discovered_at DESC LIMIT ?`, workspaceId, r.source_id, window.from, window.to, TEASERS);
    const titles = prefs.notifications.previews ? newest.slice(0, 2).map((t) => t.title) : [];
    const teasers = newest.map((t) => ({ id: t.id, title: t.title, source: r.source_title, at: t.discovered_at }));
    for (const b of mine) {
      const box = boxes.get(b.id) ?? { id: b.id, name: b.name, count: 0, titles: [], teasers: [] };
      box.count += r.n;
      box.titles.push(...titles);
      box.teasers.push(...teasers);
      boxes.set(b.id, box);
    }
  }
  const list = [...boxes.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  for (const b of list) {
    b.titles = b.titles.slice(0, 3);
    b.teasers = b.teasers.sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id)).slice(0, TEASERS);
  }
  return { window, total, boxes: list };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many boxes a digest lists; the rest are "and N more". */
const DIGEST_BOXES = 8;

/** The one notification a digest becomes: "Your daily digest: 54 new in 4 collections", with a line per collection. */
export function digestText(d: Digest, kind: "daily" | "weekly"): { title: string; body: string } {
  const where = d.boxes.length === 1 && d.boxes[0]!.id === OTHER_BOX_ID ? "your other sources" : plural(d.boxes.length, "collection");
  const lines = d.boxes.slice(0, DIGEST_BOXES).map((b) => `${b.name}: ${b.count} new${b.titles.length ? ` · ${b.titles.map((t) => `“${t}”`).join(", ")}` : ""}`);
  if (d.boxes.length > DIGEST_BOXES) lines.push(`and ${d.boxes.length - DIGEST_BOXES} more`);
  return { title: `Your ${kind} digest: ${d.total} new in ${where}`, body: lines.join("\n") };
}

/** How long ago, in words, for a teaser: "2 hours ago", "yesterday", "3 days ago". */
function ago(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour") + " ago";
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** What the digest email shows: the counts, and per box its newest items with links into the app. */
export function digestEmail(app: App, d: Digest, kind: "daily" | "weekly", now: Date = new Date()): DigestMail {
  const home = `${app.config.publicOrigin}${appUrl("/")}`;
  const text = digestText(d, kind);
  const shown = d.boxes.slice(0, DIGEST_BOXES);
  return {
    subject: text.title,
    intro: `${plural(d.total, "new item")} ${kind === "weekly" ? "this week" : "today"}, still waiting for you.`,
    boxes: shown.map((b) => ({
      name: b.name, count: b.count,
      link: b.id === OTHER_BOX_ID ? home : `${home}c/${encodeURIComponent(b.id)}`,
      teasers: b.teasers.map((t) => ({ title: t.title, meta: `${t.source} · ${ago(t.at, now)}`, link: `${home}?item=${encodeURIComponent(t.id)}` })),
    })),
    more: d.boxes.length - shown.length,
    home, settings: `${home}?dialog=notifications`,
  };
}

// ---------- the scheduled part ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneOffsetMs(tz: string, at: number): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall-clock time has in a zone. Try the offset in force before and after the nearest change of clocks: a time
 * that exists under one is that instant (the earlier one when the clocks went back and it happens twice). A time that does
 * not exist, because the clocks skipped it going forward, lands after the gap (02:30 becomes 03:30), never before it.
 */
function wallToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const beforeOffset = zoneOffsetMs(tz, guess - 36 * 3_600_000);
  const afterOffset = zoneOffsetMs(tz, guess + 36 * 3_600_000);
  const asBefore = guess - beforeOffset;
  const asAfter = guess - afterOffset;
  const exists = (t: number) => t + zoneOffsetMs(tz, t) === guess;
  const valid = [asBefore, asAfter].filter(exists);
  return valid.length ? Math.min(...valid) : asBefore;
}

/** The latest scheduled moment (a time of day, on a weekday for weekly) that is not after `now`, in the person's zone. */
export function lastScheduled(now: number, tzName: string | null, time: string, weekday: number | null): number {
  const tz = validTimezone(tzName);
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const today = localDate(now, tz);
  for (let back = 0; back < 8; back++) {
    const d = addDays(today, -back);
    if (weekday !== null && new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() !== weekday) continue;
    const at = wallToUtc(d.y, d.m, d.d, hh, mm, tz);
    if (at <= now) return at;
  }
  return now;
}

/**
 * Make the digest that is due for a PURSS, if any. Counting it, moving the window's end and recording the notification
 * happen in one transaction, so a failure leaves the window where it was and the digest is made again whole, and a digest
 * is never made twice for the same window. The end of the window (`notification_state.window_end`) is the durable record
 * of what has been covered; it is not a notification, so pruning notifications can never make a digest be sent again.
 * The digest also goes by email when the person keeps that on and the account's address is confirmed.
 * Returns whether a notification was created.
 */
export function runDigest(app: App, workspaceId: string, accountId: string, now: Date = new Date()): boolean {
  const prefs = getPreferences(app, workspaceId);
  const freq = prefs.notifications.frequency;
  if (freq !== "daily" && freq !== "weekly") return false;
  const made = app.db.tx(() => {
    const state = app.db.get<{ window_end: string }>("SELECT window_end FROM notification_state WHERE workspace_id = ?", workspaceId);
    if (!state) {
      app.db.run("INSERT INTO notification_state (workspace_id, window_end) VALUES (?, ?)", workspaceId, now.toISOString());
      return false;
    }
    const due = lastScheduled(now.getTime(), prefs.timezone, prefs.notifications.digestTime, freq === "weekly" ? prefs.notifications.digestDay : null);
    if (due <= Date.parse(state.window_end)) return false;
    const window = { from: state.window_end, to: now.toISOString() };
    const d = digestFor(app, workspaceId, window);
    app.db.run("UPDATE notification_state SET window_end = ? WHERE workspace_id = ?", window.to, workspaceId);
    if (!d.total) return false;
    const text = digestText(d, freq);
    // Named by the window it covers: the same window can only be recorded once.
    const recorded = app.db.run("INSERT OR IGNORE INTO notifications (id, workspace_id, kind, title, body, dedup_key, created_at) VALUES (?, ?, 'arrivals', ?, ?, ?, ?)",
      newId("ntf"), workspaceId, text.title, text.body, `digest:${freq}:${window.from}`, window.to).changes > 0;
    return recorded ? d : null;
  });
  if (!made) return false;
  emit(app, accountId, { type: "notification" });
  if (prefs.notifications.emailDigest) {
    const account = app.db.get<{ email: string | null; email_verified_at: string | null }>("SELECT email, email_verified_at FROM accounts WHERE id = ?", accountId);
    if (account?.email && account.email_verified_at) sendLater(app, "digest", accountId, digestMail(account.email, digestEmail(app, made, freq, now)));
  }
  return true;
}

/** A failure of a source is told about again no sooner than this after the last time. */
const PROBLEM_COOLDOWN_MS = 24 * 3_600_000;
/** Failed text saves older than this are not announced (they were not noticed in time, and nobody is waiting for them). */
const CAPTURE_NEWS_MS = 48 * 3_600_000;

/**
 * Tell about sources that have stopped working and readable-text copies that could not be saved, when the person asked for
 * it, once for each failure. Which failure was told about is kept on the source (its episode: what is wrong and since when
 * it last worked) and on the capture (the moment that attempt failed), so nothing is told twice however often this runs or
 * however old notifications are pruned. A new attempt that fails is a new failure and is told about; a source that
 * recovered and fails again is too, after a day.
 */
export function runProblemCheck(app: App, workspaceId: string, accountId: string, now: Date = new Date()): number {
  const prefs = getPreferences(app, workspaceId);
  if (prefs.notifications.frequency === "off") return 0;
  const inc = prefs.notifications.include;
  const iso = now.toISOString();
  const made = app.db.tx(() => {
    let n = 0;
    if (inc.problems) {
      // A source that works again is forgotten, so its next failure is a new one.
      app.db.run("UPDATE sources SET problem_notified_for = NULL WHERE workspace_id = ? AND problem_notified_for IS NOT NULL AND health NOT IN ('error', 'reconnect')", workspaceId);
      const rested = new Date(now.getTime() - PROBLEM_COOLDOWN_MS).toISOString();
      for (const s of app.db.all<{ id: string; title: string; health_text: string | null; episode: string }>(
        `SELECT id, title, health_text, health || ':' || COALESCE(last_success_at, created_at) AS episode FROM sources
         WHERE workspace_id = ? AND followed = 1 AND kind <> 'manual' AND health IN ('error', 'reconnect') AND notify <> 'muted'
           AND (problem_notified_for IS NULL OR problem_notified_for <> health || ':' || COALESCE(last_success_at, created_at))
           AND (problem_notified_at IS NULL OR problem_notified_at < ?)`, workspaceId, rested)) {
        n += app.db.run(
          "INSERT INTO notifications (id, workspace_id, kind, title, body, source_id, dedup_key, created_at) VALUES (?, ?, 'source', ?, ?, ?, ?, ?)",
          newId("ntf"), workspaceId, `${s.title} isn't working`, s.health_text, s.id, `source:${s.id}:${iso}`, iso).changes;
        app.db.run("UPDATE sources SET problem_notified_for = ?, problem_notified_at = ? WHERE id = ?", s.episode, iso, s.id);
      }
    }
    if (inc.captures) n += notifyCaptureFailures(app, workspaceId, prefs.timezone, now);
    return n;
  });
  if (made) emit(app, accountId, { type: "notification" });
  return made;
}

/**
 * Tell about readable copies that could not be saved: one notification per place and day, naming it and counting items (not
 * attempts: an item that failed twice is one), that opens the list of that place filtered to the failed items. The place is
 * the followed source the item comes from; an item with no feed of its own to open (a link kept by hand, or an item of a
 * source no longer followed) is told about under the basket that holds it. Only where the person asked for text: the copy was
 * asked for (Keep in a basket that keeps text, "Keep readable text too" on a link, Try again), the source has full articles on,
 * or a basket that keeps readable text holds the item. An item that has a copy by now (or one on the way) is not news. A later
 * failure the same day grows that day's notification and makes it unread again. Each failure is told about once, however
 * often this runs or notifications are pruned.
 */
function notifyCaptureFailures(app: App, workspaceId: string, timezone: string | null, now: Date): number {
  const recent = new Date(now.getTime() - CAPTURE_NEWS_MS).toISOString();
  const failed = app.db.all<{ id: string; item_id: string; source_id: string | null; source_title: string | null; kind: string | null; followed: number | null; basket_id: string | null }>(
    `SELECT c.id, c.item_id, s.id AS source_id, s.title AS source_title, s.kind, s.followed,
       (SELECT b.basket_id FROM basket_items b JOIN baskets k ON k.id = b.basket_id WHERE b.item_id = i.id ORDER BY (k.capture_mode = 'text') DESC, b.kept_at LIMIT 1) AS basket_id
     FROM captures c JOIN items i ON i.id = c.item_id LEFT JOIN sources s ON s.id = i.source_id
     WHERE c.workspace_id = ? AND c.status = 'failed' AND c.completed_at >= ? AND c.completed_at <= ?
       AND (c.failure_notified_for IS NULL OR c.failure_notified_for <> c.completed_at)
       AND COALESCE(s.notify, 'default') <> 'muted'
       AND NOT ${settledCopy("c.item_id")}
       AND (c.requested = 1 OR (s.full_text = 1 AND s.followed = 1)
         OR EXISTS (SELECT 1 FROM basket_items b JOIN baskets k ON k.id = b.basket_id WHERE b.item_id = i.id AND k.capture_mode = 'text'))
     LIMIT 500`, workspaceId, recent, now.toISOString());
  if (!failed.length) return 0;
  const { y, m, d } = localDate(now, validTimezone(timezone));
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  type Group = { key: string; sourceId: string | null; basketId: string | null; name: string; links: boolean; items: Set<string> };
  const groups = new Map<string, Group>();
  for (const f of failed) {
    const feed = f.source_id !== null && f.followed === 1 && f.kind !== "manual";
    if (!feed && !f.basket_id) continue; // nowhere to open it: not told about, and not told about later either
    const key = feed ? `source:${f.source_id}` : `basket:${f.basket_id}`;
    const group = groups.get(key) ?? {
      key, sourceId: feed ? f.source_id : null, basketId: feed ? null : f.basket_id,
      name: feed ? f.source_title! : app.db.get<{ name: string }>("SELECT name FROM baskets WHERE id = ?", f.basket_id!)!.name, links: true, items: new Set<string>(),
    };
    group.items.add(f.item_id);
    if (feed || (f.source_id !== null && f.kind !== "manual")) group.links = false;
    groups.set(key, group);
  }
  let changed = 0;
  for (const g of groups.values()) {
    const dedup = `capture-failures:${g.key}:${day}`;
    const earlier = app.db.get<{ id: string; data: string | null }>("SELECT id, data FROM notifications WHERE workspace_id = ? AND dedup_key = ?", workspaceId, dedup);
    const before = earlier?.data ? (JSON.parse(earlier.data) as { items: string[]; links?: boolean }) : null;
    const items = new Set<string>([...(before?.items ?? []), ...g.items]);
    const links = g.links && (before?.links ?? true);
    const title = g.sourceId ? `Couldn't save the text of ${plural(items.size, "item")} from ${g.name}`
      : `Couldn't save the text of ${plural(items.size, links ? "kept link" : "kept item")} in ${g.name}`;
    const body = "The details and feed content are still kept. Open the list to see which, and try again from an item.";
    const data = JSON.stringify({ items: [...items], filter: "capture-failed", ...(g.basketId ? { basketId: g.basketId, links } : {}) });
    changed += earlier
      ? app.db.run("UPDATE notifications SET title = ?, body = ?, data = ?, read_at = NULL WHERE id = ?", title, body, data, earlier.id).changes
      : app.db.run("INSERT INTO notifications (id, workspace_id, kind, title, body, source_id, dedup_key, data, created_at) VALUES (?, ?, 'system', ?, ?, ?, ?, ?, ?)",
        newId("ntf"), workspaceId, title, body, g.sourceId, dedup, data, now.toISOString()).changes;
  }
  app.db.run(`UPDATE captures SET failure_notified_for = completed_at WHERE workspace_id = ? AND id IN (${failed.map(() => "?").join(",")})`, workspaceId, ...failed.map((f) => f.id));
  return changed;
}

/** Delete notifications older than 90 days and any beyond the newest 500. */
export function pruneNotifications(app: App, workspaceId: string, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - NOTIFICATION_KEEP_DAYS * 86_400_000).toISOString();
  let n = app.db.run("DELETE FROM notifications WHERE workspace_id = ? AND created_at < ?", workspaceId, cutoff).changes;
  n += app.db.run(
    `DELETE FROM notifications WHERE workspace_id = ? AND id IN (
       SELECT id FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`, workspaceId, workspaceId, NOTIFICATION_KEEP_COUNT).changes;
  return n;
}

/** An unfollowed source's notifications go with it. */
export function deleteSourceNotifications(app: App, sourceId: string): number {
  return app.db.run("DELETE FROM notifications WHERE source_id = ?", sourceId).changes;
}

/** Whether anything about new items reaches the person (the bell badge follows this). */
export function notificationsOn(prefs: Preferences): boolean {
  return prefs.notifications.frequency !== "off";
}

// ---------- reading ----------

/** What a capture-failure notification opens: its list filter, and the basket when it has no source to open. */
function captureFailureLink(data: string | null): { listFilter?: "capture-failed"; basketId?: string } {
  const d = data ? (JSON.parse(data) as { filter?: string; basketId?: string }) : null;
  return d?.filter === "capture-failed" ? { listFilter: "capture-failed", ...(d.basketId ? { basketId: d.basketId } : {}) } : {};
}

export function listNotifications(app: App, p: Principal, limit = 50): NotificationDTO[] {
  return app.db.all<{ id: string; kind: NotificationDTO["kind"]; title: string; body: string | null; item_id: string | null; source_id: string | null; data: string | null; created_at: string; read_at: string | null }>(
    "SELECT id, kind, title, body, item_id, source_id, data, created_at, read_at FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?", p.workspaceId, limit,
  ).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, itemId: n.item_id, sourceId: n.source_id, createdAt: n.created_at, read: n.read_at !== null,
    ...captureFailureLink(n.data) }));
}

/** Unread notifications for the bell; none while notifications are off. */
export function unreadCount(app: App, workspaceId: string): number {
  if (!notificationsOn(getPreferences(app, workspaceId))) return 0;
  return app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND read_at IS NULL", workspaceId)!.n;
}

export function markNotificationsRead(app: App, p: Principal, ids: string[] | "all"): number {
  if (ids === "all") return app.db.run("UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL", nowIso(), p.workspaceId).changes;
  let n = 0;
  for (const id of ids) n += app.db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND workspace_id = ? AND read_at IS NULL", nowIso(), id, p.workspaceId).changes;
  return n;
}
