import { useState } from "react";
import { app } from "@purss/copy/app";
import type { MutedWord } from "@purss/domain";
import { Button, Icon, IconButton, SelectInput, TextInput } from "@purss/ui";
import { shortDate } from "../lib/format.ts";
import { muteUntil, withMutedWord } from "../lib/muted-words.ts";
import type { MuteFor } from "../lib/muted-words.ts";
import { useSavePreferences } from "../state/prefs.ts";
import { useWorkspace } from "../state/workspace.tsx";

const t = app.dialogs.mutedWords;

const FOR_LABELS: Record<MuteFor, string> = t.forLabels;

/** Settings → Muted words: words or phrases whose items Home and lists leave out, for a week, a month or until removed. */
export function MutedWordsField() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const [text, setText] = useState("");
  const [length, setLength] = useState<MuteFor>("month");
  const now = Date.now();
  // A word whose time has passed no longer mutes anything and is dropped with the next save.
  const words = ws.prefs.mutedWords.filter((w) => w.until === null || Date.parse(w.until) > now);
  const add = () => {
    const word = text.trim();
    if (!word) return;
    void save({ mutedWords: withMutedWord(words, word, muteUntil(length, new Date())) });
    setText("");
  };
  const remove = (w: MutedWord) => void save({ mutedWords: words.filter((x) => x.text !== w.text) });
  return (
    <fieldset className="field" aria-describedby="mw-hint"><legend className="lbl" style={{ marginBottom: 6 }}>{t.title}</legend>
      <p className="fine" id="mw-hint">{t.hint}</p>
      {words.length ? (
        <ul className="ordlist" aria-label="Muted words">
          {words.map((w) => (
            <li className="ordrow" key={w.text}>
              <span className="nm" dir="auto">{w.text}</span>
              <span className="fine">{w.until ? t.until(shortDate(w.until, now, ws.prefs.timezone)) : t.untilRemoved}</span>
              <IconButton label={`Stop muting “${w.text}”`} onClick={() => remove(w)}><Icon name="x" /></IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="two" style={{ gridTemplateColumns: "2fr 1fr auto", gap: 8, alignItems: "end", marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label className="field" style={{ gap: 4 }}><span className="lbl">{t.wordLabel}</span>
          <TextInput value={text} maxLength={80} onChange={(e) => setText(e.target.value)} placeholder={t.placeholder} /></label>
        <label className="field" style={{ gap: 4 }}><span className="lbl">{t.howLong}</span>
          <SelectInput value={length} onChange={(e) => setLength(e.target.value as MuteFor)}>
            {(Object.keys(FOR_LABELS) as MuteFor[]).map((k) => <option key={k} value={k}>{FOR_LABELS[k]}</option>)}
          </SelectInput></label>
        <Button type="submit" disabled={!text.trim()}>{t.mute}</Button>
      </form>
    </fieldset>
  );
}
