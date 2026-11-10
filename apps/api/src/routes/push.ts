import { pushRegisterSchema } from "@purss/domain";
import type { PushInfo, PushPending, PushRegisterResult } from "@purss/domain";
import type { Ctx } from "../app.ts";
import { requirePrincipal } from "../app.ts";
import { HttpError, Router, clientAddress, parse, rateLimit } from "../http.ts";
import { pushInfo, registerPushDevice, takePending, unregisterPushDevice } from "../services/push.ts";

/*
 * Phone notifications (plan/37). The phone app, with its device token: GET /api/push (is this PURSS
 * sending, through which relay, is this phone registered), POST /api/push/device (register its relay
 * handle; returns the fetch credential) and DELETE /api/push/device. The phone's notification code, with
 * that fetch credential only (no device token, no cookies; connect/gate.ts lets it through as an open
 * endpoint): POST /api/push/pending.
 */
export function pushRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.get("/api/push", (_req, ctx): PushInfo => pushInfo(ctx.app, requirePrincipal(ctx)));

  r.post("/api/push/device", (req, ctx): PushRegisterResult => {
    const p = requirePrincipal(ctx);
    rateLimit(`push-register:${p.accountId}`, 30);
    const body = parse(pushRegisterSchema, req.body);
    return registerPushDevice(ctx.app, p, body.relay, body.handle);
  });

  r.delete("/api/push/device", (_req, ctx) => unregisterPushDevice(ctx.app, requirePrincipal(ctx)));

  r.post("/api/push/pending", (req, ctx): PushPending => {
    rateLimit(`push-pending:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 240);
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.raw.headers.authorization ?? ""));
    const out = m ? takePending(ctx.app, m[1]!) : null;
    if (!out) throw new HttpError(401, "push_signed_out", "This phone isn't registered for notifications any more.");
    return out;
  });

  return r;
}
