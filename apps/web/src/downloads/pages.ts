import { platform } from "../platform/index.ts";
import { workspacePages } from "../plugins.ts";
import { DownloadsPage } from "./DownloadsPage.tsx";

/** Pages that depend on the device: the apps get "Downloaded". Called once, before the router is built. */
export function registerDevicePages(): void {
  if (platform.downloads) workspacePages.push({ path: "/downloads", title: "Downloaded", component: DownloadsPage, nav: { label: "Downloaded", icon: "download" } });
}
