/** Copy for text the app and the server share (packages/domain). */
export const common = {
  distribution: {
    stores: {
      chrome: "Chrome Web Store",
      edge: "Edge Add-ons",
      firefox: "Firefox Add-ons",
      safari: "Mac App Store",
      android: "Google Play",
      ios: "App Store",
    },
    platforms: {
      extension: "Chrome, Edge and Firefox",
      mobile: "Android",
    },
    desktop: {
      windows: "Windows (64-bit)",
      macos: "macOS (Apple silicon and Intel)",
      macosUpdate: "macOS update",
      linuxAppImage: "Linux AppImage (any distribution)",
      linuxDeb: "Linux .deb (Debian, Ubuntu)",
      linuxRpm: "Linux .rpm (Fedora, openSUSE)",
    },
  },
  workflow: {
    undecided: "Undecided",
    toRead: "To read",
    inProgress: "In progress",
    finished: "Finished",
    ignored: "Ignored",
  },
  plans: {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    unlimited: "Unlimited",
  },
  reportReasons: {
    copyright: "It copies someone's work without permission",
    illegal: "It links to something illegal",
    spam: "It's spam or a scam",
    harassment: "It harasses or threatens someone",
    privacy: "It shares someone's private information",
    other: "Something else",
  },
  query: {
    invalid: "That filter isn't valid.",
    tooDeep: "That filter is nested too deeply.",
    tooManyConditions: "That filter has too many conditions.",
    dateNeedsBound: "A date condition needs a start or an end.",
  },
  workspaceAddress: {
    empty: "Enter your PURSS's address.",
    notWebAddress: "That doesn't look like a web address.",
    notHttps: "Use the address you open the PURSS at, starting with https://.",
    hasLogin: "Leave the user name and password out of the address.",
    unencryptedRefused: "This address isn't encrypted (http). Use https://, or an address on this device or your local network.",
    unencryptedNote: "This address isn't encrypted (http), so anyone on your network can read what is sent. Use it only on a network you trust.",
  },
};
