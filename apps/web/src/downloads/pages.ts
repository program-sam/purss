import { platform } from "../platform/index.ts";
import { workspacePages } from "../plugins.ts";
import { DownloadsPage } from "./DownloadsPage.tsx";
import { app } from "@purss/copy/app";

const t = app.downloads.pages;

/** Pages that depend on the device: the apps get "Downloaded". Called once, before the router is built. */
export function registerDevicePages(): void {
  if (platform.downloads) workspacePages.push({ path: "/downloads", title: t.title, component: DownloadsPage, nav: { label: t.navLabel, icon: "download" } });
}
