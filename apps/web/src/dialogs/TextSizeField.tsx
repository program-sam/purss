import { app } from "@purss/translations/app";
import { Segmented } from "@purss/ui";
import { TEXT_SIZES, setTextSize, useTextSize } from "../lib/text-size.ts";
import type { TextSize } from "../lib/text-size.ts";

const t = app.dialogs.textSizeField;

/** Text size for this device: it scales the whole interface, and is kept here rather than with the account. */
export function TextSizeField() {
  const size = useTextSize();
  return (
    <div className="field"><div className="lbl" id="ts-l">{t.label}</div>
      <Segmented labelledBy="ts-l" value={String(size)} onChange={(v) => setTextSize(Number(v) as TextSize)} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
        options={TEXT_SIZES.map((n) => ({ value: String(n), label: `${n}%` }))} />
      <p className="fine">{t.hint}</p>
    </div>
  );
}
