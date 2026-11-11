import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readSecret(dir: string, name: string): string | null {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

export function writeSecret(dir: string, name: string, value: string): void {
  ensureDir(path.dirname(path.join(dir, name)));
  const file = path.join(dir, name);
  writeFileSync(file, value + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function removeSecret(dir: string, name: string): void {
  rmSync(path.join(dir, name), { force: true });
}

export function ensureSecret(dir: string, name: string, bytes = 32): string {
  const existing = readSecret(dir, name);
  if (existing) return existing;
  const value = randomBytes(bytes).toString("base64url");
  writeSecret(dir, name, value);
  return value;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Encrypt text with a key from the secrets folder (AES-256-GCM): `iv.tag.ciphertext`, base64url. */
export function seal(secret: string, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

/** The text sealed with this key; null when it was sealed with another key or changed. */
export function unseal(secret: string, sealed: string): string | null {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !body) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** scrypt hash "salt$hash" for low-entropy-tolerant secrets (the setup code). */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [s, h] = stored.split("$");
  if (!s || !h) return false;
  const expected = Buffer.from(h, "base64url");
  const actual = scryptSync(secret, Buffer.from(s, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** Human-typable code: groups of 4 characters. */
export function humanCode(groups = 4): string {
  const bytes = randomBytes(groups * 4);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i && i % 4 === 0) out += "-";
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}
export const normalizeCode = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
