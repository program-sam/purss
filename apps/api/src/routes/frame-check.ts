import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, badRequest } from "../http.ts";
import { frameCheck } from "../services/frame-check.ts";
import { server } from "@purss/translations/server";

/** Whether the reader can show a page from another site in a frame. */
export function frameCheckRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/frame-check", (req, ctx) => {
    const url = req.query.get("url");
    if (!url || url.length > 2048) throw badRequest(server.api.frameCheckRoute.webAddressNeeded);
    return frameCheck(ctx.app, requirePrincipal(ctx), url);
  });
  return r;
}
