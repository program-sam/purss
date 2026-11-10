import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { parseConnection } from "./connect.ts";
import type { Connection } from "./connect.ts";

/**
 * The device token, in the system's secure storage: the Keychain on iOS (this device only, readable
 * after the first unlock so playback can save its position with the screen locked), and on Android
 * encrypted with a key in the Android Keystore. Never in local storage, and never in an address.
 */
const KEY = "purss.connection";

export async function readConnection(): Promise<Connection | null> {
  try { return parseConnection(await SecureStorage.get(KEY)); } catch { return null; }
}

export async function saveConnection(c: Connection): Promise<void> {
  await SecureStorage.set(KEY, { origin: c.origin, token: c.token }, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly);
}

/** Remove the connection; rejects when secure storage refuses (it resolves when nothing was stored). */
export async function forgetConnection(): Promise<void> {
  await SecureStorage.remove(KEY);
  if (await readConnection()) throw new Error("The connection is still in secure storage.");
}
