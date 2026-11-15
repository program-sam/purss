import { createContext, useContext, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * What an `<img>` loads for a picture address the app was given: the address itself, or (where the page can't load
 * it directly) a promise of one the app fetched. Rejects when there is no picture.
 */
export type PictureResolver = (src: string) => string | Promise<string>;

const PictureContext = createContext<PictureResolver>((src) => src);

export function PictureProvider({ resolve, children }: { resolve: PictureResolver; children: ReactNode }) {
  return <PictureContext.Provider value={resolve}>{children}</PictureContext.Provider>;
}

/** The address to show for `src`: null while it is on its way, and for good once it has failed. */
export function usePicture(src: string | null | undefined): string | null {
  const resolve = useContext(PictureContext);
  const [arrived, setArrived] = useState<{ src: string; url: string | null } | null>(null);
  // Once failed, this one isn't asked for again until it is shown anew.
  const failed = !!arrived && arrived.src === src && arrived.url === null;
  const now = src && !failed ? resolve(src) : null;
  useEffect(() => {
    if (!src || typeof now === "string" || !now) return;
    let live = true;
    now.then((url) => { if (live) setArrived({ src, url }); }, () => { if (live) setArrived({ src, url: null }); });
    return () => { live = false; };
  }, [src, now]);
  if (typeof now === "string") return now;
  return arrived && arrived.src === src ? arrived.url : null;
}

/**
 * Source avatar: the source's own icon when it has one, otherwise a rounded tile with its
 * initials tinted by its hue. An icon that fails to load falls back to the tile.
 */
export function Avatar({ hue, initials, size, src }: { hue: number; initials: string; size?: number; src?: string | null }) {
  const shown = usePicture(src);
  const [broken, setBroken] = useState<string | null>(null);
  const style = { "--ah": hue, ...(size ? { "--s": `${size}px` } : {}) } as CSSProperties;
  if (shown && broken !== shown) {
    return <span className="av pic" style={style} aria-hidden="true"><img src={shown} alt="" decoding="async" onError={() => setBroken(shown)} /></span>;
  }
  return <span className="av" style={style} aria-hidden="true">{initials}</span>;
}

export function AvatarStack({ sources, max = 4 }: { sources: { id: string; hue: number; initials: string; iconUrl?: string | null }[]; max?: number }) {
  const shown = sources.slice(0, max);
  const rest = sources.length - shown.length;
  return (
    <span className="stack" aria-hidden="true">
      {shown.map((s) => <Avatar key={s.id} hue={s.hue} initials={s.initials} src={s.iconUrl} size={20} />)}
      {rest > 0 ? <span className="more">+{rest}</span> : null}
    </span>
  );
}
