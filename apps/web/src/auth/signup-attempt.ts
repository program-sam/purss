/*
 * A sign-up attempt's random id, kept on this browser until the account is made. The server finds the account an
 * earlier press of the button already made for the same id (when the same email address and password are given again), so
 * pressing twice, or again after closing the page, doesn't make a second account or send a second confirmation. (Only a hash of the id is stored on the server.)
 */
const KEY = "purss:signup-attempt";

function fresh(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This browser's current attempt id, made on first use. */
export function signupAttempt(): string {
  try {
    const kept = localStorage.getItem(KEY);
    if (kept && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept;
    const id = fresh();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return fresh(); // storage is unavailable: this visit still can't double-press
  }
}

/** The account was made: the next sign-up starts a new attempt. */
export function finishSignupAttempt(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
}
