// Worker thread for checkUploadApart (portability.ts): reads an uploaded export, verifies it and works out what
// importing it would do, on its own read-only view of the database and within its own memory limit.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { Principal } from "../app.ts";
import type { Config } from "../config.ts";
import { Database } from "../db/database.ts";
import { HttpError } from "../http.ts";
import { checkUpload } from "./portability.ts";

const { config, principal, file } = workerData as { config: Config; principal: Principal; file: string };
const db = new Database(config.dbFile);
try {
  const text = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const check = checkUpload({ db, config, events: new EventEmitter(), serviceToken: "" }, principal, text);
  parentPort!.postMessage({ ok: true, check, sha256 });
} catch (err) {
  parentPort!.postMessage(err instanceof HttpError
    ? { ok: false, status: err.status, code: err.code, message: err.message }
    : { ok: false, status: 500, code: "internal", message: "Something went wrong checking that file." });
  if (!(err instanceof HttpError)) console.error("[api] import check failed:", err instanceof Error ? err.message : "unknown error");
} finally {
  db.raw.close();
}
