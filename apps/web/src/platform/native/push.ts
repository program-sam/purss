import type { PushInfo, PushRegisterResult } from "@purss/domain";
import type { PushStatus } from "../types.ts";

/*
 * Notifications on this phone (plan/37), apart from the device APIs, so the rules can be tested without
 * a phone. The phone's push address (an FCM token on Android, an APNs token on iOS) goes to the push relay
 * only, which answers with a handle; PURSS gets that handle and answers with a fetch credential,
 * which goes to the native notification code (Android's messaging service, iOS's notification service
 * extension) so it can fetch the texts when the relay wakes the phone. Nothing is asked of the person
 * until they turn the setting on.
 */

export type PushPermission = "granted" | "denied" | "prompt";

export type PushDeps = {
  platform: "fcm" | "apns";
  /** The relay this build registers with (the project's, or a local one in a debug build). */
  relay: string;
  /** Whether this build can receive pushes at all (Android needs its Firebase setup). */
  ready: boolean;
  store: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
  /** PURSS's API with the device token. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  /** A POST to the relay; resolves with the HTTP status and JSON body. */
  relayPost(path: string, body: unknown): Promise<{ status: number; json: unknown }>;
  permission(): Promise<PushPermission>;
  /** Shows the system's prompt when it hasn't been answered yet. */
  requestPermission(): Promise<PushPermission>;
  /** The phone's push address; rejects when the system won't give one. */
  token(): Promise<string>;
  setTarget(fetchToken: string): Promise<void>;
  clearTarget(): Promise<void>;
  randomScope(): string;
};

const KEY = "purss:push";
/** `unsent`: turned off while PURSS or relay couldn't be told; they are told at the next start. */
type Saved = { on: boolean; scope: string; handle: string | null; unsent?: boolean };

export const PUSH_MESSAGES = {
  unavailable: "This build of the app can't receive notifications.",
  workspaceOff: "This PURSS doesn't send phone notifications; its operator has turned them off.",
  otherRelay: "This PURSS sends phone notifications through another relay than this app uses, so they can't reach it.",
  denied: "Notifications for this app are blocked in the phone's settings. Allow them there, then turn this on again.",
  relayDown: "The notification relay couldn't be reached. Try again later.",
} as const;

export class PushController {
  #d: PushDeps;
  #busy: Promise<unknown> = Promise.resolve();
  constructor(deps: PushDeps) { this.#d = deps; }

  #saved(): Saved | null {
    try {
      const v = JSON.parse(this.#d.store.get(KEY) ?? "null") as Saved | null;
      return v && typeof v.scope === "string" ? v : null;
    } catch { return null; }
  }
  #save(v: Saved): void { this.#d.store.set(KEY, JSON.stringify(v)); }

  /** One change at a time: a tap on the switch and a start-up refresh never interleave. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#busy.then(work, work);
    this.#busy = next.catch(() => undefined);
    return next;
  }

  /** PURSS's answer, or why the phone can't get notifications from it. */
  async #check(): Promise<{ info: PushInfo } | PushStatus> {
    if (!this.#d.ready) return { state: "unavailable", detail: PUSH_MESSAGES.unavailable };
    const info = await this.#d.api<PushInfo>("/api/push");
    if (!info.relay) return { state: "unavailable", detail: PUSH_MESSAGES.workspaceOff };
    if (info.relay !== this.#d.relay) return { state: "unavailable", detail: PUSH_MESSAGES.otherRelay };
    return { info };
  }

  status(): Promise<PushStatus> {
    return this.#serial(async () => {
      const c = await this.#check();
      if ("state" in c) return c;
      if (!this.#saved()?.on) return { state: "off", detail: null };
      if ((await this.#d.permission()) !== "granted") return { state: "denied", detail: PUSH_MESSAGES.denied };
      return c.info.registered ? { state: "on", detail: null } : { state: "off", detail: null };
    });
  }

  enable(): Promise<PushStatus> {
    return this.#serial(async () => {
      const c = await this.#check();
      if ("state" in c) return c;
      if ((await this.#d.requestPermission()) !== "granted") return { state: "denied", detail: PUSH_MESSAGES.denied };
      const saved = this.#saved();
      const scope = saved?.scope ?? this.#d.randomScope();
      this.#save({ on: true, scope, handle: saved?.handle ?? null });
      await this.#register(scope, true);
      return { state: "on", detail: null };
    });
  }

  disable(): Promise<PushStatus> {
    return this.#serial(async () => {
      const saved = this.#saved();
      await this.#d.clearTarget().catch(() => undefined);
      if (saved) this.#save({ ...saved, on: false, unsent: true });
      await this.#tellOff();
      return { state: "off", detail: null };
    });
  }

  /**
   * Tell PURSS and the relay that this phone stopped. Until both have heard it, the record stays, so
   * a phone turned off while offline isn't woken for ever (on iOS a wake shows the relay's fixed text).
   */
  async #tellOff(): Promise<void> {
    const saved = this.#saved();
    if (!saved?.unsent) return;
    const told = await this.#d.api("/api/push/device", { method: "DELETE" }).then(() => true, () => false);
    const relayTold = !saved.handle || await this.#d.relayPost("/v1/unregister", { handle: saved.handle }).then((r) => r.status < 500, () => false);
    if (told && relayTold) this.#save({ on: false, scope: saved.scope, handle: null });
  }

  /**
   * At start and when the system hands out a new push address: keep the registration current (the relay's
   * handle follows the address; PURSS forgets a handle the relay stopped knowing). Never prompts.
   */
  refresh(): Promise<void> {
    return this.#serial(async () => {
      const saved = this.#saved();
      if (saved?.unsent) await this.#tellOff();
      if (!saved?.on) return;
      const c = await this.#check();
      if ("state" in c || (await this.#d.permission()) !== "granted") return;
      await this.#register(saved.scope, !c.info.registered);
    });
  }

  /** The device stops being connected (disconnect, or PURSS says so): tell the relay, forget everything. */
  async forget(): Promise<void> {
    const saved = this.#saved();
    this.#d.store.remove(KEY);
    await this.#d.clearTarget().catch(() => undefined);
    if (saved?.handle) await this.#d.relayPost("/v1/unregister", { handle: saved.handle }).catch(() => undefined);
  }

  async #register(scope: string, force: boolean): Promise<void> {
    const token = await this.#d.token();
    const r = await this.#d.relayPost("/v1/register", { platform: this.#d.platform, token, scope }).catch(() => null);
    const handle = r?.status === 200 ? (r.json as { handle?: unknown }).handle : undefined;
    if (typeof handle !== "string") throw new Error(PUSH_MESSAGES.relayDown);
    const saved = this.#saved();
    if (!force && saved?.handle === handle) return;
    const { fetchToken } = await this.#d.api<PushRegisterResult>("/api/push/device", { method: "POST", body: { relay: this.#d.relay, handle } });
    await this.#d.setTarget(fetchToken);
    this.#save({ on: true, scope, handle });
  }
}
