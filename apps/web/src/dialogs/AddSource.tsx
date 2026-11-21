import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { app } from "@purss/copy/app";
import type { BasketDTO, DiscoveryCandidate, DiscoveryResult, KeepOffer, PodcastSearchHit, PodcastSearchResponse, SiteSearchHit, SiteSearchResponse, SourceDTO } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { ManualKeepResult } from "../api/types.ts";
import { addSourceStatus, focusTargets } from "../lib/add-source-status.ts";
import { focusFirst, focusLost } from "../lib/focus.ts";
import { capacityOf, collectionLimitNote } from "../lib/plan-limits.ts";
import { shortDate } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { keptMessage } from "./KeepPage.tsx";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { hasPage } from "../plugins.ts";
import { platform } from "../platform/index.ts";
import { isolate } from "../lib/bidi.ts";
import { preselect } from "../lib/discovery.ts";
import { looksLikeName } from "../lib/typed-name.ts";

const t = app.dialogs.addSource;

type Failure = Extract<DiscoveryResult, { ok: false }>;

type StartFrom = "now" | "week";
/** What following does with the posts a source already has. Either way the older ones are kept as Ignored, and search finds them. */
const START_CHOICES: { value: StartFrom; label: string; blurb: string }[] = [
  { value: "now", label: t.startNow.label, blurb: t.startNow.blurb },
  { value: "week", label: t.startWeek.label, blurb: t.startWeek.blurb },
];
const FAIL_TITLE: Record<Failure["reason"], string> = {
  invalid: t.failTitle.invalid,
  blocked: t.failTitle.blocked,
  unreachable: t.failTitle.unreachable,
  nofeed: t.failTitle.nofeed,
  unsupported: t.failTitle.unsupported,
  toolarge: t.failTitle.toolarge,
  timeout: t.failTitle.timeout,
};
/** Reasons where keeping the page as a single saved link is still a sensible thing to offer. */
const CAN_KEEP: Failure["reason"][] = ["nofeed", "unsupported", "unreachable", "timeout", "toolarge"];
/** A social handle (@name@server, @name.bsky.social) is not a page that could be kept as a link. */
const isHandle = (text: string) => /^@|^[^/:@\s]+@[^/@\s]+$/.test(text.trim());
const NEW = "__new";
const LOOSE = "__none";
/** Nothing chosen yet: a kept link goes into a basket the person names, never into whichever came first. */
const UNSET = "";
/** What searching by name tells the person up front: where the words go. */
const NAME_SEARCH_NOTE = t.nameSearchNote;

function CandidateCard({ c, checked, own, onPick }: { c: DiscoveryCandidate; checked: boolean; own: boolean; onPick: () => void }) {
  return (
    <label className="cand">
      <input type="radio" name="cand" checked={checked} onChange={onPick} />
      <span className="radio" aria-hidden="true" />
      <span style={{ display: "grid", gap: 0, minWidth: 0, gridColumn: "span 2" }}>
        <h3><bdi>{c.title}</bdi><span className="tag">{c.kind === "youtube" ? <Icon name="play" /> : <span className="rss"><Icon name="rss" /></span>}{c.origin}</span></h3>
        <span className="cad">{c.via}{c.cadence ? t.candidate.cadence(c.cadence) : ""}</span>
        {c.samples.length ? <ul>{c.samples.slice(0, 3).map((s, i) => <li key={i}><bdi>{s.title}</bdi>{s.publishedAt ? <span style={{ color: "var(--ink-3)" }}> · {shortDate(s.publishedAt)}</span> : null}</li>)}</ul> : <span className="fine" style={{ marginTop: 6 }}>{t.candidate.noPosts}</span>}
        {c.summariesOnly ? <span className="fine" style={{ marginTop: 6 }}>{t.candidate.summariesOnly}</span> : null}
        {own ? <span className="fine" style={{ marginTop: 6, color: "var(--accent-ink)", fontWeight: 800 }}>{t.candidate.own}</span> : null}
        {c.alreadyFollowingSourceId ? <span className="fine" style={{ marginTop: 6, color: "var(--accent-ink)", fontWeight: 800 }}>{t.candidate.alreadyFollowing}</span> : null}
        {c.sameFeedSource ? <span className="fine" style={{ marginTop: 6 }}>{t.candidate.sameFeed.before}<b><bdi>{c.sameFeedSource.title}</bdi></b>{t.candidate.sameFeed.after}</span> : null}
        {c.sameNameSource ? <span className="fine" style={{ marginTop: 6 }}>{t.candidate.sameName.before}<b><bdi>{c.sameNameSource.title}</bdi></b>{t.candidate.sameName.after}</span> : null}
        {c.privateWarning ? <span className="p-warn" style={{ marginTop: 8 }}><Icon name="lock" /><span>{c.privateWarning}</span></span> : null}
        {c.note ? <span className="fine" style={{ marginTop: 6 }}>{c.note}</span> : null}
      </span>
    </label>
  );
}

