import { CURRENCIES, ECB, currencyName, show, type Money } from "./currency.ts";
import { links, type Site } from "./site.ts";

/**
 * Shared pieces for the site: icons, sample PURSS data, and mock app screens built from the
 * app's own CSS classes so every screenshot on the site looks exactly like the product.
 */
import { ANDROID_APK, DESKTOP_DOWNLOADS, DISTRIBUTION, publishedStores } from "@purss/domain/distribution";
import type { Distributed } from "@purss/domain/distribution";
import type { DesktopOs } from "./desktop.ts";

const P: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  chev: "M9 6l6 6-6 6",
  home: "M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z",
  mark: "M9.35 4.7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM11.65 4.7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM4.29 7Q12 4.35 19.71 7a.95.95 0 0 1-.62 1.8Q12 6.25 4.91 8.8a.95.95 0 0 1-.62-1.8zM5.2 9.6Q12 7.9 18.8 9.6L20.5 15.4Q21.2 20.4 16 20.6H8Q2.8 20.4 3.5 15.4z",
  bookmark: "M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z",
  basket: "M3.5 10h17l-1.7 8.6a1.5 1.5 0 0 1-1.5 1.2H6.7a1.5 1.5 0 0 1-1.5-1.2z M8 10l3-5.5M16 10l-3-5.5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  rss: "M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14",
  play: "M8 5l11 7-11 7z",
  x: "M6 6l12 12M18 6L6 18",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  down: "M12 5v14M6 13l6 6 6-6",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  arrow: "M5 12h14M13 6l6 6-6 6",
};
const EXTRA: Record<string, string> = {
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  board: '<rect x="3.5" y="4.5" width="5" height="15" rx="1.5"/><rect x="9.5" y="4.5" width="5" height="10" rx="1.5"/><rect x="15.5" y="4.5" width="5" height="12" rx="1.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v10"/>',
  timeline: '<path d="M6 4v16"/><circle cx="6" cy="8" r="2"/><circle cx="6" cy="16" r="2"/><path d="M10 8h10M10 16h7"/>',
  export: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l3 3M13.5 9.5l2 2"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12 15h5"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  page: '<path d="M6 4.5h9l3 3V19.5H6z"/><path d="M9 11h6M9 15h6"/>',
  window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M7 6.8h.01M9.5 6.8h.01"/>',
  filter: '<path d="M4 6h16l-6.2 7.5V19l-3.6-2v-3.5z"/>',
  minus: '<path d="M7 12h10"/>',
};

export function ic(name: string, cls = ""): string {
  const body = EXTRA[name] ?? `<path d="${P[name] ?? ""}"/>`;
  const fill = name === "play" || name === "mark" ? ' style="fill:currentColor;stroke:none"' : "";
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"${fill}>${body}</svg>`;
}

const brand = (label = "PURSS") =>
  `<span class="brand"><span class="mark" aria-hidden="true">${ic("mark")}</span><span class="brand-t">${label}</span></span>`;

const av = (letters: string, hue: number, size = 24) =>
  `<span class="av" style="--ah:${hue};--s:${size}px" aria-hidden="true">${letters}</span>`;

// ---------- Sample PURSS ----------

interface Item { t: string; src: string; l: string; h: number; when: string; kind?: "vid" | "pod" | "art"; fresh?: boolean; kept?: boolean; wf?: string; len?: string }

const ITEMS = [
  { t: "The night sky is getting brighter", src: "Slow Light Journal", l: "SL", h: 228, when: "12 min ago", fresh: true, kind: "art", len: "9 min read" },
  { t: "Restoring a 1970s hand plane", src: "Maker Bench", l: "MB", h: 18, when: "1 h ago", fresh: true, kind: "vid", len: "24:10" },
  { t: "Ep. 112: Small libraries", src: "Night Shift Radio", l: "NS", h: 280, when: "3 h ago", kind: "pod", kept: true, len: "58 min" },
  { t: "Interfaces that respect attention", src: "HCI Preprints", l: "HP", h: 160, when: "Yesterday", kind: "art", wf: "To read", len: "Paper" },
  { t: "A quiet guide to growing tomatoes on a north-facing balcony", src: "Balcony Garden", l: "BG", h: 120, when: "Yesterday", kind: "art", kept: true },
  { t: "How a town rebuilt its train line", src: "Long Read Weekly", l: "LR", h: 40, when: "Tue", kind: "art", wf: "In progress", len: "31 min read" },
  { t: "A tiny weather station", src: "Maker Bench", l: "MB", h: 18, when: "Mon", kind: "vid", wf: "Finished", len: "12:48" },
] as const satisfies readonly Item[];

/** Local news and a football club's fan site, for Home's first box. */
const LOCAL: Item[] = [
  { t: "Council approves the Mill Road cycle path", src: "Millbrook Gazette", l: "MG", h: 210, when: "12 min ago", fresh: true, kind: "art", len: "3 min read" },
  { t: "Rovers sign a young keeper for the winter run", src: "Millbrook Rovers Fans", l: "MR", h: 8, when: "1 h ago", fresh: true, kind: "art", len: "2 min read" },
];

/** The Recipes collection, shown as a table. */
const RECIPES: Item[] = [
  { t: "Slow-roast tomato sauce that keeps all week", src: "Kitchen Table", l: "KT", h: 12, when: "Yesterday", wf: "To read", kept: true },
  { t: "A weeknight dal in 25 minutes", src: "Kitchen Table", l: "KT", h: 12, when: "4 Nov", wf: "Finished", kept: true },
  { t: "Sourdough for people who keep giving up", src: "Crumb & Crust", l: "CC", h: 38, when: "3 Nov", wf: "To read" },
  { t: "Aunt Mei's dumplings, step by step", src: "Mei's Kitchen Notes", l: "MK", h: 330, when: "2 Nov", wf: "Finished", kept: true },
];

