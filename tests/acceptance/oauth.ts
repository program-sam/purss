// Acceptance journey for assistants that connect with OAuth (plan/33), against the real API serving
// the built web app (no FreshRSS, egress or worker, so no podman and no network). The script plays
// the assistant the way Claude or ChatGPT does: /mcp answers 401 with the protected resource
// metadata, which names the authorization server; the assistant identifies itself with a client
// metadata document (served from a local HTTPS server and fetched by the API through safeFetch's
// in-process test hooks) and sends the person to the consent page. The person signs in, turns
// assistant access on for their account from that page, allows reading only, and the browser is
// sent to the assistant's callback with the code. The assistant exchanges it with PKCE, calls MCP,
// refreshes, and Settings → Assistants lists it; revoking ends it. A declined request goes back as
// access_denied. The API runs in this process so the test hooks reach it.
// Run: node tests/acceptance/oauth.ts (after npm run build)
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import type { Principal } from "../../apps/api/src/app.ts";
import { claim, ensureClaimCode, setInstallation } from "../../apps/api/src/auth/accounts.ts";
import { setPreferences } from "../../apps/api/src/services/preferences.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp, start } from "../../apps/api/src/main.ts";
import { applySyncBatch } from "../../apps/api/src/services/sync.ts";
import { batch, entry, makeSource } from "../../apps/api/src/testing.ts";
import { startClientSite } from "../../apps/api/src/oauth/testing.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(path.join(os.tmpdir(), "purss-oauth-"));
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}
const PORT = await freePort();
const origin = `http://localhost:${PORT}`;
const env: Record<string, string> = {
  PURSS_DATA_DIR: path.join(work, "data"),
  PURSS_PORT: String(PORT),
  PURSS_INTERNAL_PORT: String(await freePort()),
  PURSS_PUBLIC_ORIGIN: origin,
  PURSS_WEB_DIST: path.join(repo, "apps/web/dist"),
  PURSS_DISK_RESERVE_BYTES: "0",
  PURSS_ASSISTANT_OAUTH: "on",
};
const step = (s: string) => console.log(`✓ ${s}`);
const b64url = (b: Buffer) => b.toString("base64url");

/** A claimed installation with one source and an article; assistant access on for the installation only. */
function prepare(): { recoveryCodes: string[] } {
  const app = createApp(loadConfig(env));
  try {
    const code = ensureClaimCode(app);
    assert.ok(code, "a fresh installation has a setup code");
    const { accountId, recoveryCodes } = claim(app, code, "Reader");
    // The first-visit question has its own journey (run.ts); this one starts after it.
    setPreferences(app, app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id, { welcomeAsked: true });
    const workspaceId = app.db.get<{ id: string }>("SELECT id FROM workspaces WHERE account_id = ?", accountId)!.id;
    const eu = app.db.get<{ id: string }>("SELECT id FROM engine_users WHERE account_id = ?", accountId)!;
    app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", eu.id);
    const p: Principal = { accountId, workspaceId, isAdmin: true, sessionId: "prep", csrf: "x", authAt: new Date().toISOString() };
    makeSource(app, p, "Tidal Notes", "feed/1");
    applySyncBatch(app, eu.id, batch([entry("feed/1", { title: "Tidal flats and sediment" })]));
    setInstallation(app, "assistant_access", "on");
    return { recoveryCodes };
  } finally {
    app.db.close();
  }
}

