import type { ReactNode } from "react";
import type { IconName } from "@purss/ui";
import { featurePages } from "./features/pages.tsx";

/**
 * Registration point for pages that live inside the PURSS shell but are built separately:
 * data export and import (/settings/data), sharing (/sharing),
 * engine review (/review) and administration (/admin), listed in features/pages.tsx. A page appears
 * here only when it is real, so the UI never links to a route that renders nothing.
 *
 * To add a page, import its component and push an entry below (or append from that page's module
 * before the router is created). The shell supplies the header, sidebar, item panel and popups;
 * the page supplies the content of `<main>`.
 *
 * - `path`      absolute path, e.g. "/sharing"
 * - `title`     breadcrumb and document title
 * - `parent`    optional breadcrumb parent: { label, to }
 * - `nav`       optional entry in the sidebar footer; omit for pages reached from elsewhere
 * - `adminOnly` hides the page and its nav entry from people who are not administrators
 * - `hostedOnly` hides the nav entry on a self-hosted installation (the page itself must say it isn't available there)
 */
export type WorkspacePage = {
  path: string;
  title: string;
  component: () => ReactNode;
  parent?: { label: string; to: string };
  nav?: { label: string; icon: IconName };
  adminOnly?: boolean;
  hostedOnly?: boolean;
};

export const workspacePages: WorkspacePage[] = [...featurePages];

export function pageFor(path: string): WorkspacePage | undefined {
  return workspacePages.find((p) => p.path === path);
}

export function hasPage(path: string): boolean {
  return pageFor(path) !== undefined;
}
