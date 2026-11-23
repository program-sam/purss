// App copy: Signing in and up, the account, the phone and desktop apps, and downloads (apps/web/src: auth, features/account, platform, downloads).
import { words } from "./words.ts";
// The plural helper keeps the exact current logic for notices the phone apps leave after disconnecting.
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

export default {
  auth: {
    accountEmailSection: {
      noAddress: "No address yet.",
      signInWithIt: "You sign in with it.",
      addressStatus: (confirmed: boolean) => ` · ${confirmed ? "confirmed" : "not confirmed yet"}`,
      emailedAbout: "We email it only about your account, such as password resets, and with your digest of what's new, which you can turn off under Notifications and New. No newsletters or marketing.",
      selfHostedNoEmail: "This PURSS doesn't send email, so nothing is sent to it.",
      unavailable: "Email isn't available for this service yet.",
      waitingToConfirm: (pending: string, address: string) => `Waiting for you to confirm ${pending}. You still sign in with ${address} until then.`,
      changeAddress: "Change address",
      addAddress: "Add an address",
      sendLinkAgain: "Send the link again",
      confirmWithLink: {
        label: "Confirm with the link from the email",
        confirm: "Confirm",
      },
      newAddress: {
        label: "New email address",
        hint: "We'll email a link to confirm it",
      },
      toasts: {
        linkSent: "We sent a link to confirm it",
        saved: "Email address saved",
        confirmed: "Email address confirmed",
        newLinkSent: "We sent a new link",
      },
    },

    authFrame: {
      documentTitle: (title: string) => `${title} · PURSS`,
    },

    emailLinks: {
      verify: {
        title: "Confirm your email address",
        needsLink: "This page needs the link from the email.",
        confirming: "Confirming…",
        confirmed: "Your email address is confirmed. It is the one you sign in with, and messages about your account go there.",
        signInPrompt: "Sign in with your email address and password, or a passkey.",
      },
      reset: {
        passwordsDontMatch: "The two passwords don't match.",
        askTitle: "Reset your password",
        askIntro: "Enter your email address. If it has an account, we'll send a link to choose a new password.",
        sent: "If that email address has an account, we've sent a link. It works once, for an hour. Check your spam folder.",
        backToSignIn: "Back to sign in",
        sendLink: "Send a link",
        administratorsGetLink: "Administrators get a reset link from the operator tool instead.",
        chooseTitle: "Choose a new password",
        changed: "Your password is changed. You were signed out on every device; sign in again with your new password.",
        newPasswordHint: "10+ characters",
      },
    },

    headerAccount: {
      signingOut: "Signing out…",
    },

    passkeyStep: {
      cancelled: "The passkey wasn't added. You can try again whenever you like.",
      exists: "This device already has a passkey for PURSS.",
      couldntSetUp: "This browser or device couldn't set up a passkey.",
      intro: "Add a passkey: your fingerprint, face or screen lock (Touch ID, Face ID, Windows Hello) or a password manager signs you in from then on. Your password keeps working.",
      skip: "Skip for now",
      later: "You can add one later in Settings → Security.",
    },

    passwordForm: {
      minCharacters: (min: number) => `${min}+ characters`,
      passwordAgain: "Password again",
      different: "The two passwords are different.",
      sameAsEmail: "The password can't be the same as your email address.",
      currentPassword: "Current password",
    },

    providerButton: {
      continueWith: (label: string) => `Continue with ${label}`,
    },

    setup: {
      setupTitle: "Set up your PURSS",
      inviteTitle: "Accept your invitation",
      setupIntro: "Enter the setup code from the server. It was printed when the server started and is saved in the secrets folder of its data directory.",
      inviteIntro: "Enter the invitation code you were sent, and the email address it was sent to, to create your account.",
      setupCode: "Setup code",
    },

    signIn: {
      passkeyFailed: "Sign-in failed. Try again, or use your password.",
      deletionNotice: (date: string) => `Your account will be deleted on ${date}. Sign in before then to keep it.`,
      tookTooLong: "That took too long. Sign in again to keep your account.",
      keepTitle: "Keep your account?",
      intro: "Follow your sources. Keep what matters.",
      passkeyHint: "Your fingerprint, face or screen lock (Touch ID, Face ID, Windows Hello) or a password manager.",
      reset: { before: "Can't sign in? ", link: "Reset your password by email" },
      askAdministrator: "Can't sign in? Ask your PURSS administrator for a password reset link.",
      useInvitation: { link: "Use an invitation" },
    },

    signup: {
      checkInboxTitle: "Check your inbox",
      sentTo: (email: string) => `Check your inbox: we sent a link to finish creating your account to ${email}.`,
      spamHint: "If you don't see it, look in your spam folder. The link works once.",
      createIntro: "Enter your email address. We'll send you a link to finish creating your account, and you'll sign in with that address.",
      orMakeAccount: "Or make an account with your email address:",
      checkingLink: "Checking your link…",
      finishTitle: "Finish creating your account",
      finishIntro: "Choose a password to finish. You'll sign in with this email address and that password.",
      creating: "Creating your account…",
      create: "Create my account",
    },

    newAccount: {
      passkeyTitle: "Sign in without typing a password",
    },

    oidcErrors: {
      deleting: "This account is being deleted. It can't be signed in to or kept any more.",
      emailInUse: (label?: string) => `An account with this email address already exists. Sign in with your email address and password, then connect ${label ?? "it"} in Settings → Security.`,
      emailUnverified: (label?: string) => `${label ?? "The provider"} didn't give PURSS a verified email address, so an account can't be made from it.`,
      notLinked: (label?: string) => `That ${label ?? "external"} account isn't connected to an account here. Sign in another way and connect it in Settings → Security first.`,
      signupFull: "New accounts are full for now. Try again later.",
      signupRateLimited: "Too many attempts to make an account from this address. Try again later.",
      didntWork: "That sign-in didn't work. Try again, or use another way in.",
    },

    providerConfirm: {
      notFinished: "That wasn't finished in the browser. Try again.",
      confirmed: (label: string) => `Confirmed with ${label}. You can go ahead and do that again now.`,
      notConfirmed: (label: string) => `${label} didn't confirm it's you. Try again, or use another way.`,
    },

    retry: {
      tryAgainAfter: (time: string, day: string) => `Try again after ${time}${day}`,
      tomorrow: " tomorrow",
      onDate: (date: string) => ` on ${date}`,
    },
  },
  account: {
    deleteAccount: {
      dialogTitle: "Delete your account?",
      deleting: "Deleting…",
      afterSevenDays: "After 7 days this is deleted for good: your sources, collections, baskets and everything kept in them, highlights and notes, reading history, shared pages and sign-in methods.",
      signedOutEverywhere: "You're signed out everywhere now. Phone apps, the browser extension and assistants are disconnected. To keep the account, sign in within 7 days.",
      copyFirst: "Want a copy first? The export has everything you kept and can be imported into another PURSS.",
      exportAgain: "Export again",
      exportFirst: "Export first",
      typeDelete: "Type delete to confirm",
      typeName: (name: string) => `Type your name, ${name}, to confirm`,
      section: {
        hint: "Deletes your PURSS and everything in it after 7 days. Sign in before then to keep it.",
        lastAdministrator: " The last administrator can't delete their account until someone else is an administrator.",
        button: "Delete account…",
      },
    },
    keepAccount: {
      beingDeleted: (date: string) => `This account is set to be deleted on ${date}. Keep it to sign in and carry on where you left off.`,
      leave: "Leave it",
      sharedPagesOff: "Your shared pages stay switched off until you share them again.",
    },
    planTab: {
      plusLede: "For people who follow a lot, and keep a lot.",
      plusHas: ["1,000 sources", "Unlimited collections", "Share baskets and collections as public pages"],
      proLede: "For busy feeds you want curated for you.",
      proHas: ["5,000 sources", "Everything in Plus", "Smart filters: plain-language rules for what you want to see"],
      noLimitsSelf: "No limits are set on this PURSS.",
      planUnavailable: "Your plan isn't available yet.",
      yourPlan: (plan: string) => `Your plan: ${plan}`,
      unlimitedCollections: ", unlimited collections",
      collectionsOf: (used: number, limit: number) => `, ${used} of ${limit} collections`,
      keptLinks: "Kept links don't count as sources.",
      noLimits: "Your account has no limits.",
      administratorSetsPlans: "The administrator of this PURSS sets plans.",
      paidUnavailable: "Paid plans aren't available yet.",
      yearly: (save: number) => `Yearly, save ${save}%`,
      monthly: "Monthly",
      aMonth: " a month",
      billedYearly: (amount: string) => `Billed yearly as ${amount}`,
      billedMonthly: "Billed monthly",
      vatIncluded: ", VAT included.",
      opening: "Opening…",
      choose: (plan: string) => `Choose ${plan}`,
      payments: "Payments are handled by Stripe. Cancel any time; your sources, baskets and exports stay yours on Free.",
      manage: "Manage plan and payments",
      manageHint: "Change plan, update your card, see invoices or cancel. If you cancel, your plan stays until the end of the period you paid for, then moves to Free. Nothing you follow or keep is removed.",
    },
  },
  platform: {
    connectScreen: {
      declined: "You chose not to connect this app.",
      notAccepted: "PURSS didn't accept the connection. Start again.",
      finishUnreachable: "Couldn't reach PURSS to finish connecting. Check your connection and start again.",
      didntAnswer: "PURSS didn't answer properly. Try again later.",
      unreachableAddress: "Couldn't reach that address. Check it, and that this device is online.",
      unreachable: "Couldn't reach PURSS. Check that this device is online and try again.",
      signInNotStarted: "PURSS didn't start the sign-in. Try again.",
      passkeyRefused: "That didn't sign you in. Try your passkey again, or use your password.",
      passkeyUnsupported: "This phone couldn't use fingerprint, face or screen lock for this PURSS.",
      tooManyAttempts: "Too many attempts. Wait a while and try again.",
      notSignedIn: "PURSS didn't sign you in. Try again.",
      cantReach: "Couldn't reach PURSS. Check your connection and try again.",
      passwordNotSet: "PURSS didn't set the new password. Ask for a new link and try again.",
      tooManyRequests: "Too many requests. Wait a while and try again.",
      requestNotTaken: "PURSS didn't take the request. Try again.",
      accountNotCreated: "PURSS didn't create the account. Try again.",
      browserNotOpened: "Couldn't open the browser. Try again.",

      serverLine: {
        link: "Use another PURSS",
      },

      titles: {
        connect: "Connect to your PURSS",
      },
      addressIntro: "Type the address of your own PURSS, or of another hosted one.",

      address: {
        label: "PURSS address",
        hint: "e.g. purss.example.org",
        placeholder: "purss.example.org",
        useOfficial: (host: string) => `Use the official PURSS (${host})`,
      },
      opening: "Opening your PURSS…",
      waiting: {
        approve: "Waiting for you to approve this app in the browser…",
        steps: "Sign in if asked, check that it names this device, then press Connect. You'll return here by yourself.",
        openAgain: "Open the browser again",
      },
      connecting: "Connecting…",

      signupForm: {
        sentTo: (email: string) => `Check your inbox: we sent a link to finish creating your account to ${email}.`,
        openLink: "Open the link on this device. It finishes in your browser; then come back here and sign in with that email address and the password you chose.",
        providersNote: "Opens in your browser. Or make an account here with an email address:",
        invitationHint: "Or paste the invitation link",
        linkEmailHint: "We'll email you a link",
        withEmailInstead: "Sign up with an email address instead",
        haveInvitation: "I have an invitation code",
        nameLabel: "Your name (optional)",
        minCharacters: (min: number) => `${min}+ characters`,
        creating: "Creating…",
        createAccount: "Create account",
        passkeyLater: "You can add a passkey later, under Settings → Security.",
      },

      signinForm: {
        deletionDue: (date: string) => `This account is set to be deleted on ${date}. Keep it, and nothing is deleted.`,
        keeping: "Keeping…",
        resetSent: "If that email address has an account, a link to set a new password is on its way.",
        linkLabel: "The link from the email",
        minCharacters: (min: number) => `${min}+ characters`,
        setNewPassword: "Set the new password",
        resetDone: "Your new password is set. Sign in with it.",
        resetHint: "We'll email a reset link",
        signingIn: "Signing in…",
        sendLink: "Send the link",
        useEmailAndPassword: "Use an email address and password",
        forgotPassword: "Forgot your password?",
        haveLink: "I already have a link",
      },
    },

    desktop: {
      deviceName: "Computer",
      connectionStillStored: "The connection is still in the credential store.",
      interfaceNotDownloaded: (status: number) => `The interface couldn't be downloaded (${status}).`,
      interfaceNotTheOffer: "The downloaded interface isn't the one on offer.",
      browserSignin: {
        withPasskeys: words.signInInYourBrowserPasskey,
        withoutPasskeys: words.signInInYourBrowserPasskey,
      },
    },

    native: {
      deviceName: "Phone or tablet",
      browserSignin: {
        withPasskeys: "Sign in with a linked account (opens a sign-in tab)",
        withoutPasskeys: "Use a passkey or a linked account (opens a sign-in tab)",
      },
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
      cantConnect: "This PURSS can't connect this app. It may need updating.",
      differentPurss: "A different PURSS answered, or it didn't say which it is. Start connecting again.",
      noCode: "PURSS didn't send a connection code. Start connecting again.",
    },

    connectionStore: {
      stillInSecureStorage: "The connection is still in secure storage.",
    },

    files: {
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
      noPushAddress: "The phone didn't hand out a push address in time.",
    },

    push: {
      messages: {
        unavailable: words.thisBuildOfTheAppCan,
        purssOff: "This PURSS doesn't send phone notifications; its operator has turned them off.",
        otherRelay: "This PURSS sends phone notifications through another relay than this app uses, so they can't reach it.",
        denied: "Notifications for this app are blocked in the phone's settings. Allow them there, then turn this on again.",
        relayDown: "The notification relay couldn't be reached. Try again later.",
      },
    },

    transport: {
      onlyConnectedPurss: "The app only sends requests to the PURSS it is connected to.",
    },
  },
  downloads: {
    deviceTab: {
      otherWords: (n: number) => n === 1 ? "1 highlight or note" : `${n} highlights or notes`,
      unsyncedLost: (n: number) => ` ${n === 1 ? "1 highlight or note hasn't" : `${n} highlights or notes haven't`} synced yet and will be lost.`,
      disconnectConfirm: (warn: string) => `Disconnect this app from PURSS? Everything it keeps on this device, downloads included, is removed.${warn}`,
      copied: (words: string) => `Copied ${words} as text.`,
      copyFailed: "Couldn't copy to the clipboard.",
      discardConfirm: (words: string) => `Discard ${words} written with another account? They haven't been sent, so they will be lost.`,
      discarded: "Discarded.",
      otherHeading: "Unsent from another account",
      otherNote: (words: string, n: number) => `${words} from another account ${n === 1 ? "hasn't" : "haven't"} been sent. ${n === 1 ? "It'll be" : "They'll be"} sent if that account connects this app again. You can copy ${n === 1 ? "it" : "them"} as text or discard ${n === 1 ? "it" : "them"}.`,
      copyAsText: "Copy as text",
      discard: "Discard",
      connectionHeading: "Connection",
      connectedTo: {
        official: ", the official PURSS",
        after: ". To connect another PURSS, disconnect this app below and choose it when you connect again.",
      },
      toRead: "To read podcast episodes",
      wifiOnly: "Only on Wi-Fi",
      wifiOnlyHint: "Downloads you start yourself always go ahead.",
      stopAt: "Stop automatic downloads at",
      removeFinished: "Remove downloads when finished",
      removeFinishedHint: "Once an item is marked Finished or Ignored, or played to the end, its download is removed from this device. Nothing changes in your PURSS.",
      automaticOnComputer: "Automatic downloads happen while the app is running, also with its window closed.",
      automaticOnPhone: "Automatic downloads happen while the app is open, and while it is closed about once an hour, when the phone allows it (battery and storage not low).",
      storageHeading: "Storage on this device",
      storageUse: { before: "Downloads use ", after: " on this device." },
      removedAll: "Removed every download from this device.",
      removeAll: "Remove all downloads",
      unsyncedWarning: (n: number) => `${n === 1 ? "1 highlight or note hasn't" : `${n} highlights or notes haven't`} synced yet. Disconnecting deletes ${n === 1 ? "it" : "them"}. Go online first to keep ${n === 1 ? "it" : "them"}.`,
      disconnect: "Disconnect this app",
    },

    downloadSection: {
      progressSoFar: (bytes: string) => ` ${bytes}`,
      progressOf: (bytes: string, total: string, percent: number) => ` ${bytes} of ${total} (${percent}%)`,
      whatMedia: (kind: "video" | "audio", size: string | null) => `its text, your highlights and notes, and the ${kind === "video" ? "video" : "audio"} file${size !== null ? ` (about ${size})` : ""}`,
      whatPage: "the full article (your PURSS has only the summary, so it's read from the publisher's page) and your highlights and notes",
      whatText: "its text and your highlights and notes",
      fromPublisherFile: " The file comes straight from the publisher, who sees this device's address.",
      fromPublisherPage: " The page comes straight from the publisher, who sees this device's address.",
      downloadedToast: (bytes: string) => `Downloaded to this device · ${bytes}`,
      downloadedFullArticle: "Downloaded the full article to this device.",
      downloadedSummaryOnly: "Downloaded to this device, still with the summary only.",
      removedToast: (freed: string | null) => `Removed the download from this device${freed !== null ? `, freeing ${freed}` : ""}. Nothing changed in your PURSS.`,
      queuedResume: "Waiting to go on downloading from where it stopped.",
      queuedNew: "Waiting to download, after the download in progress.",
      leaveQueue: "Take out of the queue",
      offer: (what: string, andPlay: boolean, fromWhere: string) => `Download ${what} to read${andPlay ? " and play" : ""} offline.${fromWhere} Downloads stay on this device.`,
      download: "Download to this device",
      downloading: "Downloading to this device…",
      stop: "Stop download",
      notDownloaded: "Not downloaded.",
      didntFinish: "The download didn't finish.",
      downloaded: (auto: boolean) => `Downloaded to this device${auto ? " automatically" : ""}`,
      savedLine: (bytes: string, how: string) => `${bytes} · ${how} without a connection. `,
      playsAndReads: "plays and reads",
      articleReads: "the full article, shown below, reads",
      reads: "reads",
      allDownloads: "All downloads",
      remove: "Remove download",
      onlySummary: "Only the summary was saved.",
    },

    downloadedTag: {
      title: "Downloaded to this device. It works without a connection.",
    },

    downloadsPage: {
      lead: "Items saved on this device for reading and listening offline.",
      deviceSection: "On this device",
      downloadSettings: "Download settings",
      downloads: "Downloads",
      none: "None yet",
      automaticOn: (wifiOnly: boolean, limit: string) => `On${wifiOnly ? ", on Wi-Fi only" : ""}, up to ${limit}`,
      copyNote: "A download is a copy on this device. PURSS keeps no audio or video files, so if the publisher removes one, your download may be the only copy. Removing a download never changes your PURSS.",
      untitled: "Untitled",
      sourcePrefix: (source: string) => `${source} · `,
      doneLine: (bytes: string, media: "video" | "audio" | null, auto: boolean, ago: string) => `${bytes}${media !== null ? `, with its ${media === "video" ? "video" : "audio"}` : ""} · ${auto ? "automatic, " : ""}${ago || "just now"}`,
      notDownloaded: (error: string | null | undefined) => `Not downloaded: ${error ?? "the download didn't finish."}`,
      removedToast: "Removed the download from this device.",
      stop: "Stop",
      empty: "Nothing downloaded yet. Open an item and choose Download to this device, or turn on automatic downloads.",
    },

    manager: {
      tooLargeAuto: "The file is bigger than the space left in this device's automatic download limit.",
      notSecure: "The publisher doesn't offer this file over a secure connection, so it can't be downloaded.",
      stoppedEarly: "The download stopped before it finished. Check your connection and try again.",
      fileGone: "The file isn't available there any more.",
      refused: "The file's address refused the download.",
      didntFinish: "The download didn't finish. Try again later.",
      itemGone: "This item isn't in your PURSS any more.",
      pageGone: "The publisher's page isn't there any more.",
      pageNeedsLogin: "The publisher's page needs a login or turns apps away.",
      pageUnreachable: "Couldn't reach the publisher's page. Check your connection and try again.",
      pageNotFetched: "The publisher's page couldn't be fetched.",
      tooLarge: (gb: number) => `The file is over ${gb} GB, the most this app downloads.`,
      pageTooLarge: "The publisher's page is too large to read.",
    },

    readablePage: {
      noArticle: "No readable article was found on the publisher's page. It may need JavaScript or a login.",
      tooLong: "The article is longer than a download keeps.",
    },
  },
};