const COLLECTIONS = [
  { n: "Local", c: 9, s: [["MG", 210], ["MR", 8]] as [string, number][] },
  { n: "Watch", c: 4, s: [["MB", 18], ["KC", 340]] as [string, number][] },
  { n: "Listen", c: 2, s: [["NS", 280]] as [string, number][] },
  { n: "Slow reads", c: 7, s: [["LR", 40], ["BG", 120]] as [string, number][] },
  { n: "Recipes", c: 12, s: [["KT", 12], ["CC", 38]] as [string, number][] },
] as const;

// ---------- Mock screens (real app classes) ----------

export const quilt = (id = "quilt", size = 96) => `<svg class="quilt" aria-hidden="true"><defs><pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H${size}M0 0V${size}"/><circle r="${(size / 34).toFixed(1)}"/></pattern></defs><rect width="100%" height="100%" fill="url(#${id})"/></svg>`;

function row(i: Item, keepBtn = true): string {
  return `<li class="row has-keep"><div class="row-main"><span class="gut">${i.fresh ? '<span class="dot"></span>' : ""}</span>${av(i.l, i.h, 26)}
<span class="row-t"><span class="title">${i.t}</span><span class="row-s"><span class="sn">${i.src}</span><span class="shared">${i.when}</span>${i.wf ? `<span class="wf">${i.wf}</span>` : ""}</span></span><span></span></div>
${keepBtn ? `<span class="racts"><span class="keep ${i.kept ? "on" : ""}" style="opacity:${i.kept ? 1 : 0}">${ic("bookmark")}</span></span>` : ""}</li>`;
}

function mod(title: string, items: Item[], fresh?: number, stack?: [string, number][]): string {
  return `<section class="mod"><div class="mod-h"><div class="mod-t"><button type="button">${stack ? `<span class="stack">${stack.map(([l, h]) => av(l, h, 22)).join("")}</span>` : ""}<span class="t">${title}</span></button></div>${fresh ? `<span class="mod-fresh"><span class="dot"></span>${fresh} new</span>` : ""}</div>
<ul class="mod-b">${items.map((i) => row(i)).join("")}</ul></section>`;
}

function sidebar(selected = "Home"): string {
  return `<aside class="s-side">
<div class="side-head">${brand()}<span class="btn primary">${ic("plus")}Add source</span>
<span class="pill-search">${ic("search")}Search<kbd>/</kbd></span></div>
<div class="side-scroll">
<span class="nav-row ${selected === "Home" ? "sel" : ""}">${ic("home")}Home</span>
<div class="sec-head"><div class="s-sh">Collections</div></div>
${COLLECTIONS.map((c) => `<div class="grow ${selected === c.n ? "sel" : ""}"><span class="chev">${ic("chev")}</span><span class="glabel">${c.n}</span><span class="cnt">${c.c}</span></div>`).join("")}

<div class="sec-head"><div class="s-sh">Baskets</div></div>
${[["Local history", 6], ["Thesis sources", 38]].map(([n, c]) => `<span class="bk">${ic("basket")}<span class="nm">${n}</span><span class="n">${c}</span></span>`).join("\n")}
</div>
<div class="side-foot"><span class="stor"><span class="meter"><i class="feeds" style="width:37%"></i></span>37 of 100 sources</span></div>
</aside>`;
}

function homeScreen(greeting = "Good morning, Robin"): string {
  return `<div class="homewash">${quilt("quilt-mock")}<div class="col"><div class="s-mh home">${greeting}</div><p class="s-wash-sub">New items since your last visit (yesterday) in 2&nbsp;collections</p></div></div>
<div class="col home-body"><div class="mods">
<div class="mcol">${mod("Local", [...LOCAL, ITEMS[5]], 3, COLLECTIONS[0].s)}</div>
<div class="mcol">${mod("Watch & listen", ITEMS.filter((_, k) => k === 1 || k === 2 || k === 6), 2, [["MB", 18], ["NS", 280]])}</div>
</div></div>`;
}

/**
 * A browser-chrome window around a full PURSS screen. It is a picture: the label describes it, and everything
 * inside is hidden from assistive technology and unreachable (inert), so its buttons never appear as controls.
 */
export function appWindow(content = homeScreen(), opts: { side?: boolean; url?: string; cls?: string; label?: string; crumbs?: string[]; sel?: string } = {}): string {
  return `<div class="s-win ${opts.cls ?? ""}" role="img" aria-label="${opts.label ?? "The PURSS Home screen: new items from your collections"}">
<div class="s-chrome" aria-hidden="true"><i></i><i></i><i></i><span>${opts.url ?? "your.purss"}</span></div>
<div class="s-app ${opts.side === false ? "noside" : ""}" inert aria-hidden="true">${opts.side === false ? "" : sidebar(opts.sel)}<div class="s-stage">
<div class="bar"><div class="crumbs"><ol>${(opts.crumbs ?? ["Home"]).map((c) => `<li>${c}</li>`).join("")}</ol></div><div class="bar-tools"><span class="mbtn">${ic("list")}View</span></div></div>
<div class="s-main">${content}</div></div></div></div>`;
}

export function basketScreen(): string {
  const kept: Item[] = [
    { t: "Interfaces that respect attention", src: "HCI Preprints", l: "HP", h: 160, when: "Kept yesterday", wf: "To read", kept: true },
    { t: "Measuring reading depth", src: "HCI Preprints", l: "HP", h: 160, when: "Kept 4 Nov · readable text", wf: "Finished", kept: true },
    { t: "A guide to dark-sky parks", src: "Slow Light Journal", l: "SL", h: 228, when: "Kept 1 Nov · readable text", kept: true },
    { t: "Calm technology, twenty years on", src: "Calm Tech", l: "CT", h: 300, when: "Unfollowed · kept in March", kept: true },
  ];
  return `<div class="col"><div class="phead"><div class="s-mh">Thesis sources</div><div class="psub"><span>Basket · 38 kept</span><span>Readable text kept</span></div></div>
<div class="list"><ul>${kept.map((i) => row(i)).join("")}</ul></div></div>`;
}

