import { DEFAULT_PREFERENCES } from "@purss/domain";
import type { Preferences } from "@purss/domain";
import { z } from "zod";
import type { App } from "../app.ts";
import { nowIso } from "../http.ts";

const time = z.string().regex(/^\d{2}:\d{2}$/).nullable();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const notificationsPatch = z.object({
  // "off" is what older exports say; it reads as the frequency "off" (see merge).
  mode: z.enum(["off", "inapp", "browser"]),
  // "arrivals" (told as items arrive) is what older exports and stored choices may say; it reads as "weekly" (see merge).
  frequency: z.enum(["off", "arrivals", "daily", "weekly"]),
  digestTime: clock,
  digestDay: z.number().int().min(0).max(6),
  include: z.object({
    newItems: z.union([z.literal("all"), z.array(z.string()).max(200)]),
    problems: z.boolean(),
    reminders: z.boolean(),
    captures: z.boolean(),
  }).partial(),
  quietStart: time,
  quietEnd: time,
  previews: z.boolean(),
  emailReminders: z.boolean(),
  emailDigest: z.boolean(),
}).partial();
export const preferencesPatchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  skin: z.enum(["sky", "lilac", "meadow"]),
  density: z.enum(["comfortable", "compact"]),
  homeLayout: z.enum(["collections", "feed", "new", "front"]),
  homeCollectionIds: z.array(z.string()).max(200),
  homeOther: z.boolean(),
  freshMarkers: z.boolean(),
  showCounts: z.boolean(),
  reminders: z.boolean(),
  freshDays: z.number().int().min(0).max(365),
  welcomeAsked: z.boolean(),
  notifications: notificationsPatch,
  mutedWords: z.array(z.object({ text: z.string().trim().min(1).max(80), until: z.iso.datetime().nullable() })).max(100).refine(
    (words) => new Set(words.map((w) => w.text.toLowerCase())).size === words.length, "Each muted word is listed once."),
  timezone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }).nullable(),
  discoveryShare: z.boolean(),
}).partial();

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

export function getPreferences(app: App, workspaceId: string): Preferences {
  const row = app.db.get<{ value: string }>("SELECT value FROM preferences WHERE workspace_id = ?", workspaceId);
  const stored = row ? (JSON.parse(row.value) as Partial<Preferences>) : {};
  return merge(DEFAULT_PREFERENCES, stored);
}

function merge(base: Preferences, patch: Partial<Preferences> | PreferencesPatch): Preferences {
  const { notifications: n, ...rest } = patch;
  const next = { ...base, ...rest } as Preferences;
  if (n) {
    const legacyOff = (n.mode as string | undefined) === "off";
    const legacyArrivals = (n.frequency as string | undefined) === "arrivals";
    next.notifications = {
      ...base.notifications, ...n, ...(legacyArrivals ? { frequency: "weekly" } : {}), ...(legacyOff ? { mode: "inapp", frequency: "off" } : {}),
      include: { ...base.notifications.include, ...(n.include ?? {}) },
    } as Preferences["notifications"];
  }
  return next;
}

export function setPreferences(app: App, workspaceId: string, patch: PreferencesPatch): Preferences {
  const before = getPreferences(app, workspaceId);
  const next = merge(before, patch);
  // Muted words that have ended are dropped when the list is next saved.
  next.mutedWords = next.mutedWords.filter((w) => w.until === null || Date.parse(w.until) > Date.now());
  app.db.tx(() => {
    app.db.run("INSERT INTO preferences (workspace_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      workspaceId, JSON.stringify(next), nowIso());
    // Stopping (or starting) sharing for Discover reaches the suggestions at the next rebuild, which then comes soon.
    if (before.discoveryShare !== next.discoveryShare) app.db.run("UPDATE discovery_state SET dirty = 1");
    // A new way of being told starts from now: switching to a digest does not send everything from before the switch.
    if (before.notifications.frequency !== next.notifications.frequency) {
      app.db.run(
        `INSERT INTO notification_state (workspace_id, window_end) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET window_end = excluded.window_end`, workspaceId, nowIso());
    }
  });
  return next;
}
