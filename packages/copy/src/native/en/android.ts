// Native copy: the Android app (apps/mobile/android). A group becomes the start of a resource's name:
// `push.channelName` is `@string/push_channel_name`, in values/strings.xml; the `widget` groups are in
// values/widget_strings.xml. Values are filled in the order their `{name}`s first appear in the text.
export default {
  app: {
    name: "PURSS",
  },
  title: {
    activityMain: "PURSS",
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
  // The sample rows each panel shows in the launcher's list of widgets.
  widgetPreview: {
    toRead: {
      first: { avatar: "CD", title: "How cities are rethinking their streets", meta: "City Desk, 2 hr. ago" },
      second: { avatar: "LR", title: "A short history of the paperback", meta: "Long Reads, 1 day ago" },
      third: { avatar: "SW", title: "Why sleep matters more than you think", meta: "Science Weekly, 3 days ago" },
    },
    toListen: {
      first: { avatar: "TM", title: "Episode 212: The long game", meta: "The Money Hour, 1 day ago" },
      second: { avatar: "DT", title: "Inside the world of mapmakers", meta: "Design Talk, 2 days ago" },
      third: { avatar: "MM", title: "The science of habits", meta: "Mind Matters, 4 days ago" },
    },
    new: {
      first: { avatar: "MN", title: "The quiet return of the train", meta: "Morning News, 12 min. ago" },
      second: { avatar: "TN", title: "What we learned from a year of tests", meta: "Tech Notes, 1 hr. ago" },
      third: { avatar: "SW", title: "A new way to see the stars", meta: "Science Weekly, 3 hr. ago" },
    },
    collection: {
      first: { avatar: "MN", title: "The quiet return of the train", meta: "Morning News, 12 min. ago" },
      second: { avatar: "CD", title: "How cities are rethinking their streets", meta: "City Desk, 2 hr. ago" },
      third: { avatar: "LR", title: "A short history of the paperback", meta: "Long Reads, 1 day ago" },
    },
    source: {
      first: { avatar: "TN", title: "What we learned from a year of tests", meta: "Tech Notes, 1 hr. ago" },
      second: { avatar: "TN", title: "The new chips are here", meta: "Tech Notes, 5 hr. ago" },
      third: { avatar: "TN", title: "Inside a data centre", meta: "Tech Notes, 1 day ago" },
    },
  },
};
