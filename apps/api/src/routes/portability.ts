import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { Ctx } from "../app.ts";
import { audit, requirePrincipal } from "../app.ts";
import { HttpError, Router, badRequest, parse } from "../http.ts";
import { applyImport, reconnectSource, stageImport, streamExport } from "../services/portability.ts";
import { generateOpml, previewOpml } from "../services/opml.ts";
import { dismissOpmlImport, getOpmlImport, listOpmlImports, runOpmlImports, startOpmlImport, stopOpmlImport } from "../services/opml-import.ts";

/** The feeds chosen from an OPML preview. The server decides what is private from the address, not from what the browser says. */
const opmlImportSchema = z.object({
  fileName: z.string().trim().max(200).default("list.opml"),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("folders") }),
    z.object({ kind: z.literal("collection"), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(80) }),
  ]),
  feeds: z.array(z.object({
    title: z.string().max(300),
    feedUrl: z.string().trim().min(1).max(2000),
    siteUrl: z.string().max(2000).nullable().default(null),
    folder: z.string().max(200).nullable().default(null),
  })).min(1).max(5000),
});

/** Write a chunk, waiting for the socket to drain; rejects if the client went away. */
function sink(res: ServerResponse): (chunk: string) => Promise<void> {
  return (chunk) => new Promise<void>((resolve, reject) => {
    if (res.destroyed || res.writableEnded) { reject(new Error("client closed")); return; }
    if (res.write(chunk)) { resolve(); return; }
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("client closed")); };
    const cleanup = () => { res.off("drain", onDrain); res.off("close", onClose); };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/** The body of an upload: already-parsed JSON, or text that is JSON. */
function uploadedJson(body: unknown): unknown {
  if (body === undefined) throw badRequest("Choose an export file to upload.");
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); } catch { throw badRequest("That file isn't a PURSS export (it isn't valid JSON).", "not_archive"); }
}

/** Account export (works while over quota), import, OPML, and reconnecting a private source. */
export function portabilityRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.get("/api/export", async (_req, ctx, res) => {
    const p = requirePrincipal(ctx);
    // Fail before any bytes are sent when an export is already running.
    let started = false;
    const write = sink(res);
    try {
      await streamExport(ctx.app, p, async (chunk) => {
        if (!started) {
          started = true;
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="purss-export-${new Date().toISOString().slice(0, 10)}.json"`,
            "cache-control": "no-store",
          });
        }
        await write(chunk);
      });
      res.end();
      audit(ctx.app, p.accountId, "export", null, "success");
    } catch (err) {
      audit(ctx.app, p.accountId, "export", null, "failure", err instanceof HttpError ? err.code : "error");
      if (!started) throw err;
      // Part of the file is already out: cut the connection so the download fails instead of looking finished.
      console.error("[api] export failed midway:", err instanceof Error ? err.message : "unknown error");
      res.destroy();
    }
    return undefined;
  });

  r.post("/api/import/preview", (req, ctx) => stageImport(ctx.app, requirePrincipal(ctx), uploadedJson(req.body)), { bodyLimit: 128 * 1024 * 1024 });
  r.post("/api/import", (req, ctx) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    return applyImport(ctx.app, requirePrincipal(ctx), token);
  });

  r.get("/api/opml", (_req, ctx, res) => {
    const { xml, leftOut } = generateOpml(ctx.app, requirePrincipal(ctx));
    res.writeHead(200, {
      "content-type": "text/x-opml; charset=utf-8",
      "content-disposition": `attachment; filename="followed-sources-${new Date().toISOString().slice(0, 10)}.opml"`,
      "cache-control": "no-store",
      "x-purss-left-out": String(leftOut),
    });
    res.end(xml);
    return undefined;
  });
  r.post("/api/opml/preview", (req, ctx) => {
    const body = req.body;
    const text = typeof body === "string" ? body : body && typeof body === "object" && typeof (body as { opml?: unknown }).opml === "string" ? (body as { opml: string }).opml : null;
    if (text === null) throw badRequest("Choose an OPML file to upload.");
    return previewOpml(ctx.app, requirePrincipal(ctx), text);
  });

  /**
   * Follow the feeds chosen from an OPML preview on the server, one after the other. The list goes on when the tab is
   * closed; GET shows the progress, DELETE forgets a finished list.
   */
  r.post("/api/opml/imports", (req, ctx) => {
    const started = startOpmlImport(ctx.app, requirePrincipal(ctx), parse(opmlImportSchema, req.body));
    void runOpmlImports(ctx.app); // at once; the maintenance tick picks it up again after a restart
    return started;
  });
  r.get("/api/opml/imports", (_req, ctx) => listOpmlImports(ctx.app, requirePrincipal(ctx)));
  r.get("/api/opml/imports/:id", (req, ctx) => getOpmlImport(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.post("/api/opml/imports/:id/stop", (req, ctx) => stopOpmlImport(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.delete("/api/opml/imports/:id", (req, ctx) => {
    dismissOpmlImport(ctx.app, requirePrincipal(ctx), req.params.id!);
    return { ok: true };
  });

  r.post("/api/sources/:id/reconnect", (req, ctx) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    return reconnectSource(ctx.app, requirePrincipal(ctx), req.params.id!, token);
  });
  return r;
}
