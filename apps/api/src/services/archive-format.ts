import { createHash } from "node:crypto";
import { z } from "zod";
import { ANNOTATION_BODY_MAX, ANNOTATION_CONTEXT_MAX, ANNOTATION_QUOTE_MAX, ITEM_KINDS, WORKFLOW_STATES } from "@purss/domain";

/*
 * PURSS export archive, schema version 1.
 *
 * One JSON document, written as a stream. Top-level fields, in order:
 *   format           "purss-workspace-export"
 *   schemaVersion    1; an importer rejects a newer version instead of guessing
 *   exportedAt       ISO time
 *   omitted          plain-language list of what is deliberately not in the file
 *   sources          followed and unfollowed sources; private ones are secret-free references
 *   collections      source and filter collections (filters reference archive ids)
 *   baskets          basket definitions
 *   memberships      basket -> item pins with the kept version and keep time
 *   items            items with every stored version (current and kept), captured text (fetched
 *                    by the server or sent by the person's browser, by `kind`),
 *                    workflow / progress / fresh state and original publisher GUIDs
 *   preferences      one object
 *   stateLog         the account's own workflow changes (item, from, to, time), oldest first;
 *                    optional on import so older files still load
 *   annotations      the person's own highlights and notes (item, kind, quoted passage with its
 *                    context and position, the text it was made on, comment or note, times);
 *                    removed ones are not exported; optional on import like stateLog
 *   images           the pictures kept with items in baskets that keep readable text (item, address
 *                    they were saved from, type, hash, the bytes as base64); written only when there
 *                    are any
 *   itemReminders    the days set with "Remind me" on kept items (item, day "YYYY-MM-DD", note); written
 *                    only when there are any
 *   shares           sharing settings of baskets and collections (target, name shown, description,
 *                    search listing) with their public notes; written only when there are any; an
 *                    import never shares anything
 *   manifest         { algorithm: "sha256", sections: { <name>: { count, sha256 } } }
 *
 * `manifest` comes last because the file is streamed; its hashes cover the exact JSON text
 * of each section (JSON.stringify of the section value, no whitespace). IDs inside the file
 * are archive IDs: an import allocates new IDs and maps them. Nothing in the archive is a
 * credential: passwords, sessions, tokens, service secrets, private feed/item/media
 * addresses and collection-engine identifiers are never written.
 */

export const ARCHIVE_FORMAT = "purss-workspace-export";
export const ARCHIVE_SCHEMA_VERSION = 1;
export const SECTION_NAMES = ["sources", "collections", "baskets", "memberships", "items", "preferences"] as const;
/** Sections an older export lacks; when present they are checked against the manifest like the others. */
export const OPTIONAL_SECTION_NAMES = ["stateLog", "annotations", "images", "itemReminders", "shares"] as const;
export type SectionName = (typeof SECTION_NAMES)[number] | (typeof OPTIONAL_SECTION_NAMES)[number];

export const ARCHIVE_OMITTED: readonly string[] = [
  "Passwords, passkeys, recovery codes, sign-in sessions and access tokens are never exported.",
  "Service secrets and the collection engine's own data and identifiers are not included.",
  "Private source links, and any link, image or media address that belongs to an item from a private source, are left out. Those sources are exported as references that need to be reconnected.",
  "Addresses that carry a password or access key are left out of item links and media.",
  "Readable-text captures that were still in progress, and temporary data (undo history, pending confirmations, discovery previews, notifications), are not exported.",
  "Only text and links that were actually saved are included. Pages, images, audio and video that were never captured are not, and may no longer exist at their original address.",
  "Sharing settings and public notes are exported; importing them never shares anything.",
];

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

// ---------- import validation ----------
// Every field is bounded: an archive is untrusted input even when it came from us.

const id = z.string().min(1).max(120);
const iso = z.string().max(40).nullable().default(null);
const text = (max: number) => z.string().max(max);

const sourceSchema = z.object({
  id,
  kind: z.enum(["feed", "youtube", "podcast", "publication", "private", "manual"]),
  title: text(300),
  origin: text(200).default("RSS feed"),
  siteUrl: text(2000).nullable().default(null),
  feedUrl: text(2000).nullable().default(null),
  isPrivate: z.boolean().default(false),
  reconnectRequired: z.boolean().default(false),
  curator: text(100).nullable().default(null),
  hue: z.number().int().min(0).max(359).default(210),
  followed: z.boolean().default(true),
  paused: z.boolean().default(false),
  notify: z.enum(["default", "on", "muted"]).default("default"),
  fullText: z.boolean().default(false),
  createdAt: iso,
  lastItemAt: iso,
});

