import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NEWS_BODY_MAX, NEWS_TITLE_MAX } from "@purss/domain";
import type { NewsAdminDTO, NewsPostDTO, NewsPostStats } from "@purss/domain";
import { Button, Dialog, Field, Icon, TextInput } from "@purss/ui";
import { del, get, messageOf, post, put } from "../../api/client.ts";
import { timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { Loading, LoadFailed } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";

const key = ["feature", "admin", "news"] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** How a post fared, in words: counts over the PURSSes it reached, never who. */
export function statsLine(s: NewsPostStats): string {
  if (!s.delivered) return "Not in any PURSS yet";
  const parts = [`In ${plural(s.delivered, "PURSS", "PURSSes")}`, `read in ${s.read.toLocaleString("en")} (${Math.round((s.read / s.delivered) * 100)}%)`];
  if (s.kept) parts.push(`kept in ${s.kept.toLocaleString("en")}`);
  if (s.ignored) parts.push(`ignored in ${s.ignored.toLocaleString("en")}`);
  if (s.removed) parts.push(`deleted from ${s.removed.toLocaleString("en")}`);
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
        toast(publish && !published ? `Published ${out.title}` : published ? "Changes published" : "Draft saved");
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={editing ? (published ? "Edit published post" : "Edit draft") : "New post"} size="lg" onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            {published
              ? <Button variant="primary" disabled={busy || !ready} onClick={() => void save(false)}>Save changes</Button>
              : (
                <>
                  <Button disabled={busy || !ready} onClick={() => void save(false)}>Save draft</Button>
                  <Button variant="primary" disabled={busy || !ready} onClick={() => void save(true)}>Publish</Button>
                </>
              )}
          </>
        }>
        <Field label="Title" htmlFor="news-title">
          <TextInput id="news-title" value={title} maxLength={NEWS_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Post" htmlFor="news-body"
          hint={<>A blank line starts a new paragraph. Lines starting with <code>- </code> make a list. <code>**bold**</code>, <code>[link text](https://…)</code>; web addresses become links by themselves.</>}>
          <textarea id="news-body" className="in fx-textarea" rows={12} maxLength={NEWS_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <p className="fine">
          {published
            ? "Saving changes updates the post on the news page, in the feed and in every PURSS. A copy someone kept in a basket keeps the version they kept."
            : "Publishing puts the post on the news page and feed and into every PURSS that follows the news, as New. Drafts are only here."}
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
        toast(out.keptCopies ? `Deleted ${item.title}; ${plural(out.keptCopies, "kept copy", "kept copies")} stay with their owners` : `Deleted ${item.title}`);
        onClose();
      }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={`Delete ${item.title}?`} onClose={onClose}
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>Delete</Button></>}>
        <p>{item.status === "published"
          ? "It leaves the news page and feed, and its copies leave every PURSS, except where someone kept it in a basket, published it or wrote notes on it: those copies stay theirs. Feed readers elsewhere may still show it."
          : "The draft is deleted. Nobody has seen it."}</p>
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
        <span className="fine">{draft ? `Draft · changed ${timeAgo(item.updatedAt) || "just now"}` : `Published ${timeAgo(item.publishedAt!) || "just now"}`}</span>
        {item.stats ? <span className="fine">{statsLine(item.stats)}</span> : null}
      </div>
      <div className="fx-end">
        <span className={`tag fx-status ${draft ? "draft" : "published"}`}>{draft ? "Draft" : "Published"}</span>
        {item.url ? <a className="link" href={item.url} target="_blank" rel="noreferrer">View</a> : null}
        <Button onClick={onEdit}>Edit…</Button>
        <Button onClick={onDelete} aria-label={`Delete ${item.title}`}>Delete…</Button>
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
  if (q.isError || !q.data) return <LoadFailed error={q.error} what="the news" onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="fx-stack">
      <p>Posts here reach everyone on this server: every PURSS has <b>{d.title}</b> as a source, so they arrive as New on Home. They are also public on the <a href={d.pageUrl} target="_blank" rel="noreferrer">news page</a> and its <a href={d.feedUrl} target="_blank" rel="noreferrer">feed</a>.</p>
      <p className="fine">
        {d.audience.following || d.audience.unfollowed
          ? `${plural(d.audience.following, "PURSS", "PURSSes")} follow${d.audience.following === 1 ? "s" : ""} the news${d.audience.unfollowed ? `; ${d.audience.unfollowed.toLocaleString("en")} unfollowed it` : ""}. `
          : "Every PURSS gets the news source with the first published post. "}
        Reading is counted per post as numbers only; nobody's name or reading is shown.
      </p>
      <div><Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" />New post</Button></div>
      {d.posts.length ? <ul className="fx-rows">{d.posts.map((p) => <Row key={p.id} item={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />)}</ul> : <p className="state">No posts yet.</p>}
      {editing ? <Editor editing={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteDialog item={deleting} onClose={() => setDeleting(null)} /> : null}
    </div>
  );
}
