import { parseBundleVersion, parseOffer } from "@purss/domain/app-bundle";
import type { AppBundleOffer } from "@purss/domain/app-bundle";
import type { InterfaceUpdates, InterfaceUpdateState } from "../types.ts";

/*
 * Live updates of the app's interface (plan/39). The connected PURSS offers the build of the interface it
 * runs (GET /api/app/bundle); the app installs it through the updater plugin when it was built for this app's
 * native code (the native level), and, for a server other than the official one, once the person has agreed.
 * Without an offer, or when the person said no, the app goes back to the interface it was installed with.
 *
 * A downloaded interface takes over the next time the app starts, before anything is shown (startQueued), or when
 * the app is shown again after an hour away with nothing playing (a reload would stop the player). The app keeps
 * that queue itself: the plugin's own "next bundle" is installed whenever the app goes to the background. One that
 * doesn't start is rolled back by the plugin and never tried again. Disconnecting goes back to the installed
 * interface straight away and forgets the queue (index.tsx).
 */

/** The updater plugin, as far as this module uses it (index.tsx wraps @capgo/capacitor-updater). */
export interface Updater {
  /** The installed interface's version (bundleVersion form), as the app was built. */
  builtinVersion(): Promise<string>;
  /** The interface running now; id "builtin" for the installed one. */
  current(): Promise<BundleRef>;
  download(options: { url: string; version: string; checksum: string }): Promise<BundleRef>;
  downloaded(): Promise<BundleRef[]>;
  remove(id: string): Promise<void>;
  /** Switch to a downloaded interface, or "builtin", now: the page reloads. */
  apply(id: string): Promise<void>;
  /** The version of an interface that failed to start since last asked (the plugin rolled it back), if any. */
  failed(): Promise<string | null>;
}

export type BundleRef = { id: string; version: string };
export const BUILTIN = "builtin";

export type Consent = "yes" | "no" | null;

export type Target =
  | { kind: "builtin" }
  | { kind: "ask"; offer: AppBundleOffer }
  | { kind: "offer"; offer: AppBundleOffer };

/** Which interface the app should run, given what PURSS offers. */
export function chooseTarget(o: { offer: AppBundleOffer | null; nativeLevel: number | null; failed: readonly string[]; consent: Consent }): Target {
  const { offer } = o;
  if (!offer || o.nativeLevel === null || offer.native !== o.nativeLevel || o.failed.includes(offer.version)) return { kind: "builtin" };
  if (o.consent === "no") return { kind: "builtin" };
  if (o.consent === null) return { kind: "ask", offer };
  return { kind: "offer", offer };
}

/**
 * Whether the server's screens need a newer app than this one: they were made for a higher native level. Not when the
 * person refused this server's updates, since a newer app wouldn't install them either.
 */
export function needsNewerAppFor(offer: AppBundleOffer | null, nativeLevel: number | null, consent: Consent): boolean {
  return !!offer && nativeLevel !== null && offer.native > nativeLevel && consent !== "no";
}

export type KeyValue = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };

/** The queued interface, if it still exists and isn't the one running. */
async function queuedOther(updater: Updater, store: KeyValue): Promise<BundleRef | null> {
  const id = store.get(QUEUE_KEY);
  if (!id) return null;
  const current = await updater.current();
  const found = id === BUILTIN ? { id: BUILTIN, version: "" } : (await updater.downloaded()).find((b) => b.id === id) ?? null;
  if (!found || found.id === current.id) { store.remove(QUEUE_KEY); return null; }
  return found;
}

/** Switch to the queued interface. The queue is cleared first, so one that fails to start isn't tried again and again. */
async function switchTo(updater: Updater, store: KeyValue, id: string): Promise<void> {
  store.remove(QUEUE_KEY);
  await updater.apply(id);
}

/** At start, before anything is shown: switch to the queued interface. True when the page is about to reload. */
export async function startQueued(updater: Updater, store: KeyValue): Promise<boolean> {
  try {
    const queued = await queuedOther(updater, store);
    if (!queued) return false;
    await switchTo(updater, store, queued.id);
    return true;
  } catch {
    return false;
  }
}

/** Forget the queued interface (disconnecting: the next server decides). */
export function forgetQueued(store: KeyValue): void {
  store.remove(QUEUE_KEY);
}

/** Not connected: remove every downloaded interface but the running one (a server's interface outlives no connection). */
export async function removeDownloads(updater: Updater): Promise<void> {
  const current = await updater.current();
  for (const b of await updater.downloaded()) {
    if (b.id !== BUILTIN && b.id !== current.id) await updater.remove(b.id).catch(() => undefined);
  }
}

const CONSENT_KEY = "purss:interface-updates";
const FAILED_KEY = "purss:interface-failed";
/** The interface to switch to at the next safe moment: a downloaded one's id, or "builtin". */
const QUEUE_KEY = "purss:interface-next";
/** How long the app must have been away before a downloaded interface takes over when it is shown again. */
export const AWAY_MS = 60 * 60_000;
/** How often PURSS is asked again while the app is in use. */
export const CHECK_EVERY_MS = 30 * 60_000;

