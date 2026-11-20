// Server copy: apps/api/src/services/activity.ts
export default {
  pausedUntil: (date: string) => `Paused until ${date}`,
  paused: "Paused",
  settingUp: "Setting up…",
  waitingForFirstItems: "Waiting for its first items",
  startedFollowing: (title: string) => `Started following ${title}`,
  sourceProblem: (title: string, healthText: string | null) => `${title}: ${healthText ?? "couldn't be collected"}`,
  arrived: (n: number, title: string) => `${n === 1 ? "1 new item" : `${n} new items`} from ${title}`,
  savedText: (n: number) => `Saved the text of ${n === 1 ? "1 item" : `${n} items`}`,
  couldNotSaveText: (n: number) => `Couldn't save the text of ${n === 1 ? "1 item" : `${n} items`}`,
};
