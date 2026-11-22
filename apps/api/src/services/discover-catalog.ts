import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CATALOG_CATEGORIES, initialsFor, isCatalogCategory } from "@purss/domain";
import type { CatalogCategory, CatalogCategoryList, CatalogResponse, CatalogSource, SiteSearchHit } from "@purss/domain";
import { server } from "@purss/copy/server";
import type { App, Principal } from "../app.ts";
import { notFound } from "../http.ts";
import { hueFor } from "./content.ts";
import { NAMED, feedKey, hostOf, letters, ownSources, skipPrivate } from "./discover.ts";

/*
 * Discovery's catalog of popular sources by category: `discover-catalog.sqlite` in the data directory, put there by hand and never
 * part of this repository. The hosted service has its own editorial one; any other installation shows category boxes only when its
 * administrator puts a catalog there. The file is opened read-only and kept in memory until it changes on disk; a file that can't be
 * read counts as none.
 *
 * The file holds one table the API reads (other tables, such as where each popularity figure came from, are left alone):
 *   sources(feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
 *           language TEXT NOT NULL, description TEXT, weight REAL NOT NULL, image_url TEXT)
 * `category` is one of CATALOG_CATEGORIES, `kind` feed, youtube or podcast, `language` a language code, `weight` how popular the
 * source is on a log scale, and `image_url` (optional) a podcast's https artwork. Only English sources are shown.
 */

/** Sources of each category Discovery's overview sends: more than a box shows, so the page's chance has some to choose from. */
export const OVERVIEW_PER_CATEGORY = 24;
const LANGUAGE = "en";
const KINDS = new Set(["feed", "youtube", "podcast"]);

type Entry = CatalogSource & { category: CatalogCategory; feed_url: string };
type Loaded = { mtimeMs: number; size: number; byCategory: Map<CatalogCategory, Entry[]>; all: Entry[] };
type Row = { feed_url: string; title: string; site_url: string | null; category: string; kind: string; description: string | null; weight: number; image_url: string | null };
const loaded = new Map<string, Loaded | null>();

function readRows(file: string): Row[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const image = (db.prepare("PRAGMA table_info(sources)").all() as { name: string }[]).some((c) => c.name === "image_url") ? "image_url" : "NULL AS image_url";
    return db.prepare(`SELECT feed_url, title, site_url, category, kind, description, weight, ${image} FROM sources WHERE language = ? ORDER BY weight DESC, title`)
      .all(LANGUAGE) as Row[];
  } finally { db.close(); }
}

const httpsImage = (v: string | null): string | null => { try { return v && new URL(v).protocol === "https:" ? v : null; } catch { return null; } };

/** The catalog's shown sources, most popular first in each category; null when there is no catalog file or it can't be read. */
export function readCatalog(file: string): Loaded | null {
  let st: { mtimeMs: number; size: number };
  try { st = statSync(file); } catch { loaded.delete(file); return null; }
  const kept = loaded.get(file);
  if (kept !== undefined && (kept === null ? stamps.get(file) === `${st.mtimeMs}:${st.size}` : kept.mtimeMs === st.mtimeMs && kept.size === st.size)) return kept;
  let rows: Row[];
  try { rows = readRows(file); } catch (err) {
    console.error(`[api] Discovery's catalog ${file} can't be read, so it is left out: ${(err as Error).message}`);
    loaded.set(file, null);
    stamps.set(file, `${st.mtimeMs}:${st.size}`);
    return null;
  }
  const byCategory = new Map<CatalogCategory, Entry[]>(CATALOG_CATEGORIES.map((c) => [c, []]));
  const all: Entry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = feedKey(r.feed_url);
    if (!key || seen.has(key) || !isCatalogCategory(r.category) || !KINDS.has(r.kind) || !r.title.trim() || !Number.isFinite(r.weight)) continue;
    seen.add(key);
    const e: Entry = {
      key, title: r.title.trim(), host: hostOf(r.site_url) ?? hostOf(r.feed_url), feedUrl: r.feed_url, feed_url: r.feed_url,
      kind: r.kind as Entry["kind"], description: r.description?.trim() || null, weight: r.weight, category: r.category,
      imageUrl: r.kind === "podcast" ? httpsImage(r.image_url) : null, hue: hueFor(r.title.trim()), initials: initialsFor(r.title.trim()),
    };
    byCategory.get(r.category)!.push(e);
    all.push(e);
  }
  const out = { mtimeMs: st.mtimeMs, size: st.size, byCategory, all };
  loaded.set(file, out);
  return out;
}

/** When a catalog that couldn't be read was last looked at, so it is tried again only once it changes. */
const stamps = new Map<string, string>();

const shown = ({ key, title, host, feedUrl, kind, description, weight, imageUrl, hue, initials }: Entry): CatalogSource =>
  ({ key, title, host, feedUrl, kind, description, weight, imageUrl, hue, initials });

/** Whether this installation has a catalog to show. */
export const hasCatalog = (app: App): boolean => (readCatalog(app.config.catalogFile)?.all.length ?? 0) > 0;

/**
 * The catalog for the signed-in reader: every category's most popular sources (all of one category's when `category` is given),
 * leaving out the sources the reader has. No categories when the installation has no catalog.
 */
export function catalogFor(app: App, p: Principal, category?: string): CatalogResponse {
  if (category !== undefined && !isCatalogCategory(category)) throw notFound(server.api.discover.discoverName);
  const cat = readCatalog(app.config.catalogFile);
  if (!cat) return { categories: [] };
  const { skip } = ownSources(app, p);
  skipPrivate(app, p, cat.all, skip);
  const ids = category === undefined ? CATALOG_CATEGORIES : [category];
  const categories: CatalogCategoryList[] = ids.flatMap((id) => {
    const open = cat.byCategory.get(id)!.filter((e) => !skip.has(e.key));
    if (!open.length) return [];
    return [{ id, total: open.length, sources: (category === undefined ? open.slice(0, OVERVIEW_PER_CATEGORY) : open).map(shown) }];
  });
  return { categories };
}

/**
 * The catalog's sources whose name or site matches a typed name, for Add source's name search: a name that is the one typed first,
 * then the most popular.
 */
export function catalogNamed(app: App, query: string): SiteSearchHit[] {
  const q = letters(query);
  if (q.length < 2) return [];
  const cat = readCatalog(app.config.catalogFile);
  if (!cat) return [];
  return cat.all
    .filter((e) => letters(e.title).includes(q) || (e.host !== null && letters(e.host).includes(q)))
    .sort((a, b) => Number(letters(b.title) === q) - Number(letters(a.title) === q) || b.weight - a.weight)
    .slice(0, NAMED)
    .map((e) => ({ name: e.title, description: e.description, address: e.feedUrl, site: e.host ?? "", from: "catalog" }));
}
