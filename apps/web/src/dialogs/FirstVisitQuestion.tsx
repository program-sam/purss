import { useState } from "react";
import { Button, Dialog, SelectInput, TextInput } from "@purss/ui";
import { FREQUENCY_LABELS, WEEKDAYS, freshDaysChoices } from "../lib/returning.ts";
import { useSavePreferences } from "../state/prefs.ts";
import { useWorkspace } from "../state/workspace.tsx";

type Frequency = "off" | "arrivals" | "daily" | "weekly";
const CHOICES: Frequency[] = ["daily", "weekly", "arrivals", "off"];

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
  const n = ws.data.preferences.notifications;
  // The suggestion is a daily digest at 08:00, unless the person has already said they want nothing.
  const [frequency, setFrequency] = useState<Frequency>(n.frequency === "off" ? "off" : "daily");
  const [time, setTime] = useState(n.digestTime);
  const [day, setDay] = useState(n.digestDay);
  const [days, setDays] = useState(ws.data.preferences.freshDays);

  const done = (keep: boolean) => void save(keep
    ? { welcomeAsked: true }
    : { welcomeAsked: true, freshDays: days, notifications: { ...n, frequency, digestTime: time, digestDay: day } });

  return (
    <Dialog title="How should we keep you posted?" size="md" onClose={() => done(true)} initialFocus='input[name="freq"]:checked'
      footer={<><Button onClick={() => done(true)}>Not now</Button><Button variant="primary" onClick={() => done(false)}>Save</Button></>}>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>How often should we tell you about new things?</legend>
        <div className="radiolist">
          {CHOICES.map((v) => (
            <label key={v} className="rl" style={{ alignItems: "flex-start", padding: 10 }}>
              <input type="radio" name="freq" checked={frequency === v} onChange={() => setFrequency(v)} />
              <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
              <span style={{ display: "grid", gap: 2 }}><span>{FREQUENCY_LABELS[v].label}{v === "daily" ? " (suggested)" : ""}</span><span className="fine">{FREQUENCY_LABELS[v].blurb}</span></span>
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
        <p className="fine">Times are in your time zone. Notifications arrive in the bell; you can add browser alerts in Settings.</p>
      </fieldset>
      <div className="field"><label htmlFor="fresh-days">How long should items stay marked New?</label>
        <SelectInput id="fresh-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {freshDaysChoices(ws.data.preferences.freshDays).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </SelectInput>
        <p className="fine">Only the New marker goes away. The items stay where they are.</p></div>
      <p className="fine">You can change both any time in Settings, under Notifications and New.</p>
    </Dialog>
  );
}
