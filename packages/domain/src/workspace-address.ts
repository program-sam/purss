/*
 * The PURSS address the apps and the browser extension connect to (plan/31, plan/32): one rule
 * for both. HTTPS everywhere, except on this device and the local network, where self-hosted
 * PURSSes often run without TLS; there plain HTTP is allowed and the person is told it isn't
 * encrypted. Plain HTTP to anything else is refused: the app's or extension's token would cross
 * the internet readable by anyone on the way. Whether to allow the local network at all is an open
 * question for the owner (plan/31); this is the conservative default.
 */

export type WorkspaceAddress = { ok: true; origin: string; unencrypted: boolean } | { ok: false; message: string };

/** Names that only resolve on a local network (RFC 6762 .local, RFC 8375 .home.arpa, and common private ones). */
const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa"];

function ipv4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** The first 16 bits of a bracketed IPv6 host as URL writes it ("[fe80::1]"), or null. */
function ipv6Head(h: string): number | null {
  if (!h.startsWith("[") || !h.endsWith("]")) return null;
  const first = h.slice(1, -1).split(":")[0] ?? "";
  return first === "" ? 0 : /^[0-9a-f]{1,4}$/.test(first) ? parseInt(first, 16) : null;
}

/** This device: localhost names, 127.0.0.0/8, ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]") return true;
  return ipv4(h)?.[0] === 127;
}

/**
 * This device or the local network: loopback; private IPv4 (10/8, 172.16/12, 192.168/16), shared
 * address space (100.64/10, CGNAT, e.g. Tailscale) and link-local (169.254/16); IPv6 unique local
 * (fc00::/7) and link-local (fe80::/10); and local-only names.
 */
export function isLocalNetworkHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (isLoopbackHost(h) || LOCAL_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length)) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const head = ipv6Head(h);
  return head !== null && ((head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80);
}

/**
 * PURSS's origin from what the person typed. Without a scheme it is https, except for an
 * address on this device or the local network, which means http. `unencrypted`: plain HTTP that
 * leaves this device, which the person is told about.
 */
export function parseWorkspaceAddress(input: string): WorkspaceAddress {
  const raw = input.trim();
  if (!raw) return { ok: false, message: "Enter your PURSS's address." };
  let url: URL;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    url = new URL(hasScheme ? raw : `https://${raw}`);
    if (!hasScheme && isLocalNetworkHost(url.hostname)) url = new URL(`http://${raw}`);
  } catch {
    return { ok: false, message: "That doesn't look like a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: "Use the address you open the PURSS at, starting with https://." };
  if (!url.hostname) return { ok: false, message: "That doesn't look like a web address." };
  if (url.username || url.password) return { ok: false, message: "Leave the user name and password out of the address." };
  if (url.protocol === "http:" && !isLocalNetworkHost(url.hostname)) {
    return { ok: false, message: "This address isn't encrypted (http). Use https://, or an address on this device or your local network." };
  }
  return { ok: true, origin: url.origin, unencrypted: url.protocol === "http:" && !isLoopbackHost(url.hostname) };
}

/** What the apps and the extension say about an unencrypted PURSS address. */
export const UNENCRYPTED_NOTE = "This address isn't encrypted (http), so anyone on your network can read what is sent. Use it only on a network you trust.";

export type ServerChoice = { kind: "official"; origin: string } | { kind: "other"; address: string };

/**
 * Which server a connect screen starts on: the official one (`official`, OFFICIAL_WORKSPACE_ORIGIN in
 * distribution.ts), unless the person chose another one before (`remembered`). With no official server,
 * always the address field, prefilled with what was remembered.
 */
export function startingServer(remembered: string | null | undefined, official: string): ServerChoice {
  const off = official.trim() ? parseWorkspaceAddress(official) : null;
  const before = remembered?.trim() ? parseWorkspaceAddress(remembered) : null;
  if (off?.ok && (!before?.ok || before.origin === off.origin)) return { kind: "official", origin: off.origin };
  return { kind: "other", address: before?.ok ? before.origin : (remembered ?? "") };
}