/** Small original illustrations used as video thumbnails in the Cards mock (no third-party imagery). */
const THUMBS: Record<string, string> = {
  plane: `<rect width="160" height="90" fill="#3b2a1e"/><rect y="58" width="160" height="32" fill="#8a5a33"/><rect y="58" width="160" height="4" fill="#a8743f"/><path d="M0 70h160M0 80h160" stroke="#7a4e2b" stroke-width="1"/><path d="M38 56l10-14h60l14 14z" fill="#9aa3ad"/><rect x="40" y="50" width="82" height="8" rx="2" fill="#6b7480"/><path d="M60 42c4-12 14-16 22-16s12 6 10 16z" fill="#c8833f"/><circle cx="104" cy="44" r="7" fill="#c8833f"/><path d="M118 52c10-2 20 0 26 6" stroke="#e8c79c" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="130" cy="20" r="18" fill="#f6b25a" opacity=".25"/>`,
  joints: `<rect width="160" height="90" fill="#2c2420"/><rect x="18" y="26" width="58" height="40" fill="#c99a62"/><path d="M76 30h12l-4 8h-8zM76 46h12l-4 8h-8z" fill="#c99a62"/><rect x="88" y="26" width="54" height="40" fill="#e0b47a"/><path d="M88 30h-8l4 8h4zM88 46h-8l4 8h4zM88 62h-8l4-4h4z" fill="#2c2420"/><path d="M18 40h58M18 54h58M92 34h50M92 50h50" stroke="#a87b48" stroke-width="1"/><rect y="70" width="160" height="20" fill="#4a3a30"/>`,
  arches: `<rect width="160" height="90" fill="#251a2e"/><path d="M0 90V40q20-30 40 0v50zM40 90V40q20-30 40 0v50zM80 90V40q20-30 40 0v50zM120 90V40q20-30 40 0v50z" fill="#4a3657"/><path d="M8 90V46q12-20 24 0v44zM48 90V46q12-20 24 0v44zM88 90V46q12-20 24 0v44zM128 90V46q12-20 24 0v44z" fill="#e8b84a" opacity=".55"/><circle cx="80" cy="16" r="9" fill="none" stroke="#f3d27a" stroke-width="2"/><path d="M58 16a22 22 0 0 1 44 0M48 16a32 32 0 0 1 64 0" fill="none" stroke="#f3d27a" stroke-width="1.5" opacity=".6"/>`,
  weather: `<rect width="160" height="90" fill="#7cc3f0"/><circle cx="128" cy="22" r="12" fill="#ffd66b"/><path d="M30 34a10 10 0 0 1 18-6 8 8 0 0 1 12 8H26a5 5 0 0 1 4-2z" fill="#fff"/><rect y="70" width="160" height="20" fill="#5aa65a"/><rect x="78" y="30" width="4" height="42" fill="#5b6470"/><path d="M80 30l-14-6M80 30l14-6M80 30v-12" stroke="#5b6470" stroke-width="2.5" stroke-linecap="round"/><circle cx="66" cy="24" r="4" fill="#f05a4a"/><circle cx="94" cy="24" r="4" fill="#f05a4a"/><circle cx="80" cy="18" r="4" fill="#f05a4a"/><rect x="72" y="46" width="16" height="12" rx="2" fill="#eef2f6" stroke="#5b6470"/>`,
  tomato: `<rect width="160" height="90" fill="#f3efe6"/><rect x="104" y="6" width="50" height="56" rx="3" fill="#bcd7ea"/><path d="M129 6v56M104 34h50" stroke="#fff" stroke-width="3"/><path d="M40 90V30M40 50l-16-8M40 40l18-10M40 62l16-6" stroke="#4f8a3c" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="26" cy="48" r="7" fill="#e24b36"/><circle cx="58" cy="34" r="8" fill="#e24b36"/><circle cx="56" cy="60" r="6" fill="#f08a3a"/><path d="M14 74h56l-6 16H20z" fill="#b8613a"/>`,
  stars: `<rect width="160" height="90" fill="#0f1a33"/><path d="M0 72l30-14 24 8 30-16 28 12 48-10v38H0z" fill="#1c2a44"/><rect x="0" y="80" width="160" height="10" fill="#2a3a5a"/><g fill="#fff"><circle cx="20" cy="16" r="1.3"/><circle cx="44" cy="30" r="1"/><circle cx="70" cy="12" r="1.6"/><circle cx="96" cy="26" r="1"/><circle cx="118" cy="10" r="1.3"/><circle cx="140" cy="34" r="1"/><circle cx="60" cy="42" r="1"/></g><path d="M110 76h30v-6h-30z" fill="#f7c95a" opacity=".85"/><circle cx="126" cy="64" r="16" fill="#f7c95a" opacity=".12"/>`,
};
const thumb = (k: string) => `<svg class="s-thumb" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${THUMBS[k]}</svg>`;

