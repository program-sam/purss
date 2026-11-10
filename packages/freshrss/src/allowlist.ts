import { createHash } from "node:crypto";
import { ADMIN_CLI_SCRIPTS, ADMIN_SNIPPETS } from "./admin.ts";

/** What the engine image's admin helper may run: exactly the worker's fixed operations. */
export function engineAllowlist(): { cliScripts: string[]; snippetHashes: string[] } {
  return {
    cliScripts: [...ADMIN_CLI_SCRIPTS],
    snippetHashes: Object.values(ADMIN_SNIPPETS).map((code) => createHash("sha256").update(code).digest("hex")),
  };
}
