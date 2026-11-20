import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "@purss/copy/app";
import { bridgeFailureText, bytesOrUnknown, durationLabel, engineLabel, inviteLink, missLabel, parseAllocation, shortId, splitAllocation } from "./admin-model.ts";

const t = app.admin.adminModel;
const failure = t.bridgeFailure;

test("durations are rounded plainly and unknown stays unknown", () => {
  assert.equal(durationLabel(null), app.words.unknown);
  assert.equal(durationLabel(12), t.underAMinute);
  assert.equal(durationLabel(300), t.minutes(5));
  assert.equal(durationLabel(7200), t.hours(2));
  assert.equal(durationLabel(86_400), t.days(1));
  assert.equal(durationLabel(3 * 86_400), t.days(3));
});

test("an unmeasured size says so instead of showing zero", () => {
  assert.equal(bytesOrUnknown(null), app.words.unknown);
  assert.equal(bytesOrUnknown(0), app.lib.format.bytes.small(0));
  assert.equal(bytesOrUnknown(512), app.lib.format.bytes.small(512));
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
  assert.equal(shortId(null), t.system);
  assert.equal(shortId("acc_0123456789abcdef"), "…abcdef");
  assert.equal(shortId("short"), "short");
  assert.equal(engineLabel("degraded"), t.engine.degraded);
  assert.equal(engineLabel("odd"), "odd");
});

test("the invitation link carries the code and the address it is for in the address the app already reads", () => {
  assert.equal(inviteLink("https://example.org", "AB-12 3", "new.reader+x@example.org"), "https://example.org/app/invite?code=AB-12%203&email=new.reader%2Bx%40example.org");
});

test("a bridged source's failure is told in plain words, and an unknown one is not made up", () => {
  assert.equal(bridgeFailureText("timeout"), failure.timeout);
  assert.equal(bridgeFailureText("unreachable"), failure.unreachable);
  assert.equal(bridgeFailureText("too_large"), failure.tooLarge);
  assert.equal(bridgeFailureText("parse_error"), failure.parseError);
  assert.equal(bridgeFailureText("no_ids"), failure.noIds);
  assert.equal(bridgeFailureText("http_404"), failure.notFound);
  assert.equal(bridgeFailureText("http_403"), failure.refused);
  assert.equal(bridgeFailureText("http_429"), failure.limiting);
  assert.equal(bridgeFailureText("http_503"), failure.serverError("503"));
  assert.equal(bridgeFailureText("http_418"), failure.otherError("418"));
  for (const other of ["unknown", "http_", "http_5000", "", "something_new"]) assert.equal(bridgeFailureText(other), failure.unknown, other);
});

test("the reasons a lookup of a site failed are short labels, and a new reason shows as it is", () => {
  assert.deepEqual(["nofeed", "unsupported", "unreachable", "timeout"].map(missLabel), [t.miss.nofeed, t.miss.unsupported, t.miss.unreachable, t.miss.timeout]);
  assert.equal(missLabel("new_reason"), "new_reason");
});
