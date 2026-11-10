import assert from "node:assert/strict";
import dgram from "node:dgram";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createDnsServer, resolveQuery } from "./dns.ts";

function query(name: string, type = 1, id = 0x1234): Buffer {
  const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, ...labels, Buffer.from([0]), tail]);
}

const rcode = (reply: Buffer) => reply.readUInt16BE(2) & 0xf;
const answers = (reply: Buffer, qlen: number) => {
  const out: string[] = [];
  for (let at = qlen, i = 0; i < reply.readUInt16BE(6); i++, at += 16) out.push([...reply.subarray(at + 12, at + 16)].join("."));
  return out;
};

const table: Record<string, string[]> = { "t.me": ["149.154.167.99"], "inside.example": ["10.0.0.5"], "mixed.example": ["93.184.216.34", "127.0.0.1"], "meta.example": ["169.254.169.254"] };
const lookup = async (name: string) => {
  const ips = table[name];
  if (!ips) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return ips;
};

test("public IPv4 answers are passed on with the question's id", async () => {
  const q = query("t.me");
  const r = (await resolveQuery(q, lookup))!;
  assert.equal(r.readUInt16BE(0), 0x1234);
  assert.equal(rcode(r), 0);
  assert.deepEqual(answers(r, q.length), ["149.154.167.99"]);
});

test("a name with any private, loopback or metadata answer is refused whole", async () => {
  for (const name of ["inside.example", "mixed.example", "meta.example"]) {
    const r = (await resolveQuery(query(name), lookup))!;
    assert.equal(rcode(r), 5, name);
    assert.equal(r.readUInt16BE(6), 0, name);
  }
});

test("unknown names are NXDOMAIN; AAAA is empty; other types aren't implemented; junk is a format error", async () => {
  assert.equal(rcode((await resolveQuery(query("nope.example"), lookup))!), 3);
  const aaaa = (await resolveQuery(query("t.me", 28), lookup))!;
  assert.equal(rcode(aaaa), 0);
  assert.equal(aaaa.readUInt16BE(6), 0);
  assert.equal(rcode((await resolveQuery(query("t.me", 16), lookup))!), 4);
  assert.equal(rcode((await resolveQuery(Buffer.concat([query("t.me").subarray(0, 12), Buffer.from([0xc0, 0x0c])]), lookup))!), 1);
  assert.equal(await resolveQuery(Buffer.alloc(4), lookup), null);
});

test("the resolver answers over UDP", async () => {
  const server = createDnsServer({ lookup });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = dgram.createSocket("udp4");
  try {
    const reply = await new Promise<Buffer>((resolve) => {
      client.once("message", resolve);
      client.send(query("t.me"), port, "127.0.0.1");
    });
    assert.deepEqual(answers(reply, query("t.me").length), ["149.154.167.99"]);
  } finally {
    client.close();
    server.close();
  }
});
