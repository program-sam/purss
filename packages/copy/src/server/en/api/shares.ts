// Server copy: apps/api/src/services/shares.ts
export default {
  statementIntro: "Sharing makes this page and its feed readable by anyone who has the link, with no sign-in, and it keeps showing what you add from now on. ",
  statementListed: "You chose to let search engines list it, so people can also find it by searching. ",
  statementNotListed: "Search engines are asked not to index it, but that is a request, not access control. ",
  statementOutro: "You can pause or stop sharing at any time, but copies that people or feed readers have already fetched, cached or kept can't be recalled.",
  listingStatement: "Search engines may list this page from their next visit, so people can find it by searching. Turning it off later asks them to drop it, but they decide when.",
  revocationNotice: "The page and feed no longer show. Copies that were already fetched, cached or kept by others can't be recalled.",
  takenDownHosted: "PURSS took this page down after a report, so it can't be shared again. The reason is shown above.",
  takenDownAdministrator: "An administrator took this page down after a report, so it can't be shared again. The reason is shown above.",
  plusOnly: "Sharing a basket or collection as a public page is part of Plus.",
  rulesUnreadable: "This filter collection's rules can't be read, so it can't be shared.",
  usesReadingState: "This filter collection uses your reading state (such as To read, New, opened or saved text), so sharing it would show what you read. Change its rules to share it.",
  thatSharedPage: "That shared page",
  thatItemOnPage: "That item on this shared page",
  notePublic: "This page is public, so the note shows on it and in its feed now.",
  basketShows: (name: string) => `Everything you keep in “${name}” shows on the page, including what you add later.`,
  collectionUsesBaskets: "This collection's rules use your baskets, so the page shows which items you keep.",
  newItemsShow: "New items from its sources show on the page as they arrive.",
  ownLinksPublic: (own: number) => `${own === 1 ? "1 link you saved yourself" : `${own} links you saved yourself`} (not from a feed) will be public, with the title you gave ${own === 1 ? "it" : "them"}.`,
  publicNotesShow: (notes: number) => `${notes === 1 ? "1 public note" : `${notes} public notes`} you wrote for this page will show, with the name you chose.`,
  noLongerExists: "This basket or collection no longer exists.",
  reviewVisitors: "Please review what visitors will see and confirm again.",
  settingsChanged: "The sharing settings changed since you reviewed them. Please review again.",
  onlyPublicPaused: "Only a public page can be paused.",
  takenDownStaysOffHosted: "PURSS took this page down after a report. It stays switched off until the report is reviewed.",
  takenDownStaysOffAdministrator: "An administrator took this page down; it stays switched off until they restore it.",
  stopped: "Stopped.",
  nothingHereYet: "<p class=\"empty\">Nothing here yet.</p>",
  pageTitle: (title: string, curator: string) => `${title} · shared by ${curator}`,
  madeWith: (home: string, name: string) => `Made with <a href="${home}">${name}</a>: share your own baskets and collections as a page and a feed. · `,
  pageBody: (title: string, curator: string, description: string, follow: string, feed: string, list: string, home: string, report: string) => `<header>
<h1>${title}</h1>
<p class="by">Shared by ${curator}</p>
${description}
<div class="acts"><a class="btn primary sm" href="${follow}" title="Get what ${curator} adds next, in your PURSS or any feed reader">Follow</a><a class="feed" href="${feed}">Feed</a></div>
</header>
<main id="main">
${list}
</main>
<footer>
<p>These are links shared by ${curator}. The articles belong to their authors and sites.</p>
<p>${home}<a href="${report}">Report this page</a></p>
</footer>`,
  tooManyRequests: "Too many requests. Please wait a minute and try again.",
  chooseWhatsWrong: "Please choose what's wrong with the page.",
  sayMore: "Please say a little more about what's wrong (at least a few words).",
  tooManyReports: "You've sent several reports in a short time. Please try again in an hour.",
  reportedTitle: (title: string) => `A shared page was reported: ${title}`,
  reportedBody: (reason: string) => `${reason}. Review it in Administration → Reports.`,
  thatReportedPage: "That reported page",
  writeReason: "Write the reason the owner will see.",
  alreadyTakenDown: "That page is already taken down.",
  takenDownTitle: (title: string) => `Your shared page “${title}” was taken down`,
  takenDownBody: (mode: string, text: string) => `${mode === "hosted" ? "PURSS took its page and feed down after a report" : "An administrator took its page and feed down after a report"}: ${text} You can still change it, but not share it again until the report is reviewed.`,
  notTakenDown: "That page isn't taken down.",
  canShareAgainTitle: (title: string) => `Your shared page “${title}” can be shared again`,
  canShareAgainBody: (mode: string) => `${mode === "hosted" ? "PURSS lifted the takedown" : "An administrator lifted the takedown"}. It is still paused: review it and share it again when you're ready.`,
  thatOpenReport: "That open report",
};