/** The single video a pasted link points to, as it will be kept: one choice beside the channel and playlist to follow. */
function KeepOfferCard({ offer, checked, onPick }: { offer: KeepOffer; checked: boolean; onPick: () => void }) {
  return (
    <label className="cand">
      <input type="radio" name="cand" checked={checked} onChange={onPick} />
      <span className="radio" aria-hidden="true" />
      <span style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12, alignItems: "start", minWidth: 0, gridColumn: "span 2" }}>
        {offer.imageUrl ? <img src={offer.imageUrl} alt="" width={120} height={68} referrerPolicy="no-referrer" style={{ objectFit: "cover", borderRadius: 6, background: "var(--bg-2)" }} /> : null}
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <h3><bdi>{offer.title}</bdi><span className="tag"><Icon name="play" />{t.keepOffer.singleVideo}</span></h3>
          <span className="cad" dir="auto">{[offer.author, offer.siteName].filter(Boolean).join(" · ")}</span>
          <span className="fine" style={{ marginTop: 6 }}>{t.keepOffer.keepJust}</span>
        </span>
      </span>
    </label>
  );
}

/**
 * Add source. A link handed over (a deep link from the browser extension or a bookmarklet, or a link
 * shared into the apps) is only filled in: nothing is looked up until the person presses Find, so
 * visiting a link can't make the server fetch.
 */
