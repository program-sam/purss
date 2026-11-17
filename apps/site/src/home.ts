import { ALWAYS, PLANS, appCards, billingToggle, compareTable, faq, av, footer, ic, planCard, quilt, sidebar, terminal } from "./kit.ts";
import { COMPARISON_CSS, comparison } from "./compare.ts";
import { links, type Site } from "./site.ts";

// The public home page: one feed and one switch. Off, it is the feed everyone knows, with ads and suggestions between the few posts
// you follow. On, everything you didn't choose slides out, the posts you chose stay on screen and shrink into the boxes of a PURSS
// Home that forms around them. The page is rendered with the switch on, so it reads the same with scripts off or reduced motion.

const PITCH = "You used to choose what you read. Then feeds started choosing for you, ranked to keep you scrolling. PURSS hands the choice back: you decide what comes in, in what order, and what's worth keeping.";

const FEATURES = [
  { k: "Follow", icon: "plus", h: "Nothing from the people you follow gets buried.", p: "Subscribing on YouTube or following someone on Bluesky doesn't mean you'll see what they post. Here it does: paste a link, and new posts arrive, unranked, until you say stop." },
  { k: "Keep", icon: "basket", h: "Find it again in six months.", p: "Drop it in a basket for the project, the trip or the rainy Sunday, and its details, summary and, if you ask, a readable copy of the text stay with you." },
  { k: "Read", icon: "book", h: "Start on the laptop, finish on the train.", p: "Your place, your highlights and your notes follow you to every device, so nothing you started gets lost." },
  { k: "Share", icon: "share", h: "You're the one people ask for good links.", p: "Share a basket or collection as a page anyone can open. Anyone who follows it gets each new pick as you add it." },
] as const;

const HOST_POINTS = ["Every feature, free forever", "Runs on a spare computer, in about 1&nbsp;GB of memory", "Backups and invitations for family and friends built in", "Open source, AGPL-3.0"];

type Mine = { l: string; h: number; t: string; src: string; when: string; box: number; fresh?: true };
type Junk = { tag: string; t: string; sub: string; c: string };
const MINE: Mine[] = [
  { l: "MG", h: 210, t: "Council approves the Mill Road cycle path", src: "Millbrook Gazette", when: "12 min ago", box: 0, fresh: true },
  { l: "MB", h: 18, t: "Restoring a 1970s hand plane", src: "Maker Bench", when: "1 h ago · 24:10", box: 1 },
  { l: "NS", h: 280, t: "Ep. 112: Small libraries", src: "Night Shift Radio", when: "3 h ago · 58 min", box: 1 },
  { l: "SL", h: 228, t: "The night sky is getting brighter", src: "Slow Light Journal", when: "Today · 9 min read", box: 2, fresh: true },
  { l: "KT", h: 12, t: "Slow-roast tomato sauce that keeps all week", src: "Kitchen Table", when: "Yesterday", box: 3 },
];
const JUNK: Junk[] = [
  { tag: "Sponsored", t: "The mattress 4 million sleepers can't stop talking about", sub: "Shop now", c: "#e58a34" },
  { tag: "Suggested for you", t: "A stranger is extremely angry about something", sub: "Because you paused on a post like this", c: "#cc5a8c" },
  { tag: "Trending", t: "Everyone is arguing about this today", sub: "48.2K posts", c: "#d0584d" },
  { tag: "People you may know", t: "Someone you met once in 2014", sub: "Follow back", c: "#8a70cc" },
];
/** The feed's order: a junk card, a post you chose, and so on. */
const ORDER: ({ mine: number } | { junk: number })[] = [{ junk: 0 }, { mine: 0 }, { junk: 1 }, { mine: 1 }, { junk: 2 }, { mine: 2 }, { junk: 3 }, { mine: 3 }, { mine: 4 }];
const BOXES = [
  { title: "Local", stack: [["MG", 210]] },
  { title: "Watch & listen", stack: [["MB", 18], ["NS", 280]] },
  { title: "Slow reads", stack: [["SL", 228]] },
  { title: "Recipes", stack: [["KT", 12]] },
] as const;

