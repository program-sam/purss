import path from "node:path";
import { fileURLToPath } from "node:url";
import { jevConfigFromEnv } from "@purss/connectors";
import type { JevConfig } from "@purss/connectors";
import { OFFICIAL_PUSH_RELAY } from "@purss/domain/distribution";
import type { BuildVersion } from "@purss/domain/version";
import { readVersion } from "../../../scripts/version.ts";
import { parseTrustProxy, type TrustProxy } from "./http.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** This build's version (plan/40), read once: from the checkout's history, else the image's version.json. */
let buildVersion: BuildVersion | null | undefined;
const thisVersion = () => (buildVersion === undefined ? (buildVersion = readVersion(REPO)) : buildVersion);

/** How "confirm it's you" asks an external provider to check the person again (see OidcProviderConfig). */
export type StepUpMode = "reauthenticate" | "choose-account";

/**
 * An external sign-in provider (OpenID Connect). `stepUp` is how "confirm it's you" asks it to check the person again:
 * "reauthenticate" sends prompt=login and max_age=0 and refuses an ID token without a recent auth_time; "choose-account"
 * sends prompt=select_account only, for a provider such as Google that doesn't honour the first. It is always set once
 * loaded: Google's issuer defaults to "choose-account", every other to "reauthenticate". Because "choose-account" proves
 * only a signed-in provider account in that browser, it confirms accounts with no password and no passkey, and no others.
 */
export type OidcProviderConfig = { id: string; label: string; issuer: string; clientId: string; clientSecret?: string; stepUp: StepUpMode };

/**
 * An issuer address as a comparison key: lower-case host, no trailing slash. A configured issuer and the `iss` stored from an ID
 * token name the same issuer however either spells its end; anything that isn't an address compares as typed.
 */
