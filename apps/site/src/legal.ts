import * as copy from "@purss/copy/site";
import { euros } from "@purss/domain/plans";
import { footer, nav, PLANS, PLUS, PRO } from "./kit.ts";
import type { Site } from "./site.ts";

/** Terms of service, privacy policy and legal notice for the hosted service. Self-hosted copies are covered by the AGPL-3.0 only. */
export const LEGAL = {
  terms: {
    title: copy.legal.terms.title,
    updated: copy.words.november2026,
    body: copy.legal.terms.body({ free: PLANS.free.name, plus: PLANS.plus.name, pro: PLANS.pro.name, plusYear: euros(PLUS.year), plusMonth: euros(PLUS.month), proYear: euros(PRO.year), proMonth: euros(PRO.month) }),
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
