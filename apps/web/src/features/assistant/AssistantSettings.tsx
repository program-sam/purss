import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssistantAccess, AssistantAccessLevel, AssistantGrantDTO, AssistantTokenCreated, AssistantTokenDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Check, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { shortDate, timeAgo } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { useToasts } from "../../state/toasts.tsx";
import { usePurss } from "../../state/purss.tsx";
import { CopyButton, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const assistantKey = ["assistant"] as const;
const copy = app.assistant.assistantSettings;
const ACCESS_LABEL: Record<AssistantAccessLevel, string> = copy.access;
const EXPIRY = [{ value: "30", label: app.words.n30Days }, { value: "90", label: app.words.n90Days }, { value: "365", label: copy.expiry.year1 }, { value: "never", label: copy.expiry.never }] as const;

/** The connection details for a new token, in the forms common assistants accept. */
function ConnectInstructions({ endpoint, secret, access }: { endpoint: string; secret: string; access: AssistantAccessLevel }) {
  const claude = `claude mcp add --transport http purss ${endpoint} --header "Authorization: Bearer ${secret}"`;
  const json = JSON.stringify({ mcpServers: { "purss": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  return (
    <div className="fx-stack" role="status">
      <Note tone="warn" icon="lock">{copy.connect.shownOnceBefore}{access === "write" ? copy.connect.readAndOrganise : copy.connect.read}{copy.connect.shownOnceAfter}</Note>
      <div className="fx-link"><span className="fx-link-l">{copy.connect.token}</span><code className="fx-url">{secret}</code><CopyButton value={secret} what={copy.connect.token} /></div>
      <div className="fx-link"><span className="fx-link-l">{app.words.address}</span><code className="fx-url">{endpoint}</code><CopyButton value={endpoint} what={app.words.address} /></div>
      <p className="fine">{copy.connect.claudeCode}</p>
      <div className="fx-link"><code className="fx-url">{claude}</code><CopyButton value={claude} what={copy.connect.command} /></div>
      <p className="fine">{copy.connect.othersBefore}<code>Authorization: Bearer</code>{copy.connect.othersAfter}</p>
      <div className="fx-link"><code className="fx-url" style={{ whiteSpace: "pre-wrap" }}>{json}</code><CopyButton value={json} what={app.words.settings} /></div>
    </div>
  );
}

function TokenRow({ t, onRevoke }: { t: AssistantTokenDTO; onRevoke: () => void }) {
  const tz = usePurss().prefs.timezone;
  const expired = t.expiresAt !== null && Date.parse(t.expiresAt) <= Date.now();
  return (
    <li>
      <Icon name="key" />
      <span className="tx">
        <b>{t.name}</b>
        <small>
          {ACCESS_LABEL[t.access]}{copy.tokenRow.made(shortDate(t.createdAt, Date.now(), tz))}
          {t.expiresAt ? copy.tokenRow.expiry(expired, shortDate(t.expiresAt, Date.now(), tz)) : copy.tokenRow.noExpiry}
          {t.lastUsedAt ? copy.tokenRow.lastUsed(timeAgo(t.lastUsedAt) || app.words.justNow) : copy.tokenRow.notUsed}
        </small>
      </span>
      <Button onClick={onRevoke} aria-label={`Revoke ${t.name}`}>{app.words.revoke}</Button>
    </li>
  );
}

function GrantRow({ g, onRevoke }: { g: AssistantGrantDTO; onRevoke: () => void }) {
  const tz = usePurss().prefs.timezone;
  return (
    <li>
      <Icon name="user" />
      <span className="tx">
        <b>{g.clientName}</b>
        <small>{copy.grantRow.summary(g.clientHost, ACCESS_LABEL[g.access], shortDate(g.createdAt, Date.now(), tz), timeAgo(g.lastUsedAt) || app.words.justNow)}</small>
      </span>
      <Button onClick={onRevoke} aria-label={`Disconnect ${g.clientName}`}>{app.words.disconnect}</Button>
    </li>
  );
}

/** How to connect an assistant that signs in (OAuth) rather than taking a token. */
function SignInInstructions({ endpoint }: { endpoint: string }) {
  return (
    <div className="fx-stack">
      <p className="fine">{copy.signIn.hint}</p>
      <div className="fx-link"><span className="fx-link-l">{app.words.address}</span><code className="fx-url">{endpoint}</code><CopyButton value={endpoint} what={app.words.address} /></div>
    </div>
  );
}

/**
 * Settings → Assistants: let an AI assistant use PURSS through MCP with a personal access
 * token or, where the installation offers it, by signing in (OAuth).
 */
export function AssistantSettings() {
  const qc = useQueryClient();
  const ov = useOverlays();
  const nav = useNav();
  const { toast } = useToasts();
  const session = useSession().data;
  const isAdmin = !!session?.account?.isAdmin;
  const hosted = session?.installation.mode === "hosted";
  const stepUp = useStepUp();
  // Always fresh when opened: an administrator may have just changed the installation switch.
  const q = useQuery({ queryKey: assistantKey, queryFn: () => get<AssistantAccess>("/api/assistant"), staleTime: 0 });
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AssistantAccessLevel>("read");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]["value"]>("90");
  const [made, setMade] = useState<AssistantTokenCreated | null>(null);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = q.data;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); await qc.invalidateQueries({ queryKey: assistantKey }); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function setEnabled(on: boolean) {
    const n = (data?.tokens.length ?? 0) + (data?.grants.length ?? 0);
    if (!on && n && !window.confirm(copy.confirmOff(n))) return;
    await act(async () => { await put("/api/assistant", { enabled: on }); setMade(null); setComposing(false); toast(on ? copy.accessOn : copy.accessOff); });
  }
  async function create() {
    await act(async () => {
      const out = await stepUp.run(() => post<AssistantTokenCreated>("/api/assistant/tokens", { name: name.trim(), access, expiresInDays: expiry === "never" ? null : Number(expiry) }));
      if (!out) return;
      setMade(out); setName(""); setComposing(false);
    });
  }
  async function disconnect(g: AssistantGrantDTO) {
    if (!window.confirm(copy.confirmDisconnect(g.clientName))) return;
    await act(async () => { await del(`/api/assistant/grants/${encodeURIComponent(g.id)}`); toast(copy.disconnected(g.clientName)); });
  }
  async function revoke(t: AssistantTokenDTO) {
    if (!window.confirm(copy.confirmRevoke(t.name))) return;
    await act(async () => { await del(`/api/assistant/tokens/${encodeURIComponent(t.id)}`); if (made?.token.id === t.id) setMade(null); toast(copy.revoked(t.name)); });
  }

  if (q.isPending) return <p className="state"><span className="spin" aria-hidden="true" />{app.words.loading}</p>;
  if (q.isError || !data) return <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p>;
  const insecure = data.endpoint.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(data.endpoint);
  return (
    <>
      {stepUp.dialog}
      <p className="hint">{copy.intro}</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {!data.available && session ? <Note>{hosted
        ? copy.notAvailable(!!(data.tokens.length || data.grants.length))
        : <>{copy.notTurnedOn(!!(data.tokens.length || data.grants.length))}.{isAdmin ? <> <button type="button" className="link" onClick={() => { ov.close(); nav.goPath("/admin"); }}>{copy.turnOnInAdmin}</button>.</> : null}</>}</Note> : null}
      {data.available || data.enabled ? (
        <Check checked={data.enabled} disabled={busy || (!data.available && !data.enabled)} onChange={(on) => void setEnabled(on)}
          hint={copy.switchHint}>{copy.switchLabel}</Check>
      ) : null}
      {data.available && data.enabled && insecure ? <Note tone="warn" icon="alert">{copy.insecure}</Note> : null}
      {made ? <ConnectInstructions endpoint={data.endpoint} secret={made.secret} access={made.token.access} /> : null}
      {data.oauth && data.available && data.enabled && !made ? <SignInInstructions endpoint={data.endpoint} /> : null}
      {data.grants.length ? (
        <section className="field" aria-labelledby="as-g">
          <div className="lbl" id="as-g">{copy.connectedAssistants}</div>
          <ul className="seclist">
            {data.grants.map((g) => <GrantRow key={g.id} g={g} onRevoke={() => void disconnect(g)} />)}
          </ul>
        </section>
      ) : null}
      {data.enabled || data.tokens.length ? (
        <section className="field" aria-labelledby="as-t">
          <div className="lbl" id="as-t">{copy.tokens}</div>
          <ul className="seclist">
            {data.tokens.map((t) => <TokenRow key={t.id} t={t} onRevoke={() => void revoke(t)} />)}
            {!data.tokens.length ? <li><span className="tx"><small>{copy.noTokens}</small></span></li> : null}
          </ul>
        </section>
      ) : null}
      {data.available && data.enabled && !composing ? (
        <div><Button onClick={() => setComposing(true)}><Icon name="plus" size="sm" />{copy.newToken}</Button></div>
      ) : null}
      {data.available && data.enabled && composing ? (
        <form className="field" aria-labelledby="as-n" onSubmit={(e) => { e.preventDefault(); void create(); }} style={{ display: "grid", gap: 10 }}>
          <div className="lbl" id="as-n">{copy.newToken}</div>
          <label className="fine" htmlFor="as-name">{app.words.nameSoYouRecogniseItLater}</label>
          <TextInput id="as-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={copy.namePlaceholder} autoComplete="off" />
          <label className="fine" htmlFor="as-access">{copy.mayDo}</label>
          <SelectInput id="as-access" value={access} onChange={(e) => setAccess(e.target.value as AssistantAccessLevel)}>
            <option value="read">{copy.optionRead}</option>
            <option value="write">{copy.optionWrite}</option>
          </SelectInput>
          <label className="fine" htmlFor="as-exp">{copy.stopsAfter}</label>
          <SelectInput id="as-exp" value={expiry} onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number]["value"])}>
            {EXPIRY.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </SelectInput>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{copy.createToken}</Button>
            <Button onClick={() => { setComposing(false); setName(""); }} disabled={busy}>{app.words.cancel}</Button>
          </div>
          <p className="fine">{copy.confirmItsYou}</p>
        </form>
      ) : null}
    </>
  );
}
