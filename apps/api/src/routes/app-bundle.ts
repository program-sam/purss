import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseOffer } from "@purss/domain/app-bundle";
import type { AppBundleOffer } from "@purss/domain/app-bundle";
import type { App, Ctx } from "../app.ts";
import { HttpError, Router } from "../http.ts";

/*
 * Live updates of the phone apps' interface (plan/39): the build of the interface this PURSS runs,
 * packed for the apps by the server image (apps/mobile/scripts/app-bundle.ts) into Config.appBundleDir.
 * GET /api/app/bundle describes it (an open endpoint: apps ask before they are connected too, see
 * connect/gate.ts) and GET /api/app/bundle/<file> is the zip, which the phone's updater downloads itself.
 * Without a packed build both answer 404 and the apps keep the interface they have.
 */

const NONE = () => new HttpError(404, "no_app_bundle", "This PURSS offers no update of the app's interface.");

/** The packed build's manifest, or null when there is none (or it is unreadable). */
export function readAppBundle(app: App): (AppBundleOffer & { file: string }) | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path.join(app.config.appBundleDir, "manifest.json"), "utf8")); } catch { return null; }
  const file = (raw as { file?: unknown } | null)?.file;
  if (typeof file !== "string") return null;
  const offer = parseOffer({ ...(raw as object), path: `/api/app/bundle/${file}` });
  return offer ? { ...offer, file } : null;
}

export function appBundleRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.get("/api/app/bundle", (_req, ctx, res): AppBundleOffer => {
    const bundle = readAppBundle(ctx.app);
    if (!bundle) throw NONE();
    const { file: _file, ...offer } = bundle;
    res.setHeader("cache-control", "no-cache");
    return offer;
  });

  r.get("/api/app/bundle/:file", (req, ctx, res) => {
    const bundle = readAppBundle(ctx.app);
    // Only the build on offer, by its exact name: nothing else in the folder is served.
    if (!bundle || req.params.file !== bundle.file) throw NONE();
    const file = path.join(ctx.app.config.appBundleDir, bundle.file);
    let size: number;
    try { size = statSync(file).size; } catch { throw NONE(); }
    res.writeHead(200, { "content-type": "application/zip", "content-length": size, "cache-control": "public, max-age=31536000, immutable" });
    createReadStream(file).pipe(res);
    return undefined;
  });

  return r;
}