export function issuerKey(issuer: string): string {
  const text = issuer.trim();
  try {
    const u = new URL(text);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return text.replace(/\/+$/, ""); }
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/** Outgoing email (plan/27): optional; hosted open sign-up needs it. */
export type MailConfig = {
  host: string;
  port: number;
  /** "starttls" upgrades a plain connection and refuses to send without TLS; "tls" connects with TLS (port 465); "none" is for a relay on the same host or private network. */
  security: "starttls" | "tls" | "none";
  user: string | null;
  password: string | null;
  /** The sender, e.g. "PURSS <purss@example.com>". */
  from: string;
};

export type Config = {
  dataDir: string;
  secretsDir: string;
  dbFile: string;
  publicHost: string;
  publicPort: number;
  internalHost: string;
  internalPort: number;
  publicOrigin: string;
  rpId: string;
  /**
   * The phone apps this PURSS vouches for (`/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association`),
   * so they can use its passkeys and open its links: the Android package and the SHA-256 fingerprints of the keys that
   * sign it, and the iOS app ids (Team ID and bundle id). Empty lists vouch for nothing.
   */
  apps: { androidPackage: string; androidCerts: string[]; iosAppIds: string[] };
  mode: "self" | "hosted";
  diskReserveBytes: number;
  /** The most memory checking one import may use, in MB (services/portability.ts checkUploadApart); larger files are refused. */
  importCheckHeapMb: number;
  defaultAllocationBytes: number | null;
  oidc: OidcProviderConfig[];
  webDist: string;
  /** The public website, served at the root in hosted mode. */
  siteDist: string;
  /** The phone apps' interface packed for live updates (plan/39); empty or missing: no update offered. */
  appBundleDir: string;
  /** Which build this is (plan/40); null when it was built without its history or version.json. */
  version: BuildVersion | null;
  engineBaseUrl: string;
  egressControlUrl: string;
  /** The egress bridge router (plan/41), reached directly; null when this installation runs no bridge. */
  bridgeUrl: string | null;
  syncIntervalSeconds: number;
  /** Behind a reverse proxy: which peers may give the client address in X-Forwarded-For (http.ts). */
  trustProxy: TrustProxy;
  /** Hosted mode only: "open" lets anyone create an account (rate-limited); otherwise invitations only. */
  signup: "invite" | "open";
  signupDailyLimit: number;
  /** Null when PURSS_SMTP_HOST is unset: no email is sent and nothing depends on it. */
  mail: MailConfig | null;
  /**
   * Assistants may connect to /mcp with OAuth (plan/33) besides personal access tokens. On by
   * default in hosted mode; self-hosters opt in with PURSS_ASSISTANT_OAUTH=on. Needs an https origin
   * (or localhost); nothing else to configure.
   */
  assistantOAuth: boolean;
  /** Jev, for Smart filters (plan/36): the operator-fixed address and model. Keys are set in the app and kept in the secrets folder. */
  jev: JevConfig;
  /**
   * The push relay that wakes connected phones (plan/37), or null for no phone notifications. The
   * project's relay unless PURSS_PUSH_RELAY_URL names another or turns it off; nothing to set up.
   */
  pushRelay: string | null;
  /**
   * Hosted only: an external billing service (its address and a shared secret of at least 32 characters), which
   * people reach from Settings to pay for a plan and which sets plans back through /api/billing/plan (billing.ts).
   * Null without it: administrators set plans by hand.
   */
  billing: { url: string; secret: string } | null;
};

/** A number from the environment; unset or empty (Compose passes a variable the operator didn't set as "") means the default. */
function int(v: string | undefined, d: number): number {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

function mailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  const host = env.PURSS_SMTP_HOST?.trim();
  if (!host) return null;
  // Compose passes unset variables as empty strings; empty means the default.
  const security = (env.PURSS_SMTP_SECURITY?.trim() || "starttls").toLowerCase();
  if (security !== "starttls" && security !== "tls" && security !== "none") throw new Error(`PURSS_SMTP_SECURITY must be starttls, tls or none, not "${security}".`);
  const from = env.PURSS_MAIL_FROM?.trim();
  if (!from) throw new Error("PURSS_MAIL_FROM is needed when PURSS_SMTP_HOST is set, for example \"PURSS <purss@example.com>\".");
  const port = int(env.PURSS_SMTP_PORT?.trim() || undefined, security === "tls" ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PURSS_SMTP_PORT must be a port number.");
  return { host, port, security, user: env.PURSS_SMTP_USER?.trim() || null, password: env.PURSS_SMTP_PASSWORD || null, from };
}

/** OAuth endpoints must be served over https (OAuth 2.1 §1.5); a loopback origin is fine for testing. */
const secureOrigin = (origin: string) => { const u = new URL(origin); return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname); };

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function appsConfig(env: NodeJS.ProcessEnv): Config["apps"] {
  const androidPackage = env.PURSS_APP_ANDROID_PACKAGE?.trim() || "app.purss";
  if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(androidPackage)) throw new Error("PURSS_APP_ANDROID_PACKAGE must be an Android package name, for example app.purss.");
  const androidCerts = list(env.PURSS_APP_ANDROID_CERT_SHA256).map((c) => c.toUpperCase());
  for (const c of androidCerts) if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(c)) throw new Error("PURSS_APP_ANDROID_CERT_SHA256 takes SHA-256 fingerprints like AB:CD:… (32 pairs), comma-separated.");
  const iosAppIds = list(env.PURSS_APP_IOS_APP_ID);
  for (const id of iosAppIds) if (!/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(id)) throw new Error("PURSS_APP_IOS_APP_ID takes TEAMID.bundle.id, comma-separated.");
  return { androidPackage, androidCerts, iosAppIds };
}

function assistantOAuth(env: NodeJS.ProcessEnv, mode: Config["mode"], publicOrigin: string): boolean {
  // Compose passes unset variables as empty strings; empty means the default.
  const v = env.PURSS_ASSISTANT_OAUTH?.trim().toLowerCase();
  if (v && v !== "on" && v !== "off") throw new Error(`PURSS_ASSISTANT_OAUTH must be on or off, not "${v}".`);
  if (v === "on" && !secureOrigin(publicOrigin)) throw new Error("PURSS_ASSISTANT_OAUTH=on needs an https PURSS_PUBLIC_ORIGIN: assistants send their sign-in codes and tokens to it.");
  return v ? v === "on" : mode === "hosted" && secureOrigin(publicOrigin);
}

/**
 * PURSS_PUSH_RELAY_URL: unset or "official" is the project's relay; empty or "off" turns phone notifications
 * off; anything else must be the https address of another relay (one holding the credentials of the app
 * the phones run, so in practice a fork's own).
 */
function billing(env: NodeJS.ProcessEnv, mode: string): { url: string; secret: string } | null {
  const url = env.PURSS_BILLING_URL?.trim() ?? "";
  const secret = env.PURSS_BILLING_SECRET?.trim() ?? "";
  if (mode !== "hosted" || (!url && !secret)) return null;
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("PURSS_BILLING_URL must be the billing service's https address."); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error("PURSS_BILLING_URL must be a plain https address.");
  if (secret.length < 32) throw new Error("PURSS_BILLING_SECRET must be at least 32 characters, the same as the billing service's.");
  return { url: u.href.replace(/\/+$/, ""), secret };
}

