import { renameSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { Ctx } from "../app.ts";
import { audit, requirePrincipal } from "../app.ts";
import { HttpError, Router, UPLOAD_PACE, badRequest, parse, rateLimit, saveUpload } from "../http.ts";
import { applyImport, checkUploadApart, oneImportAtATime, reconnectSource, stageChecked, streamExport, uploadFile } from "../services/portability.ts";
import { assertStillUsable } from "../services/deletion.ts";
import { assertDiskRoom } from "../services/storage.ts";
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
const IMPORT_LIMIT = 128 * 1024 * 1024;
/** An upload holds one of the few slots: it must be done within 20 minutes (the largest file at about 110 KB/s). */
const IMPORT_UPLOAD_PACE = { ...UPLOAD_PACE, maxMs: 20 * 60_000 };
/** Uploads in progress, one per account and a few at once: each goes to disk first, so only disk holds them. */
const uploading = new Set<string>();
let uploadingBytes = 0;
const MAX_UPLOADS = 4;

/** Account export (works while over quota), import, OPML, and reconnecting a private source. */
export function portabilityRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.get("/api/export", async (_req, ctx, res) => {
    const p = requirePrincipal(ctx);
    // An export reads the whole account on the API's thread (tens of seconds for a large one): a few an hour, whatever the plan.
    rateLimit(`export:${p.accountId}`, 6, 3600_000);
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

  // The file goes to disk as it arrives. Once it's all there it is checked in a child process with a memory limit of its
  // own (checkUploadApart), and checks and imports take turns, so the API's memory and responsiveness stay its own.
  r.post("/api/import/preview", async (req, ctx, res) => {
    const p = requirePrincipal(ctx);
    const gone = new AbortController();
    res.once("close", () => { if (!res.writableFinished) gone.abort(); });
    if (uploading.has(p.accountId)) throw new HttpError(429, "busy", "An export is already being uploaded for your account.");
    // Checking a large export takes the import turn for a while: plenty for real use, not for keeping others waiting.
    rateLimit(`import-check:${p.accountId}`, 20, 86_400_000);
    if (uploading.size >= MAX_UPLOADS) throw new HttpError(429, "busy", "Several exports are being uploaded right now. Please try again in a minute.");
    // Room for the whole file, as announced (or as large as allowed), on top of the uploads already arriving, before
    // any of it is written; it stays set aside until this upload is done.
    const room = Number(req.raw.headers["content-length"]) || IMPORT_LIMIT;
    assertDiskRoom(ctx.app, uploadingBytes + room);
    uploading.add(p.accountId);
    uploadingBytes += room;
    let file: string | null = null;
    try {
      const upload = (file = uploadFile(ctx.app));
      // Other content keeps growing while this arrives: every 8 MB, the rest of it must still fit above the reserve.
      let checkedAt = 0;
      const bytes = await saveUpload(req.raw, upload, IMPORT_LIMIT, IMPORT_UPLOAD_PACE, (size) => {
        if (size - checkedAt < 8 * 1024 * 1024) return;
        checkedAt = size;
        assertDiskRoom(ctx.app, Math.max(0, room - size));
      });
      if (!bytes) throw badRequest("Choose an export file to upload.");
      assertDiskRoom(ctx.app, 0); // all of it written: the disk must still be above its reserve before it's kept
      return await oneImportAtATime(async () => {
        assertStillUsable(ctx.app, p); // it may have waited its turn
        const { check, sha256 } = await checkUploadApart(ctx.app, p, upload, undefined, gone.signal);
        assertStillUsable(ctx.app, p); // the upload and the check can take minutes
        return stageChecked(ctx.app, p, check, { bytes, sha256, place: (dest) => renameSync(upload, dest) });
      });
    } finally {
      uploading.delete(p.accountId);
      uploadingBytes -= room;
      if (file) rmSync(file, { force: true });
    }
  }, { bodyLimit: IMPORT_LIMIT, ownBody: true });
  r.post("/api/import", (req, ctx) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    const p = requirePrincipal(ctx);
    // Applying runs in one transaction on the API's own thread, so a large import holds everything else for its length.
    rateLimit(`import-apply:${p.accountId}`, 5, 86_400_000);
    return oneImportAtATime(() => {
      // Checked when its turn comes, not only when it asked: a session ended or an account deleted meanwhile imports nothing.
      assertStillUsable(ctx.app, p);
      return applyImport(ctx.app, p, token);
    });
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
