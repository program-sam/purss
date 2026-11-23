import { useState } from "react";
import { app } from "@purss/translations/app";
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
import { usePurss } from "../state/purss.tsx";

const t = app.dialogs.notificationSettings;

const FREQUENCIES: NotificationFrequency[] = ["daily", "weekly", "off"];

/** Settings → Notifications and New: how and when to be told, what about, quiet hours, and how New markers behave. */
export function NotificationSettings() {
  const ws = usePurss();
  const save = useSavePreferences();
  const p = ws.prefs;
  const n = p.notifications;
  const [perm, setPerm] = useState<NotifyPermission>(platform.notifier.permission());
  const set = (patch: Partial<Preferences["notifications"]>) => void save({ notifications: { ...n, ...patch } });
  const include = (patch: Partial<NotificationInclude>) => set({ include: { ...n.include, ...patch } });
  const chosen = n.include.newItems === "all" ? null : n.include.newItems;
  const pickable = [...ws.collections.map((c) => ({ id: c.id, name: c.name })), ...(ws.looseSources.length ? [{ id: OTHER_BOX_ID, name: app.words.otherSources }] : [])];
  const toggleBox = (id: string, on: boolean) => include({ newItems: on ? [...new Set([...(chosen ?? []), id])] : (chosen ?? []).filter((x) => x !== id) });
  const computer = platform.notifier.kind === "computer";
  // Digests and reminders by email need outgoing email on this installation and a confirmed address on the account.
  const session = useSession().data;
  const email = useQuery({ ...accountEmailQuery, enabled: !!session?.installation.accountEmail }).data;
  const canEmail = !!session?.installation.mail && !!email?.address && email.confirmed;
  const unconfirmed = !!session?.installation.mail && !!email && !canEmail;
  const address = email?.address ?? "";

  return (
    <div className="nset" style={{ display: "grid", gap: 16 }}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.tellMe}</legend>
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
        {(n.frequency === "daily" || n.frequency === "weekly") && canEmail ? (
          <Check checked={n.emailDigest} onChange={(v) => set({ emailDigest: v })} hint={t.digestEmail(address)}>{t.emailDigest}</Check>
        ) : null}
        {(n.frequency === "daily" || n.frequency === "weekly") && unconfirmed ? <p className="fine">{t.confirmEmail}</p> : null}
        <p className="fine">{t.times(p.timezone.replace(/_/g, " "))}</p>
      </fieldset>

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.whatToTell}</legend>
        <div className="inc">
          <div className="radiolist">
            <label className="rl"><input type="radio" name="ninc" checked={chosen === null} onChange={() => include({ newItems: "all" })} /><span className="radio" aria-hidden="true" />{t.everyCollection}</label>
            <label className="rl"><input type="radio" name="ninc" checked={chosen !== null} onChange={() => include({ newItems: ws.collections.filter((c) => c.showOnHome).map((c) => c.id) })} /><span className="radio" aria-hidden="true" />{t.onlyThese}</label>
          </div>
          {chosen !== null ? (
            <div className="cols">{pickable.length ? pickable.map((b) => <Check key={b.id} checked={chosen.includes(b.id)} onChange={(v) => toggleBox(b.id, v)}>{b.name}</Check>) : <p className="fine">{app.words.noCollectionsYet}</p>}</div>
          ) : <p className="fine" style={{ marginLeft: 28 }}>{t.hiddenLeftOut}</p>}
          <Check checked={n.include.problems} onChange={(v) => include({ problems: v })}>{t.problems}</Check>
          <Check checked={n.include.reminders} onChange={(v) => include({ reminders: v })} hint={t.remindersHint}>{t.reminders}</Check>
          {canEmail ? <div style={{ marginLeft: 28 }}><Check checked={n.emailReminders} disabled={!n.include.reminders} onChange={(v) => set({ emailReminders: v })} hint={t.emailRemindersHint(address)}>{t.emailReminders}</Check></div> : null}
          <Check checked={n.include.captures} onChange={(v) => include({ captures: v })}>{t.captures}</Check>
        </div>
        <Check checked={n.previews} onChange={(v) => set({ previews: v })} hint={t.previewsHint}>{t.previews}</Check>
      </fieldset>

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.whereShow}</legend>
        {platform.push ? <p className="fine">{t.pushNote.before}<b>{app.words.thisDevice}</b>{"."}</p> : <><div className="radiolist">
          {([["inapp", t.modeInapp.label, t.modeInapp.blurb], computer
            ? ["browser", t.modeComputer.label, t.modeComputer.blurb] as const
            : ["browser", t.modeBrowser.label, t.modeBrowser.blurb] as const] as const).map(([v, label, blurb]) => (
            <label key={v} className="rl" style={{ alignItems: "flex-start" }}>
              <input type="radio" name="nmode" checked={n.mode === v} onChange={() => set({ mode: v })} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{label}</span><span className="fine">{blurb}</span></span>
            </label>
          ))}
        </div>
        {n.mode === "browser" && !computer ? (
          <div className="field">
            {perm === "granted" ? <p className="state"><Icon name="check" size="sm" />{t.permGranted}</p> : null}
            {perm === "default" ? <div><Button onClick={async () => setPerm(await platform.notifier.request())}>{t.allowBrowser}</Button></div> : null}
            {perm === "denied" ? <p className="state note"><Icon name="info" /><span>{t.permDenied}</span></p> : null}
            {perm === "unsupported" ? <p className="state note"><Icon name="info" /><span>{t.permUnsupported}</span></p> : null}
          </div>
        ) : null}</>}
        <div className="field"><div className="lbl" id="qh">{t.quietHours}</div>
          <div className="two" style={{ gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
            <TextInput type="time" aria-label="Quiet hours start" value={n.quietStart ?? ""} onChange={(e) => set({ quietStart: e.target.value || null, quietEnd: n.quietEnd ?? (e.target.value ? "07:00" : null) })} />
            <TextInput type="time" aria-label="Quiet hours end" value={n.quietEnd ?? ""} onChange={(e) => set({ quietEnd: e.target.value || null, quietStart: n.quietStart ?? (e.target.value ? "22:00" : null) })} />
            <Button disabled={!n.quietStart && !n.quietEnd} onClick={() => set({ quietStart: null, quietEnd: null })}>{t.clear}</Button>
          </div>
          <p className="fine">{t.quietNote}</p></div>
      </fieldset>

      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.newMarkers}</legend>
        <div className="field"><label htmlFor="fresh-days">{app.words.keepItemsMarkedNewFor}</label>
          <SelectInput id="fresh-days" value={p.freshDays} onChange={(e) => void save({ freshDays: Number(e.target.value) })}>
            {freshDaysChoices(p.freshDays).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </SelectInput>
          <p className="fine">{t.markerGoes}</p></div>
        <Check checked={p.freshMarkers} onChange={(v) => void save({ freshMarkers: v })}>{app.words.showNewMarkers}</Check>
        <Check checked={p.showCounts} onChange={(v) => void save({ showCounts: v })} hint={t.countsHint}>{app.words.showCounts}</Check>
      </fieldset>
    </div>
  );
}
