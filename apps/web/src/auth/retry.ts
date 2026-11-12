/** When a refused request may be tried again, in a person's words: "Try again after 14:05", with "tomorrow" or the date when that isn't today. */
export function tryAgainAfter(seconds: number, now = new Date()): string {
  const retryAt = new Date(now.getTime() + seconds * 1000);
  const dateKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = dateKey(retryAt) === dateKey(now) ? ""
    : dateKey(retryAt) === dateKey(tomorrow) ? " tomorrow"
    : ` on ${retryAt.toLocaleDateString()}`;
  return `Try again after ${retryAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}${day}`;
}
