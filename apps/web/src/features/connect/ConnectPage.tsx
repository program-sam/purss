import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectApproveResult, ConnectRequestSummary } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { get, messageOf, post } from "../../api/client.ts";
import { AuthFrame } from "../../auth/AuthFrame.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { CopyButton, Note } from "../shared/bits.tsx";
import { KIND_LABEL } from "./ConnectedApps.tsx";

const t = app.connect.connectPage;

/** The query an app opens /connect with; passed to the server as it came. */
export const CONNECT_PARAMS = ["client", "redirect_uri", "state", "code_challenge", "code_challenge_method", "device_name"] as const;
export type ConnectSearch = Partial<Record<(typeof CONNECT_PARAMS)[number], string>>;

/** The connection parameters exactly as given; anything else in the query is ignored. */
export function rawConnectParams(search: string): ConnectSearch {
  const q = new URLSearchParams(search);
  return Object.fromEntries(CONNECT_PARAMS.filter((k) => q.has(k)).map((k) => [k, q.get(k)!]));
}

const CAN_DO = t.canDo;

type Phase = { kind: "ask" } | { kind: "sent" } | { kind: "code"; code: string; minutes: number } | { kind: "declined" };

/** Approve or decline a connection request from the PURSS app or the browser extension. */
export function ConnectPage() {
  // Read from the address as the app wrote it: the router's search parsing would turn a numeric `state` into a number.
  const [params] = useState(() => rawConnectParams(window.location.search));
  const q = useQuery({ queryKey: ["connect-request", params], queryFn: () => get<ConnectRequestSummary>("/api/connect/request", params), retry: false, staleTime: Infinity });
  const stepUp = useStepUp();
  const [name, setName] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (q.isPending) return <AuthFrame title={t.connectApp}><p className="state"><span className="spin" aria-hidden="true" />{app.words.checkingTheRequest}</p></AuthFrame>;
  if (q.isError) {
    return (
      <AuthFrame title={t.linkBroken}>
        <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p>
        <p className="fine">{app.words.nothingWasConnectedSpaced}<a className="link" href="/">{app.words.goToYourPurss}</a></p>
      </AuthFrame>
    );
  }
  const req = q.data;
  const deviceName = name ?? req.deviceName;
  const title = req.client === "mobile" ? t.titleMobile : t.titleExtension;

  async function approve() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<ConnectApproveResult>("/api/connect/approve", { ...params, device_name: deviceName.trim() }));
      if (!out) return;
      if (out.redirectTo !== undefined) { setPhase({ kind: "sent" }); window.location.assign(out.redirectTo); }
      else setPhase({ kind: "code", code: out.code, minutes: out.expiresInMinutes });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  function decline() {
    setPhase({ kind: "declined" });
    if (req.declineUrl) window.location.assign(req.declineUrl);
  }

  if (phase.kind === "sent") return <AuthFrame title={app.words.connected}><p className="hint" role="status">{t.returnToApp}</p></AuthFrame>;
  if (phase.kind === "declined") return <AuthFrame title={app.words.notConnected}><p className="hint" role="status">{app.words.nothingWasConnectedYouCanClose}</p></AuthFrame>;
  if (phase.kind === "code") {
    return (
      <AuthFrame title={t.typeCode}>
        <div style={{ display: "grid", gap: 14 }} role="status">
          <div className="fx-link"><code className="fx-url" style={{ fontSize: 22, letterSpacing: "0.08em" }}>{phase.code}</code><CopyButton value={phase.code} what={app.words.code} /></div>
          <p className="hint">{t.codeWorksOnce(phase.minutes)}</p>
          <Note tone="warn" icon="lock">{t.dontShare}</Note>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={title}
      footer={<><Button disabled={busy} onClick={decline}>{t.dontConnect}</Button><Button variant="primary" disabled={busy || !deviceName.trim()} onClick={() => void approve()}>{t.connect}</Button></>}>
      {stepUp.dialog}
      <div style={{ display: "grid", gap: 14 }}>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Note tone="warn" icon="alert">{t.onlyIfStarted}</Note>
        <ul className="seclist">
          <li><Icon name={req.client === "extension" ? "ext" : "link"} /><span className="tx"><b>{KIND_LABEL[req.client]}</b><small>{req.redirect ? req.redirect.label : t.getCode}</small></span></li>
        </ul>
        <p className="fine"><b>{app.words.itWillBeAbleTo}</b> {CAN_DO[req.client]}</p>
        <Field label={app.words.nameSoYouRecogniseItLater} htmlFor="cn-name">
          <TextInput id="cn-name" value={deviceName} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <p className="fine">{t.disconnectAnyTime}</p>
      </div>
    </AuthFrame>
  );
}
