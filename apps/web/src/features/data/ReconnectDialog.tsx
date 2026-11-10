import { useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DiscoveryCandidate, DiscoveryResult, SourceDTO } from "@purss/domain";
import { Button, Dialog, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { useToasts } from "../../state/toasts.tsx";

/** Paste a private source's link again to resume it. The link is stored apart from other data and never shown again. */
export function ReconnectDialog({ source, onClose }: { source: SourceDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [url, setUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cands: DiscoveryCandidate[] = result?.ok ? result.candidates : [];
  const cand = cands[pick];

  async function look(e?: FormEvent) {
    e?.preventDefault();
    if (!url.trim()) return;
    setLooking(true); setError(""); setResult(null); setPick(0);
    try { setResult(await post<DiscoveryResult>("/api/discover", { url: url.trim() })); } catch (err) { setError(messageOf(err)); } finally { setLooking(false); }
  }
  async function reconnect() {
    if (!cand) return;
    setBusy(true); setError("");
    try {
      await post(`/api/sources/${encodeURIComponent(source.id)}/reconnect`, { token: cand.token });
      refreshWorkspace(qc);
      onClose();
      toast(`Reconnected ${source.title}. New items arrive after the next check.`);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }

  return (
    <Dialog title={`Reconnect ${source.title}`} size="md" onClose={onClose} initialFocus="#rc-url"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!cand || busy} onClick={() => void reconnect()}>Reconnect</Button></>}>
      <p className="hint">This source's private link wasn't kept in the file, on purpose, because it contains a secret. Paste the link again to carry on. Everything already collected stays.</p>
      <form className="field" onSubmit={(e) => void look(e)}>
        <label htmlFor="rc-url">The source's link</label>
        <div className="find">
          <input className="in" id="rc-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby="rc-help" />
          <button type="submit" className="btn primary" style={{ height: 38 }} disabled={looking || !url.trim()}>Look up</button>
        </div>
        <p className="fine" id="rc-help">It is stored apart from your other data and is never shown again.</p>
      </form>
      <div aria-live="polite" style={{ display: "grid", gap: 12 }}>
        {looking ? <p className="state"><span className="spin" aria-hidden="true" />Looking…</p> : null}
        {result && !result.ok ? <p className="state note" role="alert"><Icon name="info" /><span>{result.message}</span></p> : null}
        {cands.length ? (
          <div className="cands" role="radiogroup" aria-label="Feeds found">
            {cands.map((c, i) => (
              <label key={c.token} className="cand">
                <input type="radio" name="rc-cand" checked={pick === i} onChange={() => setPick(i)} />
                <span className="radio" aria-hidden="true" />
                <span style={{ display: "grid", gap: 0, minWidth: 0, gridColumn: "span 2" }}>
                  <h3>{c.title}<span className="tag">{c.origin}</span></h3>
                  <span className="cad">{c.via}{c.cadence ? `, ${c.cadence}` : ""}</span>
                  {c.samples.length ? <ul>{c.samples.slice(0, 2).map((s, k) => <li key={k}>{s.title}</li>)}</ul> : null}
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </div>
    </Dialog>
  );
}
