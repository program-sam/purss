import { useState } from "react";
import { app } from "@purss/copy/app";
import type { NotificationFrequency } from "@purss/domain";
import { useQuery } from "@tanstack/react-query";
import { Button, Check, Dialog, SelectInput, TextInput } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { accountEmailQuery } from "../auth/AccountEmailSection.tsx";
import { FREQUENCY_LABELS, WEEKDAYS, freshDaysChoices } from "../lib/returning.ts";
import { useSavePreferences } from "../state/prefs.ts";
import { useWorkspace } from "../state/workspace.tsx";

const t = app.dialogs.firstVisitQuestion;

const CHOICES: NotificationFrequency[] = ["weekly", "daily", "off"];

/**
 * Asked once per account after signing in (also for accounts that existed before the question did): how often to be
 * told about new things, and how long items stay marked New. Skipping keeps what is set; both stay in Settings.
 */
export function FirstVisitQuestion() {
  const ws = useWorkspace();
  if (ws.data.preferences.welcomeAsked) return null;
  return <Question />;
}

function Question() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const preferences = ws.data.preferences;
  const n = ws.data.preferences.notifications;
  // The suggestion is a weekly digest on Monday at 08:00, unless the person has already said they want nothing.
  const [frequency, setFrequency] = useState<NotificationFrequency>(n.frequency === "off" ? "off" : "weekly");
  const [time, setTime] = useState(n.digestTime);
  const [day, setDay] = useState(n.digestDay);
  const [days, setDays] = useState(ws.data.preferences.freshDays);
  const [discoveryShare, setDiscoveryShare] = useState(preferences.discoveryShare);
  // A digest also goes by email when this installation sends email and the account's address is confirmed.
  const session = useSession().data;
  const hosted = session?.installation.mode === "hosted";
  const email = useQuery({ ...accountEmailQuery, enabled: !!session?.installation.accountEmail }).data;
  const emailed = !!session?.installation.mail && !!email?.address && email.confirmed && n.emailDigest;

  const done = (keep: boolean) => void save(keep
    ? { welcomeAsked: true }
    : { welcomeAsked: true, freshDays: days, notifications: { ...n, frequency, digestTime: time, digestDay: day }, ...(hosted ? { discoveryShare } : {}) });

  return (
    <Dialog title={t.title} size="md" onClose={() => done(true)} initialFocus='input[name="freq"]:checked'
      footer={<><Button onClick={() => done(true)}>{t.notNow}</Button><Button variant="primary" onClick={() => done(false)}>{t.save}</Button></>}>
      <fieldset className="field"><legend className="sr">{t.title}</legend>
        <div className="radiolist">
          {CHOICES.map((v) => (
            <label key={v} className="rl" style={{ alignItems: "flex-start", padding: 10 }}>
              <input type="radio" name="freq" checked={frequency === v} onChange={() => setFrequency(v)} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{FREQUENCY_LABELS[v].label}{v === "weekly" ? t.suggested : ""}</span><span className="fine">{FREQUENCY_LABELS[v].blurb}</span></span>
            </label>
          ))}
        </div>
        {frequency === "daily" || frequency === "weekly" ? (
          <div className="two" style={{ gridTemplateColumns: frequency === "weekly" ? "1fr 1fr" : "1fr", gap: 8, marginTop: 8 }}>
            {frequency === "weekly" ? (
              <SelectInput aria-label="Day of the week" value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
              </SelectInput>
            ) : null}
            <TextInput type="time" aria-label="Time of day" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} />
          </div>
        ) : null}
        <p className="fine">{frequency === "off"
          ? t.digestOff
          : emailed
            ? t.digestEmailed(email.address)
            : t.digestBell}</p>
      </fieldset>
      {hosted ? <div className="field" style={{ gap: 2 }}>
        <Check checked={discoveryShare} onChange={setDiscoveryShare}
          hint={t.shareHint}>
          {t.shareSources}
        </Check>
      </div> : null}
      <div className="field"><label htmlFor="fresh-days">{t.keepNewFor}</label>
        <SelectInput id="fresh-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {freshDaysChoices(ws.data.preferences.freshDays).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </SelectInput>
        <p className="fine">{t.markerOnly}</p></div>
      <p className="fine">{t.changeAnytime}</p>
    </Dialog>
  );
}