export function cardsScreen(): string {
  const vids = [
    { t: "Restoring a 1970s hand plane", src: "Maker Bench", l: "MB", h: 18, when: "1 h", len: "24:10", art: "plane", fresh: true },
    { t: "Five joints to practice first", src: "Maker Bench", l: "MB", h: 18, when: "Wed", len: "18:02", art: "joints" },
    { t: "How sound fills a cathedral", src: "Kite & Choir", l: "KC", h: 340, when: "Tue", len: "15:37", art: "arches", fresh: true },
    { t: "A tiny weather station", src: "Maker Bench", l: "MB", h: 18, when: "Mon", len: "12:48", art: "weather" },
    { t: "Balcony tomatoes, a whole summer in four minutes", src: "Balcony Garden", l: "BG", h: 120, when: "Sun", len: "4:02", art: "tomato" },
    { t: "Finding dark skies an hour from the city", src: "Slow Light", l: "SL", h: 228, when: "Sat", len: "21:30", art: "stars" },
  ];
  return `<div class="col"><div class="phead"><div class="ptitle"><div class="s-mh">Watch</div></div><div class="psub"><span class="fr"><span class="dot"></span>2 new</span><span>4 channels</span></div></div>
<div class="grid">${vids.map((i) => `<article class="card"><div class="card-main"><span class="art vid s-art">${thumb(i.art)}<span class="play">${ic("play")}</span><span class="badge">${i.len}</span></span>
<div class="meta">${i.fresh ? '<span class="dot"></span>' : ""}${av(i.l, i.h, 20)}<span class="sn">${i.src}</span><time>${i.when}</time></div><div class="title">${i.t}</div></div></article>`).join("")}</div></div>`;
}

export function boardScreen(): string {
  const col = (name: string, n: number, cards: Item[]) => `<section class="bcol"><div class="bcol-h"><b>${name}</b><span class="n">${n}</span></div><div class="bcards">${cards.map((i) => `<div class="bcard ${i.wf === "Finished" ? "dim" : ""}"><div class="bcard-main"><div class="m">${av(i.l, i.h, 18)}<span class="sn">${i.src}</span><time>${i.when}</time></div><div class="title">${i.t}</div></div>${i.kept ? `<span class="kept">${ic("bookmark")}</span>` : ""}</div>`).join("")}</div></section>`;
  return `<div class="col wide"><div class="phead"><div class="s-mh">Slow reads</div></div><div class="board">
${col("To read", 6, [ITEMS[3], { ...ITEMS[4], src: "Balcony", kept: true }])}${col("In progress", 2, [ITEMS[5]])}${col("Finished", 31, [ITEMS[6]])}</div></div>`;
}

export function tableScreen(): string {
  return `<div class="col"><div class="phead"><div class="s-mh">Recipes</div><div class="psub"><span class="fr"><span class="dot"></span>2 new</span><span>3 sources · 3 kept</span></div></div>
<div class="tblwrap"><table class="tbl"><thead><tr><th><span>Title</span></th><th><span>Source</span></th><th><span>Date</span></th><th><span>State</span></th><th><span>Kept</span></th></tr></thead><tbody>
${RECIPES.map((i) => `<tr><td class="ttl"><span class="tb"><span class="title">${i.t}</span></span></td><td><span class="c-src">${av(i.l, i.h, 22)}${i.src}</span></td><td>${i.when}</td><td>${i.wf ? `<span class="wf">${i.wf}</span>` : "—"}</td><td><span class="kbtn ${i.kept ? "on" : ""}">${ic("bookmark")}</span></td></tr>`).join("")}
</tbody></table></div></div>`;
}

export function timelineScreen(): string {
  const day = (d: string, items: Item[]) => `<div class="day"><h3>${d}</h3><ul>${items.map((i) => row(i)).join("")}</ul></div>`;
  return `<div class="col narrow"><div class="phead"><div class="s-mh">Listen</div></div><div class="list">${day("Today", [ITEMS[2]])}${day("Yesterday", [{ t: "Episode 111: Letters from a lighthouse keeper", src: "Night Shift Radio", l: "NS", h: 280, when: "Yesterday", len: "44 min" }])}${day("Monday", [{ t: "Short: why bread goes stale", src: "Kitchen Physics", l: "KP", h: 95, when: "Mon" }])}</div></div>`;
}

export function readingScreen(): string {
  return `<div class="s-read">${readerPanel()}</div>`;
}

function readerPanel(): string {
  return `<div class="s-panel"><div class="panel-bar"><span class="src">${av("LR", 40, 24)}<span class="nm">Long Read Weekly</span></span></div>
<div class="panel-body"><span class="art" data-i="LR" style="--ah:40"></span><div class="p-title">The long read: how a town rebuilt its train line</div>
<div class="p-meta"><span>Tue 3 Nov</span><span>31 min read</span></div>
<div class="wfseg"><div class="seg"><button aria-pressed="false">To read</button><button aria-pressed="true">In progress</button><button aria-pressed="false">Finished</button></div></div>
<div class="prog"><span>42% read</span><span class="track"><i style="width:42%"></i></span></div>
<p class="p-ex">When the last train left in 1987, nobody expected it back. Thirty years later, a group of volunteers began walking the old route every Sunday…</p>
<p class="fine">Kept in 2 baskets.</p></div></div>`;
}

export function addSourceDialog(): string {
  return `<div class="s-dlg" role="img" aria-label="Add source: paste a YouTube link, see the channel, choose a collection, follow"><div class="s-dlg-in" inert aria-hidden="true"><div class="s-dlg-h"><b>Add source</b></div>
<div class="s-dlg-b"><div class="s-input">${ic("search")}<span>youtube.com/@makerbench</span></div>
<div class="s-found">${av("MB", 18, 40)}<div><b>Maker Bench</b><small>YouTube · about 2 videos a week</small></div><span class="tag"><span class="rss">${ic("play")}</span>Video</span></div>
<p class="fine">New videos appear in your PURSS. Nothing is downloaded; videos play from YouTube.</p>
<div class="s-pick"><span class="fine">Add to collection</span><div class="chips"><span class="chipf" aria-pressed="true">Watch</span><span class="chipf">Slow reads</span><span class="chipf">${ic("plus")} New</span></div></div></div>
<div class="s-dlg-f"><span class="btn ghost">Cancel</span><span class="btn primary">Follow</span></div></div></div>`;
}

