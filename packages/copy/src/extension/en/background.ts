// Extension copy: apps/extension/src/background.ts and lib/menus.ts (toolbar tooltip, address-bar search, right-click menu)
export default {
  title: "PURSS",
  keptInYourPurss: "Kept in your PURSS",
  onlyWebPages: "Only web pages can be kept.",
  kept: (what: "page" | "link", basket: string | undefined) => `Kept ${what === "page" ? "this page" : "the link"} in ${basket ?? "your basket"}`,
  couldntKeep: "Couldn't keep it.",
  searchSuggestion: "Search your PURSS for: %s",
  menu: {
    connect: "Connect to your PURSS…",
    noBaskets: "Create a basket in your PURSS to keep pages",
    keepPage: "Keep page in",
    keepLink: "Keep link in",
  },
};