type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string };
const form = async (url: string, fields: Record<string, string>) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, string> | null };
};
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: res.status, json: (await res.json().catch(() => null)) as { result?: Record<string, any> } | null };
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) throw new Error("Build the web app first: npm run build");
  const { recoveryCodes } = prepare();
  const site = await startClientSite();
  const running = await start(loadConfig(env));
  const browser = await chromium.launch();
  let page: Page | null = null;
  try {
    const callback = `${site.origin()}/callback`;
    const clientId = site.document("/client-metadata.json", { client_name: "Helpful Assistant", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });

    // Discovery, as the MCP authorization spec describes it.
    const first = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(first.status, 401);
    const challenge = first.headers.get("www-authenticate")!;
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
    const scope = /scope="([^"]+)"/.exec(challenge)![1]!;
    const prm = (await (await fetch(prmUrl)).json()) as { resource: string; authorization_servers: string[] };
    const issuer = prm.authorization_servers[0]!;
    const meta = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    assert.equal(meta.issuer, issuer);
    assert.ok(meta.code_challenge_methods_supported.includes("S256") && meta.token_endpoint_auth_methods_supported.includes("none") && meta.client_id_metadata_document_supported);
    step("the assistant finds the authorization server from /mcp's 401 and its metadata");

    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const authorizeUrl = (s: string) => `${meta.authorization_endpoint}?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: callback, state: s, scope, resource: prm.resource,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    })}`;

    page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The assistant's callback: catch the browser arriving there instead of resolving its made-up host.
    const arrived: string[] = [];
    await page.route((u) => u.host === new URL(callback).host, (r) => { arrived.push(r.request().url()); return r.fulfill({ status: 200, contentType: "text/plain", body: "back at the assistant" }); });

    const consent = await page.goto(authorizeUrl(state));
    assert.equal(consent!.headers()["x-frame-options"], "DENY");
    await page.waitForURL(/\/signin\?next=/);
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "Sign in with this code" }).click();
    await page.waitForURL(/\/oauth\/authorize\?/);
    await page.getByText("Let Helpful Assistant use your PURSS?").waitFor();
    await page.getByText(`Identified by ${new URL(clientId).host}`).waitFor();
    await page.getByText(`Sends you back to ${new URL(callback).host}`).waitFor();
    step("signed out, the person goes through sign-in and lands on the consent page naming the assistant, its host and where it returns");

    assert.ok(await page.getByRole("button", { name: "Allow", exact: true }).isDisabled(), "nothing can be allowed while the account's switch is off");
    await page.getByRole("button", { name: "Turn it on" }).click();
    await page.getByRole("button", { name: "Allow", exact: true }).and(page.locator(":enabled")).waitFor();
    await page.getByRole("checkbox", { name: /Also let it organise/ }).uncheck();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await waitUntil(() => arrived.length > 0);
    const back = new URL(arrived[0]!);
    assert.deepEqual([back.searchParams.get("state"), back.searchParams.get("iss")], [state, issuer]);
    const code = back.searchParams.get("code")!;
    step("the person turns assistant access on from the page, allows reading only, and the browser returns to the assistant with the code, state and iss");

    const tokens = await form(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: callback, client_id: clientId, code_verifier: verifier, resource: prm.resource });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.json));
    const t1 = tokens.json as unknown as Tokens;
    assert.equal(t1.scope, "read");
    const init = await mcp(t1.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
    assert.equal(init.status, 200);
    const tools = (await mcp(t1.access_token, "tools/list")).json!.result!.tools as { name: string }[];
    assert.ok(tools.some((x) => x.name === "search_items") && !tools.some((x) => x.name === "set_item_state"), "reading tools only");
    const found = await mcp(t1.access_token, "tools/call", { name: "search_items", arguments: { query: "sediment" } });
    assert.equal(found.json!.result!.structuredContent.items[0].title, "Tidal flats and sediment");
    step("the code and verifier give a read-only token; MCP answers with the person's items");

    const refreshed = await form(meta.token_endpoint, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId, resource: prm.resource });
    assert.equal(refreshed.status, 200);
    const t2 = refreshed.json as unknown as Tokens;
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.equal((await mcp(t2.access_token, "tools/list")).status, 200);
    step("refreshing rotates the tokens");

    await page.goto(`${origin}/app/`);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Assistants" }).click();
    await page.getByText("Connected assistants").waitFor();
    await page.getByText("Helpful Assistant").waitFor();
    step("Settings → Assistants lists the connected assistant");

    assert.equal((await form(meta.revocation_endpoint, { token: t2.refresh_token, client_id: clientId })).status, 200);
    assert.equal((await mcp(t2.access_token, "tools/list")).status, 401);
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Assistants" }).click();
    await page.getByText("Let assistants use my PURSS").waitFor();
    assert.equal(await page.getByText("Helpful Assistant").count(), 0);
    step("the assistant revokes its token; MCP refuses it and Settings no longer lists it");

    const tokenName = page.getByLabel("Name, so you recognise it later");
    assert.equal(await tokenName.count(), 0, "the new-token form starts closed");
    if (process.env.PURSS_SHOT_DIR) await page.screenshot({ path: path.join(process.env.PURSS_SHOT_DIR, "tokens-closed.png") });
    await page.getByRole("button", { name: "New token" }).click();
    await tokenName.waitFor();
    assert.ok(await tokenName.evaluate((el) => el === document.activeElement), "the name field takes focus");
    if (process.env.PURSS_SHOT_DIR) await page.screenshot({ path: path.join(process.env.PURSS_SHOT_DIR, "tokens-open.png") });
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await tokenName.count(), 0);
    await page.getByRole("button", { name: "New token" }).waitFor();
    step("the new-token form opens from New token and closes on Cancel");

    const declineState = "second-attempt";
    await page.goto(authorizeUrl(declineState));
    await page.getByText("Let Helpful Assistant use your PURSS?").waitFor();
    await page.getByRole("button", { name: "Don't allow" }).click();
    await waitUntil(() => arrived.some((u) => u.includes(`state=${declineState}`)));
    const declined = new URL(arrived.find((u) => u.includes(`state=${declineState}`))!);
    assert.deepEqual([declined.searchParams.get("error"), declined.searchParams.get("iss"), declined.searchParams.get("code")], ["access_denied", issuer, null]);
    await page.goto(authorizeUrl("third").replace(encodeURIComponent(callback), encodeURIComponent("https://evil.example/callback")));
    await page.getByText("This sign-in link doesn't work").waitFor();
    assert.ok(!arrived.some((u) => u.includes("evil.example")));
    const before = arrived.length;
    await page.goto(`${authorizeUrl("fourth")}&state=fifth`);
    await page.getByText("This sign-in link doesn't work").waitFor();
    await page.getByText("gives “state” more than once").waitFor();
    assert.equal(arrived.length, before, "nothing went back to the assistant");
    step("declining sends access_denied back; a foreign return address or a repeated parameter is stopped on the page");

    assert.deepEqual(errors, [], "no uncaught page errors");
  } catch (err) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), "purss-oauth-failure.png") }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
    running.stop();
    await site.close();
  }
}

async function waitUntil(fn: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  await main();
  console.log("\nAssistant OAuth journey passed.");
} catch (err) {
  console.error("\nAssistant OAuth journey FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
