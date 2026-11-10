import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, nowIso } from "../http.ts";
import { credentialWrite } from "./accounts.ts";

/*
 * Username and password sign-in, for installations reached over plain HTTP (for example a home
 * server on a LAN), where browsers refuse passkeys. Stored as a 'password' sign-in method: the
 * label is the lower-case username, secret_hash an scrypt hash with its parameters.
 */

export const USERNAME_RULE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
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

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function checkNewPassword(username: string, password: string): void {
  if (!USERNAME_RULE.test(username)) {
    throw new HttpError(400, "bad_username", "Use 3 to 40 letters, digits, dots, dashes or underscores for the username, starting with a letter or digit.");
  }
  if ([...password].length < PASSWORD_MIN) throw new HttpError(400, "short_password", `Use at least ${PASSWORD_MIN} characters for the password.`);
  if ([...password].length > PASSWORD_MAX) throw new HttpError(400, "long_password", `Use at most ${PASSWORD_MAX} characters for the password.`);
  if (password.toLowerCase() === username) throw new HttpError(400, "weak_password", "The password can't be the same as the username.");
}

/** Set or replace the account's username and password. Needs recent authentication (checked by the route). */
export async function setPassword(app: App, accountId: string, sessionId: string, rawUsername: string, password: string): Promise<void> {
  await writePassword(app, accountId, rawUsername, password, (write) => credentialWrite(app, accountId, sessionId, write));
}

/**
 * Set or replace an account's username and password. `inTransaction` runs the write in the caller's
 * transaction, after the hash, so it can re-check what the hashing may have outlived.
 */
export async function writePassword(app: App, accountId: string, rawUsername: string, password: string, inTransaction: (write: () => void) => void = (write) => app.db.tx(write)): Promise<void> {
  const prepared = await preparePassword(rawUsername, password);
  inTransaction(() => storePassword(app, accountId, prepared));
}

/** A checked username and the password's hash, made before a transaction (hashing is slow). */
export type PreparedPassword = { username: string; hash: string };

export async function preparePassword(rawUsername: string, password: string): Promise<PreparedPassword> {
  const username = normalizeUsername(rawUsername);
  checkNewPassword(username, password);
  return { username, hash: await hashPassword(password) };
}

/** Set or replace the account's password, inside the caller's transaction. */
export function storePassword(app: App, accountId: string, { username, hash }: PreparedPassword): void {
  const taken = app.db.get<{ account_id: string }>("SELECT account_id FROM sign_in_methods WHERE kind = 'password' AND label = ?", username);
  if (taken && taken.account_id !== accountId) throw new HttpError(409, "username_taken", "That username is already in use. Choose another one.");
  const had = app.db.get<{ id: string }>("SELECT id FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", accountId);
  if (had) app.db.run("UPDATE sign_in_methods SET label = ?, secret_hash = ? WHERE id = ?", username, hash, had.id);
  else app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES (?, ?, 'password', ?, ?, ?)", newId("sim"), accountId, username, hash, nowIso());
  audit(app, accountId, had ? "password_change" : "password_add", null, "success");
}

let dummyHash: Promise<string> | null = null;

type PasswordRow = { id: string; account_id: string; secret_hash: string };

/**
 * The password sign-in a name belongs to: a username, or a confirmed account email address (names with "@" are
 * never usernames). An address is used only when exactly one account has it confirmed and a password; with none
 * or several it names nobody, and the caller treats it like an unknown username.
 */
function passwordRow(app: App, name: string): PasswordRow | null {
  if (name.includes("@")) {
    const rows = app.db.all<PasswordRow>(
      `SELECT m.id, m.account_id, m.secret_hash FROM accounts a JOIN sign_in_methods m ON m.account_id = a.id AND m.kind = 'password'
       WHERE lower(a.email) = ? AND a.email_verified_at IS NOT NULL LIMIT 2`, name);
    return rows.length === 1 ? rows[0]! : null;
  }
  return app.db.get<PasswordRow>("SELECT id, account_id, secret_hash FROM sign_in_methods WHERE kind = 'password' AND label = ?", name) ?? null;
}

/**
 * The account a username (or confirmed email address) and password belong to, or null. Unknown names cost the same
 * time as known ones. With `onlyAccountId` the name is ignored and that account's own password is checked.
 */
export async function checkPassword(app: App, rawName: string, password: string, onlyAccountId?: string): Promise<string | null> {
  const row = onlyAccountId
    ? app.db.get<PasswordRow>("SELECT id, account_id, secret_hash FROM sign_in_methods WHERE kind = 'password' AND account_id = ?", onlyAccountId) ?? null
    : passwordRow(app, normalizeUsername(rawName));
  if (!row) {
    dummyHash ??= hashPassword(randomBytes(12).toString("base64url"));
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.secret_hash))) return null;
  app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
  return row.account_id;
}

export function passwordUsername(app: App, accountId: string): string | null {
  return app.db.get<{ label: string }>("SELECT label FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", accountId)?.label ?? null;
}