const collectionSchema = z.object({
  id,
  name: text(80),
  emoji: text(8).nullable().default(null),
  // "manual" is only ever read, from files made when hand-picked collections existed; an import skips those.
  mode: z.enum(["sources", "manual", "query"]),
  view: z.enum(["list", "cards", "board", "table", "timeline"]).default("list"),
  query: z.unknown().default(null),
  showOnHome: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
  createdAt: iso,
  sourceIds: z.array(id).max(5000).default([]),
});

const basketSchema = z.object({
  id,
  name: text(80),
  captureMode: z.enum(["metadata", "text"]).default("text"),
  position: z.number().int().min(0).default(0),
  createdAt: iso,
});

const membershipSchema = z.object({ basketId: id, itemId: id, versionId: id.nullable().default(null), keptAt: z.string().max(40) });

const versionSchema = z.object({
  id,
  title: text(2000),
  url: text(4000).nullable().default(null),
  summaryHtml: text(500_000).nullable().default(null),
  contentHtml: text(5_000_000).nullable().default(null),
  createdAt: iso,
});

const captureSchema = z.object({
  id,
  /** "fulltext": the server fetched the page; "browser": the person's browser sent its readable text. Optional on import (older files have server captures only). */
  kind: z.enum(["fulltext", "browser"]).default("fulltext"),
  status: z.enum(["done", "failed"]),
  title: text(2000).nullable().default(null),
  text: text(5_000_000).nullable().default(null),
  html: text(5_000_000).nullable().default(null),
  finalUrl: text(4000).nullable().default(null),
  error: text(500).nullable().default(null),
  /** Whether a finished server capture passed the checks (full) or is only part of the page, and why. Absent: not checked. */
  quality: z.enum(["full", "partial"]).nullable().default(null),
  partialReason: z.enum(["gated", "references", "short"]).nullable().default(null),
  createdAt: iso,
  completedAt: iso,
});

const itemSchema = z.object({
  id,
  sourceId: id.nullable().default(null),
  kind: z.string().max(20).default("article"),
  title: text(2000),
  url: text(4000).nullable().default(null),
  urlRedacted: z.boolean().default(false),
  author: text(500).nullable().default(null),
  imageUrl: text(4000).nullable().default(null),
  durationSeconds: z.number().int().min(0).nullable().default(null),
  doi: text(200).nullable().default(null),
  curatorNote: text(5000).nullable().default(null),
  publishedAt: iso,
  discoveredAt: iso,
  createdAt: iso,
  enclosures: z.array(z.object({ url: text(4000), type: text(200).nullable().default(null), length: z.number().nullable().default(null) })).max(10).default([]),
  currentVersionId: id.nullable().default(null),
  versions: z.array(versionSchema).max(50).default([]),
  captures: z.array(captureSchema).max(50).default([]),
  state: z.object({
    workflow: z.enum(WORKFLOW_STATES).default("new"),
    fresh: z.boolean().default(false),
    progress: z.number().min(0).max(1).default(0),
    openedAt: iso,
  }).default({ workflow: "new", fresh: false, progress: 0, openedAt: null }),
  originalGuids: z.array(text(2000)).max(5).default([]),
});

const shareSchema = z.object({
  targetKind: z.enum(["basket", "collection"]),
  targetId: id,
  curatorName: text(60),
  description: text(500).nullable().default(null),
  listed: z.boolean().default(false),
  notes: z.array(z.object({ itemId: id, note: text(600) })).max(100_000).default([]),
});

const stateLogSchema = z.object({ itemId: id, from: z.enum(WORKFLOW_STATES), to: z.enum(WORKFLOW_STATES), at: z.string().max(40) });

const annotationSchema = z.object({
  id,
  itemId: id,
  kind: z.enum(["highlight", "note"]),
  quote: z.object({ exact: text(ANNOTATION_QUOTE_MAX).min(1), prefix: text(ANNOTATION_CONTEXT_MAX).default(""), suffix: text(ANNOTATION_CONTEXT_MAX).default("") }).nullable().default(null),
  position: z.object({ start: z.number().int().min(0).max(50_000_000), end: z.number().int().min(0).max(50_000_000) }).nullable().default(null),
  target: z.object({ kind: z.enum(["capture", "version"]), id }).nullable().default(null),
  body: text(ANNOTATION_BODY_MAX).nullable().default(null),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
}).refine((a) => (a.kind === "highlight" ? a.quote !== null && a.quote.exact.trim().length > 0 : !!a.body?.trim()));