// ---------- Plans and comparison (one source of truth for every design) ----------

type Price = { price: string; per: string };
/** Plus and Pro prices in euros including VAT; every price on the site derives from these. */
export const PLUS = { month: 5, year: 48 };
export const PRO = { month: 10, year: 96 };

/** Self-hosting: free, with no limits; offered in the "Host it yourself" section, not as a plan card. */
export const SELF_HOSTED = { name: "Self-hosted", price: "0" };

/**
 * What a hosted plan includes, row by row in the same order on every card, so the cards compare at a glance. A row a plan
 * doesn't have is shown as not included. What every plan has is listed once, below the cards (ALWAYS).
 */
export const PLAN_ROWS = [
  { key: "sources", label: (v: string) => `${v} sources` },
  { key: "collections", label: (v: string) => `${v} collections` },
  { key: "sharing", label: () => "Share baskets and collections as public pages" },
  { key: "smart", label: () => "Smart filters: plain-language rules for what you want to see" },
] as const;
type Row = (typeof PLAN_ROWS)[number]["key"];

/** A plan's price; `yearly` is shown while the pricing toggle is on yearly billing, `price`/`per` while it is on monthly. */
export const PLANS: Record<"free" | "plus" | "pro", Price & { yearly?: Price; eur?: { month: number; year: number }; name: string; lede: string; has: Partial<Record<Row, string>>; cta: string }> = {
  free: { name: "Free", price: "€0", per: "per month", lede: "We run it for you. No card needed.", has: { sources: "100", collections: "4" }, cta: "Create a free account" },
  plus: { name: "Plus", price: `€${PLUS.month}`, per: "per month, billed monthly", yearly: { price: `€${PLUS.year / 12}`, per: `per month, billed yearly as €${PLUS.year}` }, eur: PLUS, lede: "For people who follow a lot, and keep a lot.", has: { sources: "1,000", collections: "Unlimited", sharing: "yes" }, cta: "Start with Plus" },
  pro: { name: "Pro", price: `€${PRO.month}`, per: "per month, billed monthly", yearly: { price: `€${PRO.year / 12}`, per: `per month, billed yearly as €${PRO.year}` }, eur: PRO, lede: "For busy feeds you want curated for you.", has: { sources: "5,000", collections: "Unlimited", sharing: "yes", smart: "yes" }, cta: "Start with Pro" },
};

/** What every hosted plan includes, shown once under the cards. */
export const ALWAYS = ["Every view, baskets and search", "Export everything, any time", "Cancel any time", "No ads", "No engagement algorithm: your order, your rules", "No AI you didn't ask for", "Fingerprint, face or password sign-in", "Install as an app; read the text offline", "Prices include VAT"];

const price = (p: Price, cls = "") => `<p class="s-price ${cls}"><b>${p.price}</b><span>${p.per}</span></p>`;

/** Yearly or monthly billing for the plan cards and the comparison table; CSS shows the matching prices, so it works without scripts. */
export function billingToggle(): string {
  const opt = (id: string, label: string, checked = false) => `<input type="radio" name="billing" id="${id}" class="sr"${checked ? " checked" : ""}><label for="${id}">${label}</label>`;
  return `<div class="s-bill-row"><fieldset class="s-bill"><legend class="sr">Billing</legend>${opt("bill-year", `Yearly <span class="s-save">save ${Math.round(100 - (100 * PLUS.year) / (12 * PLUS.month))}%</span>`, true)}${opt("bill-month", "Monthly")}</fieldset>${currencyPicker()}</div>`;
}

export function planCard(site: Site, p: (typeof PLANS)[keyof typeof PLANS], opts: { featured?: boolean; badge?: string } = {}): string {
  return `<article class="s-plan ${opts.featured ? "featured" : ""}">${opts.badge ? `<span class="s-badge">${opts.badge}</span>` : ""}
<h3>${p.name}</h3>${p.yearly && p.eur ? price(p.yearly, "bill-y") + price(p, "bill-m") + `<p class="s-fx bill-y">${money({ amount: p.eur.year / 12, cur: "EUR" }, " a month, charged in euros", true)}</p><p class="s-fx bill-m">${money({ amount: p.eur.month, cur: "EUR" }, " a month, charged in euros", true)}</p>` : price(p)}<p class="s-lede">${p.lede}</p>
<ul>${PLAN_ROWS.map((r) => {
    const v = p.has[r.key];
    const text = r.label(v ?? "");
    return v ? `<li>${ic("check")}${text}</li>` : `<li class="no">${ic("minus")}<span><span class="sr">Not included: </span>${text}</span></li>`;
  }).join("")}</ul>
<a href="${links(site).signUp}" class="btn lg ${opts.featured ? "primary" : ""}">${p.cta}</a></article>`;
}

/**
 * Competitor rows: list prices shown to EU visitors in November 2026, per billing period, in the currency each lists.
 * Feedly offers Pro+ only billed annually (€12.18 a month, before a first-year discount). Check again before changing
 * the footnote's date.
 */
const RIVALS: { n: string; self: string; year: Money; month: Money; tier: string; plus?: Money; free: string }[] = [
  { n: "Feedly", self: "No", year: { amount: 6.99, cur: "EUR" }, month: { amount: 8.99, cur: "EUR" }, tier: "Pro", plus: { amount: 12.18, cur: "EUR" }, free: "100 feeds · 3 folders" },
  { n: "Inoreader", self: "No", year: { amount: 6.67, cur: "EUR" }, month: { amount: 8.99, cur: "EUR" }, tier: "Pro", free: "150 feeds" },
  { n: "Readwise Reader", self: "No", year: { amount: 9.99, cur: "USD" }, month: { amount: 12.99, cur: "USD" }, tier: "Full Readwise", free: "None; 30-day trial" },
  { n: "Instapaper", self: "No", year: { amount: 5, cur: "USD" }, month: { amount: 5.99, cur: "USD" }, tier: "Premium; read later only, no feeds", free: "Saving and reading; 5 notes a month" },
];

