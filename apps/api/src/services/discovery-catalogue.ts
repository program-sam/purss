import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CATALOG_CATEGORIES, initialsFor, isCatalogueCategory } from "@purss/domain";
import type { CatalogueCategory, CatalogueCategoryList, CatalogueResponse, CatalogueSource, SiteSearchHit } from "@purss/domain";
import { server } from "@purss/translations/server";
import { isStoredIcon } from "@purss/connectors";
import type { App, Principal } from "../app.ts";
import { notFound } from "../http.ts";
import { hueFor } from "./content.ts";
import { NAMED, hostOf, letters, ownSources, skipPrivate } from "./discover.ts";
import { feedKey } from "./source-identity.ts";

/*
 * Discovery's catalogue of popular sources by category: `discovery-catalogue.sqlite` in the data directory, put there by hand and never
 * part of this repository. The hosted service has its own editorial one; any other installation shows category boxes only when its
 * administrator puts a catalogue there. The file is opened read-only and kept in memory until it changes on disk; a file that can't be
 * read counts as none.
 *
 * The file holds one table the API reads (other tables, such as where each popularity figure came from, are left alone):
 *   sources(feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
 *           language TEXT NOT NULL, description TEXT, weight REAL NOT NULL, icon BLOB)
 * `category` is one of CATALOG_CATEGORIES, `kind` feed, youtube or podcast, `language` a language code, `weight` how popular the
 * source is on a log scale, and `icon` (optional) a WebP of at most 64 KiB, as PURSS stores a followed source's icon. Icons are not
 * kept in memory: each is read from the file when asked for, by its digest. Only English sources are shown.
 */

/** Sources of each category Discovery's overview sends: more than a box shows, so the page's chance has some to choose from. */
export const OVERVIEW_PER_CATEGORY = 24;
const LANGUAGE = "en";
const KINDS = new Set(["feed", "youtube", "podcast"]);

type Entry = Omit<CatalogueSource, "iconUrl"> & { category: CatalogueCategory; feed_url: string; iconDigest: string | null; weight: number };
type Loaded = { mtimeMs: number; size: number; byCategory: Map<CatalogueCategory, Entry[]>; all: Entry[] };
type Row = { feed_url: string; title: string; site_url: string | null; category: string; kind: string; description: string | null; weight: number; icon: Uint8Array | null };
const loaded = new Map<string, Loaded | null>();

function readRows(file: string): Row[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const icon = hasIconColumn(db) ? "icon" : "NULL AS icon";
    return db.prepare(`SELECT feed_url, title, site_url, category, kind, description, weight, ${icon} FROM sources WHERE language = ? ORDER BY weight DESC, title`)
      .all(LANGUAGE) as Row[];
  } finally { db.close(); }
}

const hasIconColumn = (db: DatabaseSync): boolean => (db.prepare("PRAGMA table_info(sources)").all() as { name: string }[]).some((c) => c.name === "icon");
const iconDigest = (b: Uint8Array | null): string | null => (b && isStoredIcon(b) ? createHash("sha256").update(b).digest("hex").slice(0, 32) : null);
export const catalogueIconPath = (digest: string): string => `/api/suggestions/catalogue/icons/${digest}`;

/** The catalogue's shown sources, most popular first in each category; null when there is no catalogue file or it can't be read. */
export function readCatalogue(file: string): Loaded | null {
  let st: { mtimeMs: number; size: number };
  try { st = statSync(file); } catch { loaded.delete(file); return null; }
  const kept = loaded.get(file);
  if (kept !== undefined && (kept === null ? stamps.get(file) === `${st.mtimeMs}:${st.size}` : kept.mtimeMs === st.mtimeMs && kept.size === st.size)) return kept;
  let rows: Row[];
  try { rows = readRows(file); } catch (err) {
    console.error(`[api] Discovery's catalogue ${file} can't be read, so it is left out: ${(err as Error).message}`);
    loaded.set(file, null);
    stamps.set(file, `${st.mtimeMs}:${st.size}`);
    return null;
  }
  const byCategory = new Map<CatalogueCategory, Entry[]>(CATALOG_CATEGORIES.map((c) => [c, []]));
  const all: Entry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = feedKey(r.feed_url);
    if (!key || seen.has(key) || !isCatalogueCategory(r.category) || !KINDS.has(r.kind) || !r.title.trim() || !Number.isFinite(r.weight)) continue;
    seen.add(key);
    const e: Entry = {
      key, title: r.title.trim(), host: hostOf(r.site_url) ?? hostOf(r.feed_url), feedUrl: r.feed_url, feed_url: r.feed_url,
      kind: r.kind as Entry["kind"], description: r.description?.trim() || null, weight: r.weight, category: r.category,
      iconDigest: iconDigest(r.icon), hue: hueFor(r.title.trim()), initials: initialsFor(r.title.trim()),
    };
    byCategory.get(r.category)!.push(e);
    all.push(e);
  }
  const out = { mtimeMs: st.mtimeMs, size: st.size, byCategory, all };
  loaded.set(file, out);
  return out;
}

