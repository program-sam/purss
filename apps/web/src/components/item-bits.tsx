import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ItemDTO, ItemKind, KeptCopy } from "@purss/domain";
import { Icon } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { workflowLabel } from "../lib/constants.ts";
import { isTimeBased, isYouTube, itemExcerpt, lengthText, manualSiteName, safeHref, safeImage } from "../lib/items.ts";
import { usePendingMark } from "../outbox/hooks.ts";
import { useRowLookups } from "../state/workspace.tsx";

export type Face = { hue: number; initials: string; iconUrl: string | null; name: string; curator: string | null };

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function initialsOf(s: string): string {
  const words = s.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[1]![0]! : words[0]?.[1] ?? "")).toUpperCase();
}

/** A stable tinted tile for a name with no icon of its own. */
export function nameFace(name: string): { hue: number; initials: string } {
  return { hue: hashHue(name), initials: initialsOf(name) };
}

/** The avatar, name and curator of an item's source, with a stable fallback for saved links. */
export function useFace(item: ItemDTO): Face {
  const lookups = useRowLookups();
  const s = item.sourceId ? lookups.source(item.sourceId) : undefined;
  if (s) return { hue: s.hue, initials: s.initials, iconUrl: s.iconUrl, name: s.title, curator: s.curator };
  // A link kept by hand has no source of its own: it shows the site it is from, not "Saved links".
  const name = manualSiteName(item) ?? item.sourceTitle;
  return { ...nameFace(name), iconUrl: null, name, curator: null };
}

export function FreshDot({ fresh }: { fresh: boolean }) {
  return fresh ? <><i className="dot" title="New since you last looked" /><span className="sr">New. </span></> : null;
}

const COPY: Record<KeptCopy, { text: string; icon: IconName }> = {
  text: { text: "Text saved", icon: "check" },
  partial: { text: "Only part saved", icon: "info" },
  summary: { text: "Summary only", icon: "item" },
  pending: { text: "Saving text…", icon: "clock" },
  failed: { text: "Couldn't save the text", icon: "alert" },
};

/** What was kept of an item in a basket, in words: the readable text, only part of it, the summary, or nothing of the page. Shown in basket lists. */
export function CopyTag({ item }: { item: ItemDTO }) {
  if (!item.kept) return null;
  const c = COPY[item.kept.copy];
  return <span className={`copy copy-${item.kept.copy}`}><Icon name={c.icon} size="sm" /><span className="sr">Kept copy: </span>{c.text}</span>;
}

/** The first line of the person's note on a kept item, under its excerpt. `id` lets the row's button describe itself with it. */
export function NoteLine({ item, id }: { item: ItemDTO; id?: string }) {
  const line = item.kept?.noteLine;
  return line ? <span className="note-line" id={id}><Icon name="pencil" size="sm" /><span className="sr">Your note: </span><span dir="auto">{line}</span></span> : null;
}

/**
 * What a screen reader says for an item's button: whether it is New, its title, source and date, then its state
 * and where it is kept. The excerpt is the button's description (`aria-describedby`), so skimming by ear stays short.
 */
export function useItemLabel(item: ItemDTO, o: { source: string; when: string; showKept: boolean; showCopy?: boolean }): string {
  const lookups = useRowLookups();
  const n = item.basketIds.length;
  const kept = o.showKept && n ? `Kept in ${n === 1 ? lookups.basketName(item.basketIds[0]!) ?? "1 basket" : `${n} baskets`}` : null;
  return [item.fresh ? "New" : null, item.title, o.source, o.when, item.workflow !== "new" ? workflowLabel(item.workflow, item.kind) : null, kept, o.showCopy && item.kept ? COPY[item.kept.copy].text : null].filter(Boolean).join(", ");
}

export function WfTag({ workflow, kind }: { workflow: ItemDTO["workflow"]; kind?: ItemKind }) {
  return workflow !== "new" ? <span className="wf" data-wf={workflow}>{workflowLabel(workflow, kind)}</span> : null;
}

/**
 * Shown on an item whose change PURSS has not confirmed yet, once it has waited a moment: a change that is
 * confirmed at once never flashes it, and with no connection it shows straight away.
 */
export function PendingMark({ id }: { id: string }) {
  if (!usePendingMark(id)) return null;
  return <span className="pend" title="Not sent yet"><Icon name="clock" size="sm" /><span className="sr">Not sent yet. </span></span>;
}

