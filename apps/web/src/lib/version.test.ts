import assert from "node:assert/strict";
import { test } from "node:test";
import { versionLine } from "./version.ts";

test("the version line: the page's, the app's, and the server's only where it differs", () => {
  assert.equal(versionLine({ page: "2631214", app: null, server: "2631214" }), "Version 2631214");
  assert.equal(versionLine({ page: "2631214", app: "2630502", server: "2631214" }), "Version 2631214 · app 2630502");
  assert.equal(versionLine({ page: "2630502", app: "2630502", server: "2631214" }), "Version 2630502 · app 2630502 · server 2631214");
  assert.equal(versionLine({ page: null, app: null, server: "2631214" }), "Server 2631214");
  assert.equal(versionLine({ page: null, app: null, server: null }), null);
});
