import { platform } from "../platform/index.ts";
import { purssPages } from "../plugins.ts";
import { DownloadsPage } from "./DownloadsPage.tsx";
import { app } from "@purss/translations/app";


/** Pages that depend on the device: the apps get "Downloaded". Called once, before the router is built. */
export function registerDevicePages(): void {
  if (platform.downloads) purssPages.push({ path: "/downloads", title: app.words.downloaded, component: DownloadsPage, nav: { label: app.words.downloaded, icon: "download" } });
}
