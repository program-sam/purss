import { useRef, useState } from "react";
import type { ChangeEvent, Ref } from "react";
import type { ImportPreview, OpmlPreview, SourceDTO } from "@purss/domain";
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
      setFeedback({ tone: "ok", text: `Saved ${out.filename} (${bytesLabel(out.bytes)}). Keep it somewhere private: it holds what you kept and your reading state.` });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(false); }
  }
  return (
    <Section title="Export everything" hint="One file you can keep, move, or import again later.">
      <div className="fx-two-lines">
        <p><b>Included:</b> your sources, collections and baskets with everything kept in them; saved text and pictures; your states, reading progress, highlights, notes and reminders; preferences; and sharing settings with their public notes.</p>
        <p><b>Left out:</b> passwords and other sign-in methods; the links of private sources (they come back as “needs reconnecting”); and anything PURSS never saved, such as pages, audio and video that live only at their original address.</p>
      </div>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy} onClick={() => void run()}><Icon name="download" size="sm" />{busy ? "Preparing…" : "Download export"}</Button>
        {busy ? <span className="state" role="status"><span className="spin" aria-hidden="true" />{progress ? `${bytesLabel(progress)} so far` : "Starting…"}</span> : null}
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
      setFeedback({ tone: "ok", text: `Saved ${out.filename} (${bytesLabel(out.bytes)}).` });
    } catch (err) { setFeedback({ tone: "problem", text: messageOf(err) }); } finally { setBusy(null); }
  }
  return (
    <Section title="Kept links as a list">
      <p>Every basket as a readable list: each kept item's title linked to the original, with its source and the dates it was published and kept. Open the web page in any browser, or the Markdown file in a notes app.</p>
      <p className="fine">The originals may change or disappear, and this list can't be imported back; the full export above can.</p>
      <div className="fx-acts-row">
        <Button variant="primary" disabled={busy !== null} onClick={() => void run("html")}><Icon name="download" size="sm" />{busy === "html" ? "Preparing…" : "Download web page"}</Button>
        <Button disabled={busy !== null} onClick={() => void run("md")}><Icon name="download" size="sm" />{busy === "md" ? "Preparing…" : "Download Markdown"}</Button>
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
    <Section title="Import a PURSS export">
      <p>You see what would change first. Nothing is deleted and nothing is added twice. Sharing comes in switched off, and private sources need reconnecting.</p>
      <div className="fx-acts-row">
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void chosen(e)} aria-label="Choose an export file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? "Reading…" : "Choose a file…"}</Button>
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
      <p>Export what you follow as an OPML file, or import a list from another reader and choose which feeds to follow. Importing continues in the background, so it keeps going if you close this page.</p>
      <p className="fine">Only public feeds are exported. Private links contain a secret, so they are left out.</p>
      <div className="fx-acts-row">
        <Button disabled={exporting} onClick={() => void exportOpml()}><Icon name="download" size="sm" />{exporting ? "Preparing…" : "Export subscriptions"}</Button>
        <input ref={input} type="file" accept=".opml,.xml,text/xml,text/x-opml,application/xml" hidden onChange={(e) => void chosen(e)} aria-label="Choose an OPML file" />
        <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="plus" size="sm" />{busy ? "Reading…" : "Import a list…"}</Button>
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
