/*
 * URL privacy helpers: redaction for logs and diagnostics, and heuristics that spot
 * credential-like components in feed URLs. Heuristics are warning signals only; an
 * address that matches nothing is never "known public" (plan/20).
 */

/** Names that are secrets whatever their value looks like: a word under `pass` or `auth` is a password. */
const SECRET_PARAM = /^(?:token|access_token|auth_token|auth|authkey|api[-_]?key|apikey|secret|sig|signature|sign|password|passwd|pwd|pass|session|sessionid|sid|bearer|jwt|private|passkey|pk|uid_token|feed_token|rsstoken|x-amz-signature|x-amz-credential|x-goog-signature)$/i;
/** Names that are only secrets when their value looks like one: `key=tech-news` is a topic, `key=Zk9aQ2xRbTJw` is a key. */
const AMBIGUOUS_PARAM = /^(?:key|code)$/i;
/** Path pieces that announce a secret in the next piece whatever it looks like. */
const SECRET_PATH_HINT = /^(?:private|secret|token|auth|passkey|apikey|api-key)$/i;
/** Path pieces that announce a secret only when the next piece looks like one (`/access/updates/feed` is a section). */
const AMBIGUOUS_PATH_HINT = /^(?:key|access)$/i;
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
 * show's page and in every directory. On these hosts a uuid or a hex id (an object id) in the path is not taken for a secret; a long
 * mixed-case token still is, and so is a username, a named secret or a `/private/` piece.
 */
const PUBLIC_ID_HOSTS = /(?:^|\.)(?:acast\.com|omnycontent\.com|omny\.fm|pinecast\.(?:com|co)|megaphone\.fm|simplecast\.com|buzzsprout\.com|libsyn\.com|anchor\.fm|transistor\.fm|art19\.com|podbean\.com|audioboom\.com|captivate\.fm|spreaker\.com|soundcloud\.com|redcircle\.com|rss\.com|podtrac\.com|blubrry\.com|castos\.com|fireside\.fm|ausha\.co|podigee\.io|podigee\.com)$/i;

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

/** A hyphenated or underscored slug of words and short numbers ("the-daily-show-2023-season"): a title, not a key. */
function isSlug(value: string): boolean {
  const parts = value.split(/[-_]/);
  return parts.length >= 3 && parts.every((p) => /^[a-z]+$/i.test(p) || /^\d{1,4}$/.test(p)) && parts.filter((p) => /^[a-z]{2,}$/i.test(p)).length >= 2;
}

/** Does this piece of an address look like random secret material? `idHost`: it is a path piece on a host whose ids are public. */
function looksRandom(piece: string, idHost = false): boolean {
  if (PUBLIC_ID.test(piece) || isSlug(piece)) return false;
  if (idHost) return !UUID.test(piece) && !(HEX_ONLY.test(piece) && piece.length <= 32) && MIXED_TOKEN.test(piece);
  // Hex alone is judged by its length: from 80 bits up it is more than an identifier.
  if (HEX_ONLY.test(piece)) return piece.length >= 20;
  return TOKENISH_SEGMENT.test(piece);
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
    // The bridge router's signature (/b/<service>/<key>/<signature>, plan/41), whatever characters it happens to have.
    if (i === 4 && all.length === 5 && all[1] === "b" && /^[A-Za-z0-9_-]{43}$/.test(s)) return "…";
    return s.length > 80 ? `${s.slice(0, 20)}…` : s;
  });
  const tail = url.search ? "?…" : "";
  return `${url.protocol}//${url.host}${segments.join("/")}${tail}`;
}

/** Why a feed address looks like it carries a credential, or null. */
export function privateUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return "username and password in the address";
  for (const [name, value] of url.searchParams) {
    if (value.length >= 6 && (SECRET_PARAM.test(name) || (AMBIGUOUS_PARAM.test(name) && !isPlainWord(value)))) return `a "${name}" value in the address`;
    if (value.length >= 32 && looksRandom(value)) return "a long random value in the address";
  }
  const publicIds = PUBLIC_ID_HOSTS.test(url.hostname);
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    // Long random path pieces such as /feed/3f9a… are typical of per-reader secret links, but YouTube channel ids,
    // dated slugs, the ids of podcast hosts and file names are not.
    if (!/\.(?:xml|rss|atom|json)$/i.test(seg) && looksRandom(seg, publicIds)) return "a long random value in the address";
    if (next !== undefined && (SECRET_PATH_HINT.test(seg) || (AMBIGUOUS_PATH_HINT.test(seg) && next.length >= 8 && !isPlainWord(next) && !isSlug(next)))) return `a "${seg}" section in the address`;
  }
  return null;
}

export function looksPrivateUrl(raw: string): boolean {
  return privateUrlReason(raw) !== null;
}

export const PRIVATE_URL_WARNING =
  "This address looks like it contains a private access key. Treat it like a password: anyone with the link may be able to read your feed. Mark the source private so the link stays out of shared pages and exports.";
