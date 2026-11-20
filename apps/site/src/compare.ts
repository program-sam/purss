import { site as copy } from "@purss/copy/site";
import { ic } from "./kit.ts";

// The "algorithmic feeds against your PURSS" panel: one line runs across the top, tangled over the feed's column and straight over PURSS's.
const THEM = copy.compare.feeds.points;
const US = copy.compare.purss.points;

/** The line, drawn `w` units wide: tangled over the feed side, a steady wobble up to the middle, then straight over PURSS.
 * Loops and waves keep their size at every width, so a narrow drawing has fewer waves instead of squashed ones. */
const wave = (w: number): string => {
  const pts: string[] = [];
  const span = w - 2 * Math.round(w * 0.07), k = span / 860;
  const N = 360, ease = (v: number) => { const c = Math.min(1, Math.max(0, v)); return c * c * (3 - 2 * c); };
  for (let i = 0; i <= N; i++) {
    const t = i / N, knots = 1 - ease((t - 0.07 / k) / (0.09 / k)), swell = 1 - ease((t - 0.36) / 0.22);
    const x = (w - span) / 2 + t * span + 12 * knots * Math.cos(t * 190 * k);
    const y = 42 + knots * 17 * Math.sin(t * 190 * k) + swell * 11 * Math.sin(t * 64 * k + 1);
    pts.push(`${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join("");
};
const line = (w: number, cls: string): string => `<svg class="${cls}" viewBox="0 0 ${w} 84" preserveAspectRatio="${cls === "wide" ? "none" : "xMidYMid meet"}"><defs><linearGradient id="cmp-${cls}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#8a8d99"/><stop offset=".45" stop-color="#8a8d99"/><stop offset=".62" stop-color="hsl(var(--h) 72% 46%)"/><stop offset="1" stop-color="hsl(var(--h) 72% 46%)"/></linearGradient></defs><path d="${wave(w)}" stroke="url(#cmp-${cls})" vector-effect="non-scaling-stroke"/></svg>`;
export const COMPARISON_CSS = `
.cmp{max-width:1000px;margin:38px auto 0;border-radius:20px;overflow:hidden;background:var(--glass);border:1px solid var(--glass-bd);box-shadow:var(--shadow-pop);text-align:left}
.cmp-line{position:relative;height:84px;background:linear-gradient(90deg,#e6e6ea,var(--tint) 62%)}
.cmp-line svg{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.cmp-line .narrow{display:none}
.cmp-cols{display:grid;grid-template-columns:1fr 1fr}
.cmp-cols>div{padding:18px 26px 24px}
.cmp-cols>div:first-child{background:#f1f1f4;filter:saturate(.3)}
.cmp-cols>div:last-child{background:linear-gradient(var(--tint),var(--surface))}
.cmp-cols h3{font-size:13px;font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
.cmp-cols>div:last-child h3{color:var(--accent-ink)}
.cmp-cols ul{display:grid;gap:10px;margin-top:12px;font-weight:700;font-size:16.5px}
.cmp-cols li{display:flex;gap:10px}
.cmp-cols li .ic{flex:none;margin-top:5px;stroke-width:3}
.cmp-cols>div:first-child li{color:var(--ink-2)}
.cmp-cols>div:first-child .ic{color:#b0605a}
.cmp-cols>div:last-child .ic{color:var(--ok)}
@media (max-width:760px){.cmp-cols{grid-template-columns:minmax(0,1fr)}.cmp-line{height:auto;aspect-ratio:480/84}.cmp-line .wide{display:none}.cmp-line .narrow{display:block}}
`;
export const comparison = (): string => `<div class="cmp"><div class="cmp-line" aria-hidden="true">${line(1000, "wide")}${line(480, "narrow")}</div>
<div class="cmp-cols"><div><h3>${copy.compare.feeds.heading}</h3><ul>${THEM.map((t) => `<li>${ic("x")}${t}</li>`).join("")}</ul></div><div><h3>${copy.compare.purss.heading}</h3><ul>${US.map((t) => `<li>${ic("check")}${t}</li>`).join("")}</ul></div></div></div>`;

