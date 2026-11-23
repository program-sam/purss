import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShareDTO, SharePreview, ShareTarget } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Check, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { useToasts } from "../../state/toasts.tsx";
import { fkeys, shareForQuery } from "../shared/api.ts";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { LinkRow } from "./LinkRow.tsx";
import { NotesDialog } from "./NotesDialog.tsx";
import { neutraliseLinks } from "./preview-html.ts";

const t = app.sharing.shareDialog;

const NEVER_SHOWN = t.neverShown;

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
      <Field label={t.settings.authorLabel} htmlFor="sh-curator" hint={t.settings.authorHint}>
        <TextInput id="sh-curator" value={curator} onChange={(e) => setCurator(e.target.value)} maxLength={60} autoComplete="off" />
      </Field>
      <Field label={t.settings.descriptionLabel} htmlFor="sh-desc" hint={t.settings.descriptionHint}>
        <textarea id="sh-desc" className="in fx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
      </Field>
      <div className="field">
        <Check checked={listed} onChange={(v) => { setListed(v); setListAck(false); }}
          hint={t.settings.listedHint}>{t.settings.listedLabel}</Check>
      </div>
      {listingNow ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>{t.settings.listedWarning}</span></p>
          <Check checked={listAck} onChange={setListAck}>{t.settings.listedAck}</Check>
        </div>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="fx-acts-row">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void save()}>{share ? app.words.save : t.settings.nextReview}</Button>
        <Button onClick={onCancel}>{app.words.cancel}</Button>
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
  if (q.isError) return <LoadFailed error={q.error} what={t.review.previewName} onRetry={() => void q.refetch()} />;
  if (!p) return null;
  return (
    <>
      <p className="hint">{t.review.hintBefore(p.isPublic ? t.review.seeNow : t.review.willSee, p.itemCount === 1 ? t.review.oneItem : t.review.items(p.itemCount), p.itemCount >= 200 ? t.review.newest : "")}<b dir="auto">{share.curatorName}</b>{t.review.hintAfter}</p>
      {p.blockers.length ? <div className="p-warn" role="alert"><Icon name="alert" /><ul className="fx-lines">{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div> : null}
      <iframe className="fx-frame" title={t.review.frameTitle(share.title)} sandbox="" srcDoc={neutraliseLinks(p.html)} />
      {p.warnings.length ? (
        <div className="fx-confirm" role="note">
          <p><Icon name="alert" /><span>{t.review.becomesPublic}</span></p>
          <ul className="fx-lines">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : null}
      <p className="fine">{NEVER_SHOWN}</p>
      {p.confirmation ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>{p.confirmation.statement}</span></p>
          <Check checked={ack} onChange={setAck}>{t.review.ack}</Check>
        </div>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <div className="fx-acts-row">
        {p.confirmation ? <Button variant="primary" disabled={!ack || busy} onClick={() => void publish()}>{app.words.share}</Button> : null}
        <Button onClick={onBack}>{app.words.back}</Button>
      </div>
    </>
  );
}

/** A shared page's addresses and controls: pause, share again, settings, public notes, stop sharing. */
function Live({ share, onStep }: { share: ShareDTO; onStep: (s: "settings" | "review" | "notes") => void }) {
  const qc = useQueryClient();
  const hosted = useSession().data?.installation.mode === "hosted";
  const { toast } = useToasts();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const live = share.status === "published" && !share.problem && !share.takenDown;
  async function pause() {
    setBusy(true); setError("");
    try { await post(`/api/shares/${encodeURIComponent(share.id)}/pause`); void qc.invalidateQueries({ queryKey: fkeys.shares }); toast(t.live.paused); }
    catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError("");
    try { await del(`/api/shares/${encodeURIComponent(share.id)}`); void qc.invalidateQueries({ queryKey: fkeys.shares }); toast(t.live.stopped(share.title)); }
    catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  const state = share.takenDown ? null
    : share.problem === "plan" ? t.live.planOff
      : share.problem === "rules" ? t.live.rulesOff
        : share.status === "published" ? t.live.published(!!share.listed)
          : share.status === "paused" ? t.live.pausedState
            : t.live.notShared;
  return (
    <>
      {share.takenDown
        ? <p className="p-warn" role="note"><Icon name="alert" /><span>{hosted ? t.live.purssTookDown : t.live.adminTookDown}: <span dir="auto">{share.takenDown.reason}</span>{t.live.stillChange}{hosted ? t.live.purssRestores : t.live.adminRestores}.</span></p>
        : <p className="hint">{state}</p>}
      <p className="fine">{t.live.shownAs}<b dir="auto">{share.curatorName}</b>{share.noteCount ? t.live.publicNote(share.noteCount) : ""}</p>
      {live ? (
        <div className="fx-links">
          <LinkRow label={app.words.page} url={share.publicUrl} />
          <LinkRow label={app.words.feedCapital} url={share.feedUrl} />
          <LinkRow label={app.words.followLink} url={share.followUrl} />
        </div>
      ) : null}
      {live ? <p className="fine">{t.live.followLinkHint}</p> : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      {stopping ? (
        <div className="fx-confirm">
          <p><Icon name="alert" /><span>{t.live.stopNote}{share.status === "published" ? t.live.recallNote : ""}</span></p>
          <div className="fx-acts-row"><Button variant="danger" disabled={busy} onClick={() => void stop()}>{t.live.stopSharing}</Button><Button onClick={() => setStopping(false)}>{app.words.cancel}</Button></div>
        </div>
      ) : (
        <div className="fx-acts-row">
          {share.status !== "published" && !share.takenDown ? <Button variant="primary" onClick={() => onStep("review")}>{t.live.reviewAndShare}</Button> : <Button onClick={() => onStep("review")}>{t.live.preview}</Button>}
          <Button onClick={() => onStep("notes")}>{t.live.publicNotes}</Button>
          <Button onClick={() => onStep("settings")}>{t.live.settings}</Button>
          {share.status === "published" && !share.takenDown ? <Button disabled={busy} onClick={() => void pause()}>{app.words.pause}</Button> : null}
          {!share.takenDown ? <Button onClick={() => setStopping(true)}>{t.live.stopSharingButton}</Button> : null}
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
    <Dialog title={t.title(name)} size={step === "review" ? "lg" : "md"} onClose={onClose} footer={<Button onClick={onClose}>{app.words.close}</Button>}>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.sharingName} onRetry={() => void q.refetch()} /> : null}
      {q.data && !share && blocked ? <p className="state note"><Icon name="lock" /><span>{blocked}</span></p> : null}
      {q.data && !share && !blocked && step === "main" ? (
        <>
          <p className="hint">{t.intro(kind, kind === "basket" ? t.youKeepHere : t.itGathers)}</p>
          <Settings kind={kind} id={id} share={null} onSaved={() => { void q.refetch().then(() => setStep("review")); }} onCancel={onClose} />
        </>
      ) : null}
      {share && step === "main" ? <Live share={share} onStep={setStep} /> : null}
      {share && step === "settings" ? <Settings kind={kind} id={id} share={share} onSaved={back} onCancel={back} /> : null}
      {share && step === "review" ? <Review share={share} onShared={back} onBack={back} /> : null}
    </Dialog>
  );
}
