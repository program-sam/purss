import { useItemActions } from "../state/actions.ts";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemDetail } from "@purss/domain";
import { Avatar, Button, Icon, IconButton } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { itemDetailQuery, keys } from "../api/queries.ts";
import { LoadingBlocks } from "../components/Loading.tsx";
import { Art, NewTab, Progress, useFace, videoLink } from "../components/item-bits.tsx";
import { VideoEmbed } from "../components/VideoEmbed.tsx";
import { embedFor } from "../lib/embeds.ts";
import { RenameTitle } from "./RenameTitle.tsx";
import { ACTIVE_STATES, KIND_LABELS, workflowLabel } from "../lib/constants.ts";
import { statusButton } from "../lib/status-label.ts";
import { prepareArticleHtml } from "../lib/article-html.ts";
import { dateTime, shortDate } from "../lib/format.ts";
import { displayAuthors, isTimeBased, itemDate, itemExcerpt, lengthText, safeHref } from "../lib/items.ts";
import { splitLinks } from "../lib/links.ts";
import { useNav } from "../nav.ts";
import { usePending, usePendingMark } from "../outbox/hooks.ts";
import { openHold } from "../state/open-hold.ts";
import { seenNotices, useSeenNotice } from "../state/seen-notice.ts";
import { useToasts } from "../state/toasts.tsx";
import { useOverlays } from "../state/overlays.tsx";
import { useItemMenus } from "../state/item-menus.tsx";
import { useCurrentPlace } from "./place.ts";
import { usePopups } from "../state/popups.tsx";
import type { MenuEntry } from "@purss/ui";
import { useWorkspace } from "../state/workspace.tsx";
import { useCachedItem } from "../api/use-item.ts";
import { MediaSection } from "../player/MediaSection.tsx";
import { DownloadSection } from "../downloads/DownloadSection.tsx";
import { useDeviceArticle } from "../downloads/hooks.ts";
import { NotesSection, ReaderHighlights, useHighlightedHtml } from "../annotations/Annotations.tsx";
import { useAnnotations } from "../annotations/use-annotations.ts";
import type { ViewAnnotation } from "../annotations/outbox.ts";
import { PageNav } from "../components/PageNav.tsx";
import { ItemReminder } from "../components/ItemReminder.tsx";
import { DownloadedTag } from "../downloads/DownloadedTag.tsx";
import { useDisplayMode } from "../lib/display.ts";
import { useReadingProgress } from "../lib/reading-progress.ts";

/** The reader: sanitised content, honest capture status, state and basket controls. */
export function ItemPanel({ itemId }: { itemId: string }) {
  const nav = useNav();
  const actions = useItemActions();
  // While a readable copy is being made the panel looks again now and then, so the result appears without a reload.
  const detail = useQuery({ ...itemDetailQuery(itemId), refetchInterval: (q) => (q.state.data?.captures.some((c) => c.level === "pending") ? 4000 : false) });
  const cached = useCachedItem(itemId);
  const item = cached ?? detail.data;
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (item && opened.current !== item.id) { opened.current = item.id; openHold.open(item); void actions.markOpened(item.id); }
  }, [item, actions]);
  // The "Marked as seen" line belongs to the item while it is open here: closing the panel or opening another takes it away. (Leaving is decided a moment after the cleanup, so a replayed effect in development does not end the opening that is under way.)
  useEffect(() => { seenNotices.hold(); return () => seenNotices.release(); }, []);
  // Lists keep this item where it was, still New, until the panel closes or another item opens.
  useEffect(() => { openHold.stay(); return () => openHold.release(); }, []);

  if (!item) {
    return (
      <>
        <div className="panel-bar">
          <button type="button" className="ibtn back" aria-label="Back to list" onClick={() => nav.openItem(undefined)}><Icon name="back" /><span className="bl" aria-hidden="true">Back</span></button>
          <span className="src" />
          <IconButton label="Close details" data-fk="close" onClick={() => nav.openItem(undefined)}><Icon name="x" /></IconButton>
        </div>
        <div className="panel-body" id="panel-body">
          {detail.isError ? (
            <div className="empty"><h2>This item isn't available</h2><p>{messageOf(detail.error)}</p><Button onClick={() => nav.openItem(undefined)}>Close</Button></div>
          ) : <LoadingBlocks label="Loading the item…"><div className="skel" style={{ height: 24, width: "70%" }} /><div className="skel" style={{ height: 14, marginTop: 14 }} /><div className="skel" style={{ height: 14, width: "85%", marginTop: 14 }} /></LoadingBlocks>}
        </div>
      </>
    );
  }
  return <PanelBody itemId={itemId} detail={detail.data} loading={detail.isPending} />;
}

