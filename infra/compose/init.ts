// Compose one-shot, before the engine starts: create the shared secrets and the engine's
// install-time settings (egress proxy, retention). Idempotent; never overwrites secrets.
import { chmodSync, chownSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ARCHIVING, randomHex, renderSystemConfig, renderUserConfig } from "@purss/freshrss";
import { ensureDir, ensureSecret } from "../../apps/api/src/secrets.ts";

const dataDir = process.env.PURSS_DATA_DIR ?? "/data";
const engineDir = process.env.PURSS_ENGINE_DATA_DIR ?? "/engine-data";
const proxy = process.env.PURSS_ENGINE_PROXY; // IPv4:port of the egress proxy on the internal network
const WWW_DATA = 33; // the engine image's web user
const NODE = 1000; // the product image's user

if (!proxy || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(proxy)) {
  console.error("PURSS_ENGINE_PROXY must be the egress proxy's IPv4 address and port");
  process.exit(1);
}

const secrets = path.join(dataDir, "secrets");
ensureDir(secrets);
ensureSecret(secrets, "service-token");
// The worker's key to the engine's admin helper, the one product secret the engine reads. The engine never
// gets the service token: whoever runs code in FreshRSS must not reach the API's or egress's service routes.
ensureSecret(secrets, "engine-helper-token");
// Signs the engine's bridge addresses (plan/41); egress, the API and the worker read it.
ensureSecret(secrets, "bridge-key");
const adminFile = path.join(secrets, "engine-admin");
if (!existsSync(adminFile)) {
  writeFileSync(adminFile, JSON.stringify({ username: "purss-engine-admin", password: randomHex(16), apiPassword: randomHex(16) }, null, 2) + "\n", { mode: 0o600 });
  console.log("created the engine operator credentials");
}

// The product services own the data and secrets; the engine's web user may only traverse the
// secrets directory and read the two files it needs (everything else there stays 0600).
chownSync(dataDir, NODE, NODE);
chownSync(secrets, NODE, WWW_DATA);
chmodSync(secrets, 0o750);

mkdirSync(engineDir, { recursive: true });
chownSync(engineDir, WWW_DATA, WWW_DATA);
for (const [name, body] of [
  ["config.custom.php", renderSystemConfig(proxy)],
  ["config-user.custom.php", renderUserConfig(DEFAULT_ARCHIVING, 900)],
] as const) {
  const file = path.join(engineDir, name);
  writeFileSync(file, body, { mode: 0o640 });
  chownSync(file, WWW_DATA, WWW_DATA);
}
chownSync(path.join(secrets, "bridge-key"), NODE, NODE);
chmodSync(path.join(secrets, "bridge-key"), 0o600);
chownSync(path.join(secrets, "service-token"), NODE, NODE);
chmodSync(path.join(secrets, "service-token"), 0o600);
for (const f of ["engine-helper-token", "engine-admin"]) {
  chownSync(path.join(secrets, f), NODE, WWW_DATA);
  chmodSync(path.join(secrets, f), 0o640);
}
console.log("init done");
