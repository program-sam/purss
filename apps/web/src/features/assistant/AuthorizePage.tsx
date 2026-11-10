import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OAuthApproveResult, OAuthRequestSummary } from "@purss/domain";
import { Button, Check, Icon } from "@purss/ui";
import { get, messageOf, post, put } from "../../api/client.ts";
import { AuthFrame } from "../../auth/AuthFrame.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { Note } from "../shared/bits.tsx";

const READ = "Search and read your items, sources, collections and baskets, with your highlights and notes.";
const WRITE = "Also change states, keep and remove items, create baskets and collections, and find, follow, change and unfollow sources.";

type Phase = { kind: "ask" } | { kind: "leaving"; title: string; text: string };

/** OAuth consent: an assistant such as Claude or ChatGPT asks to use PURSS through MCP. */
export function AuthorizePage() {
  // The query goes to the server exactly as the assistant wrote it (plan/33), repeats included: the
  // server reads it, and approving sends back the parameters it read, so both sides agree.
  const [search] = useState(() => window.location.search);
  const q = useQuery({ queryKey: ["oauth-request", search], queryFn: () => get<OAuthRequestSummary>(`/api/assistant/oauth/request${search}`), retry: false, staleTime: Infinity });
  const stepUp = useStepUp();
  const [write, setWrite] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const leave = (to: string, title: string, text: string) => { setPhase({ kind: "leaving", title, text }); window.location.assign(to); };

  if (q.isPending) return <AuthFrame title="Connect an assistant"><p className="state"><span className="spin" aria-hidden="true" />Checking the request…</p></AuthFrame>;
  if (phase.kind === "leaving") return <AuthFrame title={phase.title}><p className="hint" role="status">{phase.text}</p></AuthFrame>;
  const req = q.data;
  if (q.isError || !req || req.kind === "error") {
    const message = q.isError ? messageOf(q.error) : req?.kind === "error" ? req.message : "";
    return (
      <AuthFrame title="This sign-in link doesn't work"
        footer={req?.kind === "error" && req.redirectTo ? <Button variant="primary" onClick={() => leave(req.redirectTo!, "Not connected", "Nothing was connected. You can close this page.")}>Back to the assistant</Button> : undefined}>
        <p className="state note" role="alert"><Icon name="info" /><span>{message}</span></p>
        <p className="fine">Nothing was connected. <a className="link" href="/">Go to your PURSS</a></p>
      </AuthFrame>
    );
  }

  const allowWrite = req.access === "write" && (write ?? true);
  const ready = req.available && req.enabled;
  const request = req.request;

  async function approve() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<OAuthApproveResult>("/api/assistant/oauth/approve", { request, access: allowWrite ? "write" : "read" }));
      if (out) leave(out.redirectTo, "Connected", "Return to the assistant to finish. You can close this page.");
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function turnOn() {
    setBusy(true); setError("");
    try { await put("/api/assistant", { enabled: true }); await q.refetch(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <AuthFrame title={`Let ${req.clientName} use your PURSS?`}
      footer={<>
        <Button disabled={busy} onClick={() => leave(req.declineUrl, "Not connected", "Nothing was connected. You can close this page.")}>Don't allow</Button>
        <Button variant="primary" disabled={busy || !ready} onClick={() => void approve()}>Allow</Button>
      </>}>
      {stepUp.dialog}
      <div style={{ display: "grid", gap: 14 }}>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Note tone="warn" icon="alert">Only allow this if you just asked an assistant to connect. If a message or website sent you here, choose Don't allow.</Note>
        <ul className="seclist">
          <li><Icon name="user" /><span className="tx"><b>{req.clientName}</b><small>Identified by {req.clientHost}</small></span></li>
          <li><Icon name="link" /><span className="tx"><b>Sends you back to {req.redirectHost}</b><small>{req.loopbackRedirect ? "A program on this computer, not a website" : "Where the assistant receives access"}</small></span></li>
        </ul>
        {req.loopbackRedirect ? <Note tone="warn" icon="alert">This assistant is a program on your computer. Another program could pose as it, so allow it only if you just started it.</Note> : null}
        <div className="fine"><b>It will be able to:</b> {READ}{allowWrite ? ` ${WRITE}` : ""}</div>
        {req.access === "write" ? (
          <Check checked={allowWrite} onChange={(on) => setWrite(on)} hint={WRITE}>Also let it organise</Check>
        ) : null}
        <p className="fine">It can't delete anything for good, share, publish, export or change your sign-in. What it reads goes to the assistant and its provider. Disconnect it any time in Settings → Assistants.</p>
        {!req.available ? <Note>Your administrator hasn't turned on assistant access for this PURSS, so nothing can be connected yet.</Note> : null}
        {req.available && !req.enabled ? (
          <Note>Assistant access is off for your account. <button type="button" className="link" disabled={busy} onClick={() => void turnOn()}>Turn it on</button> to continue.</Note>
        ) : null}
      </div>
    </AuthFrame>
  );
}
