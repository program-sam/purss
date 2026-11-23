/**
 * Copy for the native shells: the Android app's string resources, the iOS widgets' and notification extension's Swift,
 * and the desktop app's Rust code; `widget` is the widgets' text both phones show. A value is a plain
 * string; `{name}` stands for a value the code fills in. scripts/native-translations.ts writes the platforms' own files from
 * it (npm run translations:native), and a test fails when one is out of date.
 */
// The app's name, in the places a system shows it.
const name = "PURSS";

// The sample rows Android's widget picker shows, used by more than one panel.
const sample = {
  theTailEnd: { avatar: "WB", title: "The Tail End", meta: "Wait But Why, 2 hr. ago" },
  howToDo: { avatar: "PG", title: "How to Do Great Work", meta: "Paul Graham, 1 day ago" },
  howToBuild: { avatar: "LT", title: "How to Build a Low-tech Website?", meta: "Low-tech Magazine, 3 days ago" },
  colors: { avatar: "RA", title: "Colors", meta: "Radiolab, 1 day ago" },
  theUpsideOf: { avatar: "FR", title: "The Upside of Quitting", meta: "Freakonomics Radio, 2 days ago" },
  taDaItS: { avatar: "TT", title: "Ta-da! It's Windows", meta: "Twenty Thousand Hertz, 4 days ago" },
  pillarsOf: { avatar: "AP", title: "Pillars of Creation", meta: "APOD, 12 min. ago" },
  whyNoOne: { avatar: "VE", title: "Why No One Has Measured The Speed Of Light", meta: "Veritasium, 1 hr. ago" },
  theFermiParadox: { avatar: "WB", title: "The Fermi Paradox", meta: "Wait But Why, 3 hr. ago" },
  standards: { avatar: "XK", title: "Standards", meta: "xkcd, 1 hr. ago" },
  exploitsOfA: { avatar: "XK", title: "Exploits of a Mom", meta: "xkcd, 2 days ago" },
  compiling: { avatar: "XK", title: "Compiling", meta: "xkcd, 4 days ago" },
};

export const native = {
  // the Android app (apps/mobile/android). A group becomes the start of a resource's name:
  // `push.channelName` is `@string/push_channel_name`, in values/strings.xml; `widgetPreview` and the widgets' text the
  // two phones share (the `widget` section) are in values/widget_strings.xml. Values are filled in the order their `{name}`s first
  // appear in the text.
  android: {
    app: {
      name,
    },
    title: {
      activityMain: name,
    },
    audio: {
      playerServiceDescription: "Plays audio from your PURSS in the background.",
    },
    push: {
      channelName: "PURSS notifications",
      channelDescription: "New items and other news from your PURSS, as you chose in its notification settings.",
      hiddenText: "Something new in your PURSS",
    },
    downloads: {
      channelName: "Downloads",
      channelDescription: "Shows while episodes and articles download to this device, including when the app is closed.",
      notificationTitle: "Downloading to this device",
      notificationProgress: "{done} of {total} MB",
      notificationBytes: "{done} MB",
    },
    // The sample rows each panel shows in the launcher's list of widgets.
    widgetPreview: {
      toRead: {
        first: sample.theTailEnd,
        second: sample.howToDo,
        third: sample.howToBuild,
      },
      toListen: {
        first: sample.colors,
        second: sample.theUpsideOf,
        third: sample.taDaItS,
      },
      new: {
        first: sample.pillarsOf,
        second: sample.whyNoOne,
        third: sample.theFermiParadox,
      },
      collection: {
        first: sample.pillarsOf,
        second: sample.theFermiParadox,
        third: sample.colors,
      },
      source: {
        first: sample.standards,
        second: sample.exploitsOfA,
        third: sample.compiling,
      },
    },
  },
  // the home-screen widgets' text both phones show (Android's values/widget_strings.xml as `widget_…`, and
  // NativeTranslations.Widget in the iOS widgets). Values are filled in the order their `{name}`s first appear in the text.
  widget: {
    toRead: "To read",
    toListen: "To listen",
    new: "New",
    collection: "Collection",
    source: "Source",
    toReadDescription: "Items you marked To read",
    toListenDescription: "Your saved podcast episodes",
    newDescription: "New items from all your sources",
    collectionDescription: "The newest items of one of your collections",
    sourceDescription: "The newest items of one of your sources",
    notConnected: "Open the app to connect it to your PURSS.",
    loading: "Loading…",
    nothing: "You are all caught up.",
    nothingToListen: "You are all caught up.",
    nothingNew: "You are all caught up.",
    nothingHere: "Nothing here yet.",
    chooseCollection: "Tap to choose a collection.",
    chooseSource: "Tap to choose a source.",
    chooseCollectionTitle: "Choose a collection",
    chooseSourceTitle: "Choose a source",
    noCollections: "You have no collections yet. Make one in the app.",
    noSources: "You follow no sources that can show here.",
    setupFailed: "Your PURSS couldn't be reached. Try again later.",
    collectionGone: "This collection is gone. Tap to choose another.",
    sourceGone: "You don't follow this source any more. Tap to choose another.",
    privateSource: "This source is private, so it isn't shown on the home screen. Tap to choose another.",
    play: "Play {title}",
    pause: "Pause {title}",
    open: "Open {title}",
    row: "{title}, {meta}",
    playing: "Playing",
    paused: "Paused",
    pausedAt: "Paused at {time}",
    savedLink: "Saved link",
  },
  // the iOS app's own text, where it differs from Android's (NativeTranslations.Ios in Swift): its widgets are
  // edited from their touch-and-hold menu, not tapped. `panelChoice` is the widget settings' App Intent names, which
  // Xcode reads at build time, so the generator writes them into PanelChoice.swift itself.
  ios: {
    widget: {
      chooseCollection: "Edit this widget to choose a collection.",
      chooseSource: "Edit this widget to choose a source.",
      collectionGone: "This collection is gone. Edit this widget to choose another.",
      sourceGone: "You don't follow this source any more. Edit this widget to choose another.",
      privateSource: "This source is private, so it isn't shown on the home screen. Edit this widget to choose another.",
      untitled: "Untitled",
      now: "now",
    },
    // The sample rows a widget shows while iOS draws it before it has data.
    placeholder: {
      first: "A headline that might be here",
      second: "Another one, a little longer than the first",
      third: "And a third",
      source: "Source",
    },
    panelChoice: {
      collection: "Collection",
      source: "Source",
      unavailable: "Unavailable",
    },
    notification: {
      more: "{count} more in your PURSS",
    },
  },
  // the desktop app (apps/desktop/src-tauri). A group becomes a Rust module, an entry without a `{name}` a
  // constant and one with values a function taking them in the order they first appear in the text:
  // `tray.restart` is `copy::tray::restart(version)`.
  desktop: {
    app: {
      name,
    },
    tray: {
      open: "Open PURSS",
      quit: "Quit",
      restart: "Restart to update to {version}",
      tooltip: {
        none: name,
        one: "PURSS: 1 new item",
        many: "PURSS: {n} new items",
      },
    },
    notification: {
      open: "Open",
      updateReady: "A new version of PURSS is ready",
      updateReadyText: "Version {version} is installed. Restart the app to see the changes.",
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
      downloadsFolderTaken: "There's already a folder with that name. Choose another folder.",
      downloadsFolderIsLink: "“{folder}” is a link. Choose another folder.",
    },
    incoming: {
      fileTooLarge: "That file is too large to be a subscription list.",
      fileUnreadable: "That file couldn't be read.",
    },
  },
};
