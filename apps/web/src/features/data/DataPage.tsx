import { useRef, useState } from "react";
import type { ChangeEvent, Ref } from "react";
import type { ImportPreview, OpmlPreview, SourceDTO } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Avatar, Button, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { bytesLabel, plural } from "../../lib/format.ts";
import { useFocusResult } from "../../lib/use-focus.ts";
import { useWorkspace } from "../../state/workspace.tsx";
import { Note, Page, Section } from "../shared/bits.tsx";
import { downloadFile } from "../shared/download.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { OpmlDialog, OpmlImports } from "./OpmlDialog.tsx";
import { ReconnectDialog } from "./ReconnectDialog.tsx";

const t = app.data.dataPage;

const IMPORT_LIMIT = 128 * 1024 * 1024;
const OPML_LIMIT = 2 * 1024 * 1024;

type Feedback = { tone: "ok" | "problem"; text: string } | null;

/** What a download or a read came to: read out when it appears, and where focus lands when the button that started it was disabled meanwhile. */
function Outcome({ tone, text, ref }: { tone: "ok" | "problem"; text: string; ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} tabIndex={-1} role={tone === "ok" ? "status" : "alert"}><Note icon={tone === "ok" ? "check" : "info"}>{text}</Note></div>;
}

function ExportSection() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const result = useFocusResult<HTMLDivElement>(busy);
  async function run() {
    setBusy(true); setFeedback(null); setProgress(0);
    try {
      const out = await downloadFile("/api/export", "purss-export.json", { onProgress: setProgress });
      setFeedback({ tone: "ok", text: t.exportSection.saved(out.filename, bytesLabel(out.bytes)) });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(false); }
  }
  return (
    <Section title={t.exportSection.title} hint={t.exportSection.hint}>
      <div className="fx-two-lines">
        <p><b>{t.exportSection.included}</b>{t.exportSection.includedText}</p>
        <p><b>{t.exportSection.leftOut}</b>{t.exportSection.leftOutText}</p>
      </div>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy} onClick={() => void run()}><Icon name="download" size="sm" />{busy ? t.preparing : t.exportSection.download}</Button>
        {busy ? <span className="state" role="status"><span className="spin" aria-hidden="true" />{progress ? t.exportSection.soFar(bytesLabel(progress)) : t.exportSection.starting}</span> : null}
      </div>
      {feedback ? <Outcome ref={result} tone={feedback.tone} text={feedback.text} /> : null}
    </Section>
  );
}

/** The links kept in baskets as a page or a Markdown list a person can read and print, next to the full export. */
function KeptLinksSection() {
  const [busy, setBusy] = useState<"html" | "md" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const result = useFocusResult<HTMLDivElement>(busy !== null);
  async function run(format: "html" | "md") {
    setBusy(format); setFeedback(null);
    try {
      const out = await downloadFile(`/api/export/kept-links?format=${format}`, `kept-links.${format}`);
      setFeedback({ tone: "ok", text: t.keptLinks.saved(out.filename, bytesLabel(out.bytes)) });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(null); }
  }
  return (
    <Section title={t.keptLinks.title}>
      <p>{t.keptLinks.text}</p>
      <p className="fine">{t.keptLinks.fine}</p>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy !== null} onClick={() => void run("html")}><Icon name="download" size="sm" />{busy === "html" ? t.preparing : t.keptLinks.downloadPage}</Button>
        <Button disabled={busy !== null} onClick={() => void run("md")}><Icon name="download" size="sm" />{busy === "md" ? t.preparing : t.keptLinks.downloadMarkdown}</Button>
      </div>
      {feedback ? <Outcome ref={result} tone={feedback.tone} text={feedback.text} /> : null}
    </Section>
  );
}

function ImportSection() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const result = useFocusResult<HTMLDivElement>(busy);
  const [staged, setStaged] = useState<{ preview: ImportPreview; name: string } | null>(null);

  async function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > IMPORT_LIMIT) { setError(t.importSection.tooLarge); return; }
    setBusy(true);
    try {
      let doc: unknown;
      try { doc = JSON.parse(await file.text()); } catch { throw new Error(t.importSection.notJson); }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(t.importSection.notExport);
      setStaged({ preview: await post<ImportPreview>("/api/import/preview", doc), name: file.name });
    } catch (err) { setError(err instanceof Error && !("code" in err) ? err.message : messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <Section title={t.importSection.title}>
      <p>{t.importSection.text}</p>
      <div className="fx-acts-row">
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void chosen(e)} aria-label="Choose an export file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? t.reading : t.importSection.chooseFile}</Button>
      </div>
      {error ? <Outcome ref={result} tone="problem" text={error} /> : null}
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
  const exported = useFocusResult<HTMLDivElement>(exporting);
  const read = useFocusResult<HTMLDivElement>(busy);
  const [staged, setStaged] = useState<{ preview: OpmlPreview; name: string } | null>(null);

  async function exportOpml() {
    setExporting(true); setFeedback(null);
    try {
      const out = await downloadFile("/api/opml", "followed-sources.opml");
      const left = Number(out.headers.get("x-purss-left-out") ?? 0);
      setFeedback({ tone: "ok", text: t.opmlSection.saved(out.filename, left, plural(left, t.opmlSection.privateSource)) });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setExporting(false); }
  }
  async function chosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > OPML_LIMIT) { setError(t.opmlSection.tooLarge); return; }
    setBusy(true);
    try { setStaged({ preview: await post<OpmlPreview>("/api/opml/preview", { opml: await file.text() }), name: file.name }); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <Section title={t.opmlSection.title} hint={t.opmlSection.hint}>
      <p>{t.opmlSection.text}</p>
      <p className="fine">{t.opmlSection.fine}</p>
      <div className="fx-acts-row">
        <Button disabled={exporting} onClick={() => void exportOpml()}><Icon name="download" size="sm" />{exporting ? t.preparing : t.opmlSection.export}</Button>
        <input ref={input} type="file" accept=".opml,.xml,text/xml,text/x-opml,application/xml" hidden onChange={(e) => void chosen(e)} aria-label="Choose an OPML file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? t.reading : t.opmlSection.importList}</Button>
      </div>
      {feedback ? <Outcome ref={exported} tone={feedback.tone} text={feedback.text} /> : null}
      {error ? <Outcome ref={read} tone="problem" text={error} /> : null}
      <OpmlImports />
      {staged ? <OpmlDialog preview={staged.preview} fileName={staged.name} onClose={() => setStaged(null)} /> : null}
    </Section>
  );
}

function ReconnectSection({ sources }: { sources: SourceDTO[] }) {
  const [open, setOpen] = useState<SourceDTO | null>(null);
  if (!sources.length) return null;
  return (
    <Section title={t.reconnectSection.title} hint={t.reconnectSection.hint}>
      <ul className="fx-rows">
        {sources.map((s) => (
          <li key={s.id} className="fx-row">
            <Avatar hue={s.hue} initials={s.initials} src={s.iconUrl} size={28} />
            <div className="fx-grow"><b>{s.title}</b><span className="fine">{s.healthText ?? t.reconnectSection.pasteAgain}</span></div>
            <div className="fx-end"><Button onClick={() => setOpen(s)} aria-label={`Reconnect ${s.title}`}>{t.reconnectSection.reconnect}</Button></div>
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
    <Page title={t.title} lead={t.lead}>
      <ReconnectSection sources={needs} />
      <ExportSection />
      <KeptLinksSection />
      <ImportSection />
      <OpmlSection />
    </Page>
  );
}
