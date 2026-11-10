import type { ServerResponse } from "node:http";
import type { App } from "../app.ts";

/*
 * The PURSS vouches for its phone apps (configured in Config.apps), so the phones let them use the
 * PURSS's passkeys and open its links: Android reads /.well-known/assetlinks.json (Digital Asset
 * Links), iOS /.well-known/apple-app-site-association. Not configured: both answer 404, as before.
 */

export const ASSETLINKS_PATH = "/.well-known/assetlinks.json";
export const AASA_PATH = "/.well-known/apple-app-site-association";

/** The origin Android's passkey API reports for an app signed with this key: its SHA-256, base64url. */
export function androidOrigin(fingerprint: string): string {
  return `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ""), "hex").toString("base64url")}`;
}

/** Every origin a passkey answer may come from: the PURSS itself, and its Android apps. */
export function passkeyOrigins(app: App): string[] {
  return [app.config.publicOrigin, ...app.config.apps.androidCerts.map(androidOrigin)];
}

/** Whether the phone apps can use passkeys here (the PURSS vouches for at least one of them). */
export function appPasskeys(app: App): boolean {
  return app.config.apps.androidCerts.length > 0 || app.config.apps.iosAppIds.length > 0;
}

/** Answer the two association files; false for any other path. */
export function serveAppAssociation(app: App, path: string, res: ServerResponse): boolean {
  const { androidPackage, androidCerts, iosAppIds } = app.config.apps;
  let body: unknown;
  if (path === ASSETLINKS_PATH && androidCerts.length) {
    body = [{
      relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: androidPackage, sha256_cert_fingerprints: androidCerts },
    }];
  } else if (path === AASA_PATH && iosAppIds.length) {
    body = { webcredentials: { apps: iosAppIds }, applinks: { details: [{ appIDs: iosAppIds, components: [{ "/": "/app/*" }] }] } };
  } else if (path === ASSETLINKS_PATH || path === AASA_PATH) {
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: { code: "not_found", message: "This PURSS vouches for no app." } }));
    return true;
  } else {
    return false;
  }
  res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end(JSON.stringify(body));
  return true;
}