function pushRelay(env: NodeJS.ProcessEnv): string | null {
  const v = env.PURSS_PUSH_RELAY_URL?.trim();
  if (v === undefined || v === "official") return OFFICIAL_PUSH_RELAY;
  if (v === "" || v === "off") return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`PURSS_PUSH_RELAY_URL must be an https address, "official", or empty or "off" for no phone notifications, not "${v}".`); }
  // Plain http only for a relay on this machine, to try the apps against a local one; waking still goes through
  // the safe fetcher, which never reaches this machine, so such a relay never receives a wake.
  const local = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  if ((u.protocol !== "https:" && !local) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("PURSS_PUSH_RELAY_URL must be a plain https address such as https://push.example.com.");
  return u.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.PURSS_DATA_DIR ?? path.join(REPO, "data"));
  const publicPort = int(env.PURSS_PORT, 8940);
  const publicOrigin = (env.PURSS_PUBLIC_ORIGIN ?? `http://localhost:${publicPort}`).replace(/\/$/, "");
  const mode = env.PURSS_MODE === "hosted" ? "hosted" : "self";
  let oidc: OidcProviderConfig[] = [];
  if (env.PURSS_OIDC) {
    const parsed = JSON.parse(env.PURSS_OIDC) as (Omit<OidcProviderConfig, "stepUp"> & { stepUp?: unknown })[];
    oidc = parsed.filter((p) => p && typeof p.id === "string" && typeof p.issuer === "string" && typeof p.clientId === "string").map((p) => {
      if (p.stepUp !== undefined && p.stepUp !== "reauthenticate" && p.stepUp !== "choose-account") throw new Error(`PURSS_OIDC: stepUp for "${p.id}" must be "reauthenticate" or "choose-account".`);
      const issuer = p.issuer.trim();
      try { new URL(issuer); } catch { throw new Error(`PURSS_OIDC: the issuer of "${p.id}" must be an address such as https://accounts.google.com.`); }
      return { ...p, issuer, stepUp: p.stepUp ?? (issuerKey(issuer) === GOOGLE_ISSUER ? "choose-account" : "reauthenticate") };
    });
  }
  const alloc = env.PURSS_DEFAULT_ALLOCATION_BYTES;
  return {
    dataDir,
    secretsDir: path.join(dataDir, "secrets"),
    dbFile: env.PURSS_DB_FILE ?? path.join(dataDir, "product.db"),
    publicHost: env.PURSS_HOST ?? "127.0.0.1",
    publicPort,
    internalHost: env.PURSS_INTERNAL_HOST ?? "127.0.0.1",
    internalPort: int(env.PURSS_INTERNAL_PORT, 8948),
    publicOrigin,
    rpId: new URL(publicOrigin).hostname,
    apps: appsConfig(env),
    mode,
    diskReserveBytes: int(env.PURSS_DISK_RESERVE_BYTES, 1024 ** 3),
    importCheckHeapMb: Math.max(64, int(env.PURSS_IMPORT_CHECK_HEAP_MB, 384)),
    defaultAllocationBytes: alloc ? int(alloc, 0) : null,
    oidc,
    webDist: env.PURSS_WEB_DIST ?? path.join(REPO, "apps/web/dist"),
    siteDist: env.PURSS_SITE_DIST ?? path.join(REPO, "apps/site/dist"),
    appBundleDir: env.PURSS_APP_BUNDLE_DIR ?? path.join(REPO, "apps/web/app-bundle"),
    version: thisVersion(),
    engineBaseUrl: env.PURSS_ENGINE_URL ?? "http://127.0.0.1:8941",
    egressControlUrl: env.PURSS_EGRESS_CONTROL_URL ?? "http://127.0.0.1:8949/status",
    bridgeUrl: env.PURSS_BRIDGE_URL ? env.PURSS_BRIDGE_URL.replace(/\/+$/, "") : null,
    syncIntervalSeconds: int(env.PURSS_SYNC_INTERVAL, 120),
    trustProxy: parseTrustProxy(env.PURSS_TRUST_PROXY),
    signup: mode === "hosted" && env.PURSS_SIGNUP === "open" ? "open" : "invite",
    signupDailyLimit: int(env.PURSS_SIGNUP_DAILY_LIMIT, 50),
    mail: mailConfig(env),
    assistantOAuth: assistantOAuth(env, mode, publicOrigin),
    jev: jevConfigFromEnv(env),
    pushRelay: pushRelay(env),
    billing: billing(env, mode),
  };
}
