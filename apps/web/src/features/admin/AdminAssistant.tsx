import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AdminAssistantAccess } from "@purss/domain";
import { Check } from "@purss/ui";
import { get, messageOf, put } from "../../api/client.ts";
import { plural } from "../../lib/format.ts";
import { LoadFailed, Loading, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const key = ["admin", "assistant"] as const;

/** The installation switch for assistant access (MCP). Each person still turns it on for themselves. */
export function AdminAssistantPanel() {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useQuery({ queryKey: key, queryFn: () => get<AdminAssistantAccess>("/api/admin/assistant") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function set(enabled: boolean) {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => put<AdminAssistantAccess>("/api/admin/assistant", { enabled }));
      if (out) qc.setQueryData(key, out);
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  if (q.isPending) return <Loading />;
  if (q.isError || !q.data) return <LoadFailed error={q.error} onRetry={() => void q.refetch()} what="assistant access" />;
  const d = q.data;
  return (
    <div className="fx-stack">
      {stepUp.dialog}
      <p>Lets people connect an AI assistant (through MCP) to their own PURSS, using tokens they make in Settings → Assistants{d.oauth ? ", or by signing in from assistants such as Claude and ChatGPT" : ""}. Off by default. An assistant only reaches the PURSS of the person who connected it, never administration.</p>
      {error ? <Note>{error}</Note> : null}
      <Check checked={d.enabled} disabled={busy} onChange={(on) => void set(on)}
        hint="Turning it off stops every token and connected assistant at once; they are kept and work again when it's turned back on.">Allow assistant access on this installation</Check>
      <p className="fine">{plural(d.accountsEnabled, "account")} turned it on · {plural(d.tokens, "token")}{d.oauth ? ` · ${plural(d.grants, "connected assistant")}` : ""}.</p>
    </div>
  );
}
