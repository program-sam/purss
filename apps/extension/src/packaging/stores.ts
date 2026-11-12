import { createHmac, createSign, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/*
 * Sends a new build of the extension to the Chrome Web Store and addons.mozilla.org, where each goes
 * through the store's review. Run by .github/workflows/extension.yml after `npm run build:extension`:
 *
 *   node apps/extension/src/packaging/stores.ts <source.tar.gz> [--dry-run]
 *
 * A store gets the build only when it differs from what the store has (the manifest's version aside),
 * when the build's version is higher, and when no earlier upload is still waiting for review. The
 * source archive goes to Firefox with each version, as AMO asks for bundled code.
 * Keys, from the environment (repository secrets); a store without its keys is skipped:
 *   CHROME_WEBSTORE_SERVICE_ACCOUNT  the service account's JSON key (added under Account in the dashboard)
 *   AMO_JWT_ISSUER, AMO_JWT_SECRET   addons.mozilla.org → Tools → Manage API Keys
 */

export const CHROME_PUBLISHER = "d92c37c5-701f-4f10-8308-20fc9df8cb64";
export const CHROME_ITEM = "hbchpheipggpppbilgepkalcnnemnldl";
const CHROME_API = `https://chromewebstore.googleapis.com/v2/publishers/${CHROME_PUBLISHER}/items/${CHROME_ITEM}`;
const CHROME_UPLOAD = `https://chromewebstore.googleapis.com/upload/v2/publishers/${CHROME_PUBLISHER}/items/${CHROME_ITEM}:upload`;
const CHROME_CRX = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx3&x=id%3D${CHROME_ITEM}%26uc`;
export const AMO_ADDON = "purss";
const AMO_API = "https://addons.mozilla.org/api/v5/addons";

export type Files = Map<string, Buffer>;

/** The files in a ZIP, or in a CRX (a ZIP behind a signed header). */
export function unzip(archive: Buffer): Files {
  let buf = archive;
  if (buf.subarray(0, 4).toString("latin1") === "Cr24") buf = buf.subarray(12 + buf.readUInt32LE(8));
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a ZIP archive");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files: Files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("Broken ZIP directory");
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + packedSize);
    if (!name.endsWith("/")) {
      if (method === 0) files.set(name, Buffer.from(packed));
      else if (method === 8) files.set(name, inflateRawSync(packed));
      else throw new Error(`Unsupported ZIP compression ${method} for ${name}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** The files of an unpacked build. */
export function readDir(dir: string): Files {
  const files: Files = new Map();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    files.set(path.relative(dir, full).split(path.sep).join("/"), readFileSync(full));
  }
  return files;
}

// What a store adds to the package it serves: signatures, and manifest keys it fills in.
const STORE_ADDED = /^(META-INF|_metadata)\//;
const MANIFEST_STORE_KEYS = ["version", "update_url", "key"];

function manifestWithoutStoreKeys(data: Buffer): string {
  const m = JSON.parse(data.toString("utf8"));
  for (const k of MANIFEST_STORE_KEYS) delete m[k];
  return JSON.stringify(m);
}

/** Whether a build has the same extension as a store's package, the version and the store's additions aside. */
export function sameExtension(built: Files, published: Files): boolean {
  const names = (f: Files) => [...f.keys()].filter((n) => !STORE_ADDED.test(n)).sort();
  const a = names(built);
  const b = names(published);
  if (a.length !== b.length || a.some((n, i) => n !== b[i])) return false;
  return a.every((n) => n === "manifest.json"
    ? manifestWithoutStoreKeys(built.get(n)!) === manifestWithoutStoreKeys(published.get(n)!)
    : built.get(n)!.equals(published.get(n)!));
}

/** Compares dotted versions (26.315.24) by number. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export type StoreState = { inReview: string | null; published: { version: string; files: () => Promise<Files> } | null };

/** Why a store doesn't get this build, or null when it should. */
export async function reasonToSkip(state: StoreState, version: string, built: Files): Promise<string | null> {
  if (state.inReview) return `version ${state.inReview} is still waiting for review`;
  if (!state.published) return null;
  if (compareVersions(version, state.published.version) <= 0) return `it already has version ${state.published.version}`;
  if (sameExtension(built, await state.published.files())) return `version ${state.published.version} has the same extension`;
  return null;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

async function check(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Chrome {
  private token: string;
  private constructor(token: string) { this.token = token; }

  static async connect(serviceAccountJson: string): Promise<Chrome> {
    const key = JSON.parse(serviceAccountJson);
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({
      iss: key.client_email, scope: "https://www.googleapis.com/auth/chromewebstore",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    }))}`;
    const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url")}`;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    return new Chrome((await check(res, "Google sign-in")).access_token);
  }

  private get auth() { return { authorization: `Bearer ${this.token}` }; }

  async state(): Promise<StoreState> {
    const s = await check(await fetch(`${CHROME_API}:fetchStatus`, { headers: this.auth }), "Chrome Web Store status");
    if (s.takenDown) throw new Error("The Chrome Web Store took the item down; see the developer dashboard");
    const submitted = s.submittedItemRevisionStatus;
    const version = s.publishedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion as string | undefined;
    return {
      inReview: submitted?.state === "PENDING_REVIEW" || submitted?.state === "STAGED" ? submitted.distributionChannels?.[0]?.crxVersion ?? "?" : null,
      published: version ? { version, files: async () => unzip(await download(CHROME_CRX)) } : null,
    };
  }

  async send(zip: Buffer): Promise<void> {
    const up = await check(await fetch(CHROME_UPLOAD, { method: "POST", headers: { ...this.auth, "content-type": "application/zip" }, body: new Uint8Array(zip) }), "Chrome Web Store upload");
    let state = up.uploadState;
    for (let i = 0; state === "IN_PROGRESS" && i < 60; i++) {
      await sleep(5000);
      state = (await check(await fetch(`${CHROME_API}:fetchStatus`, { headers: this.auth }), "Chrome Web Store status")).lastAsyncUploadState;
    }
    if (state !== "SUCCEEDED") throw new Error(`Chrome Web Store upload ended ${state}`);
    await check(await fetch(`${CHROME_API}:publish`, { method: "POST", headers: this.auth }), "Chrome Web Store publish");
  }
}

