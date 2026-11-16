import { parseFeedDate } from "@purss/connectors";

/*
 * The streaming feed trimmer (plan/44). Some feeds are tens of megabytes (a podcast that repeats every episode's show notes three
 * times over 3,000 episodes), more than the engine can parse in its memory limit, yet what it keeps of a feed is its newest items
 * (90 days of them, at least 50). The trimmer reads such a feed as a stream to its end, keeps its channel metadata and its newest items exactly as they were written,
 * and hands back a much smaller copy of the same feed. It never holds the document or a parse of it: only the text that has
 * not been classified yet, the head, the item being read and the items kept. Nothing in a feed guarantees the order of its items
 * (a pinned old item first, a newer batch appended after 200 descending ones), so it is never read only part of the way.
 *
 * It works on bytes read as Latin-1 text, so every byte comes back as it arrived whatever the feed's encoding (any ASCII-based
 * one: UTF-8, ISO-8859-x, Windows-125x); UTF-16 is refused. It finds items by the element structure (comments, CDATA, processing
 * instructions and quoted attribute values are skipped, so an `<item>` inside them is not one) and never parses an item's content.
 */

export type TrimLimits = {
  /** Items kept: the newest. */
  maxItems: number;
  /** An item bigger than this is left out whole (never cut inside its markup). */
  maxItemBytes: number;
  /** All kept items together; when the newest are bigger than this, the oldest of them go. */
  maxKeptBytes: number;
  /** Everything before the first item: the channel's metadata. */
  maxHeadBytes: number;
  /** The whole document: it is read to its end, since the newest item can be anywhere in it. */
  maxBytes: number;
};

export const TRIM_LIMITS: TrimLimits = {
  maxItems: 100,
  maxItemBytes: 1024 * 1024,
  maxKeptBytes: 4 * 1024 * 1024,
  maxHeadBytes: 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
};

export type TrimFailure =
  /** Nothing came back. */
  | "empty"
  /** Not an RSS, Atom or RDF document (a page, JSON, text). */
  | "not_feed"
  /** UTF-16 or another encoding whose bytes can't be scanned as ASCII markup. */
  | "unsupported_encoding"
  /** The document ended before its channel did, or its tags can't be followed. */
  | "malformed"
  /** More than `maxBytes` had to be read, or everything in it is bigger than a kept item may be. */
  | "too_large"
  /** The channel's own metadata is longer than `maxHeadBytes`. */
  | "head_too_large";

export type TrimResult =
  | {
      ok: true;
      /** The same feed with only the kept items, newest first, as bytes. */
      body: Buffer;
      kept: number;
      /** Items met in the document. */
      seen: number;
      /** Items left out because each was bigger than `maxItemBytes`. */
      tooBig: number;
      bytesRead: number;
      /** The document's root element was closed (false: the document ended before its channel did, and what came before is what there is). */
      complete: boolean;
      root: "rss" | "rdf" | "feed";
    }
  | { ok: false; reason: TrimFailure; bytesRead: number };

type Kept = { t: number; order: number; raw: string };

