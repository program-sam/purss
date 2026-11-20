// App copy: apps/web/src/platform
import connectScreen from "./platform/connect-screen.ts";

// The plural helper keeps the exact current logic for notices the phone apps leave after disconnecting.
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

export default {
  connectScreen,

  badgeOverlay: {
    overflow: "99+",
  },

  desktop: {
    deviceName: "Computer",
    browserSignin: {
      withPasskeys: "Sign in in your browser (passkey or linked account)",
      withoutPasskeys: "Sign in in your browser (passkey or linked account)",
    },
    connectionStillStored: "The connection is still in the credential store.",
    interfaceNotDownloaded: (status: number) => `The interface couldn't be downloaded (${status}).`,
    interfaceNotTheOffer: "The downloaded interface isn't the one on offer.",
    connectFirst: "Connect the app first.",
  },

  desktopFiles: {
    downloadStopped: "The download was stopped.",
  },

  native: {
    deviceName: "Phone or tablet",
    browserSignin: {
      withPasskeys: "Sign in with a linked account (opens a sign-in tab)",
      withoutPasskeys: "Use a passkey or a linked account (opens a sign-in tab)",
    },
    connectFirst: "Connect the app first.",
  },

  audioBackend: {
    untitled: "Playing",
  },

  appUpdates: {
    github: "GitHub",
    googlePlay: "Google Play",
    fdroid: "F-Droid",
    appStore: "the App Store",
  },

  connect: {
    notAPurss: "That address answers, but it isn't a PURSS.",
    cantConnect: "This PURSS can't connect this app. It may need updating.",
    differentPurss: "A different PURSS answered, or it didn't say which it is. Start connecting again.",
    noCode: "PURSS didn't send a connection code. Start connecting again.",
  },

  connectionStore: {
    stillInSecureStorage: "The connection is still in secure storage.",
  },

  files: {
    downloadStopped: "The download was stopped.",
    couldntReadFile: "Couldn't read the file.",
  },

  forget: {
    unsentKept: (n: number) => ` ${plural(n, "Your unsent highlight or note stays", "Your # unsent highlights and notes stay")} on this device and ${plural(n, "is", "are")} sent when you connect again with the same account.`,
    stuck: " The old connection couldn't be removed from this device's secure storage. Connecting again replaces it. If this keeps happening, reinstall the app.",
    disconnected: "This app is disconnected, and everything it kept on this device is removed.",
    unreachable: "Everything this app kept on this device is removed. PURSS couldn't be reached to disconnect it, so remove it in Settings → Connected apps next time you're there.",
    lost: (keptNote: string) => `This app isn't connected to PURSS any more, so what it kept on this device was removed.${keptNote} Connect again to carry on.`,
  },

  passkeys: {
    didntWork: "The passkey didn't work.",
  },

  pushDevice: {
    cantReceive: "This build of the app can't receive notifications.",
    noPushAddress: "The phone didn't hand out a push address in time.",
  },

  push: {
    messages: {
      unavailable: "This build of the app can't receive notifications.",
      workspaceOff: "This PURSS doesn't send phone notifications; its operator has turned them off.",
      otherRelay: "This PURSS sends phone notifications through another relay than this app uses, so they can't reach it.",
      denied: "Notifications for this app are blocked in the phone's settings. Allow them there, then turn this on again.",
      relayDown: "The notification relay couldn't be reached. Try again later.",
    },
  },

  transport: {
    onlyConnectedPurss: "The app only sends requests to the PURSS it is connected to.",
  },
};
