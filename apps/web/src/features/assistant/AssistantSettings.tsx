import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssistantAccess, AssistantAccessLevel, AssistantGrantDTO, AssistantTokenCreated, AssistantTokenDTO } from "@purss/domain";
import { Button, Check, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { shortDate, timeAgo } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { CopyButton, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const assistantKey = ["assistant"] as const;
const ACCESS_LABEL: Record<AssistantAccessLevel, string> = { read: "Read only", write: "Read and organise" };
const EXPIRY = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }, { value: "never", label: "No expiry" }] as const;

/** The connection details for a new token, in the forms common assistants accept. */
function ConnectInstructions({ endpoint, secret, access }: { endpoint: string; secret: string; access: AssistantAccessLevel }) {
  const claude = `claude mcp add --transport http purss ${endpoint} --header "Authorization: Bearer ${secret}"`;
  const json = JSON.stringify({ mcpServers: { "purss": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  return (
    <div className="fx-stack" role="status">
      <Note tone="warn" icon="lock">This token is shown only now. Anyone who has it can {access === "write" ? "read and organise" : "read"} your PURSS until you revoke it.</Note>
      <div className="fx-link"><span className="fx-link-l">Token</span><code className="fx-url">{secret}</code><CopyButton value={secret} what="Token" /></div>
      <div className="fx-link"><span className="fx-link-l">Address</span><code className="fx-url">{endpoint}</code><CopyButton value={endpoint} what="Address" /></div>
      <p className="fine">In Claude Code, run:</p>
      <div className="fx-link"><code className="fx-url">{claude}</code><CopyButton value={claude} what="Command" /></div>
      <p className="fine">Other assistants that support MCP over HTTP (Claude Desktop, Cursor and others) take the address with an <code>Authorization: Bearer</code> header, often in a settings file like this:</p>
      <div className="fx-link"><code className="fx-url" style={{ whiteSpace: "pre-wrap" }}>{json}</code><CopyButton value={json} what="Settings" /></div>
    </div>
  );
}

function TokenRow({ t, onRevoke }: { t: AssistantTokenDTO; onRevoke: () => void }) {
  const tz = useWorkspace().prefs.timezone;
  const expired = t.expiresAt !== null && Date.parse(t.expiresAt) <= Date.now();
  return (
    <li>
      <Icon name="key" />
      <span className="tx">
        <b>{t.name}</b>
        <small>
          {ACCESS_LABEL[t.access]} · made {shortDate(t.createdAt, Date.now(), tz)}
          {t.expiresAt ? ` · ${expired ? "expired" : "expires"} ${shortDate(t.expiresAt, Date.now(), tz)}` : " · no expiry"}
          {t.lastUsedAt ? ` · last used ${timeAgo(t.lastUsedAt) || "just now"}` : " · not used yet"}
        </small>
      </span>
      <Button onClick={onRevoke} aria-label={`Revoke ${t.name}`}>Revoke</Button>
    </li>
  );
}

function GrantRow({ g, onRevoke }: { g: AssistantGrantDTO; onRevoke: () => void }) {
  const tz = useWorkspace().prefs.timezone;
  return (
    <li>
      <Icon name="user" />
      <span className="tx">
        <b>{g.clientName}</b>
        <small>{g.clientHost} · {ACCESS_LABEL[g.access]} · connected {shortDate(g.createdAt, Date.now(), tz)} · last used {timeAgo(g.lastUsedAt) || "just now"}</small>
      </span>
      <Button onClick={onRevoke} aria-label={`Disconnect ${g.clientName}`}>Disconnect</Button>
    </li>
  );
}

/** How to connect an assistant that signs in (OAuth, plan/33) rather than taking a token. */
function SignInInstructions({ endpoint }: { endpoint: string }) {
  return (
    <div className="fx-stack">
      <p className="fine">Assistants that sign in, such as Claude and ChatGPT, need only this address. Add it as a custom connector, then allow it here.</p>
      <div className="fx-link"><span className="fx-link-l">Address</span><code className="fx-url">{endpoint}</code><CopyButton value={endpoint} what="Address" /></div>
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
  const isAdmin = !!useSession().data?.account?.isAdmin;
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
    if (!on && n && !window.confirm(`Turning this off revokes your tokens and disconnects your assistants. ${n === 1 ? "The assistant using it stops" : "Assistants using them stop"} working.`)) return;
    await act(async () => { await put("/api/assistant", { enabled: on }); setMade(null); setComposing(false); toast(on ? "Assistant access on" : "Assistant access off; tokens revoked and assistants disconnected"); });
  }
  async function create() {
    await act(async () => {
      const out = await stepUp.run(() => post<AssistantTokenCreated>("/api/assistant/tokens", { name: name.trim(), access, expiresInDays: expiry === "never" ? null : Number(expiry) }));
      if (!out) return;
      setMade(out); setName(""); setComposing(false);
    });
  }
  async function disconnect(g: AssistantGrantDTO) {
    if (!window.confirm(`Disconnect “${g.clientName}”? It stops working at once; connect it again from the assistant.`)) return;
    await act(async () => { await del(`/api/assistant/grants/${encodeURIComponent(g.id)}`); toast(`Disconnected ${g.clientName}`); });
  }
  async function revoke(t: AssistantTokenDTO) {
    if (!window.confirm(`Revoke “${t.name}”? Assistants using it stop working at once.`)) return;
    await act(async () => { await del(`/api/assistant/tokens/${encodeURIComponent(t.id)}`); if (made?.token.id === t.id) setMade(null); toast(`Revoked ${t.name}`); });
  }

  if (q.isPending) return <p className="state"><span className="spin" aria-hidden="true" />Loading…</p>;
  if (q.isError || !data) return <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p>;
  const insecure = data.endpoint.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(data.endpoint);
  return (
    <>
      {stepUp.dialog}
      <p className="hint">Assistants that support MCP (such as Claude or ChatGPT) can search and read your PURSS. If you allow it, they can also organise it: change states, keep items, manage sources and collections. They can't delete anything for good, share, publish, export or change your sign-in. What they read goes to the assistant and its provider.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {!data.available ? (
        <Note>Your administrator hasn't turned on assistant access for this PURSS{data.tokens.length || data.grants.length ? ", so your tokens and connected assistants don't work now. They work again if it is turned back on; revoke any you no longer want" : ""}.{isAdmin ? <> <button type="button" className="link" onClick={() => { ov.close(); nav.goPath("/admin"); }}>Turn it on in Administration → Assistants</button>.</> : null}</Note>
      ) : null}
      {data.available || data.enabled ? (
        <Check checked={data.enabled} disabled={busy || (!data.available && !data.enabled)} onChange={(on) => void setEnabled(on)}
          hint="Turning it off revokes every token you made and disconnects every assistant.">Let assistants use my PURSS</Check>
      ) : null}
      {data.available && data.enabled && insecure ? <Note tone="warn" icon="alert">This PURSS is reached over plain HTTP, so a token would travel unencrypted. Use it only on a network you trust.</Note> : null}
      {made ? <ConnectInstructions endpoint={data.endpoint} secret={made.secret} access={made.token.access} /> : null}
      {data.oauth && data.available && data.enabled && !made ? <SignInInstructions endpoint={data.endpoint} /> : null}
      {data.grants.length ? (
        <section className="field" aria-labelledby="as-g">
          <div className="lbl" id="as-g">Connected assistants</div>
          <ul className="seclist">
            {data.grants.map((g) => <GrantRow key={g.id} g={g} onRevoke={() => void disconnect(g)} />)}
          </ul>
        </section>
      ) : null}
      {data.enabled || data.tokens.length ? (
        <section className="field" aria-labelledby="as-t">
          <div className="lbl" id="as-t">Tokens</div>
          <ul className="seclist">
            {data.tokens.map((t) => <TokenRow key={t.id} t={t} onRevoke={() => void revoke(t)} />)}
            {!data.tokens.length ? <li><span className="tx"><small>No tokens yet.</small></span></li> : null}
          </ul>
        </section>
      ) : null}
      {data.available && data.enabled && !composing ? (
        <div><Button onClick={() => setComposing(true)}><Icon name="plus" size="sm" />New token</Button></div>
      ) : null}
      {data.available && data.enabled && composing ? (
        <form className="field" aria-labelledby="as-n" onSubmit={(e) => { e.preventDefault(); void create(); }} style={{ display: "grid", gap: 10 }}>
          <div className="lbl" id="as-n">New token</div>
          <label className="fine" htmlFor="as-name">Name, so you recognise it later</label>
          <TextInput id="as-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Claude on my laptop" autoComplete="off" />
          <label className="fine" htmlFor="as-access">What it may do</label>
          <SelectInput id="as-access" value={access} onChange={(e) => setAccess(e.target.value as AssistantAccessLevel)}>
            <option value="read">Read only: search and read items, sources, collections and baskets</option>
            <option value="write">Read and organise: also change states, keep items, follow and change sources</option>
          </SelectInput>
          <label className="fine" htmlFor="as-exp">Stops working after</label>
          <SelectInput id="as-exp" value={expiry} onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number]["value"])}>
            {EXPIRY.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </SelectInput>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Create token</Button>
            <Button onClick={() => { setComposing(false); setName(""); }} disabled={busy}>Cancel</Button>
          </div>
          <p className="fine">You'll be asked to confirm it's you. Text from a source could try to instruct the assistant, so check what it proposes before it changes many things.</p>
        </form>
      ) : null}
    </>
  );
}
