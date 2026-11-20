// App copy: apps/web/src/player
export default {
  bar: {
    openItem: "Open this item",
    sleepTimer: "Sleep timer",
    off: "Off",
    inMinutes: (minutes: number) => `In ${minutes} minutes`,
    minutes: " min",
  },
  media: {
    watch: "Watch",
    listen: "Listen",
    pause: "Pause",
    continue: "Continue",
    from: (word: string, time: string) => `${word} from ${time}`,
    onDevice: "Plays the download on this device, with or without a connection.",
    streams: "Streams from the publisher's site, which sees your address, like images do.",
  },
  source: {
    device: "Playing the download on this device",
    publisher: "Streaming from the publisher",
  },
  errors: {
    deviceFailed: "The download on this device couldn't be played. Remove it and download it again.",
    publisherFailed: "The publisher's file couldn't be played here. It may have moved, or need the publisher's own app.",
    notSecure: "The publisher doesn't offer this file over a secure connection, so it can't be played here.",
  },
  quickDownload: {
    queued: "Queued: it downloads after the one in progress.",
    downloading: "Downloading to this device.",
    failed: (reason: string) => `Download failed: ${reason}`,
    didntFinish: "it didn't finish.",
  },
};
