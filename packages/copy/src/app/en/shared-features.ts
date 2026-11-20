// App copy: apps/web/src/features/shared
export default {
  bits: {
    loading: "Loading…",
    loadFailedTitle: (what: string) => `Couldn't load ${what}`,
    tryAgain: "Try again",
    copied: (what: string) => `${what} copied`,
    couldntCopy: (what: string) => `Couldn't copy ${what}. Select it and copy by hand.`,
    copiedButton: "Copied",
    copy: "Copy",
  },
  stepUp: {
    yourPassword: "Your password",
    confirmWithPassword: "Confirm with password",
    confirmWithPasskey: "Confirm with a passkey",
    confirmWithProvider: (provider: string) => `Confirm with ${provider}`,
    dialogTitle: "Confirm it's you",
    cancel: "Cancel",
    hint: "For your safety, confirm it's you before this change. Nothing has been changed yet.",
  },
  download: {
    serverFailure: "Something went wrong on our side. Nothing was changed; please try again.",
    didntWork: "That didn't work. Please try again.",
    offline: "Can't reach PURSS right now. Check your connection and try again.",
    interrupted: "The download was interrupted before it finished, so nothing was saved. Please try again.",
  },
};
