import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_SNIPPETS, EngineAdmin, ExecStartError, isValidApiPassword, isValidEngineUsername, parseExecPrefix } from "./admin.ts";
import type { ExecRunner } from "./admin.ts";
import { EngineError } from "./errors.ts";

type Call = { file: string; args: readonly string[] };

function admin(respond: (call: Call) => { exitCode?: number; stdout?: string; stderr?: string } | Error, prefix = ["podman", "exec", "--user", "www-data", "purss-freshrss"]) {
  const calls: Call[] = [];
  const run: ExecRunner = async (file, args) => {
    const call = { file, args };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { calls, admin: new EngineAdmin({ prefix, run }) };
}

const PW = "0123456789abcdef0123456789abcdef";

test("the default exec prefix is podman exec as the web user, and JSON arrays are accepted for odd setups", () => {
  assert.deepEqual(parseExecPrefix(undefined), ["podman", "exec", "--user", "www-data", "purss-freshrss"]);
  assert.deepEqual(parseExecPrefix("docker  exec -u 33 engine"), ["docker", "exec", "-u", "33", "engine"]);
  assert.deepEqual(parseExecPrefix('["ssh","host with space","podman","exec","x"]'), ["ssh", "host with space", "podman", "exec", "x"]);
  assert.throws(() => parseExecPrefix("   "), EngineError);
  assert.throws(() => parseExecPrefix("[1,2]"), EngineError);
  assert.throws(() => parseExecPrefix("[not json"), EngineError);
});

test("create-user runs the fixed script with structured arguments, never a shell string", async () => {
  const { calls, admin: a } = admin(() => ({ exitCode: 0 }));
  assert.deepEqual(await a.createUser({ username: "purss_u1", apiPassword: PW }), { created: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "podman");
  assert.deepEqual(calls[0]!.args, [
    "exec", "--user", "www-data", "purss-freshrss",
    "php", "-f", "./cli/create-user.php", "--",
    "--no-default-feeds", "--user=purss_u1", `--api-password=${PW}`,
  ]);
  assert.ok(!calls[0]!.args.some((x) => x === "sh" || x === "-c" || x === "bash"));
});

test("an existing user (exit 3) is not an error, and ensureUser then resets the API password", async () => {
  const { calls, admin: a } = admin((c) => (c.args.includes("./cli/create-user.php") ? { exitCode: 3 } : { exitCode: 0 }));
  assert.deepEqual(await a.ensureUser({ username: "purss_u1", apiPassword: PW }), { created: false });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.args.includes("./cli/update-user.php"));
  assert.ok(calls[1]!.args.includes(`--api-password=${PW}`));
});

test("user names and passwords that could be mistaken for options or shell syntax are refused before anything runs", async () => {
  const { calls, admin: a } = admin(() => ({}));
  for (const bad of ["", "-x", "a b", "a;rm -rf /", "a$(id)", "a\nb", "x".repeat(129), "é"]) {
    await assert.rejects(a.createUser({ username: bad, apiPassword: PW }), EngineError, `username ${JSON.stringify(bad)}`);
  }
  for (const bad of ["short", "has space 0123456789abcdef", "-leading0123456789abcdef", "a;b0123456789abcdef", "$(x)0123456789abcdef"]) {
    await assert.rejects(a.createUser({ username: "ok", apiPassword: bad }), EngineError, `password ${JSON.stringify(bad)}`);
  }
  assert.equal(calls.length, 0);
  assert.equal(isValidEngineUsername("eng_01hxyz.user@x-1"), true);
  assert.equal(isValidApiPassword(PW), true);
});

test("failures never echo the command line or the password", async () => {
  const { admin: a } = admin(() => ({ exitCode: 1, stderr: `boom --api-password=${PW} Passwd=${PW}` }));
  await assert.rejects(a.createUser({ username: "u1", apiPassword: PW }), (e: unknown) => {
    assert.ok(e instanceof EngineError);
    assert.ok(!e.message.includes(PW), e.message);
    assert.ok(!e.message.includes("--api-password=0123"), e.message);
    return true;
  });
  const { admin: b } = admin(() => new ExecStartError("spawn"));
  await assert.rejects(b.createUser({ username: "u1", apiPassword: PW }), (e: unknown) => e instanceof EngineError && e.kind === "exec" && !e.message.includes(PW) && !(e.cause));
});

test("timeouts and aborts map to distinct error kinds", async () => {
  const { admin: t } = admin(() => new ExecStartError("timeout"));
  await assert.rejects(t.listUsers(), (e: unknown) => e instanceof EngineError && e.kind === "timeout" && e.retryable);
  const { admin: c } = admin(() => new ExecStartError("aborted"));
  await assert.rejects(c.listUsers(), (e: unknown) => e instanceof EngineError && e.kind === "cancelled" && !e.retryable);
});

test("actualize reads the engine's summary line and treats 'nothing to update' (exit 1) as success", async () => {
  const ok = admin(() => ({ exitCode: 0, stdout: "FreshRSS actualized 2 feeds for u1 (7 new articles)\n" }));
  assert.deepEqual(await ok.admin.actualize({ username: "u1" }), { feeds: 2, newArticles: 7 });
  const none = admin(() => ({ exitCode: 1, stdout: "FreshRSS actualized 0 feeds for u1 (0 new articles)\n" }));
  assert.deepEqual(await none.admin.actualize({ username: "u1" }), { feeds: 0, newArticles: 0 });
  const bad = admin(() => ({ exitCode: 1, stderr: "FreshRSS error: user not found: nobody\n" }));
  assert.deepEqual(await bad.admin.actualize({ username: "nobody" }), { feeds: 0, newArticles: 0 });
  const feed = admin(() => ({ exitCode: 0, stdout: "FreshRSS actualized 1 feeds for u1 (0 new articles)\n" }));
  await feed.admin.actualize({ username: "u1", feedId: 5 });
  assert.ok(feed.calls[0]!.args.includes("--feed-id=5"));
  await assert.rejects(feed.admin.actualize({ username: "u1", feedId: 0 }), EngineError);
});

test("engine identity is derived inside the engine and must be 64 hex characters", async () => {
  const hex = "ab".repeat(32);
  const { calls, admin: a } = admin(() => ({ stdout: hex }));
  assert.equal(await a.engineIdentity(), `freshrss:${hex.slice(0, 32)}`);
  assert.equal(calls[0]!.args.at(-3), "php");
  assert.ok(calls[0]!.args.at(-1)!.includes("config.php"));
  assert.ok(!calls[0]!.args.join(" ").includes(hex));
  const { admin: bad } = admin(() => ({ stdout: "oops" }));
  await assert.rejects(bad.engineIdentity(), EngineError);
});

test("list-users parses one name per line", async () => {
  const { admin: a } = admin(() => ({ stdout: "purss-engine-admin\neng_a\n\neng_b\n" }));
  assert.deepEqual(await a.listUsers(), ["purss-engine-admin", "eng_a", "eng_b"]);
  assert.equal(await a.userExists("ENG_A"), true);
});

test("egress configuration changes only accept an IPv4 host:port", async () => {
  const { calls, admin: a } = admin(() => ({ stdout: "unchanged" }));
  assert.equal(await a.applyEgressConfig({ proxyHostPort: "169.254.1.2:8946", dryRun: true }), "unchanged");
  assert.deepEqual(calls[0]!.args.slice(-2), ["169.254.1.2:8946", "dry"]);
  await assert.rejects(a.applyEgressConfig({ proxyHostPort: "evil.example:8946" }), EngineError);
  await assert.rejects(a.applyEgressConfig({ proxyHostPort: "1.2.3.4:80'); system('x" }), EngineError);
});

test("the egress operation also sets the engine's fetch-cache minimum, keeps other limits, and is what the dry run compares", () => {
  const sql = ADMIN_SNIPPETS.egress;
  assert.match(sql, /\$c\["limits"\]\["cache_duration_min"\] = 800;/, "written into the existing limits, not over them");
  assert.match(sql, /\(\$c\["limits"\]\["cache_duration_min"\] \?\? null\) === 800\) \{ echo "unchanged"/, "an install without it is reported as drift");
  assert.ok(!sql.includes('$c["limits"] ='), "never replaces the whole limits array");
});

test("delete-user runs the fixed script for one valid user and reports a failure without echoing the command", async () => {
  const { calls, admin: a } = admin(() => ({ exitCode: 0, stdout: "FreshRSS deleting user “purss_u1”…" }));
  await a.deleteUser("purss_u1");
  assert.deepEqual(calls[0]!.args, ["exec", "--user", "www-data", "purss-freshrss", "php", "-f", "./cli/delete-user.php", "--", "--user=purss_u1"]);

  const missing = admin(() => ({ exitCode: 1, stderr: "FreshRSS error: user not found: purss_u1" }));
  await assert.rejects(missing.admin.deleteUser("purss_u1"), (e: unknown) => e instanceof EngineError && /delete the engine user \(exit 1\)/.test(e.message) && e.retryable);
  const refused = admin(() => ({}));
  for (const bad of ["-rf", "a b", "../x"]) await assert.rejects(refused.admin.deleteUser(bad), EngineError);
  assert.equal(refused.calls.length, 0, "nothing runs for an invalid name");
});
