import type { ServerResponse } from "node:http";
import type { Ctx } from "../app.ts";
import { audit, requirePrincipal } from "../app.ts";
import { Router } from "../http.ts";
import { keptLinksChunks } from "../services/kept-links-export.ts";

/** Write a chunk, waiting for the socket to drain; rejects if the client went away. */
function write(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.reject(new Error("client closed"));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = () => { res.off("drain", onDrain); res.off("close", onClose); };
    const onDrain = () => { done(); resolve(); };
    const onClose = () => { done(); reject(new Error("client closed")); };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/** A readable list of the links the person kept (for reading and printing), next to the full export. */
export function keptLinksRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/export/kept-links", async (req, ctx, res) => {
    const p = requirePrincipal(ctx);
    const format = req.query.get("format") === "md" ? "md" : "html";
    res.writeHead(200, {
      "content-type": format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="kept-links-${new Date().toISOString().slice(0, 10)}.${format === "md" ? "md" : "html"}"`,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    try {
      for (const chunk of keptLinksChunks(ctx.app, p, format)) await write(res, chunk);
      res.end();
      audit(ctx.app, p.accountId, "export_kept_links", null, "success");
    } catch {
      res.destroy(); // a cut-off list must not look finished
    }
    return undefined;
  });
  return r;
}
