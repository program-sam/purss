import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The bridge service's image and RSS-Bridge settings as Compose runs them (infra/compose.yaml), so the
 * development container (scripts/bridge.ts) and the weekly update check (scripts/bridge-check.ts) run the same thing.
 */
export function composeBridge(repo: string): { image: string; env: [string, string][] } {
  const yaml = readFileSync(path.join(repo, "infra/compose.yaml"), "utf8");
  const block = /\n {2}bridge:\n([\s\S]*?)\n {2}[a-z-]+:\n/.exec(yaml)?.[1] ?? "";
  const image = /^ {4}image: (\S+)$/m.exec(block)?.[1];
  const env = [...block.matchAll(/^ {6}(RSSBRIDGE_[A-Za-z_]+): "?([^"\n]*)"?$/gm)].map((m) => [m[1]!, m[2]!] as [string, string]);
  if (!image || !env.length) throw new Error("infra/compose.yaml has no bridge service to copy.");
  return { image, env };
}
