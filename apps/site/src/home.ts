import { links, type Site } from "./site.ts";
import { ALWAYS, PLANS, addSourceDialog, billingToggle, appCards, appWindow, basketScreen, readingScreen, boardScreen, cardsScreen, compareTable, tableScreen, timelineScreen, faq, footer, ic, nav, planCard, quilt, terminal } from "./kit.ts";

// The public home page. The app's quilted Home wash becomes the hero; one big screenshot, then proof.
const css = `
.a-hero{position:relative;overflow:hidden;background:linear-gradient(180deg,var(--sky-top) 0%,var(--sky-mid) 46%,var(--bg) 82%);padding:64px 0 0}
.a-hero svg.quilt{position:absolute;inset:0 0 auto 0;width:100%;height:620px;pointer-events:none;-webkit-mask-image:linear-gradient(#000 40%,transparent);mask-image:linear-gradient(#000 40%,transparent)}
.a-hero .quilt path{stroke-width:2.2;stroke-dasharray:9 7}
.a-hero .s-wrap{position:relative}
.a-hero .s-h1{text-shadow:0 1px 0 rgba(255,255,255,.7);max-width:15ch;margin:18px auto 0}
.a-hero .s-lead{margin-top:20px;text-wrap:balance}
.a-hero .s-cta{margin-top:30px}
.a-shot{margin:44px auto 0;max-width:1080px;--win-h:468px}
.a-follow{display:flex;justify-content:center;gap:34px;flex-wrap:wrap;margin-top:44px;font-weight:800;color:var(--ink-3)}
.a-follow span{display:inline-flex;align-items:center;gap:8px}
.a-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:64px;align-items:center}
.a-split.rev>:first-child{order:2}
.a-split>*,.a-host>*{min-width:0}
.a-split .s-h2{margin:12px 0 16px}
.a-list{display:grid;gap:12px;margin-top:22px;font-weight:700}
.a-list li{display:flex;gap:10px}
.a-list .ic{color:var(--ok);stroke-width:3;margin-top:4px}
.a-stage{position:relative;display:grid;grid-template-columns:minmax(0,1fr);justify-items:center;place-items:center;padding:30px;border-radius:24px;background:linear-gradient(160deg,var(--sky-mid),var(--side));border:1px solid var(--line);min-height:380px}
.a-stage .s-win{width:100%;--win-h:360px}
.a-float{position:absolute}
.a-host{border-radius:28px;padding:56px;background:radial-gradient(90% 120% at 100% 0%,hsl(var(--h) 60% 30%),transparent 60%),hsl(var(--h) 35% 12%);color:#fff;display:grid;grid-template-columns:1.1fr 1fr;gap:48px;align-items:center}
.a-host .s-kicker{color:hsl(var(--h) 90% 78%)}
.a-host .s-h2{color:#fff;margin:12px 0 14px}
.a-host .s-lead{color:hsl(var(--h) 30% 82%)}
.a-host .a-list{color:hsl(var(--h) 30% 92%)}
.a-host .btn:not(.primary){background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);color:#fff;box-shadow:none}
.a-host .a-dev{margin-top:14px;color:hsl(var(--h) 30% 82%)}
.a-host .a-dev .link{color:#fff;text-decoration:underline}
.a-pitch{padding:96px 0 88px}
.a-pitch .s-h2{max-width:22ch;margin:14px auto 0;font-size:clamp(32px,4vw,50px)}
.a-pitch .s-lead{margin-top:22px;max-width:62ch}
.a-vs{display:grid;grid-template-columns:1fr 1fr;gap:0;max-width:900px;margin:48px auto 0;border-radius:20px;overflow:hidden;border:1px solid var(--line-2);box-shadow:var(--shadow);text-align:left}
.a-vs>div{padding:28px 30px;display:grid;gap:14px;align-content:start}
.a-vs h3{font-size:14px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.a-vs ul{display:grid;gap:12px;font-weight:700;font-size:16px}
.a-vs li{display:flex;gap:11px;align-items:flex-start}
.a-vs li .ic{margin-top:4px;stroke-width:3;flex:none}
.a-vs .them{background:var(--surface-2);color:var(--ink-2)}
.a-vs .them h3{color:var(--ink-3)}
.a-vs .them .ic{color:var(--ink-3)}
.a-vs .us{background:linear-gradient(var(--tint),var(--surface));border-left:1px solid var(--line-2)}
.a-vs .us h3{color:var(--accent-ink)}
.a-vs .us .ic{color:var(--ok)}
@media (max-width:900px){.a-vs{grid-template-columns:1fr}.a-vs .us{border-left:0;border-top:1px solid var(--line-2)}}
.a-tabs{margin-top:26px;flex-wrap:wrap;justify-content:center;max-width:100%}
.a-tabs button{height:36px;padding:0 16px;font-size:14.5px}
.a-view{max-width:1080px;margin:36px auto 0;--win-h:440px}
.a-view-cap{text-align:center;margin:16px auto 0;max-width:64ch;font-weight:700;color:var(--ink-2);text-wrap:balance}
.a-keep{gap:16px}
.a-sp{background:linear-gradient(var(--sky-top,var(--sky-mid)),var(--bg) 140px) no-repeat var(--bg);padding:20px 20px 16px;text-align:left;display:grid;gap:10px}
.a-sp h3{font-size:22px;font-weight:900;letter-spacing:-.02em;line-height:1.15;margin:0}
.a-sp .by{font-weight:800;color:var(--ink-2);font-size:13.5px}
.a-sp .fl{display:flex;align-items:center;gap:12px;font-size:12.5px;font-weight:800;color:var(--accent-ink)}
.a-sp .fl b{display:inline-flex;align-items:center;height:24px;padding:0 12px;border-radius:999px;background:var(--accent);color:#fff;font-size:12.5px}
.a-sp ol{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.a-sp li{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;display:grid;gap:3px}
.a-sp li .t{font-weight:800;color:var(--accent-ink);font-size:14.5px;line-height:1.3}
.a-sp li .m{font-size:12px;font-weight:700;color:var(--ink-3)}
.a-sp li .n{font-size:13px;font-weight:600;color:var(--ink-2);border-left:3px solid var(--accent);padding-left:8px}
.a-sp .ft{font-size:12px;font-weight:700;color:var(--ink-3)}
.a-keep .s-win{--win-h:auto}
.a-pitch .a-pitch-p{max-width:56ch}
.a-pitch .a-pitch-p+.a-pitch-p{margin-top:14px;color:var(--ink)}
.a-tabs button[aria-selected="true"]{background:linear-gradient(var(--surface),var(--surface-2));color:var(--ink);box-shadow:inset 0 1px 0 var(--hi),0 0 0 1px var(--line-2),var(--shadow)}
.a-beyond{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;justify-content:center;margin-top:22px;font-weight:700;color:var(--ink-2)}
.a-beyond b{color:var(--ink)}
.a-beyond span{display:inline-flex;gap:7px;align-items:center}
.a-beyond .ic{color:var(--ok);stroke-width:3}
.a-stores{display:flex;flex-wrap:wrap;gap:8px}
.a-desktop{display:grid;gap:8px;justify-items:start}
.a-desktop [hidden]{display:none}
.a-shot .s-mh.home,.a-view .s-mh.home{font-size:34px}
.a-shot .homewash .col{padding-top:20px!important;padding-bottom:20px!important}
.s-read{display:grid;grid-template-columns:minmax(0,1fr)}
.a-feats{grid-template-columns:repeat(2,minmax(0,1fr))!important;max-width:900px;margin-left:auto;margin-right:auto}
@media (max-width:600px){.a-feats{grid-template-columns:minmax(0,1fr)!important}}
.a-opml{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:14px;font-weight:700;color:var(--ink-2)}
.a-opml .ic{color:var(--accent-ink)}
.a-more{margin-top:14px;font-weight:700;color:var(--ink-3);font-size:15px;text-wrap:balance}
.a-more a{color:var(--accent-ink);text-decoration:underline;text-underline-offset:3px}
.a-who{margin-top:14px;font-style:italic}
.a-for{margin-top:18px;font-weight:700;color:var(--ink-3);font-size:15px;text-wrap:balance}
.s-read .s-panel{border-left:1px solid var(--line)}
.s-read .panel-body{padding:14px;gap:10px}
.s-read .p-title{font-size:18px}
.a-read .s-win{--win-h:auto}
.a-hero{padding-bottom:56px}
.a-beyond{display:grid;grid-template-columns:repeat(2,minmax(0,max-content));justify-content:center;text-align:left}
.a-beyond b{grid-column:1/-1;text-align:center}
@media (max-width:600px){.a-beyond{grid-template-columns:minmax(0,max-content)}.a-beyond b{text-align:left}}
@media (max-width:480px){.a-tabs{display:grid;grid-template-columns:1fr 1fr}.a-tabs button{justify-content:center}}
@media (max-width:400px){.a-hero{padding-top:28px}.a-hero .s-h1{font-size:34px;margin-top:12px}.a-hero .s-lead{margin-top:12px;font-size:16px}.a-hero .s-cta{margin-top:18px;gap:8px;flex-wrap:nowrap}.a-hero .s-cta .btn.xl{height:42px;padding:0 10px;font-size:13.5px;gap:6px}.a-shot{margin-top:24px}}
@media (min-width:1024px){.a-hero{padding-top:40px}.a-hero .s-h1{margin-top:12px}.a-hero .s-lead{margin-top:14px}.a-hero .s-cta{margin-top:22px}.a-shot{margin-top:30px}}
@media (max-width:600px){.a-shot .mcol:first-child .mod-b li:nth-child(n+3){display:none}.a-shot .s-win{--win-h:auto}.a-shot .s-main::after{display:none}.a-shot .s-main{padding-bottom:16px}}

.a-view .side-scroll::after{display:none}
.a-vh-short{display:none}
@media (max-width:600px){.a-vh-long{display:none}.a-vh-short{display:inline}}
.a-opml{align-items:flex-start}.a-opml .ic{margin-top:4px;flex:none}
.a-view .s-win{--win-h:auto}
.a-view .s-main::after{display:none}
.a-view .s-main{padding-bottom:16px}
@media (max-width:1100px){.a-view .bcol:first-child .bcard:nth-child(n+2){display:none}}
@media (max-width:600px){.a-vs li:nth-child(4){display:none}}
@media (min-width:1024px) and (max-height:860px){.a-hero{padding-top:28px}.a-hero .s-h1{font-size:56px}.a-hero .s-cta{margin-top:18px}.a-shot{margin-top:22px}.a-shot .s-mh.home{font-size:28px}.a-shot .homewash .col{padding-top:14px!important;padding-bottom:14px!important}.a-shot .s-wash-sub{margin-top:4px}}
@media (max-width:400px){.a-shot .bar{display:none}.a-shot .s-wash-sub{display:none}.a-shot .s-mh.home{font-size:22px!important}.a-shot .homewash .col{padding-top:12px!important;padding-bottom:12px!important}.a-hero .s-h1{font-size:31px}.a-hero{padding-top:22px}.a-shot{margin-top:14px!important}.a-hero .s-lead{font-size:15px}.a-hero .s-h1{margin-top:10px}}
@media (min-width:1800px){.a-pitch{padding-top:64px}}
@media (min-width:1800px){.a-shot,.a-view{max-width:1240px}.a-shot{--win-h:470px}.a-view{--win-h:500px}}
@media (max-width:600px){.a-view.a-view{--win-h:700px}.a-shot .s-mh.home,.a-view .s-mh.home{font-size:26px}}
@media (max-width:900px){.a-view{--win-h:400px}.a-split,.a-host{grid-template-columns:minmax(0,1fr);gap:32px}.a-split.rev>:first-child{order:0}.a-host{padding:28px 20px;border-radius:20px}.a-stage{padding:16px}.a-float{position:static;margin-top:14px}.a-shot{--win-h:420px;margin-top:40px}.a-follow{gap:14px 22px}.a-pitch{padding:64px 0}}
`;

