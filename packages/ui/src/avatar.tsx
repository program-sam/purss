import { useState } from "react";
import type { CSSProperties } from "react";

/**
 * Source avatar: the source's own icon when it has one, otherwise a rounded tile with its
 * initials tinted by its hue. An icon that fails to load falls back to the tile.
 */
export function Avatar({ hue, initials, size, src }: { hue: number; initials: string; size?: number; src?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  const style = { "--ah": hue, ...(size ? { "--s": `${size}px` } : {}) } as CSSProperties;
  if (src && broken !== src) {
    return <span className="av pic" style={style} aria-hidden="true"><img src={src} alt="" decoding="async" onError={() => setBroken(src)} /></span>;
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
