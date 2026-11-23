import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SMART_FILTER_WEEKLY_TOKENS } from "@purss/domain";
import type { AiServerKeyDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, TextInput } from "@purss/ui";
import { del, get, messageOf, put } from "../../api/client.ts";
import { LoadFailed, Loading, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const key = ["admin", "ai"] as const;
const t = app.admin.adminAi;

/** The server's Jev key for Smart filters, the only key they use. Self-hosted, every account may use it; hosted, the accounts on Pro. */
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
  if (q.isError || !q.data) return <LoadFailed error={q.error} onRetry={() => void q.refetch()} what={t.settingsName} />;
  const d = q.data;
  const hosted = d.mode === "hosted";
  return (
    <div className="fx-stack">
      {stepUp.dialog}
      <p>{t.intro(hosted
        ? t.usedByPro((SMART_FILTER_WEEKLY_TOKENS / 1_000_000).toLocaleString("en"))
        : t.usedByEveryAccount, d.keySource)}</p>
      {error ? <Note>{error}</Note> : null}
      {d.key ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>{t.keyEnding}<code>{d.key.hint}</code></span>
          {d.key.rejected ? <Note tone="warn" icon="alert">{t.rejected}</Note> : null}
          <Button disabled={busy} onClick={() => void run(() => del<AiServerKeyDTO>("/api/admin/ai/key"))}>{t.removeKey}</Button>
        </div>
      ) : <p className="fine">{t.noKey}</p>}
      <form className="two" style={{ gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 8) void run(() => put<AiServerKeyDTO>("/api/admin/ai/key", { key: text.trim() })); }}>
        <label className="field" style={{ gap: 4 }}><span className="lbl">{d.key ? t.replaceKey : t.serverKey}</span>
          <TextInput type="password" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} placeholder={t.keyPlaceholder(d.keySource)} /></label>
        <Button type="submit" disabled={busy || text.trim().length < 8}>{t.saveKey}</Button>
      </form>
      <p className="fine">{t.kept}</p>
    </div>
  );
}