/** A price the visitor's currency script can rewrite; `approx` prices are ours, shown converted only outside the euro. */
const money = (m: Money, suffix = "", approx = false) =>
  `<span data-money="${m.amount} ${m.cur}"${approx ? " data-approx" : ""}${suffix ? ` data-suffix="${suffix}"` : ""}>${approx ? "" : show(m, "EUR") + suffix}</span>`;

const OURS = { year: { amount: PLUS.year / 12, cur: "EUR" }, month: { amount: PLUS.month, cur: "EUR" } } as const;

/** Show prices in another currency; hidden until the script runs, since only the script can convert. */
export function currencyPicker(): string {
  return `<div class="s-cur" hidden><label for="currency">Show prices in</label><select id="currency">${CURRENCIES.map((c) => `<option value="${c}">${currencyName(c)}</option>`).join("")}</select></div>`;
}

export function compareTable(): string {
  const cell = (label: string, v: string, cls = "") => `<td data-l="${label}"${cls ? ` class="${cls}"` : ""}><span>${v}</span></td>`;
  const head = (period: string) => `Paid plan, billed ${period}`;
  const period = (k: "year" | "month") => `<th scope="col" class="bill-${k[0]}">${head(k === "year" ? "yearly" : "monthly")}</th>`;
  const us = (k: "year" | "month") => cell(head(k === "year" ? "yearly" : "monthly"), `<b>€${OURS[k].amount} / month</b><small>${money(OURS[k], " / month · ", true)}${k === "year" ? `€${PLUS.year} a year · ` : ""}Plus: 1,000 sources · unlimited collections</small>`, `bill-${k[0]}`);
  const them = (r: (typeof RIVALS)[number], k: "year" | "month") => cell(head(k === "year" ? "yearly" : "monthly"), `<b>${money(r[k], " / month")}</b><small>${r.tier}${k === "year" && r.plus ? `; Pro+ ${money(r.plus)}` : ""}</small>`, `bill-${k[0]}`);
  return `<div class="s-compare"><table><thead><tr><th scope="col"><span class="sr">Product</span></th><th scope="col">Host it yourself</th>${period("year")}${period("month")}<th scope="col">Free tier</th></tr></thead><tbody>
<tr class="s-us"><th scope="row">PURSS</th>${cell("Host it yourself", `${ic("check")}Yes, free and unlimited`)}${us("year")}${us("month")}${cell("Free tier", "Self-hosted: unlimited.<br>Hosted: 100&nbsp;sources · 4&nbsp;collections")}</tr>
${RIVALS.map((r) => `<tr><th scope="row">${r.n}</th>${cell("Host it yourself", r.self)}${them(r, "year")}${them(r, "month")}${cell("Free tier", r.free)}</tr>`).join("")}
</tbody></table></div><p class="fine s-src">We charge in euros, including VAT. Competitor prices as listed in the EU in November 2026: Feedly and Inoreader in euros, Readwise and Instapaper in US dollars. Amounts marked ≈ are converted at the European Central Bank rate of ${ECB.label}; local prices and taxes can differ. Sources: <a class="link" href="https://feedly.com/i/pro">Feedly</a>, <a class="link" href="https://www.inoreader.com/pricing">Inoreader</a>, <a class="link" href="https://readwise.io/pricing">Readwise</a>, <a class="link" href="https://www.instapaper.com/premium">Instapaper</a>, <a class="link" href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html">ECB</a>.</p>`;
}

// ---------- Apps and extensions ----------

/** Store buttons for the stores the app is listed in. Addresses: @purss/domain/distribution. */
function getIt(what: Distributed): string {
  const stores = publishedStores(what);
  return stores.length ? `<span class="a-stores">${stores.map((s) => `<a class="btn" href="${s.url}">${s.name}</a>`).join("")}</span>` : "";
}

/** For developers: the apps can already be built from the source code. Shown with the install commands in the self-hosting section. */
const developerLinks = () => `<p class="fine a-dev">Developers: <a class="link" href="${DISTRIBUTION.mobile.install}">build the phone app</a> or <a class="link" href="${DISTRIBUTION.extension.install}">load the browser extension</a> from the source.</p>`;

/**
 * The desktop app's download (plan/42): one button, which a few lines of script (main.ts, pickDesktopDownload) point
 * at the visitor's system's file, and one link to the release page with every system's files. Without the script, or
 * on a system it doesn't know, the button opens the release page.
 */
function getDesktop(site: Site): string {
  const url = (file: string) => `${site.repo}/releases/latest/download/${file}`;
  const first = (os: Exclude<DesktopOs, "android">) => url(DESKTOP_DOWNLOADS.find((p) => p.os === os)!.file);
  const releases = `${site.repo}/releases/latest`;
  return `<div class="a-desktop"><a class="btn primary" data-desktop-main href="${releases}" data-windows="${first("windows")}" data-macos="${first("macos")}" data-linux="${first("linux")}" data-android="${url(ANDROID_APK)}">Download</a>`
    + `<a class="link fine" data-desktop-other hidden href="${releases}">Other systems</a></div>`;
}

