import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeFailureText, bytesOrUnknown, durationLabel, engineLabel, inviteLink, missLabel, parseAllocation, shortId, splitAllocation } from "./admin-model.ts";

test("durations are rounded plainly and unknown stays unknown", () => {
  assert.equal(durationLabel(null), "Unknown");
  assert.equal(durationLabel(12), "under a minute");
  assert.equal(durationLabel(300), "5 min");
  assert.equal(durationLabel(7200), "2 h");
  assert.equal(durationLabel(86_400), "1 day");
  assert.equal(durationLabel(3 * 86_400), "3 days");
});

test("an unmeasured size says so instead of showing zero", () => {
  assert.equal(bytesOrUnknown(null), "Unknown");
  assert.equal(bytesOrUnknown(0), "0 B");
  assert.equal(bytesOrUnknown(512), "512 B");
});

test("allocations: blank is no limit, numbers use binary units, nonsense is rejected", () => {
  assert.equal(parseAllocation("", "GB"), null);
  assert.equal(parseAllocation("  ", "MB"), null);
  assert.equal(parseAllocation("1", "GB"), 1024 ** 3);
  assert.equal(parseAllocation("512", "MB"), 512 * 1024 ** 2);
  assert.equal(parseAllocation("0.5", "GB"), 512 * 1024 ** 2);
  assert.equal(parseAllocation("0", "GB"), 0);
  assert.equal(parseAllocation("-1", "GB"), undefined);
  assert.equal(parseAllocation("1e3", "GB"), undefined);
  assert.equal(parseAllocation("ten", "GB"), undefined);
  assert.equal(parseAllocation("1.2345", "GB"), undefined);
});

test("an existing allocation is shown in the unit that reads best", () => {
  assert.deepEqual(splitAllocation(null), { text: "", unit: "GB" });
  assert.deepEqual(splitAllocation(1024 ** 3), { text: "1", unit: "GB" });
  assert.deepEqual(splitAllocation(512 * 1024 ** 2), { text: "512", unit: "MB" });
  assert.deepEqual(splitAllocation(5 * 1024 ** 3), { text: "5", unit: "GB" });
  assert.deepEqual(splitAllocation(1536 * 1024 ** 2), { text: "1536", unit: "MB" });
});

test("ids are shortened, the system actor is named, engine states have words", () => {
  assert.equal(shortId(null), "System");
  assert.equal(shortId("acc_0123456789abcdef"), "…abcdef");
  assert.equal(shortId("short"), "short");
  assert.equal(engineLabel("degraded"), "Partly failing");
  assert.equal(engineLabel("odd"), "odd");
});

test("the invitation link carries the code and the address it is for in the address the app already reads", () => {
  assert.equal(inviteLink("https://example.org", "AB-12 3", "new.reader+x@example.org"), "https://example.org/app/invite?code=AB-12%203&email=new.reader%2Bx%40example.org");
});

test("a bridged source's failure is told in plain words, and an unknown one is not made up", () => {
  assert.equal(bridgeFailureText("timeout"), "The service took too long to answer.");
  assert.equal(bridgeFailureText("unreachable"), "The bridge couldn't reach the service.");
  assert.equal(bridgeFailureText("too_large"), "The answer was too big to use.");
  assert.equal(bridgeFailureText("parse_error"), "The answer couldn't be read.");
  assert.equal(bridgeFailureText("no_ids"), "Its posts had no usable address.");
  assert.equal(bridgeFailureText("http_404"), "The service says that page doesn't exist.");
  assert.equal(bridgeFailureText("http_403"), "The service refused the request.");
  assert.equal(bridgeFailureText("http_429"), "The service is limiting requests.");
  assert.equal(bridgeFailureText("http_503"), "The bridge or the service had an error (503).");
  assert.equal(bridgeFailureText("http_418"), "The service answered with error 418.");
  for (const other of ["unknown", "http_", "http_5000", "", "something_new"]) assert.equal(bridgeFailureText(other), "It failed, and no more is known.", other);
});

test("the reasons a lookup of a site failed are short labels, and a new reason shows as it is", () => {
  assert.deepEqual(["nofeed", "unsupported", "unreachable", "timeout"].map(missLabel), ["No feed found", "Can't be followed", "Couldn't be reached", "Took too long"]);
  assert.equal(missLabel("new_reason"), "new_reason");
});
