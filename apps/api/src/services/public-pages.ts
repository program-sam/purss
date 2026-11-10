import { looksPrivateUrl } from "@purss/connectors";
import { appUrl } from "@purss/domain";
import type { App } from "../app.ts";
import { escapeHtml, hasCredentialShape, httpUrlOrNull } from "./text-safety.ts";

/*
 * The pages anyone can open without signing in: shared baskets and collections, their report form, and the
 * follow page that a "Follow" button on any site points at. Server-rendered, no scripts, no
 * external resources, one stylesheet.
 */

export const PRODUCT_NAME = "PURSS";

const CSS = `:root{color-scheme:light dark;--bg:hsl(212 30% 99%);--surface:#fff;--line:hsl(212 24% 89%);--ink:hsl(212 38% 12%);--ink2:hsl(212 20% 29%);--ink3:hsl(212 14% 39%);--accent:hsl(212 82% 40%);--accent-ink:hsl(212 72% 29%);--tint:hsl(212 100% 97.5%);--tint-bd:hsl(212 55% 82%);--sky-top:hsl(212 88% 81%);--sky-mid:hsl(212 92% 91%);--warn:hsl(0 62% 38%)}
@media (prefers-color-scheme:dark){:root{--bg:hsl(212 16% 11%);--surface:hsl(212 14% 14.5%);--line:hsl(212 12% 21%);--ink:hsl(212 25% 94%);--ink2:hsl(212 14% 77%);--ink3:hsl(212 10% 65%);--accent:hsl(212 82% 62%);--accent-ink:hsl(212 92% 79%);--tint:hsl(212 28% 17%);--tint-bd:hsl(212 28% 33%);--sky-top:hsl(212 46% 24%);--sky-mid:hsl(212 32% 17%);--warn:hsl(0 80% 75%)}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 "Nunito",ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;color:var(--ink);background:linear-gradient(var(--sky-top),var(--sky-mid) 220px,var(--bg) 420px) no-repeat var(--bg)}
a{color:var(--accent-ink)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.wrap{max-width:46rem;margin:0 auto;padding:0 1rem}header{padding:2.5rem 0 1.25rem}h1{margin:0 0 .25rem;font-size:1.9rem;line-height:1.2}
.by{margin:0;color:var(--ink2);font-weight:700}.about{margin:.75rem 0 0;color:var(--ink2)}
.btn{display:inline-block;padding:.45rem 1rem;border-radius:999px;border:1px solid var(--tint-bd);background:var(--surface);color:var(--accent-ink);font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.sm{padding:.2rem .85rem;font-size:.9rem}
.feed{font-size:.9rem;font-weight:700}
@media (prefers-color-scheme:dark){.btn.primary{color:hsl(212 40% 10%)}}
.acts{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.75rem 0 0}
code{font-size:.9em;overflow-wrap:anywhere}
ol{list-style:none;margin:1.25rem 0;padding:0;display:grid;gap:.75rem}li{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;box-shadow:0 1px 2px hsl(212 40% 20% / .06)}
h2{margin:0;font-size:1.1rem;line-height:1.35}.meta{margin:.2rem 0 0;color:var(--ink3);font-size:.9rem}.sum{margin:.5rem 0 0;color:var(--ink2)}
.note{margin:.6rem 0 0;padding:.1rem 0 .1rem .75rem;border-left:3px solid var(--accent)}.note b{color:var(--ink2)}
.empty{color:var(--ink3)}footer{padding:1rem 0 2.5rem;color:var(--ink3);font-size:.9rem}footer p{margin:.4rem 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem;margin:1rem 0}
fieldset{border:0;margin:0 0 1rem;padding:0}legend,label.l{display:block;font-weight:700;margin:0 0 .35rem}
.opt{display:flex;gap:.5rem;align-items:baseline;margin:.25rem 0}
textarea,input[type=text]{width:100%;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.5rem .65rem}
.hint{color:var(--ink3);font-size:.9rem;margin:.25rem 0 1rem}.err{color:var(--warn);font-weight:700}`;

/** A public page: no scripts, no outside requests. Unless `indexable`, search engines are asked to stay away. */
export function pageShell(o: { title: string; indexable: boolean; head?: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.title)}</title>
${o.indexable ? "" : `<meta name="robots" content="noindex, nofollow">\n`}<meta name="referrer" content="no-referrer">
${o.head ?? ""}<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${o.body}
</div>
</body>
</html>
`;
}

/** Where people learn what this is: the website on the hosted service; a self-hosted installation has none. */
export function productHome(app: App): string | null {
  return app.config.mode === "hosted" ? `${app.config.publicOrigin}/` : null;
}

/** An address that may be shown publicly: plain http(s), with no credential in it (user and password, a key in the query, or a secret-looking path). */
export function publicLink(raw: string | null): string | null {
  const href = httpUrlOrNull(raw);
  return href && !hasCredentialShape(href) && !looksPrivateUrl(href) ? href : null;
}

/** The feed address a follow link carries, when it is one worth following. */
export const followTarget = publicLink;

/**
 * The page behind a "Follow in PURSS" button: follow here, or take the address to another reader.
 * `name` is what is being followed when it is known (a shared page on this installation); else the feed's host.
 */
export function renderFollowPage(app: App, feed: string, known: { name: string; by: string; atom: boolean } | null = null): string {
  const add = `${appUrl("/")}?dialog=add&url=${encodeURIComponent(feed)}`;
  let host = feed;
  try { host = new URL(feed).host; } catch { /* followTarget already checked it */ }
  const name = known?.name ?? host;
  const home = productHome(app);
  return pageShell({
    title: `Follow ${name}`,
    indexable: false,
    // Feed readers given this page's address find the feed from here, as they would on the site itself.
    // Its format is known only for this installation's own (Atom) feeds; others are announced as RSS, which readers treat as "a feed".
    head: `<link rel="alternate" type="${known?.atom ? "application/atom+xml" : "application/rss+xml"}" title="${escapeHtml(name)}" href="${escapeHtml(feed)}">\n`,
    body: `<header>
<h1>Follow ${escapeHtml(name)}</h1>
${known ? `<p class="by">Shared by ${escapeHtml(known.by)}</p>\n` : ""}<p class="about">Get its new posts in your ${PRODUCT_NAME}, next to everything else you follow. You see a preview before anything is followed.</p>
</header>
<main id="main">
<div class="card">
<p style="margin:0"><b>The feed:</b> <code>${escapeHtml(feed)}</code></p>
<div class="acts"><a class="btn primary" href="${escapeHtml(add)}">Follow in my PURSS</a></div>
<p class="hint">You sign in first if you aren't already.</p>
</div>
<div class="card">
<p style="margin:0"><b>Use another feed reader, or a PURSS somewhere else?</b> Copy the feed address above and paste it into that reader's “add” or “subscribe” box.</p>
${home ? `<p style="margin:.6rem 0 0">New to this? ${PRODUCT_NAME} is a calm place to follow blogs, news, YouTube channels and podcasts, without an algorithm. <a href="${escapeHtml(home)}">See how it works</a>.</p>` : ""}
</div>
</main>`,
  });
}

export function renderFollowError(): string {
  return pageShell({
    title: "This follow link doesn't work",
    indexable: false,
    body: `<header><h1>This follow link doesn't work</h1></header><main id="main"><p>It should carry a web address starting with http:// or https://. Ask whoever made the link to check it.</p></main>`,
  });
}
