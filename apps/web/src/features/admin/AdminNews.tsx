import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NEWS_BODY_MAX, NEWS_TITLE_MAX } from "@purss/domain";
import type { NewsAdminDTO, NewsPostDTO, NewsPostStats } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const key = ["feature", "admin", "news"] as const;
const t = app.admin.adminNews;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** How a post fared, in words: counts over the PURSSes it reached, never who. */
export function statsLine(s: NewsPostStats): string {
  if (!s.delivered) return t.stats.none;
  const parts = [t.stats.reached(plural(s.delivered, "PURSS", t.purssPlural)), t.stats.read(s.read.toLocaleString("en"), Math.round((s.read / s.delivered) * 100))];
  if (s.kept) parts.push(t.stats.kept(s.kept.toLocaleString("en")));
  if (s.ignored) parts.push(t.stats.ignored(s.ignored.toLocaleString("en")));
  if (s.removed) parts.push(t.stats.removed(s.removed.toLocaleString("en")));
  return parts.join(" · ");
}

/** Write a new post or change one. A draft can be saved or published; a published post's changes reach every copy. */
function Editor({ editing, onClose }: { editing: NewsPostDTO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const published = editing?.status === "published";
  const ready = title.trim().length > 0 && body.trim().length > 0;

  async function save(publish: boolean) {
    setBusy(true); setError("");
    try {
      const input = { title: title.trim(), body: body.trim(), publish };
      const out = await stepUp.run(() => editing
        ? put<NewsPostDTO>(`/api/admin/news/${encodeURIComponent(editing.id)}`, input)
        : post<NewsPostDTO>("/api/admin/news", input));
      if (out) {
        void qc.invalidateQueries({ queryKey: key });
        toast(publish && !published ? t.editor.publishedToast(out.title) : published ? t.editor.changesPublished : t.editor.draftSaved);
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={editing ? (published ? t.editor.editPublished : t.editor.editDraft) : app.words.newPost} size="lg" onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>{app.words.cancel}</Button>
            {published
              ? <Button variant="primary" disabled={busy || !ready} onClick={() => void save(false)}>{app.words.saveChanges}</Button>
              : (
                <>
                  <Button disabled={busy || !ready} onClick={() => void save(false)}>{t.editor.saveDraft}</Button>
                  <Button variant="primary" disabled={busy || !ready} onClick={() => void save(true)}>{t.editor.publish}</Button>
                </>
              )}
          </>
        }>
        <Field label={app.words.title} htmlFor="news-title">
          <TextInput id="news-title" value={title} maxLength={NEWS_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={app.words.postCapital} htmlFor="news-body"
          hint={<>{t.editor.hintBefore}<code>{"- "}</code>{t.editor.hintAfterList}<code>{t.editor.hintBold}</code>, <code>{t.editor.hintLink}</code>{t.editor.hintAfter}</>}>
          <textarea id="news-body" className="in fx-textarea" rows={12} maxLength={NEWS_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <p className="fine">
          {published
            ? t.editor.savingChanges
            : t.editor.publishing}
        </p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

function DeleteDialog({ item, onClose }: { item: NewsPostDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => del<{ removedCopies: number; keptCopies: number }>(`/api/admin/news/${encodeURIComponent(item.id)}`));
      if (out) {
        void qc.invalidateQueries({ queryKey: key });
        toast(out.keptCopies ? t.deleteDialog.deletedKept(item.title, plural(out.keptCopies, t.keptCopy, t.keptCopies)) : t.deleteDialog.deleted(item.title));
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={t.deleteDialog.title(item.title)} onClose={onClose}
        footer={<><Button onClick={onClose}>{app.words.cancel}</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>{t.deleteDialog.delete}</Button></>}>
        <p>{item.status === "published"
          ? t.deleteDialog.publishedNote
          : t.deleteDialog.draftNote}</p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

function Row({ item, onEdit, onDelete }: { item: NewsPostDTO; onEdit: () => void; onDelete: () => void }) {
  const draft = item.status === "draft";
  return (
    <li className="fx-row wrap">
      <div className="fx-grow">
        <b dir="auto">{item.title}</b>
        <span className="fine">{draft ? t.row.draftChanged(timeAgo(item.updatedAt) || app.words.justNow) : t.row.published(timeAgo(item.publishedAt!) || app.words.justNow)}</span>
        {item.stats ? <span className="fine">{statsLine(item.stats)}</span> : null}
      </div>
      <div className="fx-end">
        <span className={`tag fx-status ${draft ? "draft" : "published"}`}>{draft ? t.row.draft : app.words.published}</span>
        {item.url ? <a className="link" href={item.url} target="_blank" rel="noreferrer">{app.words.view}</a> : null}
        <Button onClick={onEdit}>{t.row.edit}</Button>
        <Button onClick={onDelete} aria-label={`Delete ${item.title}`}>{app.words.delete}</Button>
      </div>
    </li>
  );
}

/** The installation's news: posts every PURSS gets through its news source, with how many read them. */
export function AdminNewsPanel() {
  const q = useQuery({ queryKey: key, queryFn: () => get<NewsAdminDTO>("/api/admin/news") });
  const [editing, setEditing] = useState<NewsPostDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<NewsPostDTO | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError || !q.data) return <LoadFailed error={q.error} what={t.panel.newsName} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="fx-stack">
      <p>{t.panel.introBefore}<b>{d.title}</b>{t.panel.introMiddle}<a href={d.pageUrl} target="_blank" rel="noreferrer">{t.panel.newsPage}</a>{t.panel.introAnd}<a href={d.feedUrl} target="_blank" rel="noreferrer">{app.words.feed}</a>.</p>
      <p className="fine">
        {d.audience.following || d.audience.unfollowed
          ? t.panel.following(plural(d.audience.following, "PURSS", t.purssPlural), d.audience.following, d.audience.unfollowed ? d.audience.unfollowed.toLocaleString("en") : null)
          : t.panel.everyPurss}
        {t.panel.reading}
      </p>
      <div><Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" />{app.words.newPost}</Button></div>
      {d.posts.length ? <ul className="fx-rows">{d.posts.map((p) => <Row key={p.id} item={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />)}</ul> : <p className="state">{t.panel.noPosts}</p>}
      {editing ? <Editor editing={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteDialog item={deleting} onClose={() => setDeleting(null)} /> : null}
    </div>
  );
}
