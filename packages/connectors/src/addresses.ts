import { BlockList, isIP } from "node:net";

/*
 * Destination address rules shared by product discovery, readable capture and the
 * engine egress proxy. The rules are fixed in code: nothing in the environment or a
 * config file can switch them off. Tests that need a loopback server pass an
 * in-process `testAllowAddress` function to the fetch layer instead.
 */

export type AddressVerdict = { allowed: true; family: 4 | 6 } | { allowed: false; range: string };

type Range4 = { net: string; prefix: number; name: string };

const BLOCKED_V4: readonly Range4[] = [
  { net: "0.0.0.0", prefix: 8, name: "unspecified" },
  { net: "10.0.0.0", prefix: 8, name: "private" },
  { net: "100.64.0.0", prefix: 10, name: "carrier-grade NAT" },
  { net: "127.0.0.0", prefix: 8, name: "loopback" },
  { net: "169.254.0.0", prefix: 16, name: "link-local / cloud metadata" },
  { net: "172.16.0.0", prefix: 12, name: "private" },
  { net: "192.0.0.0", prefix: 24, name: "reserved (IETF protocol assignments)" },
  { net: "192.0.2.0", prefix: 24, name: "documentation" },
  { net: "192.88.99.0", prefix: 24, name: "reserved (6to4 relay)" },
  { net: "192.168.0.0", prefix: 16, name: "private" },
  { net: "198.18.0.0", prefix: 15, name: "benchmarking" },
  { net: "198.51.100.0", prefix: 24, name: "documentation" },
  { net: "203.0.113.0", prefix: 24, name: "documentation" },
  { net: "224.0.0.0", prefix: 4, name: "multicast" },
  { net: "240.0.0.0", prefix: 4, name: "reserved" },
];

/** Individual public-looking addresses that expose cloud control planes. */
const METADATA_V4: readonly string[] = [
  "168.63.129.16", // Azure wire server
  "100.100.100.200", // Alibaba Cloud metadata (also inside CGNAT)
  "169.254.169.254", // AWS / GCP / Azure / OpenStack metadata
  "169.254.170.2", // AWS ECS task metadata
];

type Range6 = { net: string; prefix: number; name: string };

const BLOCKED_V6: readonly Range6[] = [
  { net: "::", prefix: 128, name: "unspecified" },
  { net: "::1", prefix: 128, name: "loopback" },
  { net: "::", prefix: 96, name: "reserved (IPv4-compatible)" },
  { net: "100::", prefix: 64, name: "discard-only" },
  { net: "2001::", prefix: 23, name: "reserved (IETF protocol assignments, Teredo)" },
  { net: "2001:db8::", prefix: 32, name: "documentation" },
  { net: "3fff::", prefix: 20, name: "documentation" },
  { net: "5f00::", prefix: 16, name: "reserved (segment routing)" },
  { net: "64:ff9b:1::", prefix: 48, name: "local-use NAT64" },
  { net: "fc00::", prefix: 7, name: "private (unique local)" },
  { net: "fe80::", prefix: 10, name: "link-local" },
  { net: "fec0::", prefix: 10, name: "reserved (site-local)" },
  { net: "ff00::", prefix: 8, name: "multicast" },
];

const blockV4 = new BlockList();
for (const r of BLOCKED_V4) blockV4.addSubnet(r.net, r.prefix, "ipv4");
for (const a of METADATA_V4) blockV4.addAddress(a, "ipv4");

const blockV6 = new BlockList();
for (const r of BLOCKED_V6) blockV6.addSubnet(r.net, r.prefix, "ipv6");
blockV6.addAddress("fd00:ec2::254", "ipv6"); // AWS IPv6 metadata (also inside fc00::/7)

function rangeNameV4(ip: string): string {
  for (const r of BLOCKED_V4) {
    const one = new BlockList();
    one.addSubnet(r.net, r.prefix, "ipv4");
    if (one.check(ip, "ipv4")) return r.name;
  }
  return "cloud metadata";
}

