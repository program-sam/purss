import type { Server } from "node:http";
import { newId } from "@purss/domain";
import type { AddressInfo } from "node:net";
import type { App, Principal } from "./app.ts";
import { SESSION_COOKIE, resolvePrincipal } from "./auth/accounts.ts";
import { Router } from "./http.ts";
import type { Ctx } from "./app.ts";
import { addSeconds, nowIso } from "./http.ts";
import { publicServer } from "./server.ts";
import { randomToken, sha256, writeSecret } from "./secrets.ts";
import { batch, entry, makeSource } from "./testing.ts";
import { applySyncBatch } from "./services/sync.ts";
import { createBasket } from "./services/collections.ts";
import { keepItem } from "./services/state.ts";
import { completeCapture } from "./services/captures.ts";

/*
 * Test support for the feature routers: a real HTTP listener around the real server code
 * (sessions, origin and CSRF checks included) without the core router, which needs the
 * connectors package, and a realistic small library to run the features against.
 */

export type TestSession = { cookie: string; csrf: string };

/** Insert a session row the way sign-in would, so requests resolve to a real principal. */
export function signIn(app: App, accountId: string, opts: { authAgeSeconds?: number } = {}): TestSession {
  const token = randomToken(32);
  const csrf = randomToken(12);
  const authAt = new Date(Date.now() - (opts.authAgeSeconds ?? 0) * 1000).toISOString();
  app.db.run("INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, last_seen_at, auth_at, method) VALUES (?, ?, ?, ?, ?, ?, ?, 'test')",
    sha256(token), accountId, csrf, nowIso(), addSeconds(3600), nowIso(), authAt);
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf };
}

/** A principal backed by a real session row, for code that re-checks the credential after an await. */
export function signedInPrincipal(app: App, accountId: string): Principal & { session: TestSession } {
  const session = signIn(app, accountId);
  const p = resolvePrincipal(app, decodeURIComponent(session.cookie.slice(SESSION_COOKIE.length + 1)));
  if (!p) throw new Error("the test session didn't resolve");
  return { ...p, session };
}

export async function startTestServer(app: App, routers: Router<Ctx>[], pages?: Router<Ctx>): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = publicServer(app, routers, { publicPages: pages, events: (_req, res) => { res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

export type Reply = { status: number; headers: Headers; text: string; json: any };

export async function call(app: App, base: string, method: string, path: string, session: TestSession | null, body?: unknown, extra: { contentType?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { origin: app.config.publicOrigin, ...(extra.headers ?? {}) };
  if (session) { headers.cookie = session.cookie; headers["x-purss-csrf"] = session.csrf; }
  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    headers["content-type"] = extra.contentType ?? (typeof body === "string" ? "text/plain" : "application/json");
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

export const PRIVATE_FEED_URL = "https://feeds.example/u/9f8e7d6c5b4a39281706f5e4d3c2b1a0?token=SUPERSECRETTOKEN123";
export const PRIVATE_ITEM_URL = "https://feeds.example/item/abc?key=ITEMSECRET456";

export type Library = {
  publicSource: string;
  privateSource: string;
  baskets: { reading: string; later: string };
  /** Insertion order: the corrected first post, two more public posts, the private note. */
  itemIds: [string, string, string, string];
  keptIds: string[];
  privateItemId: string;
  pinnedOld: { itemId: string; versionId: string; title: string };
  captureId: string;
};

/** Public and private sources, items kept in two baskets, an upstream edit after keeping, and a captured text. */
export function seedLibrary(app: App, p: Principal & { engineUserId: string }): Library {
  const publicSource = makeSource(app, p, "Sediment Letters", "feed/1");
  const privateSource = makeSource(app, p, "Secret Garden", "feed/2", { isPrivate: true });
  writeSecret(app.config.secretsDir, `source-urls/${privateSource}`, PRIVATE_FEED_URL);
  const first = entry("feed/1", { title: "Tidal flats and sediment", contentHtml: "<p>Long form text about <b>sediment</b> transport.</p>" });
  const rest = [entry("feed/1", { title: "Second post" }), entry("feed/1", { title: "Third post" })];
  const secret = entry("feed/2", { title: "Private note", url: PRIVATE_ITEM_URL, originalGuid: PRIVATE_ITEM_URL, summaryHtml: `<p>See <a href="${PRIVATE_ITEM_URL}">this</a></p>` });
  applySyncBatch(app, p.engineUserId, batch([first, ...rest, secret]));
  const ids = app.db.all<{ id: string; title: string }>("SELECT id, title FROM items ORDER BY seq");
  const id = (title: string) => ids.find((i) => i.title === title)!.id;

  const reading = createBasket(app, p, { name: "Reading", captureMode: "text" }).id;
  const later = createBasket(app, p, { name: "Later", captureMode: "metadata" }).id;
  keepItem(app, p, id("Tidal flats and sediment"), reading);
  keepItem(app, p, id("Second post"), later);
  keepItem(app, p, id("Private note"), later);
  const pinned = app.db.get<{ version_id: string }>("SELECT version_id FROM basket_items WHERE item_id = ? AND basket_id = ?", id("Tidal flats and sediment"), reading)!;
  // An upstream correction after keeping: the kept snapshot must stay as it was.
  applySyncBatch(app, p.engineUserId, batch([{ ...first, title: "Tidal flats (corrected)", contentHtml: "<p>Corrected text.</p>" }]));
  const capture = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", id("Tidal flats and sediment"))!;
  app.db.tx(() => completeCapture(app, capture.id, { ok: true, title: "Tidal flats", text: "Captured readable text about sediment.", html: "<p>Captured readable text about sediment.</p>", finalUrl: first.url, bytes: 40 }));
  return {
    publicSource, privateSource, baskets: { reading, later },
    itemIds: ids.map((i) => i.id) as Library["itemIds"], keptIds: [id("Tidal flats and sediment"), id("Second post"), id("Private note")],
    privateItemId: id("Private note"), pinnedOld: { itemId: id("Tidal flats and sediment"), versionId: pinned.version_id, title: "Tidal flats and sediment" }, captureId: capture.id,
  };
}


/**
 * A share of a basket or collection, as a row, whatever the account's plan (for tests about other things:
 * suspension, deletion, export). The sharing journey itself goes through the routes in routes/sharing.test.ts.
 */
export function shareRow(app: App, p: Principal, kind: "basket" | "collection", targetId: string, status: "draft" | "published" | "paused" = "published", curatorName = "Me"): string {
  const id = newId("shr");
  app.db.run("INSERT INTO shares (id, workspace_id, target_kind, target_id, slug, curator_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, p.workspaceId, kind, targetId, `shared-${id.slice(-8)}`, curatorName, status, nowIso(), nowIso());
  return id;
}