const VIEWS = [
  { k: "cards", n: "Cards", icon: "grid", cap: "Channels as cards: see what's worth watching from the thumbnail. No autoplay, no recommendations; videos play on YouTube.", html: () => appWindow(cardsScreen(), { url: "your.purss/watch", crumbs: ["Collections", "Watch"], label: "Cards view of a Watch collection with video thumbnails", sel: "Watch" }) },
  { k: "table", n: "Table", icon: "table", cap: "Recipes as a table: sort by source or date and find the one you kept last winter.", html: () => appWindow(tableScreen(), { url: "your.purss/recipes", crumbs: ["Collections", "Recipes"], label: "Table view of recipes with source, date, state and kept columns", sel: "Recipes" }) },
  { k: "board", n: "Board", icon: "board", cap: "Reading as a board: see what you started and what's still waiting.", html: () => appWindow(boardScreen(), { url: "your.purss/slow-reads", crumbs: ["Collections", "Slow reads"], label: "Board view with To read, In progress and Finished columns", sel: "Slow reads" }) },
  { k: "timeline", n: "Timeline", icon: "timeline", cap: "Podcasts as a timeline: this week's episodes, day by day.", html: () => appWindow(timelineScreen(), { url: "your.purss/listen", crumbs: ["Collections", "Listen"], label: "Timeline view of podcast episodes grouped by day", sel: "Listen" }) },
] as const;