/** A day set with "Remind me" on a kept item (the person's own calendar day) and its note. */
const itemReminderSchema = z.object({ itemId: id, remindOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: text(300).nullable().default(null) });

const imageSchema = z.object({
  itemId: id,
  url: text(2048),
  role: z.enum(["cover", "inline"]),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  data: text(14_000_000),
});

const sectionStats = z.object({ count: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export const archiveSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  schemaVersion: z.number().int(),
  exportedAt: z.string().max(40),
  omitted: z.array(z.string().max(500)).max(50).default([]),
  sources: z.array(sourceSchema).max(20_000),
  collections: z.array(collectionSchema).max(5000),
  baskets: z.array(basketSchema).max(2000),
  memberships: z.array(membershipSchema).max(1_000_000),
  items: z.array(itemSchema).max(500_000),
  // Only ever read, from files made when saved searches existed; an import skips them.
  savedQueries: z.array(z.unknown()).max(2000).default([]),
  preferences: z.record(z.string(), z.unknown()),
  // Only ever read, from files made when shared collections were separate lists; an import skips them.
  publications: z.array(z.unknown()).max(500).default([]),
  stateLog: z.array(stateLogSchema).max(2_000_000).default([]),
  annotations: z.array(annotationSchema).max(1_000_000).default([]),
  images: z.array(imageSchema).max(1_000_000).default([]),
  itemReminders: z.array(itemReminderSchema).max(1_000_000).default([]),
  shares: z.array(shareSchema).max(10_000).default([]),
  manifest: z.object({
    algorithm: z.literal("sha256"),
    sections: z.object({
      ...(Object.fromEntries(SECTION_NAMES.map((n) => [n, sectionStats])) as Record<(typeof SECTION_NAMES)[number], typeof sectionStats>),
      stateLog: sectionStats.optional(),
      annotations: sectionStats.optional(),
      images: sectionStats.optional(),
      itemReminders: sectionStats.optional(),
      shares: sectionStats.optional(),
    }),
  }),
});

export type Archive = z.infer<typeof archiveSchema>;
export type ArchiveItem = z.infer<typeof itemSchema>;
export type ArchiveSource = z.infer<typeof sourceSchema>;
export type ArchiveCollection = z.infer<typeof collectionSchema>;
export type ArchiveShare = z.infer<typeof shareSchema>;
export type ArchiveAnnotation = z.infer<typeof annotationSchema>;

export class ArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Check an export file: format, version, per-section counts and hashes, then field bounds.
 * `raw` is the parsed JSON before any defaults are applied, so hashes cover exactly what was written.
 */
export function parseArchive(raw: unknown): Archive {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArchiveError("not_archive", "That file isn't a PURSS export.");
  const head = raw as Record<string, unknown>;
  if (head.format !== ARCHIVE_FORMAT) throw new ArchiveError("not_archive", "That file isn't a PURSS export.");
  if (typeof head.schemaVersion !== "number" || !Number.isInteger(head.schemaVersion) || head.schemaVersion < 1) {
    throw new ArchiveError("bad_version", "That export file has no readable version.");
  }
  if (head.schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveError("newer_version", "That export was made by a newer version of PURSS. Update this installation before importing it.");
  }
  const manifest = head.manifest as { sections?: Record<string, { count?: unknown; sha256?: unknown }> } | undefined;
  if (!manifest?.sections) throw new ArchiveError("incomplete", "That export file looks incomplete: it has no integrity manifest. It may have been cut short while downloading.");
  const verify = (name: SectionName, section: unknown, stats: { count?: unknown; sha256?: unknown } | undefined) => {
    if (section === undefined || !stats) throw new ArchiveError("incomplete", `That export file is missing its "${name}" section.`);
    const count = Array.isArray(section) ? section.length : 1;
    if (stats.count !== count || stats.sha256 !== sha256Hex(JSON.stringify(section))) {
      throw new ArchiveError("damaged", `That export file looks damaged: its "${name}" section doesn't match its integrity check.`);
    }
  };
  for (const name of SECTION_NAMES) verify(name, head[name], manifest.sections[name]);
  for (const name of OPTIONAL_SECTION_NAMES) {
    if (head[name] !== undefined || manifest.sections[name] !== undefined) verify(name, head[name], manifest.sections[name]);
  }
  const parsed = archiveSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.slice(0, 3).join(".")})` : "";
    throw new ArchiveError("invalid", `That export file has details this version can't read${where}.`);
  }
  return parsed.data;
}

export const KNOWN_KINDS: readonly string[] = ITEM_KINDS;
