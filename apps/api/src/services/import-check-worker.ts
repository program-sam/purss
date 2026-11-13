// Child process for checkUploadApart (portability.ts): reads an uploaded export, verifies it and works out what
// importing it would do, on its own view of the database and within its own heap (--max-old-space-size).
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { Principal } from "../app.ts";
import type { Config } from "../config.ts";
import { Database } from "../db/database.ts";
import { HttpError } from "../http.ts";
import { checkUpload } from "./portability.ts";

process.once("message", (job: { config: Config; principal: Principal; file: string }) => {
  const db = new Database(job.config.dbFile);
  let answer: unknown;
  try {
    const text = readFileSync(job.file, "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    answer = { ok: true, check: checkUpload({ db, config: job.config, events: new EventEmitter(), serviceToken: "" }, job.principal, text), sha256 };
  } catch (err) {
    answer = err instanceof HttpError
      ? { ok: false, status: err.status, code: err.code, message: err.message }
      : { ok: false, status: 500, code: "internal", message: "Something went wrong checking that file." };
    if (!(err instanceof HttpError)) console.error("[api] import check failed:", err instanceof Error ? err.message : "unknown error");
  } finally {
    db.raw.close();
  }
  process.send?.(answer, () => process.disconnect?.());
});
