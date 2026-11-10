import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sortable, URL-safe identifier: 10 chars of millisecond time + 16 random chars. */
export function newId(prefix: string, now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${time}${rand}`;
}

export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== "string") return false;
  const re = prefix ? new RegExp(`^${prefix}_[0-9a-z]{26}$`) : /^[a-z]{1,8}_[0-9a-z]{26}$/;
  return re.test(value);
}
