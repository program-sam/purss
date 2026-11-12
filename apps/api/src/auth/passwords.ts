import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, nowIso } from "../http.ts";

/*
 * Email address and password sign-in: every account has a password made with it, except one made by signing in with a
 * provider. Stored as a 'password' sign-in method whose secret_hash is an scrypt hash with its parameters; the address
 * it goes with is the account's own (accounts.email). It can be changed or reset but never removed; a passkey or a linked
 * provider is only an extra way in.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

// scrypt N=2^15, r=8, p=1: about 32 MiB and a few tens of milliseconds per check.
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32, MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * An address as JavaScript compares it. SQL compares with lower() on both sides instead, as the accounts_email index
 * does (SQLite's lower() folds only ASCII letters).
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function checkNewPassword(password: string, email: string | null): void {
  if ([...password].length < PASSWORD_MIN) throw new HttpError(400, "short_password", `Use at least ${PASSWORD_MIN} characters for the password.`);
  if ([...password].length > PASSWORD_MAX) throw new HttpError(400, "long_password", `Use at most ${PASSWORD_MAX} characters for the password.`);
  if (email !== null && password.toLowerCase() === normalizeEmail(email)) throw new HttpError(400, "weak_password", "The password can't be the same as your email address.");
}

/** The account's address, which a new password is checked against. */
export function accountEmail(app: App, accountId: string): string | null {
  return app.db.get<{ email: string | null }>("SELECT email FROM accounts WHERE id = ?", accountId)?.email ?? null;
}

/**
 * Set or replace an account's password. `inTransaction` runs the write in the caller's transaction, after the hash,
 * so it can re-check what the hashing may have outlived.
 */
export async function writePassword(app: App, accountId: string, password: string, inTransaction: (write: () => void) => void = (write) => app.db.tx(write)): Promise<void> {
  const prepared = await preparePassword(password, accountEmail(app, accountId));
  inTransaction(() => storePassword(app, accountId, prepared));
}

/** A checked password's hash, made before a transaction (hashing is slow). */
export type PreparedPassword = { hash: string };

export async function preparePassword(password: string, email: string | null): Promise<PreparedPassword> {
  checkNewPassword(password, email);
  return { hash: await hashPassword(password) };
}

/** Set or replace the account's password, inside the caller's transaction. */
export function storePassword(app: App, accountId: string, { hash }: PreparedPassword): void {
  const had = app.db.get<{ id: string }>("SELECT id FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", accountId);
  if (had) app.db.run("UPDATE sign_in_methods SET secret_hash = ? WHERE id = ?", hash, had.id);
  else app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, secret_hash, created_at) VALUES (?, ?, 'password', ?, ?)", newId("sim"), accountId, hash, nowIso());
  audit(app, accountId, had ? "password_change" : "password_add", null, "success");
}

let dummyHash: Promise<string> | null = null;

type PasswordRow = { id: string; account_id: string; secret_hash: string };

/**
 * The account an email address and password belong to, or null. Unknown addresses cost the same time as known ones.
 * With `onlyAccountId` the address is ignored and that account's own password is checked.
 */
export async function checkPassword(app: App, rawEmail: string, password: string, onlyAccountId?: string): Promise<string | null> {
  const row = onlyAccountId
    ? app.db.get<PasswordRow>("SELECT id, account_id, secret_hash FROM sign_in_methods WHERE kind = 'password' AND account_id = ?", onlyAccountId) ?? null
    : app.db.get<PasswordRow>(
      `SELECT m.id, m.account_id, m.secret_hash FROM accounts a JOIN sign_in_methods m ON m.account_id = a.id AND m.kind = 'password'
       WHERE lower(a.email) = lower(?)`, rawEmail.trim()) ?? null;
  if (!row) {
    dummyHash ??= hashPassword(randomBytes(12).toString("base64url"));
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.secret_hash))) return null;
  // Checking took a while: a password changed or reset meanwhile (which also signs out everywhere) wins.
  const current = app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE id = ? AND secret_hash = ?", nowIso(), row.id, row.secret_hash);
  return current.changes ? row.account_id : null;
}
