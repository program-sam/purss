import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Preferences } from "@purss/domain";
import { Button, Check, Dialog, Icon, Segmented, SelectInput } from "@purss/ui";
import { ApiError, del, messageOf, post } from "../api/client.ts";
import { keys, securityQuery } from "../api/queries.ts";
import { useSession } from "../api/hooks.ts";
import type { SecurityMethod } from "../api/types.ts";
import { registerPasskey } from "../auth/PasskeyStep.tsx";
import { PasswordForm, passkeysAvailable } from "../auth/PasswordForm.tsx";
import { StepUpOptions } from "../features/shared/step-up.tsx";
import { shortDate, timeAgo } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useSavePreferences } from "../state/prefs.ts";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { SOUND_MATERIALS, cue, soundSettings, subscribeSounds, updateSounds } from "../lib/sound.ts";
import { setDisplayMode, useDisplayMode } from "../lib/display.ts";
import { OfflineField } from "../offline/OfflineSettings.tsx";
import { TextSizeField } from "./TextSizeField.tsx";
import { useWaitingCount } from "../annotations/use-annotations.ts";
import { AssistantSettings } from "../features/assistant/AssistantSettings.tsx";
import { ConnectedApps } from "../features/connect/ConnectedApps.tsx";
import { AccountEmailSection } from "../auth/AccountEmailSection.tsx";
import { useSignOut } from "../auth/use-sign-out.ts";
import { DeviceTab } from "../downloads/DeviceTab.tsx";
import { platform } from "../platform/index.ts";
import { PAGE_VERSION, versionLine } from "../lib/version.ts";
import { hasPage } from "../plugins.ts";
import { NotificationSettings } from "./NotificationSettings.tsx";
import { fkeys } from "../features/shared/api.ts";
import { MutedWordsField } from "./MutedWords.tsx";
import { AiSettingsField } from "./AiFilter.tsx";
import { DeleteAccountSection } from "../features/account/DeleteAccount.tsx";
import { PlanTab } from "../features/account/PlanTab.tsx";

type Tab = "general" | "notifications" | "security" | "assistants" | "apps" | "device" | "plan" | "account";
const SKINS: { value: Preferences["skin"]; label: string; hue: number }[] = [{ value: "sky", label: "Sky", hue: 212 }, { value: "lilac", label: "Lilac", hue: 268 }, { value: "meadow", label: "Meadow", hue: 152 }];

function useZones(current: string): string[] {
  return useMemo(() => {
    let list: string[] = [];
    try { list = Intl.supportedValuesOf("timeZone"); } catch { /* older engines: fall back below */ }
    return [...new Set(["UTC", current, ...list])].sort();
  }, [current]);
}

function SoundsField() {
  const s = useSyncExternalStore(subscribeSounds, soundSettings);
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Sounds</legend>
      <Check checked={s.enabled} onChange={(v) => updateSounds({ enabled: v })} hint="Soft clicks and chimes when you press buttons or finish actions. New arrivals stay silent. Saved on this device.">Interface sounds</Check>
      {s.enabled ? (
        <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
          <label className="field" style={{ gap: 4 }}><span className="lbl">Volume</span>
            <input type="range" min={0.05} max={1} step={0.05} value={s.volume} aria-valuetext={`${Math.round(s.volume * 100)} percent`}
              onChange={(e) => updateSounds({ volume: Number(e.target.value) })} onPointerUp={() => cue("select")} onKeyUp={() => cue("select")} /></label>
          <label className="field" style={{ gap: 4 }}><span className="lbl">Sound style</span>
            <select className="sel-in" value={s.material} onChange={(e) => { updateSounds({ material: e.target.value as typeof s.material }); cue("success"); }}>
              {SOUND_MATERIALS.map((m) => <option key={m.value} value={m.value}>{m.label} · {m.blurb}</option>)}
            </select></label>
        </div>
      ) : null}
    </fieldset>
  );
}

function DisplayField() {
  const mode = useDisplayMode();
  return (
    <div className="field">
      <Check checked={mode === "eink"} onChange={(v) => setDisplayMode(v ? "eink" : "standard")}
        hint="Black on white with nothing that moves, and Page up and Page down buttons instead of scrolling. For e-readers. Saved on this device.">E-ink display</Check>
    </div>
  );
}

