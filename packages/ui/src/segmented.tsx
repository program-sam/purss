import type { CSSProperties, ReactNode } from "react";

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

/** A row of toggle buttons where exactly one is pressed. Uses aria-pressed, not colour alone. */
export function Segmented<T extends string>({ options, value, onChange, label, labelledBy, style, buttonStyle }: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
  labelledBy?: string;
  style?: CSSProperties;
  buttonStyle?: CSSProperties;
}) {
  return (
    <div className="seg" role="group" aria-label={label} aria-labelledby={labelledBy} style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" data-cuelume-select="" disabled={o.disabled} aria-pressed={o.value === value} style={buttonStyle} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
