import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { syncBatchSchema } from "@purss/domain";
import type { JobKind } from "@purss/domain";

/**
 * Test double of the API's internal listener, implementing the routes the worker uses with the lease/idempotency
 * semantics of apps/api/src/services/jobs.ts. Test infrastructure only.
 */
export type FakeJob = { id: string; kind: JobKind | string; payload: unknown };

export class FakeInternalApi {
  readonly token: string;
  leaseSeconds = 120;
  queued: FakeJob[] = [];
  readonly leased = new Map<string, { job: FakeJob; leaseId: string }>();
  readonly calls = { lease: 0, heartbeat: [] as string[], complete: [] as Array<{ id: string; result: unknown }>, fail: [] as Array<{ id: string; error: string; retryable: boolean; reason?: string }>, batches: [] as unknown[], unauthorized: 0 };
  readonly engineUsers = new Map<string, { id: string; username: string; baseUrl: string }>();
  readonly checkpoints = new Map<string, { continuation: string | null; newestCrawlUsec: string | null; engineIdentity: string | null }>();
  readonly batchKeys = new Map<string, number>();
  readonly imported = new Map<string, Map<string, unknown>>();
  /** Status to answer for the next N lease calls. */
  failLease: { status: number; remaining: number } | null = null;
  /** Job ids whose heartbeat answers 409 (lease lost). */
  loseLeaseOnHeartbeat = new Set<string>();
  /** Reject the Nth call (1-based) to the batch endpoint with this status, once. */
  failBatchCall: { call: number; status: number } | null = null;
  /** Idempotency keys of batch requests that were answered with an injected failure. */
  readonly failedBatchKeys: string[] = [];
  /** Account deletions on the engine side, by engine user, as the engine.delete_user job reports them. */
  readonly deletions = new Map<string, { engineAttemptedAt: string | null; engineRemovedAt: string | null; engineReviewAt: string | null; finalized: boolean }>();
  /** Deletion calls in order, as "<engineUserId> <step>". */
  readonly deletionCalls: string[] = [];
  /** Apply the next finalize, then drop the connection as if its answer were lost. */
  loseFinalizeAnswer = false;
  #batchCalls = 0;
  #n = 0;

  constructor(token = "test-service-token") {
    this.token = token;
  }

  enqueue(kind: JobKind | string, payload: unknown): string {
    const id = `job_${++this.#n}`;
    this.queued.push({ id, kind, payload });
    return id;
  }

