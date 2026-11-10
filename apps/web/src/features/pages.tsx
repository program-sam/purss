import "./features.css";
import type { WorkspacePage } from "../plugins.ts";
import { AdminPageRoute, DataPageRoute, DiscoverPageRoute, ReviewPageRoute, SharingPageRoute } from "./lazy.tsx";

/** The pages built on the feature routes. Registered through plugins.ts before the router is created. */
export const featurePages: WorkspacePage[] = [
  { path: "/discover", title: "Discovery", component: DiscoverPageRoute, hostedOnly: true, nav: { label: "Discovery", icon: "compass" } },
  { path: "/sharing", title: "Sharing", component: SharingPageRoute, nav: { label: "Sharing", icon: "link" } },
  { path: "/settings/data", title: "Your data", component: DataPageRoute, nav: { label: "Your data", icon: "download" } },
  // Reached from the notice on Home while entries are waiting; no permanent link.
  { path: "/review", title: "Review", component: ReviewPageRoute },
  { path: "/admin", title: "Administration", component: AdminPageRoute, adminOnly: true, nav: { label: "Administration", icon: "lock" } },
];
