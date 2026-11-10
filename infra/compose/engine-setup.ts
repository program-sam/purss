// Compose one-shot, after the engine is healthy: make sure every fetch still goes through
// the egress proxy (corrects an existing install in place) and the operator can sign in.
import { readFileSync } from "node:fs";
import path from "node:path";
import { EngineAdmin, GReaderClient } from "@purss/freshrss";

const dataDir = process.env.PURSS_DATA_DIR ?? "/data";
const engineUrl = process.env.PURSS_ENGINE_URL ?? "http://engine";
const proxy = process.env.PURSS_ENGINE_PROXY!;
const token = readFileSync(path.join(dataDir, "secrets/service-token"), "utf8").trim();
const operator = JSON.parse(readFileSync(path.join(dataDir, "secrets/engine-admin"), "utf8")) as { username: string; apiPassword: string };

const admin = EngineAdmin.fromEnv({ ...process.env, PURSS_ENGINE_ADMIN_URL: `${engineUrl}/purss/admin.php` }, { adminToken: token });
const outcome = await admin.applyEgressConfig({ proxyHostPort: proxy });
console.log(outcome === "updated" ? "corrected the engine's egress proxy setting" : "engine egress proxy setting is current");
await new GReaderClient({ baseUrl: engineUrl, username: operator.username, apiPassword: operator.apiPassword }).login();
console.log(`engine ready (${await admin.engineIdentity()})`);
