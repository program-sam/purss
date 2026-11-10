import { useState } from "react";
import { Button, Check, Icon } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { platform } from "../platform/index.ts";

/** Shows recovery codes once, with copy and download, and asks the person to confirm they are saved. */
/** `acknowledge` records that they are saved; the mobile app's sign-up sends it with its new device token instead of a session. */
export function RecoveryCodesPanel({ codes, generation, onSaved, confirmLabel = "Continue", acknowledge: send = (g) => post("/api/account/recovery-codes/acknowledge", { generation: g }) }: { codes: string[]; generation: number; onSaved: () => void; confirmLabel?: string; acknowledge?: (generation: number) => Promise<unknown> }) {
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try { await navigator.clipboard.writeText(text); setNote("Copied."); } catch { setNote("Couldn't copy. Select the codes and copy them by hand."); }
  }
  async function download() {
    const blob = new Blob([`Recovery codes\nEach code signs you in once. Use one if you lose your phone or forget your password.\n\n${text}\n`], { type: "text/plain" });
    try { await platform.saveFile(blob, "purss-recovery-codes.txt"); setNote(platform.connection ? "" : "Downloaded."); } catch { setNote("Couldn't save the file. Copy the codes instead."); }
  }

  async function acknowledge() {
    setBusy(true); setError("");
    try {
      await send(generation);
      onSaved();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="hint">Save these codes somewhere safe. If you lose your phone or forget your password, each code signs you in once. They can't be shown again. Closed this page too soon? Make a new set in Settings.</p>
      <ul className="codes" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button onClick={copy}><Icon name="copy" size="sm" />Copy</Button>
        <Button onClick={() => void download()}><Icon name="download" size="sm" />{platform.connection ? "Save" : "Download"}</Button>
        <span className="fine" role="status">{note}</span>
      </div>
      <Check checked={saved} onChange={setSaved}>I've saved these codes somewhere safe</Check>
      {error ? <p className="state note" role="alert">{error}</p> : null}
      <div><Button variant="primary" disabled={!saved || busy} onClick={() => void acknowledge()}>{busy ? "Saving…" : confirmLabel}</Button></div>
    </div>
  );
}
