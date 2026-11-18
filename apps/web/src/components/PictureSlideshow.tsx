import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon, IconButton } from "@purss/ui";

/**
 * A post's pictures one at a time, as the post shows them (for now an Instagram post's kept pictures: its first, then the rest
 * of its carousel). The pictures sit side by side in a strip that snaps to each one, so a finger or a trackpad swipes through
 * them natively; the arrows, the dots and the arrow keys (when the slideshow has focus) move one picture. The frame takes the
 * first picture's shape, which an Instagram carousel shares with all its pictures, and never grows taller than most of the screen.
 * Give it a key per item, so another item's pictures start at the first.
 */
export function PictureSlideshow({ pictures, label }: { pictures: readonly string[]; label: string }) {
  const track = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState(0);
  const [ratio, setRatio] = useState(4 / 5);
  const many = pictures.length > 1;

  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const to = Math.max(0, Math.min(pictures.length - 1, i));
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: to * el.clientWidth, behavior: smooth ? "smooth" : "auto" });
    setAt(to);
  };
  const onScroll = () => {
    const el = track.current;
    if (el && el.clientWidth) setAt(Math.round(el.scrollLeft / el.clientWidth));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation(); // the reader's own arrow keys move between items
      go(at + (e.key === "ArrowRight" ? 1 : -1));
    }
  };

  return (
    <section className="slideshow" aria-roledescription="carousel" aria-label={label} tabIndex={many ? 0 : undefined} onKeyDown={many ? onKey : undefined}
      style={{ width: `min(100%, calc(75vh * ${ratio}))` }}>
      <div className="slideshow-stage" style={{ aspectRatio: String(ratio) }}>
        <ul ref={track} className="slideshow-track" dir="ltr" onScroll={many ? onScroll : undefined}>
          {pictures.map((src, i) => (
            <li key={src} aria-roledescription="slide" aria-label={many ? `${i + 1} of ${pictures.length}` : undefined} aria-hidden={many && i !== at ? true : undefined}>
              <img src={src} alt="" decoding="async" loading={i < 2 ? "eager" : "lazy"} draggable={false}
                onLoad={i === 0 ? (e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setRatio(w / h); } : undefined} />
            </li>
          ))}
        </ul>
        {many ? <>
          <IconButton label="Previous picture" className="slideshow-prev" onClick={() => go(at - 1)} disabled={at === 0} tabIndex={-1}><Icon name="back" /></IconButton>
          <IconButton label="Next picture" className="slideshow-next" onClick={() => go(at + 1)} disabled={at === pictures.length - 1} tabIndex={-1}><Icon name="chev" /></IconButton>
          <span className="slideshow-count" aria-live="polite">{at + 1} / {pictures.length}</span>
        </> : null}
      </div>
      {many ? (
        <div className="slideshow-dots">
          {pictures.map((src, i) => <button key={src} type="button" aria-label={`Picture ${i + 1}`} aria-current={i === at ? "true" : undefined} tabIndex={-1} onClick={() => go(i)} />)}
        </div>
      ) : null}
    </section>
  );
}
