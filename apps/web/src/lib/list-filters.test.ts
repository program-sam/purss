import test from "node:test";
import assert from "node:assert/strict";
import type { MenuEntry } from "@purss/ui";
import { app } from "@purss/translations/app";
import { defaultFilterFor, filterChoices, filterFor, filterLabel, filterParam, isNarrowed, listFilters, typeLengthEntries, typeLengthSummary, typesParam } from "./list-filters.ts";
import type { ListState } from "../pages/list-state.ts";

const l = app.lib.listFilters;
const c = app.lib.constants;
const shortLabel = (length: "short" | "long") => l.lengths[length].split(" (")[0]!;

const state = (over: Partial<ListState> = {}): ListState => ({
  scope: "all", view: "list", modes: ["list"], filter: "active", defaultFilter: "active", sort: "newest", source: undefined, without: undefined, types: [], length: undefined, showMuted: false, captureFailed: false, itemId: undefined, ...over,
});

test("a list's address becomes the request's filters, and only what is set", () => {
  assert.deepEqual(listFilters(state()), {});
  assert.deepEqual(listFilters(state({ source: "src_1", types: ["videos", "podcasts"], length: "short", showMuted: true })), { source: "src_1", type: "videos,podcasts", length: "short", muted: "show" });
  assert.deepEqual(listFilters(state({ without: "src_2" })), { without: "src_2" });
  assert.equal(isNarrowed(state()), false);
  for (const over of [{ source: "s" }, { without: "s" }, { types: ["articles" as const] }, { length: "long" as const }]) assert.equal(isNarrowed(state(over)), true);
});

test("the filter menu offers Type as checks and Length as one choice, and changes the address by one choice at a time", () => {
  const calls: Record<string, unknown>[] = [];
  const entries = typeLengthEntries(state({ types: ["videos"], length: "long" }), (p) => calls.push(p));
  const labelled = entries.filter((e): e is Extract<MenuEntry, { label: string }> => "label" in e);
  assert.deepEqual(labelled.map((e) => e.label), [app.words.type, l.types.articles, l.types.videos, l.types.podcasts, app.words.length, l.anyLength, l.lengths.short, l.lengths.long]);
  const pick = (label: string) => (labelled.find((e) => e.label === label) as Extract<MenuEntry, { type: "check" | "radio" }>);
  assert.deepEqual([pick(l.types.videos).on, pick(l.types.articles).on, pick(l.lengths.long).on, pick(l.anyLength).on], [true, false, true, false]);
  pick(l.types.podcasts).onSelect();
  pick(l.types.videos).onSelect();
  pick(l.lengths.short).onSelect();
  pick(l.anyLength).onSelect();
  assert.deepEqual(calls, [{ type: "videos,podcasts" }, { type: undefined }, { length: "short" }, { length: undefined }]);
});

test("the filter button says which type and length are chosen", () => {
  assert.equal(typeLengthSummary(state()), "");
  assert.equal(typeLengthSummary(state({ types: ["videos", "podcasts"] })), `${l.types.videos}, ${l.types.podcasts}`);
  assert.equal(typeLengthSummary(state({ types: ["videos"], length: "short" })), `${l.types.videos}, ${shortLabel("short")}`);
  assert.equal(typeLengthSummary(state({ length: "long" })), shortLabel("long"));
});

test("the types in an address are read in one fixed order, and anything else is dropped", () => {
  assert.equal(typesParam("podcasts,videos"), "videos,podcasts");
  assert.equal(typesParam("videos,books,videos"), "videos");
  assert.equal(typesParam("books"), undefined);
  assert.equal(typesParam(undefined), undefined);
  assert.equal(typesParam(5), undefined);
});

test("a list opened from a failed-text notification asks only for those items", () => {
  assert.deepEqual(listFilters(state({ source: "src_1", captureFailed: true })), { source: "src_1", capture: "failed" });
  assert.equal(isNarrowed(state({ captureFailed: true })), true);
});

test("a collection opens on its new items while it has any, then on everything but ignored", () => {
  const c = { t: "c", id: "col_1" } as const;
  assert.equal(defaultFilterFor(c, "cards", 26), "fresh");
  assert.equal(defaultFilterFor(c, "list", 0), "active");
  assert.equal(defaultFilterFor(c, "board", 26), "active", "the board keeps every item in its workflow columns");
  assert.equal(defaultFilterFor({ t: "s", id: "src_1" }, "list", 5), "active");
  assert.equal(defaultFilterFor(null, "list", 5), "active");
});

test("a basket has no Ignored: it shows everything kept in it, ignored or not", () => {
  const b = { t: "b", id: "b_1" } as const;
  assert.equal(defaultFilterFor(b, "list", 5), "all");
  assert.equal(filterFor(b, undefined, "all"), "all");
  assert.equal(filterFor(b, "active", "all"), "all", "an old address's All still shows the whole basket");
  assert.equal(filterFor(b, "ignored", "all"), "all", "an address naming Ignored falls back to the whole basket");
  assert.equal(filterFor(b, "toread", "all"), "toread");
  assert.ok(!filterChoices(b).includes("ignored"));
  assert.ok(!filterChoices(b).includes("active"));
  assert.equal(filterLabel(b, "all"), c.filters.active);
  const s = { t: "s", id: "src_1" } as const;
  assert.equal(filterFor(s, "ignored", "active"), "ignored");
  assert.ok(filterChoices(s).includes("ignored"));
  assert.equal(filterLabel(s, "all"), c.filters.all);
});

test("a chosen filter stays in the address unless it is the page's default", () => {
  assert.equal(filterParam({ defaultFilter: "fresh" }, "fresh"), undefined);
  assert.equal(filterParam({ defaultFilter: "fresh" }, "active"), "active");
  assert.equal(filterParam({ defaultFilter: "active" }, "active"), undefined);
  assert.equal(filterParam({ defaultFilter: "active" }, "all"), "all");
});

test("the queue page offers the filters that can show something: what is waiting, what is started, what is New", () => {
  const r = { t: "r", id: "toread" } as const;
  assert.deepEqual(filterChoices(r), ["active", "fresh", "toread", "inprogress"]);
  assert.equal(filterFor(r, "inprogress", "active"), "inprogress");
  assert.equal(filterFor(r, "toread", "active"), "toread");
  assert.equal(filterFor(r, "finished", "active"), "active", "an address naming a state the queue never holds opens on All");
  assert.equal(filterFor(r, "all", "active"), "active");
  assert.equal(filterFor(r, undefined, "active"), "active");
  assert.equal(defaultFilterFor(r, "list", 5), "active");
  assert.equal(filterLabel(r, "active"), c.filters.active);
  assert.equal(filterLabel(r, "inprogress"), app.words.inProgress);
});
