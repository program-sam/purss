import { server } from "@purss/translations/server";
import { isForbiddenLiteralHost } from "./addresses.ts";
import { parseTarget } from "./safe-fetch.ts";

/** Turn whatever a person pasted into a clean http(s) URL, or explain what is wrong. */

export type NormalizedInput =
  | {
      ok: true;
      /** Address to try first (https where the person gave none or http). */
      url: string;
      /** Plain-http address to fall back to when the https attempt cannot connect. */
      httpFallback: string | null;
      /** The person wrote a port after the name, even a default one (`:443`, `:80`) that the address drops: the name is theirs to the letter, so it is not guessed at (`wwwAlternative`). */
      explicitPort: boolean;
    }
  | { ok: false; reason: "invalid" | "blocked"; message: string };

const FEED_SCHEMES = new Set(["feed", "feeds", "rss", "pcast", "itpc", "podcast"]);

export const EMAIL_MESSAGE = server.sources.connectors.input.email;
export const NAME_MESSAGE = server.sources.connectors.input.name;

/** One word or a few that were typed as a name: nothing in them is shaped like an address. */
function looksLikeAddress(token: string): boolean {
  return /[^\s.]\.[^\s.]/.test(token) || token.includes("/") || /^[a-z][a-z0-9+.-]*:/i.test(token);
}

function stripTrailingJunk(value: string): string {
  let s = value;
  for (let guard = 0; guard < 20; guard++) {
    const last = s.at(-1);
    if (!last) break;
    if (".,;:!?'\"“”‘’»`".includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    // Closing brackets are junk only when they have no opening partner in the URL.
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
    const open = pairs[last];
    if (open && (s.split(last).length - 1) > (s.split(open).length - 1)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/**
 * Springer Nature bounces a visitor without cookies back to the same address with
 * `?error=cookies_not_supported&code=<random>` added. That noise is not part of the address,
 * and its random `code` would look like a private key; drop it (and only it).
 */
export function withoutCookieBounce(href: string): string {
  let url: URL;
  try { url = new URL(href); } catch { return href; }
  if (url.searchParams.get("error") !== "cookies_not_supported") return href;
  url.searchParams.delete("error");
  url.searchParams.delete("code");
  return url.href;
}

/** What was pasted without invisible characters, surrounding quotes, brackets or trailing punctuation. */
export function cleanPasted(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, (c) => (/\s/.test(c) ? " " : "")).trim();
  return stripTrailingJunk(s.replace(/^[<(\["'“‘`]+/, ""));
}

export function normalizeInput(raw: string, opts: { testAllowAddress?: (ip: string) => boolean } = {}): NormalizedInput {
  if (!raw.trim()) return { ok: false, reason: "invalid", message: server.sources.connectors.input.empty };
  if (raw.trim().length > 2000) return { ok: false, reason: "invalid", message: server.sources.connectors.address.tooLong };
  let s = cleanPasted(raw);
  if (/\s/.test(s)) {
    if (!s.split(/\s+/).some(looksLikeAddress)) return { ok: false, reason: "invalid", message: NAME_MESSAGE };
    return { ok: false, reason: "invalid", message: server.sources.connectors.input.notSingle };
  }
  if (!s) return { ok: false, reason: "invalid", message: server.sources.connectors.input.empty };
  if (/^(?:mailto:)?[^\s@/:?#]+@[^\s@/:?#]+\.[^\s@/:?#]+$/i.test(s)) return { ok: false, reason: "invalid", message: EMAIL_MESSAGE };

  if (s.startsWith("@")) {
    return { ok: false, reason: "invalid", message: server.sources.connectors.input.bareHandle };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  let hadHttp = false;
  let bareFeedScheme = false;
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    const rest = s.slice(scheme[0].length);
    if (name === "http" || name === "https") {
      if (!rest.startsWith("//")) return { ok: false, reason: "invalid", message: server.sources.connectors.address.invalid };
      hadHttp = name === "http";
      s = `${name}:${rest}`;
    } else if (FEED_SCHEMES.has(name)) {
      // feed://example.com/rss, feed:https://example.com/rss
      bareFeedScheme = !/^https?:\/\//i.test(rest);
      s = bareFeedScheme ? `https:${rest.startsWith("//") ? rest : `//${rest}`}` : rest;
    } else if (/^[^/\s:]+\.[^/\s:]+:\d+(?:[/?#]|$)/.test(s) || /^localhost:\d+/i.test(s)) {
      s = `https://${s}`; // host:port with no scheme
    } else if (name === "mailto" || name === "javascript" || name === "data" || name === "file" || name === "ftp" || name === "tel" || name === "about" || name === "blob") {
      return { ok: false, reason: "invalid", message: server.sources.connectors.input.notWebScheme };
    } else {
      return { ok: false, reason: "invalid", message: server.sources.connectors.input.notWebAddress };
    }
  } else if (s.startsWith("//")) {
    s = `https:${s}`;
  } else if (!/[./:[]/.test(s) && s.toLowerCase() !== "localhost") {
    // A single word with no dot is a name (a channel, a person), not a web address.
    return { ok: false, reason: "invalid", message: NAME_MESSAGE };
  } else {
    s = `https://${s}`;
  }

  const target = parseTarget(s);
  if (!target.ok) return target;
  const url = new URL(withoutCookieBounce(target.url.href));
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isForbiddenLiteralHost(url.hostname) && !opts.testAllowAddress?.(literal)) {
    return { ok: false, reason: "blocked", message: server.sources.connectors.address.private };
  }
  const explicitPort = /^https?:\/\/[^/?#]*:\d+/i.test(s);
  if (hadHttp && !explicitPort) {
    const upgraded = new URL(url.href);
    upgraded.protocol = "https:";
    return { ok: true, url: upgraded.href, httpFallback: url.href, explicitPort };
  }
  if (!hadHttp && url.protocol === "https:" && !scheme && !explicitPort) {
    const fallback = new URL(url.href);
    fallback.protocol = "http:";
    return { ok: true, url: url.href, httpFallback: fallback.href, explicitPort };
  }
  if (bareFeedScheme && url.protocol === "https:") {
    const fallback = new URL(url.href);
    fallback.protocol = "http:";
    return { ok: true, url: url.href, httpFallback: fallback.href, explicitPort };
  }
  return { ok: true, url: url.href, httpFallback: null, explicitPort };
}

/**
 * The same address on its `www.` host, for a site whose bare host refuses automated readers (a bot challenge in front of the bare name),
 * fails or does not answer while the usual `www.` address works. Only a plain name qualifies: not one that starts with `www.`, an
 * address made of numbers, a single word or a name with its own port (`explicitPort`: written even when it is the scheme's default, which
 * the address then leaves out). It is checked like any pasted address, so a name that is not
 * allowed (an internal one) has no alternative. `httpFallback` follows the address's host too.
 */
export function wwwAlternative(input: { url: string; httpFallback: string | null; explicitPort?: boolean }): { url: string; httpFallback: string | null } | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (input.explicitPort || url.port || host.startsWith("www.") || host.startsWith("[") || !host.includes(".") || /^[\d.]+$/.test(host)) return null;
  const swap = (href: string): string => {
    const u = new URL(href);
    u.hostname = `www.${u.hostname}`;
    return u.href;
  };
  const alt = parseTarget(swap(url.href));
  if (!alt.ok) return null;
  let httpFallback: string | null = null;
  if (input.httpFallback) {
    const fallback = parseTarget(swap(input.httpFallback));
    if (fallback.ok) httpFallback = fallback.url.href;
  }
  return { url: alt.url.href, httpFallback };
}
