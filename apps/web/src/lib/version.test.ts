import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "@purss/copy/app";
import { versionLine } from "./version.ts";

const t = app.lib.version;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

test("the version line: the page's, the app's, and the server's only where it differs", () => {
  assert.equal(versionLine({ page: "2631214", app: null, server: "2631214" }), sentence(t.page("2631214")));
  assert.equal(versionLine({ page: "2631214", app: "2630502", server: "2631214" }), `${sentence(t.page("2631214"))} · ${t.app("2630502")}`);
  assert.equal(versionLine({ page: "2630502", app: "2630502", server: "2631214" }), `${sentence(t.page("2630502"))} · ${t.app("2630502")} · ${t.server("2631214")}`);
  assert.equal(versionLine({ page: null, app: null, server: "2631214" }), sentence(t.server("2631214")));
  assert.equal(versionLine({ page: null, app: null, server: null }), null);
});