  async listen(): Promise<{ url: string; close(): Promise<void>; server: Server }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(body === undefined ? "" : JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${this.token}`) {
          this.calls.unauthorized += 1;
          return send(401, { error: "unauthorized" });
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const url = new URL(req.url ?? "/", "http://x");
        this.#route(req.method ?? "GET", url.pathname, body, send, () => req.socket.destroy());
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      server,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  }

  #route(method: string, path: string, body: Record<string, unknown>, send: (s: number, b?: unknown) => void, drop: () => void): void {
    if (method === "POST" && path === "/internal/jobs/lease") {
      this.calls.lease += 1;
      if (this.failLease && this.failLease.remaining > 0) {
        this.failLease.remaining -= 1;
        return send(this.failLease.status, { error: "down" });
      }
      const kinds = body.kinds as string[];
      const max = body.max as number;
      const jobs = [];
      for (const job of [...this.queued]) {
        if (jobs.length >= max) break;
        if (!kinds.includes(job.kind)) continue;
        this.queued.splice(this.queued.indexOf(job), 1);
        const leaseId = `lse_${job.id}_${this.calls.lease}`;
        this.leased.set(job.id, { job, leaseId });
        jobs.push({ id: job.id, kind: job.kind, payload: job.payload, leaseId, leaseExpiresAt: new Date(Date.now() + this.leaseSeconds * 1000).toISOString(), attempts: 1 });
      }
      return send(200, { jobs });
    }
    let m = /^\/internal\/jobs\/([^/]+)\/(heartbeat|complete|fail)$/.exec(path);
    if (method === "POST" && m) {
      const [, id, action] = m as unknown as [string, string, string];
      const held = this.leased.get(id);
      if (!held || held.leaseId !== body.leaseId) return send(409, { error: "lease lost" });
      if (action === "heartbeat") {
        this.calls.heartbeat.push(id);
        if (this.loseLeaseOnHeartbeat.has(id)) {
          this.leased.delete(id);
          return send(409, { error: "lease lost" });
        }
        return send(200, { leaseExpiresAt: new Date(Date.now() + this.leaseSeconds * 1000).toISOString() });
      }
      this.leased.delete(id);
      if (action === "complete") this.calls.complete.push({ id, result: body.result });
      else this.calls.fail.push({ id, error: body.error as string, retryable: body.retryable as boolean, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) });
      return send(200, { ok: true });
    }
    m = /^\/internal\/sync\/([^/]+)\/batch$/.exec(path);
    if (method === "POST" && m) {
      const engineUserId = m[1]!;
      this.#batchCalls += 1;
      if (this.failBatchCall && this.failBatchCall.call === this.#batchCalls) {
        const status = this.failBatchCall.status;
        this.failBatchCall = null;
        this.failedBatchKeys.push(String(body.idempotencyKey));
        return send(status, { error: "injected" });
      }
      const parsed = syncBatchSchema.safeParse(body);
      if (!parsed.success) return send(400, { error: "invalid batch", issues: parsed.error.issues.length });
      const batch = parsed.data;
      if (![...this.leased.values()].some((l) => l.leaseId === batch.leaseId)) return send(409, { error: "lease lost" });
      this.calls.batches.push(batch);
      const seen = this.batchKeys.get(`${engineUserId}:${batch.idempotencyKey}`);
      if (seen !== undefined) return send(200, { accepted: 0, duplicates: seen });
      const store = this.imported.get(engineUserId) ?? new Map<string, unknown>();
      this.imported.set(engineUserId, store);
      let dup = 0;
      for (const e of batch.entries) {
        if (store.has(e.externalId)) dup += 1;
        store.set(e.externalId, e);
      }
      this.batchKeys.set(`${engineUserId}:${batch.idempotencyKey}`, batch.entries.length);
      this.checkpoints.set(engineUserId, { ...batch.checkpoint, engineIdentity: batch.engineIdentity });
      return send(200, { accepted: batch.entries.length - dup, duplicates: dup });
    }
    m = /^\/internal\/sync\/([^/]+)\/checkpoint$/.exec(path);
    if (method === "GET" && m) {
      return send(200, this.checkpoints.get(m[1]!) ?? { continuation: null, newestCrawlUsec: null, engineIdentity: null });
    }
    m = /^\/internal\/deletions\/([^/]+)(?:\/(attempt|removed|review|finalize))?$/.exec(path);
    if (method === "POST" && m) {
      const [, engineUserId, step = "state"] = m as unknown as [string, string, string | undefined];
      this.deletionCalls.push(`${engineUserId} ${step}`);
      const d = this.deletions.get(engineUserId);
      if (step === "finalize" && (!d || d.finalized)) return send(200, { finalized: false });
      const held = this.leased.get(String(body.jobId));
      if (!d || !held || held.leaseId !== body.leaseId) return send(409, { error: "lease lost" });
      const now = new Date().toISOString();
      if (step === "attempt") d.engineAttemptedAt ??= now;
      if (step === "removed") { d.engineRemovedAt ??= now; d.engineReviewAt = null; }
      if (step === "review") { d.engineReviewAt ??= now; this.leased.delete(String(body.jobId)); }
      if (step === "finalize") {
        if (!d.engineRemovedAt) return send(409, { error: "not removed" });
        d.finalized = true;
        this.leased.delete(String(body.jobId));
        if (this.loseFinalizeAnswer) { this.loseFinalizeAnswer = false; return drop(); }
        return send(200, { finalized: true });
      }
      return send(200, { engineAttemptedAt: d.engineAttemptedAt, engineRemovedAt: d.engineRemovedAt, engineReviewAt: d.engineReviewAt });
    }
    m = /^\/internal\/engine-users\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const u = this.engineUsers.get(m[1]!);
      return u ? send(200, u) : send(404, { error: "unknown" });
    }
    send(404, { error: "no route" });
  }
}