/** A shared basket's public page, as visitors see it (original sample content). */
function sharedPageMock(): string {
  const items = [
    { t: "Why the night sky is getting brighter", m: "Slow Light Journal · 2 Nov 2026", n: "The maps halfway down are worth the whole read." },
    { t: "Calm technology, twenty years on", m: "Calm Tech · 28 Oct 2026", n: null },
    { t: "A field guide to tide pools", m: "Coastal Notes · 21 Oct 2026", n: "Bring this on your next beach walk." },
  ];
  return `<div class="s-win" role="img" aria-label="A shared basket called Slow web picks: a public page with a Follow button, three links and two notes from the person who shared it">
<div class="s-chrome" aria-hidden="true"><i></i><i></i><i></i><span>your.purss/p/slow-web-picks</span></div>
<div class="a-sp" inert aria-hidden="true"><h3>Slow web picks</h3><span class="by">Shared by Noor</span>
<div class="fl"><b>Follow</b><span>Feed</span></div>
<ol>${items.map((i) => `<li><span class="t">${i.t}</span><span class="m">${i.m}</span>${i.n ? `<span class="n"><b>Noor:</b> ${i.n}</span>` : ""}</li>`).join("")}</ol>
<span class="ft">Links shared by Noor · Report this page</span></div></div>`;
}

