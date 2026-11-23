import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/translations/app";
import type { Preferences } from "@purss/domain";
import { Button, Check, Dialog, Icon, Segmented, SelectInput } from "@purss/ui";
import { ApiError, del, messageOf, post } from "../api/client.ts";
import { keys, securityQuery } from "../api/queries.ts";
import { useSession } from "../api/hooks.ts";
import type { SecurityMethod } from "../api/types.ts";
import { registerPasskey } from "../auth/PasskeyStep.tsx";
import { PasswordForm, passkeysAvailable } from "../auth/PasswordForm.tsx";
import { linkWithProvider } from "../auth/provider-confirm.ts";
import { StepUpOptions } from "../features/shared/step-up.tsx";
import { shortDate, timeAgo } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useSavePreferences } from "../state/prefs.ts";
import { useToasts } from "../state/toasts.tsx";
import { usePurss } from "../state/purss.tsx";
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

const t = app.dialogs.settings;

type Tab = "general" | "notifications" | "security" | "assistants" | "apps" | "device" | "plan" | "account";
const SKINS: { value: Preferences["skin"]; label: string; hue: number }[] = [{ value: "sky", label: t.skins.sky, hue: 212 }, { value: "lilac", label: t.skins.lilac, hue: 268 }, { value: "meadow", label: t.skins.meadow, hue: 152 }];

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
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.sounds.title}</legend>
      <Check checked={s.enabled} onChange={(v) => updateSounds({ enabled: v })} hint={t.sounds.hint}>{t.sounds.enabled}</Check>
      {s.enabled ? (
        <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
          <label className="field" style={{ gap: 4 }}><span className="lbl">{t.sounds.volume}</span>
            <input type="range" min={0.05} max={1} step={0.05} value={s.volume} aria-valuetext={`${Math.round(s.volume * 100)} percent`}
              onChange={(e) => updateSounds({ volume: Number(e.target.value) })} onPointerUp={() => cue("select")} onKeyUp={() => cue("select")} /></label>
          <label className="field" style={{ gap: 4 }}><span className="lbl">{t.sounds.style}</span>
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
        hint={t.display.hint}>{app.words.eInkDisplay}</Check>
    </div>
  );
}

