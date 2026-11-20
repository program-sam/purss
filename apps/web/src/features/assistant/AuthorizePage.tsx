import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OAuthApproveResult, OAuthRequestSummary } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Check, Icon } from "@purss/ui";
import { get, messageOf, post, put } from "../../api/client.ts";
import { AuthFrame } from "../../auth/AuthFrame.tsx";
import { useSession } from "../../api/hooks.ts";
import { useStepUp } from "../shared/step-up.tsx";
import { Note } from "../shared/bits.tsx";

const t = app.assistant.authorizePage;

const READ = t.read;
const CHANGES = t.changes;
const WRITE = t.also(CHANGES);

type Phase = { kind: "ask" } | { kind: "leaving"; title: string; text: string };

/** OAuth consent: an assistant such as Claude or ChatGPT asks to use PURSS through MCP. */
export function AuthorizePage() {
  const session = useSession();
  const hosted = session.data?.installation.mode === "hosted";
  // The query goes to the server exactly as the assistant wrote it, repeats included: the
  // server reads it, and approving sends back the parameters it read, so both sides agree.
  const [search] = useState(() => window.location.search);
  const q = useQuery({ queryKey: ["oauth-request", search], queryFn: () => get<OAuthRequestSummary>(`/api/assistant/oauth/request${search}`), retry: false, staleTime: Infinity });
  const stepUp = useStepUp();
  const [write, setWrite] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const leave = (to: string, title: string, text: string) => { setPhase({ kind: "leaving", title, text }); window.location.assign(to); };

  if (q.isPending) return <AuthFrame title={t.connectTitle}><p className="state"><span className="spin" aria-hidden="true" />{app.words.checkingTheRequest}</p></AuthFrame>;
  if (phase.kind === "leaving") return <AuthFrame title={phase.title}><p className="hint" role="status">{phase.text}</p></AuthFrame>;
  const req = q.data;
  if (q.isError || !req || req.kind === "error") {
    const message = q.isError ? messageOf(q.error) : req?.kind === "error" ? req.message : "";
    return (
      <AuthFrame title={t.linkBroken}
        footer={req?.kind === "error" && req.redirectTo ? <Button variant="primary" onClick={() => leave(req.redirectTo!, app.words.notConnected, app.words.nothingWasConnectedYouCanClose)}>{t.backToAssistant}</Button> : undefined}>
        <p className="state note" role="alert"><Icon name="info" /><span>{message}</span></p>
        <p className="fine">{app.words.nothingWasConnectedSpaced}<a className="link" href="/">{app.words.goToYourPurss}</a></p>
      </AuthFrame>
    );
  }

  const allowWrite = req.access === "write" && (write ?? false);
  const ready = req.available && req.enabled;
  const request = req.request;

  async function approve() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<OAuthApproveResult>("/api/assistant/oauth/approve", { request, access: allowWrite ? "write" : "read" }));
      if (out) leave(out.redirectTo, app.words.connected, t.returnToFinish);
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function turnOn() {
    setBusy(true); setError("");
    try { await put("/api/assistant", { enabled: true }); await q.refetch(); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <AuthFrame title={t.title(req.clientName)}
      footer={<>
        <Button disabled={busy} onClick={() => leave(req.declineUrl, app.words.notConnected, app.words.nothingWasConnectedYouCanClose)}>{app.words.donTAllow}</Button>
        <Button variant="primary" disabled={busy || !ready} onClick={() => void approve()}>{t.allow}</Button>
      </>}>
      {stepUp.dialog}
      <div style={{ display: "grid", gap: 14 }}>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Note tone="warn" icon="alert">{t.onlyIfAsked}</Note>
        <ul className="seclist">
          <li><Icon name="user" /><span className="tx"><b>{req.clientName}</b><small>{t.identifiedBy(req.clientHost)}</small></span></li>
          <li><Icon name="link" /><span className="tx"><b>{t.sendsBack(req.redirectHost)}</b><small>{req.loopbackRedirect ? t.loopbackKind : t.redirectKind}</small></span></li>
        </ul>
        {req.loopbackRedirect ? <Note tone="warn" icon="alert">{t.loopbackWarning}</Note> : null}
        <div className="fine"><b>{app.words.itWillBeAbleTo}</b> {READ}{allowWrite ? ` ${WRITE}` : ""}</div>
        {req.access === "write" ? (
          <Check checked={allowWrite} onChange={(on) => setWrite(on)} hint={t.canHint(CHANGES)}>{t.allowChanges}</Check>
        ) : null}
        <p className="fine">{t.cantDelete}</p>
        {!req.available && session.data ? <Note>{hosted ? t.notAvailableHosted : t.notAvailableSelf}</Note> : null}
        {req.available && !req.enabled ? (
          <Note>{t.offBefore}<button type="button" className="link" disabled={busy} onClick={() => void turnOn()}>{t.turnOn}</button>{t.offAfter}</Note>
        ) : null}
      </div>
    </AuthFrame>
  );
}