/** A Smart filter's preview: what it would keep and drop of a busy feed, with how sure the model is. */
function smartFilterMock(): string {
  const rows: [string, boolean, number][] = [
    ["Ten easy pasta dinners for busy weeknights", true, 96],
    ["Markets slip as bond yields rise again", false, 4],
    ["A slow week walking the Scottish Highlands", true, 93],
    ["Transfer deadline day: every deal so far", false, 6],
    ["What to plant in your garden this autumn", true, 95],
  ];
  return `<div class="s-win" role="img" aria-label="A Smart filter for a busy newspaper, tried on the latest posts: food, travel and gardening kept, markets and sport dropped, each with how sure the model is">
<div class="s-chrome" aria-hidden="true"><i></i><i></i><i></i><span>your.purss/s/daily-courier</span></div>
<div class="a-sf" inert aria-hidden="true"><h3>Smart filter for The Daily Courier</h3>
<p class="k"><b>Keep posts that…</b><span>are about food, travel or gardening</span></p>
<p class="sum">3 posts kept, 2 dropped</p>
<ol>${rows.map(([t, keep, p]) => `<li class="${keep ? "" : "x"}"><span class="v">${keep ? "Keep" : "Drop"}</span><span class="t">${t}</span><span class="p">${p}%</span></li>`).join("")}</ol></div></div>`;
}

