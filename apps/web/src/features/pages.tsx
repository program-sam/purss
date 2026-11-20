import "./features.css";
import { app } from "@purss/copy/app";
import type { WorkspacePage } from "../plugins.ts";
import { AdminPageRoute, DataPageRoute, DiscoverPageRoute, ReviewPageRoute, SharingPageRoute } from "./lazy.tsx";


/** The pages built on the feature routes. Registered through plugins.ts before the router is created. */
export const featurePages: WorkspacePage[] = [
  { path: "/discover", title: app.words.discovery, component: DiscoverPageRoute, hostedOnly: true, nav: { label: app.words.discovery, icon: "compass" } },
  { path: "/sharing", title: app.words.sharing, component: SharingPageRoute, nav: { label: app.words.sharing, icon: "link" } },
  { path: "/settings/data", title: app.words.yourData, component: DataPageRoute, nav: { label: app.words.yourData, icon: "download" } },
  // Reached from the notice on Home while entries are waiting; no permanent link.
  { path: "/review", title: app.words.review, component: ReviewPageRoute },
  { path: "/admin", title: app.words.administration, component: AdminPageRoute, adminOnly: true, nav: { label: app.words.administration, icon: "lock" } },
];
