import test from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "../testing.ts";
import { startTestServer } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { loadConfig } from "../config.ts";
import { androidOrigin, passkeyOrigins } from "./app-association.ts";

const CERT = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";

async function serve(env: Record<string, string>) {
  const { app, cleanup } = makeTestApp(env);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, base: server.base, close: async () => { await server.close(); cleanup(); } };
}

test("a PURSS that vouches for its apps serves the association files and offers passkeys in the app", async (t) => {
  const s = await serve({ PURSS_APP_ANDROID_CERT_SHA256: CERT.toLowerCase(), PURSS_APP_IOS_APP_ID: "ABCDE12345.app.purss" });
  t.after(s.close);
  const links = await fetch(`${s.base}/.well-known/assetlinks.json`);
  assert.equal(links.status, 200);
  assert.deepEqual(await links.json(), [{
    relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "app.purss", sha256_cert_fingerprints: [CERT] },
  }]);
  const aasa = await (await fetch(`${s.base}/.well-known/apple-app-site-association`)).json() as { webcredentials: { apps: string[] } };
  assert.deepEqual(aasa.webcredentials.apps, ["ABCDE12345.app.purss"]);

  const info = await (await fetch(`${s.base}/api/connect/info`)).json() as { signin: { methods: string[]; passkeyOptions: string | null } };
  assert.deepEqual(info.signin.methods, ["password", "passkey"]);
  const options = await fetch(`${s.base}/api/connect/passkey/options`, { method: "POST", headers: { origin: "capacitor://localhost", "content-type": "application/json" }, body: "{}" });
  assert.equal(options.status, 200);
  const body = await options.json() as { challengeId: string; options: { rpId: string; challenge: string } };
  assert.equal(body.options.rpId, s.app.config.rpId);
  assert.equal(options.headers.get("access-control-allow-origin"), "capacitor://localhost");

  // The Android app's passkey answers carry its signing key as their origin, and those are accepted.
  assert.match(androidOrigin(CERT), /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(passkeyOrigins(s.app), [s.app.config.publicOrigin, androidOrigin(CERT)]);
});

test("a PURSS that vouches for no app says so, and the app doesn't offer its passkeys", async (t) => {
  const s = await serve({});
  t.after(s.close);
  assert.equal((await fetch(`${s.base}/.well-known/assetlinks.json`)).status, 404);
  assert.equal((await fetch(`${s.base}/.well-known/apple-app-site-association`)).status, 404);
  const info = await (await fetch(`${s.base}/api/connect/info`)).json() as { signin: { methods: string[]; passkeyOptions: string | null } };
  assert.deepEqual([info.signin.methods, info.signin.passkeyOptions], [["password"], null]);
  assert.equal((await fetch(`${s.base}/api/connect/passkey/options`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
});

test("the app settings refuse values that would vouch for the wrong thing", () => {
  const base = { PURSS_DATA_DIR: "/tmp/x" };
  assert.throws(() => loadConfig({ ...base, PURSS_APP_ANDROID_CERT_SHA256: "14:6D" }), /SHA-256 fingerprints/);
  assert.throws(() => loadConfig({ ...base, PURSS_APP_IOS_APP_ID: "app.purss" }), /TEAMID/);
  assert.throws(() => loadConfig({ ...base, PURSS_APP_ANDROID_PACKAGE: "not a package" }), /package name/);
  assert.deepEqual(loadConfig(base).apps, { androidPackage: "app.purss", androidCerts: [], iosAppIds: [] });
});
