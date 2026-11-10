import { useQuery } from "@tanstack/react-query";
import type { ShareDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { shortDate } from "../../lib/format.ts";
import { useNav } from "../../nav.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { sharesQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Page } from "../shared/bits.tsx";
import { LinkRow } from "./LinkRow.tsx";

function status(s: ShareDTO): { label: string; tone: string; text: string } {
  if (s.takenDown) return { label: "Taken down", tone: "failed", text: `An administrator took it down after a report: ${s.takenDown.reason}` };
  if (s.problem === "gone") return { label: "Not showing", tone: "draft", text: "Its basket or collection was removed." };
  if (s.problem === "plan") return { label: "Not showing", tone: "draft", text: "Your plan doesn't include sharing, so it doesn't show. It shows again if you choose Plus." };
  if (s.problem === "rules") return { label: "Not showing", tone: "draft", text: "This filter collection now uses your reading state, so it doesn't show. Change its rules to share it again." };
  if (s.status === "published") return { label: "Public", tone: "published", text: `Anyone with the link can read it and follow its feed. ${s.listed ? "Search engines may list it." : "Search engines are asked not to list it."}` };
  if (s.status === "paused") return { label: "Paused", tone: "paused", text: "The page and feed don't show until you share it again." };
  return { label: "Not shared yet", tone: "draft", text: "Prepared, but nothing is public until you review it and share it." };
}

function Card({ share }: { share: ShareDTO }) {
  const ws = useWorkspace();
  const nav = useNav();
  const overlays = useOverlays();
  const st = status(share);
  const live = share.status === "published" && !share.problem && !share.takenDown;
  const path = `/${share.targetKind === "basket" ? "b" : "c"}/${share.targetId}`;
  return (
    <article className="fx-pub" aria-labelledby={`sh-${share.id}`}>
      <header>
        <div className="fx-grow">
          <h2 id={`sh-${share.id}`} dir="auto">{share.title || "(removed)"}</h2>
          <p className="fine">{share.targetKind === "basket" ? "Basket" : "Collection"} · shown as <span dir="auto">{share.curatorName}</span>{share.noteCount ? ` · ${share.noteCount === 1 ? "1 public note" : `${share.noteCount} public notes`}` : ""}{share.publishedAt ? ` · first shared ${shortDate(share.publishedAt, Date.now(), ws.prefs.timezone)}` : ""}</p>
        </div>
        <span className={`tag fx-status ${st.tone}`}>{st.label}</span>
      </header>
      <p className="fine" dir="auto">{st.text}</p>
      {live ? <div className="fx-links"><LinkRow label="Page" url={share.publicUrl} /><LinkRow label="Feed" url={share.feedUrl} /></div> : null}
      {share.problem !== "gone" ? (
        <div className="fx-acts-row">
          <Button onClick={() => overlays.open({ kind: "share", target: share.targetKind, targetId: share.targetId, name: share.title })}>Manage…</Button>
          <Button onClick={() => nav.goPath(path)}>Open {share.targetKind}</Button>
        </div>
      ) : null}
    </article>
  );
}

/** Everything this PURSS shows the world: each shared basket and collection, and what state it is in. */
export function SharingPage() {
  const q = useQuery(sharesQuery);
  const list = q.data ?? [];
  return (
    <Page title="Sharing" lead="What you show the world. Share a basket or a collection from its page with Share; it becomes a public page and a feed that anyone can read and follow without an account.">
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="what you share" onRetry={() => void q.refetch()} /> : null}
      {q.data && !list.length ? (
        <div className="empty card-like">
          <h2>You don't share anything</h2>
          <p>Open a basket or a collection and choose <b>Share</b> under its name. You see the page and what becomes public before anything is shared.</p>
        </div>
      ) : null}
      <div className="fx-stack">{list.map((s) => <Card key={s.id} share={s} />)}</div>
      {list.length ? (
        <p className="fine"><Icon name="info" size="sm" /> Visitors see each item's title, link, a short summary, its source name and date, and your public notes. Never your reading progress and states, private notes and highlights, or saved text. Anyone can report a public page; the people who run this installation can take it down.</p>
      ) : null}
    </Page>
  );
}
