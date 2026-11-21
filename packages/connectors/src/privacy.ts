/*
 * URL privacy helpers: redaction for logs and diagnostics, and heuristics that spot
 * credential-like components in feed URLs. Heuristics are warning signals only; an
 * address that matches nothing is never "known public".
 */

import { server } from "@purss/copy/server";

/** Query parameter names that are secrets whatever their value looks like (a word under `pass` or `auth` is a password): the whole name. */
const SECRET_NAME = /^(?:auth|authkey|sig|sign|pass|passwd|pwd|session|sessionid|sid|bearer|jwt|private|passkey|pk)$/;
/** ...or the name ends in one of these once its separators and capitals are ignored: `token`, `access_token`, `X-Plex-Token`, `feed_token`, `clientSecret`, `api-key`. */
const SECRET_NAME_ENDING = /(?:token|secret|password|passphrase|signature|credentials?|apikey|authkey|accesskey|passkey)$/;
/** ...except a token that only keeps a place in a long list: `pageToken`, `next_token`, `cursor_token`. */
const PAGING_NAME = /(?:page|next|prev|previous|cursor|continuation|paging)token$/;
/** Names that are only secrets when their value looks like one: `key=tech-news` is a topic, `key=Zk9aQ2xRbTJw` is a key (`feed_key`, `userKey`, `code`). */
const AMBIGUOUS_NAME = /^(?:code|.*key)$/;
/** Path pieces that announce a secret in the next piece whatever it looks like. */
const SECRET_PATH_HINT = /^(?:private|secret|token|auth|passkey|apikey|api-key)$/i;
/** Path pieces that announce a secret only when the next piece looks like one (`/access/updates/feed` is a section). */
const AMBIGUOUS_PATH_HINT = /^(?:key|access)$/i;
/** Path pieces that name a feed or a person's own feed: a random-looking piece right after one is that feed's key (`/feed/3f9a…`, `/u/3f9a…/rss`). */
const PERSONAL_PATH_HINT = /^(?:feeds?|rss|atom|u|users?|subscribers?|members?|listeners?|subscriptions?|personal|premium|plus)$/i;
/** A path piece that names the next one as an identifier (`/product/id/3D5C…`): a hex id or uuid after it is not a secret. */
const ID_PATH_HINT = /^ids?$/i;
/** Public YouTube channel and playlist ids look random but are not credentials. */
const PUBLIC_ID = /^(?:UC|UU)[A-Za-z0-9_-]{22}$|^(?:PL|FL|OLAK5uy_)[A-Za-z0-9_-]{10,}$/;
/** A long run of letters and digits with at least one digit: base62 or base64 material. */
const TOKENISH_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{24,}$/;
const HEX_ONLY = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mixed case and digits, 20 or more: a token even where ids are expected. */
const MIXED_TOKEN = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{20,}$/;
/**
 * Hosts that publish podcast feeds at addresses made of ids (a show's id, a playlist's uuid). Those ids are public: they are in the
 * show's page and in every directory. On these hosts a uuid or a hex id (an object id) after a word like `feed` is not taken for a
 * secret; a long mixed-case token still is, and so is a username, a named secret or a `/private/` piece.
 */
const PUBLIC_ID_HOSTS = /(?:^|\.)(?:acast\.com|omnycontent\.com|omny\.fm|pinecast\.(?:com|co)|megaphone\.fm|simplecast\.com|buzzsprout\.com|libsyn\.com|anchor\.fm|transistor\.fm|art19\.com|podbean\.com|audioboom\.com|captivate\.fm|spreaker\.com|soundcloud\.com|redcircle\.com|rss\.com|podtrac\.com|blubrry\.com|castos\.com|fireside\.fm|ausha\.co|podigee\.io|podigee\.com)$/i;

/**
 * Feed addresses of services whose feeds are one member's own, however the address is written. Each shape is one the service documents or
 * shows its members; a service that is not here is judged by the rules above, not taken for public.
 */
