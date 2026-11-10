import type { BasketDTO, BulkResult, ItemDTO } from "@purss/domain";

/** Response shapes of routes that are not named DTOs in the shared contract (see apps/api/src/routes/public.ts). */
export type StateChangeResult = { item: ItemDTO; undoToken: string };
export type KeepResult = { captureQueued: boolean; captureNote: string | null; removed?: boolean; undoToken: string; item: ItemDTO };
export type ClearFreshResult = { changed: number; undoToken: string | null };
export type BulkOutcome = BulkResult;
export type UndoResult = { applied: number };
export type DeleteResult = { deleted: number; releasedBytes: number };
export type { ManualKeepResult } from "@purss/domain";
export type BasketDeletePreview = { items: number; onlyHere: number; confirmToken: string };
export type UnfollowResult = { keptItems: number; deletedItems: number };
export type SecurityMethod = { id: string; kind: "passkey" | "oidc" | "password"; label: string | null; createdAt: string; lastUsedAt: string | null };
export type SecuritySession = { id: string; current: boolean; createdAt: string; lastSeenAt: string; method: string; device: string | null; sessionClass: "persistent" | "shared" };
export type SecurityInfo = { methods: SecurityMethod[]; sessions: SecuritySession[]; recentAuth: boolean };
export type RecoveryCodes = { recoveryCodes: string[]; recoveryGeneration: number };
export type BasketCreateResult = BasketDTO;
