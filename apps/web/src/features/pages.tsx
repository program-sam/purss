import "./features.css";
import { app } from "@purss/copy/app";
import type { WorkspacePage } from "../plugins.ts";
import { AdminPageRoute, DataPageRoute, DiscoverPageRoute, ReviewPageRoute, SharingPageRoute } from "./lazy.tsx";

const t = app.featuresRoot.pages;

/** The pages built on the feature routes. Registered through plugins.ts before the router is created. */
export const featurePages: WorkspacePage[] = [
  { path: "/discover", title: t.discover.title, component: DiscoverPageRoute, hostedOnly: true, nav: { label: t.discover.nav, icon: "compass" } },
  { path: "/sharing", title: t.sharing.title, component: SharingPageRoute, nav: { label: t.sharing.nav, icon: "link" } },
  { path: "/settings/data", title: t.data.title, component: DataPageRoute, nav: { label: t.data.nav, icon: "download" } },
  // Reached from the notice on Home while entries are waiting; no permanent link.
  { path: "/review", title: t.review.title, component: ReviewPageRoute },
  { path: "/admin", title: t.admin.title, component: AdminPageRoute, adminOnly: true, nav: { label: t.admin.nav, icon: "lock" } },
];
