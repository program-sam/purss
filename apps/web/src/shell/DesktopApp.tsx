import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Check, Icon } from "@purss/ui";
import { platform } from "../platform/index.ts";
import type { DesktopApp, DesktopUpdate } from "../platform/types.ts";
import { useToasts } from "../state/toasts.tsx";

const noSubscribe = () => () => {};
const none: DesktopUpdate = { state: "none" };

/**
 * Settings → This device, in the desktop app (plan/42): its own updates, starting when you sign in to the computer,
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
      <div className="lbl" id="dv-app">New version of the app</div>
      {update.state === "downloading" ? <p className="state" role="status"><span className="spin" aria-hidden="true" />Downloading version {update.version}…</p> : null}
      {update.state === "ready" ? <>
        <p className="fine">Version {update.version} is ready. It's installed when you restart the app, or when you quit it from the tray.</p>
        <div><Button variant="primary" disabled={busy} onClick={() => { setBusy(true); void app.restartToUpdate().finally(() => setBusy(false)); }}>Restart to update</Button></div>
      </> : null}
      {update.state === "failed" ? <p className="state note"><Icon name="info" /><span>The new version couldn't be installed: {update.detail} The app tries again later.</span></p> : null}
    </section>
  );
}

function StartAtLogin({ app }: { app: DesktopApp }) {
  const [on, setOn] = useState<boolean | null>(null);
  const { toast } = useToasts();
  useEffect(() => { void app.startAtLogin().then(setOn, () => setOn(null)); }, [app]);
  if (on === null) return null;
  return (
    <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>On this computer</legend>
      <Check checked={on} onChange={(v) => { void app.setStartAtLogin(v).then(() => setOn(v), () => toast("Couldn't change that. Try again.")); }}
        hint="The app starts in the tray, so notifications and automatic downloads go on. Closing its window keeps it running there; quit it from the tray icon.">
        Start when you sign in to the computer
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
      if (next) { setFolder({ path: next }); toast("Downloads are now kept in the new folder."); }
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : String(err));
    } finally { setBusy(false); }
  }
  if (folder === null) return null;
  return (
    <section className="field" aria-labelledby="dv-folder">
      <div className="lbl" id="dv-folder">Downloads folder</div>
      {"path" in folder
        ? <p className="fine">Downloads are files in <b style={{ wordBreak: "break-all" }}>{folder.path}</b>, one folder per item. Other programs can open them. They're removed when you remove the download or disconnect this app; anything else you put in that folder is left alone.</p>
        : <p className="p-warn"><Icon name="alert" /><span>{folder.problem} Downloads can't be kept until you do.</span></p>}
      <div className="fx-acts-row">
        {"path" in folder ? <Button onClick={() => void app.showDownloadsFolder()}><Icon name="folder" size="sm" />Show in folder</Button> : null}
        <Button disabled={busy} onClick={() => void choose()}>{busy ? "Moving…" : "Change folder…"}</Button>
      </div>
    </section>
  );
}

function CredentialNote({ app }: { app: DesktopApp }) {
  const [store, setStore] = useState<"system" | "file" | null>(null);
  useEffect(() => { void app.credentialStore().then(setStore, () => undefined); }, [app]);
  if (store !== "file") return null;
  return <p className="p-warn"><Icon name="alert" /><span>This computer has no keyring for passwords, so the app's connection is kept in a file only your user account can read.</span></p>;
}