const APPS = (site: Site) => [
  ["ext", "Browser extension", `Found something good? Keep it or follow its site without leaving the page. For ${DISTRIBUTION.extension.platforms}.`, () => getIt("extension")],
  ["phone", "Phone and tablet", `Catch up in the queue or on the plane. The ${DISTRIBUTION.mobile.platforms} app plays with the screen off, keeps downloads for offline and takes links shared from any app.`, () => `<span class="a-stores">${getIt("mobile")}<a class="btn" href="${site.repo}/releases/latest/download/${ANDROID_APK}">Download for Android</a></span>`],
  ["laptop", "Windows, Mac and Linux", "Close the window and it keeps working: alerts and downloads carry on from the tray, and it updates itself.", () => getDesktop(site)],
  ["bookmark", "Bookmarklets", "Can't install anything? Two bookmarks send any page to PURSS, in any browser.", () => ""],
  ["key", "Your assistant, if you want one", "Ask Claude, ChatGPT or another assistant you already use what you've read about something, and let it tidy up if you allow. Connects through MCP; off until you turn it on.", () => ""],
  ["page", "E-ink display", "Long reads are easier on the eyes on an e-reader: black on white, page buttons instead of scrolling.", () => ""],
  ["window", "Install it as an app", "No app store needed: add it from your browser and your reading list works offline.", () => ""],
] as const;

export function appCards(site: Site): string {
  return APPS(site).map(([i, t, p, get]) => `<div class="s-feat"><span class="s-ico">${ic(i, "lg")}</span><h3 class="s-h3">${t}</h3><p>${p}</p>${get()}</div>`).join("");
}

const steps = (site: Site) => [
  // The repository address may break after its last slash, or anywhere on the narrowest screens.
  { t: "Get the code", c: `git clone <span class="url">${links(site).clone.replace(/\/(?=[^/]*$)/, "/<wbr>")}</span> purss\ncd purss` },
  { t: "Settings (empty is fine for one machine)", c: "touch .env" },
  { t: "Start", c: 'docker compose <span class="nw">--env-file .env</span> \\\n<span class="ind">    </span><span class="nw">-f infra/compose.yaml</span> <span class="nw">up -d --build</span>' },
];

/** The install commands as a terminal, with the developer links under it. */
export function terminal(site: Site): string {
  // Each command is its own block with a hanging indent, so wrapped lines never look like new commands.
  const cmds = (c: string) => c.split(/\n(?!<span class="ind">)/).map((cmd) => `<span class="cmd"><span class="p">$</span> ${cmd}</span>`).join("");
  return `<div class="s-term"><div class="s-term-h" aria-hidden="true"><i></i><i></i><i></i><span>your-server</span></div>
<pre tabindex="0" aria-label="Install commands" class="s-pre">${steps(site).map((s) => `<span class="c"># ${s.t}</span>${cmds(s.c)}`).join("")}<span class="ok">✔ PURSS running on http://localhost:8940</span></pre></div>${developerLinks()}`;
}

