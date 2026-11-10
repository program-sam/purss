import { useEffect, useMemo, useState } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpmlImportDestination, OpmlImportDTO, OpmlImportEntryDTO, OpmlPreview, OpmlPreviewEntry } from "@purss/domain";
import { Button, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, get, messageOf, post } from "../../api/client.ts";
import { refreshWorkspace } from "../../api/queries.ts";
import { plural } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useWorkspace } from "../../state/workspace.tsx";

/** An OPML file opened with the desktop app (plan/42): read on the server, then the same choice as an import from Your data. */
export function OpenedOpmlFile({ name, text, onClose }: { name: string; text: string; onClose: () => void }) {
  const [read, setRead] = useState<{ preview: OpmlPreview } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    post<OpmlPreview>("/api/opml/preview", { opml: text }).then((preview) => { if (live) setRead({ preview }); }, (err: unknown) => { if (live) setRead({ error: messageOf(err) }); });
    return () => { live = false; };
  }, [text]);
  if (read && "preview" in read) return <OpmlDialog preview={read.preview} fileName={name} onClose={onClose} />;
  return (
    <Dialog title="Subscription list (OPML)" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {read ? <p className="state note"><Icon name="info" /><span>{read.error}</span></p>
        : <p className="state" role="status"><span className="spin" aria-hidden="true" />Reading <b style={{ wordBreak: "break-all" }}>{name}</b>…</p>}
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
    case "waiting": return <span className="fine">Waiting</span>;
    case "working": return <span className="state"><span className="spin" aria-hidden="true" />Looking…</span>;
    case "followed": return <span className="fx-ok"><Icon name="check" size="sm" />Following{o.message ? <span className="fine"> · {o.message}</span> : null}</span>;
    case "already": return <span className="fine">Already following{o.sourceId ? <> · <button type="button" className="link" onClick={() => nav.go({ t: "s", id: o.sourceId! })}>Open</button></> : null}</span>;
    case "failed": return <span className="fx-fail"><Icon name="alert" size="sm" />{o.message}</span>;
  }
}

