/** Page titles, descriptions and link previews (apps/site/src/pages.ts). */
export default {
  name: "PURSS",
  index: {
    title: (name: string) => `${name}: your internet, organized by you`,
    description: "Follow blogs, journals, YouTube channels and podcasts in one calm place, with no engagement algorithm. Keep what matters in baskets. Open source: host it yourself for free, or let us host it.",
  },
  /** Structured data on the home page. */
  structuredData: {
    description: "A calm reader for blogs, journals, YouTube channels and podcasts that you can host yourself.",
    operatingSystem: "Any modern browser; self-hosted with Docker on Linux",
    publisher: "Program Sam",
    offer: (plan: string, period: string) => `${plan}, billed ${period}`,
    yearly: "yearly",
    monthly: "monthly",
  },
  terms: {
    title: (name: string) => `Terms of service · ${name}`,
    description: "The terms for the hosted PURSS: the plans, paying and cancelling, your data, fair use and closing your account.",
  },
  privacy: {
    title: (name: string) => `Privacy · ${name}`,
    description: "What the hosted PURSS stores, who else is involved, how long it is kept and your rights. No trackers, no ads, no selling your data.",
  },
  legal: {
    title: (name: string) => `Legal notice · ${name}`,
    description: "Who runs PURSS, how to reach them, and the GNU AGPL-3.0 license the software is under.",
  },
  notFound: {
    title: (name: string) => `Page not found · ${name}`,
    description: "This page doesn't exist.",
    heading: "This page isn't here.",
    lead: { before: "The link may be old or mistyped. Try the ", home: "home page", between: ", or the ", faq: "questions and answers", after: "." },
  },
  /** The text of the link preview image. */
  previewImageAlt: "PURSS: Your internet, organized by you.",
};
