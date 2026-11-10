// Writes infra/engine/image/allowlist.json from the worker's fixed admin operations.
// A test fails when they drift apart. Usage: node scripts/gen-engine-allowlist.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineAllowlist } from "../packages/freshrss/src/allowlist.ts";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/engine/image/allowlist.json");
writeFileSync(out, JSON.stringify(engineAllowlist(), null, 2) + "\n");
console.log(`wrote ${out}`);
