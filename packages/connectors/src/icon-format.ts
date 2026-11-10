/** Image format checks without any decoder, so the API can verify stored icons cheaply. */

/** Largest file the API accepts and stores for one icon. */
export const MAX_ICON_BYTES = 64 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "avif" | "ico";

export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 4))) return "avif";
  if (b.length >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | (b[5]! << 8)) > 0) return "ico";
  return null;
}

/** True when stored bytes really are a WebP image. The API checks this before storing an icon. */
export function isStoredIcon(b: Uint8Array): boolean {
  return b.length <= MAX_ICON_BYTES && sniffImage(b) === "webp";
}

export function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}