export function AddSourceDialog({ collectionId, url: initialUrl }: { collectionId?: string; url?: string }) {
  const ov = useOverlays();
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const sourceCollections = ws.collections.filter((c) => c.mode === "sources");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [phase, setPhase] = useState<"paste" | "looking" | "found" | "failed" | "single" | "results">("paste");
  /** A video link starts on keeping the video; its channel and playlist are the other choices in the same list. */
  const [mode, setMode] = useState<"follow" | "keep">("follow");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [pick, setPick] = useState(0);
  // Following never needs a collection: it starts as "No collection", unless Add source was opened from one.
  const [colChoice, setColChoice] = useState<string>(collectionId && sourceCollections.some((c) => c.id === collectionId) ? collectionId : LOOSE);
  const [newName, setNewName] = useState("");
  /** Null until the person ticks or unticks it: then a link that looks like it carries a key starts private. */
  const [markPrivate, setMarkPrivate] = useState<boolean | null>(null);
  /** Off until the person ticks it; looking up another link starts again from off. */
  const [fullTextChoice, setFullTextChoice] = useState<boolean | null>(null);
  /** What to do with the posts the source already has: leave them out of Home (the default), or also show the last week's as New. */
  const [startFrom, setStartFrom] = useState<StartFrom>("now");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Keep-a-single-link path
  // No basket is chosen for the person: with baskets they pick one, without any the name box for a new one is open.
  const [basketChoice, setBasketChoice] = useState<string>(ws.data.baskets.length ? UNSET : NEW);
  const [newBasket, setNewBasket] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [readableText, setReadableText] = useState(false);
  // Finding a site or a show by name
  const [sites, setSites] = useState<SiteSearchHit[]>([]);
  const [shows, setShows] = useState<PodcastSearchHit[]>([]);
  /** A directory that failed while the other answered: said beside the results that did come. */
  const [siteTrouble, setSiteTrouble] = useState("");
  const [showTrouble, setShowTrouble] = useState("");
  const [searching, setSearching] = useState(false);
  /** Which search is current: the answers of an earlier one (the name was changed and searched again) are dropped. */
  const searchRun = useRef(0);
  /** The look-up came from a result picked in a search, so the typed words are not an address to keep. */
  const [fromSearch, setFromSearch] = useState(false);

  // The control that had focus is replaced or disabled by each step (a site or show chosen from the results, Find and Follow while they work):
  // focus goes to what the step shows, so it doesn't fall to the page.
  useEffect(() => {
    if (!focusLost()) return;
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    focusFirst(dialogs[dialogs.length - 1], focusTargets(phase, { searching, hasError: !!error }));
  }, [phase, searching, error]);

  const candidates = result?.ok ? result.candidates : [];
  const cand = candidates[pick];
  /** Said before "New collection…" is chosen, when the plan has no room for one. */
  const collectionFull = collectionLimitNote(capacityOf(ws.data));
  // A bridged source has no link of its own to keep private.
  const isPrivate = !cand?.feedUrl.startsWith("bridge:") && (markPrivate ?? !!cand?.privateWarning);
  const canFullText = !!cand && (cand.kind === "feed" || cand.kind === "publication") && !isPrivate;
  const fullText = canFullText && (fullTextChoice ?? false); // off unless the person ticks it
  /** What was typed reads as a name, not an address: it can be searched for. */
  const nameLike = phase === "paste" && looksLikeName(url);

  /** Look up an address: the typed one, or the website or feed of a result chosen from a search. */
  async function look(e?: FormEvent, address?: string) {
    e?.preventDefault();
    const target = address ?? url.trim();
    if (!target) return;
    setPhase("looking"); setError(""); setResult(null); setPick(0); setFullTextChoice(null); setMarkPrivate(null); setStartFrom("now"); setFromSearch(address !== undefined);
    try {
      const out = await post<DiscoveryResult>("/api/discover", { url: target });
      setResult(out);
      setPick(out.ok ? preselect(out.candidates) : 0);
      setMode(out.ok && out.keep ? "keep" : "follow");
      setPhase(out.ok ? "found" : "failed");
    } catch (err) { setError(messageOf(err)); setPhase(address !== undefined ? "results" : "paste"); }
  }
  /** Websites and shows with this name, asked of both directories at once. One failing still shows what the other found. */
  async function searchByName() {
    const query = url.trim();
    if (!query) return;
    const run = ++searchRun.current;
    setSearching(true); setError(""); setSites([]); setShows([]); setSiteTrouble(""); setShowTrouble(""); setPhase("results");
    const [siteOut, showOut] = await Promise.allSettled([
      post<SiteSearchResponse>("/api/discover/sites", { query }),
      post<PodcastSearchResponse>("/api/discover/podcasts", { query }),
    ]);
    if (run !== searchRun.current) return;
    const trouble = (r: PromiseSettledResult<SiteSearchResponse | PodcastSearchResponse>) => (r.status === "rejected" ? messageOf(r.reason) : r.value.ok ? "" : r.value.message);
    if (siteOut.status === "fulfilled" && siteOut.value.ok) setSites(siteOut.value.hits);
    if (showOut.status === "fulfilled" && showOut.value.ok) setShows(showOut.value.hits);
    const siteFailed = trouble(siteOut), showFailed = trouble(showOut);
    if (siteFailed && showFailed) setError(siteFailed);
    else { setSiteTrouble(siteFailed); setShowTrouble(showFailed); }
    setSearching(false);
  }
  /** A changed link makes the earlier result stale: forget it, so Follow can't act on the old address. */
  function editUrl(next: string) {
    setUrl(next);
    if (phase === "found" || phase === "failed" || phase === "results") { searchRun.current++; setSearching(false); setPhase("paste"); setResult(null); setPick(0); setError(""); setSites([]); setShows([]); setSiteTrouble(""); setShowTrouble(""); setFromSearch(false); }
  }

  async function follow() {
    if (!cand) return;
    if (cand.alreadyFollowingSourceId) { ov.close(); nav.go({ t: "s", id: cand.alreadyFollowingSourceId }); return; }
    setBusy(true); setError("");
    try {
      const src = await post<SourceDTO>("/api/sources", {
        token: cand.token,
        collectionId: colChoice === NEW || colChoice === LOOSE ? null : colChoice,
        newCollectionName: colChoice === NEW ? newName.trim() : null,
        markPrivate: isPrivate,
        fullText,
        startFrom,
      });
      refreshWorkspace(qc);
      ov.close();
      const createdCollection = colChoice === NEW ? src.collectionIds[0] : undefined;
      toast(`${t.following(isolate(src.title))}${colChoice !== LOOSE ? t.inCollection(isolate(ws.collectionById.get(colChoice)?.name ?? newName.trim())) : ""}`, {
        undo: async () => {
          await del(`/api/sources/${encodeURIComponent(src.id)}`);
          if (createdCollection) await del(`/api/collections/${encodeURIComponent(createdCollection)}`).catch(() => undefined);
          refreshWorkspace(qc);
        },
        actions: [{ label: t.openSource, onSelect: () => nav.go({ t: "s", id: src.id }) }],
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  /** Keep one page (or video) in a basket. The server reads its title, picture and site from the page. */
  async function keepLink(target: string, noun: "link" | "video" = "link") {
    setBusy(true); setError("");
    try {
      let basketId = basketChoice;
      let basketName = ws.basketById.get(basketChoice)?.name ?? "";
      if (basketChoice === UNSET) { setError(t.chooseBasketFirst); setBusy(false); return; }
      if (basketChoice === NEW) {
        if (!newBasket.trim()) { setError(app.words.nameTheNewBasketFirst); setBusy(false); return; }
        const b = await post<BasketDTO>("/api/baskets", { name: newBasket.trim(), captureMode: "metadata" });
        basketId = b.id; basketName = b.name;
      }
      const out = await post<ManualKeepResult>("/api/items/manual", { url: target, basketId, ...(linkTitle.trim() ? { title: linkTitle.trim() } : {}), ...(readableText ? { readableText: true } : {}) });
      refreshWorkspace(qc);
      ov.close();
      toast(keptMessage(out, basketName, noun), { actions: [{ label: app.words.open, onSelect: () => nav.go({ t: "b", id: basketId }, { item: out.itemId }) }] });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const offer = phase === "found" && result?.ok && result.keep ? result.keep : null;
  const keeping = mode === "keep" ? offer : null;
  const basketReady = basketChoice !== UNSET && (basketChoice !== NEW || newBasket.trim().length > 0);
  /** The paste hints give way once something was found, to leave room for the choices. */
  const showHelp = !(phase === "found" && (candidates.length || offer));
  const footer = phase === "single"
    ? <><Button onClick={() => setPhase(result && !result.ok ? "failed" : "paste")}>{app.words.back}</Button><Button variant="primary" disabled={busy || !basketReady} onClick={() => void keepLink(url.trim())}>{app.words.keepLink}</Button></>
    : keeping
      ? <><Button onClick={ov.close}>{app.words.cancel}</Button><Button variant="primary" disabled={busy || !basketReady} onClick={() => void keepLink(keeping.url, "video")}>{t.keepThisVideo}</Button></>
      : <><Button onClick={ov.close}>{app.words.cancel}</Button>{phase === "found" ? <Button variant={cand ? "primary" : "default"} disabled={busy || !cand || (!cand.alreadyFollowingSourceId && colChoice === NEW && !newName.trim())} onClick={follow}>{cand?.alreadyFollowingSourceId ? t.openSource : app.words.follow}</Button> : null}</>;

  /** The basket to keep into, and the title; shared by keeping one video and keeping one page. */
  const keepFields = (
    <>
      <Field label={app.words.basket} htmlFor="kl-b">
        <SelectInput id="kl-b" value={basketChoice} onChange={(e) => setBasketChoice(e.target.value)}>
          {ws.data.baskets.length ? <option value={UNSET}>{t.keepFields.chooseBasket}</option> : null}
          {ws.data.baskets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value={NEW}>{app.words.newBasketMenu}</option>
        </SelectInput>
        {basketChoice === NEW ? <input className="in" placeholder={app.words.nameYourBasket} aria-label="New basket name" value={newBasket} onChange={(e) => setNewBasket(e.target.value)} autoFocus={ws.data.baskets.length > 0} /> : null}
      </Field>
      <Field label={app.words.titleOptional} htmlFor="kl-t" hint={t.keepFields.titleHint}>
        <TextInput id="kl-t" value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} maxLength={300} autoComplete="off" placeholder={keeping?.title ?? ""} />
      </Field>
      {keeping?.kind === "video" ? null : (
        <Check checked={readableText} onChange={setReadableText}
          hint={t.keepFields.readableHint}>{t.keepFields.readable}</Check>
      )}
    </>
  );

  return (
    <Dialog title={app.words.addSource} onClose={ov.close} footer={footer} initialFocus="#as-url">
      {phase !== "single" ? (
        <form className="field" onSubmit={(e) => { if (nameLike) { e.preventDefault(); void searchByName(); } else void look(e); }}>
          <label htmlFor="as-url">{t.linkOrName}</label>
          <div className="find">
            <input className="in" id="as-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder={t.placeholder} aria-describedby={showHelp ? "as-help" : undefined}
              value={url} onChange={(e) => editUrl(e.target.value)} />
            {nameLike
              ? <button type="submit" className="btn primary" style={{ height: 38 }}>{t.search}</button>
              : <button type="submit" className={`btn${phase === "paste" || phase === "failed" ? " primary" : ""}`} disabled={phase === "looking" || phase === "results" || !url.trim()} style={{ height: 38 }}>{t.find}</button>}
          </div>
          {showHelp ? (
            <>
              <p className="fine" id="as-help">{t.help}</p>
              {nameLike ? <p className="fine">{NAME_SEARCH_NOTE}</p> : null}
              {hasPage("/settings/data") ? <p className="fine"><button type="button" className="link" onClick={() => { ov.close(); nav.goPath("/settings/data"); }}>{t.importOpml}</button></p> : null}
              {platform.connection ? null : <p className="fine">{t.extension.before}<button type="button" className="link" onClick={() => ov.open({ kind: "settings", tab: "apps" })}>{app.words.browserExtensionOrABookmarklet}</button>{t.extension.after}</p>}
            </>
          ) : null}
        </form>
      ) : null}
      <div className="sr" role="status">{addSourceStatus({ phase, searching, results: sites.length + shows.length, candidates: candidates.length, failure: result && !result.ok ? FAIL_TITLE[result.reason] : null, keeping: !!result?.ok && !!result.keep })}</div>
      <div style={{ display: "grid", gap: 16 }}>
        {phase === "looking" ? <p className="state" id="as-looking" tabIndex={-1}><span className="spin" aria-hidden="true" />{app.words.looking}</p> : null}
        {error && phase !== "single" ? <p className="state note" id="as-error" tabIndex={-1} role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        {phase === "failed" && result && !result.ok ? (
          <>
            <p className="state note" id="as-failed" tabIndex={-1}><Icon name="info" /><span><b style={{ display: "block" }}>{FAIL_TITLE[result.reason]}</b>{result.message}</span></p>
            {fromSearch ? <div><button type="button" className="link" onClick={() => setPhase("results")}>{t.backToResults}</button></div> : null}
            {CAN_KEEP.includes(result.reason) && !isHandle(url) && !fromSearch ? <div><Button onClick={() => setPhase("single")}>{t.keepThisLink}</Button></div> : null}
          </>
        ) : null}
        {phase === "results" ? (
          <div className="field" id="as-results">
            <div className="lbl">{searching ? t.searchingDirectories : t.resultsFor(url.trim())}</div>
            {searching ? <p className="state" id="as-searching" tabIndex={-1}><span className="spin" aria-hidden="true" />{app.words.searching}</p> : null}
            {!searching && !sites.length && !shows.length && !error ? <p className="state note"><Icon name="info" /><span>{t.noResults}</span></p> : null}
            {sites.length ? (
              <>
                <div className="lbl" id="sts">{t.websites}</div>
                <ul className="cands" aria-labelledby="sts" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {sites.map((h) => (
                    <li key={h.address}>
                      <button type="button" className="cand" style={{ gridTemplateColumns: "1fr", width: "100%", textAlign: "start", font: "inherit", color: "inherit", alignItems: "center" }} onClick={() => void look(undefined, h.address)}>
                        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                          <b dir="auto">{h.name}</b>
                          <span className="cad" dir="auto">{[h.site, h.from === "readers" ? t.followedHere : h.description].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {!searching && siteTrouble ? <p className="fine">{siteTrouble}</p> : null}
            {shows.length ? (
              <>
                <div className="lbl" id="shw">{t.podcasts}</div>
                <ul className="cands" aria-labelledby="shw" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {shows.map((h) => (
                    <li key={h.feedUrl}>
                      <button type="button" className="cand" style={{ gridTemplateColumns: "auto 1fr", width: "100%", textAlign: "start", font: "inherit", color: "inherit", alignItems: "center" }} onClick={() => void look(undefined, h.feedUrl)}>
                        {h.artworkUrl ? <img src={h.artworkUrl} alt="" width={56} height={56} referrerPolicy="no-referrer" style={{ objectFit: "cover", borderRadius: 8, background: "var(--bg-2)" }} /> : <span style={{ width: 56, height: 56, borderRadius: 8, background: "var(--bg-2)", display: "grid", placeItems: "center" }} aria-hidden="true"><Icon name="rss" /></span>}
                        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                          <b dir="auto">{h.name}</b>
                          <span className="cad" dir="auto">{[h.author, h.genre].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {!searching && showTrouble ? <p className="fine">{showTrouble}</p> : null}
            <p className="fine">{t.chooseResult(NAME_SEARCH_NOTE)}</p>
          </div>
        ) : null}
        {phase === "found" && (candidates.length || offer) ? (
          <>
            {fromSearch && (sites.length || shows.length) ? <div><button type="button" className="link" onClick={() => setPhase("results")}>{t.backToResults}</button></div> : null}
            <div className="field"><div className="lbl" id="fnd">{offer ? (candidates.length ? t.keepOrFollow : t.singleVideoLink) : candidates.length === 1 ? t.oneSourceFound : t.sourcesFound(candidates.length)}</div>
              <div className="cands" role="radiogroup" aria-labelledby="fnd">
                {offer ? <KeepOfferCard offer={offer} checked={mode === "keep"} onPick={() => setMode("keep")} /> : null}
                {candidates.map((c, i) => <CandidateCard key={c.token} c={c} checked={mode === "follow" && pick === i} own={candidates.length > 1 && c.matchesPage === true && !c.pageList} onPick={() => { setMode("follow"); setPick(i); setFullTextChoice(null); setMarkPrivate(null); }} />)}
              </div>
              {pick < 0 && mode === "follow" && candidates.length ? <p className="fine">{t.noneMatches}</p> : null}
            </div>
            {keeping ? (
              <>
                {keepFields}
                <p className="fine">{t.videoNote}</p>
              </>
            ) : null}
            {!keeping && cand && !cand.alreadyFollowingSourceId ? (
              <>
                <div className="field"><label htmlFor="as-col">{app.words.collection}</label>
                  <SelectInput id="as-col" value={colChoice} onChange={(e) => setColChoice(e.target.value)}>
                    <option value={LOOSE}>{t.noCollection}</option>
                    {sourceCollections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    <option value={NEW} disabled={!!collectionFull}>{app.words.newCollectionMenu}{collectionFull ? t.limitReached : ""}</option>
                  </SelectInput>
                  {colChoice === NEW ? <input className="in" placeholder={app.words.nameYourCollection} aria-label="New collection name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus /> : null}
                  {collectionFull ? <p className="fine">{collectionFull} <button type="button" className="link" onClick={() => ov.open({ kind: "settings", tab: "plan" })}>{app.words.seePlans}</button></p> : null}
                  <p className="fine">{colChoice === LOOSE ? t.withoutCollection : t.collectionGroups}</p>
                </div>
                <fieldset className="field"><legend className="lbl" style={{ marginBottom: 6 }}>{t.postsAlreadyHas}</legend>
                  <div className="radiolist">
                    {START_CHOICES.map((c) => (
                      <label key={c.value} className="rl" style={{ alignItems: "flex-start", padding: "10px" }}>
                        <input type="radio" name="as-start" checked={startFrom === c.value} onChange={() => setStartFrom(c.value)} />
                        <span className="radio" aria-hidden="true" style={{ marginTop: 2 }} />
                        <span style={{ display: "grid", gap: 2 }}><span>{c.label}</span><span className="fine">{c.blurb}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {cand.feedUrl.startsWith("bridge:") ? null : <Check checked={isPrivate} onChange={setMarkPrivate}
                  hint={cand.privateWarning
                    ? t.privateKey
                    : t.privateMembers}>
                  {app.words.keepThisFeedSLinkPrivate}</Check>}
                {canFullText ? (
                  <Check checked={fullText} onChange={setFullTextChoice}
                    hint={t.fullTextHint}>{app.words.saveFullArticles}</Check>
                ) : null}
              </>
            ) : null}
            {isHandle(url) || fromSearch || offer ? null : <div><button type="button" className="link" onClick={() => setPhase("single")}>{t.keepInstead}</button></div>}
          </>
        ) : null}
        {phase === "found" && result?.ok && !candidates.length && !offer ? <p className="state note"><Icon name="info" /><span>{t.nothingFound}</span></p> : null}
        {phase === "single" ? (
          <div style={{ display: "grid", gap: 14 }}>
            <p className="hint">{t.single.before}<b style={{ wordBreak: "break-all" }}>{url.trim()}</b>{t.single.after}</p>
            {keepFields}
            {error ? <p className="state note" id="as-error" tabIndex={-1} role="alert"><Icon name="info" /><span>{error}</span></p> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
