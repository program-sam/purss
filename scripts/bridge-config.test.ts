import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRIDGE_SERVICES, needsRssBridge } from "@purss/connectors";
import { composeBridge } from "./bridge-config.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = new Map(composeBridge(repo).env);

test("the bridges Compose enables are the RSS-Bridge bridges the catalogue uses, no more and no fewer", () => {
  const catalogued = BRIDGE_SERVICES.flatMap((s) => (needsRssBridge(s) && s.backend.kind === "rss-bridge" ? [s.backend.bridge] : []));
  assert.ok(catalogued.length > 0);
  assert.deepEqual([...new Set(catalogued)].sort(), (env.get("RSSBRIDGE_system_enabled_bridges") ?? "").split(",").sort());
});

test("RSS-Bridge follows redirects only through the egress proxy, which checks every hop it makes", () => {
  // RSS-Bridge checks the address of the first request only; the proxy is what refuses a redirect to a private address.
  assert.equal(env.get("RSSBRIDGE_http_follow"), "true");
  const egressOnBridgeNetwork = /EGRESS_BRIDGE_NET_HOST: (\S+)/.exec(readFileSync(path.join(repo, "infra/compose.yaml"), "utf8"))?.[1];
  assert.ok(egressOnBridgeNetwork);
  assert.match(env.get("RSSBRIDGE_proxy_url") ?? "", new RegExp(`^http://${egressOnBridgeNetwork.replaceAll(".", "\\.")}:\\d+$`), "the proxy is egress's own listener on RSS-Bridge's network");
  assert.equal(env.get("RSSBRIDGE_proxy_by_bridge"), "false", "every bridge, not a chosen few, goes through the proxy");
});
