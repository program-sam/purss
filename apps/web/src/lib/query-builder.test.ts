import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_DRAFT, describeQuery, draftToQuery, excludesWorkflow, queryToDraft } from "./query-builder.ts";

test("an empty draft is rejected with a plain message", () => {
  const r = draftToQuery(EMPTY_DRAFT);
  assert.equal(r.ok, false);
});

test("one condition is a bare leaf, several are an all-group", () => {
  const one = draftToQuery({ ...EMPTY_DRAFT, text: " tide " });
  assert.deepEqual(one, { ok: true, query: { field: "text", value: "tide" } });
  const many = draftToQuery({ ...EMPTY_DRAFT, text: "tide", kinds: ["video"], kept: "unkept", workflows: ["toread", "inprogress"] });
  assert.deepEqual(many, { ok: true, query: { all: [
    { field: "text", value: "tide" }, { field: "kind", value: ["video"] }, { field: "workflow", value: ["toread", "inprogress"] }, { field: "kept", value: false },
  ] } });
});

test("date ranges need valid, ordered ends and keep their basis", () => {
  assert.equal(draftToQuery({ ...EMPTY_DRAFT, from: "2026-13-xx" }).ok, false);
  assert.equal(draftToQuery({ ...EMPTY_DRAFT, from: "2026-05-02", to: "2026-05-01" }).ok, false);
  const r = draftToQuery({ ...EMPTY_DRAFT, dateBasis: "kept", from: "2026-01-01" });
  assert.deepEqual(r, { ok: true, query: { field: "date", which: "kept", from: "2026-01-01" } });
});

test("round trip: draft -> query -> draft", () => {
  const draft = { ...EMPTY_DRAFT, text: "ferry", sourceIds: ["src_0123456789abcdefghjkmnpqrs"], kinds: ["article" as const], kept: "kept" as const, dateBasis: "discovered" as const, from: "2026-01-01", to: "2026-02-01" };
  const built = draftToQuery(draft);
  assert.ok(built.ok);
  const back = queryToDraft(built.query);
  assert.deepEqual(back, { editable: true, draft });
});

test("filters the builder cannot express are not editable, never rewritten", () => {
  assert.deepEqual(queryToDraft({ any: [{ field: "text", value: "a" }, { field: "text", value: "b" }] }), { editable: false });
  assert.deepEqual(queryToDraft({ not: { field: "kept", value: true } }), { editable: false });
  assert.deepEqual(queryToDraft({ field: "author", value: "Mira" }), { editable: false });
  assert.deepEqual(queryToDraft({ all: [{ field: "text", value: "a" }, { field: "text", value: "b" }] }), { editable: false });
});

const names = { source: (id: string) => (id === "src_a" ? "The Tide Table" : "A source") };

test("a filter reads in plain words: states by their names, words as all-of, kinds as plurals", () => {
  assert.equal(describeQuery({ field: "workflow", value: ["new", "toread"] }, names, "en-GB"), "Items marked Undecided or To read.");
  assert.equal(describeQuery({ field: "workflow", value: ["inprogress", "toread", "finished"] }, names, "en-GB"), "Items marked In progress, To read or Finished.");
  assert.equal(describeQuery({ field: "text", value: "tide, ferry timetable" }, names, "en-GB"), "Items containing all of these words: tide, ferry, timetable.");
  assert.equal(describeQuery({ field: "text", value: "tide" }, names, "en-GB"), "Items containing “tide”.");
  assert.equal(describeQuery({ field: "kind", value: ["video", "article"] }, names, "en-GB"), "Items that are videos or articles.");
  assert.equal(describeQuery({ field: "kept", value: false }, names, "en-GB"), "Items not kept.");
  assert.equal(describeQuery({ field: "source", value: ["src_a"] }, names, "en-GB"), "Items from The Tide Table.");
  assert.equal(describeQuery({ field: "date", which: "discovered", from: "2026-01-05", to: "2026-02-01" }, names, "en-GB"), "Items arrived 5 Jan 2026 to 1 Feb 2026.");
  assert.equal(describeQuery({ field: "date", which: "published", from: "2026-01-05" }, names, "en-GB"), "Items published from 5 Jan 2026.");
  assert.equal(describeQuery({ all: [{ field: "text", value: "a" }, { field: "workflow", value: ["toread"] }] }, names, "en-GB"), "Items containing “a”, marked To read.");
  assert.equal(describeQuery({ any: [{ field: "text", value: "a" }, { field: "text", value: "b" }] }, names), "A custom filter.");
  assert.equal(describeQuery(null, names), "Everything.");
});

test("the filter heading never shows a stored state name", () => {
  for (const w of ["new", "toread", "inprogress", "finished", "ignored"] as const) {
    const text = describeQuery({ field: "workflow", value: [w] }, names, "en-GB");
    assert.doesNotMatch(text, /\b(new|toread|inprogress)\b/, text);
  }
});

test("a collection's own filter can leave a state out, and says why", () => {
  const onlyToRead: Parameters<typeof excludesWorkflow>[0] = { mode: "query", query: { field: "workflow", value: ["toread"] } };
  assert.equal(excludesWorkflow(onlyToRead, "finished"), "this collection only shows items marked To read");
  assert.equal(excludesWorkflow(onlyToRead, "toread"), null);
  assert.equal(excludesWorkflow({ mode: "query", query: { field: "workflow", value: ["new", "toread"] } }, "ignored"), "this collection only shows items marked Undecided or To read");
  assert.equal(excludesWorkflow({ mode: "query", query: { field: "text", value: "tide" } }, "finished"), null);
  assert.equal(excludesWorkflow({ mode: "sources", query: null }, "finished"), null);
  assert.equal(excludesWorkflow({ mode: "query", query: { any: [{ field: "text", value: "a" }, { field: "text", value: "b" }] } }, "finished"), null, "a filter the builder cannot read is left alone");
});
