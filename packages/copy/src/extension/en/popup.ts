// Extension copy: apps/extension/src/popup/popup.ts and lib/popup-model.ts (the toolbar popup)
export default {
  notConnected: {
    title: "PURSS",
    body: "Connect this extension to your PURSS to keep pages, follow sites and search from here.",
    connect: "Connect…",
  },
  footer: {
    open: "Open your PURSS",
    options: "Options",
  },
  nothingToKeep: {
    title: "Nothing to keep here",
    body: "Open a web page to keep it or follow its site. Browser pages and the PURSS itself can't be kept.",
  },
  checking: "Checking your PURSS…",
  couldntCheck: "Couldn't check your PURSS.",
  keep: {
    title: "Keep this page",
    button: "Keep",
    withText: "Also keep its text as you see it",
    reading: "Reading the page and keeping it…",
    keeping: "Keeping…",
    couldntKeep: "Couldn't keep this page.",
  },
  noBasket: { before: "You don't have a basket yet. ", link: "Create one in your PURSS", after: "." },
  openItem: "Open it in your PURSS",
  addSource: {
    title: "Add as a source",
    hint: "Opens Add source in your PURSS, where you check what was found and choose a collection.",
  },
  somethingWentWrong: "Something went wrong.",
  // lib/popup-model.ts
  names: (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
  status: {
    keptIn: (baskets: string) => `Kept in ${baskets}`,
    inYourPurss: "In your PURSS, not kept in a basket",
    notYet: "Not in your PURSS yet",
  },
  following: (sources: string) => `You follow ${sources} on this site`,
  keepButton: {
    alreadyIn: (basket: string) => `Already in ${basket}`,
    keepText: "Keep its text",
    keepIn: (basket: string) => `Keep in ${basket}`,
  },
  textHint: {
    replaces: (date: string) => `Replaces the text kept from your browser on ${date}.`,
    saves: "Saves the readable part of this page as your browser shows it, labelled as captured in your browser.",
  },
  missingText: {
    empty: "No readable text was found on the page, so only the link was kept.",
    too_large: "The page's text is too long to keep, so only the link was kept.",
  },
  kept: {
    keptIn: (basket: string) => `Kept in ${basket}`,
    alreadyIn: (basket: string) => `Already in ${basket}`,
    keptAgain: (basket: string) => `Kept in ${basket} (you already had this page)`,
    textReplaced: "Its text was replaced with what you see now.",
    textSaved: "Its text was saved as your browser shows it.",
    textNotSaved: "Its text wasn't saved.",
  },
  offers: {
    followChannel: (name: string | null) => `Follow ${name ?? "this channel"}`,
    followVideoChannel: "Follow this video's channel",
    followFeedTitled: (title: string) => `Follow “${title}”`,
    followSite: "Follow this site",
    followFeed: (n: number) => `Follow feed ${n}`,
  },
};
