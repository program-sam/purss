import { useEffect, useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpmlImportDestination, OpmlImportDTO, OpmlImportEntryDTO, OpmlPreview, OpmlPreviewEntry } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, get, messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { plural } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useWorkspace } from "../../state/workspace.tsx";

const t = app.data.opmlDialog;

/** An OPML file opened with the desktop app: read on the server, then the same choice as an import from Your data. */
export function OpenedOpmlFile({ name, text, onClose }: { name: string; text: string; onClose: () => void }) {
  const [read, setRead] = useState<{ preview: OpmlPreview } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    post<OpmlPreview>("/api/opml/preview", { opml: text }).then((preview) => { if (live) setRead({ preview }); }, (err: unknown) => { if (live) setRead({ error: messageOf(err) }); });
    return () => { live = false; };
  }, [text]);
  if (read && "preview" in read) return <OpmlDialog preview={read.preview} fileName={name} onClose={onClose} />;
  return (
    <Dialog title={app.words.subscriptionListOpml} onClose={onClose} footer={<Button onClick={onClose}>{app.words.close}</Button>}>
      {read ? <p className="state note"><Icon name="info" /><span>{read.error}</span></p>
        : <p className="state" role="status"><span className="spin" aria-hidden="true" />{t.readingBefore}<b style={{ wordBreak: "break-all" }}>{name}</b>{"…"}</p>}
    </Dialog>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const NEW = "__new";
const NONE = "__none";
const FOLDERS = "__folders";

/** The lists of feeds followed on the server, newest first. Checked often while one is still going. */
export const opmlImportsQuery = queryOptions({
  queryKey: ["opml-imports"] as const,
  queryFn: () => get<OpmlImportDTO[]>("/api/opml/imports"),
  refetchInterval: (q) => (q.state.data?.some((i) => i.status === "running") ? 2500 : false),
});
const opmlImportQuery = (id: string) => queryOptions({
  queryKey: ["opml-imports", id] as const,
  queryFn: () => get<OpmlImportDTO>(`/api/opml/imports/${encodeURIComponent(id)}`),
  refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
});

function Outcome({ o }: { o: OpmlImportEntryDTO }) {
  const nav = useNav();
  switch (o.state) {
    case "waiting": return <span className="fine">{app.words.waiting}</span>;
    case "working": return <span className="state"><span className="spin" aria-hidden="true" />{app.words.looking}</span>;
    case "followed": return <span className="fx-ok"><Icon name="check" size="sm" />{t.outcome.following}{o.message ? <span className="fine"> · {o.message}</span> : null}</span>;
    case "already": return <span className="fine">{app.words.alreadyFollowing}{o.sourceId ? <> · <button type="button" className="link" onClick={() => nav.go({ t: "s", id: o.sourceId! })}>{app.words.open}</button></> : null}</span>;
    case "failed": return <span className="fx-fail"><Icon name="alert" size="sm" />{o.message}</span>;
  }
}

/** One-line account of a list: how far it is and how it went. */
export function importSummary(i: OpmlImportDTO): string {
  const checked = i.total - i.waiting;
  if (i.status === "running") return t.summary.progress(checked, plural(i.total, app.words.feed));
  const parts = [i.followed ? t.summary.following(plural(i.followed, t.summary.newSource)) : t.summary.nothingNew, i.already ? t.summary.already(i.already) : "", i.failed ? t.summary.failed(i.failed) : "", i.status === "stopped" && i.waiting ? t.summary.notLookedAt(i.waiting) : ""];
  return `${parts.filter(Boolean).join(". ")}.`;
}

/** A list being followed on the server: what each feed came to, as it happens. Closing this window doesn't stop it. */
export function OpmlProgressDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNav();
  const ws = useWorkspace();
  const q = useQuery(opmlImportQuery(id));
  const stop = useMutation({
    mutationFn: () => post<OpmlImportDTO>(`/api/opml/imports/${encodeURIComponent(id)}/stop`),
    onSuccess: (out) => { qc.setQueryData(["opml-imports", id], out); void qc.invalidateQueries({ queryKey: ["opml-imports"] }); refreshWorkspace(qc); },
  });
  const list = q.data;
  const running = list?.status === "running";
  // Sources appear in the sidebar as they are followed.
  const followed = list?.followed ?? 0;
  useEffect(() => { if (followed) refreshWorkspace(qc); }, [followed, qc]);
  return (
    <Dialog title={running ? t.progress.runningTitle : t.progress.title} size="md" onClose={onClose}
      footer={running
        ? <><Button onClick={() => stop.mutate()} disabled={stop.isPending}>{t.progress.stop}</Button><Button variant="primary" onClick={onClose}>{app.words.close}</Button></>
        : <Button variant="primary" onClick={onClose}>{app.words.done}</Button>}>
      {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
      {list ? (
        <>
          <p className="state" aria-live="polite">{running ? <span className="spin" aria-hidden="true" /> : null}{importSummary(list)}</p>
          {running ? <p className="fine">{t.progress.background}</p> : null}
          {stop.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(stop.error)}</span></p> : null}
          <ul className="fx-rows fx-scroll">
            {list.entries!.map((e) => (
              <li key={e.position} className="fx-row">
                <div className="fx-grow"><b dir="auto">{(e.sourceId && ws.data.sources.find((src) => src.id === e.sourceId)?.title) || e.title}</b><span className="fine">{e.host}{e.folder ? ` · ${e.folder}` : ""}</span></div>
                <div className="fx-end fx-outcome"><Outcome o={e} /></div>
              </li>
            ))}
          </ul>
          {!running && list.followed ? <p className="fine">{t.progress.newItems}{" "}<button type="button" className="link" onClick={() => { onClose(); nav.go({ t: "home" }); }}>{app.words.goToHome}</button></p> : null}
        </>
      ) : q.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{app.words.loading}</p> : null}
    </Dialog>
  );
}

