import { z } from "zod";

/*
 * Annotations (plan/26): the person's own highlights and notes on an item. They are separate from
 * workflow, reading progress, collections, baskets and retention. IDs are chosen by the client
 * (`ann_` + 26 characters, the same shape as every product id) so they can be made offline; a write
 * carries the time it was made and the later write wins. The web app mirrors the limits below in
 * apps/web/src/annotations/limits.ts (a test keeps them equal).
 */

/** Longest comment or note, in characters. */
export const ANNOTATION_BODY_MAX = 10_000;
/** Longest highlighted passage, in characters. */
export const ANNOTATION_QUOTE_MAX = 5_000;
/** Text kept before and after a passage to tell repeated passages apart. */
export const ANNOTATION_CONTEXT_MAX = 64;
/** Most annotations one item can have (removed ones don't count). */
export const ANNOTATIONS_PER_ITEM = 500;

export const ANNOTATION_KINDS = ["highlight", "note"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** Which text a highlight was made on: a readable-text capture or an item version (feed or kept copy). */
export type TextRef = { kind: "capture" | "version"; id: string };
/** A text-quote selector over the reader's text with runs of white space collapsed to one space. */
export type TextQuote = { exact: string; prefix: string; suffix: string };
/** Where the passage started and ended in that text: a hint for finding it again quickly. */
export type TextPosition = { start: number; end: number };

export type AnnotationDTO = {
  id: string;
  itemId: string;
  kind: AnnotationKind;
  /** Highlights only: the marked passage, which is the publisher's text. */
  quote: TextQuote | null;
  position: TextPosition | null;
  /** The text the highlight was made on, when it is known. */
  target: TextRef | null;
  /** The person's own words: a highlight's comment (optional) or a note's text. */
  body: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnnotationList = { itemId: string; annotations: AnnotationDTO[] };

/** The answer to a create, change or removal: what the server now holds, and whether this write won. */
export type AnnotationWriteResult = {
  /** The annotation as stored after this write; null when it is removed (or was never stored). */
  annotation: AnnotationDTO | null;
  /** False when a later write was already stored, so this one was ignored (last write wins). */
  applied: boolean;
};

export const annotationIdSchema = z.string().regex(/^ann_[0-9a-z]{26}$/);
const writtenAt = z.iso.datetime({ offset: true });

export const annotationPutSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("highlight"),
    quote: z.object({
      exact: z.string().min(1).max(ANNOTATION_QUOTE_MAX).refine((s) => s.trim().length > 0),
      prefix: z.string().max(ANNOTATION_CONTEXT_MAX).default(""),
      suffix: z.string().max(ANNOTATION_CONTEXT_MAX).default(""),
    }),
    position: z.object({ start: z.number().int().min(0).max(50_000_000), end: z.number().int().min(0).max(50_000_000) })
      .refine((p) => p.end > p.start).nullable().default(null),
    target: z.object({ kind: z.enum(["capture", "version"]), id: z.string().max(60) }).nullable().default(null),
    body: z.string().max(ANNOTATION_BODY_MAX).nullable().default(null),
    updatedAt: writtenAt,
  }),
  z.object({
    kind: z.literal("note"),
    body: z.string().max(ANNOTATION_BODY_MAX).refine((s) => s.trim().length > 0),
    updatedAt: writtenAt,
  }),
]);
export type AnnotationPut = z.input<typeof annotationPutSchema>;

export const annotationDeleteSchema = z.object({ updatedAt: writtenAt });
