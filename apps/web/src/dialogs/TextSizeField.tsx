import { Segmented } from "@purss/ui";
import { TEXT_SIZES, setTextSize, useTextSize } from "../lib/text-size.ts";
import type { TextSize } from "../lib/text-size.ts";

/** Text size for this device: it scales the whole interface, and is kept here rather than with the account. */
export function TextSizeField() {
  const size = useTextSize();
  return (
    <div className="field"><div className="lbl" id="ts-l">Text size</div>
      <Segmented labelledBy="ts-l" value={String(size)} onChange={(v) => setTextSize(Number(v) as TextSize)} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
        options={TEXT_SIZES.map((n) => ({ value: String(n), label: `${n}%` }))} />
      <p className="fine">Makes text and controls larger. Saved on this device only.</p>
    </div>
  );
}
