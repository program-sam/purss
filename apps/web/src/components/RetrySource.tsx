import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SourceHealth } from "@purss/domain";
import { canRetrySource } from "../lib/sources.ts";
import { retrySource } from "../state/source-actions.ts";
import { useToasts } from "../state/toasts.tsx";

/** "Try again" for a source that couldn't be collected. Nothing for any other source. */
export function RetrySource({ id, title, health }: { id: string; title: string; health: SourceHealth }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [busy, setBusy] = useState(false);
  if (!canRetrySource({ health })) return null;
  return (
    <button type="button" className="link retry" disabled={busy} aria-label={`Try again: ${title}`}
      onClick={async () => { setBusy(true); await retrySource(qc, toast, id, title); setBusy(false); }}>Try again</button>
  );
}
