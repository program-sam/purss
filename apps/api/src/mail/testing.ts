import net from "node:net";
import type { AddressInfo } from "node:net";

/*
 * TEST ONLY: a tiny SMTP server on 127.0.0.1 that keeps what it receives, so tests and the
 * hermetic journeys exercise the real nodemailer path without a network. Plain SMTP, no TLS
 * and no login (PURSS_SMTP_SECURITY=none). Recipients matching `reject` are refused with 550.
 */

export type Received = { from: string; to: string[]; data: string };
export type SmtpSink = { port: number; received: Received[]; close: () => Promise<void> };

export async function startSmtpSink(opts: { reject?: RegExp } = {}): Promise<SmtpSink> {
  const received: Received[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let mail: Received = { from: "", to: [], data: "" };
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink.test ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          mail.data = buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buffer = buffer.slice(end + 5);
          received.push(mail);
          mail = { from: "", to: [], data: "" };
          inData = false;
          reply("250 2.0.0 queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") { reply("250-sink.test"); reply("250 8BITMIME"); }
        else if (verb === "HELO" || verb === "NOOP" || verb === "RSET") reply("250 OK");
        else if (verb === "MAIL") { mail.from = line.replace(/^MAIL FROM:\s*/i, ""); reply("250 OK"); }
        else if (verb === "RCPT") {
          const to = line.replace(/^RCPT TO:\s*/i, "");
          if (opts.reject?.test(to)) reply("550 5.1.1 no such mailbox");
          else { mail.to.push(to); reply("250 OK"); }
        } else if (verb === "DATA") { inData = true; reply("354 go ahead"); }
        else if (verb === "QUIT") { reply("221 bye"); socket.end(); return; }
        else reply("502 not here");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

/** The decoded plain-text part of a received message (quoted-printable, base64 or 7bit). */
export function textOf(message: Received): string {
  const m = /Content-Type: text\/plain[^\r]*\r\n((?:[^\r]+\r\n)*)\r\n([^]*?)(?:\r\n--|$)/i.exec(message.data);
  if (!m) return message.data;
  const headers = m[1]!;
  const body = m[2]!;
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(headers)) return body;
  const flat = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    const hex = flat.slice(i + 1, i + 3);
    if (flat[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(...Buffer.from(flat[i]!));
  }
  return Buffer.from(bytes).toString("utf8");
}
