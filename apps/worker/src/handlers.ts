import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AiJudgeResult, SyncBatch } from "@purss/domain";
import { askJevEach, jevKeyFingerprint, JevError } from "@purss/connectors";
import type { JevConfig } from "@purss/connectors";
import { EngineAdmin, EngineError, GReaderClient, runSync } from "@purss/freshrss";
import type { EngineSubscription } from "@purss/freshrss";
import type { InternalApi } from "./internal-api.ts";
import type { Logger } from "./log.ts";
import { JobAborted, JobFailure, KeyedLock, SETTLED } from "./runner.ts";
import type { Handlers, HandlerArgs } from "./runner.ts";
import type { EngineUserSecrets } from "./secrets.ts";
import { resolveFeedUrl, trimmedEngineUrl } from "./secrets.ts";

/** What `captureReadable` from `@purss/connectors` returns. */
export type CaptureResult =
  | { ok: true; title: string | null; text: string; html: string; finalUrl: string; bytes: number }
  | { ok: false; reason: string; message: string };
export type CaptureFn = (url: string, opts?: { signal?: AbortSignal }) => Promise<CaptureResult>;

/** What `fetchPictures` from `@purss/connectors` returns. */
export type PicturesFn = (urls: string[], opts: { maxBytes: number; shrink: boolean; signal?: AbortSignal }) => Promise<{ url: string; contentType: string; data: Buffer }[]>;

/** What `resolveSourceIcon` from `@purss/connectors` returns. */
export type IconResult =
  | { ok: true; icon: { data: Buffer; width: number; from: string }; tried: number }
  | { ok: false; tried: number; reasons: string[] };
export type IconFn = (input: { kind: string; feedUrl: string | null; siteUrl: string | null }, opts?: { signal?: AbortSignal }) => Promise<IconResult>;

/** The slice of the GReader client the handlers use; tests substitute an in-memory engine. */
export type EngineClient = Pick<
  GReaderClient,
  "login" | "quickAdd" | "listSubscriptions" | "unsubscribe" | "renameSubscription" | "markRead" | "streamContents" | "feedHasItems"
>;

export type HandlerDeps = {
  api: InternalApi;
  secrets: EngineUserSecrets;
  /** Where private feed addresses live (<data>/secrets); see resolveFeedUrl. */
  secretsDir: string;
  /** Where the engine reaches the bridge router; see resolveFeedUrl. */
  bridgeEngineUrl?: string;
  /** Where the engine reaches the feed gateway, which trims big feeds (plan/44); see trimmedEngineUrl. */
  gatewayEngineUrl?: string;
  admin: Pick<EngineAdmin, "ensureUser" | "engineIdentity" | "userExists" | "deleteUser">;
  log: Logger;
  makeClient: (args: { baseUrl: string; username: string; apiPassword: string; signal: AbortSignal }) => EngineClient;
  /** Absent when the connectors package does not provide capture; such jobs are then not leased at all. */
  capture?: CaptureFn;
  /** Fetches the pictures of a kept copy; absent when the connectors package does not provide it, and then not leased. */
  pictures?: PicturesFn;
  /**
   * Whether an address answers with something the preview reads as a feed (`previewsAsFeed`). Asked only when the engine
   * refuses an address as "not a feed": a feed served without a Content-Type is then added with the engine's force marker.
   * Absent: the engine's refusal stands.
   */
  looksLikeFeed?: (url: string, opts: { signal: AbortSignal }) => Promise<boolean>;
  /**
   * Whether an address answers with a document larger than the engine can read whole (`isLargeFeed`; null: could not be asked). Asked only
   * when the engine itself fails on a subscription (its out-of-memory answer): a feed that is that big is then followed through the feed
   * gateway. Absent: the engine's failure stands.
   */
  isLargeFeed?: (url: string, opts: { signal: AbortSignal }) => Promise<boolean | null>;
  /** Absent when the connectors package does not provide icon lookup; such jobs are then not leased at all. */
  icon?: IconFn;
  /** Jev for Smart filters (plan/36): the operator's address (keys are read from the secrets folder). Absent: not leased. */
  jev?: { config: JevConfig; fetch?: (url: string, init: RequestInit) => Promise<Response> };
  syncPageSize: number;
  syncOverlapSeconds: number;
  /** Serialized-size budget of one posted batch (the API's request body limit is 1 MB by default). */
  syncMaxBatchBytes: number;
  requestTimeoutMs: number;
};

