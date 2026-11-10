import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SMART_FILTER_WEEKLY_TOKENS } from "@purss/domain";
import type { AiServerKeyDTO } from "@purss/domain";
import { Button, TextInput } from "@purss/ui";
import { del, get, messageOf, put } from "../../api/client.ts";
import { LoadFailed, Loading, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const key = ["admin", "ai"] as const;

/** The server's Jev key for Smart filters (plan/36), the only key they use. Self-hosted, every account may use it; hosted, the accounts on Pro. */
export function AdminAiPanel() {
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useQuery({ queryKey: key, queryFn: () => get<AiServerKeyDTO>("/api/admin/ai") });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(f: () => Promise<AiServerKeyDTO>) {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(f);
      if (out) { qc.setQueryData(key, out); setText(""); void qc.invalidateQueries({ queryKey: ["ai-settings"] }); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  if (q.isPending) return <Loading />;
  if (q.isError || !q.data) return <LoadFailed error={q.error} onRetry={() => void q.refetch()} what="Smart filter settings" />;
  const d = q.data;
  const hosted = d.mode === "hosted";
  return (
    <div className="fx-stack">
      {stepUp.dialog}
      <p>Smart filters let people mark the posts of a source or collection they don't want as Ignored. They ask Jev, TypeSafe AI's decision model, about each new post, on the one key set here: {hosted
        ? `used by the accounts on the Pro plan (${(SMART_FILTER_WEEKLY_TOKENS / 1_000_000).toLocaleString("en")} million tokens a week each, never shown to them; set plans in Accounts)`
        : "used by every account on this server"}. Without it, filters wait and posts arrive unfiltered. This server reaches Jev through {d.keySource}, so the key comes from there and its use is billed there.</p>
      {error ? <Note>{error}</Note> : null}
      {d.key ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>Server key ending in <code>{d.key.hint}</code></span>
          {d.key.rejected ? <Note tone="warn" icon="alert">Jev did not accept it, so filters don't use it. Replace it to start again.</Note> : null}
          <Button disabled={busy} onClick={() => void run(() => del<AiServerKeyDTO>("/api/admin/ai/key"))}>Remove key</Button>
        </div>
      ) : <p className="fine">No server key yet.</p>}
      <form className="two" style={{ gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 8) void run(() => put<AiServerKeyDTO>("/api/admin/ai/key", { key: text.trim() })); }}>
        <label className="field" style={{ gap: 4 }}><span className="lbl">{d.key ? "Replace the server key" : "Server Jev key"}</span>
          <TextInput type="password" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} placeholder={`Key from ${d.keySource}`} /></label>
        <Button type="submit" disabled={busy || text.trim().length < 8}>Save key</Button>
      </form>
      <p className="fine">Kept in this server's secrets folder, never shown again and only sent to Jev. Changing it asks you to confirm it's you.</p>
    </div>
  );
}
