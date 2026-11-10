import { home } from "./home.ts";
import { PLANS, PLUS, PRO, SELF_HOSTED } from "./kit.ts";
import { docPage, legalPage } from "./legal.ts";
import { links, type Site } from "./site.ts";

/**
 * Every page of the site with its metadata. The build renders each page's HTML and head from
 * here (vite.config.ts), so crawlers and link previews see the full page without running scripts.
 */
type Page = { path: string; title: string; description: string; render: (site: Site) => string; index?: false; ld?: (site: Site) => object[] };

const NAME = "PURSS";

/** Structured data needs full addresses; the app's links may be paths on this site. */
const abs = (site: Site, url: string) => new URL(url, `${site.origin}/`).href;

export const PAGES = {
  index: {
    path: "/",
    title: `${NAME}: your internet, organized by you`,
    description: "Follow blogs, journals, YouTube channels and podcasts in one calm place, with no engagement algorithm. Keep what matters in baskets. Open source: host it yourself for free, or let us host it.",
    render: home.render,
    ld: (site) => [{
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: NAME,
      url: `${site.origin}/`,
      description: "A calm reader for blogs, journals, YouTube channels and podcasts that you can host yourself.",
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any modern browser; self-hosted with Docker on Linux",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      isAccessibleForFree: true,
      sameAs: [links(site).source],
      publisher: { "@type": "Organization", name: "program-sam", url: "https://github.com/program-sam" },
      offers: [
        { "@type": "Offer", name: SELF_HOSTED.name, price: SELF_HOSTED.price, priceCurrency: "EUR", url: links(site).install },
        { "@type": "Offer", name: PLANS.free.name, price: "0", priceCurrency: "EUR", url: abs(site, links(site).signUp) },
        ...([[PLANS.plus.name, PLUS], [PLANS.pro.name, PRO]] as const).flatMap(([name, eur]) => ([["P1Y", eur.year, "yearly"], ["P1M", eur.month, "monthly"]] as const).map(([d, price, period]) => ({
          "@type": "Offer", name: `${name}, billed ${period}`, price: String(price), priceCurrency: "EUR", url: abs(site, links(site).signUp),
          priceSpecification: { "@type": "UnitPriceSpecification", price: String(price), priceCurrency: "EUR", valueAddedTaxIncluded: true, billingDuration: d },
        }))),
      ],
    }],
  },
  terms: {
    path: "/terms.html",
    title: `Terms of service · ${NAME}`,
    description: "The terms for the hosted PURSS: the plans, paying and cancelling, your data, fair use and closing your account.",
    render: (site) => legalPage(site, "terms"),
  },
  privacy: {
    path: "/privacy.html",
    title: `Privacy · ${NAME}`,
    description: "What the hosted PURSS stores, who else is involved, how long it is kept and your rights. No trackers, no ads, no selling your data.",
    render: (site) => legalPage(site, "privacy"),
  },
  legal: {
    path: "/legal.html",
    title: `Legal notice · ${NAME}`,
    description: "Who runs PURSS, how to reach them, and the GNU AGPL-3.0 license the software is under.",
    render: (site) => legalPage(site, "legal"),
  },
  "404": {
    path: "/404.html",
    title: `Page not found · ${NAME}`,
    description: "This page doesn't exist.",
    index: false,
    render: (site) => docPage(site, "This page isn't here.", `<p class="s-lead">The link may be old or mistyped. Try the <a class="link" href="/">home page</a>, or the <a class="link" href="/#faq">questions and answers</a>.</p>`),
  },
} satisfies Record<string, Page>;

export type PageKey = keyof typeof PAGES;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The page's `<head>` metadata: title, description, canonical link, link previews and structured data. */
export function head(site: Site, key: PageKey): string {
  const p: Page = PAGES[key];
  const url = `${site.origin}${p.path}`;
  const tags = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    p.index === false ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${NAME}">`,
    `<meta property="og:locale" content="en">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    ...(p.index === false ? [] : [`<meta property="og:url" content="${url}">`]),
    `<meta property="og:image" content="${site.origin}/og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="PURSS: Your internet, organized by you.">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
    // `<` is escaped so text in the data can never close the script element.
    ...(p.ld?.(site) ?? []).map((d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>`),
  ];
  return tags.join("\n  ");
}

export const render = (site: Site, key: PageKey): string => PAGES[key].render(site);

export const sitemap = (site: Site): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.values(PAGES).filter((p: Page) => p.index !== false).map((p) => `  <url><loc>${site.origin}${p.path}</loc></url>`).join("\n")}
</urlset>
`;

export const robots = (site: Site): string => `User-agent: *
Allow: /

Sitemap: ${site.origin}/sitemap.xml
`;
