/*
 * Cookie and consent banners, taken out of a page before Readability looks for its article. A banner is a block of prose with
 * more words than a short page has, so on a thin page (a vacancy, a notice) Readability can pick it as "the main block" and the
 * capture is the banner. Taken out first, what is left is the page.
 *
 * Banners are found by what the markup calls them, never by what they say: the names of the common consent tools and of banners
 * generally (`govuk-cookie-banner`, `onetrust-banner-sdk`, `CybotCookiebotDialog`, `cc-window`), or an accessible name that
 * is a cookie notice's. A block that is or holds the page's own article, or holds most of the page's text, is never taken out, whatever it is
 * called (a site marks its <body>, or a wrapper round everything, with `cookie-banner-open` while a banner shows).
 */

/** An id or class that names a consent banner or a consent tool. The name starts at a word boundary: `govuk-cookie-banner` but not `scookiebannerless`. */
const BANNER_NAME = new RegExp(
  "(?:^|[^a-z0-9])(?:" +
    [
      "cookie[-_]?(?:banner|consent|notice|bar|law|popup|modal|overlay|dialog|message|wall|warning|disclaimer|manager|settings-banner)",
      "cookies[-_]?(?:banner|consent|notice|bar|popup|modal|overlay|message|warning)",
      "consent[-_]?(?:banner|manager|notice|bar|popup|modal|dialog|wall|management)",
      "gdpr[-_]?(?:banner|consent|notice|popup|cookie|bar|modal)",
      "eu[-_]cookie",
      "cc[-_](?:window|banner|revoke|grower)",
      "cmplz[-_]",
      "cmp[-_](?:banner|container|modal)",
      "onetrust|ot-sdk-container|optanon",
      "cybotcookiebot|cookiebot",
      "didomi",
      "usercentrics",
      "qc-cmp",
      "sp_message_container|sp-message-container",
      "iubenda-cs",
      "osano-cm",
      "truste|trustarc|evidon",
      "klaro",
      "termly",
      "fc-consent-root",
      "cookiefirst",
      "borlabs-cookie",
      "cookie-law-info|cli-modal|moove[-_]gdpr",
    ].join("|") +
    ")",
  "i",
);

/** An accessible name that is a cookie notice's: "Cookies on Find an apprenticeship", "Cookie banner", "Cookie settings". */
const BANNER_LABEL = /^\s*(?:cookies?(?:\s+(?:on|banner|consent|notice|settings|preferences|policy banner)\b|\s*$)|consent\s+(?:banner|manager|preferences)|privacy\s+(?:banner|preferences|notice banner)|manage\s+(?:cookies|consent))/i;

/** The minimum of the DOM this needs; a linkedom document satisfies it. */
type Node = {
  tagName?: string;
  textContent: string | null;
  parentNode: Node | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): unknown;
  matches(selector: string): boolean;
  remove(): void;
};
export type ConsentDocument = { body?: Node | null; querySelectorAll(selector: string): ArrayLike<Node> };

/** A banner that is most of the page's text is the page that Readability is left with; the capture check names it. */
const BANNER_SHARE = 0.8;
/** A class that says a banner is showing, on whatever wraps the page (`has-cookie-banner`, `cookie-banner-open`), not that the element is one. */
const STATE_TOKEN = /^(?:has|with|no|show|shows|is)[-_]|[-_](?:open|opened|visible|active|shown|showing|enabled|on|present|displayed)$/i;

/** What a page holds of its own: a block that is any of it, or holds any of it, is the page, not a banner. */
const PAGE_CONTENT = "article, main, [role='main'], [itemprop='articleBody']";

/** Take the consent banners out of a document; returns how many blocks were removed. */
export function removeConsentBanners(document: ConsentDocument): number {
  let removed = 0;
  const bodyChars = (document.body?.textContent ?? "").replace(/\s+/g, " ").length;
  for (const el of Array.from(document.querySelectorAll("[id], [class], [aria-label]"))) {
    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "html" || tag === "body" || tag === "head" || tag === "main" || tag === "article") continue;
    const named = BANNER_NAME.test(el.getAttribute("id") ?? "") || (el.getAttribute("class") ?? "").split(/\s+/).some((c) => BANNER_NAME.test(c) && !STATE_TOKEN.test(c))
      || BANNER_LABEL.test(el.getAttribute("aria-label") ?? "");
    if (!named) continue;
    if (el.matches(PAGE_CONTENT) || el.querySelector(PAGE_CONTENT)) continue;
    if (bodyChars > 0 && (el.textContent ?? "").replace(/\s+/g, " ").length / bodyChars >= BANNER_SHARE) continue;
    // Already taken out with a banner that holds this one.
    if (isDetached(el)) continue;
    el.remove();
    removed++;
  }
  return removed;
}

function isDetached(el: Node): boolean {
  let node: Node | null = el;
  while (node) {
    if (node.tagName?.toLowerCase() === "html") return false;
    node = node.parentNode;
  }
  return true;
}