const PRIVATE_FEED_SHAPES: readonly { host: RegExp; path: RegExp; reason: string }[] = [
  { host: /(?:^|\.)patreon\.com$/i, path: /^\/rss\//i, reason: "a Patreon members' feed" },
  { host: /(?:^|\.)github\.com$/i, path: /\.private(?:\.actor)?(?:\.atom)?$/i, reason: "a GitHub private feed" },
  { host: /(?:^|\.)feedbin\.com$/i, path: /^\/starred\/[A-Za-z0-9_-]{16,}\.xml$/, reason: "a Feedbin starred-entries feed" },
  { host: /^feeds\.transistor\.fm$/i, path: /^\/[a-z0-9-]+-u[0-9a-f]{16}$/, reason: "an unlisted podcast feed" },
  { host: /(?:^|\.)memberful\.com$/i, path: /^\/account\//i, reason: "a Memberful member's feed" },
  // Pinboard's feeds of private bookmarks: `/rss/secret:<token>/u:<name>/private/`, with the token in the path.
  { host: /^feeds\.pinboard\.in$/i, path: /^\/[a-z]+\/secret:[^/]+\//i, reason: "a Pinboard private feed" },
  // A Ghost site in private mode serves its feed, without a login, at the site's `public_hash`: 15 random bytes, so 30 hex characters,
  // right before `rss`, whichever path leads there (`/<hash>/rss/`, `/tag/<slug>/<hash>/rss/`) and on the site's own domain.
  { host: /./, path: /\/[0-9a-f]{30}\/rss(?:\/\d*)?\/?$/i, reason: "a private Ghost site's feed" },
];

/** A run of letters that can be said: short, or with vowels spread through it and no long stretch of consonants. */
function readsLikeWord(part: string): boolean {
  if (part.length <= 12) return true;
  const vowels = part.replace(/[^aeiouy]/g, "").length;
  return vowels / part.length >= 0.3 && !/[^aeiouy]{5,}/.test(part);
}

/** Lowercase words with separators ("tech-news", "sports_extra") that read like words: a name, not a key. */
export function isPlainWord(value: string): boolean {
  return value.length <= 40 && /^[a-z]+(?:[-_.][a-z]+)*$/.test(value) && value.split(/[-_.]/).every(readsLikeWord);
}

/** A hyphenated or underscored slug of words and numbers ("the-daily-show-2023-season", "…-yorkshire-4912345"): a title with an id, not a key. */
function isSlug(value: string): boolean {
  const parts = value.split(/[-_]/);
  return parts.length >= 3 && parts.every((p) => /^[a-z]+$/i.test(p) || /^\d{1,12}$/.test(p)) && parts.filter((p) => /^[a-z]{2,}$/i.test(p)).length >= 2;
}

/** Does this piece of an address look like random secret material? `idHost`: it is a path piece on a host whose ids are public. */
function looksRandom(piece: string, idHost = false): boolean {
  if (PUBLIC_ID.test(piece) || isSlug(piece)) return false;
  if (idHost) return !UUID.test(piece) && !(HEX_ONLY.test(piece) && piece.length <= 32) && MIXED_TOKEN.test(piece);
  // Hex alone is judged by its length: from 80 bits up it is more than an identifier.
  if (HEX_ONLY.test(piece)) return piece.length >= 20;
  return TOKENISH_SEGMENT.test(piece);
}

/**
 * Random material that is a key without anything around it saying so: base62 or base64 of mixed case that changes case as random letters
 * do (a CamelCase title does not), or a hex string of 160 bits or more. A uuid, an object id or an md5 is an identifier at least as
 * often as a key, so it counts only after a word that names a feed's key (see `looksRandom`).
 */
function looksMachineMade(piece: string, hexOk = true): boolean {
  if (PUBLIC_ID.test(piece) || isSlug(piece)) return false;
  if (HEX_ONLY.test(piece)) return hexOk && piece.length >= 40;
  if (!/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{22,}$/.test(piece)) return false;
  let changes = 0;
  const kind = (c: string): number => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
  for (let i = 1; i < piece.length; i++) if (kind(piece[i]!) !== kind(piece[i - 1]!)) changes++;
  return changes / piece.length >= 0.4;
}

/**
 * Could a query parameter be a credential, however short its value? A name that says so (`token`, `api_key`, `sig`; never a paging
 * token) always; a name that could be a topic (`key`, `code`) unless its value is a word.
 */
export function mayBeCredentialParam(name: string, value: string): boolean {
  const bare = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_NAME.test(bare) || (SECRET_NAME_ENDING.test(bare) && !PAGING_NAME.test(bare))) return true;
  return AMBIGUOUS_NAME.test(bare) && !isPlainWord(value);
}

/** Is a query parameter's name that of a credential, given its value? A value under six characters is too short to be one here. */
export function isCredentialParam(name: string, value: string): boolean {
  return value.length >= 6 && mayBeCredentialParam(name, value);
}

/** Remove userinfo, query string, fragment and token-looking path segments. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[invalid address]";
  }
  const segments = url.pathname.split("/").map((s, i, all) => {
    if (!s) return s;
    const prev = all[i - 1] ?? "";
    if (TOKENISH_SEGMENT.test(s) || /^[0-9a-f]{20,}$/i.test(s) || SECRET_PATH_HINT.test(prev) || AMBIGUOUS_PATH_HINT.test(prev)) return "…";
    // Pinboard's private feeds carry the token after its name: `secret:<token>`.
    if (/^secret:./i.test(s)) return "secret:…";
    // The bridge router's signature (/b/<service>/<key>/<signature>), whatever characters it happens to have.
    if (i === 4 && all.length === 5 && all[1] === "b" && /^[A-Za-z0-9_-]{43}$/.test(s)) return "…";
    // The feed gateway's signature and address (/t/<signature>/<address>): the address is the feed's own, base64 of it, private links included.
    if ((i === 2 || i === 3) && all.length === 4 && all[1] === "t" && /^[A-Za-z0-9_-]{43}$/.test(all[2]!) && /^[A-Za-z0-9_-]+$/.test(s)) return "…";
    return s.length > 80 ? `${s.slice(0, 20)}…` : s;
  });
  const tail = url.search ? "?…" : "";
  return `${url.protocol}//${url.host}${segments.join("/")}${tail}`;
}

/**
 * Why a feed address looks like it carries a credential, or null. It looks for what says "key" rather than for what looks random: a
 * username or password in the address, a query parameter named like a credential, a path piece that announces one (`/private/`), the
 * known private-feed shapes of services (Patreon, GitHub, Feedbin, Memberful, Pinboard, private Ghost sites, unlisted podcasts), and random material (a uuid, hex, base64)
 * right after a word that names a feed's own key (`/feed/`, `/u/`). Random material on its own counts only when it is unmistakably
 * machine-made (a mixed-case token, 160 bits of hex): the ids of public feeds, which are often uuids or hex, are not taken for keys.
 */
export function privateUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return "username and password in the address";
  for (const [name, value] of url.searchParams) {
    if (isCredentialParam(name, value)) return `a "${name}" value in the address`;
    if (value.length >= 32 && looksMachineMade(value)) return "a long random value in the address";
  }
  const shape = PRIVATE_FEED_SHAPES.find((f) => f.host.test(url.hostname) && f.path.test(url.pathname));
  if (shape) return shape.reason;
  const publicIds = PUBLIC_ID_HOSTS.test(url.hostname);
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    // A key in a file name (`/feed/Lx3E5w94M3mOKFtcttHK8w.xml`) is judged without its ending; a hex name (`<commit>.atom`) is a file, not a key.
    const piece = seg.replace(/\.(?:xml|rss|atom|json)$/i, "");
    const idPiece = publicIds || (prev !== undefined && ID_PATH_HINT.test(prev));
    if (looksMachineMade(piece, piece === seg && !idPiece)) return "a long random value in the address";
    if (prev !== undefined && PERSONAL_PATH_HINT.test(prev) && looksRandom(piece, idPiece)) return "a long random value in the address";
    if (next !== undefined && (SECRET_PATH_HINT.test(seg) || (AMBIGUOUS_PATH_HINT.test(seg) && next.length >= 8 && !isPlainWord(next) && !isSlug(next)))) return `a "${seg}" section in the address`;
  }
  return null;
}

export function looksPrivateUrl(raw: string): boolean {
  return privateUrlReason(raw) !== null;
}

export const PRIVATE_URL_WARNING =
  server.sources.connectors.privacy.warning;