const css = `
.pf{position:relative;--k:0;--t:1.7;background:#e4e4e8;transition:background calc(.9s*var(--t))}
.pf[data-on="1"]{--k:1;background:var(--bg)}
.pf-sky{position:absolute;inset:0 0 auto 0;height:1000px;pointer-events:none;opacity:0;transition:opacity calc(.9s*var(--t));background:linear-gradient(180deg,var(--sky-top) 0,var(--sky-mid) 50%,var(--bg) 100%)}
.pf[data-on="1"] .pf-sky{opacity:1}
.pf-sky svg.quilt{position:absolute;inset:0;width:100%;height:100%;-webkit-mask-image:linear-gradient(#000 40%,transparent);mask-image:linear-gradient(#000 40%,transparent)}
.pf-sky .quilt path{stroke-width:2.2;stroke-dasharray:9 7}
.pf-nav{position:relative;display:flex;align-items:center;gap:24px;max-width:1180px;margin:0 auto;padding:16px 28px;font-weight:800;font-size:14.5px}
.pf-nav b{display:inline-flex;align-items:center;gap:8px;font-size:17px;font-weight:900;color:hsl(var(--h) 85% 32%)}
.pf-nav b .ic{width:22px;height:22px}
.pf-nav a{color:var(--ink-2)}
.pf-nav span{margin-left:auto;display:flex;gap:10px;align-items:center}
.pf-hero{position:relative;max-width:1180px;margin:0 auto;padding:28px 28px 70px;display:grid;grid-template-columns:minmax(0,370px) minmax(0,1fr);gap:40px;align-items:center;min-height:calc(100vh - 70px)}
.pf-h1{font-size:clamp(36px,3.9vw,54px);font-weight:900;letter-spacing:-.04em;line-height:1;text-wrap:balance}
.pf-lead{margin-top:18px;max-width:46ch;font-size:19.5px;font-weight:600;line-height:1.5;color:var(--ink-2)}
.pf-sw{display:flex;align-items:center;gap:12px;margin-top:28px;font-weight:900;font-size:15.5px;white-space:nowrap}
.pf-sw label{cursor:pointer;color:var(--ink-3);transition:color calc(.4s*var(--t))}
.pf[data-on="0"] .pf-sw .l0,.pf[data-on="1"] .pf-sw .l1{color:var(--ink)}
.pf-toggle{all:unset;cursor:pointer;position:relative;flex:none;width:128px;height:60px;border-radius:999px;background:linear-gradient(#8d8f99,#b9bbc4);border:1px solid #6d6f79;box-shadow:inset 0 5px 10px rgba(0,0,0,.4),0 1px 0 rgba(255,255,255,.9),0 0 0 6px rgba(255,255,255,.4);transition:background calc(.5s*var(--t)),border-color calc(.5s*var(--t))}
.pf[data-on="1"] .pf-toggle{background:linear-gradient(hsl(var(--h) 85% 36%),hsl(var(--h) 88% 58%));border-color:hsl(var(--h) 80% 26%)}
.pf-toggle:focus-visible{outline:3px solid var(--focus);outline-offset:6px}
.pf-toggle i{position:absolute;left:5px;top:5px;width:48px;height:48px;border-radius:50%;background:linear-gradient(#fff,#dcdfe8);border:1px solid rgba(0,0,0,.25);box-shadow:inset 0 2px 0 #fff,inset 0 -10px 14px rgba(0,20,60,.12),0 6px 12px rgba(0,0,0,.35);transition:translate calc(.55s*var(--t)) cubic-bezier(.3,1.5,.5,1);display:grid;place-items:center;color:#8d8f99}
.pf[data-on="1"] .pf-toggle i{translate:68px 0;color:hsl(var(--h) 85% 40%)}
.pf-toggle .ic{width:26px;height:26px}
.pf-points{display:grid;gap:12px;margin-top:26px;font-weight:900;font-size:16.5px}
.pf-points li{display:flex;gap:12px;align-items:flex-start}
.pf-points .pt{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;background:linear-gradient(hsl(var(--h) 85% 56%),hsl(var(--h) 85% 38%));box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 2px 5px hsl(var(--h) 70% 25% / .3)}
.pf-points .pt .ic{width:15px;height:15px;stroke-width:3.2}
.pf-points small{display:block;font-weight:700;font-size:14px;color:var(--ink-2)}
.pf-hero .s-cta{margin-top:26px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pf-hero .s-cta .btn{width:100%;justify-content:center;padding:0 10px}

.pf-stage{position:relative;height:min(680px,calc(100vh - 120px));min-height:540px}
.pf-win{height:100%;display:flex;flex-direction:column;box-shadow:0 0 0 6px rgba(255,255,255,.45),0 30px 70px hsl(var(--h) 60% 20% / .25);background:var(--surface);transition:background calc(.8s*var(--t)),border-color calc(.8s*var(--t)),box-shadow calc(.8s*var(--t))}
.pf[data-on="0"] .pf-win{background:#f1f1f4;border-color:#c9c9d0;box-shadow:0 24px 60px rgba(20,20,40,.25)}
.pf-win .s-chrome{position:relative;transition:background calc(.8s*var(--t))}
.pf[data-on="0"] .pf-win .s-chrome{background:#e6e6ea}
.pf-win .s-chrome span{position:absolute;left:50%;top:50%;translate:-50% -50%;margin:0;transition:opacity calc(.25s*var(--t))}
.pf-win .u0,.pf[data-on="0"] .pf-win .u1{opacity:0}
.pf[data-on="0"] .pf-win .u0{opacity:1;transition-delay:calc(.12s*var(--t))}
.pf[data-on="1"] .pf-win .u1{transition-delay:calc(.12s*var(--t))}
.pf-bar{position:relative;display:flex;align-items:center;height:50px;flex:none;padding:0 18px;background:#fff;border-bottom:1px solid var(--line);font-weight:900;font-size:16px;transition:padding-left calc(.8s*var(--t)) cubic-bezier(.2,.9,.3,1)}
.pf[data-on="1"] .pf-bar{padding-left:206px;transition-delay:calc(.2s*var(--t))}
.pf-bar .l{position:relative;flex:1;height:100%}
.pf-bar .l span{position:absolute;left:0;top:0;height:100%;display:flex;align-items:center;transition:opacity calc(.25s*var(--t)),translate calc(.5s*var(--t)) cubic-bezier(.2,.9,.3,1)}
.pf-bar .t1,.pf[data-on="1"] .pf-bar .t0{opacity:0;translate:0 12px}
.pf[data-on="1"] .pf-bar .t1{opacity:1;translate:0 0;transition-delay:calc(.12s*var(--t))}
.pf[data-on="0"] .pf-bar .t0{opacity:1;translate:0 0;transition-delay:calc(.12s*var(--t))}
.pf[data-on="0"] .pf-bar .t1{opacity:0;translate:0 12px}
.pf-bar .t0{translate:0 0}
.pf-bar .r{position:relative;width:76px;height:100%}
.pf-bar .r>*{position:absolute;right:0;top:50%;transition:opacity calc(.25s*var(--t)),translate calc(.5s*var(--t)) cubic-bezier(.2,.9,.3,1)}
.pf-bar .bell{translate:0 -50%;color:#777}
.pf-bar .bell::after{content:"99+";position:absolute;right:-8px;top:-9px;padding:1px 5px;border-radius:999px;background:#dc4a3e;color:#fff;font-size:10.5px;font-weight:900}
.pf-bar .vw{translate:0 -30%;opacity:0;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:10px;border:1px solid var(--line-2);background:#fff;font-size:13px;font-weight:800;white-space:nowrap}
.pf-bar .vw .ic{width:14px;height:14px}
.pf[data-on="1"] .pf-bar .vw{opacity:1;translate:0 -50%;transition-delay:calc(.12s*var(--t))}
.pf[data-on="0"] .pf-bar .bell{transition-delay:calc(.12s*var(--t))}
.pf[data-on="1"] .pf-bar .bell{opacity:0;translate:0 -20%}
.pf-main{position:relative;flex:1;min-height:0;overflow:hidden}
.pf-main>.s-side{position:absolute;left:0;top:0;bottom:0;width:190px;z-index:3}
.pf-win .mcol+.mcol{display:grid!important}
.pf[data-on="0"] .pf-main>.s-side{translate:-100% 0}
.pf-content{position:relative;height:100%;overflow:hidden}
.pf[data-on="1"] .pf-content{padding-left:190px}
.pf-list{padding:10px 12px;display:grid}
.pf[data-on="1"] .pf-list{display:none}
.pf[data-on="0"] .pf-wash,.pf[data-on="0"] .pf-boxes{display:none}
.pf-wash.leaving,.pf-boxes.leaving{display:block!important;position:absolute;pointer-events:none}
.pf-wash.leaving{margin-left:0}
.pf-wash .homewash{margin:0}
@media (min-width:1201px){.pf-wash{margin-left:-190px}.pf-wash .homewash .col{padding-left:218px}}
.pf-boxes{padding-top:2px}
.pf-box .mod-t{display:flex;align-items:center;gap:8px;min-width:0}
.pf-box .mod-t .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pf-box .mod-fresh{margin-left:8px;flex:none}
.pf-ghosts{position:absolute;inset:0;pointer-events:none;z-index:1}
.pf-stage.fly .pf-box,.pf-stage.fly .pf-box .mod-b{overflow:visible!important}
.pf-ghosts>*{position:absolute;margin:0!important}
.pf-slot{margin-bottom:8px}
.pf[data-on="1"] .pf-slot{margin-bottom:0}
.pf-m{margin:0!important}
.pf-c,.pf-m{box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center;padding:9px 12px;margin-bottom:8px;border-radius:13px;background:#fff;border:1px solid #dcdce2;overflow:hidden}
.pf-c b,.pf-m b{display:block;font-weight:800;font-size:14.5px;line-height:1.25;color:var(--ink)}
.pf-c small,.pf-m small{display:block;margin-top:2px;font-weight:700;font-size:12.5px;color:var(--ink-3)}
.pf-c.junk{background:color-mix(in srgb,var(--c) 11%,#fff);border:2px solid var(--c);padding:8px 11px}
.pf-c.junk .th{width:40px;height:40px;border-radius:9px;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--c) 60%,#fff) 0 8px,color-mix(in srgb,var(--c) 36%,#fff) 8px 16px)}
.pf-c.junk small{color:#3a3a42}
.pf-c.junk small em{font-style:normal;font-weight:900;color:#fff;background:var(--c);padding:1px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em;font-size:10.5px;margin-right:7px}
.pf-m .av{--s:34px;width:var(--s);height:var(--s)}
.pf-m .fd{display:inline-block;width:0;height:7px;border-radius:50%;background:var(--fresh);margin-right:0;vertical-align:2px;opacity:0;transition:width calc(.5s*var(--t)) calc(.5s*var(--t)),margin calc(.5s*var(--t)) calc(.5s*var(--t)),opacity calc(.5s*var(--t)) calc(.5s*var(--t))}
.pf-m{transition:filter calc(.6s*var(--t))}
.pf[data-on="0"] .pf-m{filter:saturate(.45)}
.pf[data-on="1"] .pf-m{margin:0;border-radius:0;border-color:transparent;border-bottom-color:var(--line);background:transparent;padding:10px 12px;filter:none}
.pf[data-on="1"] .pf-m .av{--s:26px}
.pf[data-on="1"] .pf-m b{font-size:14.5px}
.pf[data-on="1"] .pf-m .fd{width:7px;margin-right:7px;opacity:1}
.pf[data-on="1"] .pf-box .mod-b .pf-slot:last-child .pf-m{border-bottom-color:transparent}
.pf-more{position:absolute;left:0;right:0;bottom:0;text-align:center;font-weight:800;pointer-events:none;padding:70px 0 16px;background:linear-gradient(transparent,#f1f1f4 60%);color:#777;font-size:14px;transition:opacity calc(.4s*var(--t)) calc(.7s*var(--t))}
.pf[data-on="1"] .pf-more{opacity:0;transition-delay:0s}
.pf-more i{display:inline-block;width:14px;height:14px;margin-right:8px;border-radius:50%;border:2.5px solid #bbb;border-top-color:#666;vertical-align:-2px;animation:pf-spin .8s linear infinite}
@keyframes pf-spin{to{rotate:360deg}}
@media (prefers-reduced-motion:reduce){.pf *,.pf{transition:none!important;animation:none!important}}

.pf-sec{position:relative;max-width:1120px;margin:0 auto;padding:72px 24px 0}
.pf-sec#features{padding-bottom:84px}
.pf-h2{font-size:clamp(30px,3.6vw,46px);font-weight:900;letter-spacing:-.03em;line-height:1.06;text-wrap:balance;text-align:center}
.pf-p{margin:14px auto 0;max-width:60ch;text-align:center;font-size:19px;font-weight:600;color:var(--ink-2)}
.pf-feats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:38px}
.pf-feats .mod-t{display:flex;align-items:center;gap:8px;padding-left:6px}
.pf-feats .mod-b{padding:14px 16px 18px;display:grid;gap:8px}
.pf-feats h3{font-size:18px;font-weight:900;line-height:1.2;letter-spacing:-.01em}
.pf-feats p{font-size:14.5px;font-weight:600;color:var(--ink-2)}
.pf-host{display:grid;grid-template-columns:1fr 1.15fr;gap:36px;align-items:center}
.pf-host .pf-h2,.pf-host .pf-p{text-align:left;margin-left:0}
.pf-why{margin-top:0}
.pf-pts{display:grid;gap:10px;margin-top:18px;font-weight:700;font-size:16.5px}
.pf-pts li{display:flex;gap:10px}
.pf-pts .ic{flex:none;margin-top:5px;stroke-width:3;color:var(--ok)}
.pf-end{padding:80px 24px 90px;text-align:center}
.pf-end .s-cta{justify-content:center}
@media (max-width:1200px){.pf-nav a:not(.btn){display:none}.pf-hero{grid-template-columns:minmax(0,1fr);gap:28px;padding-top:8px}.pf-stage{height:520px}.pf-feats{grid-template-columns:1fr 1fr}.pf-host{grid-template-columns:minmax(0,1fr)}.pf-hero>div:first-child{display:contents}.pf-h1{order:1}.pf-lead{order:2;margin-top:0}.pf-sw{order:3;margin-top:0;font-size:14px;gap:10px}.pf-sw label{flex:1}.pf-sw .l0{text-align:right}.pf-stage{order:4;height:540px;min-height:0}.pf-points{order:5;margin-top:0}.pf[data-on="1"] .pf-content{padding-left:0}.pf-main>.s-side{display:none}.pf[data-on="1"] .pf-bar{padding-left:18px}.pf-hero .s-cta{order:6;margin-top:0;grid-template-columns:minmax(0,1fr)}.pf-hero{gap:18px;min-height:0;padding-bottom:40px}.pf-sw{white-space:normal}.pf-toggle{width:112px;height:54px}.pf-toggle i{width:42px;height:42px}.pf[data-on="1"] .pf-toggle i{translate:58px 0}}
@media (min-width:1600px){.pf-nav,.pf-hero{max-width:1640px}.pf-hero{grid-template-columns:minmax(0,480px) minmax(0,1fr);gap:64px}.pf-h1{font-size:clamp(54px,3.7vw,76px)}.pf-lead{font-size:22px}.pf-points{font-size:19px}.pf-points small{font-size:15.5px}.pf-stage{height:min(840px,calc(100vh - 120px))}.pf-nav{font-size:16px}}
@media (min-width:2200px){.pf-nav,.pf-hero{max-width:2100px}.pf-hero{grid-template-columns:minmax(0,600px) minmax(0,1fr);gap:90px}.pf-h1{font-size:clamp(72px,3.4vw,96px)}.pf-lead{font-size:27px}.pf-points{font-size:23px;gap:16px}.pf-points small{font-size:18px}.pf-stage{height:min(1080px,calc(100vh - 140px))}.pf-nav{font-size:18px}}
@media (max-width:480px){.pf-nav{padding:10px 18px}.pf-h1{font-size:29px;line-height:1.04}.pf-lead{font-size:15px;line-height:1.42}.pf-sw{font-size:13px}.pf-stage{height:clamp(420px,calc(100svh - 300px),560px)!important}.pf-hero{gap:12px;padding-top:2px}}
`;

