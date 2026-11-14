import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../http.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { forgetFrameChecks, frameCheck } from "./frame-check.ts";
import type { FrameChecker } from "./frame-check.ts";

test("an answer is remembered per PURSS, a failure means no frame, and only web addresses are read", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_PUBLIC_ORIGIN: "https://purss.example" });
  t.after(() => { forgetFrameChecks(); cleanup(); });
  const a = makeOwner(app);
  const b = makeOwner(app);
  const asked: string[] = [];
  const checker: FrameChecker = async (url, embedder) => {
    asked.push(`${embedder} ${url}`);
    if (url.includes("broken")) throw new Error("boom");
    return { frame: true, url };
  };
  assert.deepEqual(await frameCheck(app, a, "https://site.example/a#part", checker), { frame: true, url: "https://site.example/a" });
  await frameCheck(app, a, "https://site.example/a", checker);
  assert.deepEqual(asked, ["https://purss.example https://site.example/a"], "the second time from memory, without the fragment");
  await frameCheck(app, b, "https://site.example/a", checker);
  assert.equal(asked.length, 2, "another PURSS asks for itself");
  assert.deepEqual(await frameCheck(app, a, "https://site.example/broken", checker), { frame: false });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
    assert.throws(() => frameCheck(app, a, bad, checker), (e: unknown) => e instanceof HttpError && e.status === 400, bad);
  }
});
