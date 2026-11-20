import type { CSSProperties } from "react";
import { app } from "@purss/copy/app";
import type { ItemDTO } from "@purss/domain";
import { Avatar, Icon } from "@purss/ui";
import { workflowLabel } from "../lib/constants.ts";
import { timeAgo } from "../lib/format.ts";
import { itemDate, itemExcerpt, itemPicture } from "../lib/items.ts";
import { memo, useId, useState } from "react";
import { CopyTag, FreshDot, KeptTag, NoteLine, PendingMark, SharedBy, WfTag, useFace, useItemLabel } from "./item-bits.tsx";
import { DownloadedTag } from "../downloads/DownloadedTag.tsx";
import { DownloadRing, progressFraction } from "../downloads/DownloadRing.tsx";
import { useDownload } from "../downloads/hooks.ts";
import { platform } from "../platform/index.ts";
import { offersQuickDownload, useQuickDownloadState } from "../player/quick-download.ts";
import { useRowCtx, useRowMarks } from "./row-context.tsx";

const t = app.components.itemRow;

/**
 * Room a row's or card's actions take, as CSS variables: --na icon slots in one line, --nc columns when
 * phone rows stack them two high. Restore is a word, about two slots.
 */
export function actionRoom(item: ItemDTO): CSSProperties {
  if (item.workflow === "ignored") return { "--na": 2, "--nc": 2 } as CSSProperties;
  const icons = 3 + (offersQuickDownload(item) ? 1 : 0);
  return { "--na": icons, "--nc": Math.ceil(icons / 2) } as CSSProperties;
}

const DOWNLOAD_TIPS = t.downloadTips;

/**
 * The quick download of an item's audio or video to this device, in the apps: an empty ring with a cross
 * while it waits its turn (click to take it out of the queue), a ring that fills while the file comes in,
 * a filled check once it's downloaded, a warning when it didn't finish.
 */
function DownloadButton({ item, tipAt }: { item: ItemDTO; tipAt?: "above" }) {
  const c = useRowCtx();
  const state = useQuickDownloadState(item);
  const { progress } = useDownload(item.id);
  if (!state) return null;
  const share = state === "busy" ? progressFraction(progress) : null;
  const tip = share === null ? DOWNLOAD_TIPS[state] : t.downloading(Math.round(share * 100));
  return (
    <button type="button" className={`rq sv ${state}`} data-tip={tip} data-tip-at={tipAt}
      aria-label={`${tip}: ${item.title}`} aria-disabled={state === "busy" || state === "done" ? "true" : undefined}
      onClick={() => {
        if (state === "none" || state === "failed") void c.onDownload(item);
        else if (state === "queued") void platform.downloads?.cancel(item.id);
      }}>
      {state === "busy" || state === "queued" ? <DownloadRing progress={progress} queued={state === "queued"} /> : null}
      {state === "done" ? <span className="dl-badge"><Icon name="check" /></span> : <Icon name={state === "failed" ? "alert" : state === "queued" ? "x" : "download"} />}
    </button>
  );
}

/** One-click triage, the same in rows, cards and the table: download (media, in the apps), To read, and Ignore, or in a basket Remove from it. */
export function TriageActions({ item, tipAt }: { item: ItemDTO; tipAt?: "above" }) {
  const c = useRowCtx();
  const later = item.workflow === "toread";
  // The state is called what the item is for: To read, To watch or To listen.
  const put = workflowLabel("toread", item.kind);
  return (
    <>
      <DownloadButton item={item} tipAt={tipAt} />
      <button type="button" className={`rq tr${later ? " on" : ""}`} data-tip={later ? t.inQueue(put) : put} data-tip-at={tipAt}
        aria-pressed={later} aria-label={`${put}: ${item.title}`} onClick={() => c.onWorkflow(item, later ? "new" : "toread")}><Icon name="item" /></button>
      {c.basket ? (
        <button type="button" className="rq ig" data-tip={t.removeFrom(c.basket.name)} data-tip-at={tipAt} aria-label={`Remove from ${c.basket.name}: ${item.title}`} onClick={() => c.onRemove(item)}><Icon name="x" /></button>
      ) : (
        <button type="button" className="rq ig" data-tip={t.ignore} data-tip-at={tipAt} aria-label={`Ignore: ${item.title}`} onClick={() => c.onWorkflow(item, "ignored")}><Icon name="x" /></button>
      )}
    </>
  );
}