type Answer = string | ((site: Site) => string);
const FAQ: readonly (readonly [string, Answer])[] = [
  ["What can I follow?", "Anything with a feed: blogs, news sites, journals, newsletters with a feed, YouTube channels, podcasts, and the public posts of Mastodon and Bluesky accounts. Paste a link or a handle and PURSS finds the feed and shows you a preview before you follow."],
  ["Can I follow sites in other languages, including Arabic?", "Yes. Sources in any language or script work, and right-to-left text such as Arabic reads the right way round, even in a list next to English titles. Nothing is translated or changed. PURSS's own menus and buttons are in English for now."],
  ["Is self-hosting really the full product?", "Yes. It's the same app with no limits unless you set them. The hosted plans exist for people who'd rather not run a server."],
  ["What happens if I stop paying?", "Plus and Pro are billed yearly or monthly, as you choose, and you can cancel any time. Your plan runs to the end of the year or month you paid for, then your account moves to the Free limits. Nothing is deleted automatically to fit the free plan. You keep reading and exporting everything; new items pause until you're back under the free limits or renew."],
  ["What are Smart filters?", "An optional filter for a source or collection that floods your lists. You describe which posts you want (\"keep posts about food, travel and gardening\", \"drop job ads\"), try it on the latest 20 posts, then turn it on. Jev, an AI model by TypeSafe AI that answers yes or no, judges each new post, and the ones it drops are marked Ignored: nothing is deleted, and a post you move back stays where you put it. Only a post's title, summary, author and source name are sent to be judged, never your reading, notes or account. Smart filters are included in the Pro plan. They are off until you set one up."],
  ["Why not just run FreshRSS?", "FreshRSS does the fetching here too, and it's excellent at it. PURSS adds the parts people actually live in: guided Add source with YouTube, podcast, Mastodon and Bluesky discovery, collections, baskets with kept copies, five views, workflow with undo, highlights and notes, a podcast player, search, fingerprint and face sign-in, backups and invitations, plus a browser extension and phone apps. You never touch FreshRSS settings."],
  ["How does Discovery work?", "Discovery is coming soon to the hosted service. It suggests sources you don't follow yet, from what other readers who follow your sources also follow, and says which of your sources led to each one, with a few chance picks for variety. It's an exchange: your followed sources count, without your name, and only readers who share get suggestions. A source counts only once at least 10 readers follow it, nobody sees who follows what or how many do, private sources never count, and suggestions never appear in your lists. Switch it off in Settings any time. A PURSS you host yourself has no Discovery."],
  ["Who can see my data on the hosted plans?", "Your PURSS is private to your account; other users never see it. The admin tools we use to run the service show health, jobs and storage use, not your items or reading history; the only content they show is a shared page you published that someone reported. We don't sell your data or show ads, and you can export everything at any time. The hosted service is run by program-sam on a server it manages."],
  ["Who runs the hosted service?", 'program-sam, the name behind the open-source code, runs it on a server it manages; how to reach program-sam is on the <a class="link" href="/legal.html">legal notice</a>. You aren\'t locked in: every plan exports everything, and the same software runs on your own server. If the hosted service ever closed, the terms promise notice well in advance and time to export.'],
  ["Does a basket save the whole web page?", "A basket keeps the item's details and summary, and can keep a readable text copy; with the browser extension, also the text as your browser shows it. Videos and episodes stay with their publisher; the phone app can download an episode to your device. None of that keeps the original page, video or episode online."],
  ["Does a basket keep pictures?", "Yes, when the basket keeps a readable text copy: it then keeps the item's main picture and the pictures inside the text with it, so a recipe or a comic keeps its images. Items you only follow, without keeping them, still load their pictures from the publisher. Videos and episodes stay with their publisher."],
  ["Can I be reminded about something I kept?", "Yes. Choose Remind me on a kept item, pick a date and add a note if you like. On that day the bell tells you, and so does an email where the PURSS sends email, and Home shows what's coming up in the next 7 days. It's meant for things like an exhibition or a deadline."],
  ["Can I share something with other people?", "Yes. Copy link on an item copies the original page's address, so you can send it to anyone and they need no account. A separate Copy link to this item in your PURSS opens it for you after you sign in. You can also share a whole basket or collection with Share on its page: it becomes a public page and feed that anyone can read without an account and follow from their own PURSS or any feed reader, and it keeps showing what you add. You can add a public note to any item on it. Before anything is shared you see the page and what of yours becomes public; it never shows your reading, private notes, highlights or saved text. Sharing is part of Plus and Pro, and included when you host PURSS yourself."],
  ["Can readers of my blog follow it here?", "Yes. In Settings → Connected apps, paste your blog's feed address to get a Follow button for your pages. Readers who press it can follow you in their PURSS, or copy the feed into any other reader. The button is a plain link: no script, no tracking."],
  ["What works without a connection?", "In the installed app, your reading list is saved on the device: your To read and In progress items, recent new ones, and kept items with saved text. You can read them, mark them and write highlights and notes; changes are sent when you're back online. Adding sources, search, settings and anything not saved need a connection, and so can pictures. The phone app can also download an episode to your device for listening offline."],
  ["Is there a phone app or a browser extension?", "Both are on the way to the stores. The Android app can already be downloaded from this page; the extension for Chrome, Edge and Firefox isn't in the browser stores yet. On an iPhone or iPad, add PURSS to your home screen from your browser: it opens like an app and keeps your reading list for offline. Bookmarklets work in any browser with nothing to install. If you're technical, you can already build both from the source code."],
  ["Can I sign in on a borrowed or shared computer?", "Yes. Fingerprint, face or screen lock is the quickest way in on your own devices, but you can also sign in with a username and password on any computer. On a library, work or borrowed computer, choose This is a shared computer on the sign-in page: the session ends when the browser closes, and after eight hours at the latest, and offline copies stay off in an ordinary browser tab. Two people on one laptop each use their own account."],
  ["Is it accessible?", (site) => `We build the website and the app for keyboard use and screen readers: named controls, visible focus, keyboard shortcuts in the app, a skip link on the website, and text that still fits when enlarged. We have checked them with the keyboard alone, with the browser's accessibility tree and with enlarged text, and we fix what that finds. We have not had an independent audit or tested with a panel of people who use assistive technology, so there will be gaps. If something doesn't work for you, <a class="link" href="${links(site).source}/issues">open an issue</a> or reach program-sam through the <a class="link" href="/legal.html">legal notice</a>, and say what you were doing and what you use. We treat it as a bug.`],
  ["Does it use AI?", "Not unless you ask it to. There's no built-in AI. If you want, you can connect your own assistant, such as Claude or ChatGPT, to search and read your PURSS, and organise it if you allow. It's off until you turn it on, and you can disconnect it at any time."],
  ["Can I move between hosted and self-hosted?", "Yes. Export your PURSS from one and import it into the other. Coming from Feedly, Inoreader or another reader? Import its OPML file (the export file most readers offer) and your sources come with you."],
] as const;

export function faq(site: Site): string {
  return `<div class="s-faq">${FAQ.map(([q, a]) => `<details><summary>${q}${ic("chev")}</summary><p>${typeof a === "function" ? a(site) : a}</p></details>`).join("")}</div>`;
}

export function footer(site: Site): string {
  return `<footer class="s-foot"><div class="s-wrap s-foot-in">${brand()}<nav aria-label="Footer"><a href="/#features">Features</a><a href="/#apps">Apps and extensions</a><a href="/#pricing">Pricing</a><a href="/#self-host">Host it yourself</a><a href="${links(site).docs}">Docs</a><a href="${links(site).source}">Source code</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/legal.html">Legal notice</a></nav><span class="fine">Run by <a class="link" href="https://github.com/program-sam">program-sam</a>. Built on the <a class="link" href="https://freshrss.org">FreshRSS</a> engine. No trackers on this site.</span></div></footer>`;
}

export function nav(site: Site, base = "", cta = "Create a free account", short = "Start free"): string {
  const to = links(site);
  const items = `<a href="${base}#why">Why</a><a href="${base}#features">Features</a><a href="${base}#apps">Apps</a><a href="${base}#pricing">Pricing</a><a href="${base}#self-host">Host it yourself</a><a href="${to.docs}">Docs</a>`;
  return `<header class="s-nav"><div class="s-wrap s-nav-in"><a class="s-home" href="/">${brand()}</a><nav aria-label="Main">${items}</nav><span class="s-nav-cta"><a class="btn ghost" href="${to.dashboard}">Open dashboard</a><a class="btn primary" href="${to.signUp}"><span class="s-long">${cta}</span><span class="s-short">${short}</span></a>
<details class="s-menu"><summary class="ibtn" aria-label="Menu"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></summary><nav aria-label="Main, small screens">${items}<a href="${to.dashboard}">Open dashboard</a></nav></details></span></div></header>`;
}
