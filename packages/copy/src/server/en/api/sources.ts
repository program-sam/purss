// Server copy: apps/api/src/services/sources.ts
export default {
  noPostsYet: "No posts yet. Still following; new posts will appear here.",
  reconnectRequired: "Reconnect required: this private source needs its link again.",
  pausedUntilNote: (until: string) => `Paused until ${until}. Nothing new is collected until then.`,
  pausedNote: "Paused. Nothing new is collected until you resume it.",
  noNewPosts: (days: number) => `No new posts for ${days} days. Still following.`,
  workingNoRetry: "This source is working, so there is nothing to retry.",
  linkMissing: "This source's link is missing. Remove it and add it again.",
  fullArticlesUnavailable: "Full articles can't be fetched for this kind of source.",
  noOwnLink: "This source has no link of its own to keep private.",
  needsLinkAgain: "This source needs its link again before it can be made public. Reconnect it first.",
  stillSettingUp: "This source is still being set up. Try again in a minute.",
  feedUnreachable: "The feed couldn't be reached to check what it is, so its link stays private. Try again later.",
};
