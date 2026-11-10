import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Icon } from "@purss/ui";
import { messageOf } from "../../api/client.ts";
import { useToasts } from "../../state/toasts.tsx";
import { Trail } from "../../shell/crumbs.tsx";

/** Page frame: title, one calm sentence, then the sections. */
export function Page({ title, lead, narrow = true, children, wide }: { title: string; lead?: ReactNode; narrow?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`col ${wide ? "wide" : narrow ? "narrow page" : ""}`.trim()}>
      <Trail />
      <div className="phead"><h1>{title}</h1>{lead ? <p className="lead">{lead}</p> : null}</div>
      <div className="fx-stack">{children}</div>
    </div>
  );
}

/** A titled block on a page. `actions` sit on the right of the heading. */
export function Section({ title, hint, actions, children, id, tone }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; tone?: "quiet" }) {
  const hid = `sec-${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`fx-sec${tone ? ` fx-${tone}` : ""}`} aria-labelledby={hid}>
      <header className="fx-sec-h">
        <div><h2 id={hid}>{title}</h2>{hint ? <p className="fine">{hint}</p> : null}</div>
        {actions ? <div className="fx-acts">{actions}</div> : null}
      </header>
      <div className="fx-sec-b">{children}</div>
    </section>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="state" role="status"><span className="spin" aria-hidden="true" />{label}</p>;
}

export function LoadFailed({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  return (
    <div className="empty card-like" role="alert">
      <h2>Couldn't load {what}</h2>
      <p>{messageOf(error)}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

export function Note({ children, tone, icon = "info" }: { children: ReactNode; tone?: "warn"; icon?: "info" | "alert" | "lock" | "clock" | "check" }) {
  return tone === "warn"
    ? <p className="p-warn"><Icon name={icon} /><span>{children}</span></p>
    : <p className="state note"><Icon name={icon} /><span>{children}</span></p>;
}

/** Copy a value; says so, or says plainly when the browser won't allow it. */
export function CopyButton({ value, label, what }: { value: string; label?: string; what: string }) {
  const { toast } = useToasts();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 2000);
      toast(`${what} copied`);
    } catch { toast(`Couldn't copy ${what.toLowerCase()}. Select it and copy by hand.`); }
  }
  return <Button onClick={() => void copy()} aria-label={`Copy ${what.toLowerCase()}`}><Icon name={done ? "check" : "copy"} size="sm" />{done ? "Copied" : label ?? "Copy"}</Button>;
}

/** A label and value in a quiet two-column list. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="fx-facts">
      {items.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
    </dl>
  );
}
