import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "@purss/ui";

/** The calm centred card used for setup, sign-in and invitations. */
export function AuthFrame({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  // The tab names the step, and a new step (adding a passkey after the form) puts focus on its heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(false);
  useEffect(() => {
    document.title = `${title} · PURSS`;
    if (shown.current) heading.current?.focus({ preventScroll: true });
    shown.current = true;
  }, [title]);
  return (
    <div className="auth-page">
      <main className="auth-card" aria-labelledby="auth-title">
        <header className="dlg-h">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="mark" aria-hidden="true"><Icon name="mark" /></span>
            <div style={{ display: "grid", gap: 3 }}>
              <span className="fine" style={{ fontSize: 12 }}>PURSS</span>
              <h1 id="auth-title" className="auth-title" ref={heading} tabIndex={-1}>{title}</h1>
            </div>
          </div>
        </header>
        <div className="dlg-b">
          {intro ? <p className="hint">{intro}</p> : null}
          {children}
        </div>
        {footer ? <div className="dlg-f">{footer}</div> : null}
      </main>
    </div>
  );
}
