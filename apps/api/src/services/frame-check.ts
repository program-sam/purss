import { checkFraming } from "@purss/connectors";
import type { FrameCheck } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { badRequest, rateLimit } from "../http.ts";
import { server } from "@purss/copy/server";

/*
 * Whether the reader can show a page from another site in a frame: the page's own headers decide,
 * so the server reads them (through safeFetch) and remembers the answer for a while. The memory is per PURSS:
 * how fast an answer comes must not tell one account which pages another opened.
 */

export type FrameChecker = (url: string, embedderOrigin: string) => Promise<FrameCheck>;

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const known = new Map<string, { check: Promise<FrameCheck>; expires: number }>();

/** The answer for `url`, from memory or by reading the page's headers. Only http(s) addresses are read. */
export function frameCheck(app: App, p: Principal, raw: string, checker: FrameChecker = checkFraming): Promise<FrameCheck> {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest(server.api.frameCheck.notWebAddress); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest(server.api.frameCheck.onlyWebAddresses);
  url.hash = "";
  const key = `${p.workspaceId} ${url.href}`;
  const now = Date.now();
  const hit = known.get(key);
  if (hit && hit.expires > now) return hit.check;
  rateLimit(`frame-check:${p.accountId}`, 300, 10 * 60_000);
  // A failure to answer is "no frame"; it is remembered like any answer.
  const check = checker(url.href, app.config.publicOrigin).catch((): FrameCheck => ({ frame: false }));
  if (known.size >= MAX_ENTRIES) {
    for (const [k, v] of known) if (v.expires <= now) known.delete(k);
    if (known.size >= MAX_ENTRIES) known.delete(known.keys().next().value!);
  }
  known.delete(key);
  known.set(key, { check, expires: now + TTL_MS });
  return check;
}

/** TEST ONLY: forget every answer. */
export function forgetFrameChecks(): void {
  known.clear();
}
