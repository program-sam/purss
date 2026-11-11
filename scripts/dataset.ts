import { mkdirSync, mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { newId } from "@purss/domain";
import type { SyncEntry, WorkflowState } from "@purss/domain";
import type { App, Principal } from "../apps/api/src/app.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { openDatabase } from "../apps/api/src/db/database.ts";
import { applySyncBatch } from "../apps/api/src/services/sync.ts";
import { bulk, keepItem } from "../apps/api/src/services/state.ts";
import { completeCapture, failCapture } from "../apps/api/src/services/captures.ts";
import { createBasket, createCollection } from "../apps/api/src/services/collections.ts";
import { listNotifications, markNotificationsRead } from "../apps/api/src/services/notifications.ts";
import { expireFreshMarkers } from "../apps/api/src/services/returning.ts";
import { makeOwner, makeSource } from "../apps/api/src/testing.ts";

/*
 * Builds a realistic dataset in a throwaway data directory, through the product's own code: accounts and
 * sources as the tests make them, items through the sync batch path (so they get versions, search entries,
 * storage objects and arrival notifications exactly as a real sync gives them), workflow states and
 * New markers through the bulk actions, and kept items and their readable-text captures through Keep.
 *
 *   node scripts/dataset.ts [--dir <dir>] [--accounts 1] [--sources 300] [--items 100000] [--seed 1]
 *
 * Items follow the sync's own rules: the sources are followed 60 days ago, their back catalogue arrives first (not New),
 * the sources settle, and the later 8% arrive as New; New markers older than the default 30 days then expire.
 * Defaults are the size gate in plan/13: one account with 300 sources and 100,000 items. `--accounts 20`
 * builds the host gate (20 such accounts, about 2 million items: allow an hour and several GB of disk).
 * `--items` and `--sources` are per account. The directory defaults to a new one under the repository's
 * ignored data/ folder; it is never deleted by this script. A few percent of the items end up New. Point PURSS_DATA_DIR
 * at it to serve it.
 */

export type DatasetOptions = {
  /** Data directory to build in (created if missing). */
  dir: string;
  accounts?: number;
  /** Sources per account. */
  sources?: number;
  /** Items per account. */
  items?: number;
  seed?: number;
  /** Progress lines; defaults to silent. */
  log?: (line: string) => void;
};

export type DatasetAccount = { principal: Principal & { engineUserId: string }; sourceIds: string[]; itemIds: string[] };
export type Dataset = { app: App; dir: string; accounts: DatasetAccount[]; close: () => void };

/** Entries the engine hands over in one sync batch; a batch touches a few dozen of the account's sources. */
const BATCH_ENTRIES = 100;
/** The account followed its sources this long ago, and this share of its items arrived since (the rest is back catalogue). */
const FOLLOWED_DAYS_AGO = 60;
const ARRIVAL_SHARE = 0.08;

// ---------- deterministic randomness and text ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = () => number;
const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

const EN = ["tidal", "flats", "sediment", "research", "network", "reading", "archive", "notes", "design", "engine", "field", "season", "protocol", "garden", "signal", "report", "library", "history", "method", "analysis", "story", "interview", "release", "update", "guide", "review", "season", "recipe", "podcast", "episode", "chapter", "essay", "map", "paper", "dataset"];
const AR = ["الأخبار", "اليوم", "تقرير", "مقال", "الثقافة", "العلوم", "التقنية", "الاقتصاد", "الرياضة", "المجتمع", "الكتاب", "المدينة", "الحياة", "الطبيعة"];
const ZH = ["今天", "新闻", "文章", "研究", "报告", "技术", "社会", "经济", "文化", "生活", "科学", "历史", "世界", "城市"];
const RU = ["сегодня", "новости", "статья", "исследование", "отчёт", "технологии", "общество", "экономика", "культура", "жизнь", "наука", "история", "мир", "город"];
type Language = { words: readonly string[]; joiner: string };
const LANGUAGES: Array<{ weight: number; lang: Language }> = [
  { weight: 90, lang: { words: EN, joiner: " " } },
  { weight: 4, lang: { words: AR, joiner: " " } },
  { weight: 3, lang: { words: ZH, joiner: "" } },
  { weight: 3, lang: { words: RU, joiner: " " } },
];

function languageFor(r: Rand): Language {
  let x = r() * 100;
  for (const l of LANGUAGES) {
    x -= l.weight;
    if (x < 0) return l.lang;
  }
  return LANGUAGES[0]!.lang;
}

function sentence(r: Rand, lang: Language, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(pick(r, lang.words));
  return out.join(lang.joiner);
}

/** Paragraphs of the language's words: most posts are a few hundred characters, one in twenty is a long read. */
function bodyHtml(r: Rand, lang: Language): string {
  const paragraphs = r() < 0.05 ? 20 + Math.floor(r() * 60) : 1 + Math.floor(r() * 4);
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i++) out.push(`<p>${sentence(r, lang, 25 + Math.floor(r() * 30))}.</p>`);
  return out.join("\n");
}