function GeneralTab() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const qc = useQueryClient();
  const ov = useOverlays();
  const nav = useNav();
  const go = (to: string) => { ov.close(); nav.goPath(to); };
  const p = ws.prefs;
  const zones = useZones(p.timezone);
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const eink = useDisplayMode() === "eink";
  const session = useSession().data;
  return (
    <>
      <div className="field"><div className="lbl" id="th">Theme</div>
        <Segmented labelledBy="th" value={p.theme} onChange={(v) => void save({ theme: v })} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 16px" }}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Match device" }]} />
        {eink ? <p className="fine">This device uses the e-ink display, which is always black on white.</p> : null}</div>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>Accent colour</legend>
        <div className="swatches">
          {SKINS.map((s) => (
            <label key={s.value} className="sw-opt">
              <input type="radio" name="skin" value={s.value} checked={p.skin === s.value} onChange={() => void save({ skin: s.value })} />
              <span className="c" style={{ "--sh": s.hue } as CSSProperties} aria-hidden="true" />{s.label}
            </label>
          ))}
        </div></fieldset>
      <div className="field"><div className="lbl" id="dn2">List density</div>
        <Segmented labelledBy="dn2" value={p.density} onChange={(v) => void save({ density: v })} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
          options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} /></div>
      <DisplayField />
      <TextSizeField />
      <SoundsField />
      <OfflineField />
      <MutedWordsField />
      <AiSettingsField />
      <div className="field" style={{ gap: 2 }}>
        <Check checked={p.reminders} onChange={(v) => void save({ reminders: v })} hint="Now and then, a quiet note on Home about something you kept a year ago. You can hide or snooze each one.">Anniversary reminders</Check>
      </div>
      {session?.installation.mode === "hosted" ? (
        <div className="field" style={{ gap: 2 }}>
          <Check checked={p.discoveryShare} onChange={(v) => { void save({ discoveryShare: v }).then(() => qc.removeQueries({ queryKey: fkeys.suggestions })); }}
            hint="For Discovery. Your sources count anonymously. Private sources never count. Only people who share get suggestions.">Share my sources</Check>
        </div>
      ) : null}
      <div className="field"><label htmlFor="tz">Time zone</label>
        <SelectInput id="tz" value={p.timezone} onChange={(e) => void save({ timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</SelectInput>
        <p className="fine">Used for “Today” and “Yesterday” groupings. {device && device !== p.timezone ? <button type="button" className="link" onClick={() => void save({ timezone: device })}>Use this device's ({device.replace(/_/g, " ")})</button> : null}</p></div>
      <div className="field"><div className="lbl" id="more-l">More</div>
        <div role="group" aria-labelledby="more-l" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {hasPage("/settings/data") ? <Button onClick={() => go("/settings/data")}>Your data</Button> : null}
          <Button onClick={() => go("/sharing")}>Sharing</Button>
          <Button onClick={() => ov.open({ kind: "shortcuts" })}>Keyboard shortcuts</Button>
        </div>
      </div>
    </>
  );
}

type Step = { kind: "main" } | { kind: "stepup"; then: () => Promise<void> } | { kind: "password" };

function SecurityTab() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const session = useSession().data;
  const sec = useQuery(securityQuery);
  const out = useSignOut();
  const [step, setStep] = useState<Step>({ kind: "main" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const unsynced = useWaitingCount();

  const refreshQueries = () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.security }),
      qc.invalidateQueries({ queryKey: keys.session }),
    ]);
  const refresh = () => { void refreshQueries(); };

  /** Run an action that needs a recent sign-in; if the server asks for a fresh confirmation, ask, then retry once. */
  async function withStepUp(run: () => Promise<void>) {
    setError("");
    try { await run(); } catch (err) {
      if (err instanceof ApiError && err.code === "step_up") { setStep({ kind: "stepup", then: run }); return; }
      setError(messageOf(err));
    }
  }
  async function finishStepUp(confirm: () => Promise<void>, then: () => Promise<void>) {
    setBusy(true); setError("");
    let confirmed = false;
    try {
      await confirm();
      confirmed = true;
      setStep({ kind: "main" });
      await then();
    } catch (err) {
      if (confirmed) setStep({ kind: "main" });
      setError(messageOf(err));
    } finally { setBusy(false); }
  }

  // Adding a sign-in method needs a recent sign-in.
  const addPasskey = () => withStepUp(async () => { await registerPasskey(null); await refreshQueries(); toast("Fingerprint, face or screen lock added"); });
  const removeMethod = (m: SecurityMethod) => withStepUp(async () => { await del(`/api/account/methods/${encodeURIComponent(m.id)}`); refresh(); toast("Sign-in method removed"); });
  // The form needs a recent sign-in when saved; confirm first so nothing typed is lost.
  const openPassword = () => withStepUp(async () => {
    const s = await qc.fetchQuery({ ...securityQuery, staleTime: 0 });
    if (!s.recentAuth) throw new ApiError(403, "step_up", "Please confirm it's you again before doing this.");
    setStep({ kind: "password" });
  });
  const linkProvider = (id: string) => withStepUp(async () => {
    const s = await qc.fetchQuery({ ...securityQuery, staleTime: 0 });
    if (!s.recentAuth) throw new ApiError(403, "step_up", "Please confirm it's you again before doing this.");
    window.location.assign(`/api/auth/oidc/${encodeURIComponent(id)}/start?link=1`);
  });
  async function revoke(id: string) {
    try { await del(`/api/account/sessions/${encodeURIComponent(id)}`); refresh(); toast("Signed that device out"); } catch (err) { setError(messageOf(err)); }
  }
  async function signOutOthers() {
    try { await post("/api/account/sessions/sign-out-others"); refresh(); toast("Signed out everywhere else"); } catch (err) { setError(messageOf(err)); }
  }

  if (step.kind === "password") {
    const current = sec.data?.methods.find((m) => m.kind === "password")?.label ?? null;
    return <PasswordForm current={current} submitLabel="Save new password" onDone={() => { refresh(); setStep({ kind: "main" }); toast("Password changed"); }} onCancel={() => setStep({ kind: "main" })} />;
  }
  if (step.kind === "stepup") {
    const then = step.then;
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <p className="hint">For your safety, confirm it's you before this change.</p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <StepUpOptions busy={busy} confirm={(run) => void finishStepUp(() => run().then(() => undefined), then)} />
        <div><button type="button" className="link" onClick={() => { setStep({ kind: "main" }); setError(""); }}>Cancel</button></div>
      </div>
    );
  }

  const password = sec.data?.methods.find((m) => m.kind === "password") ?? null;
  const otherMethods = (sec.data?.methods ?? []).filter((m) => m.kind !== "password");
  const linked = new Set((sec.data?.methods ?? []).filter((m) => m.kind === "oidc").map((m) => m.label));
  const providers = (session?.installation.oidcProviders ?? []).filter((p) => !linked.has(p.label));
  return (
    <>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {sec.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Loading…</p> : null}
      {sec.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(sec.error)}</span></p> : null}
      {sec.data ? (
        <>
          <section className="field" aria-labelledby="sec-p">
            <div className="lbl" id="sec-p">Password</div>
            {password ? (
              <ul className="seclist">
                <li>
                  <Icon name="user" />
                  <span className="tx"><b>{password.label}</b><small>Username · added {shortDate(password.createdAt, Date.now(), ws.prefs.timezone)}{password.lastUsedAt ? ` · last used ${timeAgo(password.lastUsedAt)}` : ""}</small></span>
                </li>
              </ul>
            ) : null}
            <div><Button onClick={() => void openPassword()}>Change username or password</Button></div>
          </section>
          <section className="field" aria-labelledby="sec-m">
            <div className="lbl" id="sec-m">Fingerprint, face or screen lock, and linked sign-ins</div>
            <p className="fine">Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a password manager.</p>
            <ul className="seclist">
              {otherMethods.map((m) => {
                const methodLabel = m.kind === "passkey" ? "Fingerprint, face or screen lock" : m.label ?? "Linked sign-in";
                const customPasskeyLabel = m.kind === "passkey" && m.label && m.label !== methodLabel ? `${m.label} · ` : "";
                return (
                  <li key={m.id}>
                    <Icon name="key" />
                    <span className="tx"><b>{methodLabel}</b><small>{customPasskeyLabel}Added {shortDate(m.createdAt, Date.now(), ws.prefs.timezone)}{m.lastUsedAt ? ` · last used ${timeAgo(m.lastUsedAt)}` : ""}</small></span>
                    <Button onClick={() => void removeMethod(m)} aria-label={`Remove ${methodLabel.toLowerCase()}`}>Remove</Button>
                  </li>
                );
              })}
              {!otherMethods.length ? <li><span className="tx"><small>No linked sign-ins yet.</small></span></li> : null}
            </ul>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {passkeysAvailable() ? <Button disabled={busy} onClick={() => void addPasskey()}><Icon name="plus" size="sm" />Add fingerprint, face or screen lock</Button> : null}
              {providers.map((p) => <Button key={p.id} onClick={() => void linkProvider(p.id)}>Link {p.label}</Button>)}
            </div>
          </section>
          {passkeysAvailable() ? null : <p className="fine">{platform.connection
            ? "Fingerprint, face or screen lock works in the app once this PURSS's operator sets it up (see the app section of the self-hosting guide)."
            : "Fingerprint, face or screen lock needs a secure (https) address, so it can't be added here."}</p>}
          {session?.installation.accountEmail ? <AccountEmailSection withStepUp={withStepUp} /> : null}
          <section className="field" aria-labelledby="sec-s">
            <div className="lbl" id="sec-s">Signed-in devices</div>
            <ul className="seclist">
              {sec.data.sessions.map((s) => (
                <li key={s.id}>
                  <Icon name="user" />
                  <span className="tx"><b>{shortDevice(s.device)}{s.current ? " · This device" : ""}</b><small>Signed in {shortDate(s.createdAt, Date.now(), ws.prefs.timezone)} by {methodName(s.method)} · last used about {timeAgo(s.lastSeenAt) || "now"}{s.sessionClass === "shared" ? " · Shared computer: signs out when the browser closes and after 8 hours" : ""}</small></span>
                  {s.current ? null : <Button onClick={() => void revoke(s.id)}>Sign out</Button>}
                </li>
              ))}
            </ul>
            <div><Button disabled={busy || !sec.data.sessions.some((s) => !s.current)} onClick={() => void signOutOthers()}>Sign out everywhere else</Button></div>
          </section>
        </>
      ) : null}
      {unsynced ? (
        <p className="p-warn"><Icon name="alert" /><span>{unsynced === 1 ? "1 highlight or note hasn't" : `${unsynced} highlights or notes haven't`} synced yet. Signing out deletes {unsynced === 1 ? "it" : "them"} from this browser; connect to the internet first to keep {unsynced === 1 ? "it" : "them"}.</span></p>
      ) : null}
      {out.error ? <p className="state note" role="alert"><Icon name="info" /><span>{out.error}</span></p> : null}
      <div><Button disabled={busy || out.busy} onClick={() => void out.signOut()}>Sign out of this browser</Button></div>
    </>
  );
}