/** Actions on a row or card: download (media, in the apps), To read, Ignore (Remove in a basket) and More; Restore when ignored, except in a basket, which has no Ignore. Keep lives in the reader and More. */
export function RowActions({ item }: { item: ItemDTO }) {
  const c = useRowCtx();
  if (c.selecting) return null;
  if (item.workflow === "ignored" && !c.basket) {
    return (
      <span className="racts">
        <button type="button" className="restore" aria-label={`Restore: ${item.title}`} onClick={() => c.onRestore(item)}>{t.restore}</button>
      </span>
    );
  }
  return (
    <span className="racts qa">
      <TriageActions item={item} tipAt="above" />
      <button type="button" className="rq rm" aria-haspopup="menu" data-tip={t.moreActions} data-tip-at="above" aria-label={`Actions for ${item.title}`} onClick={(e) => c.onMore(item, e.currentTarget)}><Icon name="more" /></button>
    </span>
  );
}

/** Memoised: a row re-renders when its item, its marks, or the page's row context change, not when a neighbour does. */
export const ItemRow = memo(function ItemRow({ item, bare = false }: { item: ItemDTO; bare?: boolean }) {
  const c = useRowCtx();
  const face = useFace(item);
  const { active, picked } = useRowMarks(item.id);
  const hasActs = !bare && !c.selecting;
  const when = timeAgo(itemDate(item), c.now, c.timeZone);
  const label = useItemLabel(item, { source: face.name, when, showKept: !c.basket, showCopy: !!c.basket });
  const excerptId = useId();
  const excerpt = itemExcerpt(item);
  const noteId = `${excerptId}n`;
  const described = [excerpt ? excerptId : null, c.basket && item.kept?.noteLine ? noteId : null].filter(Boolean).join(" ") || undefined;
  return (
    <li className={`row irow${item.kind === "video" ? " vid" : ""}${active ? " sel-row" : ""}${picked ? " picked" : ""}${item.workflow === "ignored" && !c.basket ? " dim" : ""}${hasActs ? " has-acts" : ""}`} data-item={item.id} data-wf={item.workflow} data-leaves={c.leaves(item)} style={{ "--sh": face.hue, ...(hasActs ? actionRoom(item) : {}) } as CSSProperties}>
      <button type="button" className="row-main" data-act="open" onClick={() => c.onOpen(item)} aria-label={label} aria-describedby={described}
        aria-pressed={c.selecting ? picked : undefined} aria-current={!c.selecting && active ? "true" : undefined}>
        <span className="gut">{c.selecting ? <span className="cbx" aria-hidden="true"><Icon name="check" /></span> : <FreshDot fresh={item.fresh} />}</span>
        <Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} />
        <span className="row-t">
          <span className="title" dir="auto">{item.title}</span>
          {excerpt ? <span className="ex" id={excerptId} dir="auto">{excerpt}</span> : null}
          {c.basket ? <NoteLine item={item} id={noteId} /> : null}
          <span className="row-s"><span className="sn" dir="auto">{face.name}</span><time className="when" dateTime={itemDate(item)}>{when}</time><SharedBy curator={face.curator} /><WfTag workflow={item.workflow} kind={item.kind} />{c.basket ? <CopyTag item={item} /> : <KeptTag item={item} />}<PendingMark id={item.id} /><DownloadedTag itemId={item.id} /></span>
        </span>
        <RowThumb item={item} sourceIconUrl={face.iconUrl} />
      </button>
      {hasActs ? <RowActions item={item} /> : null}
    </li>
  );
});

/** A small copy of the item's own picture at the end of the row, where there is one (a podcast episode without one shows the show's art). Wide lists show every one; a narrow list only a video's. */
function RowThumb({ item, sourceIconUrl }: { item: ItemDTO; sourceIconUrl: string | null }) {
  const [broken, setBroken] = useState(false);
  const src = itemPicture(item, sourceIconUrl);
  if (!src || broken) return null;
  return <span className="thumb" aria-hidden="true"><img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} /></span>;
}
