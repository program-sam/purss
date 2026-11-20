import { site as copy } from "@purss/copy/site";
import { footer, nav, PLANS, PLUS, PRO } from "./kit.ts";
import type { Site } from "./site.ts";

/** Terms of service, privacy policy and legal notice for the hosted service. Self-hosted copies are covered by the AGPL-3.0 only. */
export const LEGAL = {
  terms: {
    title: copy.legal.terms.title,
    updated: copy.legal.terms.updated,
    body: copy.legal.terms.body({ free: PLANS.free.name, plus: PLANS.plus.name, pro: PLANS.pro.name, plusYear: PLUS.year, plusMonth: PLUS.month, proYear: PRO.year, proMonth: PRO.month }),
  },
  privacy: copy.legal.privacy,
  legal: copy.legal.legal,
} satisfies Record<string, { title: string; updated: string; body: string }>;

export type LegalKey = keyof typeof LEGAL;

/** A text page: the legal pages and the 404 page. */
export function docPage(site: Site, title: string, body: string, updated?: string): string {
  return `<a class="s-skip" href="#main">${copy.kit.skipToContent}</a>${nav(site, "/")}
<main id="main" tabindex="-1" class="s-doc"><div class="s-wrap"><article>
<h1 class="s-h2">${title}</h1>${updated ? `<p class="fine">${copy.legal.lastUpdated(updated)}</p>` : ""}${body}</article></div></main>
${footer(site)}`;
}

export const legalPage = (site: Site, key: LegalKey): string => docPage(site, LEGAL[key].title, LEGAL[key].body, LEGAL[key].updated);
