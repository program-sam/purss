/*
 * The product's version number (plan/40): one number per commit on main, from the date it was made, for
 * telling builds apart in reports, compatibility notes and update posts. Seven digits:
 *
 *   2631214 = 26 (the year) + 312 (the day of the year, UTC) + 14 (that day's 14th commit on main)
 *
 * Fixed width, so the numbers never repeat and always grow, which app stores require of build numbers.
 * A day has room for 99; later commits that day share 99. No dependencies, so every app and script can
 * import it.
 */

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function dayOfYear(at: Date): number {
  return Math.floor((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(at.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

/** The version of the `nth` commit (1-based) on main on the UTC day of `committedAt`. */
export function versionOf(committedAt: Date, nth: number): string {
  const n = Math.min(Math.max(Math.trunc(nth), 1), 99);
  return `${pad(committedAt.getUTCFullYear() % 100, 2)}${pad(dayOfYear(committedAt), 3)}${pad(n, 2)}`;
}

export type VersionParts = { year: number; day: number; nth: number };

export function parseVersion(version: string): VersionParts | null {
  const m = /^(\d{2})(\d{3})(\d{2})$/.exec(version);
  if (!m) return null;
  const parts = { year: 2000 + Number(m[1]), day: Number(m[2]), nth: Number(m[3]) };
  return parts.day >= 1 && parts.day <= 366 && parts.nth >= 1 ? parts : null;
}

/** The UTC day a version was made on. */
export function versionDay(version: string): Date | null {
  const p = parseVersion(version);
  return p ? new Date(Date.UTC(p.year, 0, p.day)) : null;
}

/**
 * The same version as three dotted numbers (26.312.14), for the stores that limit each part: Chrome's
 * extension store (at most 65535 each) and Apple's version strings (at most three parts).
 */
export function dottedVersion(version: string): string | null {
  const p = parseVersion(version);
  return p ? `${p.year % 100}.${p.day}.${p.nth}` : null;
}

/** A version as an app store spells it (26.312.14, or already 2631214), back in its plain form; null when it isn't one. */
export function plainVersion(spelled: string): string | null {
  if (parseVersion(spelled)) return spelled;
  const m = /^(\d{1,2})\.(\d{1,3})\.(\d{1,2})$/.exec(spelled);
  if (!m) return null;
  const plain = `${m[1]!.padStart(2, "0")}${m[2]!.padStart(3, "0")}${m[3]!.padStart(2, "0")}`;
  return parseVersion(plain) ? plain : null;
}

/** What a build knows about itself: its version and the commit it was built from. */
export type BuildVersion = { version: string; commit: string; committedAt: string };