const NO_ANNOTATIONS: readonly ViewAnnotation[] = [];

function PanelBody({ itemId, detail, loading }: { itemId: string; detail: ItemDetail | undefined; loading: boolean }) {
  const ws = useWorkspace();
  const nav = useNav();
  const overlays = useOverlays();
  const actions = useItemActions();
  const menus = useItemMenus();
  // Opened from a basket, the item was saved on purpose: the state menu offers no Ignored.
  const inBasket = useCurrentPlace()?.t === "b";
  const popups = usePopups();
  const qc = useQueryClient();
  const { toast } = useToasts();
  const item = useCachedItem(itemId) ?? detail!;
  const face = useFace(item);
  const source = item.sourceId ? ws.sourceById.get(item.sourceId) : undefined;
  const video = item.kind === "video";
  const media = isTimeBased(item.kind);
  const play = videoLink(item);
  // A video page plays here in its platform's own player; a publisher's file plays in PURSS's player instead (MediaSection).
  const embed = item.media ? null : embedFor(item.url);
  const href = safeHref(item.url);
  const pending = usePending(item.id);
  const seen = useSeenNotice(item.id);
  const markPending = usePendingMark(item.id);
  const [showLatest, setShowLatest] = useState(false);
  const [showPartial, setShowPartial] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setShowLatest(false); setShowPartial(false); setRenaming(false); }, [itemId]);
  const latest = showLatest && !!detail?.latestHtml;
  // A capture that is only part of the page is not the article: the feed's own text comes first and the capture waits behind a toggle (it is shown when the feed sent no text).
  const partial = latest ? null : detail?.partialCopy ?? null;
  const partialShown = !!partial && (showPartial || !detail?.contentHtml);
  // PURSS has only the feed's summary, and a download on this device read the article from the publisher's page: that is shown.
  const deviceArticle = useDeviceArticle(itemId);
  const fromDevice = !!deviceArticle && !latest && !partialShown && !!(detail?.summaryOnly || detail?.contentOmitted);
  const shown = fromDevice ? deviceArticle.html : partialShown ? partial!.html : latest ? detail?.latestHtml : detail?.contentHtml;
  const html = useMemo(() => (shown ? prepareArticleHtml(shown, { dropCitation: !!item.doi, video: video ? { pictureUrl: item.imageUrl } : undefined }) : null), [shown, item.doi, video, item.imageUrl]);
  const ann = useAnnotations(itemId, item.annotatedAt);
  // Highlights belong to PURSS's text, never to an article kept on this device only.
  const highlighted = useHighlightedHtml(html, fromDevice ? NO_ANNOTATIONS : ann.annotations);
  const proseRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const display = useDisplayMode();
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [itemId]);
  // Opening an item moves focus to its heading, so it is announced and the next Tab starts inside it; Escape gives focus back to the row.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [itemId]);
  // Once the title scrolls away, the bar names the item beside its source.
  const [titleGone, setTitleGone] = useState(false);
  useEffect(() => {
    const h = titleRef.current;
    if (!h || !bodyRef.current) return;
    const io = new IntersectionObserver(([e]) => setTitleGone(!e!.isIntersecting), { root: bodyRef.current });
    io.observe(h);
    return () => io.disconnect();
  }, [itemId, renaming]);
  // Reading progress follows how far the person scrolled the article, and reopening goes back to where it was left (lib/reading-progress.ts).
  useReadingProgress(bodyRef, { itemId, ready: !!html && !media, contentKey: html, saved: item.progress, save: (id, progress) => void actions.saveProgress(id, progress) });
  const collections = detail?.collections ?? [];
  const tz = ws.prefs.timezone;
  const audio = detail?.enclosures.find((e) => e.type?.startsWith("audio/"));
  const audioHref = safeHref(audio?.url);
  const lenTxt = lengthText(item);
  const kept = item.basketIds.length > 0;
  const keptName = item.basketIds.length === 1 ? ws.basketById.get(item.basketIds[0]!)?.name ?? "" : `${item.basketIds.length} baskets`;
  const status = statusButton(item.workflow, item.kind);
  const stateEntries = () => [...ACTIVE_STATES, ...(inBasket ? [] : ["ignored" as const])].map<MenuEntry>((k) => ({
    type: "radio", label: workflowLabel(k, item.kind), on: item.workflow === k, onSelect: () => void actions.setWorkflow([item.id], k),
  }));
  // Only PURSS's own answer says a copy was kept; until then the panel says so, and never prints a date it does not have.
  const keptLine = pending ? "Keeping this. Saved on this device until PURSS confirms."
    : detail?.keptVersionAt ? `Kept on ${dateTime(detail.keptVersionAt, tz)}.` : `Kept in ${keptName}.`;
  const summaryOnly = !!detail?.summaryOnly && !media;
  const excerpt = itemExcerpt(item);
  async function retryCapture() {
    try {
      await post(`/api/items/${encodeURIComponent(item.id)}/capture/retry`);
      await qc.invalidateQueries({ queryKey: keys.item(item.id) });
      toast("Trying again to read the page.");
    } catch (err) { toast(messageOf(err), { tone: "error" }); }
  }

  return (
    <>
      <div className={`panel-bar${titleGone ? " titled" : ""}`}>
        <button type="button" className="ibtn back" aria-label="Back to list" onClick={() => nav.openItem(undefined)}><Icon name="back" /><span className="bl" aria-hidden="true">Back</span></button>
        {source ? (
          <button type="button" className="src" aria-label={`Open source ${source.title}`} onClick={() => nav.go({ t: "s", id: source.id })}>
            <Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} size={26} /><span className="nm"><bdi>{source.title}</bdi></span>
          </button>
        ) : <span className="src"><Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} size={26} /><span className="nm"><bdi>{face.name}</bdi></span></span>}
        {titleGone ? <span className="pt" aria-hidden="true" dir="auto">{item.title}</span> : null}
        {titleGone ? (
          // Scrolled past the actions: State and Keep stay within reach in the bar.
          <span className="pb-acts">
            <button type="button" className={`mbtn st st-${item.workflow}`} aria-haspopup="menu" aria-label={status.aria}
              onClick={(e) => popups.menu(e.currentTarget, stateEntries(), "State")}>{status.text}<Icon name="chev" size="sm" /></button>
            <button type="button" className={`mbtn${kept ? " kept-on" : ""}`} aria-haspopup="menu" aria-label={kept ? `Kept in ${keptName}. Change baskets` : "Keep in a basket"} onClick={(e) => menus.openKeep(item, e.currentTarget)}>
              <Icon name="bookmark" /><span className="pb-kl">{kept ? "Kept" : "Keep"}</span></button>
          </span>
        ) : null}
        <button type="button" className="ibtn" aria-haspopup="menu" aria-label="More for this item" onClick={(e) => popups.menu(e.currentTarget, [
            ...menus.linkEntries(item),
            ...(detail?.renamable ? [{ label: "Rename…", icon: "pencil" as const, onSelect: () => setRenaming(true) }] : []),
          ], "More for this item")}><Icon name="more" /><span className="ml" aria-hidden="true">More</span></button>
        <IconButton label="Close details" data-fk="close" onClick={() => nav.openItem(undefined)}><Icon name="x" /></IconButton>
      </div>
      <div className="panel-body" id="panel-body" ref={bodyRef} tabIndex={-1}>
        {video || embed ? <div>{embed ? <VideoEmbed key={item.id} item={item} face={face} embed={embed} /> : play ? <a className="art-link" href={play.href} target="_blank" rel="noopener noreferrer" aria-label={`${play.label}: ${item.title} (opens in a new tab)`}><Art item={item} face={face} playable /></a> : <Art item={item} face={face} />}</div> : null}
        <div style={{ display: "grid", gap: 6 }}>
          {renaming ? <RenameTitle itemId={item.id} title={item.title} onDone={() => setRenaming(false)} /> : <h2 className="p-title" ref={titleRef} tabIndex={-1} dir="auto">{item.title}</h2>}
          {item.author ? <p className="p-by" dir="auto">{displayAuthors(item.author)}</p> : null}
          <p className="p-meta dotted">
            <span>{KIND_LABELS[item.kind]}</span>
            {lenTxt && !summaryOnly ? <span>{lenTxt}{media ? "" : " read"}</span> : null}
            <time dateTime={itemDate(item)} title={dateTime(itemDate(item), tz)}>{shortDate(itemDate(item), Date.now(), tz)}</time>
            {collections.map((c) => <span key={c.id}><bdi>{c.name}</bdi></span>)}
            {item.doi ? <span className="nowrap">DOI {item.doi}</span> : null}
            <DownloadedTag itemId={item.id} />
          </p>
          {seen ? <p className="fine p-seen">Marked as seen <button type="button" className="link" onClick={() => void actions.undoSeenMarker(seen)}>Undo</button></p> : null}
        </div>
        <div className="p-acts" role="group" aria-label="Item actions">
          <button type="button" className={`mbtn st st-${item.workflow}`} aria-haspopup="menu" aria-label={status.aria}
            onClick={(e) => popups.menu(e.currentTarget, stateEntries(), "State")}>
            {status.keyed ? <span className="k">State</span> : null}{status.text}<Icon name="chev" size="sm" />
          </button>
          <button type="button" className={`mbtn${kept ? " kept-on" : ""}`} aria-haspopup="menu" onClick={(e) => menus.openKeep(item, e.currentTarget)}>
            <Icon name="bookmark" />{kept ? <><span className="kin">Kept in</span><span className="k" dir="auto">{keptName}</span></> : "Keep"}<Icon name="chev" size="sm" />
          </button>
          {href ? <a className={`mbtn${detail?.captures.some((c) => c.level === "fulltext" || c.level === "browser") || html && html.length > 1500 ? "" : " go"}`} href={href} target="_blank" rel="noopener noreferrer">{embed ? `Open on ${embed.platform}` : video && play ? play.label : "Open original"}<NewTab /><Icon name="ext" size="sm" /></a> : null}
          {audioHref ? <a className="mbtn" href={audioHref} target="_blank" rel="noopener noreferrer">Open the audio<NewTab /><Icon name="ext" size="sm" /></a> : null}
        </div>
        {kept ? <ItemReminder itemId={item.id} /> : null}
        {markPending ? <p className="fine p-pend" role="status"><Icon name="clock" size="sm" />Not sent yet. Saved on this device. It'll be sent when PURSS is reachable.</p> : null}
        {!html && !loading && excerpt ? <p className="p-ex" dir="auto">{splitLinks(excerpt).map((p, i) => (p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a> : <Fragment key={i}>{p.text}</Fragment>))}</p> : null}
        {!loading && !fromDevice && (detail?.contentOmitted || summaryOnly) ? (
          <p className="p-warn p-sum" role="note"><Icon name="info" /><span>{detail?.contentOmitted ? "The feed's full text was too large to store; open the original." : "Summary only — the full article stays on the original site."}</span></p>
        ) : null}
        {item.curatorNote ? <p className="p-quote"><b>From {face.curator ?? "the person who shared this"}</b>{item.curatorNote}</p> : null}
        {source?.health === "login" ? <p className="p-warn"><Icon name="key" /><span>Full text needs a login. Titles and summaries still arrive.</span></p> : null}
        {media ? null : <Progress value={item.progress} />}
        {detail?.media ? <MediaSection item={{ ...detail, media: detail.media }} /> : null}
        {detail ? <DownloadSection item={detail} /> : null}
        {loading ? <><hr /><LoadingBlocks label="Loading the text…"><div className="skel" style={{ height: 14 }} /><div className="skel" style={{ height: 14, width: "90%", marginTop: 10 }} /><div className="skel" style={{ height: 14, width: "75%", marginTop: 10 }} /></LoadingBlocks></>
          : html ? <><hr />
            {detail?.changedSinceKept ? (
              <p className="fine kept-note">{showLatest ? "Showing the latest version from the source." : "The original changed after you kept it. Showing your kept copy."}{" "}
                <button type="button" className="link" onClick={() => setShowLatest((v) => !v)}>{showLatest ? "Show your kept copy" : "Show the latest version"}</button></p>
            ) : null}
            {fromDevice ? (
              <p className="fine kept-note" role="note">The full article, read from the publisher's page on {dateTime(deviceArticle.savedAt, tz)}. It is kept on this device only: your PURSS and your other devices have the summary, and highlights can't be made on it.</p>
            ) : null}
            {partial ? (
              <p className="fine kept-note" role="note">{partial.note}{" "}
                {detail?.contentHtml ? <button type="button" className="link" onClick={() => setShowPartial((v) => !v)}>{partialShown ? "Show the feed's own text" : "Show what was saved of the page"}</button> : null}</p>
            ) : null}
            <div className="prose" dir="auto" ref={proseRef} dangerouslySetInnerHTML={{ __html: highlighted.html ?? html }} />
            {fromDevice ? null : <ReaderHighlights proseRef={proseRef} ann={ann} textRef={(partialShown ? partial!.ref : latest ? detail?.latestRef : detail?.contentRef) ?? null} />}</> : null}
        <hr />
        <NotesSection ann={ann} detached={highlighted.detached} hasText={!!html && !fromDevice} proseRef={proseRef} tz={tz} />
        <section className="p-copy" aria-label="About your copy">
          {detail?.captures.length ? (
            <ul className="caps" aria-label="What was kept">
              {detail.captures.map((c) => (
                <li key={c.id} className="cap"><Icon name={c.level === "failed" ? "alert" : c.level === "pending" ? "clock" : "check"} size="sm" /><span>{c.label}{c.level === "browser" ? ` on ${shortDate(c.createdAt, Date.now(), tz)}` : ""}{c.note ? `. ${c.note}` : ""}<small> · <time dateTime={c.createdAt}>{dateTime(c.createdAt, tz)}</time></small>
                  {(c.level === "failed" || c.level === "partial") && href ? <>{" "}<button type="button" className="link" onClick={() => void retryCapture()}>Try again</button></> : null}</span></li>
              ))}
            </ul>
          ) : null}
          {item.basketIds.length ? <p className="fine">{keptLine} The original page may change or disappear. Your kept copy stays as it is.</p>
            : <p className="fine">Keeping saves the link, title and summary. Baskets that save text also keep the page text. The original page may change or disappear.</p>}
        </section>
      </div>
      {display === "eink" ? <PageNav target={bodyRef} what="article" /> : null}
    </>
  );
}
