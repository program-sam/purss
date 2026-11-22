import "./features.css";
import { app } from "@purss/copy/app";
import type { WorkspacePage } from "../plugins.ts";
import { CATALOG_CATEGORIES } from "@purss/domain";
import type { SessionInfo } from "@purss/domain";
import { AdminPageRoute, DataPageRoute, DiscoverPageRoute, ReviewPageRoute, SharingPageRoute, discoverCategoryRoute } from "./lazy.tsx";


/** Discovery has its readers-like-you suggestions on a hosted installation and popular sources wherever there is a catalog. */
const discoveryAvailable = (i: SessionInfo["installation"]) => i.mode === "hosted" || i.catalog;

/** The pages built on the feature routes. Registered through plugins.ts before the router is created. */
export const featurePages: WorkspacePage[] = [
  { path: "/discover", title: app.words.discovery, component: DiscoverPageRoute, available: discoveryAvailable, nav: { label: app.words.discovery, icon: "compass" } },
  // Each category of Discovery's popular sources, reached from its box.
  ...CATALOG_CATEGORIES.map((id) => ({
    path: `/discover/${id}`, title: app.discover.discoverPage.categories[id], component: discoverCategoryRoute(id), available: (i: SessionInfo["installation"]) => i.catalog,
    parent: { label: app.words.discovery, to: "/discover" },
  })),
  { path: "/sharing", title: app.words.sharing, component: SharingPageRoute, nav: { label: app.words.sharing, icon: "link" } },
  { path: "/settings/data", title: app.words.yourData, component: DataPageRoute, nav: { label: app.words.yourData, icon: "download" } },
  // Reached from the notice on Home while entries are waiting; no permanent link.
  { path: "/review", title: app.words.review, component: ReviewPageRoute },
  { path: "/admin", title: app.words.administration, component: AdminPageRoute, adminOnly: true, nav: { label: app.words.administration, icon: "lock" } },
];