const mineEl = (k: number): string => { const m = MINE[k]!; return `<div class="pf-slot"><div class="pf-m" data-k="${k}"><span class="av" style="--ah:${m.h}" aria-hidden="true">${m.l}</span><span><b>${m.fresh ? '<i class="fd"></i>' : ""}${m.t}</b><small>${m.src} · ${m.when}</small></span></div></div>`; };
const junkEl = (j: number): string => { const x = JUNK[j]!; return `<div class="pf-c junk" style="--c:${x.c}" data-dir="${j % 2 ? 1 : -1}"><span class="th"></span><span><b>${x.t}</b><small><em>${x.tag}</em>${x.sub}</small></span></div>`; };
const boxEl = (n: number): string => { const b = BOXES[n]!; const ks = MINE.flatMap((m, k) => (m.box === n ? [k] : [])); return `<section class="mod pf-box"><div class="mod-h"><div class="mod-t"><button type="button"><span class="stack">${b.stack.map(([l, h]) => av(l, h, 22)).join("")}</span><span class="t">${b.title}</span></button></div>${ks.some((k) => MINE[k]!.fresh) ? `<span class="mod-fresh"><span class="dot"></span>${ks.filter((k) => MINE[k]!.fresh).length} new</span>` : ""}</div><div class="mod-b" data-box="${n}">${ks.map(mineEl).join("")}</div></section>`; };

