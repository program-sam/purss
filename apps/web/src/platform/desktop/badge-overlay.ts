import { app } from "@purss/translations/app";


/*
 * Windows has no badge count for desktop apps, only an overlay icon on the taskbar button. It is drawn
 * here, with the system's font at the screen's pixel density, and handed to the app as pixels: a disc in the app
 * icon's blue with the number, "99+" above 99.
 */

/** The app icon's blue (apps/desktop/src-tauri/icons, `ic_launcher_background` on Android). */
const BADGE_BLUE = "#1260ba";

/** The overlay's pixels, square, in RGBA; what the `set_badge` command takes. */
export type BadgeOverlay = { size: number; rgba: number[] };

/** What the overlay says: the count, or "99+". */
export function badgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Windows shows the overlay at 16 points: its pixels follow the screen's scale, within what the app accepts. */
export function overlaySize(pixelRatio: number): number {
  return Math.min(64, Math.max(16, Math.round(16 * (pixelRatio || 1))));
}

/** The overlay for `count` (above 0), or null where it can't be drawn. */
export function drawBadgeOverlay(count: number, pixelRatio = window.devicePixelRatio): BadgeOverlay | null {
  const size = overlaySize(pixelRatio);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const label = badgeLabel(count);
  // The app icon's blue, quieter than an alarm red; a thin white edge keeps it apart from the icon underneath.
  const edge = Math.max(1, size / 16);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = BADGE_BLUE;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - edge, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  // One digit fills the disc; more get smaller so they stay inside it.
  const scale = label.length === 1 ? 0.72 : label.length === 2 ? 0.6 : 0.44;
  g.font = `700 ${Math.round(size * scale)}px "Segoe UI", system-ui, sans-serif`;
  g.fillText(label, size / 2, size / 2 + size * 0.04, size * 0.9);
  return { size, rgba: Array.from(g.getImageData(0, 0, size, size).data) };
}

/** Only Windows uses the overlay; elsewhere the app shows the count itself. */
export function wantsOverlay(userAgent = navigator.userAgent): boolean {
  return /\bWindows\b/.test(userAgent);
}
