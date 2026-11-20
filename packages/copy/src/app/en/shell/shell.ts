export default {
  loading: "Loading your PURSS…",
  loadFailed: "Couldn't load your PURSS",
  tryAgain: "Try again",
  home: "Home",
  collection: "Collection",
  source: "Source",
  basket: "Basket",
  statistics: (name: string) => `Statistics · ${name}`,
  documentTitle: (item: string | undefined, name: string) => `${item ? `${item} · ` : ""}${name} · PURSS`,
  skipToContent: "Skip to content",
  skipToPlayer: "Skip to the player",
};
