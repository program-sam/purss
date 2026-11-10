import { itemReminderSchema } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { Router, parse } from "../http.ts";
import { comingUp, getItemReminder, removeItemReminder, setItemReminder } from "../services/item-reminders.ts";

/** "Remind me" on a kept item, and the next days' reminders for Home's "Coming up". */
export function itemRemindersRouter(): Router<Ctx> {
  const r = new Router<Ctx>();
  r.get("/api/item-reminders", (_req, ctx) => comingUp(ctx.app, requirePrincipal(ctx)));
  r.get("/api/items/:id/reminder", (req, ctx) => ({ reminder: getItemReminder(ctx.app, requirePrincipal(ctx), req.params.id!) }));
  r.put("/api/items/:id/reminder", (req, ctx) => ({ reminder: setItemReminder(ctx.app, requirePrincipal(ctx), req.params.id!, parse(itemReminderSchema, req.body)) }));
  r.delete("/api/items/:id/reminder", (req, ctx) => removeItemReminder(ctx.app, requirePrincipal(ctx), req.params.id!));
  return r;
}
