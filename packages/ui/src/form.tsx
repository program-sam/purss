import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { forwardRef } from "react";
import { Icon } from "./icons.tsx";

/** A labelled control. A short `hint` sits beside the label, and wraps under it where there isn't room. */
export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {hint ? <div className="field-h"><label htmlFor={htmlFor}>{label}</label><span className="fine">{hint}</span></div> : <label htmlFor={htmlFor}>{label}</label>}
      {children}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className = "", ...rest }, ref) {
  return <input ref={ref} className={`in ${className}`.trim()} {...rest} />;
});

export const SelectInput = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function SelectInput({ className = "", ...rest }, ref) {
  return <select ref={ref} className={`sel-in ${className}`.trim()} {...rest} />;
});

/** Checkbox with a visible box and an optional second line of explanation. */
export function Check({ checked, onChange, children, hint, disabled, name }: {
  checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: ReactNode; disabled?: boolean; name?: string;
}) {
  return (
    <label className="chk">
      <input type="checkbox" data-cuelume-toggle="" name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="cb" aria-hidden="true"><Icon name="check" /></span>
      {hint ? <span>{children}<small>{hint}</small></span> : children}
    </label>
  );
}
