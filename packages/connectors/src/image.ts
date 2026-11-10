import sharp from "sharp";
import { ascii, MAX_ICON_BYTES, sniffImage } from "./icon-format.ts";

/**
 * Turns untrusted icon bytes into a small, freshly encoded square WebP. PNG, JPEG, GIF, WebP,
 * AVIF and ICO are decoded (libvips through sharp, which shrinks large JPEGs while decoding,
 * so 3000 px podcast artwork stays cheap), fitted into a square, scaled down and re-encoded:
 * nothing of the original file survives except its pixels. SVG and anything else is refused.
 */

export const ICON_SIZE = 128;
const MAX_PIXELS = 16_000_000;
const MIN_SIDE = 16;
/** Wider or taller than this is a banner or a photo, not an icon. */
const MAX_ASPECT = 1.3;

// One image at a time on one thread, nothing cached: the worker runs with little memory.
sharp.cache(false);
sharp.concurrency(1);

export type IconImage = { mime: "image/webp"; data: Buffer; width: number; height: number };
export type IconRejection = "format" | "corrupt" | "toolarge" | "small" | "shape" | "empty";
export type NormalizeResult = ({ ok: true } & IconImage) | { ok: false; reason: IconRejection };

type Rgba = { width: number; height: number; data: Uint8Array };

export async function normalizeIcon(input: Uint8Array): Promise<NormalizeResult> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const format = sniffImage(bytes);
  if (!format) return { ok: false, reason: "format" };
  let source: Buffer | Rgba | IconRejection = bytes;
  try {
    if (format === "ico") source = decodeIco(bytes);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (typeof source === "string") return { ok: false, reason: source };
  try {
    const open = () => Buffer.isBuffer(source)
      ? sharp(source, { limitInputPixels: MAX_PIXELS, animated: false, failOn: "error" })
      : sharp(Buffer.from((source as Rgba).data), { raw: { width: (source as Rgba).width, height: (source as Rgba).height, channels: 4 } });
    const meta = await open().metadata();
    // EXIF orientations 5–8 turn the picture a quarter; width and height swap.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    if (!width || !height) return { ok: false, reason: "corrupt" };
    if (width * height > MAX_PIXELS) return { ok: false, reason: "toolarge" };
    const shaped = checkShape(width, height);
    if (shaped) return { ok: false, reason: shaped };
    const side = Math.min(Math.max(width, height), ICON_SIZE);
    const { data, info } = await open().rotate().resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!hasVisiblePixels(data)) return { ok: false, reason: "empty" };
    const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).webp({ quality: 90, alphaQuality: 100, effort: 4 }).toBuffer();
    if (out.length > MAX_ICON_BYTES) return { ok: false, reason: "toolarge" };
    return { ok: true, mime: "image/webp", data: out, width: info.width, height: info.height };
  } catch (error) {
    return { ok: false, reason: /pixel limit/i.test(String(error)) ? "toolarge" : "corrupt" };
  }
}

function checkShape(width: number, height: number): IconRejection | null {
  if (Math.min(width, height) < MIN_SIDE) return "small";
  if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT) return "shape";
  return null;
}

/** ICO: pick the largest entry; entries hold either a whole PNG or a headerless BMP (DIB). */
function decodeIco(bytes: Buffer): Buffer | Rgba | IconRejection {
  const count = Math.min(bytes.readUInt16LE(4), 64);
  let best: { width: number; bpp: number; size: number; offset: number } | null = null;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > bytes.length) break;
    const entry = { width: bytes[at] || 256, bpp: bytes.readUInt16LE(at + 6), size: bytes.readUInt32LE(at + 8), offset: bytes.readUInt32LE(at + 12) };
    if (entry.offset + entry.size > bytes.length || entry.size < 16) continue;
    if (!best || entry.width > best.width || (entry.width === best.width && entry.bpp > best.bpp)) best = entry;
  }
  if (!best) return "corrupt";
  const data = bytes.subarray(best.offset, best.offset + best.size);
  return sniffImage(data) === "png" ? Buffer.from(data) : decodeDib(Buffer.from(data));
}

function decodeDib(d: Buffer): Rgba | IconRejection {
  const headerSize = d.readUInt32LE(0);
  if (headerSize < 40 || headerSize > d.length) return "corrupt";
  const width = d.readInt32LE(4);
  const height = Math.abs(d.readInt32LE(8)) / 2; // XOR image plus AND mask
  const bpp = d.readUInt16LE(14);
  const compression = d.readUInt32LE(16);
  if (width <= 0 || height <= 0 || width > 1024 || height > 1024 || !Number.isInteger(height)) return "corrupt";
  if (compression !== 0 && !(compression === 3 && bpp === 32)) return "format";
  if (![1, 4, 8, 24, 32].includes(bpp)) return "format";
  const paletteSize = bpp <= 8 ? (d.readUInt32LE(32) || 1 << bpp) : 0;
  const paletteAt = headerSize;
  const pixelsAt = paletteAt + paletteSize * 4;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const maskAt = pixelsAt + stride * height;
  const maskStride = Math.ceil(width / 32) * 4;
  if (maskAt > d.length) return "corrupt";
  const hasMask = maskAt + maskStride * height <= d.length;
  const out = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixelsAt + (height - 1 - y) * stride; // rows are stored bottom-up
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let b: number, g: number, r: number, a = 255;
      if (bpp === 32) { b = d[row + x * 4]!; g = d[row + x * 4 + 1]!; r = d[row + x * 4 + 2]!; a = d[row + x * 4 + 3]!; if (a) anyAlpha = true; }
      else if (bpp === 24) { b = d[row + x * 3]!; g = d[row + x * 3 + 1]!; r = d[row + x * 3 + 2]!; }
      else {
        const bit = x * bpp;
        const idx = (d[row + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const p = paletteAt + Math.min(idx, paletteSize - 1) * 4;
        b = d[p]!; g = d[p + 1]!; r = d[p + 2]!;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  // The AND mask carries transparency unless a 32-bit image already has a real alpha channel.
  if (hasMask && !(bpp === 32 && anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const row = maskAt + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const transparent = (d[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

function hasVisiblePixels(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) return true;
  return false;
}
