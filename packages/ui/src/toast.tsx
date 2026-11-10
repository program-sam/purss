import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

export type ToastAction = { label: string; onSelect: () => void };

/** Presentational toast: a message, optional actions (Undo first), and a dismiss button. */
export function ToastView({ message, undo, actions = [], onDismiss, onHold, onRelease }: {
  message: ReactNode; undo?: (() => void) | null; actions?: ToastAction[]; onDismiss: () => void; onHold?: () => void; onRelease?: () => void;
}) {
  return (
    <div className="toast" onMouseEnter={onHold} onMouseLeave={onRelease} onFocus={onHold} onBlur={onRelease}>
      <span className="tx">{message}</span>
      {undo ? <button type="button" className="ta undo" aria-keyshortcuts="Control+Z Meta+Z" title="Undo (Ctrl+Z)" onClick={undo}>Undo</button> : null}
      {actions.map((a) => <button key={a.label} type="button" className="ta" onClick={a.onSelect}>{a.label}</button>)}
      <button type="button" className="x" aria-label="Dismiss" onClick={onDismiss}><Icon name="x" size="sm" /></button>
    </div>
  );
}
