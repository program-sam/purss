import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ImportPreview, OpmlPreview, SourceDTO } from "@purss/domain";
import { Avatar, Button, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { bytesLabel, plural } from "../../lib/format.ts";
import { useWorkspace } from "../../state/workspace.tsx";
import { Note, Page, Section } from "../shared/bits.tsx";
import { downloadFile } from "../shared/download.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { OpmlDialog, OpmlImports } from "./OpmlDialog.tsx";
import { ReconnectDialog } from "./ReconnectDialog.tsx";

const IMPORT_LIMIT = 128 * 1024 * 1024;
const OPML_LIMIT = 2 * 1024 * 1024;

type Feedback = { tone: "ok" | "problem"; text: string } | null;

function ExportSection() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(null);
  async function run() {
    setBusy(true); setFeedback(null); setProgress(0);
    try {
      const out = await downloadFile("/api/export", "purss-export.json", { onProgress: setProgress });
      setFeedback({ tone: "ok", text: `Saved ${out.filename} (${bytesLabel(out.bytes)}). Keep it somewhere private: it holds what you kept and your reading state.` });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(false); }
  }
  return (
    <Section title="Export everything" hint="One file you can keep, move, or import again later.">
      <div className="fx-two-lines">
        <p><b>Included:</b> your sources, collections, baskets and what you kept in them, items with the text that was saved, workflow and reading progress, preferences, and your sharing settings with their public notes.</p>
        <p><b>Left out:</b> passwords, fingerprint, face or screen lock sign-ins and sign-in sessions; private source links and links to items from private sources (those sources come back as “needs reconnecting”); anything you never saved, such as pages, images, audio and video that only exist at their original address and may disappear.</p>
      </div>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy} onClick={() => void run()}><Icon name="download" size="sm" />{busy ? "Preparing…" : "Download export"}</Button>
        {busy ? <span className="state" role="status"><span className="spin" aria-hidden="true" />{progress ? `${bytesLabel(progress)} so far` : "Starting…"}</span> : null}
      </div>
      {feedback ? <Note icon={feedback.tone === "ok" ? "check" : "info"}>{feedback.text}</Note> : null}
    </Section>
  );
}

/** The links kept in baskets as a page or a Markdown list a person can read and print, next to the full export. */
function KeptLinksSection() {
  const [busy, setBusy] = useState<"html" | "md" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  async function run(format: "html" | "md") {
    setBusy(format); setFeedback(null);
    try {
      const out = await downloadFile(`/api/export/kept-links?format=${format}`, `kept-links.${format}`);
      setFeedback({ tone: "ok", text: `Saved ${out.filename} (${bytesLabel(out.bytes)}).` });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(null); }
  }
  return (
    <Section title="Kept links as a list">
      <p>Every basket with the items kept in it: the title as a link to the original, where it came from, and the dates it was published and kept. Open the web page in any browser; the Markdown file suits a notes app.</p>
      <p className="fine">The links go to the original pages, which may change or disappear. This list is for reading; the full export above is the one to import again.</p>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy !== null} onClick={() => void run("html")}><Icon name="download" size="sm" />{busy === "html" ? "Preparing…" : "Download web page"}</Button>
        <Button disabled={busy !== null} onClick={() => void run("md")}><Icon name="download" size="sm" />{busy === "md" ? "Preparing…" : "Download Markdown"}</Button>
      </div>
      {feedback ? <Note icon={feedback.tone === "ok" ? "check" : "info"}>{feedback.text}</Note> : null}
    </Section>
  );
}

