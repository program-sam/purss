// Server copy: apps/api/src/services/items.ts
export default {
  unknownView: "Unknown view.",
  pageLinkExpired: "That page link has expired.",
  labelPartial: "Only part of the page was saved",
  labelBrowser: "Saved from your browser",
  labelPending: "Saving readable text…",
  labelFailed: "Couldn't save the text",
  browserCaptureNote: "The text as your browser showed it. PURSS didn't fetch the page, so it can't confirm that this matches the original.",
  triedAgainNothingBetter: "Tried again, nothing better",
  stillPartial: (reason: string) => `The page still gave only part of its text: ${reason} The copy saved earlier stays.`,
};
