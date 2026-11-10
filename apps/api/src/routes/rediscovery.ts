import { reminderActionSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { listReminders, reminderAction } from "../services/reminders.ts";

/** Anniversary reminders ("On this day") over kept items. */
export function rediscoveryRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/reminders", (_req, ctx) => listReminders(ctx.app, requirePrincipal(ctx)));
  r.post("/api/reminders/:id", (req, ctx) => {
    const { action } = parse(reminderActionSchema, req.body);
    return reminderAction(ctx.app, requirePrincipal(ctx), req.params.id!, action);
  });
  return r;
}
