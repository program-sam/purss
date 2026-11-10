import { createHash } from "node:crypto";
import type { AiJudgeRequest } from "@purss/domain";

/*
 * Jev, TypeSafe AI's decision model (plan/36): one POST /v1/systemone per post, with the post as the state and one yes/no ("noul")
 * question per filter. Jev answers each question with the chance that it is true and bills the input tokens only. The address is
 * the operator's (PURSS_JEV_URL), never a person's: a key someone adds is only ever sent to it.
 */

export const JEV_DEFAULT_URL = "https://api.typesafe.ai";
/**
 * The newest Jev, by its alias: TypeSafe's, or OpenRouter's when the address is OpenRouter's. An operator who wants filters to keep
 * behaving exactly the same pins a version with PURSS_JEV_MODEL (for example jev-1.13.0, or typesafe/jev-1.13 on OpenRouter).
 */
export function jevDefaultModel(baseUrl: string): string {
  return /^https:\/\/openrouter\.ai(\/|$)/.test(baseUrl) ? "~typesafe/jev-latest" : "jev-latest";
}

export type JevConfig = { baseUrl: string; model: string; timeoutMs: number };

/** Where keys for this address come from, for the key fields: OpenRouter's or TypeSafe's console, or the address itself. */
export function jevKeySource(baseUrl: string): string {
  if (/^https:\/\/openrouter\.ai(\/|$)/.test(baseUrl)) return "OpenRouter (openrouter.ai/keys)";
  if (baseUrl === JEV_DEFAULT_URL) return "TypeSafe (console.typesafe.ai)";
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

export function jevConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const baseUrl = (env.PURSS_JEV_URL?.trim() || JEV_DEFAULT_URL).replace(/\/+$/, "");
  return { baseUrl, model: env.PURSS_JEV_MODEL?.trim() || jevDefaultModel(baseUrl), timeoutMs: 20_000 };
}

/**
 * Why a call failed. "key_rejected": the key is wrong or revoked (don't retry with it). "invalid": Jev refused the request itself.
 * "busy": rate limited or overloaded, worth retrying later. "unavailable": no answer (network, timeout, server error).
 */
export type JevFailure = "key_rejected" | "invalid" | "busy" | "unavailable";

export class JevError extends Error {
  readonly failure: JevFailure;
  readonly retryAfterSeconds: number | null;
  constructor(failure: JevFailure, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "JevError";
    this.failure = failure;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  get retryable(): boolean {
    return this.failure === "busy" || this.failure === "unavailable";
  }
}

export type JevAnswer = { model: string | null; answers: Record<string, number>; inputTokens: number };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function retryAfter(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.min(3600, Math.round(n)));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(3600, Math.round((at - Date.now()) / 1000))) : null;
}

/** Ask Jev the request's questions about its post. */
export async function askJev(config: JevConfig, apiKey: string, request: Pick<AiJudgeRequest, "state" | "questions">, opts: { signal?: AbortSignal; fetch?: FetchLike } = {}): Promise<JevAnswer> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
      redirect: "error",
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new JevError("unavailable", timeout.aborted ? "Jev did not answer in time." : "Jev could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new JevError("key_rejected", "Jev did not accept the key.");
  if (res.status === 429 || res.status === 529) throw new JevError("busy", "Jev is busy; trying again later.", retryAfter(res));
  if (res.status === 400 || res.status === 422) throw new JevError("invalid", `Jev refused the request (${res.status}).`);
  if (!res.ok) throw new JevError("unavailable", `Jev answered ${res.status}.`, retryAfter(res));
  const text = await res.text();
  if (text.length > 1_000_000) throw new JevError("unavailable", "Jev's answer was too large.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new JevError("unavailable", "Jev's answer was not JSON."); }
  const answer = readAnswer(body, Object.keys(request.questions));
  // Usage is what allowances are counted in; a reply without it is counted by the size of what was sent (about 4 characters a token).
  if (answer.inputTokens === null) answer.inputTokens = Math.ceil(JSON.stringify({ state: request.state, questions: request.questions }).length / 4);
  return answer as JevAnswer;
}

/** The chance for each question asked, from Jev's answer. An answer that doesn't hold every question is not used. */
export function readAnswer(body: unknown, asked: readonly string[]): Omit<JevAnswer, "inputTokens"> & { inputTokens: number | null } {
  const b = body as { model?: unknown; answers?: Record<string, { noul?: unknown }>; usage?: { input_tokens?: unknown } } | null;
  const answers: Record<string, number> = {};
  for (const key of asked) {
    const p = b?.answers?.[key]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new JevError("unavailable", "Jev's answer left out a question.");
    answers[key] = p;
  }
  const tokens = b?.usage?.input_tokens;
  return {
    model: typeof b?.model === "string" ? b.model.slice(0, 100) : null,
    answers,
    inputTokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : null,
  };
}

/** Ask about several posts, a few at a time (Jev allows 80 requests a second for a whole key). Stops at the first failure. */
export async function askJevAll<T extends Pick<AiJudgeRequest, "state" | "questions">>(config: JevConfig, apiKey: string, requests: readonly T[], opts: { signal?: AbortSignal; fetch?: FetchLike; concurrency?: number } = {}): Promise<JevAnswer[]> {
  const out: JevAnswer[] = new Array(requests.length);
  let next = 0;
  let failed = false;
  const run = async () => {
    while (!failed && next < requests.length) {
      const i = next++;
      try {
        out[i] = await askJev(config, apiKey, requests[i]!, opts);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, requests.length) }, run));
  return out;
}

/**
 * Ask about several posts, a few at a time, and keep what each one got: an answer, or why there was none. After a failure that
 * isn't worth repeating soon (a refused key, or Jev busy) the rest aren't asked.
 */
export async function askJevEach<T extends Pick<AiJudgeRequest, "state" | "questions">>(config: JevConfig, apiKey: string, requests: readonly T[], opts: { signal?: AbortSignal; fetch?: FetchLike; concurrency?: number } = {}): Promise<(JevAnswer | JevError)[]> {
  const out: (JevAnswer | JevError)[] = new Array(requests.length);
  let next = 0;
  let stop: JevError | null = null;
  const run = async () => {
    while (next < requests.length) {
      const i = next++;
      if (stop) { out[i] = stop; continue; }
      try {
        out[i] = await askJev(config, apiKey, requests[i]!, opts);
      } catch (err) {
        if (!(err instanceof JevError)) throw err;
        out[i] = err;
        if (err.failure === "key_rejected" || err.failure === "busy") stop = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, requests.length) }, run));
  return out;
}

/** A short fingerprint of a key, so a refusal is recorded only against the key that was refused (never the key itself). */
export function jevKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
