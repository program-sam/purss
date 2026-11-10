import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { bridgeRoutePath, parseBridgeDescriptor } from "@purss/connectors";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

/**
 * Engine user API passwords, one 0600 file per engine user. Only the worker reads these files; the API
 * never does. Writes are atomic so a crash never leaves a half-written password behind.
 */
export class EngineUserSecrets {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }

  #file(engineUserId: string): string {
    if (!SAFE_ID.test(engineUserId)) throw new Error("The engine user id is not a safe file name.");
    return path.join(this.#dir, engineUserId);
  }

  read(engineUserId: string): string | null {
    const file = this.#file(engineUserId);
    if (!existsSync(file)) return null;
    const v = readFileSync(file, "utf8").trim();
    return v === "" ? null : v;
  }

  /** Returns the existing password, or generates and durably stores a new one before it is used anywhere. */
  ensure(engineUserId: string): { apiPassword: string; generated: boolean } {
    const existing = this.read(engineUserId);
    if (existing) return { apiPassword: existing, generated: false };
    const apiPassword = randomBytes(24).toString("hex");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = this.#file(engineUserId);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${apiPassword}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return { apiPassword, generated: true };
  }

  /** Forget the password of an engine user that was deleted. A missing file is fine. */
  remove(engineUserId: string): void {
    rmSync(this.#file(engineUserId), { force: true });
  }
}

const SECRET_REF = /^secret:source-urls\/(src_[0-9a-z]{26})$/;

/** Where the engine reaches the bridge router (through the egress proxy's internal alias). */
export const DEFAULT_BRIDGE_ENGINE_URL = "http://feed-bridge.internal:8945";

/**
 * The address the engine follows for a source's stored feed address:
 * - Private (secret-link) addresses never travel in job payloads; the API stores them in
 *   <secrets>/source-urls/<sourceId> and the job carries `secret:source-urls/<sourceId>`.
 * - A bridged source (`bridge:<service>/<key>`, plan/41) becomes the router address signed with
 *   <secrets>/bridge-key, which only the worker and the API hold.
 * Returns null when the reference points nowhere.
 */
export function resolveFeedUrl(secretsDir: string, feedUrl: string, bridgeEngineUrl: string = DEFAULT_BRIDGE_ENGINE_URL): string | null {
  if (feedUrl.startsWith("bridge:")) {
    const target = parseBridgeDescriptor(feedUrl);
    const key = readSecretFile(path.join(secretsDir, "bridge-key"));
    if (!target || !key) return null;
    return `${bridgeEngineUrl.replace(/\/+$/, "")}${bridgeRoutePath(key, target.service.id, target.key)}`;
  }
  if (!feedUrl.startsWith("secret:")) return feedUrl;
  const m = SECRET_REF.exec(feedUrl);
  if (!m) return null;
  return readSecretFile(path.join(secretsDir, "source-urls", m[1]!));
}

function readSecretFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const v = readFileSync(file, "utf8").trim();
  return v === "" ? null : v;
}
