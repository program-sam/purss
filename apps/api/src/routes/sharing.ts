import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { REPORT_REASONS, REPORT_REASON_LABELS, shareNoteSchema, shareSettingsSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, badRequest, clientAddress, parse } from "../http.ts";
import {
  findPublished, followUrl, limitPublicRead, listShares, pauseShare, previewShare, publishShare, renderAtom, renderPage, reportShare, saveShare,
  setShareNote, shareFor, shareItems, stopSharing,
} from "../services/shares.ts";
import type { PublicShare, ReportInput } from "../services/shares.ts";
import { followTarget, pageShell, renderFollowError, renderFollowPage } from "../services/public-pages.ts";
import { escapeHtml, httpUrlOrNull } from "../services/text-safety.ts";
import { publishedPost, renderNewsAtom, renderNewsPage, renderNewsPostPage } from "../services/news.ts";
import { server } from "@purss/copy/server";

const targetKind = z.enum(["basket", "collection"]);

/** Sharing a basket or collection, for its owner (signed in). */
export function sharingRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/shares", (_req, ctx) => listShares(ctx.app, requirePrincipal(ctx)));
  r.get("/api/shares/for/:kind/:id", (req, ctx) => shareFor(ctx.app, requirePrincipal(ctx), parse(targetKind, req.params.kind), req.params.id!));
  r.put("/api/shares/for/:kind/:id", (req, ctx) => saveShare(ctx.app, requirePrincipal(ctx), parse(targetKind, req.params.kind), req.params.id!, parse(shareSettingsSchema, req.body)));
  r.get("/api/shares/:id/preview", (req, ctx) => previewShare(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.post("/api/shares/:id/publish", (req, ctx) => {
    const { confirmToken } = parse(z.object({ confirmToken: z.string().min(1).max(200) }), req.body);
    return publishShare(ctx.app, requirePrincipal(ctx), req.params.id!, confirmToken);
  });
  r.post("/api/shares/:id/pause", (req, ctx) => pauseShare(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.delete("/api/shares/:id", (req, ctx) => stopSharing(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.get("/api/shares/:id/items", (req, ctx) => shareItems(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.put("/api/shares/:id/items/:itemId/note", (req, ctx) => {
    const { note } = parse(shareNoteSchema, req.body);
    return setShareNote(ctx.app, requirePrincipal(ctx), req.params.id!, req.params.itemId!, note);
  });
  // The Follow button maker (Settings → Connected apps) asks here, so it accepts exactly what the follow page does.
  r.get("/api/follow-link", (req, ctx) => {
    requirePrincipal(ctx);
    const raw = (req.query.get("url") ?? "").trim();
    const feed = followTarget(raw);
    if (feed) return { followUrl: followUrl(ctx.app, feed) };
    throw httpUrlOrNull(raw)
      ? badRequest(server.api.sharingRoute.privateFeedLink, "private_link")
      : badRequest(server.api.sharingRoute.enterFeedAddress, "not_a_link");
  });
  return r;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** The report form posts to itself; nothing else on these pages submits anything. */
const FORM_CSP = PAGE_CSP.replace("form-action 'none'", "form-action 'self'");
const NOT_FOUND_PAGE = server.api.sharingRoute.notFoundPage;

function notFoundPage(res: ServerResponse, kind: "html" | "feed"): void {
  const body = kind === "html" ? NOT_FOUND_PAGE : server.api.shared.notFound;
  res.writeHead(404, {
    "content-type": kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "content-security-policy": PAGE_CSP,
  });
  res.end(body);
}

/** A cacheable public response. Unless the curator let search engines list the page, the header asks them not to. */
function send(res: ServerResponse, ifNoneMatch: string | undefined, body: string, type: string, indexable = false): void {
  const etag = `W/"${createHash("sha256").update(body).digest("hex").slice(0, 24)}"`;
  const headers: Record<string, string> = { "content-type": type, "cache-control": "public, max-age=60", etag, "content-security-policy": PAGE_CSP };
  if (!indexable) headers["x-robots-tag"] = "noindex, nofollow";
  if (ifNoneMatch === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** An uncached page (forms and their answers, follow pages). */
function sendPage(res: ServerResponse, status: number, body: string, csp = PAGE_CSP): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "content-security-policy": csp,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function reportForm(pub: PublicShare, input: ReportInput, error: string | null): string {
  const action = `/p/${pub.slug}/report`;
  const reasons = REPORT_REASONS.map((r) => `<label class="opt"><input type="radio" name="reason" value="${r}" required${input.reason === r ? " checked" : ""}> ${escapeHtml(REPORT_REASON_LABELS[r])}</label>`).join("\n");
  return pageShell({
    title: server.api.sharingRoute.reportTitle(pub.title),
    indexable: false,
    body: server.api.sharingRoute.reportFormBody(escapeHtml(pub.title), escapeHtml(pub.curatorName), error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : "", escapeHtml(action), reasons, escapeHtml(input.details), escapeHtml(input.contact), escapeHtml(pub.slug)),
  });
}

function reportThanks(pub: PublicShare): string {
  return pageShell({
    title: server.api.sharingRoute.reportSent,
    indexable: false,
    body: server.api.sharingRoute.reportThanksBody(escapeHtml(pub.title), escapeHtml(pub.slug)),
  });
}

function readForm(body: unknown): ReportInput {
  const f = new URLSearchParams(typeof body === "string" ? body.slice(0, 20_000) : "");
  return { reason: f.get("reason") ?? "", details: f.get("details") ?? "", contact: f.get("contact") ?? "" };
}

/** Public shared pages, their feeds and report forms, and the follow page. Anonymous and rate-limited; they serve only published projections. */
export function publicPagesRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  for (const method of ["GET", "HEAD"]) {
    r.on(method, "/p/:slug", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      const pub = findPublished(ctx.app, req.params.slug!);
      if (!pub) { notFoundPage(res, "html"); return undefined; }
      send(res, req.raw.headers["if-none-match"], renderPage(ctx.app, pub, pub.items), "text/html; charset=utf-8", pub.listed);
      return undefined;
    });
    r.on(method, "/p/:slug/feed.atom", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      const pub = findPublished(ctx.app, req.params.slug!);
      if (!pub) { notFoundPage(res, "feed"); return undefined; }
      send(res, req.raw.headers["if-none-match"], renderAtom(ctx.app, pub, pub.items), "application/atom+xml; charset=utf-8");
      return undefined;
    });
    // The installation's news (services/news.ts): a page, one page per post, and the Atom feed every PURSS's news source mirrors.
    r.on(method, "/news", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      send(res, req.raw.headers["if-none-match"], renderNewsPage(ctx.app), "text/html; charset=utf-8", true);
      return undefined;
    });
    r.on(method, "/news/feed.atom", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      send(res, req.raw.headers["if-none-match"], renderNewsAtom(ctx.app), "application/atom+xml; charset=utf-8", true);
      return undefined;
    });
    r.on(method, "/news/:id", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      const post = publishedPost(ctx.app, req.params.id!);
      if (!post) { notFoundPage(res, "html"); return undefined; }
      send(res, req.raw.headers["if-none-match"], renderNewsPostPage(ctx.app, post), "text/html; charset=utf-8", true);
      return undefined;
    });
    r.on(method, "/p/:slug/report", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      const pub = findPublished(ctx.app, req.params.slug!);
      if (!pub) { notFoundPage(res, "html"); return undefined; }
      sendPage(res, 200, reportForm(pub, { reason: "", details: "", contact: "" }, null), FORM_CSP);
      return undefined;
    });
    r.on(method, "/follow", (req, ctx, res) => {
      limitPublicRead(clientAddress(req.raw, ctx.app.config.trustProxy));
      const feed = followTarget(req.query.get("url"));
      // One of this installation's own shared pages is named as such; anything else by its host.
      const own = feed?.match(/^(.*)\/p\/([a-z0-9-]{3,80})\/feed\.atom$/);
      const pub = own && own[1] === ctx.app.config.publicOrigin ? findPublished(ctx.app, own[2]!) : null;
      sendPage(res, feed ? 200 : 400, feed ? renderFollowPage(ctx.app, feed, pub && { name: pub.title, by: pub.curatorName, atom: true }) : renderFollowError());
      return undefined;
    });
  }
  r.post("/p/:slug/report", (req, ctx, res) => {
    const address = clientAddress(req.raw, ctx.app.config.trustProxy);
    limitPublicRead(address);
    const pub = findPublished(ctx.app, req.params.slug!);
    if (!pub) { notFoundPage(res, "html"); return undefined; }
    // Only this site's own form may send a report: another site can't spend a visitor's report allowance or fill a page's reports.
    const site = req.raw.headers["sec-fetch-site"];
    const origin = req.raw.headers.origin;
    if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== ctx.app.config.publicOrigin)) {
      sendPage(res, 403, reportForm(pub, { reason: "", details: "", contact: "" }, server.api.sharingRoute.sendFromThisPage), FORM_CSP);
      return undefined;
    }
    const input = readForm(req.body);
    const out = reportShare(ctx.app, pub, input, address);
    if (out.ok) sendPage(res, 200, reportThanks(pub));
    else sendPage(res, out.status, reportForm(pub, input, out.error), FORM_CSP);
    return undefined;
  });
  return r;
}
