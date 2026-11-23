import { useQuery } from "@tanstack/react-query";
import type { ShareDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Icon } from "@purss/ui";
import { shortDate } from "../../lib/format.ts";
import { useSession } from "../../api/hooks.ts";
import { useNav } from "../../nav.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { usePurss } from "../../state/purss.tsx";
import { sharesQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Page } from "../shared/bits.tsx";
import { LinkRow } from "./LinkRow.tsx";

const t = app.sharing.sharingPage;

function status(s: ShareDTO, hosted: boolean): { label: string; tone: string; text: string } {
  if (s.takenDown) return { label: app.words.takenDown, tone: "failed", text: t.status.takenDownText(hosted ? t.status.purssTookItDown : t.status.adminTookItDown, s.takenDown.reason) };
  if (s.problem === "gone") return { label: t.status.notShowing, tone: "draft", text: t.status.gone };
  if (s.problem === "plan") return { label: t.status.notShowing, tone: "draft", text: t.status.plan };
  if (s.problem === "rules") return { label: t.status.notShowing, tone: "draft", text: t.status.rules };
  if (s.status === "published") return { label: t.status.public, tone: "published", text: t.status.publicText(!!s.listed) };
  if (s.status === "paused") return { label: app.words.paused, tone: "paused", text: t.status.pausedText };
  return { label: t.status.notSharedYet, tone: "draft", text: t.status.preparedText };
}

function Card({ share }: { share: ShareDTO }) {
  const ws = usePurss();
  const hosted = useSession().data?.installation.mode === "hosted";
  const nav = useNav();
  const overlays = useOverlays();
  const st = status(share, hosted);
  const live = share.status === "published" && !share.problem && !share.takenDown;
  const path = `/${share.targetKind === "basket" ? "b" : "c"}/${share.targetId}`;
  return (
    <article className="fx-pub" aria-labelledby={`sh-${share.id}`}>
      <header>
        <div className="fx-grow">
          <h2 id={`sh-${share.id}`} dir="auto">{share.title || t.removed}</h2>
          <p className="fine">{share.targetKind === "basket" ? app.words.basket : app.words.collection}{t.shownAs}<span dir="auto">{share.curatorName}</span>{share.noteCount ? t.publicNote(share.noteCount) : ""}{share.publishedAt ? t.firstShared(shortDate(share.publishedAt, Date.now(), ws.prefs.timezone)) : ""}</p>
        </div>
        <span className={`tag fx-status ${st.tone}`}>{st.label}</span>
      </header>
      <p className="fine" dir="auto">{st.text}</p>
      {live ? <div className="fx-links"><LinkRow label={app.words.page} url={share.publicUrl} /><LinkRow label={app.words.feedCapital} url={share.feedUrl} /></div> : null}
      {share.problem !== "gone" ? (
        <div className="fx-acts-row">
          <Button onClick={() => overlays.open({ kind: "share", target: share.targetKind, targetId: share.targetId, name: share.title })}>{t.manage}</Button>
          <Button onClick={() => nav.goPath(path)}>{t.open(share.targetKind)}</Button>
        </div>
      ) : null}
    </article>
  );
}

/** Everything this PURSS shows the world: each shared basket and collection, and what state it is in. */
export function SharingPage() {
  const q = useQuery(sharesQuery);
  const hosted = useSession().data?.installation.mode === "hosted";
  const list = q.data ?? [];
  return (
    <Page title={app.words.sharing} lead={t.lead}>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.sharesName} onRetry={() => void q.refetch()} /> : null}
      {q.data && !list.length ? (
        <div className="empty card-like">
          <h2>{t.nothingShared}</h2>
          <p>{t.nothingSharedBefore}<b>{app.words.share}</b>{t.nothingSharedAfter}</p>
        </div>
      ) : null}
      <div className="fx-stack">{list.map((s) => <Card key={s.id} share={s} />)}</div>
      {list.length ? (
        <p className="fine"><Icon name="info" size="sm" />{t.visitorsSee(hosted ? t.purssCanTakeDown : t.adminsCanTakeDown)}</p>
      ) : null}
    </Page>
  );
}