/** Which baskets keep the item, in words: "Fieldwork", or "2 baskets". Nothing when it isn't kept. */
export function KeptTag({ item }: { item: ItemDTO }) {
  const lookups = useRowLookups();
  const n = item.basketIds.length;
  if (!n) return null;
  const name = n === 1 ? lookups.basketName(item.basketIds[0]!) ?? "1 basket" : `${n} baskets`;
  return <span className="kept"><Icon name="bookmark" size="sm" /><span className="sr">Kept in </span><span dir="auto">{name}</span></span>;
}

/**
 * One resize observer for every text card. Its callback gets all the cards that changed at once, so every card
 * measures before any of them re-renders; one observer per card made each measurement force a fresh layout.
 */
const artWatchers = new Map<Element, () => void>();
let artObserver: ResizeObserver | null = null;
function watchArt(box: Element, measure: () => void): () => void {
  artObserver ??= new ResizeObserver((entries) => { for (const e of entries) artWatchers.get(e.target)?.(); });
  artWatchers.set(box, measure);
  artObserver.observe(box);
  return () => { artWatchers.delete(box); artObserver?.unobserve(box); };
}

/** A picture-less card's slot: the title, then as many whole lines of excerpt as its row's height
 *  leaves room for, so it ends level with the picture cards beside it. */
function TextArt({ title, excerpt }: { title: string; excerpt: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ lines: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      if (!(lh > 0)) return;
      const room = box.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      const lines = Math.max(4, Math.floor((room + 1) / lh));
      setFit((f) => (f && f.lines === lines ? f : { lines, height: lines * lh }));
    };
    measure();
    return watchArt(box, measure);
  }, []);
  return (
    <span className="art art-text" aria-hidden="true">
      <span><b dir="auto">{title}</b>{excerpt ? <span dir="auto" ref={ref} className="ax" style={fit ? { WebkitLineClamp: fit.lines, maxHeight: fit.height } : undefined}>{excerpt}</span> : null}</span>
    </span>
  );
}

/** The card's picture slot. A video or podcast without a picture keeps its dark tile; anything
 *  else without one leads with its title and excerpt. The play mark is only drawn where something answers it. */
export function Art({ item, face, playable = false }: { item: ItemDTO; face: Face; playable?: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = safeImage(item.imageUrl);
  const vid = isTimeBased(item.kind);
  const badge = lengthText(item);
  if ((!src || broken) && !vid) return <TextArt title={item.title} excerpt={itemExcerpt(item)} />;
  return (
    <span className={`art${vid ? " vid" : ""}`} style={{ "--ah": face.hue } as CSSProperties} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : null}
      {vid && playable ? <span className="play"><Icon name="play" /></span> : null}
      {badge ? <span className="badge">{badge}</span> : null}
    </span>
  );
}

/** A video's own page (YouTube, Vimeo, ...), opened in a new tab; the reader may play it in the platform's player instead (VideoEmbed). */
export function videoLink(item: ItemDTO): { href: string; label: string } | null {
  if (item.kind !== "video") return null;
  const href = safeHref(item.url);
  return href ? { href, label: isYouTube(href) ? "Play on YouTube" : "Open the video" } : null;
}

/** Said after the name of a link that opens another tab, for screen readers. */
export function NewTab() {
  return <span className="sr"> (opens in a new tab)</span>;
}

/** The play mark of a card as a real link over the card's picture (a link cannot sit inside the card's button). */
export function PlayLink({ item }: { item: ItemDTO }) {
  const v = videoLink(item);
  if (!v) return null;
  return (
    <span className="playwrap">
      <a className="playlink" href={v.href} target="_blank" rel="noopener noreferrer" aria-label={`${v.label}: ${item.title} (opens in a new tab)`} title={v.label} />
    </span>
  );
}

export function SharedBy({ curator }: { curator: string | null }) {
  return curator ? <span className="shared">shared by <span dir="auto">{curator}</span></span> : null;
}

/** Reading progress, shown only when there is some. Never colour alone: the number is always there. */
export function Progress({ value, label = "Reading progress" }: { value: number; label?: string }) {
  if (!(value > 0)) return null;
  const pct = Math.round(value * 100);
  return (
    <div className="prog">
      <span>{label}: {pct}% read</span>
      <div className="track" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
