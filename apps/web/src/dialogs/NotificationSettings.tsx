import { useState } from "react";
import type { NotificationFrequency, NotificationInclude, Preferences } from "@purss/domain";
import { useQuery } from "@tanstack/react-query";
import { Button, Check, Icon, SelectInput, TextInput } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { accountEmailQuery } from "../auth/AccountEmailSection.tsx";
import type { NotifyPermission } from "../lib/browser-notify.ts";
import { FREQUENCY_LABELS, WEEKDAYS, freshDaysChoices } from "../lib/returning.ts";
import { OTHER_BOX_ID } from "../pages/home-boxes.ts";
import { useSavePreferences } from "../state/prefs.ts";
import { platform } from "../platform/index.ts";
import { useWorkspace } from "../state/workspace.tsx";

const FREQUENCIES: NotificationFrequency[] = ["arrivals", "daily", "weekly", "off"];

/** Settings → Notifications and New: how and when to be told, what about, quiet hours, and how New markers behave. */
export function NotificationSettings() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const p = ws.prefs;
  const n = p.notifications;
  const [perm, setPerm] = useState<NotifyPermission>(platform.notifier.permission());
  const set = (patch: Partial<Preferences["notifications"]>) => void save({ notifications: { ...n, ...patch } });
  const include = (patch: Partial<NotificationInclude>) => set({ include: { ...n.include, ...patch } });
  const chosen = n.include.newItems === "all" ? null : n.include.newItems;
  const pickable = [...ws.collections.map((c) => ({ id: c.id, name: c.name })), ...(ws.looseSources.length ? [{ id: OTHER_BOX_ID, name: "Other sources" }] : [])];
  const toggleBox = (id: string, on: boolean) => include({ newItems: on ? [...new Set([...(chosen ?? []), id])] : (chosen ?? []).filter((x) => x !== id) });
  const off = n.frequency === "off";
  const computer = platform.notifier.kind === "computer";
  // Reminders by email need outgoing email on this installation and a confirmed address on the account.
  const session = useSession().data;
  const email = useQuery({ ...accountEmailQuery, enabled: !!session?.installation.accountEmail }).data;
  const mailReminders = !!session?.installation.mail && !!email?.address && email.confirmed;
  const address = email?.address ?? "";

  return (
    <div className="nset" style={{ display: "grid", gap: 16 }}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Tell me about new items</legend>
        <div className="radiolist">
          {FREQUENCIES.map((v) => (
            <label key={v} className="rl" style={{ alignItems: "flex-start" }}>
              <input type="radio" name="nfreq" checked={n.frequency === v} onChange={() => set({ frequency: v })} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{FREQUENCY_LABELS[v].label}</span><span className="fine">{FREQUENCY_LABELS[v].blurb}</span></span>
            </label>
          ))}
        </div>
        {n.frequency === "daily" || n.frequency === "weekly" ? (
          <div className="two" style={{ gridTemplateColumns: n.frequency === "weekly" ? "1fr 1fr" : "1fr", gap: 8, marginTop: 8 }}>
            {n.frequency === "weekly" ? (
              <SelectInput aria-label="Day of the week" value={n.digestDay} onChange={(e) => set({ digestDay: Number(e.target.value) })}>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
              </SelectInput>
            ) : null}
            <TextInput type="time" aria-label="Time of the digest" value={n.digestTime} onChange={(e) => e.target.value && set({ digestTime: e.target.value })} />
          </div>
        ) : null}
        <p className="fine">Times are in your time zone ({p.timezone.replace(/_/g, " ")}). New items arrive in batches when sources are checked; it isn't instant.</p>
      </fieldset>

      <fieldset className="field" disabled={off} style={{ opacity: off ? 0.55 : 1 }}><legend className="lbl" style={{ marginBottom: 6 }}>What to tell me about</legend>
        <div className="inc">
          <div className="radiolist">
            <label className="rl"><input type="radio" name="ninc" checked={chosen === null} onChange={() => include({ newItems: "all" })} /><span className="radio" aria-hidden="true" />New items from every collection shown on Home</label>
            <label className="rl"><input type="radio" name="ninc" checked={chosen !== null} onChange={() => include({ newItems: ws.collections.filter((c) => c.showOnHome).map((c) => c.id) })} /><span className="radio" aria-hidden="true" />New items only from these collections</label>
          </div>
          {chosen !== null ? (
            <div className="cols">{pickable.length ? pickable.map((b) => <Check key={b.id} checked={chosen.includes(b.id)} onChange={(v) => toggleBox(b.id, v)}>{b.name}</Check>) : <p className="fine">No collections yet.</p>}</div>
          ) : <p className="fine" style={{ marginLeft: 28 }}>Collections you hide from Home in Customise Home are left out.</p>}
          <Check checked={n.include.problems} onChange={(v) => include({ problems: v })}>Sources that stop working</Check>
          <Check checked={n.include.reminders} onChange={(v) => include({ reminders: v })} hint="“On this day” notes about kept items, and your Remind me days. Turn the notes off in General.">Reminders</Check>
          {mailReminders ? <div style={{ marginLeft: 28 }}><Check checked={n.emailReminders} disabled={!n.include.reminders} onChange={(v) => set({ emailReminders: v })} hint={`Also email your Remind me days to ${address}. Item titles are left out unless you show titles in notifications.`}>Email me reminders</Check></div> : null}
          <Check checked={n.include.captures} onChange={(v) => include({ captures: v })}>Readable text that failed to save</Check>
        </div>
        <Check checked={n.previews} onChange={(v) => set({ previews: v })} hint="Off by default, so a notification doesn't reveal what you follow on a shared screen. Private sources never show titles.">Show item titles in notifications</Check>
      </fieldset>

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Where they show</legend>
        {platform.push ? <p className="fine">In the bell, and as notifications on this phone when you turn them on in <b>This device</b>.</p> : <><div className="radiolist">
          {([["inapp", "In PURSS", "A list in the bell. Nothing leaves this page."], computer
            ? ["browser", "Also as notifications on this computer", "A system notification when something arrives while the app is running, also with its window closed."] as const
            : ["browser", "Also as browser alerts", "A system notification when something arrives while this page is open."] as const] as const).map(([v, label, blurb]) => (
            <label key={v} className="rl" style={{ alignItems: "flex-start" }}>
              <input type="radio" name="nmode" checked={n.mode === v} onChange={() => set({ mode: v })} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{label}</span><span className="fine">{blurb}</span></span>
            </label>
          ))}
        </div>
        {n.mode === "browser" && !computer ? (
          <div className="field">
            {perm === "granted" ? <p className="state"><Icon name="check" size="sm" />Your browser allows notifications from this page.</p> : null}
            {perm === "default" ? <div><Button onClick={async () => setPerm(await platform.notifier.request())}>Allow browser notifications</Button></div> : null}
            {perm === "denied" ? <p className="state note"><Icon name="info" /><span>Your browser blocks notifications from this site. Allow them in the browser's site settings. New items still appear in the bell.</span></p> : null}
            {perm === "unsupported" ? <p className="state note"><Icon name="info" /><span>This browser can't show notifications. Arrivals still appear in the bell.</span></p> : null}
          </div>
        ) : null}</>}
        <div className="field"><div className="lbl" id="qh">Quiet hours</div>
          <div className="two" style={{ gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
            <TextInput type="time" aria-label="Quiet hours start" value={n.quietStart ?? ""} onChange={(e) => set({ quietStart: e.target.value || null, quietEnd: n.quietEnd ?? (e.target.value ? "07:00" : null) })} />
            <TextInput type="time" aria-label="Quiet hours end" value={n.quietEnd ?? ""} onChange={(e) => set({ quietEnd: e.target.value || null, quietStart: n.quietStart ?? (e.target.value ? "22:00" : null) })} />
            <Button disabled={!n.quietStart && !n.quietEnd} onClick={() => set({ quietStart: null, quietEnd: null })}>Clear</Button>
          </div>
          <p className="fine">Browser alerts and phone notifications are held back during these hours, in your time zone. Everything still waits in the bell.</p></div>
      </fieldset>

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>New markers</legend>
        <div className="field"><label htmlFor="fresh-days">Keep items marked New for</label>
          <SelectInput id="fresh-days" value={p.freshDays} onChange={(e) => void save({ freshDays: Number(e.target.value) })}>
            {freshDaysChoices(p.freshDays).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </SelectInput>
          <p className="fine">Then the New marker goes away. The item stays where it is.</p></div>
        <Check checked={p.freshMarkers} onChange={(v) => void save({ freshMarkers: v })}>Show New markers</Check>
        <Check checked={p.showCounts} onChange={(v) => void save({ showCounts: v })} hint="Off hides every count of New items, in the sidebar, page headers and Home.">Show counts</Check>
      </fieldset>
    </div>
  );
}
