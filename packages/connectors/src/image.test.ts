import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { isStoredIcon, sniffImage } from "./icon-format.ts";
import { normalizeIcon } from "./image.ts";

const solid = (width: number, height: number, format: "png" | "jpeg" | "gif" | "webp", alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha } } })[format]().toBuffer();

async function pixel(webp: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [...data.subarray(i, i + 4)];
}

/** An ICO holding one 32-bit BMP entry: top half red, bottom half blue, left column transparent. */
function bmpIco(size: number): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row; // stored bottom-up
    for (let x = 0; x < size; x++) {
      const o = (row * size + x) * 4;
      const red = y < size / 2;
      pixels[o] = red ? 0 : 255; pixels[o + 1] = 0; pixels[o + 2] = red ? 255 : 0; pixels[o + 3] = x === 0 ? 0 : 255;
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  const image = Buffer.concat([header, pixels, mask]);
  const dir = Buffer.alloc(6 + 16);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  dir[6] = size; dir[7] = size; dir.writeUInt16LE(1, 10); dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(image.length, 14); dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, image]);
}

function pngIco(png: Buffer): Buffer {
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(1, 10); dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(png.length, 14); dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, png]);
}

test("large artwork in every raster format becomes a 128 px WebP the API accepts", async () => {
  for (const format of ["png", "jpeg", "gif", "webp"] as const) {
    const r = await normalizeIcon(await solid(900, 900, format));
    assert.ok(r.ok, format);
    assert.equal(r.mime, "image/webp");
    assert.equal(r.width, 128);
    assert.equal(r.height, 128);
    assert.ok(isStoredIcon(r.data), `${format} output is a small WebP`);
  }
});

test("3000 px podcast artwork decodes within the worker's memory budget", async () => {
  const art = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 92 }).toBuffer();
  global.gc?.();
  const before = process.memoryUsage().rss;
  const r = await normalizeIcon(art);
  assert.ok(r.ok);
  assert.equal(r.width, 128);
  assert.ok(process.memoryUsage().rss - before < 120 * 1024 * 1024, "decoding stays well under the 192 MB container limit");
});

test("small icons are kept at their size, never enlarged", async () => {
  const r = await normalizeIcon(await solid(32, 32, "png"));
  assert.ok(r.ok);
  assert.equal(r.width, 32);
});

test("nearly square logos are fitted with transparent padding, not cropped", async () => {
  const r = await normalizeIcon(await solid(120, 100, "png"));
  assert.ok(r.ok);
  assert.equal(r.width, 120);
  assert.equal(r.height, 120);
  assert.equal((await pixel(r.data, 60, 2))[3], 0, "padding above the logo is transparent");
  assert.ok((await pixel(r.data, 60, 60))[3]! > 240, "the logo itself is intact");
});

test("banners, tiny images, blank images, SVG and non-images are refused", async () => {
  assert.deepEqual(await normalizeIcon(await solid(600, 200, "png")), { ok: false, reason: "shape" });
  assert.deepEqual(await normalizeIcon(await solid(12, 12, "png")), { ok: false, reason: "small" });
  assert.deepEqual(await normalizeIcon(await solid(64, 64, "png", 0)), { ok: false, reason: "empty" });
  assert.deepEqual(await normalizeIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), { ok: false, reason: "format" });
  assert.deepEqual(await normalizeIcon(Buffer.from("<!doctype html><title>Forbidden</title>")), { ok: false, reason: "format" });
  const png = await solid(64, 64, "png");
  assert.deepEqual(await normalizeIcon(png.subarray(0, 60)), { ok: false, reason: "corrupt" }, "a truncated PNG");
});

test("a PNG declaring a huge canvas is refused before it is decoded", async () => {
  const png = Buffer.from(await solid(16, 16, "png"));
  png.writeUInt32BE(20_000, 16); // IHDR width
  png.writeUInt32BE(20_000, 20); // IHDR height
  const r = await normalizeIcon(png);
  assert.equal(r.ok, false);
});

test("ICO files: BMP entries keep their colours, orientation and alpha; PNG entries are decoded too", async () => {
  const r = await normalizeIcon(bmpIco(32));
  assert.ok(r.ok);
  assert.equal(r.width, 32);
  const top = await pixel(r.data, 16, 4);
  const bottom = await pixel(r.data, 16, 28);
  assert.ok(top[0]! > 200 && top[2]! < 60, `top is red (${top})`);
  assert.ok(bottom[2]! > 200 && bottom[0]! < 60, `bottom is blue (${bottom})`);
  assert.equal((await pixel(r.data, 0, 16))[3], 0, "the transparent column stays transparent");

  const p = await normalizeIcon(pngIco(await solid(48, 48, "png")));
  assert.ok(p.ok);
  assert.equal(p.width, 48);
});

test("only WebP passes the API's stored-icon check", async () => {
  assert.equal(isStoredIcon(await solid(32, 32, "png")), false);
  assert.equal(isStoredIcon(await solid(32, 32, "webp")), true);
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(isStoredIcon(Buffer.alloc(70_000)), false);
});