export const home = {
  render: (site: Site) => `<style>${css}${COMPARISON_CSS}</style>
<a class="s-skip" href="#main">Skip to content</a><main class="pf" id="main" tabindex="-1" data-on="1"><div class="pf-sky" aria-hidden="true">${quilt("pf-quilt", 150)}</div>
<header class="pf-nav"><b>${ic("mark")}PURSS</b><a href="#why">Why</a><a href="#features">What it does</a><a href="#pricing">Pricing</a><a href="#self-host">Host it yourself</a><a href="${links(site).docs}">Docs</a><span><a href="${links(site).dashboard}">Open dashboard</a><a class="btn primary" href="${links(site).signUp}">Create a free account</a></span></header>
<section class="pf-hero">
<div><h1 class="pf-h1">Your internet, organized by you.</h1>
<p class="pf-lead">A reader you fill yourself. Pick the blogs, channels, podcasts and journals; PURSS brings what they post, in order, and nothing else.</p>
<div class="pf-sw"><label class="l0" for="pf-t">Chosen for you</label><button class="pf-toggle" id="pf-t" type="button" role="switch" aria-checked="true" aria-label="Show only what you chose"><i>${ic("mark")}</i></button><label class="l1" for="pf-t">Chosen by you</label></div>
<ul class="pf-points">${[["No algorithmic feed", "Everything in the order it was posted."], ["No ads, no trackers", "Nothing sponsored, nothing suggested."], ["You're in control", "You pick every source and what stays."], ["Yours to take with you", "Export everything, any time."]].map(([t, d]) => `<li><span class="pt">${ic("check")}</span><span>${t}<small>${d}</small></span></li>`).join("")}</ul>
<div class="s-cta"><a class="btn primary xl" href="${links(site).signUp}">Create a free account</a><a class="btn xl" href="#self-host">${ic("server")}Host it yourself</a></div></div>
<div class="pf-stage" role="img" aria-label="PURSS Home: a dashboard with a box for each source you follow, and nothing else.">
<div class="s-win pf-win"><div class="s-chrome" aria-hidden="true"><i></i><i></i><i></i><span class="u0">the feed</span><span class="u1">your.purss</span></div>
<div class="pf-bar" aria-hidden="true"><span class="l"><span class="t0">For You</span><span class="t1">Home</span></span><span class="r"><span class="bell">${ic("bell")}</span><span class="vw">${ic("list")}View</span></span></div>
<div class="pf-main" aria-hidden="true">${sidebar()}
<div class="pf-content"><div class="pf-list"></div>
<div class="pf-wash"><div class="homewash">${quilt("pf-wash-q")}<div class="col"><div class="s-mh home">Good morning, Robin</div><p class="s-wash-sub">New items since your last visit (yesterday) in 2&nbsp;collections</p></div></div></div>
<div class="pf-boxes col home-body"><div class="mods"><div class="mcol">${boxEl(0)}${boxEl(2)}</div><div class="mcol">${boxEl(1)}${boxEl(3)}</div></div></div>
<div class="pf-more"><i></i>Loading more for you…</div><div class="pf-ghosts"></div></div></div></div></div>
</section>

<section class="pf-sec" id="why"><h2 class="pf-h2">The web was yours once. Take it back.</h2><p class="pf-p">${PITCH}</p>${comparison()}</section>

<section class="pf-sec" id="features"><div class="pf-feats">${FEATURES.map((f) => `<section class="mod"><div class="mod-h"><div class="mod-t">${ic(f.icon)}<span class="t">${f.k}</span></div></div><div class="mod-b"><h3>${f.h}</h3><p>${f.p}</p></div></section>`).join("")}</div></section>

<section class="s-sec s-tint" id="apps"><div class="s-wrap"><div class="s-center"><span class="s-kicker">${ic("phone")}Apps and extensions</span><h2 class="s-h2" style="margin:10px 0 12px">Wherever you come across things.</h2><p class="s-lead">Save it where you find it, read it where you are. Your browser, phone, computer and e-reader all share one PURSS.</p></div>
<div class="s-feats" style="margin-top:40px">${appCards(site)}</div></div></section>

<section class="s-sec" id="pricing"><div class="s-wrap"><div class="s-center"><span class="s-kicker">Pricing</span><h2 class="s-h2" style="margin:10px 0 12px">Simple, honest pricing.</h2><p class="s-lead">We run it for you, from free to Pro. Every plan includes the full reader, baskets, search and export. Prefer to run it yourself? <a class="link" href="#self-host">It's free</a>.</p></div>${billingToggle()}
<div class="s-plans" style="margin-top:36px">${planCard(site, PLANS.free)}${planCard(site, PLANS.plus, { featured: true, badge: "Public sharing" })}${planCard(site, PLANS.pro, { badge: "Smart filters" })}</div>
<div class="s-always">${ALWAYS.map((x) => `<span>${ic("check")}${x}</span>`).join("")}</div></div></section>

<section class="s-sec s-tint"><div class="s-wrap"><div class="s-center" style="margin-bottom:34px"><span class="s-kicker">Compare</span><h2 class="s-h2" style="margin-top:10px">The only one of the five you can run yourself.</h2><p class="s-lead" style="margin-top:12px">Hosted by us or on your own server, it's the same app, and one export moves you between them.</p></div>${compareTable()}</div></section>

<section class="pf-sec" id="self-host"><div class="pf-host"><div><h2 class="pf-h2">Prefer to run it yourself? It's free.</h2><p class="pf-p">Your reading on your own hardware, where nobody can change the rules on you. The same PURSS with no limits, running with Docker in about 30 minutes.</p><ul class="pf-pts">${HOST_POINTS.map((t) => `<li>${ic("check")}${t}</li>`).join("")}</ul><div class="s-cta" style="margin-top:22px"><a class="btn primary lg" href="${links(site).install}">Read the install guide</a><a class="btn lg" href="${links(site).source}">View the source</a></div></div>${terminal(site)}</div></section>

<section class="s-sec" id="faq"><div class="s-wrap"><h2 class="s-h2 s-center" style="margin-bottom:30px">Questions</h2>${faq(site)}</div></section>

<section class="pf-end"><h2 class="pf-h2">Make the internet yours again.</h2><div class="s-cta" style="margin-top:22px"><a class="btn primary xl" href="${links(site).signUp}">Create a free account</a><a class="btn xl" href="#self-host">Host it yourself</a></div></section>
</main>
${footer(site)}`,
  mount: (root: HTMLElement): void => {
    const page = root.querySelector<HTMLElement>(".pf")!;
    const btn = root.querySelector<HTMLButtonElement>(".pf-toggle")!;
    const stage = root.querySelector<HTMLElement>(".pf-stage")!;
    const content = root.querySelector<HTMLElement>(".pf-content")!;
    const list = root.querySelector<HTMLElement>(".pf-list")!;
    const ghosts = root.querySelector<HTMLElement>(".pf-ghosts")!;
    const wash = root.querySelector<HTMLElement>(".pf-wash")!;
    const boxes = root.querySelector<HTMLElement>(".pf-boxes")!;
    const side = root.querySelector<HTMLElement>(".pf-main > .s-side")!;
    const mine = MINE.map((_, k) => root.querySelector<HTMLElement>(`.pf-m[data-k="${k}"]`)!);
    const slots = mine.map((el) => el.parentElement!);
    const motion = !matchMedia("(prefers-reduced-motion:reduce)").matches;
    let on = true;

    const toList = () => { list.replaceChildren(...ORDER.map((o) => { if ("mine" in o) return slots[o.mine]!; const t = document.createElement("div"); t.innerHTML = junkEl(o.junk); return t.firstElementChild!; })); };
    const toBoxes = () => { slots.forEach((el, k) => root.querySelector(`.mod-b[data-box="${MINE[k]!.box}"]`)!.append(el)); list.replaceChildren(); };
    const label = (v: boolean) => stage.setAttribute("aria-label", v ? "PURSS Home: a dashboard with a box for each source you follow, and nothing else." : "A typical feed: ads, suggestions and trending posts mixed in with the few things you follow, with more loading forever.");
    // Posts hold an opaque white surface for the whole trip (it is invisible inside a white box); only the border and radius tween.
    const CARD = { borderRadius: "13px", paddingTop: "9px", paddingBottom: "9px", backgroundColor: "rgb(255,255,255)", borderTopColor: "#dcdce2", borderLeftColor: "#dcdce2", borderRightColor: "#dcdce2", borderBottomColor: "#dcdce2" };
    const ROW = { borderRadius: "0px", paddingTop: "10px", paddingBottom: "10px", backgroundColor: "rgb(255,255,255)", borderTopColor: "rgba(220,220,226,0)", borderLeftColor: "rgba(220,220,226,0)", borderRightColor: "rgba(220,220,226,0)", borderBottomColor: "rgb(228,232,240)" };
    const EASE = "cubic-bezier(.3,.9,.3,1)";
    /** Every running animation and timer of the current flip, so a new flip (a click, or the auto-flip) can cancel them cleanly. */
    let runs: Animation[] = [], timers: number[] = [];
    const T = 1.7;
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
    const play = (el: Element, kf: Keyframe[], opt: KeyframeAnimationOptions): Animation => { const a = el.animate(kf, opt); runs.push(a); return a; };
    const settle = () => {
      runs.forEach((a) => a.cancel()); runs = []; timers.forEach(clearTimeout); timers = [];
      stage.classList.remove("fly");
      for (const el of mine) { el.style.zIndex = ""; el.style.position = ""; }
      for (const s of slots) { s.style.height = ""; s.style.width = ""; }
      wash.classList.remove("leaving"); wash.removeAttribute("style");
      root.querySelectorAll(".pf-boxes.leaving").forEach((e) => e.remove());
    };
    const flyAll = (first: DOMRect[], toRow: boolean) => {
      const last = slots.map((el) => el.getBoundingClientRect());
      slots.forEach((s, k) => { s.style.width = `${last[k]!.width}px`; s.style.height = `${last[k]!.height}px`; });
      mine.forEach((el, k) => {
        const f = first[k]!, l = last[k]!, d = (120 + k * 70) * T, dur = 820 * T;
        el.style.zIndex = "2"; el.style.position = "relative";
        const at = { translate: `${f.left - l.left}px ${f.top - l.top}px` }, to = { translate: "0 0" };
        const small = toRow ? { width: `${l.width}px`, height: `${l.height}px` } : { width: `${f.width}px`, height: `${f.height}px` };
        // Posts shrink to row size before they travel (to Home) or stay row-sized until they arrive (back to the feed), so they never overlap each other.
        const kf: Keyframe[] = toRow
          ? [{ ...at, width: `${f.width}px`, height: `${f.height}px`, ...CARD, offset: 0 }, { ...small, ...ROW, offset: 0.3 }, { ...to, width: `${l.width}px`, height: `${l.height}px`, ...ROW, offset: 1 }]
          : [{ ...at, width: `${f.width}px`, height: `${f.height}px`, ...ROW, offset: 0 }, { ...small, ...CARD, offset: 0.7 }, { ...to, width: `${l.width}px`, height: `${l.height}px`, ...CARD, offset: 1 }];
        const a = play(el, kf, { duration: dur, delay: d, easing: EASE, fill: "backwards" });
        play(el.querySelector(".av")!, [{ width: toRow ? "34px" : "26px", height: toRow ? "34px" : "26px" }, { width: toRow ? "26px" : "34px", height: toRow ? "26px" : "34px" }], { duration: dur, delay: d, easing: EASE, fill: "backwards" });
        a.onfinish = () => { el.style.zIndex = ""; el.style.position = ""; slots[k]!.style.height = ""; slots[k]!.style.width = ""; };
      });
    };

    const go = (next: boolean, animate = true) => {
      // On narrow screens the boxes and greeting come in early so the window never sits half empty.
      const q = matchMedia("(max-width:1200px)").matches ? 0.4 : 1;
      if (next === on) return;
      const first = mine.map((el) => el.getBoundingClientRect());
      settle();
      on = next; label(next);
      if (!animate || !motion) { page.dataset.on = next ? "1" : "0"; if (next) toBoxes(); else toList(); return; }
      stage.classList.add("fly"); later(settle, 1700 * T);
      const cr = content.getBoundingClientRect();
      if (next) {
        // The ads and suggestions slide out sideways and are gone by halfway; everything you chose stays and the app forms around it.
        const cards = [...list.querySelectorAll<HTMLElement>(".pf-c.junk")];
        const rects = cards.map((el) => el.getBoundingClientRect());
        cards.forEach((el, n) => {
          const r = rects[n]!, dir = Number(el.dataset.dir);
          Object.assign(el.style, { left: `${r.left - cr.left}px`, top: `${r.top - cr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
          ghosts.append(el);
          el.animate([{ translate: "0 0", opacity: 1, rotate: "0deg", offset: 0 }, { opacity: 0, offset: q < 1 ? 0.85 : 0.55 }, { translate: `${dir * cr.width * 0.9}px 0`, opacity: 0, rotate: `${dir * 5}deg`, offset: 1 }], { duration: 600 * T, delay: n * 50 * T, easing: "cubic-bezier(.4,0,.7,1)", fill: "both" }).onfinish = () => el.remove();
        });
        page.dataset.on = "1"; toBoxes();
        flyAll(first, true);
        play(side, [{ translate: "-100% 0" }, { translate: "0 0" }], { duration: 760 * T, delay: 220 * T, easing: "cubic-bezier(.2,.9,.3,1)", fill: "backwards" });
        play(wash, [{ translate: "0 -100%" }, { translate: "0 0" }], { duration: 760 * T, delay: 220 * T, easing: "cubic-bezier(.2,.9,.3,1)", fill: "backwards" });
        boxes.querySelectorAll<HTMLElement>(".pf-box").forEach((b, i) => {
          play(b, [{ backgroundColor: "rgba(255,255,255,0)", borderColor: "rgba(0,0,0,0)", boxShadow: "none" }, {}], { duration: 500 * T, delay: (260 + i * 100) * q * T, fill: "backwards" });
          play(b.querySelector(".mod-h")!, [{ opacity: 0 }, { opacity: 1 }], { duration: 450 * T, delay: (340 + i * 100) * q * T, fill: "backwards" });
        });
      } else {
        // And back: the app folds away, the posts return to the feed and the ads slide in between them.
        // The boxes leave as a still frame placed exactly where the live boxes were: same size, no posts in them, each fading as its post departs.
        const still = boxes.cloneNode(true) as HTMLElement;
        const live = [...boxes.querySelectorAll<HTMLElement>(".mod-b")];
        const at = { left: boxes.offsetLeft, top: boxes.offsetTop, width: boxes.offsetWidth, wl: wash.offsetLeft, wt: wash.offsetTop, ww: wash.offsetWidth };
        still.querySelectorAll<HTMLElement>(".mod-b").forEach((el, i) => { el.style.height = `${live[i]!.offsetHeight}px`; el.replaceChildren(); });
        Object.assign(still.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, zIndex: "0" });
        Object.assign(wash.style, { left: `${at.wl}px`, top: `${at.wt}px`, width: `${at.ww}px` });
        still.classList.add("leaving"); wash.classList.add("leaving");
        boxes.after(still);
        const w = play(wash, [{ translate: "0 0" }, { translate: "0 -100%" }], { duration: 560 * T, easing: "cubic-bezier(.5,0,.8,.4)", fill: "forwards" });
        still.querySelectorAll<HTMLElement>(".pf-box").forEach((b, i) => play(b, [{ opacity: 1 }, { opacity: 0 }], { duration: 380 * T, delay: (80 + i * 70) * T, fill: "forwards" }));
        
        page.dataset.on = "0"; toList();
        play(side, [{ translate: "0 0" }, { translate: "-100% 0" }], { duration: 560 * T, easing: "cubic-bezier(.5,0,.8,.4)" });
        flyAll(first, false);
        [...list.querySelectorAll<HTMLElement>(".pf-c.junk")].forEach((el, n) => {
          const dir = Number(el.dataset.dir);
          play(el, [{ translate: `${dir * cr.width * 0.9}px 0`, opacity: 0, rotate: `${dir * 5}deg` }, { opacity: 1, offset: 0.4 }, { translate: "0 0", opacity: 1, rotate: "0deg" }], { duration: 700 * T, delay: (320 + n * 80) * T, easing: "cubic-bezier(.2,.9,.3,1)", fill: "backwards" });
        });
      }
    };
    // A resize mid-flight would leave animations aimed at stale rectangles: snap to the finished state instead.
    let lastW = innerWidth;
    addEventListener("resize", () => { if (innerWidth !== lastW) { lastW = innerWidth; settle(); } });

    btn.onclick = () => { clearTimeout(auto); const next = btn.getAttribute("aria-checked") !== "true"; btn.setAttribute("aria-checked", String(next)); go(next); };
    // The page starts on the feed everyone knows, then flips once. With reduced motion (or without scripts) it stays on Home.
    if (motion) { btn.setAttribute("aria-checked", "false"); go(false, false); }
    const auto = motion ? window.setTimeout(() => { btn.setAttribute("aria-checked", "true"); go(true); }, 3200) : 0;
  },
};