function rangeNameV6(ip: string): string {
  for (const r of BLOCKED_V6) {
    const one = new BlockList();
    one.addSubnet(r.net, r.prefix, "ipv6");
    if (one.check(ip, "ipv6")) return r.name;
  }
  return "cloud metadata";
}

/** Parse an IPv6 literal (no brackets, no zone id) into 16 bytes, or null. */
export function parseIPv6(input: string): Uint8Array | null {
  if (input.includes("%") || input.length > 45) return null;
  let text = input;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    const parts = maybeV4.split(".").map(Number);
    tail = [(parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (tail.length) {
    // the dotted tail replaced the last two groups
    groups = groups.slice(0, 6).concat(tail);
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

function v4FromBytes(b: Uint8Array, offset: number): string {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
}

/** IPv4 addresses embedded in IPv6 forms that would route to that IPv4 host. */
function embeddedV4(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) out.push(v4FromBytes(bytes, 12));
  // ::a.b.c.d (IPv4-compatible, deprecated)
  if (zeros(0, 12)) out.push(v4FromBytes(bytes, 12));
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) out.push(v4FromBytes(bytes, 12));
  // 2002:aabb:ccdd::/48 (6to4)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) out.push(v4FromBytes(bytes, 2));
  // ::ffff:0:a.b.c.d (IPv4-translated, SIIT)
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) out.push(v4FromBytes(bytes, 12));
  return out;
}

/**
 * Decide whether a literal IP address may be contacted on behalf of a user.
 * Anything that is not a clean IPv4/IPv6 literal is rejected.
 */
export function classifyAddress(ip: string): AddressVerdict {
  const kind = isIP(ip);
  if (kind === 4) {
    if (blockV4.check(ip, "ipv4")) return { allowed: false, range: rangeNameV4(ip) };
    return { allowed: true, family: 4 };
  }
  if (kind === 6) {
    const bytes = parseIPv6(ip);
    if (!bytes) return { allowed: false, range: "unparseable IPv6" };
    for (const v4 of embeddedV4(bytes)) {
      if (blockV4.check(v4, "ipv4")) return { allowed: false, range: `${rangeNameV4(v4)} (embedded in IPv6)` };
    }
    if (blockV6.check(ip, "ipv6")) return { allowed: false, range: rangeNameV6(ip) };
    return { allowed: true, family: 6 };
  }
  return { allowed: false, range: "not an IP address" };
}

export function isBlockedAddress(ip: string): boolean {
  return !classifyAddress(ip).allowed;
}

/** Ports of well-known non-web services. Blocked for both fetching and proxying. */
const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 445, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 2375, 2376, 2379,
  2380, 3306, 3389, 4190, 5060, 5061, 5432, 5900, 5984, 6000, 6379, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 9200, 9300, 10080, 10250, 10255, 11211, 27017,
]);

export function isBlockedPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535 || BLOCKED_PORTS.has(port);
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".intranet", ".corp", ".home", ".private"];

/**
 * Cheap name-based screen applied before DNS. It is only an early, clearer refusal:
 * the resolved-address check is what actually protects the network.
 */
export function hostnameVerdict(hostname: string): { ok: true } | { ok: false; message: string } {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, message: "That address has no host name." };
  if (isIP(host) || host.startsWith("[")) return { ok: true };
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, message: "That address points to this computer or a private network, so it can't be followed." };
  }
  if (!host.includes(".")) {
    return { ok: false, message: "That address has no domain name (it looks like an internal host), so it can't be followed." };
  }
  // WHATWG URL parsing has already converted internationalised names to ASCII (punycode).
  if (!/^[a-z0-9._-]+$/.test(host)) {
    return { ok: false, message: "That doesn't look like a valid web address." };
  }
  return { ok: true };
}

/** True when a URL host is an IP literal in a forbidden range (names are judged after DNS). */
export function isForbiddenLiteralHost(hostname: string): boolean {
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(literal) !== 0 && !classifyAddress(literal).allowed;
}