function GeneralTab() {
  const ws = usePurss();
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
      <div className="field"><div className="lbl" id="th">{t.general.theme}</div>
        <Segmented labelledBy="th" value={p.theme} onChange={(v) => void save({ theme: v })} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 16px" }}
          options={[{ value: "light", label: t.general.light }, { value: "dark", label: t.general.dark }, { value: "system", label: t.general.matchDevice }]} />
        {eink ? <p className="fine">{t.general.einkNote}</p> : null}</div>
      <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.general.accent}</legend>
        <div className="swatches">
          {SKINS.map((s) => (
            <label key={s.value} className="sw-opt">
              <input type="radio" name="skin" value={s.value} checked={p.skin === s.value} onChange={() => void save({ skin: s.value })} />
              <span className="c" style={{ "--sh": s.hue } as CSSProperties} aria-hidden="true" />{s.label}
            </label>
          ))}
        </div></fieldset>
      <div className="field"><div className="lbl" id="dn2">{t.general.density}</div>
        <Segmented labelledBy="dn2" value={p.density} onChange={(v) => void save({ density: v })} style={{ justifySelf: "start" }} buttonStyle={{ height: 30, padding: "0 14px" }}
          options={[{ value: "comfortable", label: app.words.comfortable }, { value: "compact", label: app.words.compact }]} /></div>
      <section className="set-device" aria-labelledby="set-device-h">
        <div><h3 id="set-device-h">{app.words.thisDevice}</h3><p className="fine">{t.general.savedHere}</p></div>
        <DisplayField />
        <TextSizeField />
        <SoundsField />
        <OfflineField />
      </section>
      <MutedWordsField />
      <AiSettingsField />
      <div className="field" style={{ gap: 2 }}>
        <Check checked={p.reminders} onChange={(v) => void save({ reminders: v })} hint={t.general.anniversaryHint}>{t.general.anniversary}</Check>
      </div>
      {session?.installation.mode === "hosted" ? (
        <div className="field" style={{ gap: 2 }}>
          <Check checked={p.discoveryShare} onChange={(v) => { void save({ discoveryShare: v }).then(() => qc.removeQueries({ queryKey: fkeys.suggestions })); }}
            hint={app.words.purssCountsSourcesFollowedByPeople}>{app.words.shareMySources}</Check>
        </div>
      ) : null}
      <div className="field"><label htmlFor="tz">{t.general.timeZone}</label>
        <SelectInput id="tz" value={p.timezone} onChange={(e) => void save({ timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</SelectInput>
        <p className="fine">{t.general.timeZoneUse}{device && device !== p.timezone ? <button type="button" className="link" onClick={() => void save({ timezone: device })}>{t.general.useDevice(device.replace(/_/g, " "))}</button> : null}</p></div>
      <div className="field"><div className="lbl" id="more-l">{app.words.more}</div>
        <div role="group" aria-labelledby="more-l" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {hasPage("/settings/data") ? <Button onClick={() => go("/settings/data")}>{app.words.yourData}</Button> : null}
          <Button onClick={() => go("/sharing")}>{app.words.sharing}</Button>
          <Button onClick={() => ov.open({ kind: "shortcuts" })}>{app.words.keyboardShortcuts}</Button>
        </div>
      </div>
    </>
  );
}

type Step = { kind: "main" } | { kind: "stepup"; then: () => Promise<void> } | { kind: "password" };

function SecurityTab() {
  const ws = usePurss();
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
  const addPasskey = () => withStepUp(async () => { await registerPasskey(null); await refreshQueries(); toast(t.security.passkeyAdded); });
  const removeMethod = (m: SecurityMethod) => withStepUp(async () => { await del(`/api/account/methods/${encodeURIComponent(m.id)}`); refresh(); toast(t.security.methodRemoved); });
  // Changing the password takes the current one in the form. Adding a first one needs a recent sign-in when saved, so that is
  // confirmed first and nothing typed is lost.
  const hadPassword = !!sec.data?.methods.some((m) => m.kind === "password");
  const openPassword = () => hadPassword ? setStep({ kind: "password" }) : withStepUp(async () => {
    const s = await qc.fetchQuery({ ...securityQuery, staleTime: 0 });
    if (!s.recentAuth) throw new ApiError(403, "step_up", t.security.stepUpNeeded);
    setStep({ kind: "password" });
  });
  const linkProvider = (p: { id: string; label: string }) => withStepUp(async () => {
    const s = await qc.fetchQuery({ ...securityQuery, staleTime: 0 });
    if (!s.recentAuth) throw new ApiError(403, "step_up", t.security.stepUpNeeded);
    toast(platform.connection ? t.security.finishConnecting(p.label) : t.security.opening(p.label));
    await linkWithProvider(p);
    await refreshQueries();
    toast(t.security.connected(p.label));
  });
  async function revoke(id: string) {
    try { await del(`/api/account/sessions/${encodeURIComponent(id)}`); refresh(); toast(t.security.deviceSignedOut); } catch (err) { setError(messageOf(err)); }
  }
  async function signOutOthers() {
    try { await post("/api/account/sessions/sign-out-others"); refresh(); toast(t.security.othersSignedOut); } catch (err) { setError(messageOf(err)); }
  }

  if (step.kind === "password") {
    return <PasswordForm email={session?.account?.email ?? null} hasPassword={hadPassword} submitLabel={hadPassword ? app.words.saveNewPassword : t.security.addPassword} onDone={() => { refresh(); setStep({ kind: "main" }); toast(hadPassword ? t.security.passwordChanged : t.security.passwordAdded); }} onCancel={() => setStep({ kind: "main" })} />;
  }
  if (step.kind === "stepup") {
    const then = step.then;
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <p className="hint">{t.security.confirmItsYou}</p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        <StepUpOptions busy={busy} returnTo="/?dialog=security" confirm={(run) => void finishStepUp(() => run().then(() => undefined), then)} />
        <div><button type="button" className="link" onClick={() => { setStep({ kind: "main" }); setError(""); }}>{app.words.cancel}</button></div>
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
      {sec.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{app.words.loading}</p> : null}
      {sec.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(sec.error)}</span></p> : null}
      {sec.data ? (
        <>
          <section className="field" aria-labelledby="sec-p">
            <div className="lbl" id="sec-p">{app.words.password}</div>
            {password ? (
              <ul className="seclist">
                <li>
                  <Icon name="user" />
                  <span className="tx"><b>{app.words.password}</b><small>{session?.account?.email ? t.security.forEmail(session.account.email) : ""}{t.security.added(shortDate(password.createdAt, Date.now(), ws.prefs.timezone))}{password.lastUsedAt ? t.security.lastUsed(timeAgo(password.lastUsedAt)) : ""}</small></span>
                </li>
              </ul>
            ) : null}
            {!password ? <p className="fine">{t.security.noPassword((sec.data?.methods ?? []).filter((m) => m.kind === "oidc").map((m) => m.label).join(t.security.joinAnd) || t.security.linkedSignIn)}</p> : null}
            <div><Button onClick={() => void openPassword()}>{password ? t.security.changePassword : t.security.addAPassword}</Button></div>
          </section>
          <section className="field" aria-labelledby="sec-m">
            <div className="lbl" id="sec-m">{t.security.passkeysAndLinked}</div>
            <p className="fine">{t.security.passkeyHint}</p>
            <ul className="seclist">
              {otherMethods.map((m) => {
                const methodLabel = m.kind === "passkey" ? t.security.passkey : m.label ?? t.security.linkedSignInTitle;
                const customPasskeyLabel = m.kind === "passkey" && m.label && m.label !== methodLabel ? t.security.passkeyLabelPrefix(m.label) : "";
                return (
                  <li key={m.id}>
                    <Icon name="key" />
                    <span className="tx"><b>{methodLabel}</b><small>{customPasskeyLabel}{t.security.added(shortDate(m.createdAt, Date.now(), ws.prefs.timezone))}{m.lastUsedAt ? t.security.lastUsed(timeAgo(m.lastUsedAt)) : ""}</small></span>
                    <Button onClick={() => void removeMethod(m)} aria-label={`Remove ${methodLabel.toLowerCase()}`}>{app.words.remove}</Button>
                  </li>
                );
              })}
              {!otherMethods.length ? <li><span className="tx"><small>{t.security.noLinked}</small></span></li> : null}
            </ul>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {passkeysAvailable() ? <Button disabled={busy} onClick={() => void addPasskey()}><Icon name="plus" size="sm" />{app.words.addAPasskey}</Button> : null}
              {providers.map((p) => <Button key={p.id} onClick={() => void linkProvider(p)}>{t.security.link(p.label)}</Button>)}
            </div>
          </section>
          {passkeysAvailable() ? null : <p className="fine">{platform.connection
            ? session?.installation.mode === "self" ? t.security.passkeysSelfHosted : t.security.passkeysNotYet
            : t.security.passkeysNeedHttps}</p>}
          <AccountEmailSection withStepUp={withStepUp} />
          <section className="field" aria-labelledby="sec-s">
            <div className="lbl" id="sec-s">{t.security.signedInDevices}</div>
            <ul className="seclist">
              {sec.data.sessions.map((s) => (
                <li key={s.id}>
                  <Icon name="user" />
                  <span className="tx"><b>{shortDevice(s.device)}{s.current ? t.security.thisDevice : ""}</b><small>{t.security.signedIn(shortDate(s.createdAt, Date.now(), ws.prefs.timezone), methodName(s.method), timeAgo(s.lastSeenAt) || t.security.now)}{s.sessionClass === "shared" ? t.security.sharedComputer : ""}</small></span>
                  {s.current ? null : <Button onClick={() => void revoke(s.id)}>{app.words.signOut}</Button>}
                </li>
              ))}
            </ul>
            <div><Button disabled={busy || !sec.data.sessions.some((s) => !s.current)} onClick={() => void signOutOthers()}>{t.security.signOutOthers}</Button></div>
          </section>
        </>
      ) : null}
      {unsynced ? (
        <p className="p-warn"><Icon name="alert" /><span>{t.security.unsynced(unsynced)}</span></p>
      ) : null}
      {out.error ? <p className="state note" role="alert"><Icon name="info" /><span>{out.error}</span></p> : null}
      <div><Button disabled={busy || out.busy} onClick={() => void out.signOut()}>{t.security.signOutBrowser}</Button></div>
    </>
  );
}

