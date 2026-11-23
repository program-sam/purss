import { annotationDeleteSchema, annotationIdSchema, annotationPutSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, badRequest, parse } from "../http.ts";
import { deleteAnnotation, listAnnotations, putAnnotation } from "../services/annotations.ts";
import { server } from "@purss/translations/server";

/** Comfortably above the longest comment plus the longest passage, JSON-encoded. */
const BODY_LIMIT = 96 * 1024;

function annotationId(raw: string): string {
  if (!annotationIdSchema.safeParse(raw).success) throw badRequest(server.api.annotationsRoute.invalidNoteId);
  return raw;
}

/**
 * The person's highlights and notes on an item. Create and change are one idempotent PUT
 * with an id the client chose; removal is an idempotent DELETE. Both carry when the change was made.
 */
export function annotationsRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/items/:id/annotations", (req, ctx) => listAnnotations(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.put("/api/items/:id/annotations/:annotationId", (req, ctx) =>
    putAnnotation(ctx.app, requirePrincipal(ctx), req.params.id!, annotationId(req.params.annotationId!), parse(annotationPutSchema, req.body)), { bodyLimit: BODY_LIMIT });
  r.delete("/api/items/:id/annotations/:annotationId", (req, ctx) =>
    deleteAnnotation(ctx.app, requirePrincipal(ctx), req.params.id!, annotationId(req.params.annotationId!), parse(annotationDeleteSchema, req.body).updatedAt), { bodyLimit: 1024 });
  return r;
}
