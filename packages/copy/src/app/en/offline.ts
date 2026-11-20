// App copy: apps/web/src/offline
export default {
  settings: {
    removed: "Removed the offline copies from this device. Offline reading is off.",
    title: "App and offline reading",
    hint: "Saves your To read and In progress items, items kept with their text, and recent Undecided items on this device. You can read them offline, with source icons and the pictures saved with kept items. Other article images still need a connection. Turning this off or signing out removes the copies.",
    enabled: "Offline reading on this device",
    unsupported: "This needs a secure address (HTTPS) and a browser that can keep offline copies, so it isn't available here.",
    using: (size: string) => `Using ${size} of this device's browser storage.`,
    remove: "Remove offline copies",
    install: "Install app",
    ownWindow: "Opens in its own window, like any other app.",
    appleHint: "To install on an iPhone or iPad, tap Share, then Add to Home Screen.",
    installed: "You're using the installed app.",
  },
  controller: {
    updateReady: "A new version is ready",
    reload: "Reload",
  },
  summary: {
    saving: "Saving your reading list…",
    nothing: "Nothing is saved on this device yet. Items you mark To read, or keep with their text, are saved here.",
    item: "item",
    saved: (items: string) => `${items} saved`,
    updating: (items: string) => `${items}, updating…`,
    updated: (items: string, when: string) => `${items}, last updated ${when}.`,
    done: (items: string) => `${items}.`,
  },
};