/** One-line account of a list: how far it is and how it went. */
export function importSummary(i: OpmlImportDTO): string {
  const checked = i.total - i.waiting;
  if (i.status === "running") return `${checked} of ${plural(i.total, "feed")} checked`;
  const parts = [i.followed ? `Following ${plural(i.followed, "new source")}` : "Nothing new followed", i.already ? `${i.already} already followed` : "", i.failed ? `${i.failed} couldn't be followed` : "", i.status === "stopped" && i.waiting ? `${i.waiting} not looked at` : ""];
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
    <Dialog title={running ? "Following your list…" : "Your list"} size="md" onClose={onClose}
      footer={running
        ? <><Button onClick={() => stop.mutate()} disabled={stop.isPending}>Stop after this one</Button><Button variant="primary" onClick={onClose}>Close</Button></>
        : <Button variant="primary" onClick={onClose}>Done</Button>}>
      {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
      {list ? (
        <>
          <p className="state" aria-live="polite">{running ? <span className="spin" aria-hidden="true" /> : null}{importSummary(list)}</p>
          {running ? <p className="fine">This runs in the background. You can close this window. Progress is on the Your data page.</p> : null}
          {stop.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(stop.error)}</span></p> : null}
          <ul className="fx-rows fx-scroll">
            {list.entries!.map((e) => (
              <li key={e.position} className="fx-row">
                <div className="fx-grow"><b dir="auto">{(e.sourceId && ws.data.sources.find((src) => src.id === e.sourceId)?.title) || e.title}</b><span className="fine">{e.host}{e.folder ? ` · ${e.folder}` : ""}</span></div>
                <div className="fx-end fx-outcome"><Outcome o={e} /></div>
              </li>
            ))}
          </ul>
          {!running && list.followed ? <p className="fine">New items arrive after the next check. Open any source from the sidebar.{" "}<button type="button" className="link" onClick={() => { onClose(); nav.go({ t: "home" }); }}>Go to Home</button></p> : null}
        </>
      ) : q.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Loading…</p> : null}
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
              <Button onClick={() => setOpen(i.id)} aria-label={`${i.status === "running" ? "Watch" : "See"} ${i.fileName}`}>{i.status === "running" ? "Watch" : "See"}</Button>
              {i.status !== "running" ? <Button onClick={() => forget.mutate(i.id)} disabled={forget.isPending} aria-label={`Forget ${i.fileName}`}>Forget</Button> : null}
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
    <Dialog title="Import a list of feeds" size="lg" onClose={onClose} initialFocus="#op-all"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!total || !destOk || busy} onClick={() => void run()}>{total ? `Follow ${plural(total, "feed")}` : "Follow"}</Button></>}>
      <p className="hint"><b style={{ wordBreak: "break-all" }}>{fileName}</b> lists {plural(feeds.length, "feed")}. Choose which to follow. Each is looked up like Add source and keeps the name from the file. This runs on the server, so you can close this window. Progress is on the Your data page.</p>
      {preview.truncated ? <p className="state note"><Icon name="info" /><span>The list was longer than can be read at once, so only the first {feeds.length} are shown.</span></p> : null}
      {preview.skipped.notWebAddress || preview.skipped.duplicates ? (
        <p className="fine">Left out of the list: {[preview.skipped.notWebAddress ? `${plural(preview.skipped.notWebAddress, "entry", "entries")} without a web address` : "", preview.skipped.duplicates ? `${plural(preview.skipped.duplicates, "duplicate")}` : ""].filter(Boolean).join(", ")}.</p>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {feeds.length ? (
        <div className="field">
          <div className="fx-pick-head">
            <label className="fx-allbox"><input id="op-all" type="checkbox" checked={allOn && picked.size > 0} onChange={(e) => setPicked(e.target.checked ? new Set(feeds.flatMap((f, i) => (selectable(f) ? [i] : []))) : new Set())} />
              <span className="cb" aria-hidden="true"><Icon name="check" /></span>Select all</label>
            <span className="fine" aria-live="polite">{picked.size} selected</span>
          </div>
          <div className="picks fx-picks" role="group" aria-label="Feeds in the list">
            {feeds.map((f, i) => (
              <label key={i} className={`pick fx-feed${f.alreadyFollowing ? " off" : ""}`}>
                <input type="checkbox" checked={picked.has(i)} disabled={!selectable(f)} onChange={() => toggle(i)} />
                <span className="cb" aria-hidden="true"><Icon name="check" /></span>
                <span className="fx-grow"><b>{f.title}</b><span className="fine">{hostOf(f.feedUrl)}{f.folder ? ` · ${f.folder}` : ""}</span></span>
                {f.alreadyFollowing ? <span className="tag">Already following</span> : null}
                {f.looksPrivate ? <span className="tag warn"><Icon name="lock" />Looks private</span> : null}
              </label>
            ))}
          </div>
          {feeds.some((f) => f.looksPrivate) ? <p className="fine">Feeds marked “Looks private” have a secret in their link. They start unticked; if you follow one, its link is kept apart from your other data and never shown again.</p> : null}
        </div>
      ) : <p className="state note"><Icon name="info" /><span>No feeds were found in that file.</span></p>}
      {feeds.length ? (
        <Field label="Put them in" htmlFor="op-dest">
          <SelectInput id="op-dest" value={dest} onChange={(e) => setDest(e.target.value)}>
            {hasFolders ? <option value={FOLDERS}>The folders from the file (one collection each)</option> : null}
            {sourceCollections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>A new collection…</option>
            <option value={NONE}>No collection (shown under Other sources on Home)</option>
          </SelectInput>
          {dest === NEW ? <TextInput aria-label="New collection name" placeholder="Name your collection" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} autoFocus /> : null}
        </Field>
      ) : null}
    </Dialog>
  );
}