function methodName(m: string): string {
  return (t.security.methodNames as Record<string, string | undefined>)[m] ?? m;
}
function shortDevice(ua: string | null): string {
  if (!ua) return t.security.aBrowser;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : t.security.aBrowser;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? t.security.browserOn(browser, os) : browser;
}

/** Which version runs here: for reporting a problem, and for reading update posts. */
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
    { value: "general", label: t.dialog.tabs.general }, { value: "notifications", label: t.dialog.tabs.notifications },
    ...(platform.connection ? [{ value: "device" as const, label: app.words.thisDevice }] : []),
    { value: "security", label: t.dialog.tabs.security }, { value: "apps", label: t.dialog.tabs.apps }, { value: "assistants", label: app.words.assistants },
    ...(hosted ? [{ value: "plan" as const, label: app.words.plan }] : []), { value: "account", label: app.words.account },
  ];
  const [tab, setTab] = useState<Tab>(initial && options.some((o) => o.value === initial) ? initial : "general");
  return (
    <Dialog title={app.words.settings} size="lg" onClose={ov.close} initialFocus="dialog" footer={<><VersionNote /><Button variant="primary" onClick={ov.close}>{app.words.done}</Button></>}>
      <div className="dlg-tabs"><Segmented label="Settings section" value={tab} onChange={setTab} buttonStyle={{ height: 30, padding: "0 14px" }} options={options} /></div>
      {tab === "general" ? <GeneralTab /> : tab === "notifications" ? <NotificationSettings /> : tab === "security" ? <SecurityTab /> : tab === "apps" ? <ConnectedApps onOpen={setTab} /> : tab === "device" ? <DeviceTab /> : tab === "assistants" ? <AssistantSettings /> : tab === "plan" ? <PlanTab /> : <DeleteAccountSection />}
    </Dialog>
  );
}