class Firefox {
  private issuer: string;
  private secret: string;
  constructor(issuer: string, secret: string) { this.issuer = issuer; this.secret = secret; }

  // AMO wants a fresh token (unique id, at most five minutes) on every request.
  private get auth() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: this.issuer, jti: randomUUID(), iat: now, exp: now + 60 }))}`;
    return { authorization: `JWT ${unsigned}.${createHmac("sha256", this.secret).update(unsigned).digest("base64url")}` };
  }

  async state(): Promise<StoreState> {
    const list = await check(await fetch(`${AMO_API}/addon/${AMO_ADDON}/versions/?filter=all_without_unlisted`, { headers: this.auth }), "addons.mozilla.org versions");
    const latest = list.results?.[0];
    if (!latest) return { inReview: null, published: null };
    return {
      inReview: latest.file?.status === "unreviewed" ? latest.version : null,
      published: { version: latest.version, files: async () => unzip(await download(latest.file.url, this.auth)) },
    };
  }

  async send(zip: Buffer, source: Buffer, version: string): Promise<void> {
    const form = new FormData();
    form.set("upload", new Blob([new Uint8Array(zip)]), `purss-firefox-${version}.zip`);
    form.set("channel", "listed");
    let upload = await check(await fetch(`${AMO_API}/upload/`, { method: "POST", headers: this.auth, body: form }), "addons.mozilla.org upload");
    for (let i = 0; !upload.processed && i < 60; i++) {
      await sleep(5000);
      upload = await check(await fetch(`${AMO_API}/upload/${upload.uuid}/`, { headers: this.auth }), "addons.mozilla.org validation");
    }
    if (!upload.processed) throw new Error("addons.mozilla.org didn't finish validating the upload");
    if (!upload.valid) throw new Error(`addons.mozilla.org rejected the upload: ${JSON.stringify(upload.validation?.messages?.filter((m: any) => m.type === "error") ?? upload.validation).slice(0, 1500)}`);
    const v = new FormData();
    v.set("upload", upload.uuid);
    v.set("source", new Blob([new Uint8Array(source)]), `purss-source-${version}.tar.gz`);
    await check(await fetch(`${AMO_API}/addon/${AMO_ADDON}/versions/`, { method: "POST", headers: this.auth, body: v }), "addons.mozilla.org new version");
  }
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const sourcePath = argv.find((a) => !a.startsWith("--"));
  if (!sourcePath) throw new Error("usage: stores.ts <source.tar.gz> [--dry-run]");
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
  const source = readFileSync(sourcePath);

  const stores: { name: string; target: string; open: () => Promise<Chrome | Firefox> | null }[] = [
    { name: "Chrome Web Store", target: "chromium", open: () => process.env.CHROME_WEBSTORE_SERVICE_ACCOUNT ? Chrome.connect(process.env.CHROME_WEBSTORE_SERVICE_ACCOUNT) : null },
    { name: "addons.mozilla.org", target: "firefox", open: () => process.env.AMO_JWT_ISSUER && process.env.AMO_JWT_SECRET ? Promise.resolve(new Firefox(process.env.AMO_JWT_ISSUER.trim(), process.env.AMO_JWT_SECRET.trim())) : null },
  ];
  let failed = false;
  for (const s of stores) {
    try {
      const opening = s.open();
      if (!opening) { console.log(`::notice::${s.name}: skipped, its keys aren't set.`); continue; }
      const store = await opening;
      const built = readDir(path.join(dist, s.target));
      const version = JSON.parse(built.get("manifest.json")!.toString("utf8")).version as string;
      const skip = await reasonToSkip(await store.state(), version, built);
      if (skip) { console.log(`::notice::${s.name}: not sending ${version}, ${skip}.`); continue; }
      if (dryRun) { console.log(`${s.name}: would send ${version}.`); continue; }
      const zip = readFileSync(path.join(dist, `purss-${s.target}.zip`));
      if (store instanceof Chrome) await store.send(zip);
      else await store.send(zip, source, version);
      console.log(`::notice::${s.name}: sent ${version} for review.`);
    } catch (e) {
      failed = true;
      console.log(`::error::${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