export const home = {
  render: (site: Site): string => `<style>${css}</style><a class="s-skip" href="#main">Skip to content</a>${nav(site)}
<main id="main" tabindex="-1">
<section class="a-hero">${quilt("hero-quilt", 150)}
<div class="s-wrap s-center">
<h1 class="s-h1">Your internet, organized by you.</h1>
<p class="s-lead">The blogs, channels, podcasts and journals you chose, in one place that isn't trying to keep you scrolling.</p>
<div class="s-cta"><a class="btn primary xl" href="${links(site).signUp}">Create a free account</a><a class="btn xl" href="#self-host">${ic("server")}Host it yourself</a></div>
<div class="a-shot">${appWindow()}</div>
<div class="a-follow"><span>${ic("rss")}Blogs &amp; news</span><span>${ic("book")}Journals</span><span>${ic("play")}YouTube</span><span>${ic("mic")}Podcasts</span><span>${ic("share")}Mastodon &amp; Bluesky</span><span>${ic("export")}Import from other readers</span></div>
<p class="a-more">…and most other sites with a feed. <a href="${links(site).signUp}">Paste a link into a free account</a> to see if yours works.</p>
<p class="a-for">Made for curious readers, hobbyists, students and researchers, video and podcast fans, and anyone who'd rather run it themselves.</p>
</div></section>

<section class="a-pitch" id="why"><div class="s-wrap s-center">
<span class="s-kicker">${ic("heart")}Why we built it</span>
<h2 class="s-h2">The web was yours once. Take it back.</h2>
<p class="s-lead a-pitch-p">You used to choose what you read: a favorite blog, a journal, a channel you loved. Then feeds started choosing for you, ranked to keep you scrolling and tuned for outrage.</p>
<p class="s-lead a-pitch-p">PURSS gives the choice back. You decide what comes in and in what order, so the time you spend reading is time you meant to spend.</p>
<div class="a-vs"><div class="them"><h3>Algorithmic feeds</h3><ul>
<li>${ic("x")}Ranked to keep you scrolling</li><li>${ic("x")}Strangers and ads in between</li><li>${ic("x")}Your attention is the product</li><li>${ic("x")}Gone when the platform changes its mind</li></ul></div>
<div class="us"><h3>Your PURSS</h3><ul>
<li>${ic("check")}Only the sources you chose, in your order</li><li>${ic("check")}No ads, no third-party trackers, no suggested posts</li><li>${ic("check")}You're the customer, not the product</li><li>${ic("check")}Nothing you keep expires; export any time</li></ul></div></div>
</div></section>

<section class="s-sec s-tint" id="features"><div class="s-wrap"><div class="a-split">
<div><span class="s-kicker">${ic("plus")}Follow</span><h2 class="s-h2">Nothing from the people you follow gets buried.</h2>
<p class="s-lead">Subscribing on YouTube or following someone on Bluesky doesn't mean you'll see what they post. Here it does: paste a link, and new posts arrive, unranked, until you say stop.</p>
<ul class="a-list"><li>${ic("check")}Sites, journals, YouTube, podcasts, Mastodon, Bluesky: try any link</li><li>${ic("check")}Switching readers? Bring your whole list in one go</li><li>${ic("compass")}Coming soon: suggestions for sources you'll like</li></ul></div>
<div class="a-stage">${addSourceDialog()}</div></div></div></section>

<section class="s-sec"><div class="s-wrap"><div class="a-split rev">
<div><span class="s-kicker">${ic("basket")}Keep</span><h2 class="s-h2">Find it again in six months.</h2>
<p class="s-lead">You'll want that article again, long after the feed has moved on. Drop it in a basket for the project, the trip or the rainy Sunday, and its details, summary and, if you ask, a readable copy of the text stay with you.</p>
<ul class="a-list"><li>${ic("check")}Articles, videos and episodes side by side</li><li>${ic("check")}Still there after you unfollow the source</li></ul></div>
<div class="a-stage a-keep">${appWindow(basketScreen(), { side: false, url: "your.purss/baskets/thesis", crumbs: ["Baskets", "Thesis sources"], label: "A basket called Thesis sources with four kept items, one from a source that was unfollowed" })}</div></div></div></section>

<section class="s-sec" id="read"><div class="s-wrap"><div class="a-split">
<div><span class="s-kicker">${ic("book")}Read</span><h2 class="s-h2">Start on the laptop, finish on the train.</h2>
<p class="s-lead">No pile of open tabs, no wondering where you were. Your place, your highlights and your notes follow you to every device, so nothing you started gets lost.</p>
<ul class="a-list"><li>${ic("check")}Full articles right in the app, where the site allows it</li><li>${ic("check")}Know at a glance what's next and what's half done</li><li>${ic("check")}Notes and highlights you can search later</li><li>${ic("check")}A podcast player that remembers where you were</li></ul></div>
<div class="a-stage a-read">${appWindow(readingScreen(), { side: false, url: "your.purss/slow-reads", crumbs: ["Collections", "Slow reads"], label: "A long read open in the reading pane, 42% read, kept in a basket" })}</div></div></div></section>

<section class="s-sec" id="share"><div class="s-wrap"><div class="a-split rev">
<div><span class="s-kicker">${ic("share")}Share</span><h2 class="s-h2">You're the one people ask for good links.</h2>
<p class="s-lead">Share a basket or collection as a page anyone can open, no account needed. Anyone who follows it gets each new pick as you add it, in their PURSS or any feed reader.</p>
<p class="s-p a-who">A reading list for your class. The best of your field, picked by someone who knows it. The links your followers keep asking for. A newsletter, without writing one.</p>
<ul class="a-list"><li>${ic("check")}A note on each pick says why it's worth their time</li><li>${ic("check")}Only what you choose goes public. Pause or stop any time</li></ul>
<p class="s-p" style="margin-top:14px">Included in Plus and Pro, and when you host it yourself.</p></div>
<div class="a-stage a-keep">${sharedPageMock()}</div></div></div></section>

<section class="s-sec s-tint" id="smart-filters"><div class="s-wrap"><div class="a-split">
<div><span class="s-kicker">${ic("filter")}Smart filters</span><h2 class="s-h2">Love the source. Skip the noise.</h2>
<p class="s-lead">Your favorite paper also posts plenty you'll never read, and keywords never quite catch it. Say what you care about in your own words, and the rest steps aside.</p>
<ul class="a-list"><li>${ic("check")}See what it would keep before you turn it on</li><li>${ic("check")}Nothing is deleted: set-aside posts wait in Ignored</li></ul>
<p class="s-p" style="margin-top:14px">Included in Pro.</p></div>
<div class="a-stage a-keep">${smartFilterMock()}</div></div></div></section>

<section class="s-sec s-tint" id="views"><div class="s-wrap"><div class="s-center"><span class="s-kicker">${ic("grid")}See it your way</span><h2 class="s-h2" style="margin:10px 0 12px"><span class="a-vh-long">Videos as cards. Recipes as a table. Reading as a board. Podcasts as a timeline.</span><span class="a-vh-short">Cards, table, board or timeline: your choice.</span></h2><p class="s-lead">A recipe isn't a video, and a podcast isn't a long read. Give each collection the layout that suits it.</p>
<div class="seg a-tabs" role="tablist" aria-label="Views">${VIEWS.map((v, k) => `<button type="button" role="tab" id="vt-${v.k}" aria-controls="vp" aria-selected="${k === 0}" data-v="${v.k}">${ic(v.icon)}${v.n}</button>`).join("")}</div></div>
<div class="a-view" id="vp" role="tabpanel" tabindex="0" aria-labelledby="vt-${VIEWS[0].k}">${VIEWS[0].html()}</div><p class="a-view-cap">${VIEWS[0].cap}</p></div></section>

<section class="s-sec"><div class="s-wrap"><div class="s-center"><span class="s-kicker">The little things</span><h2 class="s-h2" style="margin-top:10px">Calm by design.</h2></div>
<div class="s-feats a-feats" style="margin-top:40px">
${([
  ["bell", "Gentle alerts", "Hear about the sources you care about, when you want to, and nothing else. Kept something for later? Pick a date and it comes back to you."],
  ["spark", "New, but not noisy", "See what's new without a red badge nagging you. Counts are yours to switch off."],
  ["search", "Find anything", "That article from last spring, that line you highlighted: one search box finds it."],
  ["rss", "A Follow button for your blog", "Write a blog? Give readers a way to follow you that doesn't track them."],
] as const).map(([i, t, p]) => `<div class="s-feat"><span class="s-ico">${ic(i, "lg")}</span><h3 class="s-h3">${t}</h3><p>${p}</p></div>`).join("")}
</div></div></section>

<section class="s-sec s-tint" id="apps"><div class="s-wrap"><div class="s-center"><span class="s-kicker">${ic("phone")}Apps and extensions</span><h2 class="s-h2" style="margin:10px 0 12px">Wherever you come across things.</h2><p class="s-lead">Save it where you find it, read it where you are. Your browser, phone, computer and e-reader all share one PURSS.</p></div>
<div class="s-feats" style="margin-top:40px">${appCards(site)}</div></div></section>

<section class="s-sec" id="pricing"><div class="s-wrap"><div class="s-center"><span class="s-kicker">Pricing</span><h2 class="s-h2" style="margin:10px 0 12px">Simple, honest pricing.</h2><p class="s-lead">We run it for you, from free to Pro. Every plan includes the full reader, baskets, search and export. Prefer to run it yourself? <a class="link" href="#self-host">It's free</a>.</p></div>${billingToggle()}
<div class="s-plans" style="margin-top:36px">${planCard(site, PLANS.free)}${planCard(site, PLANS.plus, { featured: true, badge: "Public sharing" })}${planCard(site, PLANS.pro, { badge: "Smart filters" })}</div>
<div class="s-always">${ALWAYS.map((x) => `<span>${ic("check")}${x}</span>`).join("")}</div></div></section>

<section class="s-sec s-tint"><div class="s-wrap"><div class="s-center" style="margin-bottom:34px"><span class="s-kicker">Compare</span><h2 class="s-h2" style="margin-top:10px">The only one of the five you can run yourself.</h2><p class="s-lead" style="margin-top:12px">How we compare with the readers people switch from.</p></div>${compareTable()}<div class="a-beyond"><b>Beyond the price:</b><span>${ic("check")}Your copies outlive the feed</span><span>${ic("check")}A view for every collection</span><span>${ic("check")}YouTube and podcast discovery</span><span>${ic("check")}Move between hosted and self-hosted</span><span>${ic("check")}Highlights and notes</span><span>${ic("check")}Public pages anyone can follow</span><span>${ic("check")}Browser extension and phone apps</span></div><p class="a-opml">${ic("export")}Bring your list: import an OPML file (the export most readers offer) from Feedly, Inoreader or any reader.</p></div></section>

<section class="s-sec tight" id="self-host"><div class="s-wrap"><div class="a-host">
<div><span class="s-kicker">${ic("server")}Host it yourself</span><h2 class="s-h2">Prefer to run it yourself? It's free.</h2>
<p class="s-lead">Your reading on your own hardware, where nobody can change the rules on you. The same PURSS with no limits, running with Docker in about 30 minutes.</p>
<ul class="a-list"><li>${ic("check")}Every feature, free forever</li><li>${ic("check")}Runs on a spare computer, in about 1&nbsp;GB of memory</li><li>${ic("check")}Backups and invitations for family and friends built in</li><li>${ic("check")}Open source, AGPL-3.0</li></ul>
<div class="s-cta" style="margin-top:26px"><a class="btn primary lg" href="${links(site).install}">Read the install guide</a><a class="btn lg" href="${links(site).source}">View the source</a></div></div>
<div>${terminal(site)}</div></div></div></section>

<section class="s-sec" id="faq"><div class="s-wrap"><h2 class="s-h2 s-center" style="margin-bottom:30px">Questions</h2>${faq(site)}</div></section>

<section class="s-sec tight"><div class="s-wrap s-center"><h2 class="s-h2">Make the internet yours again.</h2><p class="s-lead" style="margin-top:12px">Free plan, no card needed. Or run it yourself, free forever.</p><div class="s-cta" style="margin-top:24px"><a class="btn primary xl" href="${links(site).signUp}">Create a free account</a><a class="btn xl" href="#self-host">Host it yourself</a></div></div></section>
</main>
${footer(site)}`,
  mount: (root: HTMLElement): void => {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".a-tabs button")];
    const panel = root.querySelector<HTMLElement>(".a-view")!;
    const cap = root.querySelector<HTMLElement>(".a-view-cap")!;
    const pick = (t: HTMLButtonElement) => {
      const v = VIEWS.find((x) => x.k === t.dataset.v)!;
      for (const x of tabs) { const on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; }
      panel.innerHTML = v.html(); panel.setAttribute("aria-labelledby", t.id); cap.textContent = v.cap;
    };
    tabs.forEach((t, k) => {
      t.tabIndex = k === 0 ? 0 : -1;
      t.onclick = () => pick(t);
      t.onkeydown = (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        const n = tabs[(k + d + tabs.length) % tabs.length]!; n.focus(); pick(n);
      };
    });
  },
};