/** When a catalogue that couldn't be read was last looked at, so it is tried again only once it changes. */
const stamps = new Map<string, string>();

/** What a reader's browser gets of a source. Popularity figures never leave the server: only the order they led to does. */
const shown = ({ key, title, host, feedUrl, kind, description, iconDigest: digest, hue, initials }: Entry): CatalogueSource =>
  ({ key, title, host, feedUrl, kind, description, iconUrl: digest ? catalogueIconPath(digest) : null, hue, initials });

/** How much chance reorders the popular sources, on their log-scale weight. */
const CHANCE = 1;

/**
 * Sources most popular first, with chance: each weight gets Gumbel noise from `random`, so a popular source usually comes early but
 * the order differs on every request. Pure for a given `random`.
 */
export function byChance<T extends { weight: number }>(list: readonly T[], random: () => number = Math.random): T[] {
  return list
    .map((s) => ({ s, v: s.weight - CHANCE * Math.log(-Math.log(Math.min(Math.max(random(), 1e-12), 1 - 1e-12))) }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.s);
}

/** A catalogue source's icon by its digest, read from the file; not found when no shown source has it. */
export function catalogueIcon(app: App, digest: string): { bytes: Uint8Array; digest: string } {
  const cat = readCatalogue(app.config.catalogueFile);
  const entry = /^[0-9a-f]{32}$/.test(digest) ? cat?.all.find((e) => e.iconDigest === digest) : undefined;
  if (!entry) throw notFound(server.api.discover.discoverName);
  const db = new DatabaseSync(app.config.catalogueFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT icon FROM sources WHERE feed_url = ?").get(entry.feed_url) as { icon: Uint8Array | null } | undefined;
    if (!row?.icon || iconDigest(row.icon) !== digest) throw notFound(server.api.discover.discoverName);
    return { bytes: row.icon, digest };
  } finally { db.close(); }
}

/** Whether this installation has a catalogue to show. */
export const hasCatalogue = (app: App): boolean => (readCatalogue(app.config.catalogueFile)?.all.length ?? 0) > 0;

/**
 * The catalogue for the signed-in reader: every category's most popular sources (all of one category's when `category` is given),
 * in a new order with chance on each request and without their figures, leaving out the sources the reader has. No categories when the installation has no catalogue.
 */
export function catalogueFor(app: App, p: Principal, category?: string): CatalogueResponse {
  if (category !== undefined && !isCatalogueCategory(category)) throw notFound(server.api.discover.discoverName);
  const cat = readCatalogue(app.config.catalogueFile);
  if (!cat) return { categories: [] };
  const { skip } = ownSources(app, p);
  skipPrivate(app, p, cat.all, skip);
  const ids = category === undefined ? CATALOG_CATEGORIES : [category];
  const categories: CatalogueCategoryList[] = ids.flatMap((id) => {
    const open = cat.byCategory.get(id)!.filter((e) => !skip.has(e.key));
    if (!open.length) return [];
    return [{ id, total: open.length, sources: byChance(category === undefined ? open.slice(0, OVERVIEW_PER_CATEGORY) : open).map(shown) }];
  });
  return { categories };
}

/**
 * The catalogue's sources whose name or site matches a typed name, for Add source's name search: a name that is the one typed first,
 * then the most popular.
 */
export function catalogueNamed(app: App, query: string): SiteSearchHit[] {
  const q = letters(query);
  if (q.length < 2) return [];
  const cat = readCatalogue(app.config.catalogueFile);
  if (!cat) return [];
  return cat.all
    .filter((e) => letters(e.title).includes(q) || (e.host !== null && letters(e.host).includes(q)))
    .sort((a, b) => Number(letters(b.title) === q) - Number(letters(a.title) === q) || b.weight - a.weight)
    .slice(0, NAMED)
    .map((e) => ({ name: e.title, description: e.description, address: e.feedUrl, site: e.host ?? "", from: "catalogue" }));
}
