import type { ApnsEnv } from "./store.ts";

export type LogEvent = { event: string; [field: string]: string | number | boolean };

/** What a push service said: delivered to it, the token is dead, or try again later. */
export interface SendOutcome {
  status: "ok" | "gone" | "transient";
  /** APNs only: the environment that accepted the token, when it differs from the stored one. */
  env?: ApnsEnv;
}

export interface Provider {
  /** Sends the fixed, content-free wake-up push. Never throws. */
  send(token: string, env: ApnsEnv): Promise<SendOutcome>;
  close(): void;
}

export const SEND_TIMEOUT_MS = 10_000;

export function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}
