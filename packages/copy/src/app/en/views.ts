// App copy: apps/web/src/views
export default {
  board: {
    moved: (count: number, to: string, why: string) => `${count === 1 ? "The card moved" : `${count} cards moved`} to ${to} and left this board, because ${why}.`,
    dismiss: "Dismiss",
    showIgnored: "Show ignored items",
    nothingHere: "Nothing here",
    loading: "Loading…",
    showMore: (count: number) => `Show ${count} more`,
  },
  table: {
    columns: { source: "Source", title: "Title", type: "Type", length: "Length", added: "Date", state: "State", kept: "Kept" },
    restore: "Restore",
    basket: "basket",
  },
  cards: {
    read: (length: string) => `${length} read`,
  },
  timeline: {
    note: "Grouped by the day each item arrived. What a feed already had when you followed it goes by its publication date.",
  },
};
