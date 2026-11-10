import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FeedItem = {
  guid: string;
  title: string;
  /** HTML body (content:encoded). */
  html: string;
  link?: string;
  pubDate?: Date;
  enclosure?: { url: string; type: string; length: number };
};

export type Feed = { path: string; title: string; items: FeedItem[]; format?: "rss" | "atom" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderRss(feed: Feed, base: string): string {
  const items = feed.items
    .map(
      (i) => `<item>
  <guid isPermaLink="false">${esc(i.guid)}</guid>
  <title>${esc(i.title)}</title>
  <link>${esc(i.link ?? `${base}/post/${encodeURIComponent(i.guid)}`)}</link>
  <pubDate>${(i.pubDate ?? new Date("2026-01-01T00:00:00Z")).toUTCString()}</pubDate>
  <dc:creator>Test Author</dc:creator>
  <content:encoded><![CDATA[${i.html}]]></content:encoded>
  ${i.enclosure ? `<enclosure url="${esc(i.enclosure.url)}" type="${esc(i.enclosure.type)}" length="${i.enclosure.length}"/>` : ""}
</item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>${esc(feed.title)}</title>
  <link>${base}/</link>
  <description>Contract test feed</description>
${items}
</channel>
</rss>
`;
}

/** Local HTTP server that serves controllable RSS feeds and records every request it receives. */
export class FeedServer {
  readonly feeds = new Map<string, Feed>();
  readonly hits: Array<{ path: string; at: number; viaProxy: boolean }> = [];
  #server: Server | null = null;
  port = 0;

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setFeed(feed: Feed): string {
    this.feeds.set(feed.path, feed);
    return `${this.base}${feed.path}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      this.hits.push({ path, at: Date.now(), viaProxy: req.headers["x-purss-test-proxy"] === "1" });
      const feed = this.feeds.get(path);
      if (!feed) {
        res.writeHead(404, { "content-type": "text/plain" });
        return void res.end("not found");
      }
      res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "no-store" });
      res.end(renderRss(feed, this.base));
    });
    await new Promise<void>((r) => this.#server!.listen(0, "127.0.0.1", r));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  }
}