const ROOTS = new Set(["rss", "rdf", "feed"]);
const MAX_TAG = 64 * 1024;
/** Open elements outside the items: a real channel is a few deep, and the list must not grow with the document. */
const MAX_DEPTH = 128;
/** The element that dates an item, in the order they are trusted; any namespace prefix (`dc:date`, `a:updated`) is accepted. */
const DATE_TAGS = ["pubDate", "date", "published", "issued", "updated", "modified", "created"].map(
  (tag) => new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]*)`, "i"),
);

const local = (name: string): string => name.slice(name.indexOf(":") + 1).toLowerCase();

/** The index of the `>` that ends the tag starting at `from`, skipping quoted attribute values; -1 when it has not arrived. */
function tagEnd(buf: string, from: number): number {
  let quote = 0;
  for (let j = from + 1; j < buf.length; j++) {
    const c = buf.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return j;
  }
  return -1;
}

/** The end of a `<!…>` declaration such as a DOCTYPE with an internal subset in `[ ]`; -1 when it has not arrived. */
function declarationEnd(buf: string, from: number): number {
  const gt = buf.indexOf(">", from);
  if (gt < 0) return -1;
  const open = buf.indexOf("[", from);
  if (open < 0 || open > gt) return gt + 1;
  const close = buf.indexOf("]", open);
  if (close < 0) return -1;
  const end = buf.indexOf(">", close);
  return end < 0 ? -1 : end + 1;
}

function dateOf(raw: string): number | null {
  for (const re of DATE_TAGS) {
    const m = re.exec(raw);
    if (!m) continue;
    const iso = parseFeedDate(m[1]!.trim());
    if (iso) return Date.parse(iso);
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const escapeAttribute = (value: string, quote: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replaceAll(quote, quote === '"' ? "&quot;" : "&apos;");

/** A decoder for the document's encoding; one the platform doesn't know is read as UTF-8, XML's default. */
function decoderFor(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder("utf-8");
  }
}

/**
 * The document's encoding as XML settles it: a UTF-8 byte order mark, else the charset the answer was sent with, else the XML
 * declaration's, else UTF-8. `prolog` is the text before the root element, read as Latin-1 like the rest.
 */
export function documentCharset(prolog: string, httpCharset?: string | null): string {
  if (prolog.startsWith("\xef\xbb\xbf")) return "utf-8";
  if (httpCharset) return httpCharset;
  const declared = /^(?:\xef\xbb\xbf)?<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(prolog);
  return declared ? declared[1]!.toLowerCase() : "utf-8";
}

/** An attribute value as text (XML's character references and the five named entities); text that is not ASCII is the document's bytes, read in its encoding. */
function attributeText(value: string, charset = "utf-8"): string {
  // Decoded even when every byte is ASCII: some encodings (ISO-2022-JP) write other characters with 7-bit bytes.
  const bytes = decoderFor(charset).decode(Buffer.from(value, "latin1"));
  return bytes.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return XML_ENTITIES[name.toLowerCase()]!;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The root element's start tag with `xml:base` made to carry the address the document was fetched from, so that relative links in
 * the copy resolve where they would in the original: an absent `xml:base` is added, a relative one is resolved against `base`, an
 * absolute one is left as it is. Nothing else in the tag changes.
 */
export function rootWithBase(tag: string, base: string, charset = "utf-8"): string {
  const name = /^<[^\s/>]+/.exec(tag);
  if (!name) return tag;
  let existing: { valueStart: number; valueEnd: number; quote: string; value: string } | null = null;
  let end = name[0].length;
  ATTRIBUTE.lastIndex = end;
  for (let m = ATTRIBUTE.exec(tag); m; m = ATTRIBUTE.exec(tag)) {
    end = ATTRIBUTE.lastIndex;
    if (m[1] === "xml:base") {
      const quote = m[2] !== undefined ? '"' : "'";
      const value = m[2] ?? m[3] ?? "";
      existing = { valueStart: end - 1 - value.length, valueEnd: end - 1, quote, value };
    }
  }
  if (existing) {
    const written = attributeText(existing.value, charset);
    if (URL.canParse(written)) return tag; // already absolute
    let resolved = base;
    try {
      resolved = new URL(written, base).href;
    } catch {
      /* an xml:base that can't be resolved is ignored by the engine too */
    }
    return tag.slice(0, existing.valueStart) + escapeAttribute(resolved, existing.quote) + tag.slice(existing.valueEnd);
  }
  // After the last attribute: whatever follows it (spacing, `>` or `/>`) stays as it was.
  return `${tag.slice(0, end)} xml:base="${escapeAttribute(base, '"')}"${tag.slice(end)}`;
}

export class FeedTrimmer {
  #limits: TrimLimits;
  #buf = "";
  #bytes = 0;
  #failure: TrimFailure | null = null;
  #done = false;
  #phase: "head" | "item" | "after" = "head";
  #special: string | null = null;
  #head: string[] = [];
  #headBytes = 0;
  #stack: string[] = [];
  #root: "rss" | "rdf" | "feed" | null = null;
  #itemLocal = "item";
  #itemDepth = -1;
  #closers = "";
  #rootClosed = false;
  #item = { name: "", parts: [] as string[], bytes: 0, overflow: false, depth: 0 };
  #seen = 0;
  #tooBig = 0;
  #kept: Kept[] = []; // worst (oldest) first
  #keptBytes = 0;
  #prevT: number | null = null;
  #checked = false;
  /** The root element's start tag, as offsets into the head text. */
  #rootTag: { start: number; end: number } | null = null;

