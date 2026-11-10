import { z } from "zod";
import { AI_FILTER_TEXT_MAX } from "./ai-limits.ts";

/*
 * Smart filters (plan/36): a person describes which posts of a source or collection to keep, and Jev, TypeSafe AI's decision model,
 * judges each new post against that description. A post the filter drops is marked Ignored, the workflow state a person uses for
 * the same thing; nothing is deleted, and changing it back is the person's last word on that post. Filters are off unless the
 * person adds one, and they run on the server's Jev key, which only an administrator sets (on the hosted service, within the Pro plan's
 * monthly allowance).
 */

/**
 * Below this chance of "keep", a post is dropped. "keep" (when unsure, keep) drops only posts Jev is fairly sure don't belong;
 * "drop" also drops the ones it is unsure about.
 */
export const AI_FILTER_THRESHOLDS = { keep: 0.3, drop: 0.6 } as const;
export type WhenUnsure = keyof typeof AI_FILTER_THRESHOLDS;

export const aiFilterRuleSchema = z.object({
  keep: z.string().trim().min(3, "Say which posts to keep.").max(AI_FILTER_TEXT_MAX),
  drop: z.string().trim().max(AI_FILTER_TEXT_MAX).nullable().default(null).transform((v) => (v ? v : null)),
  whenUnsure: z.enum(["keep", "drop"]).default("keep"),
});
export type AiFilterRule = z.infer<typeof aiFilterRuleSchema>;

/** What a filter applies to: one source (all its posts, wherever they are listed) or every source of one collection. */
export const aiFilterScopeSchema = z.union([z.object({ sourceId: z.string() }).strict(), z.object({ collectionId: z.string() }).strict()]);
export type AiFilterScope = z.infer<typeof aiFilterScopeSchema>;

export const aiFilterSaveSchema = aiFilterRuleSchema.extend({ enabled: z.boolean().default(true) });

export type AiFilterDTO = AiFilterRule & {
  id: string;
  scope: AiFilterScope;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Posts this filter has marked Ignored that are still Ignored. */
  droppedCount: number;
  judgedCount: number;
};

export type AiSettingsDTO = {
  /** Hosted installs only: whether the account's plan (Pro) includes Smart filters. Null when self-hosted. */
  pro: { included: boolean } | null;
  /** Whether an administrator has set a server key that Jev accepts. */
  serverKey: boolean;
  /**
   * Whether filters can run now: the server has a key and the account may use it (self-hosted every account; hosted, Pro within
   * its allowance). When not, filters wait and posts stay as they are.
   */
  ready: boolean;
  /**
   * Hosted: the account's Smart filter allowance for this week is used up; filters wait until next week. The allowance itself
   * (tokens) is an administrator's safeguard and never shown to people.
   */
  allowanceUsedUp: boolean;
  /** Where this server reaches Jev, e.g. "OpenRouter (openrouter.ai/keys)"; the filter dialog names it. */
  keySource: string;
};

/** Administrators: the server's Jev key, as entered in Admin → Smart filters. */
export const aiKeySchema = z.object({ key: z.string().trim().min(8).max(500) });

export type AiFilterPreviewPost = {
  itemId: string;
  title: string;
  sourceTitle: string | null;
  publishedAt: string | null;
  /** Jev's chance that the post belongs, 0 to 1. */
  keepProbability: number;
  dropped: boolean;
};

export type AiFilterPreview = { posts: AiFilterPreviewPost[]; inputTokens: number };

export const aiFilterPreviewSchema = aiFilterRuleSchema.extend({ scope: aiFilterScopeSchema });

/** Whether a chance of "keep" drops the post under this rule. */
export function dropsPost(keepProbability: number, whenUnsure: WhenUnsure): boolean {
  return keepProbability < AI_FILTER_THRESHOLDS[whenUnsure];
}

/** The week usage is counted in: the ISO week (Monday to Sunday, UTC), as YYYY-Www (for example 2026-W46). */
export function usageWeek(at: Date = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // the week's Thursday decides its year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ---------- worker contract (internal) ----------

/** One Jev request: one post as the state and one question per filter that applies to it. */
export type AiJudgeRequest = {
  itemId: string;
  state: { source: string | null; title: string; author: string | null; summary: string | null };
  /** Keyed by `f<filter version>_<filter id>`; see judgeQuestionKey. */
  questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }>;
};

/** What the worker gets for a filter.judge job: whether to ask on the server's key, and what. No route: complete without asking. */
export type AiJudgeInput = { route: "server" | null; model: string; requests: AiJudgeRequest[] };

export const aiJudgeResultSchema = z.object({
  /** The route the answers were asked on; null when there was none. */
  route: z.literal("server").nullable(),
  model: z.string().max(100).nullable(),
  /** Jev refused the server's key; `keyFingerprint` says which key that was (see the API's keyFingerprint). */
  keyRejected: z.boolean().default(false),
  keyFingerprint: z.string().max(64).nullable().default(null),
  /** Posts Jev couldn't be asked about this time; the API queues them again. */
  unfinished: z.array(z.string()).max(20).default([]),
  verdicts: z.array(z.object({ itemId: z.string(), answers: z.record(z.string().max(80), z.number().min(0).max(1)), inputTokens: z.number().int().min(0) })).max(50),
});
export type AiJudgeResult = z.infer<typeof aiJudgeResultSchema>;

export function judgeQuestionKey(filterId: string, version: number): string {
  return `f${version}_${filterId}`;
}

export function parseJudgeQuestionKey(key: string): { filterId: string; version: number } | null {
  const m = /^f(\d{1,9})_(.+)$/.exec(key);
  return m ? { filterId: m[2]!, version: Number(m[1]) } : null;
}

/** Administrators: the server's Jev key, shown by its last characters only. */
export type AiServerKeyDTO = { key: { hint: string; rejected: boolean } | null; mode: "self" | "hosted"; keySource: string };
