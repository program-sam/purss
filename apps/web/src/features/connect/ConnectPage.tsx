import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectApproveResult, ConnectRequestSummary } from "@purss/domain";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { get, messageOf, post } from "../../api/client.ts";
import { AuthFrame } from "../../auth/AuthFrame.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { CopyButton, Note } from "../shared/bits.tsx";
import { KIND_LABEL } from "./ConnectedApps.tsx";

/** The query an app opens /connect with (plan/24); passed to the server as it came. */
export const CONNECT_PARAMS = ["client", "redirect_uri", "state", "code_challenge", "code_challenge_method", "device_name"] as const;
export type ConnectSearch = Partial<Record<(typeof CONNECT_PARAMS)[number], string>>;

/** The connection parameters exactly as given; anything else in the query is ignored. */
export function rawConnectParams(search: string): ConnectSearch {
  const q = new URLSearchParams(search);
  return Object.fromEntries(CONNECT_PARAMS.filter((k) => q.has(k)).map((k) => [k, q.get(k)!]));
}

const CAN_DO = {
  mobile: "Everything you do in PURSS: reading, organising, keeping, sources and collections. Not your sign-in or security settings, administration or assistant access.",
  extension: "Keep links in your baskets, check whether you already have a page, search, and find and follow sources. Nothing else.",
} as const;

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

  if (q.isPending) return <AuthFrame title="Connect an app"><p className="state"><span className="spin" aria-hidden="true" />Checking the request…</p></AuthFrame>;
  if (q.isError) {
    return (
      <AuthFrame title="This connection link doesn't work">
        <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p>
        <p className="fine">Nothing was connected. <a className="link" href="/">Go to your PURSS</a></p>
      </AuthFrame>
    );
  }
  const req = q.data;
  const deviceName = name ?? req.deviceName;
  const title = req.client === "mobile" ? "Connect the PURSS app?" : "Connect the browser extension?";

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

  if (phase.kind === "sent") return <AuthFrame title="Connected"><p className="hint" role="status">Return to the app to finish. You can close this page.</p></AuthFrame>;
  if (phase.kind === "declined") return <AuthFrame title="Not connected"><p className="hint" role="status">Nothing was connected. You can close this page.</p></AuthFrame>;
  if (phase.kind === "code") {
    return (
      <AuthFrame title="Type this code into the app">
        <div style={{ display: "grid", gap: 14 }} role="status">
          <div className="fx-link"><code className="fx-url" style={{ fontSize: 22, letterSpacing: "0.08em" }}>{phase.code}</code><CopyButton value={phase.code} what="Code" /></div>
          <p className="hint">It works once, for the next {phase.minutes} minutes, and only in the app that asked.</p>
          <Note tone="warn" icon="lock">Don't share this code or type it anywhere else. PURSS will never ask for it.</Note>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={title}
      footer={<><Button disabled={busy} onClick={decline}>Don't connect</Button><Button variant="primary" disabled={busy || !deviceName.trim()} onClick={() => void approve()}>Connect</Button></>}>
      {stepUp.dialog}
      <div style={{ display: "grid", gap: 14 }}>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <Note tone="warn" icon="alert">Only connect if you just started this from the app on your own device. If a message or website sent you here, choose Don't connect.</Note>
        <ul className="seclist">
          <li><Icon name={req.client === "extension" ? "ext" : "link"} /><span className="tx"><b>{KIND_LABEL[req.client]}</b><small>{req.redirect ? req.redirect.label : "You'll get a code to type into the app"}</small></span></li>
        </ul>
        <p className="fine"><b>It will be able to:</b> {CAN_DO[req.client]}</p>
        <Field label="Name, so you recognise it later" htmlFor="cn-name">
          <TextInput id="cn-name" value={deviceName} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <p className="fine">Disconnect it any time in Settings → Connected apps. It disconnects itself after 90 days unused.</p>
      </div>
    </AuthFrame>
  );
}
