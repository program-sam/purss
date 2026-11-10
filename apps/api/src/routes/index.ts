import type { Ctx } from "../app.ts";
import type { Router } from "../http.ts";
import { accountEmailRouter } from "./account-email.ts";
import { adminRouter } from "./admin.ts";
import { appBundleRouter } from "./app-bundle.ts";
import { aiFiltersRouter } from "./ai-filters.ts";
import { annotationsRouter } from "./annotations.ts";
import { assistantRouter } from "./assistant.ts";
import { connectRouter } from "./connect.ts";
import { downloadsRouter } from "./downloads.ts";
import { discoverRouter } from "./discover.ts";
import { capturesRouter } from "./captures.ts";
import { homeRouter } from "./home.ts";
import { itemRemindersRouter } from "./item-reminders.ts";
import { playbackRouter } from "./playback.ts";
import { keptLinksRouter } from "./kept-links.ts";
import { portabilityRouter } from "./portability.ts";
import { pushRouter } from "./push.ts";
import { reconcileRouter } from "./reconcile.ts";
import { rediscoveryRouter } from "./rediscovery.ts";
import { publicPagesRouter, sharingRouter } from "./sharing.ts";
import { statisticsRouter } from "./statistics.ts";

/** Feature route modules mounted after the core public router. */
export const extraRouters = {
  api: (): Router<Ctx>[] => [rediscoveryRouter(), portabilityRouter(), sharingRouter(), reconcileRouter(), adminRouter(), statisticsRouter(), assistantRouter(), capturesRouter(), homeRouter(), keptLinksRouter(), connectRouter(), playbackRouter(), annotationsRouter(), accountEmailRouter(), itemRemindersRouter(), discoverRouter(), aiFiltersRouter(), downloadsRouter(), pushRouter(), appBundleRouter()],
  pages: (): Router<Ctx> | undefined => publicPagesRouter(),
};