/** The recent lists on the Your data page, with their progress; open one for the feed-by-feed result. */
export function OpmlImports() {
  const qc = useQueryClient();
  const q = useQuery(opmlImportsQuery);
  const [open, setOpen] = useState<string | null>(null);
  const forget = useMutation({
    mutationFn: (id: string) => del(`/api/opml/imports/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opml-imports"] }),
  });
  const lists = q.data ?? [];
  if (!lists.length) return null;
  return (
    <>
      <ul className="fx-rows">
        {lists.map((i) => (
          <li key={i.id} className="fx-row">
            <div className="fx-grow"><b>{i.fileName}</b><span className="fine" aria-live="polite">{importSummary(i)}</span></div>
            <div className="fx-end">
              <Button onClick={() => setOpen(i.id)} aria-label={`${i.status === "running" ? "Watch" : "See"} ${i.fileName}`}>{i.status === "running" ? app.words.watch : t.imports.see}</Button>
              {i.status !== "running" ? <Button onClick={() => forget.mutate(i.id)} disabled={forget.isPending} aria-label={`Forget ${i.fileName}`}>{t.imports.forget}</Button> : null}
            </div>
          </li>
        ))}
      </ul>
      {forget.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(forget.error)}</span></p> : null}
      {open ? <OpmlProgressDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/**
 * Import a list of feeds: choose which, and where they go. The server then follows them one by one, each looked up
 * first just like Add source, so the list goes on when this window is closed.
 */
export function OpmlDialog({ preview, fileName, onClose }: { preview: OpmlPreview; fileName: string; onClose: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const feeds = preview.feeds;
  const selectable = (f: OpmlPreviewEntry) => !f.alreadyFollowing;
  const [picked, setPicked] = useState<Set<number>>(() => new Set(feeds.flatMap((f, i) => (selectable(f) && !f.looksPrivate ? [i] : []))));
  const hasFolders = feeds.some((f) => f.folder);
  const sourceCollections = ws.collections.filter((c) => c.mode === "sources");
  const [dest, setDest] = useState<string>(hasFolders ? FOLDERS : NONE);
  const [newName, setNewName] = useState("");
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const chosen = useMemo(() => feeds.map((f, i) => [f, i] as const).filter(([, i]) => picked.has(i)), [feeds, picked]);
  const toggle = (i: number) => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const allOn = feeds.every((f, i) => !selectable(f) || picked.has(i));
  const destination = (): OpmlImportDestination => dest === NONE ? { kind: "none" } : dest === FOLDERS ? { kind: "folders" } : dest === NEW ? { kind: "new", name: newName.trim() } : { kind: "collection", id: dest };
  const destOk = dest !== NEW || newName.trim().length > 0;
  const total = chosen.length;

  async function run() {
    if (!total || !destOk) return;
    setBusy(true); setError("");
    try {
      const out = await post<OpmlImportDTO>("/api/opml/imports", { fileName, destination: destination(), feeds: chosen.map(([f]) => ({ title: f.title, feedUrl: f.feedUrl, siteUrl: f.siteUrl, folder: f.folder })) });
      qc.setQueryData(["opml-imports", out.id], out);
      void qc.invalidateQueries({ queryKey: ["opml-imports"] });
      refreshWorkspace(qc);
      setStarted(out.id);
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  if (started) return <OpmlProgressDialog id={started} onClose={onClose} />;

  return (
    <Dialog title={t.dialog.title} size="lg" onClose={onClose} initialFocus="#op-all"
      footer={<><Button onClick={onClose}>{app.words.cancel}</Button><Button variant="primary" disabled={!total || !destOk || busy} onClick={() => void run()}>{total ? t.dialog.followFeeds(plural(total, app.words.feed)) : app.words.follow}</Button></>}>
      <p className="hint"><b style={{ wordBreak: "break-all" }}>{fileName}</b>{t.dialog.listsAfter(plural(feeds.length, app.words.feed))}</p>
      {preview.truncated ? <p className="state note"><Icon name="info" /><span>{t.dialog.truncated(feeds.length)}</span></p> : null}
      {preview.skipped.notWebAddress || preview.skipped.duplicates ? (
        <p className="fine">{t.dialog.leftOut}{[preview.skipped.notWebAddress ? t.dialog.withoutWebAddress(plural(preview.skipped.notWebAddress, app.words.entry, app.words.entries)) : "", preview.skipped.duplicates ? `${plural(preview.skipped.duplicates, t.dialog.duplicate)}` : ""].filter(Boolean).join(", ")}.</p>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {feeds.length ? (
        <div className="field">
          <div className="fx-pick-head">
            <label className="fx-allbox"><input id="op-all" type="checkbox" checked={allOn && picked.size > 0} onChange={(e) => setPicked(e.target.checked ? new Set(feeds.flatMap((f, i) => (selectable(f) ? [i] : []))) : new Set())} />
              <span className="cb" aria-hidden="true"><Icon name="check" /></span>{app.words.selectAll}</label>
            <span className="fine" aria-live="polite">{t.dialog.selected(picked.size)}</span>
          </div>
          <div className="picks fx-picks" role="group" aria-label="Feeds in the list">
            {feeds.map((f, i) => (
              <label key={i} className={`pick fx-feed${f.alreadyFollowing ? " off" : ""}`}>
                <input type="checkbox" checked={picked.has(i)} disabled={!selectable(f)} onChange={() => toggle(i)} />
                <span className="cb" aria-hidden="true"><Icon name="check" /></span>
                <span className="fx-grow"><b>{f.title}</b><span className="fine">{hostOf(f.feedUrl)}{f.folder ? ` · ${f.folder}` : ""}</span></span>
                {f.alreadyFollowing ? <span className="tag">{app.words.alreadyFollowing}</span> : null}
                {f.looksPrivate ? <span className="tag warn"><Icon name="lock" />{t.dialog.looksPrivate}</span> : null}
              </label>
            ))}
          </div>
          {feeds.some((f) => f.looksPrivate) ? <p className="fine">{t.dialog.privateNote}</p> : null}
        </div>
      ) : <p className="state note"><Icon name="info" /><span>{t.dialog.noFeeds}</span></p>}
      {feeds.length ? (
        <Field label={t.dialog.putThemIn} htmlFor="op-dest">
          <SelectInput id="op-dest" value={dest} onChange={(e) => setDest(e.target.value)}>
            {hasFolders ? <option value={FOLDERS}>{t.dialog.folders}</option> : null}
            {sourceCollections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>{t.dialog.newCollection}</option>
            <option value={NONE}>{t.dialog.noCollection}</option>
          </SelectInput>
          {dest === NEW ? <TextInput aria-label="New collection name" placeholder={app.words.nameYourCollection} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} autoFocus /> : null}
        </Field>
      ) : null}
    </Dialog>
  );
}