function methodName(m: string): string {
  return { passkey: "fingerprint, face or screen lock", password: "password", signup: "sign-up", setup: "setup", invite: "invitation", oidc: "linked sign-in" }[m] ?? m;
}
function shortDevice(ua: string | null): string {
  if (!ua) return "A browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Which version runs here (plan/40): for reporting a problem, and for reading update posts. */
function VersionNote() {
  const session = useSession();
  const [app, setApp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void platform.appVersion().then((v) => { if (live) setApp(v); });
    return () => { live = false; };
  }, []);
  const line = versionLine({ page: PAGE_VERSION, app, server: session.data?.installation.version ?? null });
  return line ? <span className="fine lft" style={{ alignSelf: "center" }}>{line}</span> : null;
}

export function SettingsDialog({ tab: initial }: { tab?: Tab }) {
  const ov = useOverlays();
  const hosted = useSession().data?.installation.mode === "hosted";
  // The apps have everything the browser has, plus their own device settings.
  const options: { value: Tab; label: string }[] = [
    { value: "general", label: "General" }, { value: "notifications", label: "Notifications and New" },
    ...(platform.connection ? [{ value: "device" as const, label: "This device" }] : []),
    { value: "security", label: "Security" }, { value: "apps", label: "Connected apps" }, { value: "assistants", label: "Assistants" },
    ...(hosted ? [{ value: "plan" as const, label: "Plan" }] : []), { value: "account", label: "Account" },
  ];
  const [tab, setTab] = useState<Tab>(initial && options.some((o) => o.value === initial) ? initial : "general");
  return (
    <Dialog title="Settings" size="lg" onClose={ov.close} initialFocus="dialog" footer={<><VersionNote /><Button variant="primary" onClick={ov.close}>Done</Button></>}>
      <div className="dlg-tabs"><Segmented label="Settings section" value={tab} onChange={setTab} buttonStyle={{ height: 30, padding: "0 14px" }} options={options} /></div>
      {tab === "general" ? <GeneralTab /> : tab === "notifications" ? <NotificationSettings /> : tab === "security" ? <SecurityTab /> : tab === "apps" ? <ConnectedApps onOpen={setTab} /> : tab === "device" ? <DeviceTab /> : tab === "assistants" ? <AssistantSettings /> : tab === "plan" ? <PlanTab /> : <DeleteAccountSection />}
    </Dialog>
  );
}
