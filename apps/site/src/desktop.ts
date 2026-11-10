/**
 * The download button (plan/42): the visitor's system, read from the browser's user agent, points the button at that
 * system's file (kit.ts, getDesktop) and shows the link to the other systems. Android phones and tablets get the
 * Android app; iPhones, iPads (an iPad says "Macintosh" but has a touch screen), Chromebooks and anything unrecognised
 * keep the button on the release page. Linux gets the AppImage, which runs on any distribution and updates itself.
 */
export type DesktopOs = "windows" | "macos" | "linux" | "android";

export function desktopOs(userAgent: string, touchPoints = 0): DesktopOs | null {
  if (/CrOS/i.test(userAgent)) return null;
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return null;
  if (/Windows NT/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return touchPoints > 1 ? null : "macos";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return null;
}

const NAMES: Record<DesktopOs, string> = { windows: "Download for Windows", macos: "Download for Mac", linux: "Download for Linux", android: "Download for Android" };

export function pickDesktopDownload(doc: Pick<Document, "querySelector">, nav: { userAgent: string; maxTouchPoints?: number }): void {
  const main = doc.querySelector<HTMLAnchorElement>("[data-desktop-main]");
  const other = doc.querySelector<HTMLAnchorElement>("[data-desktop-other]");
  const os = desktopOs(nav.userAgent, nav.maxTouchPoints ?? 0);
  const file = os ? main?.dataset[os] : undefined;
  if (!main || !os || !file) return;
  main.href = file;
  main.textContent = NAMES[os];
  if (other) other.hidden = false;
}
