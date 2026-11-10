import { SMART_FILTER_WEEKLY_TOKENS, planHasSmartFilters, usageWeek } from "@purss/domain";
import type { AiServerKeyDTO, AiSettingsDTO } from "@purss/domain";
import { jevKeyFingerprint, jevKeySource } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { audit } from "../app.ts";
import { readSecret, removeSecret, writeSecret } from "../secrets.ts";
import { planOf } from "./plans.ts";

/*
 * Smart filters (plan/36), the parts other services need without the filters themselves: the server's Jev key that an
 * administrator set (in the secrets folder; people never hand the server a key of their own), usage per week, and removing filter
 * rows with what they belong to.
 */

type Owner = Pick<Principal, "accountId" | "workspaceId">;

/** The server's key, set by an administrator (Admin → Smart filters). */
const SERVER_KEY_FILE = "jev-server-key";
const SERVER_REJECTED = "jev_server_key_rejected";

function serverKey(app: App): string | null {
  const v = readSecret(app.config.secretsDir, SERVER_KEY_FILE);
  return v || null;
}

const serverRejected = (app: App) => app.db.get("SELECT 1 FROM installation WHERE key = ?", SERVER_REJECTED) !== undefined;

/** Whether the server is set up for Smart filters: an administrator added a key and Jev hasn't refused it. */
export const serverKeyReady = (app: App) => serverKey(app) !== null && !serverRejected(app);

/**
 * Jev refused the server's key: filters stop using it until it is replaced. Recorded only while the key in place is still the refused one
 * (`fingerprint`), so a late refusal of a replaced key doesn't disable its replacement.
 */
export function markKeyRejected(app: App, fingerprint: string | null): void {
  const current = serverKey(app);
  if (!current || !fingerprint || jevKeyFingerprint(current) !== fingerprint) return;
  app.db.run("INSERT INTO installation (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING", SERVER_REJECTED);
}

export function serverKeyInfo(app: App): AiServerKeyDTO {
  const key = serverKey(app);
  return { key: key ? { hint: key.slice(-4), rejected: serverRejected(app) } : null, mode: app.config.mode, keySource: jevKeySource(app.config.jev.baseUrl) };
}

export function setServerKey(app: App, admin: Principal, key: string): AiServerKeyDTO {
  writeSecret(app.config.secretsDir, SERVER_KEY_FILE, key);
  app.db.run("DELETE FROM installation WHERE key = ?", SERVER_REJECTED);
  audit(app, admin.accountId, "ai.server_key_set", null, "success");
  return serverKeyInfo(app);
}

export function removeServerKey(app: App, admin: Principal): AiServerKeyDTO {
  removeSecret(app.config.secretsDir, SERVER_KEY_FILE);
  app.db.run("DELETE FROM installation WHERE key = ?", SERVER_REJECTED);
  audit(app, admin.accountId, "ai.server_key_removed", null, "success");
  return serverKeyInfo(app);
}

/** Hosted installs: whether the account's plan includes Smart filters on the server's key (Pro; administrators always). */
function planIncludes(app: App, accountId: string): boolean {
  const plan = planOf(app, accountId);
  return plan !== null && planHasSmartFilters(plan);
}

function usageOf(app: App, accountId: string, week = usageWeek()): number {
  return app.db.get<{ input_tokens: number }>("SELECT input_tokens FROM ai_usage WHERE account_id = ? AND week = ?", accountId, week)?.input_tokens ?? 0;
}

/** Hosted: the plan's Smart filter allowance for this week is used up. */
function allowanceUsedUp(app: App, accountId: string): boolean {
  return app.config.mode === "hosted" && usageOf(app, accountId) >= SMART_FILTER_WEEKLY_TOKENS;
}

/** Whether the account may use the server's key: self-hosted every account may; hosted, those on Pro within its allowance. */
function mayUseServerKey(app: App, accountId: string): boolean {
  return app.config.mode === "hosted" ? planIncludes(app, accountId) && !allowanceUsedUp(app, accountId) : true;
}

/** The server's key when the account's filters may use it now (Jev hasn't refused it; hosted, the plan includes it); else null. */
export function keyFor(app: App, owner: Owner): string | null {
  const server = serverKey(app);
  return server && !serverRejected(app) && mayUseServerKey(app, owner.accountId) ? server : null;
}

export function recordUsage(app: App, accountId: string, inputTokens: number, requests: number): void {
  if (!requests) return;
  app.db.run(
    `INSERT INTO ai_usage (account_id, week, input_tokens, requests) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, week) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, requests = requests + excluded.requests`,
    accountId, usageWeek(), inputTokens, requests);
}

export function aiSettings(app: App, p: Owner): AiSettingsDTO {
  return {
    pro: app.config.mode === "hosted" ? { included: planIncludes(app, p.accountId) } : null,
    serverKey: serverKeyReady(app),
    ready: keyFor(app, p) !== null,
    allowanceUsedUp: allowanceUsedUp(app, p.accountId),
    keySource: jevKeySource(app.config.jev.baseUrl),
  };
}

/** Administrators: the tokens an account used on the server's key this week (hosted only; null when self-hosted). */
export function serverTokensOf(app: App, accountId: string): number | null {
  return app.config.mode === "hosted" ? usageOf(app, accountId) : null;
}

// ---------- rows that go with what they belong to ----------

/** A collection that is deleted takes its filter with it. Call in the deleting transaction, before the collection goes. */
export function forgetCollectionFilter(app: App, workspaceId: string, collectionId: string): void {
  const r = app.db.get<{ id: string }>("SELECT id FROM ai_filters WHERE collection_id = ? AND workspace_id = ?", collectionId, workspaceId);
  if (!r) return;
  app.db.run("DELETE FROM ai_filter_verdicts WHERE filter_id = ?", r.id);
  app.db.run("DELETE FROM ai_filters WHERE id = ?", r.id);
}

/** A post that is deleted takes its answers with it. */
export function forgetItemVerdicts(app: App, itemId: string): void {
  app.db.run("DELETE FROM ai_filter_verdicts WHERE item_id = ?", itemId);
}
