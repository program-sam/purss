import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeEngine } from "../../../packages/freshrss/src/testing/fake-engine.ts";
import { FakeInternalApi } from "./testing/fake-internal-api.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await wait(20);
  }
}

async function launch(env: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => out };
}

test("SIGTERM: an idle worker exits cleanly right away", async () => {
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-proc-"));
  try {
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "service-token"), `${fake.token}\n`);
    const w = await launch({ PURSS_INTERNAL_URL: srv.url, PURSS_DATA_DIR: dir, PURSS_WORKER_POLL_MS: "50" });
    await until(() => fake.calls.lease >= 2);
    const started = Date.now();
    w.child.kill("SIGTERM");
    const { code } = await w.exited;
    assert.equal(code, 0, w.output());
    assert.ok(Date.now() - started < 3000, "no waiting out the poll interval");
    assert.match(w.output(), /"msg":"drained"/);
    assert.ok(!w.output().includes(fake.token), "the service token is never logged");
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SIGTERM: a job in flight is allowed to finish and is reported before the process exits", async () => {
  const engine = new FakeEngine();
  engine.users.set("eng_user", "0123456789abcdef0123456789abcdef");
  engine.delayMs = 700;
  const entry = (() => { engine.addFeed("https://example.org/a.xml", "A"); return engine.addEntry({ id: 1_700_000_000_000_001n, feedId: 1, title: "a", content: "", link: "https://example.org/1" }); })();
  const engineSrv = await engine.listen();
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-proc-"));
  try {
    mkdirSync(path.join(dir, "secrets", "engine-users"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "service-token"), `${fake.token}\n`);
    writeFileSync(path.join(dir, "secrets", "engine-users", "eu1"), "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    fake.engineUsers.set("eu1", { id: "eu1", username: "eng_user", baseUrl: engineSrv.baseUrl });
    const jobId = fake.enqueue("engine.mark_read", { engineUserId: "eu1", externalIds: [entry.id.toString()], read: true });
    const w = await launch({ PURSS_INTERNAL_URL: srv.url, PURSS_DATA_DIR: dir, PURSS_WORKER_POLL_MS: "50", PURSS_WORKER_DRAIN_MS: "10000" });
    await until(() => fake.leased.has(jobId) && engine.requests.some((r) => r.path === "/accounts/ClientLogin"));
    const leasesAtSignal = fake.calls.lease;
    w.child.kill("SIGTERM");
    const { code } = await w.exited;
    assert.equal(code, 0, w.output());
    assert.equal(fake.calls.complete.length, 1, "the in-flight job completed during the drain");
    assert.equal(fake.calls.fail.length, 0);
    assert.equal(entry.read, true);
    assert.ok(fake.calls.lease - leasesAtSignal <= 1, "no new leases after the signal");
  } finally { await srv.close(); await engineSrv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("SIGTERM: a job that outlives the drain budget is released as retryable and the process still exits 0", async () => {
  const engine = new FakeEngine();
  engine.users.set("eng_user", "0123456789abcdef0123456789abcdef");
  engine.addFeed("https://example.org/a.xml", "A");
  engine.delayMs = 4000;
  const engineSrv = await engine.listen();
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-proc-"));
  try {
    mkdirSync(path.join(dir, "secrets", "engine-users"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "service-token"), `${fake.token}\n`);
    writeFileSync(path.join(dir, "secrets", "engine-users", "eu1"), "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    fake.engineUsers.set("eu1", { id: "eu1", username: "eng_user", baseUrl: engineSrv.baseUrl });
    const jobId = fake.enqueue("engine.mark_read", { engineUserId: "eu1", externalIds: ["1"], read: true });
    const w = await launch({ PURSS_INTERNAL_URL: srv.url, PURSS_DATA_DIR: dir, PURSS_WORKER_POLL_MS: "50", PURSS_WORKER_DRAIN_MS: "300" });
    await until(() => fake.leased.has(jobId) && engine.requests.length > 0);
    const started = Date.now();
    w.child.kill("SIGTERM");
    const { code } = await w.exited;
    assert.equal(code, 0, w.output());
    assert.ok(Date.now() - started < 3500, "did not wait for the slow engine");
    assert.equal(fake.calls.fail.length, 1);
    assert.equal(fake.calls.fail[0]!.retryable, true);
    assert.equal(fake.calls.complete.length, 0);
  } finally { await srv.close(); await engineSrv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a worker started before the API created the service token reports that plainly and backs off instead of crashing", async () => {
  const fake = new FakeInternalApi();
  const srv = await fake.listen();
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-proc-"));
  try {
    const w = await launch({ PURSS_INTERNAL_URL: srv.url, PURSS_DATA_DIR: dir, PURSS_WORKER_POLL_MS: "50" });
    await until(() => /service token file is missing/.test(w.output()));
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "service-token"), `${fake.token}\n`);
    await until(() => fake.calls.lease >= 1, 15_000);
    w.child.kill("SIGTERM");
    assert.equal((await w.exited).code, 0, w.output());
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