export function defaultMakeClient(timeoutMs: number): HandlerDeps["makeClient"] {
  return ({ baseUrl, username, apiPassword, signal }) => new GReaderClient({ baseUrl, username, apiPassword, signal, requestTimeoutMs: timeoutMs });
}

const sameFeedUrl = (a: string, b: string) => normalizeFeedUrl(a) === normalizeFeedUrl(b);
function normalizeFeedUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    const s = url.toString();
    return s.endsWith("/") && url.pathname === "/" ? s.slice(0, -1) : s;
  } catch {
    return u;
  }
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const lock = new KeyedLock();
  /**
   * One first subscribe per feed address at a time. FreshRSS keeps one fetch cache for all its users (key: the address
   * and the fetch options), but its quick-add looks the cache up before it takes the per-feed lock, so accounts that
   * follow the same new feed at the same moment would each fetch it. Run one after another, the later ones find the
   * first one's fetch in the cache. Lock order: an engine user's lock, then at most one address lock; the holder of an
   * address lock never waits for another lock, so there is no cycle.
   */
  const addressLock = new KeyedLock();

  /** Resolves the engine user and logs in with its stored API password. */
  async function engineSession(engineUserId: string, signal: AbortSignal): Promise<{ client: EngineClient; username: string; baseUrl: string }> {
    const record = await deps.api.engineUser(engineUserId, signal);
    const apiPassword = deps.secrets.read(engineUserId);
    if (!apiPassword) {
      throw new JobFailure("This engine user has no stored credentials; it must be provisioned before use.", false);
    }
    const client = deps.makeClient({ baseUrl: record.baseUrl, username: record.username, apiPassword, signal });
    await client.login();
    return { client, username: record.username, baseUrl: record.baseUrl };
  }

  async function findSubscriptionByUrl(client: EngineClient, feedUrl: string): Promise<EngineSubscription | undefined> {
    return (await client.listSubscriptions()).find((s) => sameFeedUrl(s.url, feedUrl));
  }

  /**
   * Whether an address the engine refused as "not a feed" may be added with the engine's force marker: only a web address that
   * the preview's own parser reads as a feed (so a page, or anything that does not parse, is never forced), and never a bridged
   * address, which the engine reaches through the bridge router and which always carries its type. The marker stays on the
   * address the engine stores, so it keeps taking the feed as one at every later refresh; the source's own address stays without it.
   */
  async function mayForce(e: unknown, payloadUrl: string, feedUrl: string, signal: AbortSignal): Promise<boolean> {
    if (!deps.looksLikeFeed || !(e instanceof EngineError) || e.kind !== "rejected" || e.reason !== "not_a_feed") return false;
    if (payloadUrl.startsWith("bridge:") || !/^https?:\/\//i.test(feedUrl)) return false;
    try {
      return await deps.looksLikeFeed(feedUrl, { signal });
    } catch {
      return false;
    }
  }

  /**
   * What the engine says about the feed it has just fetched for a subscription: whether anything is in it. The engine fetches
   * a feed when it adds it, so an empty stream right after is a feed with no posts. When the engine can't be asked, nothing
   * is claimed (the subscription itself still succeeded).
   */
  async function feedEmpty(client: EngineClient, streamId: string): Promise<{ empty: boolean } | Record<string, never>> {
    try {
      return { empty: !(await client.feedHasItems(streamId)) };
    } catch {
      return {};
    }
  }

  return {
    "engine.provision": async ({ payload, signal }: HandlerArgs<"engine.provision">) => {
      const record = await deps.api.engineUser(payload.engineUserId, signal);
      if (record.username !== payload.username) throw new JobFailure("The engine user's username does not match the job.", false);
      // Persist the credential before the engine learns it, so a crash can never strand a user nobody can log in as.
      const { apiPassword, generated } = deps.secrets.ensure(payload.engineUserId);
      const { created } = await deps.admin.ensureUser({ username: record.username, apiPassword });
      const client = deps.makeClient({ baseUrl: record.baseUrl, username: record.username, apiPassword, signal });
      await client.login();
      const engineIdentity = await deps.admin.engineIdentity();
      deps.log("info", "engine user ready", { engineUserId: payload.engineUserId, created, credentialGenerated: generated });
      return { engineUserId: payload.engineUserId, username: record.username, engineIdentity, created };
    },

    "engine.subscribe": async ({ payload, signal }: HandlerArgs<"engine.subscribe">) =>
      lock.run(payload.engineUserId, async () => {
        const resolved = resolveFeedUrl(deps.secretsDir, payload.feedUrl, deps.bridgeEngineUrl);
        if (!resolved) {
          throw new JobFailure(payload.feedUrl.startsWith("bridge:") ? "This installation has no bridge key, so the source can't be followed." : "The private feed address for this source is missing.", false);
        }
        // A bridged source is already served by the router; any other address can be a big feed (plan/44).
        const trimmable = !payload.feedUrl.startsWith("bridge:") && /^https?:\/\//i.test(resolved);
        // The gateway's address for a feed; null on an installation that has no feed gateway key (plan/44).
        const viaGateway = (address: string): string | null => trimmedEngineUrl(deps.secretsDir, address, deps.gatewayEngineUrl);
        const { client } = await engineSession(payload.engineUserId, signal);
        // A private (secret-link) address belongs to one account and is never fetched for another, so it needs no ordering.
        const add = async (address: string, force: boolean) => {
          try {
            return await client.quickAdd(address);
          } catch (e) {
            if (!force || !(await mayForce(e, payload.feedUrl, address, signal))) throw e;
            return await client.quickAdd(address, { force: true });
          }
        };
        const subscribe = (address: string, force: boolean) =>
          payload.feedUrl.startsWith("secret:")
            ? add(address, force)
            : addressLock.run(createHash("sha256").update(normalizeFeedUrl(address)).digest("hex"), () => add(address, force));
        // The follow decided from its preview that this feed is big; the engine's address is the gateway's. Without a gateway key the engine is
        // given the feed as it is, and fails on it if it must.
        let engineUrl = (payload.trim && trimmable ? viaGateway(resolved) : null) ?? resolved;
        let trimmed = engineUrl !== resolved;
        let added: Awaited<ReturnType<typeof add>>;
        try {
          added = await subscribe(engineUrl, !trimmed);
        } catch (e) {
          // The engine reads a feed whole, in a memory limit; one too big for it fails the request itself (an HTTP 500, or the connection
          // dropped when its process is killed), which says nothing about the feed's site (the engine words a failure of the site with
          // a reason; this has none). A feed that really is that big (imports, retries and subscriptions made before the gateway
          // never had a preview to tell) is then followed through the gateway. The engine refusing a feed for its size (its download limit) is the same.
          const overloaded = e instanceof EngineError && ((e.kind === "unavailable" && e.reason === null) || e.reason === "too_large");
          // The engine answering HTTP 500 to the gateway's own small copy is about the feed's content, not its site: say that plainly (a dropped
          // connection could as well be the engine restarting, and is retried as before).
          if (trimmed && overloaded && e instanceof EngineError && e.status === 500) throw new JobFailure("The engine could not read this feed even trimmed to its newest items.", false);
          if (trimmed || !trimmable || !overloaded || !deps.isLargeFeed) throw e;
          const large = await deps.isLargeFeed(resolved, { signal }).catch(() => null);
          if (large !== true) throw e;
          const gateway = viaGateway(resolved);
          if (!gateway) throw new JobFailure("The engine could not read this feed, and this installation has no feed gateway key to give it a smaller copy.", false);
          engineUrl = gateway;
          trimmed = true;
          added = await subscribe(engineUrl, false);
        }
        // What the engine holds is the gateway's address; the source keeps its own, and says so (the product records it).
        const via = trimmed ? { viaGateway: true } : {};
        if ("already" in added) {
          const existing = await findSubscriptionByUrl(client, engineUrl);
          if (!existing) throw new JobFailure("The engine reports an existing subscription for this feed but does not list it.", true);
          return { streamId: existing.streamId, title: existing.title, alreadySubscribed: true, ...via, ...(await feedEmpty(client, existing.streamId)) };
        }
        return { streamId: added.streamId, title: added.title, alreadySubscribed: false, ...via, ...(await feedEmpty(client, added.streamId)) };
      }),

    "engine.unsubscribe": async ({ payload, signal }: HandlerArgs<"engine.unsubscribe">) =>
      lock.run(payload.engineUserId, async () => {
        const { client } = await engineSession(payload.engineUserId, signal);
        try {
          await client.unsubscribe(payload.streamId);
          return { streamId: payload.streamId, removed: true };
        } catch (e) {
          // The engine answers 400 for an unknown stream. If it is really gone, the goal is already met.
          if (e instanceof EngineError && e.kind === "bad_request") {
            const still = (await client.listSubscriptions()).some((s) => s.streamId === payload.streamId);
            if (!still) return { streamId: payload.streamId, removed: false };
          }
          throw e;
        }
      }),

    "engine.rename": async ({ payload, signal }: HandlerArgs<"engine.rename">) =>
      lock.run(payload.engineUserId, async () => {
        const { client } = await engineSession(payload.engineUserId, signal);
        // The engine accepts a rename of a stream it does not have and reports success, so check first.
        if (!(await client.listSubscriptions()).some((s) => s.streamId === payload.streamId)) {
          throw new JobFailure("The engine has no subscription with that stream id.", false);
        }
        await client.renameSubscription(payload.streamId, payload.title);
        return { streamId: payload.streamId, title: payload.title };
      }),

    "engine.sync": async ({ job, payload, signal }: HandlerArgs<"engine.sync">) =>
      lock.run(payload.engineUserId, async () => {
        const { client } = await engineSession(payload.engineUserId, signal);
        const [checkpoint, engineIdentity] = await Promise.all([deps.api.checkpoint(payload.engineUserId, signal), deps.admin.engineIdentity()]);
        const summary = await runSync({
          client,
          engineUserId: payload.engineUserId,
          engineIdentity,
          checkpoint,
          pageSize: deps.syncPageSize,
          overlapSeconds: deps.syncOverlapSeconds,
          maxBatchBytes: deps.syncMaxBatchBytes,
          signal,
          submit: async (draft) => {
            const batch: SyncBatch = { leaseId: job.leaseId, ...draft };
            return deps.api.submitBatch(payload.engineUserId, batch, signal);
          },
        });
        if (!summary.complete) throw new JobAborted();
        return {
          pages: summary.pages,
          batches: summary.batches,
          entries: summary.entries,
          accepted: summary.accepted,
          duplicates: summary.duplicates,
          identityChanged: summary.identityChanged,
          newestCrawlUsec: summary.checkpoint.newestCrawlUsec,
        };
      }),

    /*
     * Phase 2 of an account deletion. The attempt is recorded before the engine is asked, so a user found
     * missing later is only taken as never created (or removed by hand) when no attempt was recorded; after
     * an unconfirmed attempt an administrator confirms instead. Finalizing settles the job itself.
     */
    "engine.delete_user": async ({ job, payload, signal }: HandlerArgs<"engine.delete_user">) =>
      lock.run(payload.engineUserId, async () => {
        const lease = { jobId: job.id, leaseId: job.leaseId };
        const state = await deps.api.deletionState(payload.engineUserId, lease, signal);
        if (!state.engineRemovedAt) {
          if (await deps.admin.userExists(payload.username)) {
            await deps.api.deletionAttempt(payload.engineUserId, lease, signal);
            await deps.admin.deleteUser(payload.username);
            if (await deps.admin.userExists(payload.username)) throw new JobFailure("The engine still lists the user after deleting it.", true);
          } else if (state.engineAttemptedAt) {
            await deps.api.deletionReview(payload.engineUserId, lease, signal);
            deps.log("warn", "engine user missing after an unconfirmed removal; waiting for an administrator", { engineUserId: payload.engineUserId });
            return SETTLED;
          }
          await deps.api.deletionEngineRemoved(payload.engineUserId, lease, signal);
        }
        deps.secrets.remove(payload.engineUserId);
        await deps.api.finalizeDeletion(payload.engineUserId, lease, signal);
        deps.log("info", "account deletion finished", { engineUserId: payload.engineUserId });
        return SETTLED;
      }),

    "engine.mark_read": async ({ payload, signal }: HandlerArgs<"engine.mark_read">) =>
      lock.run(payload.engineUserId, async () => {
        const { client } = await engineSession(payload.engineUserId, signal);
        await client.markRead(payload.externalIds, payload.read);
        return { count: payload.externalIds.length, read: payload.read };
      }),

    ...(deps.capture
      ? {
          "capture.fulltext": async ({ payload, signal }: HandlerArgs<"capture.fulltext">) => {
            const result = await deps.capture!(payload.url, { signal });
            if (!result.ok) throw new JobFailure(`The page could not be captured (${result.reason}): ${result.message}`, false);
            return result;
          },
        }
      : {}),

    ...(deps.pictures
      ? {
          // A picture that can't be fetched is left out; the job still answers with the ones that could.
          "capture.images": async ({ payload, signal }: HandlerArgs<"capture.images">) => {
            const got = await deps.pictures!(payload.urls, { maxBytes: payload.maxBytes, shrink: payload.shrink === true, signal });
            return { images: got.map((p) => ({ url: p.url, contentType: p.contentType, data: p.data.toString("base64") })) };
          },
        }
      : {}),

    ...(deps.jev
      ? {
          // One request per post. Posts left unasked after a failure go back to the API, which asks again later; when nothing
          // could be asked, the job fails and is retried like any other.
          "filter.judge": async ({ job, signal }: HandlerArgs<"filter.judge">) => {
            const input = await deps.api.filterInput(job.id, job.leaseId, signal);
            const none: AiJudgeResult = { route: input.route, model: null, keyRejected: false, keyFingerprint: null, unfinished: [], verdicts: [] };
            if (!input.route || !input.requests.length) return none;
            const key = jevServerKey(deps.secretsDir);
            if (!key) return { ...none, keyRejected: true };
            const answers = await askJevEach({ ...deps.jev!.config, model: input.model }, key, input.requests, { signal, fetch: deps.jev!.fetch });
            const result: AiJudgeResult = { ...none };
            let failure: JevError | null = null;
            answers.forEach((a, i) => {
              const itemId = input.requests[i]!.itemId;
              if (a instanceof JevError) {
                failure ??= a;
                if (a.failure === "key_rejected") {
                  result.keyRejected = true;
                  result.keyFingerprint = jevKeyFingerprint(key);
                }
                else result.unfinished.push(itemId);
              } else {
                result.model ??= a.model;
                result.verdicts.push({ itemId, answers: a.answers, inputTokens: a.inputTokens });
              }
            });
            const f = failure as JevError | null;
            if (f && !result.verdicts.length && !result.keyRejected) {
              throw new JobFailure(f.message, f.retryable, f.failure === "busy" ? "rate_limited" : f.failure === "invalid" ? "refused" : "unavailable");
            }
            if (f) deps.log("warn", "some posts could not be judged", { failure: f.failure, judged: result.verdicts.length, unfinished: result.unfinished.length });
            return result;
          },
        }
      : {}),

    ...(deps.icon
      ? {
          // One lookup at a time: decoding large artwork is the worker's biggest memory use.
          "source.icon": async ({ payload, signal }: HandlerArgs<"source.icon">) =>
            lock.run("source.icon", async () => {
              const result = await deps.icon!({ kind: payload.kind, feedUrl: payload.feedUrl, siteUrl: payload.siteUrl }, { signal });
              // Finding no icon is an answer, not a failure: the source keeps its initials until the next check.
              return result.ok
                ? { found: true, data: result.icon.data.toString("base64"), width: result.icon.width, from: result.icon.from }
                : { found: false, reasons: result.reasons.slice(0, 10) };
            }),
        }
      : {}),
  } as Handlers;
}

/** The server's key, as the API wrote it (<secrets>/jev-server-key). */
function jevServerKey(secretsDir: string): string | null {
  const file = path.join(secretsDir, "jev-server-key");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim() || null;
}
