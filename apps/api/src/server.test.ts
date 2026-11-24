import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { makeTestApp } from "./testing.ts";
import { startTestServer } from "./features-testing.ts";
import { publicRouter } from "./routes/public.ts";

/** Sends one raw request line, which fetch would refuse to build, and returns the status line of the reply. */
function rawStatusLine(base: string, target: string): Promise<string> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let reply = "";
    socket.on("data", (chunk) => { reply += String(chunk); });
    socket.on("end", () => resolve(reply.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

test("a request path that is not a valid address gets a 400 and the server keeps answering", async (t) => {
  const { app, cleanup } = makeTestApp();
  const server = await startTestServer(app, [publicRouter()]);
  t.after(async () => { await server.close(); cleanup(); });
  assert.match(await rawStatusLine(server.base, "//["), /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${server.base}/api/session`)).status, 200);
});
