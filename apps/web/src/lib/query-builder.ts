import type { CollectionDTO, ItemKind, QueryNode, WorkflowState } from "@purss/domain";
import { KIND_LABELS, WORKFLOW_LABELS } from "./constants.ts";
import { interfaceLocale } from "./format.ts";

/**
 * The small filter builder behind "Filter" collections: a flat list of conditions that are all
 * required. It maps to and from the typed QueryNode tree the server validates; anything the
 * builder cannot represent (any/not groups, other fields) is reported so the UI never silently
 * rewrites a filter it does not understand.
 */

export type DateBasis = "published" | "discovered" | "kept";
export type KeptChoice = "any" | "kept" | "unkept";

export type QueryDraft = {
  text: string;
  sourceIds: string[];
  kinds: ItemKind[];
  workflows: WorkflowState[];
  kept: KeptChoice;
  dateBasis: DateBasis;
  from: string; // YYYY-MM-DD or ""
  to: string;
};

export const EMPTY_DRAFT: QueryDraft = { text: "", sourceIds: [], kinds: [], workflows: [], kept: "any", dateBasis: "published", from: "", to: "" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type BuildResult = { ok: true; query: QueryNode } | { ok: false; message: string };

export function draftToQuery(d: QueryDraft): BuildResult {
  const leaves: QueryNode[] = [];
  const text = d.text.trim();
  if (text) {
    if (text.length > 200) return { ok: false, message: "Keep the words to 200 characters or fewer." };
    leaves.push({ field: "text", value: text });
  }
  if (d.sourceIds.length) leaves.push({ field: "source", value: d.sourceIds.slice(0, 50) });
  if (d.kinds.length) leaves.push({ field: "kind", value: [...d.kinds] });
  if (d.workflows.length) leaves.push({ field: "workflow", value: [...d.workflows] });
  if (d.kept !== "any") leaves.push({ field: "kept", value: d.kept === "kept" });
  if (d.from || d.to) {
    if ((d.from && !DATE.test(d.from)) || (d.to && !DATE.test(d.to))) return { ok: false, message: "Use a valid date." };
    if (d.from && d.to && d.from > d.to) return { ok: false, message: "The start date is after the end date." };
    leaves.push({ field: "date", which: d.dateBasis, ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}) });
  }
  if (!leaves.length) return { ok: false, message: "Add at least one condition." };
  if (leaves.length > 24) return { ok: false, message: "That filter has too many conditions." };
  return { ok: true, query: leaves.length === 1 ? leaves[0]! : { all: leaves } };
}

export type ParsedDraft = { editable: true; draft: QueryDraft } | { editable: false };

/** Read a stored query back into the builder, or say it needs more than the builder offers. */
export function queryToDraft(query: QueryNode | null): ParsedDraft {
  if (!query) return { editable: true, draft: { ...EMPTY_DRAFT } };
  const nodes = "all" in query ? query.all : [query];
  const draft: QueryDraft = { ...EMPTY_DRAFT };
  const seen = new Set<string>();
  for (const n of nodes) {
    if ("all" in n || "any" in n || "not" in n) return { editable: false };
    if (seen.has(n.field)) return { editable: false };
    seen.add(n.field);
    switch (n.field) {
      case "text": draft.text = n.value; break;
      case "source": draft.sourceIds = [...n.value]; break;
      case "kind": draft.kinds = [...n.value]; break;
      case "workflow": draft.workflows = [...n.value]; break;
      case "kept": draft.kept = n.value ? "kept" : "unkept"; break;
      case "date": draft.dateBasis = n.which; draft.from = n.from ?? ""; draft.to = n.to ?? ""; break;
      default: return { editable: false };
    }
  }
  return { editable: true, draft };
}

const BASIS_WORD: Record<DateBasis, string> = { published: "published", discovered: "arrived", kept: "kept" };

/** "3 Nov 2026" for a YYYY-MM-DD date, read as that calendar day wherever the person is. */
function plainDay(day: string, locale: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function joinOr(words: string[]): string {
  return words.length < 3 ? words.join(" or ") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** Plain-language summary of a stored query, for settings and empty states. */
export function describeQuery(query: QueryNode | null, names: { source: (id: string) => string }, locale = interfaceLocale()): string {
  const parsed = queryToDraft(query);
  if (!parsed.editable) return "A custom filter.";
  const d = parsed.draft;
  const bits: string[] = [];
  if (d.text) {
    const words = d.text.split(/[\s,]+/).filter(Boolean);
    bits.push(words.length > 1 ? `containing all of these words: ${words.join(", ")}` : `containing “${d.text.trim()}”`);
  }
  if (d.sourceIds.length) bits.push(`from ${d.sourceIds.map(names.source).join(", ")}`);
  if (d.kinds.length) bits.push(`that are ${joinOr(d.kinds.map((k) => `${KIND_LABELS[k].toLowerCase()}s`))}`);
  if (d.workflows.length) bits.push(`marked ${joinOr(d.workflows.map((w) => WORKFLOW_LABELS[w]))}`);
  if (d.kept !== "any") bits.push(d.kept === "kept" ? "kept in a basket" : "not kept");
  if (d.from || d.to) {
    const basis = BASIS_WORD[d.dateBasis];
    bits.push(d.from && d.to ? `${basis} ${plainDay(d.from, locale)} to ${plainDay(d.to, locale)}` : d.from ? `${basis} from ${plainDay(d.from, locale)}` : `${basis} until ${plainDay(d.to, locale)}`);
  }
  return bits.length ? `Items ${bits.join(", ")}.` : "Everything.";
}

/**
 * Whether a collection's own filter leaves an item in a given workflow state out: a card moved to that state
 * disappears from the collection's board, and the person should be told why. Null when it stays.
 */
export function excludesWorkflow(collection: Pick<CollectionDTO, "mode" | "query">, workflow: WorkflowState): string | null {
  if (collection.mode !== "query") return null;
  const parsed = queryToDraft(collection.query);
  if (!parsed.editable || !parsed.draft.workflows.length || parsed.draft.workflows.includes(workflow)) return null;
  return `this collection only shows items marked ${joinOr(parsed.draft.workflows.map((w) => WORKFLOW_LABELS[w]))}`;
}
