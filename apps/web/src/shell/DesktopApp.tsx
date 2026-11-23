import { app as copy } from "@purss/translations/app";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Check, Icon } from "@purss/ui";
import { platform } from "../platform/index.ts";
import type { DesktopApp, DesktopUpdate } from "../platform/types.ts";
import { useToasts } from "../state/toasts.tsx";

const t = copy.shell.desktopApp;
const noSubscribe = () => () => {};
const none: DesktopUpdate = { state: "none" };

/**
 * Settings → This device, in the desktop app: its own updates, starting when you sign in to the computer,
 * the downloads folder, and where the connection is kept. Null elsewhere.
 */
export function DesktopAppSection() {
  const app = platform.desktop;
  const update = useSyncExternalStore(app?.subscribe ?? noSubscribe, app?.update ?? (() => none));
  if (!app) return null;
  return (
    <>
      <AppUpdate app={app} update={update} />
      <StartAtLogin app={app} />
      <DownloadsFolder app={app} />
      <CredentialNote app={app} />
    </>
  );
}

function AppUpdate({ app, update }: { app: DesktopApp; update: DesktopUpdate }) {
  const [busy, setBusy] = useState(false);
  if (update.state === "none") return null;
  return (
    <section className="field" aria-labelledby="dv-app">
      <div className="lbl" id="dv-app">{copy.words.newVersionOfTheApp}</div>
      {update.state === "downloading" ? <p className="state" role="status"><span className="spin" aria-hidden="true" />{t.downloading(update.version)}</p> : null}
      {update.state === "ready" ? <>
        <p className="fine">{t.ready(update.version)}</p>
        <div><Button variant="primary" disabled={busy} onClick={() => { setBusy(true); void app.restartToUpdate().finally(() => setBusy(false)); }}>{t.restart}</Button></div>
      </> : null}
      {update.state === "failed" ? <p className="state note"><Icon name="info" /><span>{t.failed(update.detail)}</span></p> : null}
    </section>
  );
}

function StartAtLogin({ app }: { app: DesktopApp }) {
  const [on, setOn] = useState<boolean | null>(null);
  const { toast } = useToasts();
  useEffect(() => { void app.startAtLogin().then(setOn, () => setOn(null)); }, [app]);
  if (on === null) return null;
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.computer}</legend>
      <Check checked={on} onChange={(v) => { void app.setStartAtLogin(v).then(() => setOn(v), () => toast(t.cantChange)); }}
        hint={t.startHint}>
        {t.startLabel}
      </Check>
    </fieldset>
  );
}

function DownloadsFolder({ app }: { app: DesktopApp }) {
  // The folder, or why it can't be used (a folder of that name that isn't the app's): choosing another still works.
  const [folder, setFolder] = useState<{ path: string } | { problem: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToasts();
  const load = () => void app.downloadsFolder().then((path) => setFolder({ path }), (err: unknown) => setFolder({ problem: String(err) }));
  useEffect(load, [app]);
  async function choose() {
    setBusy(true);
    try {
      const next = await app.chooseDownloadsFolder();
      if (next) { setFolder({ path: next }); toast(t.folderChanged); }
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : String(err));
    } finally { setBusy(false); }
  }
  if (folder === null) return null;
  return (
    <section className="field" aria-labelledby="dv-folder">
      <div className="lbl" id="dv-folder">{t.folderTitle}</div>
      {"path" in folder
        ? <p className="fine">{t.folder.before}<b style={{ wordBreak: "break-all" }}>{folder.path}</b>{t.folder.after}</p>
        : <p className="p-warn"><Icon name="alert" /><span>{folder.problem}{t.folderProblem}</span></p>}
      <div className="fx-acts-row">
        {"path" in folder ? <Button onClick={() => void app.showDownloadsFolder()}><Icon name="folder" size="sm" />{t.showInFolder}</Button> : null}
        <Button disabled={busy} onClick={() => void choose()}>{busy ? t.moving : t.changeFolder}</Button>
      </div>
    </section>
  );
}

function CredentialNote({ app }: { app: DesktopApp }) {
  const [store, setStore] = useState<"system" | "file" | null>(null);
  useEffect(() => { void app.credentialStore().then(setStore, () => undefined); }, [app]);
  if (store !== "file") return null;
  return <p className="p-warn"><Icon name="alert" /><span>{t.noKeyring}</span></p>;
}
