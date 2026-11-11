import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@purss/domain";
import type { App, Principal } from "./app.ts";
import { createAccount, setInstallation } from "./auth/accounts.ts";
import { preparePassword } from "./auth/passwords.ts";
import { call, startTestServer } from "./features-testing.ts";
import type { Reply, TestSession } from "./features-testing.ts";
import { extraRouters } from "./routes/index.ts";
import { internalRouter } from "./routes/internal.ts";
import { publicRouter } from "./routes/public.ts";
import { internalServer } from "./server.ts";
import { batch, entry, makeSource, makeTestApp } from "./testing.ts";
import { addSeconds, nowIso } from "./http.ts";
import { sha256 } from "./secrets.ts";
import { issueCode } from "./connect/codes.ts";
import { createDeviceToken } from "./connect/devices.ts";
import { exchangeCode } from "./oauth/grants.ts";
import { putAnnotation } from "./services/annotations.ts";
import { saveBrowserCapture } from "./services/captures.ts";
import { completeImages } from "./services/images.ts";
import { savePlayback } from "./services/media.ts";
import { applySyncBatch } from "./services/sync.ts";

/*
 * Test support for account deletion: the real public and internal listeners, accounts that can
 * sign in with a password, and requests whose body is held back while something else happens.
 */

export type Member = { accountId: string; workspaceId: string; engineUserId: string; username: string; password: string };