const readJson = <T>(store: KeyValue, key: string, fallback: T): T => {
  try { return (JSON.parse(store.get(key) ?? "null") as T | null) ?? fallback; } catch { return fallback; }
};

export type Deps = {
  origin: string;
  /** The official server: its updates need no question. */
  official: boolean;
  updater: Updater;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Something is playing: reloading the page now would stop it. */
  playing: () => boolean;
  store: KeyValue;
  now: () => number;
  /** How this shell reads PURSS's offer: the desktop app at its own level (plan/42); null means none fits. */
  readOffer?: (offer: AppBundleOffer) => AppBundleOffer | null;
};

export function createInterfaceUpdates(deps: Deps): InterfaceUpdates & {
  check(): Promise<void>;
  /** The app was shown again after `awayMs` hidden. */
  shown(awayMs: number): Promise<void>;
} {
  const listeners = new Set<() => void>();
  let state: InterfaceUpdateState = { official: deps.official, consent: consentOf(), asking: false, needsNewerApp: false };
  let running: Promise<void> | null = null;
  let lastCheck = -Infinity;

  function consentOf(): Consent {
    if (deps.official) return "yes";
    return readJson<Record<string, Consent>>(deps.store, CONSENT_KEY, {})[deps.origin] ?? null;
  }
  function setState(next: Partial<InterfaceUpdateState>): void {
    state = { ...state, ...next };
    for (const l of listeners) l();
  }

  async function failedVersions(): Promise<string[]> {
    const failed = readJson<string[]>(deps.store, FAILED_KEY, []);
    const latest = await deps.updater.failed().catch(() => null);
    if (latest && !failed.includes(latest)) {
      failed.push(latest);
      deps.store.set(FAILED_KEY, JSON.stringify(failed.slice(-10)));
    }
    return failed;
  }

  /** PURSS's offer: null when it has none; undefined when it couldn't be asked (try again later). */
  async function askWorkspace(): Promise<AppBundleOffer | null | undefined> {
    try {
      const res = await deps.fetch(`${deps.origin}/api/app/bundle`, { credentials: "omit", signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (!res.ok) return undefined;
      const offer = parseOffer(await res.json());
      return offer && deps.readOffer ? deps.readOffer(offer) : offer;
    } catch {
      return undefined;
    }
  }

  /** Remove downloaded interfaces other than the ones given. */
  async function tidy(keep: (string | undefined)[]): Promise<void> {
    for (const b of await deps.updater.downloaded().catch(() => [])) {
      if (b.id !== BUILTIN && !keep.includes(b.id)) await deps.updater.remove(b.id).catch(() => undefined);
    }
  }

  async function run(): Promise<void> {
    lastCheck = deps.now();
    const failed = await failedVersions();
    const offer = await askWorkspace();
    if (offer === undefined) return;
    const nativeLevel = parseBundleVersion(await deps.updater.builtinVersion())?.native ?? null;
    const target = chooseTarget({ offer, nativeLevel, failed, consent: consentOf() });
    const needsNewerApp = needsNewerAppFor(offer, nativeLevel, consentOf());
    if (target.kind === "ask") { setState({ asking: true, consent: null, needsNewerApp }); return; }
    setState({ asking: false, consent: consentOf(), needsNewerApp });
    const current = await deps.updater.current();
    const queued = await queuedOther(deps.updater, deps.store);
    const queue = (id: string | null) => { if (id) deps.store.set(QUEUE_KEY, id); else deps.store.remove(QUEUE_KEY); };
    if (target.kind === "builtin") {
      queue(current.id === BUILTIN ? null : BUILTIN);
      await tidy([current.id]);
      return;
    }
    const { offer: o } = target;
    if (current.version === o.version) { queue(null); await tidy([current.id]); return; }
    if (queued?.version === o.version) { await tidy([current.id, queued.id]); return; }
    const url = new URL(o.path, deps.origin).toString();
    const got = await deps.updater.download({ url, version: o.version, checksum: o.checksum });
    queue(got.id);
    await tidy([current.id, got.id]);
  }

  async function check(): Promise<void> {
    if (!running) running = run().catch(() => undefined).finally(() => { running = null; });
    return running;
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async answer(allow) {
      const all = readJson<Record<string, Consent>>(deps.store, CONSENT_KEY, {});
      all[deps.origin] = allow ? "yes" : "no";
      deps.store.set(CONSENT_KEY, JSON.stringify(all));
      // Refused: a newer app wouldn't install this server's screens either, so stop asking for one now, not at the next check.
      setState({ consent: allow ? "yes" : "no", asking: false, ...(allow ? {} : { needsNewerApp: false }) });
      // A check already running decided with the old answer: let it finish, then decide again with the new one.
      if (running) await running;
      await check();
    },
    check,
    async shown(awayMs) {
      if (awayMs >= AWAY_MS && !deps.playing()) {
        const queued = await queuedOther(deps.updater, deps.store).catch(() => null);
        if (queued) { await switchTo(deps.updater, deps.store, queued.id); return; }
      }
      if (deps.now() - lastCheck >= CHECK_EVERY_MS) await check();
    },
  };
}
