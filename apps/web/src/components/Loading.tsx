import type { ReactNode } from "react";

/** Placeholder blocks while something loads: marked busy, and announced once as "Loading…" to screen readers. */
export function LoadingBlocks({ label = "Loading…", className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div className={className} aria-busy="true">
      <span className="sr" role="status">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
