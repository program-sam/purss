import dgram from "node:dgram";
import { resolve4 } from "node:dns/promises";
import { classifyAddress } from "@purss/connectors";
import type { Logger } from "./proxy.ts";

/*
 * A minimal DNS resolver for the bridge container's network (plan/41). RSS-Bridge looks up every
 * host itself before it fetches (to pin the address), even when it sends the request through the
 * egress proxy, and its network has no other way out. This answers only IPv4 address questions,
 * and only with public addresses: a name with any private, loopback, link-local or otherwise
 * forbidden answer is refused as a whole, the same rule as the proxy's. Every other question type
 * gets an empty answer (AAAA) or "not implemented". It runs only on the bridge network.
 */

const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;
const RCODE = { ok: 0, formErr: 1, servFail: 2, nxDomain: 3, notImp: 4, refused: 5 } as const;
const TTL = 60;
const MAX_INFLIGHT = 64;

type Question = { id: number; rd: boolean; name: string; type: number; cls: number; end: number };

export type DnsLookup = (name: string) => Promise<string[]>;

function parseQuestion(msg: Buffer): Question | null {
  if (msg.length < 12 || msg.length > 512) return null;
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000 || ((flags >> 11) & 0xf) !== 0 || msg.readUInt16BE(4) !== 1) return null; // a standard query with one question
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    if (at >= msg.length) return null;
    const len = msg[at]!;
    at++;
    if (len === 0) break;
    if (len > 63 || at + len > msg.length) return null; // no compression pointers in a question
    labels.push(msg.subarray(at, at + len).toString("latin1"));
    at += len;
  }
  if (at + 4 > msg.length) return null;
  const name = labels.join(".").toLowerCase();
  if (!name || name.length > 253 || !/^[a-z0-9_.-]+$/.test(name)) return null;
  return { id, rd: Boolean(flags & 0x0100), name, type: msg.readUInt16BE(at), cls: msg.readUInt16BE(at + 2), end: at + 4 };
}

function answer(msg: Buffer, q: Question, rcode: number, addresses: string[] = []): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(q.id, 0);
  head.writeUInt16BE(0x8000 | (q.rd ? 0x0100 : 0) | 0x0080 | rcode, 2); // response, RD copied, RA, rcode
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(addresses.length, 6);
  const records = addresses.map((ip) => {
    const r = Buffer.alloc(16);
    r.writeUInt16BE(0xc00c, 0); // the question's name
    r.writeUInt16BE(TYPE_A, 2);
    r.writeUInt16BE(CLASS_IN, 4);
    r.writeUInt32BE(TTL, 6);
    r.writeUInt16BE(4, 10);
    ip.split(".").forEach((part, i) => r.writeUInt8(Number(part), 12 + i));
    return r;
  });
  return Buffer.concat([head, msg.subarray(12, q.end), ...records]);
}

/** The reply to one query: public IPv4 answers only. Exported for tests. */
export async function resolveQuery(msg: Buffer, lookup: DnsLookup): Promise<Buffer | null> {
  const q = parseQuestion(msg);
  if (!q) {
    if (msg.length < 12) return null;
    const reply = Buffer.from(msg.subarray(0, 12));
    reply.writeUInt16BE(0x8000 | RCODE.formErr, 2);
    reply.writeUInt16BE(0, 4);
    return reply;
  }
  if (q.cls !== CLASS_IN) return answer(msg, q, RCODE.notImp);
  if (q.type === TYPE_AAAA) return answer(msg, q, RCODE.ok); // IPv4 only: an empty answer, so the client uses A
  if (q.type !== TYPE_A) return answer(msg, q, RCODE.notImp);
  let ips: string[];
  try {
    ips = await lookup(q.name);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return answer(msg, q, code === "ENOTFOUND" || code === "ENODATA" ? RCODE.nxDomain : RCODE.servFail);
  }
  if (!ips.length) return answer(msg, q, RCODE.nxDomain);
  if (ips.some((ip) => !classifyAddress(ip).allowed)) return answer(msg, q, RCODE.refused);
  return answer(msg, q, RCODE.ok, ips.slice(0, 8));
}

export function createDnsServer(opts: { log?: Logger; lookup?: DnsLookup } = {}): dgram.Socket {
  const log = opts.log ?? (() => {});
  const lookup = opts.lookup ?? ((name: string) => resolve4(name));
  const socket = dgram.createSocket("udp4");
  let inflight = 0;
  socket.on("message", (msg, rinfo) => {
    if (inflight >= MAX_INFLIGHT) return;
    inflight++;
    void resolveQuery(msg, lookup)
      .then((reply) => {
        if (reply) socket.send(reply, rinfo.port, rinfo.address);
      })
      .catch(() => log({ event: "dns.error" }))
      .finally(() => { inflight--; });
  });
  socket.on("error", () => log({ event: "dns.socket_error" }));
  return socket;
}
