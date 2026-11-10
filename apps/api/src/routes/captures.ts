import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router } from "../http.ts";
import { retryCapture } from "../services/captures.ts";
import { readPicture } from "../services/images.ts";

/** Readable copies of single items: trying one again after it failed, and the pictures kept with one. */
export function capturesRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.post("/api/items/:id/capture/retry", (req, ctx) => retryCapture(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.get("/api/items/:id/images/:imageId", (req, ctx, res) => {
    const picture = readPicture(ctx.app, requirePrincipal(ctx), req.params.id!, req.params.imageId!);
    const etag = `"${picture.sha256.slice(0, 32)}"`;
    // Bytes from someone else's site, served from this origin: the type comes from the bytes (never a script-capable one),
    // the browser may not guess another, and nothing the picture holds can run. Private because it is per account.
    const headers = {
      "content-type": picture.contentType, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable", etag,
    };
    if (req.raw.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return undefined; }
    res.writeHead(200, { ...headers, "content-length": picture.data.byteLength });
    res.end(picture.data);
    return undefined;
  });
  return r;
}