// ---------- building ----------

const KINDS = ["feed", "feed", "feed", "feed", "feed", "feed", "youtube", "podcast", "publication"] as const;

function createApp(dir: string): App {
  mkdirSync(dir, { recursive: true });
  const config = loadConfig({ PURSS_DATA_DIR: dir, PURSS_DISK_RESERVE_BYTES: "0" });
  return { db: openDatabase(config.dbFile), config, events: new EventEmitter(), serviceToken: "dataset" };
}

/** Sources get very different posting rates: a few busy ones and a long tail (weight ~ 1 / rank). */
function sourceWeights(count: number): number[] {
  const w = Array.from({ length: count }, (_, i) => 1 / (i + 1) ** 0.8);
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

function buildAccount(app: App, index: number, opts: Required<Omit<DatasetOptions, "dir" | "log">>, log: (line: string) => void): DatasetAccount {
  const r = rng(opts.seed * 7919 + index);
  const p = makeOwner(app, { admin: index === 0 });
  const tag = `a${index + 1}`;

  // Sources, in collections of about 30 (a source can be in two; some are in none).
  const sourceIds: string[] = [];
  const streams: string[] = [];
  const kinds: string[] = [];
  for (let s = 0; s < opts.sources; s++) {
    const kind = pick(r, KINDS);
    const stream = `feed/${index + 1}${String(s + 1).padStart(4, "0")}`;
    streams.push(stream);
    kinds.push(kind);
    sourceIds.push(makeSource(app, p, `Source ${tag}-${s + 1}`, stream, { kind, settled: false }));
  }
  // Every tenth source is set to "Notify me", so its New arrivals are told at once; the rest wait for the weekly digest.
  for (const id of sourceIds.filter((_, s) => s % 10 === 0)) app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", id);
  const collectionCount = Math.max(1, Math.round(opts.sources / 30));
  for (let c = 0; c < collectionCount; c++) {
    const members = sourceIds.filter((_, s) => s % collectionCount === c || (s % 7 === 0 && (s / 7) % collectionCount === c));
    createCollection(app, p, { name: `Collection ${c + 1}`, emoji: null, mode: "sources", sourceIds: members.slice(0, 500), query: null, view: "list" });
  }
  const readLater = createBasket(app, p, { name: "Read later", captureMode: "text" });
  const reference = createBasket(app, p, { name: "Reference", captureMode: "metadata" });

  // Items arrive in time order, a sync pass at a time, over about two years.
  const weights = sourceWeights(opts.sources);
  const cumulative: number[] = [];
  weights.reduce((acc, w, i) => (cumulative[i] = acc + w), 0);
  const drawSource = (): number => {
    const x = r();
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // The account followed its sources 60 days ago. What each source already had then (two years of posts) arrives in the
  // first walk as back catalogue and is not New; once a walk that began after the follow has ended, the sources are
  // settled and what comes later arrives as New. The sync's own rules decide which is which.
  const end = Date.now();
  const start = end - 2 * 365 * 86_400_000;
  const followed = end - FOLLOWED_DAYS_AGO * 86_400_000;
  const arrivals = Math.max(1, Math.round(opts.items * ARRIVAL_SHARE));
  const backCatalogue = opts.items - arrivals;
  let counter = 0;
  const entryFor = (sourceIndex: number, published: number, crawled: number): SyncEntry => {
    counter++;
    const lang = languageFor(r);
    const podcast = kinds[sourceIndex] === "podcast";
    return {
      externalId: `tag:google.com,2005:reader/item/${(index * 1e12 + counter).toString(16).padStart(16, "0")}`,
      streamId: streams[sourceIndex]!,
      originalGuid: null,
      url: `https://${tag}-${sourceIndex + 1}.example.org/post/${counter}`,
      title: sentence(r, lang, 4 + Math.floor(r() * 6)),
      author: r() < 0.7 ? `Writer ${1 + Math.floor(r() * 40)}` : null,
      publishedAt: r() < 0.97 ? new Date(published).toISOString() : null,
      crawledAt: new Date(crawled).toISOString(),
      summaryHtml: null,
      contentHtml: bodyHtml(r, lang),
      imageUrl: r() < 0.4 ? `https://${tag}-${sourceIndex + 1}.example.org/img/${counter}.jpg` : null,
      enclosures: podcast ? [{ url: `https://${tag}-${sourceIndex + 1}.example.org/audio/${counter}.mp3`, type: "audio/mpeg", length: 20_000_000 }] : [],
    };
  };
  let batches = 0;
  const deliver = (entries: SyncEntry[], at: number, done: boolean) =>
    applySyncBatch(app, p.engineUserId, {
      leaseId: "dataset", idempotencyKey: `${tag}-walk-${batches++}-${newId("bat")}`, engineIdentity: "dataset-engine", entries,
      checkpoint: { continuation: null, newestCrawlUsec: String(BigInt(at) * 1000n) }, done,
    });
  const walk = (count: number, itemAt: (i: number) => { published: number; crawled: number }, label: string) => {
    for (let from = 0; from < count; from += BATCH_ENTRIES) {
      const entries: SyncEntry[] = [];
      for (let i = from; i < Math.min(count, from + BATCH_ENTRIES); i++) {
        const t = itemAt(i);
        entries.push(entryFor(drawSource(), t.published, t.crawled));
      }
      deliver(entries, entries.length ? Date.parse(entries[entries.length - 1]!.crawledAt) : followed, from + BATCH_ENTRIES >= count);
      if (Math.floor(from / BATCH_ENTRIES) % 100 === 99) log(`${tag}: ${label} ${from + BATCH_ENTRIES} of ${count}`);
    }
  };
  // First walk: the back catalogue, found by the engine when the sources were followed.
  walk(backCatalogue, (i) => ({ published: start + Math.floor((i / backCatalogue) * (followed - start)), crawled: followed + i }), "back catalogue");
  // A walk that begins after the engine confirmed the subscriptions finds nothing new and settles the sources.
  deliver([], followed, true);
  // From then on items arrive as they are published.
  walk(arrivals, (i) => {
    const published = followed + Math.floor((i / arrivals) * (end - followed));
    return { published, crawled: published + 60_000 };
  }, "arrivals");
  const itemIds = app.db.all<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? ORDER BY seq", p.workspaceId).map((row) => row.id);

  // A returning reader: some items are in a workflow state, and some of the new arrivals have been looked at (their New
  // marker cleared). New markers last 30 days by default: older ones have expired, as the product's maintenance pass clears them.
  const states: Array<[WorkflowState, number]> = [["finished", 0.06], ["toread", 0.03], ["inprogress", 0.01], ["ignored", 0.02]];
  for (let from = 0; from < itemIds.length; from += 500) {
    const chunk = itemIds.slice(from, from + 500);
    for (const [workflow, share] of states) {
      const some = chunk.filter(() => r() < share);
      if (some.length) bulk(app, p, some, { type: "workflow", workflow });
    }
  }
  const looked = itemIds.slice(itemIds.length - arrivals).filter(() => r() < 0.4);
  for (let from = 0; from < looked.length; from += 500) bulk(app, p, looked.slice(from, from + 500), { type: "clearFresh" });
  expireFreshMarkers(app, p.workspaceId);
  log(`${tag}: states set`);

  // Kept items (about 1.5%), most of them in "Read later" with a readable-text capture that finished.
  const keepCount = Math.max(1, Math.round(itemIds.length * 0.015));
  for (let k = 0; k < keepCount; k++) {
    const itemId = itemIds[Math.floor(r() * itemIds.length)]!;
    keepItem(app, p, itemId, r() < 0.7 ? readLater.id : reference.id);
  }
  for (const cap of app.db.all<{ id: string; item_id: string }>("SELECT id, item_id FROM captures WHERE workspace_id = ? AND status = 'pending'", p.workspaceId)) {
    if (r() < 0.1) { failCapture(app, cap.id, "The page couldn't be captured."); continue; }
    if (r() < 0.2) continue; // still waiting
    const text = sentence(r, LANGUAGES[0]!.lang, 800 + Math.floor(r() * 3000));
    completeCapture(app, cap.id, { ok: true, title: null, text, html: `<p>${text}</p>`, finalUrl: `https://example.org/${cap.item_id}`, bytes: text.length });
  }
  log(`${tag}: ${keepCount} kept`);

  // Notifications: the oldest 70% have been read.
  const all = listNotifications(app, p, 1_000_000);
  const readIds = all.slice(Math.floor(all.length * 0.3)).map((n) => n.id);
  for (let from = 0; from < readIds.length; from += 500) markNotificationsRead(app, p, readIds.slice(from, from + 500));
  return { principal: p, sourceIds, itemIds };
}

export function buildDataset(opts: DatasetOptions): Dataset {
  const log = opts.log ?? (() => {});
  const full = { accounts: opts.accounts ?? 1, sources: opts.sources ?? 300, items: opts.items ?? 100_000, seed: opts.seed ?? 1 };
  const app = createApp(opts.dir);
  const accounts: DatasetAccount[] = [];
  for (let i = 0; i < full.accounts; i++) accounts.push(buildAccount(app, i, full, log));
  return { app, dir: opts.dir, accounts, close: () => app.db.close() };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, accounts: { type: "string" }, sources: { type: "string" }, items: { type: "string" }, seed: { type: "string" } } });
  const dataRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
  mkdirSync(dataRoot, { recursive: true });
  const dir = values.dir ? path.resolve(values.dir) : mkdtempSync(path.join(dataRoot, "dataset-"));
  const n = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const started = Date.now();
  const data = buildDataset({ dir, accounts: n(values.accounts), sources: n(values.sources), items: n(values.items), seed: n(values.seed), log: (l) => console.error(`[dataset] ${l}`) });
  const count = data.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n;
  data.close();
  console.log(`Built ${data.accounts.length} account(s), ${count} items in ${Math.round((Date.now() - started) / 1000)} s: ${dir}`);
}
