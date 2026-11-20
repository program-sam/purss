// Native copy: the desktop app (apps/desktop/src-tauri). A group becomes a Rust module, an entry without a `{name}` a
// constant and one with values a function taking them in the order they first appear in the text:
// `tray.restart` is `copy::tray::restart(version)`.
export default {
  app: {
    name: "PURSS",
  },
  tray: {
    open: "Open PURSS",
    quit: "Quit",
    restart: "Restart to update to {version}",
    tooltip: {
      none: "PURSS",
      one: "PURSS: 1 new item",
      many: "PURSS: {n} new items",
    },
  },
  notification: {
    open: "Open",
    updateReady: "A new version of PURSS is ready",
    updateReadyText: "Version {version} is installed when you restart the app, or when you quit it from the tray.",
  },
  dialog: {
    chooseDownloads: "Choose where to keep downloads",
    exportName: "export",
  },
  computer: {
    mac: "Mac",
    windows: "Windows",
    linux: "Linux",
    unnamed: "{os} computer",
    named: "{host} ({os})",
  },
  errors: {
    fileNotSaved: "The file couldn't be saved: {e}",
    connectionNotKept: "The connection couldn't be kept on this computer: {e}",
    connectionNotRemoved: "The credential store couldn't remove the connection.",
    downloadsFolderInside: "Choose a folder outside the current downloads folder.",
    downloadsNotCopied: "Couldn't copy the downloads: {e}",
    downloadsFolderNotKept: "Couldn't keep the new folder: {e}",
    downloadsFolderNotMade: "Couldn't make the downloads folder: {e}",
    downloadsFolderTaken: "There's already a folder called “{folder}” there that isn't the app's. Choose another folder.",
    downloadsFolderIsLink: "“{folder}” there is a link. Choose another folder.",
  },
  incoming: {
    fileTooLarge: "That file is too large to be a subscription list.",
    fileUnreadable: "That file couldn't be read.",
  },
};