export async function bootDeletion(env: Record<string, string> = {}) {
  const { app, cleanup } = makeTestApp(env);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const internal: Server = internalServer(app, internalRouter(app));
  await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
  const internalBase = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
  return {
    app,
    base: server.base,
    /** A request on the public listener, as the given session (or signed out). */
    api: (s: TestSession | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
      call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body, { headers }),
    /** A worker call on the internal listener. */
    worker: async (path: string, body: unknown = {}): Promise<{ status: number; json: any }> => {
      const res = await fetch(internalBase + path, { method: "POST", headers: { authorization: `Bearer ${app.serviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    close: async () => {
      await server.close();
      await new Promise<void>((resolve) => { internal.close(() => resolve()); internal.closeAllConnections(); });
      cleanup();
    },
  };
}
export type DeletionBoot = Awaited<ReturnType<typeof bootDeletion>>;

let n = 0;
/** An account with a display name (or none), a ready engine user and a password to sign in with. */
export async function member(app: App, displayName: string | null, opts: { admin?: boolean } = {}): Promise<Member> {
  const username = `member${++n}${Date.now().toString(36)}`;
  const password = "correct horse battery";
  const prepared = await preparePassword(username, password);
  const { accountId, workspaceId } = app.db.tx(() => createAccount(app, { displayName, admin: opts.admin ?? false, allocationBytes: null, grantedBy: null, password: prepared }));
  const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
  app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
  return { accountId, workspaceId, engineUserId: eu.id, username, password };
}

/** The `name=value` pair of a cookie the response set, or null. */
export function setCookie(r: Reply | Response, name: string): { pair: string; header: string } | null {
  const header = r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header ? { pair: header.split(";")[0]!, header } : null;
}

export const signInWithPassword = (b: DeletionBoot, m: Member) => b.api(null, "POST", "/api/auth/password", { username: m.username, password: m.password });

/** Make a deletion due now (as if the grace period had passed). */
export function makeDue(app: App, accountId: string): void {
  app.db.run("UPDATE account_deletions SET due_at = ? WHERE account_id = ?", new Date(Date.now() - 1000).toISOString(), accountId);
}

/**
 * A request whose headers are sent at once and whose body only when `finish()` is called, so a test can
 * change things while the server is still reading it. Resolves the reply after `finish()`.
 */
export function stalledRequest(base: string, path: string, headers: Record<string, string>, body: string): { finish: () => Promise<{ status: number; json: any }>; started: Promise<void> } {
  const bytes = Buffer.from(body);
  const url = new URL(path, base);
  let resolveReply!: (v: { status: number; json: any }) => void;
  let rejectReply!: (e: unknown) => void;
  const reply = new Promise<{ status: number; json: any }>((res, rej) => { resolveReply = res; rejectReply = rej; });
  const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": String(bytes.length) } }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveReply({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
    });
  });
  req.on("error", rejectReply);
  const half = Math.floor(bytes.length / 2);
  const started = new Promise<void>((resolve) => req.write(bytes.subarray(0, half), () => resolve()));
  // Give the server time to route the request and start reading the body.
  const ready = started.then(() => new Promise<void>((r) => setTimeout(r, 50)));
  return {
    started: ready,
    finish: async () => {
      req.end(bytes.subarray(half));
      return reply;
    },
  };
}

/** Every value in every table (except the audit log) that mentions one of the ids, as "table.column". */
export function rowsMentioning(app: App, ids: string[]): string[] {
  const found: string[] = [];
  const tables = app.db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('audit_events', 'schema_migrations')");
  for (const t of tables) {
    if (/CREATE VIRTUAL TABLE/i.test(t.sql ?? "")) continue; // its shadow tables are checked instead
    for (const c of app.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t.name}')`)) {
      for (const id of ids) {
        const hit = app.db.get(`SELECT 1 FROM "${t.name}" WHERE typeof("${c.name}") = 'text' AND instr("${c.name}", ?) > 0 LIMIT 1`, id);
        if (hit) found.push(`${t.name}.${c.name} (${id})`);
      }
    }
  }
  return found;
}

/** The verifier and challenge of a PKCE pair (RFC 7636 appendix B). */
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const ASSISTANT = "https://assistant.example/client";

export type AdjacentData = {
  itemId: string;
  deviceToken: string;
  accessToken: string;
  refreshToken: string;
  /** A word only this account's highlights and notes contain. */
  word: string;
};

/**
 * One of everything the connected apps, playback positions, highlights and notes, browser capture, email
 * and assistants connected with OAuth keep for an account, made through the real services where
 * there is one. Needs PURSS_ASSISTANT_OAUTH=on for the OAuth grant.
 */
export function seedAdjacent(app: App, p: Principal & { engineUserId: string }, word = "zygomorph"): AdjacentData {
  const stream = `feed/pod-${p.accountId}`;
  makeSource(app, p, "Podcast", stream);
  const episode = (n: number) => entry(stream, { title: `Episode ${n} ${word}`, enclosures: [{ url: `https://media.example/${p.accountId}/${n}.mp3`, type: "audio/mpeg", length: 4 }] });
  applySyncBatch(app, p.engineUserId, batch([episode(1), episode(2)]));
  const episodeId = app.db.get<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? AND title LIKE 'Episode %' ORDER BY title", p.workspaceId)!.id;
  savePlayback(app, p, episodeId, { positionSeconds: 42, durationSeconds: 120 });

  putAnnotation(app, p, episodeId, newId("ann"), { kind: "highlight", quote: { exact: `a ${word} passage`, prefix: "", suffix: "" }, position: null, target: null, body: `${word} comment`, updatedAt: nowIso() });
  putAnnotation(app, p, episodeId, newId("ann"), { kind: "note", body: `${word} note`, updatedAt: nowIso() });
  saveBrowserCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: episodeId, url: "https://example.org/page", title: "Page", html: `<p>${word} text</p>`, text: `${word} text` });
  // A picture kept with the item, as the worker delivers it (the eight bytes every PNG starts with).
  const picture = `https://pictures.example/${p.accountId}.png`;
  completeImages(app, { itemId: episodeId, urls: [picture] }, { images: [{ url: picture, contentType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64") }] });

  // Connected apps (the phone with notifications on), a connection waiting for its code, an assistant connected with OAuth.
  const phone = createDeviceToken(app, p.accountId, "mobile", "Phone");
  const deviceToken = phone.secret;
  createDeviceToken(app, p.accountId, "extension", "Browser");
  // The phone registered for notifications (plan/37).
  app.db.run("INSERT INTO push_devices (device_id, account_id, relay, handle, fetch_hash, shown_until, created_at) VALUES (?, ?, 'https://push.example.org', ?, ?, ?, ?)",
    phone.device.id, p.accountId, `rh_${"P".repeat(43)}`, sha256(`push-${p.accountId}`), nowIso(), nowIso());
  issueCode(app, { accountId: p.accountId, kind: "extension", clientId: null, redirectUri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/", label: "Browser", scope: null }, CHALLENGE, "redirect");
  setInstallation(app, "assistant_access", "on");
  app.db.run("UPDATE accounts SET assistant_access = 1 WHERE id = ?", p.accountId);
  const code = issueCode(app, { accountId: p.accountId, kind: "oauth", clientId: ASSISTANT, redirectUri: "https://assistant.example/cb", label: "Assistant", scope: "read" }, CHALLENGE, "redirect");
  const tokens = exchangeCode(app, { code, codeVerifier: VERIFIER, clientId: ASSISTANT, redirectUri: "https://assistant.example/cb" });
  if (!("access_token" in tokens)) throw new Error(`seedAdjacent: ${tokens.error_description}`);
  const grantId = app.db.get<{ id: string }>("SELECT id FROM oauth_grants WHERE account_id = ?", p.accountId)!.id;
  app.db.run("INSERT INTO oauth_refreshes (account_id, grant_id, at) VALUES (?, ?, ?)", p.accountId, grantId, nowIso());

  // Email: a confirmed address, a link not used yet, a message waiting to be sent, and what was sent.
  app.db.run("UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?", `${p.accountId}@example.org`, nowIso(), p.accountId);
  app.db.run("INSERT INTO email_tokens (id, account_id, purpose, email, created_at, expires_at) VALUES (?, ?, 'verify', ?, ?, ?)",
    sha256(`verify-${p.accountId}`), p.accountId, `${p.accountId}@example.org`, nowIso(), addSeconds(3600));
  app.db.run("INSERT INTO mail_queue (id, kind, account_id, sealed, created_at, next_attempt_at) VALUES (?, 'verify', ?, 'sealed', ?, ?)", newId("mlq"), p.accountId, nowIso(), addSeconds(3600));
  app.db.run("INSERT INTO mail_log (id, at, kind, account_id, recipient, outcome) VALUES (?, ?, 'verify', ?, 'a•••@example.org', 'sent')", newId("mlg"), nowIso(), p.accountId);

  return {
    itemId: episodeId,
    deviceToken,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    word,
  };
}
