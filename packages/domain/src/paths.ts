/**
 * Where the web app lives on the server. The public website has the root; the API stays at /api and
 * published collections at /p.
 */
export const APP_PATH = "/app";

/** An address inside the web app, from an app path such as "/signin?error=x". */
export const appUrl = (path: string): string => `${APP_PATH}${path}`;

/** An item's short link: the app's /i/ and the item's number in its account. The app resolves it itself, so it opens offline too. */
export const itemPath = (number: number): string => appUrl(`/i/${number}`);
