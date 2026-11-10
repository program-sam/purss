import { playbackSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { savePlayback } from "../services/media.ts";

/** Where playback of an item stopped, kept per account so any device can resume (plan/25). */
export function playbackRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.put("/api/items/:id/playback", (req, ctx) => savePlayback(ctx.app, requirePrincipal(ctx), req.params.id!, parse(playbackSchema, req.body)));
  return r;
}
