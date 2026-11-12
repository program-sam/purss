import { useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BasketDTO, DiscoveryCandidate, DiscoveryResult, KeepOffer, PodcastSearchHit, PodcastSearchResponse, SourceDTO } from "@purss/domain";
import { Button, Check, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { ManualKeepResult } from "../api/types.ts";
import { addSourceStatus } from "../lib/add-source-status.ts";
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
import { looksLikePodcastName } from "../lib/podcast-name.ts";

type Failure = Extract<DiscoveryResult, { ok: false }>;
const FAIL_TITLE: Record<Failure["reason"], string> = {
  invalid: "That doesn't look like a web address",
  blocked: "We can't follow that address",
  unreachable: "We couldn't reach that site",
  nofeed: "Nothing to follow there",
  unsupported: "We can't follow that kind of link",
  toolarge: "That page is too large to check",
  timeout: "That took too long",
};
/** Reasons where keeping the page as a single saved link is still a sensible thing to offer. */
const CAN_KEEP: Failure["reason"][] = ["nofeed", "unsupported", "unreachable", "timeout", "toolarge"];
/** A social handle (@name@server, @name.bsky.social) is not a page that could be kept as a link. */
const isHandle = (text: string) => /^@|^[^/:@\s]+@[^/@\s]+$/.test(text.trim());
const NEW = "__new";
const LOOSE = "__none";
/** Nothing chosen yet: a kept link goes into a basket the person names, never into whichever came first. */
const UNSET = "";
/** What searching for a show by name tells the person up front: where the words go. */
const PODCAST_SEARCH_NOTE = "Searching sends only the name you typed to Apple's podcast directory.";

function CandidateCard({ c, checked, own, onPick }: { c: DiscoveryCandidate; checked: boolean; own: boolean; onPick: () => void }) {
  return (
    <label className="cand">
      <input type="radio" name="cand" checked={checked} onChange={onPick} />
      <span className="radio" aria-hidden="true" />
      <span style={{ display: "grid", gap: 0, minWidth: 0, gridColumn: "span 2" }}>
        <h3><bdi>{c.title}</bdi><span className="tag">{c.kind === "youtube" ? <Icon name="play" /> : <span className="rss"><Icon name="rss" /></span>}{c.origin}</span></h3>
        <span className="cad">{c.via}{c.cadence ? `, ${c.cadence}` : ""}</span>
        {c.samples.length ? <ul>{c.samples.slice(0, 3).map((s, i) => <li key={i}><bdi>{s.title}</bdi>{s.publishedAt ? <span style={{ color: "var(--ink-3)" }}> · {shortDate(s.publishedAt)}</span> : null}</li>)}</ul> : <span className="fine" style={{ marginTop: 6 }}>No posts yet. Follow it and new posts will appear.</span>}
        {c.summariesOnly ? <span className="fine" style={{ marginTop: 6 }}>Summaries only. The full article stays on the original site.</span> : null}
        {own ? <span className="fine" style={{ marginTop: 6, color: "var(--accent-ink)", fontWeight: 800 }}>This is the feed of the page you gave.</span> : null}
        {c.alreadyFollowingSourceId ? <span className="fine" style={{ marginTop: 6, color: "var(--accent-ink)", fontWeight: 800 }}>You already follow this.</span> : null}
        {c.sameNameSource ? <span className="fine" style={{ marginTop: 6 }}>You already follow a source called <b><bdi>{c.sameNameSource.title}</bdi></b> (another address). Following this one adds a second source with the same name.</span> : null}
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
          <h3><bdi>{offer.title}</bdi><span className="tag"><Icon name="play" />Single video</span></h3>
          <span className="cad" dir="auto">{[offer.author, offer.siteName].filter(Boolean).join(" · ")}</span>
          <span className="fine" style={{ marginTop: 6 }}>Keep just this video in a basket.</span>
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
  const [phase, setPhase] = useState<"paste" | "looking" | "found" | "failed" | "single" | "shows">("paste");
  /** A video link starts on keeping the video; its channel and playlist are the other choices in the same list. */
  const [mode, setMode] = useState<"follow" | "keep">("follow");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [pick, setPick] = useState(0);
  // Following never needs a collection: it starts as "No collection", unless Add source was opened from one.
  const [colChoice, setColChoice] = useState<string>(collectionId && sourceCollections.some((c) => c.id === collectionId) ? collectionId : LOOSE);
  const [newName, setNewName] = useState("");
  const [showOnHome, setShowOnHome] = useState(true);
  const [markPrivate, setMarkPrivate] = useState(false);
  /** Off until the person ticks it; looking up another link starts again from off. */
  const [fullTextChoice, setFullTextChoice] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Keep-a-single-link path
  // No basket is chosen for the person: with baskets they pick one, without any the name box for a new one is open.
  const [basketChoice, setBasketChoice] = useState<string>(ws.data.baskets.length ? UNSET : NEW);
  const [newBasket, setNewBasket] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [readableText, setReadableText] = useState(false);
  // Finding a show by name
  const [shows, setShows] = useState<PodcastSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  /** The look-up came from a show picked in the results, so the typed words are not an address to keep. */
  const [fromShow, setFromShow] = useState(false);

  const candidates = result?.ok ? result.candidates : [];
  const cand = candidates[pick];
  // A bridged source (plan/41) has no link of its own to keep private.
  const isPrivate = !cand?.feedUrl.startsWith("bridge:") && (markPrivate || !!cand?.privateWarning);
  const canFullText = !!cand && (cand.kind === "feed" || cand.kind === "publication") && !isPrivate;
  const fullText = canFullText && (fullTextChoice ?? false); // off unless the person ticks it
  /** What was typed reads as a show's name, not an address: it can be searched for. */
  const nameLike = phase === "paste" && looksLikePodcastName(url);

  /** Look up an address: the typed one, or a show's own feed address chosen from a search. */
  async function look(e?: FormEvent, address?: string) {
    e?.preventDefault();
    const target = address ?? url.trim();
    if (!target) return;
    setPhase("looking"); setError(""); setResult(null); setPick(0); setFullTextChoice(null); setFromShow(address !== undefined);
    try {
      const out = await post<DiscoveryResult>("/api/discover", { url: target });
      setResult(out);
      setPick(out.ok ? preselect(out.candidates) : 0);
      setMode(out.ok && out.keep ? "keep" : "follow");
      setPhase(out.ok ? "found" : "failed");
    } catch (err) { setError(messageOf(err)); setPhase(address !== undefined ? "shows" : "paste"); }
  }
  /** Shows with this name in Apple's podcast directory. */
  async function searchShows() {
    const query = url.trim();
    if (!query) return;
    setSearching(true); setError(""); setShows([]); setPhase("shows");
    try {
      const out = await post<PodcastSearchResponse>("/api/discover/podcasts", { query });
      if (out.ok) setShows(out.hits); else { setError(out.message); }
    } catch (err) { setError(messageOf(err)); } finally { setSearching(false); }
  }
  /** A changed link makes the earlier result stale: forget it, so Follow can't act on the old address. */
  function editUrl(next: string) {
    setUrl(next);
    if (phase === "found" || phase === "failed" || phase === "shows") { setPhase("paste"); setResult(null); setPick(0); setError(""); setShows([]); setFromShow(false); }
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
        showOnHome,
        markPrivate: isPrivate,
        fullText,
      });
      refreshWorkspace(qc);
      ov.close();
      const createdCollection = colChoice === NEW ? src.collectionIds[0] : undefined;
      toast(`Following ${isolate(src.title)}${colChoice !== LOOSE ? ` in ${isolate(ws.collectionById.get(colChoice)?.name ?? newName.trim())}` : ""}`, {
        undo: async () => {
          await del(`/api/sources/${encodeURIComponent(src.id)}`);
          if (createdCollection) await del(`/api/collections/${encodeURIComponent(createdCollection)}`).catch(() => undefined);
          refreshWorkspace(qc);
        },
        actions: [{ label: "Open source", onSelect: () => nav.go({ t: "s", id: src.id }) }],
      });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  /** Keep one page (or video) in a basket. The server reads its title, picture and site from the page. */
  async function keepLink(target: string, noun: "link" | "video" = "link") {
    setBusy(true); setError("");
    try {
      let basketId = basketChoice;
      let basketName = ws.basketById.get(basketChoice)?.name ?? "";
      if (basketChoice === UNSET) { setError("Choose a basket for it first."); setBusy(false); return; }
      if (basketChoice === NEW) {
        if (!newBasket.trim()) { setError("Name the new basket first."); setBusy(false); return; }
        const b = await post<BasketDTO>("/api/baskets", { name: newBasket.trim(), captureMode: "metadata" });
        basketId = b.id; basketName = b.name;
      }
      const out = await post<ManualKeepResult>("/api/items/manual", { url: target, basketId, ...(linkTitle.trim() ? { title: linkTitle.trim() } : {}), ...(readableText ? { readableText: true } : {}) });
      refreshWorkspace(qc);
      ov.close();
      toast(keptMessage(out, basketName, noun), { actions: [{ label: "Open", onSelect: () => nav.go({ t: "b", id: basketId }, { item: out.itemId }) }] });
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const offer = phase === "found" && result?.ok && result.keep ? result.keep : null;
  const keeping = mode === "keep" ? offer : null;
  const basketReady = basketChoice !== UNSET && (basketChoice !== NEW || newBasket.trim().length > 0);
  /** The paste hints give way once something was found, to leave room for the choices. */
  const showHelp = !(phase === "found" && (candidates.length || offer));
  const footer = phase === "single"
    ? <><Button onClick={() => setPhase(result && !result.ok ? "failed" : "paste")}>Back</Button><Button variant="primary" disabled={busy || !basketReady} onClick={() => void keepLink(url.trim())}>Keep link</Button></>
    : keeping
      ? <><Button onClick={ov.close}>Cancel</Button><Button variant="primary" disabled={busy || !basketReady} onClick={() => void keepLink(keeping.url, "video")}>Keep this video</Button></>
      : <><Button onClick={ov.close}>Cancel</Button>{phase === "found" ? <Button variant={cand ? "primary" : "default"} disabled={busy || !cand || (!cand.alreadyFollowingSourceId && colChoice === NEW && !newName.trim())} onClick={follow}>{cand?.alreadyFollowingSourceId ? "Open source" : "Follow"}</Button> : null}</>;

  /** The basket to keep into, and the title; shared by keeping one video and keeping one page. */
  const keepFields = (
    <>
      <Field label="Basket" htmlFor="kl-b">
        <SelectInput id="kl-b" value={basketChoice} onChange={(e) => setBasketChoice(e.target.value)}>
          {ws.data.baskets.length ? <option value={UNSET}>Choose a basket…</option> : null}
          {ws.data.baskets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value={NEW}>New basket…</option>
        </SelectInput>
        {basketChoice === NEW ? <input className="in" placeholder="Name your basket" aria-label="New basket name" value={newBasket} onChange={(e) => setNewBasket(e.target.value)} autoFocus={ws.data.baskets.length > 0} /> : null}
      </Field>
      <Field label="Title (optional)" htmlFor="kl-t" hint="Empty uses the page's title">
        <TextInput id="kl-t" value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} maxLength={300} autoComplete="off" placeholder={keeping?.title ?? ""} />
      </Field>
      {keeping?.kind === "video" ? null : (
        <Check checked={readableText} onChange={setReadableText}
          hint="Saves a copy of the page's text, so you can read it if the page changes or disappears. Some sites don't allow it.">Keep readable text too</Check>
      )}
    </>
  );

  return (
    <Dialog title="Add source" onClose={ov.close} footer={footer} initialFocus="#as-url">
      {phase !== "single" ? (
        <form className="field" onSubmit={(e) => { if (nameLike) { e.preventDefault(); void searchShows(); } else void look(e); }}>
          <label htmlFor="as-url">Link or podcast name</label>
          <div className="find">
            <input className="in" id="as-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="e.g. quietharbour.example" aria-describedby={showHelp ? "as-help" : undefined}
              value={url} onChange={(e) => editUrl(e.target.value)} />
            {nameLike
              ? <button type="submit" className="btn primary" style={{ height: 38 }}>Search podcasts</button>
              : <button type="submit" className={`btn${phase === "paste" || phase === "failed" ? " primary" : ""}`} disabled={phase === "looking" || phase === "shows" || !url.trim()} style={{ height: 38 }}>Find</button>}
          </div>
          {showHelp ? (
            <>
              <p className="fine" id="as-help">Paste a link to a website, blog, podcast, YouTube channel or video, feed, or Mastodon or Bluesky account (@name@server, name.bsky.social). To find a podcast, type its name.</p>
              {nameLike ? <p className="fine">{PODCAST_SEARCH_NOTE}</p> : null}
              {hasPage("/settings/data") ? <p className="fine"><button type="button" className="link" onClick={() => { ov.close(); nav.goPath("/settings/data"); }}>Import a list (OPML)</button></p> : null}
              {platform.connection ? null : <p className="fine">Found something while browsing? The <button type="button" className="link" onClick={() => ov.open({ kind: "settings", tab: "apps" })}>browser extension or a bookmarklet</button> brings the page here in one click.</p>}
            </>
          ) : null}
        </form>
      ) : null}
      <div className="sr" role="status">{addSourceStatus({ phase, searching, shows: shows.length, candidates: candidates.length, failure: result && !result.ok ? FAIL_TITLE[result.reason] : null, keeping: !!result?.ok && !!result.keep })}</div>
      <div style={{ display: "grid", gap: 16 }}>
        {phase === "looking" ? <p className="state"><span className="spin" aria-hidden="true" />Looking…</p> : null}
        {error && phase !== "single" ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
        {phase === "failed" && result && !result.ok ? (
          <>
            <p className="state note"><Icon name="info" /><span><b style={{ display: "block" }}>{FAIL_TITLE[result.reason]}</b>{result.message}</span></p>
            {fromShow ? <div><button type="button" className="link" onClick={() => setPhase("shows")}>Back to the shows found</button></div> : null}
            {CAN_KEEP.includes(result.reason) && !isHandle(url) && !fromShow ? <div><Button onClick={() => setPhase("single")}>Keep this link</Button></div> : null}
          </>
        ) : null}
        {phase === "shows" ? (
          <div className="field">
            <div className="lbl" id="shw">{searching ? "Searching Apple's podcast directory…" : shows.length ? `Podcasts matching “${url.trim()}”` : "Shows in Apple's podcast directory"}</div>
            {searching ? <p className="state"><span className="spin" aria-hidden="true" />Searching…</p> : null}
            {!searching && !shows.length && !error ? <p className="state note"><Icon name="info" /><span>No shows found. Try other words, or paste the show's website or feed address.</span></p> : null}
            {shows.length ? (
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
            ) : null}
            <p className="fine">Choose a show to see its latest episodes before you follow it. {PODCAST_SEARCH_NOTE}</p>
          </div>
        ) : null}
        {phase === "found" && (candidates.length || offer) ? (
          <>
            {fromShow && shows.length ? <div><button type="button" className="link" onClick={() => setPhase("shows")}>Back to the shows found</button></div> : null}
            <div className="field"><div className="lbl" id="fnd">{offer ? (candidates.length ? "Keep the video, or follow where it comes from" : "This link is a single video") : candidates.length === 1 ? "1 source found" : `${candidates.length} sources found`}</div>
              <div className="cands" role="radiogroup" aria-labelledby="fnd">
                {offer ? <KeepOfferCard offer={offer} checked={mode === "keep"} onPick={() => setMode("keep")} /> : null}
                {candidates.map((c, i) => <CandidateCard key={c.token} c={c} checked={mode === "follow" && pick === i} own={candidates.length > 1 && c.matchesPage === true} onPick={() => { setMode("follow"); setPick(i); setFullTextChoice(null); }} />)}
              </div>
              {pick < 0 && mode === "follow" && candidates.length ? <p className="fine">None of these clearly matches your link. Choose the one to follow.</p> : null}
            </div>
            {keeping ? (
              <>
                {keepFields}
                <p className="fine">The original video may change or disappear. Your basket keeps the link, title and picture.</p>
              </>
            ) : null}
            {!keeping && cand && !cand.alreadyFollowingSourceId ? (
              <>
                <div className="field"><label htmlFor="as-col">Collection</label>
                  <SelectInput id="as-col" value={colChoice} onChange={(e) => setColChoice(e.target.value)}>
                    <option value={LOOSE}>No collection</option>
                    {sourceCollections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    <option value={NEW}>New collection…</option>
                  </SelectInput>
                  {colChoice === NEW ? <input className="in" placeholder="Name your collection" aria-label="New collection name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus /> : null}
                  <p className="fine">{colChoice === LOOSE ? "Without a collection, it shows in “Other sources” on Home. You can group it later." : "A collection groups sources you read together. Home shows your collections."}</p>
                </div>
                {colChoice !== LOOSE ? <Check checked={showOnHome} onChange={setShowOnHome}>Show this collection on Home</Check> : null}
                {cand.feedUrl.startsWith("bridge:") ? null : <Check checked={markPrivate || !!cand.privateWarning} disabled={!!cand.privateWarning} onChange={setMarkPrivate}
                  hint={cand.privateWarning
                    ? "This link has a personal key in it, so it's kept private automatically."
                    : "Tick this for members-only or paid feeds whose link is unique to you, such as a Patreon or private podcast feed. The full link is locked away: the app shows only the site's address, and exports leave the link out, so you'd paste it again after a restore."}>
                  This feed link is personal to me</Check>}
                {canFullText ? (
                  <Check checked={fullText} onChange={setFullTextChoice}
                    hint="Saves a readable copy of each new post, so you can read it offline. Some sites don't allow it. You can turn this on later.">Fetch the full article for new items</Check>
                ) : null}
              </>
            ) : null}
            {isHandle(url) || fromShow || offer ? null : <div><button type="button" className="link" onClick={() => setPhase("single")}>Keep this link instead</button></div>}
          </>
        ) : null}
        {phase === "found" && result?.ok && !candidates.length && !offer ? <p className="state note"><Icon name="info" /><span>Nothing to follow was found at that address.</span></p> : null}
        {phase === "single" ? (
          <div style={{ display: "grid", gap: 14 }}>
            <p className="hint">This saves only the page at <b style={{ wordBreak: "break-all" }}>{url.trim()}</b> in a basket. You won't follow the site. The original page may change or disappear.</p>
            {keepFields}
            {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
