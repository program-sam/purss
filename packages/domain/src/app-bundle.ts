/*
 * Live updates of the apps' interface (the phones, plan/39; the desktop app, plan/42). Every PURSS offers the build of the interface it
 * runs to the apps connected to it; an app installs it when it fits the app's native code (and, for a server
 * other than the official one, once the person has agreed). No dependencies, so the web build, the server
 * and the packing script can all import it.
 */

/**
 * Which build of the interface: the phone apps' native code it needs (`native`), the desktop app's (`desktop`,
 * plan/42; absent in builds from before the desktop app), and when it was made (seconds).
 */
export type AppBuild = { native: number; built: number; desktop?: number };

/** What `GET /api/app/bundle` answers when PURSS has a build of the interface for the apps. */
export type AppBundleOffer = AppBuild & {
  /** bundleVersion() of native and built. */
  version: string;
  /** Where the zip is, on the same PURSS. */
  path: string;
  /** The zip's SHA-256 (hex); the plugin checks it before installing. */
  checksum: string;
  /** The zip's size in bytes. */
  size: number;
};

/**
 * The version string of a build: `native.built.0`. The updater plugin reads the app's own (built-in) version
 * as a semantic version, so the same form is used for every build.
 */
export const bundleVersion = (b: AppBuild): string => `${b.native}.${b.built}.0`;

export function parseBundleVersion(version: string): AppBuild | null {
  const m = /^(\d{1,4})\.(\d{1,12})\.0$/.exec(version);
  return m ? { native: Number(m[1]), built: Number(m[2]) } : null;
}

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/** An offer as received, or null when anything in it is missing or malformed. */
export function parseOffer(value: unknown): AppBundleOffer | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (!isInt(o.native, 1) || !isInt(o.built, 1) || !isInt(o.size, 1)) return null;
  if (o.version !== bundleVersion({ native: o.native, built: o.built })) return null;
  if (typeof o.path !== "string" || !/^\/api\/app\/bundle\/[\w.-]+\.zip$/.test(o.path)) return null;
  if (typeof o.checksum !== "string" || !/^[0-9a-f]{64}$/.test(o.checksum)) return null;
  return { version: o.version, native: o.native, built: o.built, path: o.path, checksum: o.checksum, size: o.size, ...(isInt(o.desktop, 1) ? { desktop: o.desktop } : {}) };
}

/**
 * An offer as the desktop app reads it: the same build, its `native` the desktop level and its version spelled with
 * it, so the rules of live updates apply unchanged. Null when the build names no desktop level: the desktop then
 * keeps the interface it was installed with.
 */
export function desktopOffer(offer: AppBundleOffer): AppBundleOffer | null {
  if (!offer.desktop) return null;
  return { ...offer, native: offer.desktop, version: bundleVersion({ native: offer.desktop, built: offer.built }) };
}
