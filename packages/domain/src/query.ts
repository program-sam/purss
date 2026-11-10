import { z } from "zod";
import { WORKFLOW_STATES } from "./workflow.ts";

/**
 * Typed query tree for query-mode collections. Validated on the
 * server, compiled to parameterised SQL, never stored or executed as raw SQL/regex.
 */
export const ITEM_KINDS = ["article", "video", "paper", "post", "podcast", "link"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const CAPTURE_LEVELS = ["metadata", "feed", "fulltext", "pending", "failed"] as const;

const id = z.string().min(3).max(40).regex(/^[a-z]{1,8}_[0-9a-z]{26}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const leafSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("text"), value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("source"), value: z.array(id).min(1).max(50) }),
  z.object({ field: z.literal("collection"), value: z.array(id).min(1).max(20) }),
  z.object({ field: z.literal("basket"), value: z.array(id).min(1).max(20) }),
  z.object({ field: z.literal("kind"), value: z.array(z.enum(ITEM_KINDS)).min(1) }),
  z.object({ field: z.literal("workflow"), value: z.array(z.enum(WORKFLOW_STATES)).min(1) }),
  z.object({ field: z.literal("author"), value: z.string().trim().min(1).max(120) }),
  z.object({ field: z.literal("fresh"), value: z.boolean() }),
  z.object({ field: z.literal("opened"), value: z.boolean() }),
  z.object({ field: z.literal("kept"), value: z.boolean() }),
  z.object({ field: z.literal("capture"), value: z.array(z.enum(CAPTURE_LEVELS)).min(1) }),
  z.object({
    field: z.literal("date"),
    which: z.enum(["published", "discovered", "kept"]),
    from: date.optional(),
    to: date.optional(),
  }),
]);
export type QueryLeaf = z.infer<typeof leafSchema>;

export type QueryNode =
  | QueryLeaf
  | { all: QueryNode[] }
  | { any: QueryNode[] }
  | { not: QueryNode };

export const queryNodeSchema: z.ZodType<QueryNode> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ all: z.array(queryNodeSchema).min(1).max(12) }).strict(),
    z.object({ any: z.array(queryNodeSchema).min(1).max(12) }).strict(),
    z.object({ not: queryNodeSchema }).strict(),
  ]),
);

export const MAX_QUERY_DEPTH = 4;
export const MAX_QUERY_LEAVES = 24;

export type QueryCheck = { ok: true; query: QueryNode } | { ok: false; message: string };

/** Parse and bound a query tree by depth and number of leaves (its cost). */
export function checkQuery(input: unknown): QueryCheck {
  const parsed = queryNodeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That filter isn't valid." };
  let leaves = 0;
  const walk = (node: QueryNode, depth: number): string | null => {
    if (depth > MAX_QUERY_DEPTH) return "That filter is nested too deeply.";
    if ("all" in node) return firstError(node.all, depth);
    if ("any" in node) return firstError(node.any, depth);
    if ("not" in node) return walk(node.not, depth + 1);
    leaves++;
    if (leaves > MAX_QUERY_LEAVES) return "That filter has too many conditions.";
    if (node.field === "date" && !node.from && !node.to) return "A date condition needs a start or an end.";
    return null;
  };
  const firstError = (nodes: QueryNode[], depth: number): string | null => {
    for (const n of nodes) {
      const e = walk(n, depth + 1);
      if (e) return e;
    }
    return null;
  };
  const error = walk(parsed.data, 1);
  return error ? { ok: false, message: error } : { ok: true, query: parsed.data };
}

export const SORTS = ["newest", "oldest", "source", "title", "kept"] as const;
export type Sort = (typeof SORTS)[number];