  constructor(limits: Partial<TrimLimits> = {}) {
    this.#limits = { ...TRIM_LIMITS, ...limits };
  }

  /** Feed bytes in order. "stop" means nothing more is needed (the document has ended, or it can't be read): the caller may stop reading and call `finish`. */
  write(chunk: Buffer): "stop" | undefined {
    if (this.#done) return "stop";
    this.#bytes += chunk.length;
    if (this.#bytes > this.#limits.maxBytes) {
      this.#fail("too_large");
      return "stop";
    }
    this.#buf += chunk.toString("latin1");
    if (!this.#checked && this.#buf.length >= 4) this.#checkEncoding();
    if (!this.#done) this.#scan(false);
    return this.#done ? "stop" : undefined;
  }

  /**
   * The end of the document: the trimmed feed, or why there is none. `base` is the address the document was fetched from after any
   * redirects: the copy is served from another address, so the root element gets an `xml:base` that keeps the feed's relative
   * links resolving against it (an `xml:base` the root already had is resolved against it).
   */
  finish(base?: string, httpCharset?: string | null): TrimResult {
    if (!this.#done) {
      if (!this.#checked) this.#checkEncoding();
      if (!this.#done) this.#scan(true);
    }
    if (this.#failure) return { ok: false, reason: this.#failure, bytesRead: this.#bytes };
    if (this.#root === null) return { ok: false, reason: this.#bytes === 0 ? "empty" : "not_feed", bytesRead: this.#bytes };
    const head = this.#headText(base, httpCharset);
    if (this.#seen === 0) {
      // A feed with no items is its own head, as long as its channel was closed.
      if (!this.#rootClosed) return { ok: false, reason: "malformed", bytesRead: this.#bytes };
      return { ok: true, body: Buffer.from(head, "latin1"), kept: 0, seen: 0, tooBig: 0, bytesRead: this.#bytes, complete: true, root: this.#root };
    }
    if (this.#kept.length === 0) {
      // Every item was bigger than an item may be: nothing to give. Items that were only empty elements leave an empty feed.
      if (this.#tooBig > 0) return { ok: false, reason: "too_large", bytesRead: this.#bytes };
      return { ok: true, body: Buffer.from(`${head}${this.#closers}\n`, "latin1"), kept: 0, seen: this.#seen, tooBig: 0, bytesRead: this.#bytes, complete: this.#rootClosed, root: this.#root };
    }
    const items = [...this.#kept].sort((a, b) => b.t - a.t || a.order - b.order).map((k) => k.raw);
    const body = Buffer.from(`${head}${items.join("\n")}\n${this.#closers}\n`, "latin1");
    return { ok: true, body, kept: this.#kept.length, seen: this.#seen, tooBig: this.#tooBig, bytesRead: this.#bytes, complete: this.#rootClosed, root: this.#root };
  }

  #headText(base: string | undefined, httpCharset?: string | null): string {
    const head = this.#head.join("");
    if (!base || !this.#rootTag) return head;
    const { start, end } = this.#rootTag;
    return head.slice(0, start) + rootWithBase(head.slice(start, end), base, documentCharset(head.slice(0, start), httpCharset)) + head.slice(end);
  }

  #fail(reason: TrimFailure): void {
    this.#failure = reason;
    this.#done = true;
    this.#buf = "";
  }

  #checkEncoding(): void {
    this.#checked = true;
    const b = this.#buf;
    if (b.startsWith("\xff\xfe") || b.startsWith("\xfe\xff") || b.startsWith("\x00") || b.slice(0, 64).includes("\x00")) this.#fail("unsupported_encoding");
  }

  /** Text that belongs to the document at this point: the head, or the item being read (nothing after the first item is kept). */
  #emit(text: string): void {
    if (this.#phase === "head") {
      this.#head.push(text);
      this.#headBytes += text.length;
      if (this.#headBytes > this.#limits.maxHeadBytes) this.#fail("head_too_large");
    } else if (this.#phase === "item" && !this.#item.overflow) {
      this.#item.parts.push(text);
      this.#item.bytes += text.length;
      if (this.#item.bytes > this.#limits.maxItemBytes) {
        this.#item.overflow = true;
        this.#item.parts = [];
      }
    }
  }

  #scan(final: boolean): void {
    const buf = this.#buf;
    let from = 0; // text before this has been passed on
    let look = 0; // where the next `<` is looked for
    const flush = (to: number): void => {
      if (to > from) this.#emit(buf.slice(from, to));
      if (to > from) from = to;
    };
    const wait = (at: number): void => {
      // The construct at `at` has not fully arrived; keep it for the next chunk (at the end of the document it is just text).
      if (final) {
        flush(buf.length);
        look = buf.length;
      } else {
        flush(at);
        look = at;
      }
    };
    while (!this.#done) {
      if (this.#special !== null) {
        const idx = buf.indexOf(this.#special, look);
        if (idx >= 0) {
          look = idx + this.#special.length;
          this.#special = null;
          continue;
        }
        // The terminator may be split across two chunks: keep its possible start.
        const safe = Math.max(look, buf.length - (this.#special.length - 1));
        flush(final ? buf.length : safe);
        look = final ? buf.length : safe;
        break;
      }
      const lt = buf.indexOf("<", look);
      if (lt < 0) {
        flush(buf.length);
        look = buf.length;
        break;
      }
      const next = buf.charCodeAt(lt + 1);
      if (Number.isNaN(next)) {
        wait(lt);
        break;
      }
      if (next === 33) {
        // `<!`
        if (buf.startsWith("<!--", lt)) {
          this.#special = "-->";
          look = lt + 4;
          continue;
        }
        if (buf.startsWith("<![CDATA[", lt)) {
          this.#special = "]]>";
          look = lt + 9;
          continue;
        }
        const rest = buf.slice(lt, lt + 9);
        if (!final && rest.length < 9 && ("<!--".startsWith(rest) || "<![CDATA[".startsWith(rest))) {
          wait(lt);
          break;
        }
        const end = declarationEnd(buf, lt);
        if (end < 0) {
          if (buf.length - lt > this.#limits.maxHeadBytes) this.#fail("malformed");
          else wait(lt);
          break;
        }
        look = end;
        continue;
      }
      if (next === 63) {
        // `<?`
        this.#special = "?>";
        look = lt + 2;
        continue;
      }
      if (next === 47) {
        // `</name>`
        const gt = buf.indexOf(">", lt + 2);
        if (gt < 0) {
          if (buf.length - lt > MAX_TAG) this.#fail("malformed");
          else wait(lt);
          break;
        }
        const name = /^<\/\s*([^\s>]+)/.exec(buf.slice(lt, Math.min(gt + 1, lt + 300)))?.[1] ?? "";
        look = gt + 1;
        if (this.#phase === "item") {
          if (name === this.#item.name && --this.#item.depth === 0) {
            flush(look);
            this.#finishItem();
            if (this.#done) break;
          }
          continue;
        }
        this.#popTo(name);
        if (this.#stack.length === 0 && this.#root !== null) {
          this.#rootClosed = true;
          flush(look);
          this.#done = true;
        }
        continue;
      }
      const isNameStart = (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95 || next === 58;
      if (!isNameStart) {
        look = lt + 1; // a lone `<` in text
        continue;
      }
      if (this.#phase === "item") {
        // Inside an item only a nested element of the item's own name matters (it would hide the item's end tag).
        const name = this.#item.name;
        const rest = buf.slice(lt + 1, lt + 1 + name.length);
        if (rest !== name) {
          if (!final && rest.length < name.length && name.startsWith(rest)) {
            wait(lt);
            break;
          }
          look = lt + 1;
          continue;
        }
        const after = lt + 1 + name.length;
        if (after >= buf.length) {
          if (final) {
            look = after;
            continue;
          }
          wait(lt);
          break;
        }
        const c = buf.charCodeAt(after);
        if (c !== 62 && c !== 47 && c !== 32 && c !== 9 && c !== 10 && c !== 13) {
          look = lt + 1;
          continue;
        }
        const gt = tagEnd(buf, lt);
        if (gt < 0) {
          if (buf.length - lt > MAX_TAG) this.#fail("malformed");
          else wait(lt);
          break;
        }
        if (buf.charCodeAt(gt - 1) !== 47) this.#item.depth++;
        look = gt + 1;
        continue;
      }
      const gt = tagEnd(buf, lt);
      if (gt < 0) {
        if (buf.length - lt > MAX_TAG) this.#fail("malformed");
        else wait(lt);
        break;
      }
      const m = /^<([^\s/>]+)/.exec(buf.slice(lt, Math.min(gt + 1, lt + 300)));
      const name = m?.[1] ?? "";
      const selfClosing = buf.charCodeAt(gt - 1) === 47;
      if (this.#root === null) {
        const rootName = local(name);
        if (!ROOTS.has(rootName)) {
          this.#fail("not_feed");
          break;
        }
        this.#root = rootName as "rss" | "rdf" | "feed";
        this.#itemLocal = rootName === "feed" ? "entry" : "item";
        // Text before the root tag (the declaration, comments) is still waiting in `buf` from `from`: the head so far is what was passed on.
        const start = this.#headBytes + (lt - from);
        this.#rootTag = { start, end: start + (gt + 1 - lt) };
        if (selfClosing) {
          this.#rootClosed = true;
          this.#done = true;
          flush(gt + 1);
          break;
        }
        this.#stack.push(name);
        look = gt + 1;
        continue;
      }
      const isItem = local(name) === this.#itemLocal && this.#stack.length > 0 && (this.#itemDepth < 0 || this.#stack.length === this.#itemDepth);
      if (isItem) {
        if (this.#phase === "head") {
          this.#itemDepth = this.#stack.length;
          this.#closers = [...this.#stack].reverse().map((n) => `</${n}>`).join("");
        }
        flush(lt); // in the head, the channel's metadata ends where the first item begins
        if (selfClosing) {
          this.#phase = "after";
          this.#seen++; // an empty item: counted, nothing to keep
          look = gt + 1;
          flush(look);
          continue;
        }
        this.#phase = "item";
        this.#item = { name, parts: [], bytes: 0, overflow: false, depth: 1 };
        look = gt + 1; // `from` stays at `lt`: the item's own start tag is the first of its text
        continue;
      }
      if (!selfClosing) this.#stack.push(name);
      if (this.#stack.length > MAX_DEPTH) {
        this.#fail("malformed");
        break;
      }
      look = gt + 1;
    }
    if (!this.#done) {
      if (final) flush(buf.length);
      this.#buf = buf.slice(from);
    } else {
      this.#buf = "";
    }
    if (final && !this.#done && this.#phase === "item") this.#phase = "after"; // the document ended inside an item: it is dropped
  }

  #popTo(name: string): void {
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      if (this.#stack[i] === name) {
        this.#stack.length = i;
        return;
      }
    }
  }

  #finishItem(): void {
    const it = this.#item;
    this.#phase = "after";
    const order = this.#seen++;
    if (it.overflow) {
      this.#tooBig++;
      return;
    }
    const raw = it.parts.join("");
    const dated = dateOf(raw);
    const t = dated ?? this.#prevT ?? 0;
    this.#prevT = t;
    // Binary insertion keeps the list worst-first: older, then later in the document.
    const entry: Kept = { t, order, raw };
    let lo = 0;
    let hi = this.#kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const k = this.#kept[mid]!;
      const worse = k.t < t || (k.t === t && k.order > order);
      if (worse) lo = mid + 1;
      else hi = mid;
    }
    this.#kept.splice(lo, 0, entry);
    this.#keptBytes += raw.length;
    while (this.#kept.length > this.#limits.maxItems || this.#keptBytes > this.#limits.maxKeptBytes) {
      const worst = this.#kept.shift()!;
      this.#keptBytes -= worst.raw.length;
    }
  }
}

/** Trims a whole document held in memory, for tests and tools: the same as feeding it in chunks of `chunkSize`. */
export function trimDocument(doc: Buffer | string, limits: Partial<TrimLimits> = {}, chunkSize = 16 * 1024, base?: string): TrimResult {
  const data = typeof doc === "string" ? Buffer.from(doc, "latin1") : doc;
  const t = new FeedTrimmer(limits);
  for (let at = 0; at < data.length; at += chunkSize) {
    if (t.write(data.subarray(at, at + chunkSize)) === "stop") break;
  }
  return t.finish(base);
}