function ImportSection() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [staged, setStaged] = useState<{ preview: ImportPreview; name: string } | null>(null);

  async function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > IMPORT_LIMIT) { setError("That file is larger than the 128 MB an import can take."); return; }
    setBusy(true);
    try {
      let doc: unknown;
      try { doc = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a PURSS export (it isn't valid JSON)."); }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("That file isn't a PURSS export.");
      setStaged({ preview: await post<ImportPreview>("/api/import/preview", doc), name: file.name });
    } catch (err) { setError(err instanceof Error && !("code" in err) ? err.message : messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <Section title="Import an export">
      <p>You see what will change before anything is imported. Nothing is deleted. Items already here aren't added twice. Sharing settings come in switched off. Private sources come back as “needs reconnecting”.</p>
      <div className="fx-acts-row">
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void chosen(e)} aria-label="Choose an export file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? "Reading…" : "Choose a file…"}</Button>
      </div>
      {error ? <Note>{error}</Note> : null}
      {staged ? <ImportDialog preview={staged.preview} fileName={staged.name} onClose={() => setStaged(null)} /> : null}
    </Section>
  );
}

function OpmlSection() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [staged, setStaged] = useState<{ preview: OpmlPreview; name: string } | null>(null);

  async function exportOpml() {
    setExporting(true); setFeedback(null);
    try {
      const out = await downloadFile("/api/opml", "followed-sources.opml");
      const left = Number(out.headers.get("x-purss-left-out") ?? 0);
      setFeedback({ tone: "ok", text: `Saved ${out.filename}.${left ? ` ${plural(left, "private source")} ${left === 1 ? "was" : "were"} left out because the link holds a secret.` : ""}` });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setExporting(false); }
  }
  async function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > OPML_LIMIT) { setError("That file is too large to be a subscription list."); return; }
    setBusy(true);
    try { setStaged({ preview: await post<OpmlPreview>("/api/opml/preview", { opml: await file.text() }), name: file.name }); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <Section title="Subscription list (OPML)" hint="The standard list other feed readers use.">
      <p>Export what you follow as an OPML file, or import a list from another reader and choose which feeds to follow. An imported list is followed on the server, so it goes on if you close this page.</p>
      <p className="fine">Only public feeds are exported. Private links contain a secret, so they are left out.</p>
      <div className="fx-acts-row">
        <Button disabled={exporting} onClick={() => void exportOpml()}><Icon name="download" size="sm" />{exporting ? "Preparing…" : "Export subscriptions"}</Button>
        <input ref={input} type="file" accept=".opml,.xml,text/xml,text/x-opml,application/xml" hidden onChange={(e) => void chosen(e)} aria-label="Choose an OPML file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? "Reading…" : "Import a list…"}</Button>
      </div>
      {feedback ? <Note icon={feedback.tone === "ok" ? "check" : "info"}>{feedback.text}</Note> : null}
      {error ? <Note>{error}</Note> : null}
      <OpmlImports />
      {staged ? <OpmlDialog preview={staged.preview} fileName={staged.name} onClose={() => setStaged(null)} /> : null}
    </Section>
  );
}

function ReconnectSection({ sources }: { sources: SourceDTO[] }) {
  const [open, setOpen] = useState<SourceDTO | null>(null);
  if (!sources.length) return null;
  return (
    <Section title="Sources that need reconnecting" hint="Their private links weren't kept, on purpose.">
      <ul className="fx-rows">
        {sources.map((s) => (
          <li key={s.id} className="fx-row">
            <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={28} />
            <div className="fx-grow"><b>{s.title}</b><span className="fine">{s.healthText ?? "Paste its link again to resume."}</span></div>
            <div className="fx-end"><Button onClick={() => setOpen(s)} aria-label={`Reconnect ${s.title}`}>Reconnect…</Button></div>
          </li>
        ))}
      </ul>
      {open ? <ReconnectDialog source={open} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

export function DataPage() {
  const ws = useWorkspace();
  const needs = ws.data.sources.filter((s) => s.health === "reconnect");
  return (
    <Page title="Your data" lead="Your PURSS is yours to take with you. None of this depends on your plan.">
      <ReconnectSection sources={needs} />
      <ExportSection />
      <KeptLinksSection />
      <ImportSection />
      <OpmlSection />
    </Page>
  );
}
