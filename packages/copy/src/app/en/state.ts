// App copy: apps/web/src/state
const notSent = "Not sent yet: it goes as soon as PURSS can be reached.";

export default {
  actions: {
    notSent,
    withNote: (message: string, note: string) => `${message}. ${note}`,
    already: (label: string) => `Already ${label.toLowerCase()}`,
    restoredTo: (label: string) => `Restored to ${label}`,
    ignored: "Ignored",
    marked: (label: string) => `Marked ${label}`,
    markedFor: (verb: string, items: string) => `${verb} for ${items}`,
    keep: (on: boolean, basket: string) => `${on ? "Kept in" : "Removed from"} ${basket}`,
    alreadyKept: "Already kept there",
    keptIn: (items: string, where: string) => `Kept ${items} in ${where}`,
    needsConnection: "Mark all as seen needs a connection. Nothing was changed.",
    nothingNew: "Nothing new to mark as seen",
    markedSeen: (items: string) => `Marked ${items} as seen`,
    notMarkedNew: (one: boolean) => `${one ? "That item wasn't" : "Those items weren't"} marked New`,
    markedSeenLater: `Marked as seen. ${notSent}`,
  },
  itemMenus: {
    keepIn: "Keep in",
    savesText: "saves text",
    savesLink: "saves link",
    noBaskets: "No baskets yet. A basket keeps items you choose, even after their source drops them.",
    newBasket: "New basket…",
    couldntCopy: "Couldn't copy the link.",
    openShowSite: "Open the show's website",
    openOriginal: "Open original",
    current: "Current",
    mark: (label: string) => `Mark ${label}`,
    restore: "Restore",
    ignore: "Ignore",
    keepInMenu: "Keep in…",
    removeFromBasket: "Remove from basket",
    deletePermanently: "Delete permanently…",
    moveTo: "Move to",
  },
  sourceActions: {
    retrying: (title: string) => `Trying again to collect ${title}.`,
  },
  toasts: {
    undone: "Undone.",
    pressToUndo: (message: string, mac: boolean) => `${message}. Press ${mac ? "Command" : "Control"} Z to undo.`,
    undoAvailable: (message: string) => `${message}. Undo is available.`,
  },
};
