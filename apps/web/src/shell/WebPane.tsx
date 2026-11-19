import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, IconButton } from "@purss/ui";
import { platform } from "../platform/index.ts";
import type { WebView } from "../platform/types.ts";
import { addressParts, coversOver, placeWebView } from "../lib/originals.ts";
import type { Box } from "../lib/originals.ts";

/**
 * A page from another site in the reader: the article's original or a link in it, over the article, which
 * keeps its place underneath. The bar names the site and address, and always offers the page outside PURSS. In the
 * desktop app the page is its own web view, drawn over this pane's place; in a browser it is a frame, offered only for
 * pages whose headers allow PURSS to frame them.
 */
export function WebPane({ url, top, onClose }: { url: string; top: number; onClose: () => void }) {
  const view = platform.webView;
  const [shown, setShown] = useState({ url, loading: true });
  const [reloads, setReloads] = useState(0);
  useEffect(() => { setShown({ url, loading: true }); }, [url]);
  const address = addressParts(shown.url || url);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <div className="web-pane" style={{ top }} role="region" aria-label={`Page from ${address.site}`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="web-bar">
        <button ref={closeRef} type="button" className="ibtn web-close" onClick={onClose} aria-label="Back to the article" title="Back to the article (Esc)">
          <Icon name="back" /><span aria-hidden="true">Article</span>
        </button>
        {view ? (
          <>
            <IconButton label="Back in this page" title="Back" onClick={() => view.go("back")}><Icon name="back" size="sm" /></IconButton>
            <IconButton label="Forward in this page" title="Forward" onClick={() => view.go("forward")}><Icon name="chev" size="sm" /></IconButton>
          </>
        ) : null}
        <span className="web-addr" title={shown.url || url}>
          {address.secure ? null : <span className="web-plain">Not secure</span>}
          <bdi className="web-site">{address.site}</bdi><span className="web-rest">{address.rest}</span>
        </span>
        {shown.loading ? <span className="web-loading" role="status">Loading…</span> : null}
        <IconButton label="Reload the page" title="Reload" onClick={() => (view ? view.go("reload") : setReloads((n) => n + 1))}><Icon name="reload" size="sm" /></IconButton>
        <a className="ibtn" href={shown.url || url} target="_blank" rel="noopener noreferrer" aria-label={view ? "Open in your browser" : "Open in a new tab"} title={view ? "Open in your browser" : "Open in a new tab"}
          onClick={(e) => { if (view) { e.preventDefault(); platform.openExternal(shown.url || url); } }}><Icon name="ext" size="sm" /></a>
      </div>
      {view ? <NativeView view={view} url={url} onState={setShown} />
        : (
          <div className="web-view">
            <iframe key={reloads} src={url} title={`Page from ${address.site}`}
              // A page of its own (another origin, so these don't let it reach PURSS): it may run, keep its cookies, send forms and open
              // tabs, but never navigate PURSS itself. Its site learns PURSS's origin only, as with the video players.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="strict-origin-when-cross-origin" allow="fullscreen" allowFullScreen
              onLoad={() => setShown((s) => ({ ...s, loading: false }))} />
          </div>
        )}
    </div>
  );
}

/** The desktop app's web view, kept over this element's place and out from under PURSS's popups and messages. */
function NativeView({ view, url, onState }: { view: WebView; url: string; onState: (s: { url: string; loading: boolean }) => void }) {
  const place = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const stateRef = useRef(onState);
  stateRef.current = onState;
  // The blank page the view is emptied with when a pane closes is never a destination: Back reaching it goes forward again.
  useEffect(() => view.subscribe((s) => {
    if (s.url) stateRef.current(s);
    else if (!s.loading && opened.current) view.go("forward");
  }), [view]);

  // Opened once per address; moved, hidden and shown as the page around it changes.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = place.current;
    if (!el) return;
    let last = "";
    let frame = 0;
    const measure = (): Box | null => {
      const r = el.getBoundingClientRect();
      return placeWebView({ x: r.left, y: r.top, width: r.width, height: r.height }, coversOver(el.closest(".web-pane") ?? el));
    };
    const update = () => {
      frame = 0;
      const box = document.visibilityState === "visible" ? measure() : null;
      const key = box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : "hidden";
      if (key === last || !opened.current) return;
      last = key;
      view.place(box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [view]);

  useEffect(() => {
    const el = place.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = { x: Math.round(r.left), y: Math.round(r.top), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    setFailed(false);
    let gone = false;
    view.open(url, box).then(() => {
      if (gone) return;
      opened.current = true;
      // Something may already be over its place (a menu that opened the page): placed again at once.
      const now = placeWebView(box, coversOver(el.closest(".web-pane") ?? el));
      if (!now || now.height !== box.height) view.place(now);
    }, () => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [view, url]);
  useEffect(() => () => { opened.current = false; view.close(); }, [view]);

  return (
    <div className="web-view" ref={place}>
      {failed ? <p className="web-failed">This page couldn't be shown here. <button type="button" className="link" onClick={() => platform.openExternal(url)}>Open it in your browser</button></p> : null}
    </div>
  );
}
