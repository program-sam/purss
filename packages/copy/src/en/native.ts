/**
 * Copy for the native shells: the Android app's string resources, the iOS widgets' and notification extension's Swift,
 * and the desktop app's Rust code; `widget` is the widgets' text both phones show. A value is a plain
 * string; `{name}` stands for a value the code fills in. scripts/native-copy.ts writes the platforms' own files from
 * it (npm run copy:native), and a test fails when one is out of date.
 */
// The app's name, in the places a system shows it.
const name = "PURSS";

// The sample rows Android's widget picker shows, used by more than one panel.
const sample = {
  howCitiesAre: { avatar: "CD", title: "How cities are rethinking their streets", meta: "City Desk, 2 hr. ago" },
  aShortHistory: { avatar: "LR", title: "A short history of the paperback", meta: "Long Reads, 1 day ago" },
  whySleepMatters: { avatar: "SW", title: "Why sleep matters more than you think", meta: "Science Weekly, 3 days ago" },
  episodeTheLong: { avatar: "TM", title: "Episode 212: The long game", meta: "The Money Hour, 1 day ago" },
  insideTheWorld: { avatar: "DT", title: "Inside the world of mapmakers", meta: "Design Talk, 2 days ago" },
  theScienceOf: { avatar: "MM", title: "The science of habits", meta: "Mind Matters, 4 days ago" },
  theQuietReturn: { avatar: "MN", title: "The quiet return of the train", meta: "Morning News, 12 min. ago" },
  whatWeLearned: { avatar: "TN", title: "What we learned from a year of tests", meta: "Tech Notes, 1 hr. ago" },
  aNewWay: { avatar: "SW", title: "A new way to see the stars", meta: "Science Weekly, 3 hr. ago" },
  theNewChips: { avatar: "TN", title: "The new chips are here", meta: "Tech Notes, 5 hr. ago" },
  insideAData: { avatar: "TN", title: "Inside a data centre", meta: "Tech Notes, 1 day ago" },
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
        first: sample.howCitiesAre,
        second: sample.aShortHistory,
        third: sample.whySleepMatters,
      },
      toListen: {
        first: sample.episodeTheLong,
        second: sample.insideTheWorld,
        third: sample.theScienceOf,
      },
      new: {
        first: sample.theQuietReturn,
        second: sample.whatWeLearned,
        third: sample.aNewWay,
      },
      collection: {
        first: sample.theQuietReturn,
        second: sample.howCitiesAre,
        third: sample.aShortHistory,
      },
      source: {
        first: sample.whatWeLearned,
        second: sample.theNewChips,
        third: sample.insideAData,
      },
    },
  },
  // the home-screen widgets' text both phones show (Android's values/widget_strings.xml as `widget_…`, and
  // NativeCopy.Widget in the iOS widgets). Values are filled in the order their `{name}`s first appear in the text.
  widget: {
    toRead: "To read",
    toListen: "To listen",
    new: "New",
    collection: "Collection",
    source: "Source",
    toReadDescription: "The items you marked To read",
    toListenDescription: "Your To read podcast episodes and the one you're listening to",
    newDescription: "New items from all your sources",
    collectionDescription: "The newest items of a collection you choose",
    sourceDescription: "The newest items of a source you choose",
    notConnected: "Open the app to connect it to your PURSS.",
    loading: "Loading…",
    nothing: "Nothing To read.",
    nothingToListen: "Nothing To listen to.",
    nothingNew: "Nothing New.",
    nothingHere: "Nothing here yet.",
    chooseCollection: "Tap to choose a collection.",
    chooseSource: "Tap to choose a source.",
    chooseCollectionTitle: "Choose a collection",
    chooseSourceTitle: "Choose a source",
    noCollections: "You have no collections yet. Make one in the app.",
    noSources: "You follow no sources that can show here. Private sources never show on the home screen.",
    setupFailed: "Your PURSS couldn't be reached. Try again in a moment.",
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
  // the iOS app's own text, where it differs from Android's (NativeCopy.Ios in Swift): its widgets are
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
  },
};
