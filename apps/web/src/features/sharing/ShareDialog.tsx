import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShareDTO, SharePreview, ShareTarget } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { useToasts } from "../../state/toasts.tsx";
import { fkeys, shareForQuery } from "../shared/api.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { LinkRow } from "./LinkRow.tsx";
import { NotesDialog } from "./NotesDialog.tsx";
import { neutraliseLinks } from "./preview-html.ts";

const NEVER_SHOWN = "Never shown: your reading progress and states, your private notes and highlights, saved text, and your other baskets and collections.";

/** The name shown, a description and search listing. A new share starts private; nothing is public until it is reviewed and shared. */
function Settings({ kind, id, share, onSaved, onCancel }: { kind: ShareTarget; id: string; share: ShareDTO | null; onSaved: (s: ShareDTO) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [curator, setCurator] = useState(share?.curatorName ?? "");
  const [description, setDescription] = useState(share?.description ?? "");
  const [listed, setListed] = useState(share?.listed ?? false);
  const [listAck, setListAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listingNow = share?.status === "published" && listed && !share.listed;
  const ready = curator.trim().length > 0 && (!listingNow || listAck);
  async function save() {
    setBusy(true); setError("");
    try {
      const out = await put<ShareDTO>(`/api/shares/for/${kind}/${encodeURIComponent(id)}`, { curatorName: curator.trim(), description: description.trim() || null, listed, ...(listingNow ? { confirmListed: true } : {}) });
      void qc.invalidateQueries({ queryKey: fkeys.shares });
      onSaved(out);
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <>
      <Field label="Your name as the author" htmlFor="sh-curator" hint="This names you, not the collection: the page and its feed say “shared by” this name. A pseudonym or a first name is fine. It is never filled in from your account.">
        <TextInput id="sh-curator" value={curator} onChange={(e) => setCurator(e.target.value)} maxLength={60} autoComplete="off" />
      </Field>
      <Field label="Description (optional)" htmlFor="sh-desc" hint="A sentence or two for people who open the page.">
        <textarea id="sh-desc" className="in fx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
      </Field>
      <div className="field">
        <Check checked={listed} onChange={(v) => { setListed(v); setListAck(false); }}
          hint="Off: search engines are asked not to list the page, so people find it through your link. On: people can also find it by searching.">Let search engines list this page</Check>
      </div>
      {listingNow ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>Search engines may list this page from their next visit, so people can find it by searching. Turning it off later asks them to drop it, but they decide when.</span></p>
          <Check checked={listAck} onChange={setListAck}>I understand, let search engines list it</Check>
        </div>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="fx-acts-row">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>{share ? "Save" : "Next: review"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </>
  );
}

/** Exactly what visitors will see, what of the person's own becomes visible, and the confirmation to share. */
function Review({ share, onShared, onBack }: { share: ShareDTO; onShared: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["feature", "share-preview", share.id], queryFn: () => get<SharePreview>(`/api/shares/${encodeURIComponent(share.id)}/preview`), gcTime: 0, staleTime: 0, retry: false });
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const p = q.data;
  async function publish() {
    if (!p?.confirmation) return;
    setBusy(true); setError("");
    try {
      await post(`/api/shares/${encodeURIComponent(share.id)}/publish`, { confirmToken: p.confirmation.token });
      void qc.invalidateQueries({ queryKey: fkeys.shares });
      onShared();
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadFailed error={q.error} what="the preview" onRetry={() => void q.refetch()} />;
  if (!p) return null;
  return (
    <>
      <p className="hint">{p.isPublic ? "This is what people who open the page see now" : "This is what people who open the page will see"}: {p.itemCount === 1 ? "1 item" : `${p.itemCount} items`}{p.itemCount >= 200 ? " (the newest 200)" : ""}, shared by <b dir="auto">{share.curatorName}</b>. Links are switched off in this preview.</p>
      {p.blockers.length ? <div className="p-warn" role="alert"><Icon name="alert" /><ul className="fx-lines">{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div> : null}
      <iframe className="fx-frame" title={`Preview of the public page for ${share.title}`} sandbox="" srcDoc={neutraliseLinks(p.html)} />
      {p.warnings.length ? (
        <div className="fx-confirm" role="note">
          <p><Icon name="alert" /><span>What of yours becomes public:</span></p>
          <ul className="fx-lines">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : null}
      <p className="fine">{NEVER_SHOWN}</p>
      {p.confirmation ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>{p.confirmation.statement}</span></p>
          <Check checked={ack} onChange={setAck}>I understand, share this page</Check>
        </div>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="fx-acts-row">
        {p.confirmation ? <Button variant="primary" disabled={!ack || busy} onClick={() => void publish()}>Share</Button> : null}
        <Button onClick={onBack}>Back</Button>
      </div>
    </>
  );
}

/** A shared page's addresses and controls: pause, share again, settings, public notes, stop sharing. */
function Live({ share, onStep }: { share: ShareDTO; onStep: (s: "settings" | "review" | "notes") => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const live = share.status === "published" && !share.problem && !share.takenDown;
  async function pause() {
    setBusy(true); setError("");
    try { await post(`/api/shares/${encodeURIComponent(share.id)}/pause`); void qc.invalidateQueries({ queryKey: fkeys.shares }); toast("Paused. The page and feed no longer show."); }
    catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError("");
    try { await del(`/api/shares/${encodeURIComponent(share.id)}`); void qc.invalidateQueries({ queryKey: fkeys.shares }); toast(`Stopped sharing ${share.title}`); }
    catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  const state = share.takenDown ? null
    : share.problem === "plan" ? "Switched off: your plan doesn't include sharing. It shows again if you choose Plus."
      : share.problem === "rules" ? "Switched off: this filter collection now uses your reading state. Change its rules to share it again."
        : share.status === "published" ? `Public. Anyone with the link can read the page and follow its feed, without signing in. ${share.listed ? "Search engines may list it." : "Search engines are asked not to list it."}`
          : share.status === "paused" ? "Paused. The page and feed don't show. Review it and share again to switch it on."
            : "Not shared yet. Review it, then share when you're ready.";
  return (
    <>
      {share.takenDown
        ? <p className="p-warn" role="note"><Icon name="alert" /><span>An administrator took this page and its feed down after a report: <span dir="auto">{share.takenDown.reason}</span> You can still change it, but not share it again unless an administrator restores it.</span></p>
        : <p className="hint">{state}</p>}
      <p className="fine">Shown as <b dir="auto">{share.curatorName}</b>{share.noteCount ? ` · ${share.noteCount === 1 ? "1 public note" : `${share.noteCount} public notes`}` : ""}</p>
      {live ? (
        <div className="fx-links">
          <LinkRow label="Page" url={share.publicUrl} />
          <LinkRow label="Feed" url={share.feedUrl} />
          <LinkRow label="Follow link" url={share.followUrl} />
        </div>
      ) : null}
      {live ? <p className="fine">Share the follow link anywhere: it opens a page where people follow this in their own PURSS, or copy its feed into any feed reader.</p> : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {stopping ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>Stop sharing removes the page, its address and your public notes on it. {share.status === "published" ? "Copies people or feed readers already fetched can't be recalled." : ""}</span></p>
          <div className="fx-acts-row"><Button variant="danger" disabled={busy} onClick={() => void stop()}>Stop sharing</Button><Button onClick={() => setStopping(false)}>Cancel</Button></div>
        </div>
      ) : (
        <div className="fx-acts-row">
          {share.status !== "published" && !share.takenDown ? <Button variant="primary" onClick={() => onStep("review")}>Review and share…</Button> : <Button onClick={() => onStep("review")}>Preview</Button>}
          <Button onClick={() => onStep("notes")}>Public notes…</Button>
          <Button onClick={() => onStep("settings")}>Settings…</Button>
          {share.status === "published" && !share.takenDown ? <Button disabled={busy} onClick={() => void pause()}>Pause</Button> : null}
          {!share.takenDown ? <Button onClick={() => setStopping(true)}>Stop sharing…</Button> : null}
        </div>
      )}
    </>
  );
}

/** Share a basket or a collection as a public page and feed, or manage how it is shared. */
export function ShareDialog({ kind, id, name, onClose }: { kind: ShareTarget; id: string; name: string; onClose: () => void }) {
  const q = useQuery(shareForQuery(kind, id));
  const [step, setStep] = useState<"main" | "settings" | "review" | "notes">("main");
  const share = q.data?.share ?? null;
  const blocked = q.data?.blocked ?? null;
  const back = () => { void q.refetch(); setStep("main"); };
  if (step === "notes" && share) return <NotesDialog share={share} onClose={back} />;
  return (
    <Dialog title={`Share ${name}`} size={step === "review" ? "lg" : "md"} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="sharing" onRetry={() => void q.refetch()} /> : null}
      {q.data && !share && blocked ? <p className="state note"><Icon name="lock" /><span>{blocked}</span></p> : null}
      {q.data && !share && !blocked && step === "main" ? (
        <>
          <p className="hint">Share this {kind} as a public page and a feed. Anyone with the link can read it without an account, and follow it to get what {kind === "basket" ? "you keep here" : "it gathers"} from now on. Nothing is public until you review the page and share it.</p>
          <Settings kind={kind} id={id} share={null} onSaved={() => { void q.refetch().then(() => setStep("review")); }} onCancel={onClose} />
        </>
      ) : null}
      {share && step === "main" ? <Live share={share} onStep={setStep} /> : null}
      {share && step === "settings" ? <Settings kind={kind} id={id} share={share} onSaved={back} onCancel={back} /> : null}
      {share && step === "review" ? <Review share={share} onShared={back} onBack={back} /> : null}
    </Dialog>
  );
}
