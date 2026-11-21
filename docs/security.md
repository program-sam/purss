# Security and privacy

How PURSS protects accounts, content and the network around it, as the code does today, and what
the people who run it can see. [Self-hosting](self-hosting.md#security-notes) lists the settings an
operator chooses and the deployment notes; [Architecture](architecture.md) describes the
components; the [user guide](user-guide.md) describes the same controls from the person's side. This
page describes controls. It is not an independent security review.

PURSS is not end-to-end encrypted. The server reads the text it stores, and so does anyone who
controls the machine it runs on. The controls below limit what people, apps and assistants can do
through PURSS; none of them limits someone with access to the host ([What the operator
can see](#what-the-operator-can-see)).

To report a vulnerability, see [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

**Assets.** Each account's library (items, saved text, notes, highlights, baskets), the credentials
that reach it, the installation's secrets, and the server's position on the network.

**Untrusted input.** Everything that arrives from outside: pasted addresses, feeds and the pages they
link to, redirects, article HTML, import archives, images and media metadata, connector output, and
the text of publishers that an assistant or a Smart filter reads.

**Attackers the controls are built against.**

- A source or site that tries to make the server reach internal addresses, or to exhaust it with
  large, slow, deeply nested or compressed responses.
- A web page that sends cross-site requests to someone's PURSS.
- Another account on the same installation.
- Someone who steals a session cookie, a device token, an assistant token or a backup.
- Someone who sees a private feed link, a sign-in link or a one-time code.
- A publisher whose text reaches an assistant or a Smart filter.
- A hostile server that a phone or desktop app is connected to.

**Not defended against.** Someone who controls the host; malware on a person's own device; and,
beyond the isolation described below, a compromised FreshRSS, which holds the subscriptions and
entries of every account.

## Components and trust boundaries

| Component | Holds | Boundary |
| --- | --- | --- |
| Browser, phone and desktop apps, extension | A session cookie or a device token | Untrusted. Every request is authenticated and scoped to the account's workspace by the API |
| API (`apps/api`) | The product database (its only writer) and the secrets folder | A public listener for people, apps and assistants, and an internal listener that accepts only the service token and serves only the worker's routes |
| Worker (`apps/worker`) | The secrets folder, read and write | Leases jobs from the internal listener and never opens the database. It fetches and parses untrusted pages for readable text, so it is not a sandbox |
| Egress (`apps/egress`) | The service token, the bridge key and the feed-trim key | Forward proxy that is the only way out for FreshRSS and RSS-Bridge; feed gateway and bridge router that answer only signed addresses; a control listener that accepts only the service token |
| FreshRSS | Every account's subscriptions and entries, the operator account's credentials and the admin helper's token | Parses hostile feeds in PHP. Internal network only, no published port, no route out except egress, administered only through a fixed helper |
| RSS-Bridge | Nothing of the product's | Its own network, with egress as its only peer. Pinned by digest, only the catalogued bridges enabled. Its XPathBridge runs only the recipes the router passes it ([Page lists](sources.md#page-lists)) |
| Push relay (`apps/push-relay`) | The project's FCM and APNs credentials and each phone's push address | Run by the project, apart from any PURSS. Wakes a phone by handle and carries no content |

Under Compose the containers sit on four networks. All but `outside` have no route to the internet.

| Network | Members | What it is for |
| --- | --- | --- |
| `internal` | API, worker, egress, FreshRSS | FreshRSS reaches egress and answers the worker's helper calls |
| `services` | API's internal listener, worker, egress control | Worker jobs and egress status. FreshRSS is not on it, so code running there can't reach them even with a stolen token |
| `bridge-net` | RSS-Bridge, egress | RSS-Bridge's requests go to egress's proxy and its name lookups to egress's resolver, which answers only public addresses |
| `outside` | API, worker, egress | The only members that reach the internet |

The API, worker and egress run as the same unprivileged user and mount the same data volume (which
holds `product.db`) and secrets volume, so what limits each one's access is what its code reads, not
file permission. FreshRSS is the exception: it can read only two secret files. It is administered only
through `/purss/admin.php`, which accepts a bearer token of its own (`engine-helper-token`, never the
service token) and runs a closed set of five FreshRSS scripts and three snippets matched by SHA-256,
with arguments restricted to a safe character set. [`infra/README.md`](../infra/README.md) and
[engine operation](../infra/engine/README.md) have the packaging; a local run without Compose
confines FreshRSS less ([self-hosting](self-hosting.md#security-notes)).

Tenancy is one workspace per account, each with its own FreshRSS user. Product queries start from the
principal resolved from the session or token and enforce its ownership (`account_id` or
`workspace_id`, directly or through an owned parent row). Tests cover the boundary feature by feature
(listing, reading, keeping, annotations, sync and imports). FreshRSS
shares its fetch cache across its users, keyed by feed address, so accounts that follow one public
feed cost one request per refresh while each stores its own entries.

## Fetching addresses on behalf of people

Every request the server makes to an address that a person, a feed or a page supplied goes through one
fetcher (`safeFetch`, `packages/connectors/src/safe-fetch.ts`), or, for FreshRSS and RSS-Bridge,
through the egress proxy. That covers discovery and previews, readable-text capture, link metadata,
source icons, kept pictures, frame checks, assistants' client documents, the push relay wake, and the
Wikidata, Crossref, podcast-directory and Bluesky lookups.

- Only `http` and `https`; no user name or password in the address; at most 2,048 characters; no port
  from a list of well-known non-web ports (SSH, SMTP, databases, Redis, Docker and the like).
- Names without a dot, and names ending in `.localhost`, `.local`, `.internal`, `.lan`,
  `.home.arpa`, `.corp`, `.home` and similar, are refused before DNS. That is only a clearer early
  message: the resolved addresses decide.
- Every address a name resolves to is checked, and one forbidden answer refuses the whole name. The
  connection is then bound to the checked addresses, so a second lookup can't redirect it. Refused
  ranges cover loopback, private, link-local, shared (CGNAT), documentation, benchmarking, multicast
  and reserved space, the cloud metadata addresses (AWS, GCP, Azure, Alibaba), and IPv6 forms that
  embed an IPv4 address (mapped, compatible, NAT64, 6to4).
- Redirects are followed by the fetcher, never by the HTTP stack: at most 5, each hop checked again,
  credentials headers not forwarded.
- Budgets: 2 MiB of decompressed body by default (32 MiB at most, 128 MiB when a body is read as a
  stream and never held), 20 seconds overall, with limits on DNS, connection, first byte and silence.
  Feeds and pages nested deeper than 512 elements are refused.
- No setting or environment variable turns the rules off. Tests that need a loopback server pass an
  in-process argument.

The egress proxy applies the same rules to FreshRSS and RSS-Bridge. It serves only absolute-form `GET`
and `HEAD` and `CONNECT` tunnels, refuses request bodies, resolves and checks each request and each
redirect hop (which reaches it as a separate request), pins the outgoing connection, and checks the connected
address again. By default it allows 256 connections, 60 seconds and 32 MiB per response, and 120
seconds and 64 MiB per tunnel. It binds only loopback or a private address, and logs a redacted path (no user
information, query string, fragment or token-like path piece). The only exceptions are exact
host-and-port pairs the operator lists, which map to a fixed address and can't be tunnelled, and which the
proxy on RSS-Bridge's network doesn't have (RSS-Bridge follows redirects and checks only its first address, so a
redirect to the feed gateway's or the bridge router's alias is refused there like one to any private address). The feed
gateway and the bridge router answer only addresses signed with a key (`feed-trim-key`, `bridge-key`)
that FreshRSS never reads, so a feed that redirects FreshRSS can't make them fetch anything that was
not signed ([Sources](sources.md#identity-and-signed-addresses)).

**Page lists.** The one bridge that is given a page and expressions instead of a handle is XPathBridge, for a list of posts the detector found on a page
that has no feed ([Sources](sources.md#page-lists)). What reaches it is what the router derives from a signed key: a page and four XPath expressions,
read back only when they are exactly what PURSS's writer makes: an inflate cap of 4 KiB, an http(s) address that passes the address rules (no login, no private
or internal host, none that looks to carry a key), and expressions inside a fixed XPath 1.0 grammar (class and attribute tests, child and descendant steps, one
union or one `concat`; no `document()`, variable, extension function or regular expression). It is given no cookie, header, content or other XPathBridge parameter. It
fetches the page once per check through the egress proxy, which resolves and checks every hop, and RSS-Bridge's own refusal of a private or reserved first
address stays on. The key is made only by the detector, and a descriptor pasted from an archive is read the same way, so a hand-made one can only select text and links
from a public page. XPathBridge's answer is parsed by the router as an untrusted feed, like any other. No script of the page runs, in discovery or in the bridge.

Addresses the operator fixes (the SMTP server, OIDC issuers, the Jev address, the billing service)
are not user input and are not subject to these rules. The push relay's address is one of them but is
still reached through the fetcher, so it can't be a local or private address. Jev requests refuse
redirects.

**Private feed links.** A source whose address is a secret (a members' feed with a key in it) is
stored as a file under `secrets/source-urls/`, never in the database, in job payloads, in exports,
in logs or in a shared page. The secret link itself is never used for an icon or a directory lookup.
FreshRSS holds the address, since it must fetch it. Whether an address looks private is a heuristic
that only warns; the per-source private flag, set when the source is followed, decides.

## Accounts and sign-in

Sign-in is an email address and password for every account except one made by signing in with a
provider. A passkey and linked providers are optional extra ways in. There are no user names. Each
address belongs to one account, compared without regard to case, and the account's internal id stays
the key, so the address can change. Email never links accounts or grants a role.

- **Passwords.** 10 to 256 characters, not equal to the account's address. Stored as scrypt
  (N=2^15, r=8, p=1) with a random salt. An unknown address costs the same time as a wrong password.
  The password can be changed or reset but never removed.
- **Passkeys.** WebAuthn discoverable credentials, attestation not requested, user verification
  preferred. The relying party is the host name of `PURSS_PUBLIC_ORIGIN`: changing that host makes
  passkeys unusable until they are added again, and the password keeps working. The phone apps use
  the PURSS's passkeys only where the operator vouches for them (`PURSS_APP_ANDROID_CERT_SHA256`,
  `PURSS_APP_IOS_APP_ID`), through `/.well-known/assetlinks.json` and
  `apple-app-site-association`.
- **Providers (OpenID Connect).** Authorization code with PKCE (S256), `state` and `nonce`. A random
  value is also kept in an HttpOnly cookie in the starting browser, and the callback must present it,
  so a callback address replayed in another browser fails. Identities bind by validated issuer and
  subject, never by email. Provider tokens are not stored: only the issuer, subject and label are.
  Linking is an action of a signed-in account with a recent sign-in. Where open sign-up is on, an
  unlinked identity makes an account only if the provider says `email_verified` and no account has
  that address; otherwise nothing is made or linked. A provider-created account has no password and
  no administrator role.
- **Last way in.** A passkey can be removed only while a password or a configured provider remains; a
  provider only while a password remains. A stored sign-in for a provider no longer in `PURSS_OIDC`
  counts as nothing.

**Guessing.** Password sign-in allows 10 attempts per 10 minutes per network address and 10 tries per
15 minutes per email address. A browser or app that has signed in to the account before carries a
signed value that gives it tries of its own and skips the address limit (so someone spending the shared
tries can't lock the account's person out of a browser they use); the value stops counting when the
password changes. The tries are taken before the password is checked, so parallel guesses can't slip
past, and a correct password gives them back. The setup code and invitations are limited to 10 attempts
per 10 minutes per address.

**Making accounts.**

- *First account.* An unclaimed installation writes a one-time setup code to `secrets/setup-code`
  (mode 0600), keeps only its scrypt hash, and removes the file once an account claims it. Sign-up is
  closed until that account exists. The claimant is the first administrator.
- *Invitations.* An administrator types the address. The code (about 99 bits) is stored as a SHA-256
  hash, is valid for 1 to 60 days, and the person types the address again to accept. Where email is
  set up the code is emailed only to that address, which confirms it. Invitations never grant
  administration.
- *Open sign-up* (hosted mode with working email only). It starts with an address; a single-use link
  goes there and the account is made only when the link is used, so every such account has a confirmed
  address. Limits: 30 attempts and 10 accounts an hour per network address (kept as a salted hash for
  an hour), 3 sign-up emails an hour per email address, and `PURSS_SIGNUP_DAILY_LIMIT` accounts a day
  (50 by default).

**Enumeration.** Signing in, starting sign-up and asking for a password reset answer the same whether
or not an address has an account. Starting sign-up with an address that has one sends that address a
note with sign-in and reset links instead of a sign-up link. Two paths do say that an address is taken:
a signed-in person changing their own address to one another account uses, and an administrator
inviting an address that has an account.

**Confirm it's you.** Sensitive actions need a sign-in within the last 10 minutes. The password, a
passkey or a linked provider confirms it; a phone app's connection has its own clock. These need it:
adding a passkey; removing a sign-in method; linking a provider; adding a first password to a
provider-only account; changing the account's address; deleting the account; connecting an app or an
assistant; creating an assistant token; and the administrator actions that change accounts, access
or what reaches every account (invitations, account changes, the administrator role, the Smart
filter key, the assistant switch, takedowns, publishing news). Changing a password takes the current
password however recent the sign-in. Password guesses here are limited to 10 per 10 minutes per
session and 50 an hour per account.

Providers confirm in one of two modes, set per provider in `PURSS_OIDC` (`stepUp`). `reauthenticate`
(the default) forces the provider to ask again (`prompt=login`, `max_age=0`) and refuses an ID token
without a fresh `auth_time`. `choose-account` (the default for Google, which can't be made to ask
again) only shows the account chooser, which proves less than a password does, so it confirms an
account only when that account has no password and no passkey.

**Recovery.** There are two ways, both ending in the ordinary "choose a password" page:

- *By email*, where the installation sends email: a single-use link, valid for an hour, sent to the
  account's confirmed address. It works for accounts with a password and not for administrators. At
  most 10 requests an hour per network address, 5 per email address and 3 links per account.
- *From the operator*, for installations without email, accounts without a confirmed address and
  administrators: `node apps/api/src/cli.ts password-reset-link <account>` prints a single-use link,
  valid for 60 minutes and tied to no address, and records a host-level audit event. It refuses an
  account without a password or one whose removal has started.

Choosing a password through either link signs the account out everywhere (browser sessions, connected
apps, assistant tokens and OAuth grants, pending codes and unused email links) and tells the confirmed
address. An account made by a provider has no password to reset: its recovery is a password it added
beforehand. Changing the password in Settings ends the same, except the browser session or connected app
the change is made from.

**Deleting an account.** The owner confirms with a recent sign-in. The account is signed out
everywhere, its public pages stop, and signing in during the following 7 days offers to keep it. After
that the product data and files are removed and the worker removes the FreshRSS user. Only the audit
log keeps the bare account id.

## Sessions, requests and the browser

- **Session cookie.** `purss_session` is 32 random bytes, stored only as a SHA-256 hash, `HttpOnly`,
  `SameSite=Lax`, and `Secure` when `PURSS_PUBLIC_ORIGIN` is https. It lasts 30 days and is extended as
  it is used. Choosing "This is a shared computer" makes a session that ends when the browser closes
  or after 8 hours and is not extended. Settings → Security lists sessions (with the browser's own
  description) and ends others.
- **Return paths.** After signing in, a person is sent on only to a path on the PURSS itself: an
  address that starts `//` or holds a backslash or control character is refused.
- **Mutations.** Every `POST`, `PUT`, `PATCH` and `DELETE` from a browser needs an `Origin` header equal
  to the public origin (a missing one is refused) and, when signed in, the session's `X-PURSS-CSRF`
  value, compared in constant time.
- **Response headers.** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that
  denies camera, microphone and location. The API does not send HSTS; the operator's proxy can.
- **Content-Security-Policy** on the app's pages: scripts, styles, fonts and API calls from the same
  origin only (no inline or eval scripts; inline styles are allowed); images from any https address
  and `data:`; audio and video from https; frames from `https:` and `http:` for the reader's players
  and originals (below); no plugins, no `<base>`, forms only to the same origin, and the page can't be
  framed.
- **Request bodies.** A body must keep arriving: a stalled or trickling one is dropped. Signed-out
  bodies are at most 64 KB and signed-in bodies 1 MB unless a route allows more (a browser capture,
  8 MB; imports stream to disk). Bodies held in memory are budgeted per account and per network
  address ([self-hosting](self-hosting.md#security-notes) has the figures).
- **Rate limits** are counted in the API process's memory and reset when it restarts, except sign-up
  capacity and assistant token refreshes, which are counted in the database. Behind a reverse proxy
  `PURSS_TRUST_PROXY` names the proxy that may say who the visitor is (only its right-most
  `X-Forwarded-For` hop is used); without it, every visitor shares the proxy's address.
- **No stored addresses.** PURSS stores no visitor's IP address in its database. The only trace is the
  salted hash used by the sign-up limit, kept for an hour.

## Administrators and the audit log

The administrator role is separate from owning an account. The first account claims it with the
setup code; invitations and provider sign-up never grant it. An administrator grants or removes it
for another account with a recent sign-in. An administrator can't suspend their own account or remove
their own role, and the last active administrator can't be removed or suspended. A suspended
account can't sign in and its sessions, apps and codes end at once (assistants stop being accepted and
resume with the account).

The Administration area has fixed, audited operations: health, jobs (retry or cancel), accounts
(display name, email address, status, storage use, limits), invitations, reports about shared pages,
Smart filter and assistant switches, the installation's news and the audit log. It shows no item
titles, reading history, notes, tokens or sign-in details; the one trace of what accounts follow is
the bridge log's list of failing public sources (a Telegram channel name, for instance), kept with no
account. It has no impersonation, content browser, database console, shell, generic fetch proxy or
token viewer. The one piece of content an administrator sees is a reported public page, shown as
visitors saw it in a sandboxed frame with its links disabled.

**Audit log.** Each event has a time, the acting account (none for a visitor or a host-level command),
an action, a target, an outcome and an optional detail. It covers sign-ins and failures, changes to
sign-in methods, password and address changes, app connections and revocations, assistant tokens and
grants, invitations, administrator changes, exports and imports, sharing, reports and takedowns,
account deletion, and operator CLI commands (`cli_*`). It holds no content, secrets or IP addresses;
addresses are masked and error texts are redacted. PURSS never deletes audit events, and they keep
the bare account id after an account is deleted.

## Connected apps

The phone and desktop apps (client kind `mobile`) and the browser extension (`extension`) are other
programs, so they can't use the session cookie and its same-origin and CSRF checks. They connect with
a code and PKCE, then use a device token. The kinds, return addresses and permissions are fixed in
code: there is no client registration or setup for an operator.

1. The app makes a random verifier and sends only its SHA-256 challenge (`S256`; no other method) to
   `/connect` in the system browser, with its kind, return address, state and device name.
2. The person signs in there, checks the kind, return address and name, and approves with a POST that
   passes the browser checks above and needs a recent sign-in. The page can't be framed.
3. The browser goes to the app's return address with a one-time code, `state` and `iss` (the PURSS's
   origin, so an app that knows several can tell which answered).
4. The app posts the code and its verifier to `/api/connect/token` and receives the device token once.

- **Return addresses** are checked against fixed rules before anything is shown or issued, so the
  page can't be an open redirect. `mobile`: exactly `purss://connect`. `extension`:
  `https://<32 letters>.chromiumapp.org/…` or `https://<40 hex>.extensions.allizom.org/…` with no
  query, fragment, port or credentials. Firefox's loopback form is refused: any local program could
  listen there. A malicious app on the device that registers `purss://` is a residual risk of any
  custom scheme; without the verifier it gets nothing from a code.
- **Codes.** Redirect codes are 32 random bytes; the code typed in by an app that can't receive a
  redirect (Safari) is 12 characters from a 31-letter alphabet, about 59 bits. A code lasts 5
  minutes, is single use, is stored as a SHA-256 hash, and is bound to the challenge, the kind and
  the exact return address. Any failed exchange burns it, so whoever intercepts one gets one try.
  The verifier is compared in constant time. Exchanges are limited to 30 per 10 minutes per address
  and approvals to 30 per 10 minutes per account.
- **Tokens.** `purss_dev_` plus 32 random bytes, shown once, stored as a SHA-256 hash, looked up on
  every request, so revoking one applies to the next request and closes that app's open event
  stream. A token stops working 90 days after its last use (the last use is written at most hourly),
  and an account has at most 20. There are no refresh tokens: PURSS doesn't rotate a device token, so
  one lasts until it is revoked or goes 90 days unused. Revocation: Settings → Connected apps, the app
  itself, suspension, a password reset (by email or from the operator), and deleting the account.
- **Reach.** The phone and desktop token is a full sign-in: a token of an administrator's account acts
  as an administrator, and it has its own "confirm it's you" clock that confirming refreshes. The one
  thing it can't do is approve another app's connection or an assistant's sign-in; those belong to the
  browser that app opened. The extension's token reaches an exact list of routes (read its session, baskets and
  collections; look up, search, keep a link or a page's text, find and follow a source; disconnect
  itself) and is never an administrator or a recent sign-in. The check runs on the route the router
  matched, and routes answer only their canonical path (no empty segment, trailing slash or encoded
  slash), so no other spelling reaches a route the check didn't see.
- **Bearer requests skip the Origin and CSRF check** because forgery needs a credential the browser
  attaches by itself, and a browser never attaches this one. A bearer request ignores cookies, and an
  invalid token is refused, never replaced by a cookie. A device token sent from any other web page is
  refused.
- **CORS** is answered only for the apps' own origins (`capacitor://localhost`, `https://localhost`,
  `http://localhost`, `tauri://localhost`, `http://tauri.localhost`, and `chrome-extension://`,
  `moz-extension://` and `safari-web-extension://` pages, whose ids aren't pinned), only for requests
  that carry a token and the endpoints an app uses before it has one (server information, the code
  exchange, signing in and creating an account), and never with credentials. The list grants nothing
  by itself: without a token, a request from an app origin is an ordinary cookie request and fails the
  Origin check.
- **Storage.** The phone app keeps the token in the Keychain (this device only) or the Android
  Keystore; the desktop app in the system credential store (a file readable only by the user where
  there is none); the extension in its local storage, never synced and sent only as a bearer header.
- **Addresses.** The apps and the extension use `https` for a PURSS, and plain `http` only for this
  device, private and shared ranges and local-only names, with a warning when it isn't loopback.
- **Phishing and persuasion.** A link that starts a connection for someone else's app meets an approval
  page that names the kind and the return address, needs a recent sign-in and says to connect only what
  you started. A code is bound to the challenge of whoever started the request, so reading one out to
  someone else gains them nothing unless they hold its verifier.
- **Providers in an app.** An app can't show a provider's page (Google refuses embedded web views),
  so it asks for a single-use ticket (5 minutes) and opens the system browser. That browser changes
  nothing: it hands a single-use code back to `purss://connect`, and the app redeems it with its own
  token and a verifier only it holds. A ticket address handed to someone else can't attach their
  identity, and a stolen token can't have the owner confirm for it.

## Browser extension

The manifest asks for `activeTab`, `scripting`, `storage`, `contextMenus` and (not Safari)
`identity`, plus an optional `tabs` permission that is requested only when the person turns on the
toolbar mark. It has no host permissions, declares no content scripts and has no cookies or web
request access. A page is read only when the person opens the popup or the right-click menu on it.

- The extension sends addresses, never feed contents, and only to the PURSS it is connected to. The
  server does the fetching, through the rules above.
- Deep links and bookmarklets only open a PURSS page: Add source fills in an address and waits for
  Find; Keep asks which basket and waits for a press. A site that links to a deep link can't make the
  server fetch anything.
- The toolbar mark, which looks up each page opened in a normal window, is off by default, skips
  private windows, and caches answers for 10 minutes.
- Connecting checks that the answer carries the attempt's `state` and names the PURSS it was started
  against (`iss`), and that the server's own information names the address typed, so a code from
  another attempt or another PURSS is not exchanged.
- A browser capture sends the readable text of a page as the browser showed it, which can include
  pages behind the person's own sign-in. It is on request only, at most 2,000,000 characters and 8 MB
  of body, 60 per 10 minutes per account. The server fetches nothing, sanitizes the HTML again with its
  allowlist, stores it labelled as the person's browser showed it (it can't confirm the page matched
  the original), keeps at most one per item, and counts it against storage.

## Assistants

Assistant access (the `/mcp` endpoint) is off until an administrator turns it on for the installation
and a person turns it on for their account. [Assistants](assistants.md) has the tools and endpoints;
this is the security model.

- **Who it acts as.** The token's account, never an administrator and never a recent sign-in. The
  tools can't delete anything permanently, share, export, change sign-in methods or administer
  ([what is not offered](assistants.md#what-is-not-offered)).
  Cookies are ignored at `/mcp`, and a request with another web origin is refused (DNS rebinding).
- **Personal access tokens.** `purss_mcp_` plus 32 random bytes, stored as a SHA-256 hash, at most 20
  per account, created only with a recent sign-in, with a level of read or read and organise and an
  optional expiry. 120 calls a minute per token; write calls are audited.
- **OAuth.** On in hosted mode (over https) and off elsewhere unless `PURSS_ASSISTANT_OAUTH=on`, which
  needs an https origin. Authorization code with PKCE (S256), no client secret and no registration:
  an assistant names itself with a client ID metadata document at an https address, which the server
  fetches through the fetcher above (5 kB, 5 seconds, no redirects, status 200 only, 30 uncached
  fetches per account per 10 minutes, cached up to a day) and only when a signed-in person's consent
  page asks. The document must list the return address; matching is exact, except any port on
  `localhost`, `127.0.0.1` and `[::1]`. The consent page shows the client's own name (stripped of
  control and direction-changing characters, at most 80) next to the host that vouches for it and the
  host the code goes to, warns for loopback return addresses, and approving needs a recent sign-in (30
  per 10 minutes). The person may allow less than asked, never more.
- **Tokens.** Access tokens (`purss_oat_`, 32 random bytes) last an hour. Refresh tokens
  (`purss_ort_<grant>.<generation>.<nonce>.<mac>`) rotate on every use; the mac is an HMAC-SHA256 under
  `secrets/oauth-refresh-key`. A refresh token used a second time, or an authorization code used a
  second time, revokes the whole grant, which detects a copied token whichever holder uses it. Only
  hashes of current tokens are stored, and a refresh token can end a grant only with a valid mac, so a
  grant id (which Settings and the audit log show) isn't enough. A grant ends 90 days after its last
  refresh; an account has at most 20; refreshes are limited to 30 an hour per grant and 120 an hour
  per account. Revoking either token at `/oauth/revoke` ends the grant.
- **Audience.** A grant records `<origin>/mcp` and `/mcp` accepts only tokens for its own current
  address; OAuth tokens are never accepted on `/api`, and device tokens never on `/mcp`. Changing
  `PURSS_PUBLIC_ORIGIN` ends every grant.
- **Switches and events.** Turning an account's assistant switch off revokes its tokens and grants; a
  password reset signs it out of all of them; suspension stops them at once; deleting the account
  deletes them. There are no CORS answers on the OAuth endpoints.
- **Audit.** Approvals, grants created and revoked (with reasons), token creation and revocation,
  switches, and write calls.
- **Prompt injection.** Publisher text is returned labelled as the publisher's and the server's
  instructions tell the assistant to treat it as data. Write tools exist only for read-and-organise
  grants. One of them, `find_sources`, makes the server fetch an address the assistant supplies
  (`follow_source` then has FreshRSS poll what it found), within the address rules above. What an
  assistant reads leaves the server for its provider.

## Stored content, frames and public pages

**Text from outside.** Feed text, captures, browser captures and imported text are sanitized with an
allowlist on the way in, and the reader renders what is stored. Scripts, event handlers, styles,
forms, frames, objects, SVG and every attribute outside the list are dropped, only `http`, `https`
and `mailto` addresses survive, links open with `noopener noreferrer nofollow`, and images are sent
without a referrer. The Content-Security-Policy is a second layer. Source icons and kept pictures are
fetched and served by PURSS; images inside articles load directly from the publisher, so the
publisher sees the reader's address (not the page they came from).

**Originals in the reader.** A browser refuses a frame when the page's headers say so, and the frame
can't report it, so `GET /api/frame-check` reads the headers on the server (through the fetcher, 16 KB,
8 seconds) and judges them against the PURSS's origin the way a browser would. Only a successful answer
counts, a download is never framed, and an https PURSS never frames plain http. Answers are kept 6
hours (5,000 at most), per account, and a check that has to read a page is limited to 300 per 10 minutes
per account. A frame is sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups
allow-popups-to-escape-sandbox`, never `allow-top-navigation`); it is another origin, so it can't reach
PURSS, and PURSS's own pages refuse to be framed. A video player loads in a frame after the person
presses play, with a similar sandbox; an Instagram post's embed loads when the post opens. In the
phone apps the page policy narrows frames to the video players, and originals open in the system
browser's tab.

The desktop app shows other pages in a second web view that reaches no app command (no capability
names a remote address, and the command handler refuses every web view but the main one), loads only
`http` and `https` pages on hosts other than `localhost`, and keeps its storage in memory only, so
sites start signed out and nothing outlives the app. Downloads go to the default browser.

**Public pages and feeds.** A basket or collection is private until its owner chooses Share. The
review shows the exact page and what becomes public before anything is published.

- Visitors see each item's title, link, a short plain-text summary, source name and date, and the
  owner's public note. Never reading state, annotations, saved text or anything else of the account.
  Items of private sources and links that carry a key never show, and filter collections whose rules
  read reading state can't be shared.
- The address is the title plus 12 random letters (60 bits). An unlisted page is not access control.
  Pages ask search engines not to index them unless the owner chose listing, which asks for its own
  confirmation. Item links are `nofollow`.
- Pages and feeds load no scripts, images or outside resources (`default-src 'none'`), set no cookies,
  and are cached for at most 60 seconds, so pausing, stopping or a takedown reaches visitors within a
  minute. Copies already fetched can't be recalled. Suspending or deleting an account pauses its
  pages.
- Reads are limited to 120 a minute per address. Each page links to a report form that posts only to
  itself and keeps the reason, the explanation and an optional contact, never the visitor's address:
  5 reports an hour per address and 50 open per page, past which reports are thanked but not stored.
  Every administrator gets one bell entry per page a day.
- An administrator reviews the page as visitors saw it. Taking it down needs a recent sign-in and a
  reason, pauses it at once, closes its open reports and tells the owner, who keeps the basket but can't
  share it again until an administrator restores it. Each step is audited.

## Email

Outgoing email is optional and off unless the operator sets an SMTP server. STARTTLS is required by
default (`PURSS_SMTP_SECURITY` can be `tls` or, for a relay on a private network, `none`).

- Links are 32 random bytes, stored as SHA-256 hashes, single use, and tied to the address they were
  sent to (a change of address afterwards voids them). Confirmation and sign-up links last 48 hours, reset
  links one hour; a replacement voids unused older ones. An address change takes effect only when the
  link to the replacement address is used, and the old confirmed address is told.
- A message sent after a request (sign-up, confirmation, reset, notices) is first written to a queue,
  sealed with AES-256-GCM under `secrets/mail-queue-key`, so the database alone never holds a usable
  link, and a restart doesn't lose it. It is retried from 30 seconds doubling to 15 minutes, for up to
  a day. The server stops at start if the key can't be made. Invitations and the test message are sent
  while the person waits and not queued.
- The send log keeps the kind, a masked address (`a•••@example.com`), the outcome and an error code,
  never a body, subject or link, and is purged after 90 days. Spent links are purged after a day.
- Digests and reminders are sent only when the person keeps them on and to a confirmed address. They
  carry titles from the account's own library (a digest leaves out private sources' titles).

## Updates of the phone and desktop interface

The phone apps (and the desktop app, at its own native level) show an interface they download from
the PURSS they are connected to, so small changes reach them without a store release. The server image
packs the build of the interface it runs, and `GET /api/app/bundle` offers it with its version,
native level, SHA-256 and size; only the zip on offer is served.

- **Who may push code.** Any server the app is connected to. Bundles are not signed. The official
  server's updates install without a question. Any other server is asked about once, the first time it
  offers an update (closing the question counts as *Don't allow*), and the answer, kept per server, can
  be changed in Settings → This device.
- **What that means.** A downloaded interface is code that runs in the app with the app's access: a
  malicious server's interface can read what is typed into the app's screens and use the connection's
  token. It can't use another server's data by itself, because the app holds one connection's token at
  a time. Reinstalling the app or clearing its data removes a downloaded interface.
- **Fit.** Each build records the native level of the app it was made for, and the app installs a
  build only when that level equals its own. A fingerprint of the native side (the Android and iOS
  projects, the plugins and the Capacitor configuration) is stored next to the level, and a test fails
  whenever it changes until a person decides whether the interface depends on the change.
- **Integrity.** The plugin checks the zip against the offered SHA-256, which catches a damaged
  download but not a malicious server. Plain `http` is allowed for a server on the local network, where
  anyone on it could swap the download.
- **Rollback.** An interface must report that it started within 15 seconds or the previous one is
  restored and that version is never installed again. Updates switch in at start, or when the app is
  shown again after an hour away with nothing playing. Disconnecting returns to the interface the app
  was installed with.
- **No third party.** The updater plugin's own service is not used: its update, statistics and
  channel addresses are empty, so no check or statistic leaves the app.
- **Desktop.** The page checks the SHA-256; the Rust side unpacks only names that check out, under a
  size cap (200 MB, 5,000 files) and only a build for the app's level, and rolls back an interface that
  doesn't report started within 15 seconds.

## Hosted service

On the official hosted service (`PURSS_MODE=hosted`):

- Open sign-up exists only when configured, with a working mail server (re-checked every 10 minutes
  while failing), and under the limits above.
- Where a billing service is configured, paid subscriptions are handled by it. PURSS stores no card
  details and trusts the service for one thing: which of Free, Plus and Pro an account is on. The hand-off is a
  signed ticket valid for 10 minutes; the service's callback is an HMAC-SHA256 signature with a shared
  secret of at least 32 characters, accepted within 5 minutes of its timestamp and only once. It can
  never change an administrator or an unlimited account.
- The operator can technically read stored content, as for any installation. The administrator
  tools show health, jobs and storage use, not items.

## Optional features and what they send

- **Discovery** (hosted only) suggests sources that readers who share follow together. Only accounts
  with sharing on (`discoveryShare`, on unless switched off) count, and an account that doesn't share
  gets no suggestions. Private sources, manual sources and shared collections never count. A source
  enters the aggregate only when at least 10 accounts follow it and a pair when 10 follow both; the
  tables hold counts with no account or workspace, counts never leave the server, and a suggested
  title and site must each be used by at least 10 followers.
- **Smart filters** send, for each post of a filtered source (and for the latest posts when the person
  tries a filter), the post's title, source name, author, stored excerpt (about 300 characters) and the
  person's own words to the Jev address the operator fixed (TypeSafe's by default, or OpenRouter's),
  with redirects refused. Pages are never fetched for it. The key is set only by an administrator (with
  a recent sign-in), kept in `secrets/jev-server-key` and shown by its last four characters; people
  never hand the server a key. A filter on a private source sends that source's post text too, because
  filters are turned on per source. Jev has no tools and answers only probabilities.
- **Phone notifications.** A phone registers a random handle from the push relay with its PURSS. When
  a notice reaches the bell, the PURSS asks the relay to wake that handle (a POST through the fetcher,
  10 seconds) and the relay asks Google or Apple for a push with no text. The phone then fetches the
  text from its PURSS with a credential (`purss_push_…`, stored hashed) that reaches only that phone's
  waiting notifications. The relay, Google and Apple learn that a server has something for that phone,
  never what. A handle is the only credential `notify` needs, so anyone who learns one can wake that
  phone, within the relay's rate limits. `PURSS_PUSH_RELAY_URL=` turns it off.
- **Lookups for discovery.** When no feed is found, a page's address (without query string, and not one
  that looks private) can be asked of Wikidata, an ISSN of Crossref, and a name typed into Add
  source's search of Wikidata (for websites) and of Apple's podcast directory. Requests to Wikimedia's
  sites name the project's public website in their User-Agent (`PURSS/0.1 (https://purss.app; feed
  reader)`), as Wikimedia's API rules ask of clients; it names the software, not the installation or a
  person. Every other request sends the generic `PURSS/0.1 (self-hosted feed reader)`.

## What the operator can see

Anyone with access to the machine that runs PURSS (the server's file system, its containers, its
database, its backups) can read:

- **The product database**, in plain SQLite: every account's email address and display name, items,
  saved text, browser captures, notes, highlights, baskets, sources, reading state and settings.
  It holds only hashes of passwords, setup codes, invitations, sessions, tokens, codes and email
  links, and public keys of passkeys.
- **The secrets folder:** the signing and encryption keys, the service token, the Jev key, the
  private feed addresses and the FreshRSS credentials, as plain files readable by the services
  (modes 0600 and 0640).
- **FreshRSS's data volume**, which holds each account's subscriptions (private feed links included)
  and recent entries.

PURSS doesn't encrypt the database, the FreshRSS volume or backups. `scripts/backup.ts` copies a
consistent snapshot of the database, and with `--include-secrets` the secrets folder too; such a backup
must be protected like a password ([Backups](storage-and-retention.md#backups)). Disk encryption and
file permissions are the operator's to set.

An operator with host access can also make a password reset link for any account that has a password,
administrators included, and sign in as it. That is recorded as a host-level audit event with no actor,
and the account's confirmed address gets a "password changed" message once the link is used, but
nothing stops it. The dashboard's limits (no content, no impersonation) are product rules, not
protection against the person who runs the server.

What an operator can see through the application is limited to the administrators' tools above.
A visitor's network address is visible to the operator's reverse proxy and network; PURSS doesn't store it.

Data leaves the server in these cases:

| What | Goes to | Controlled by |
| --- | --- | --- |
| Feeds, pages, icons and pictures the person follows or keeps | The publisher, which sees the server's address | The person following the source |
| Article images, audio and video | The publisher, which sees the reader's address; a video player loads from its platform after play | The reader |
| Wake requests | The push relay, then Google or Apple, by handle without content | The person, per phone; the operator |
| Post text for Smart filters | Jev (TypeSafe or OpenRouter) | The administrator's key and the person's filter |
| What an assistant reads | The assistant's provider | The person's switch and grant |
| Email | The operator's SMTP server | The operator |
| Sign-in | The configured OpenID Connect provider, which learns that a sign-in happened | The operator |
| Lookups when no feed is found, and names typed into Add source's search | Wikidata, Crossref, Apple's podcast directory | Automatic, only as described above; a search only when the person presses *Search* |
| Changes to a subscription (hosted) | The billing service | The operator |

PURSS sends no telemetry. It calls an AI service only when an administrator has set a Smart filter key and someone has turned a filter on.

## Secrets on disk

All under `secrets/` in the data directory (mode 0700, files 0600 unless noted), never in the database,
exports, logs or job payloads:

| File | Used for | Read by |
| --- | --- | --- |
| `setup-code` | The first account's one-time code, until it is claimed | The operator |
| `service-token` | The worker to the API's internal listener, the API to egress control | API, worker, egress |
| `engine-helper-token` (0640) | The worker's key to FreshRSS's admin helper | Worker, engine setup, FreshRSS |
| `engine-admin` (0640) | FreshRSS's operator account | FreshRSS, engine setup |
| `engine-users/<id>` | Each account's FreshRSS API password | Worker only |
| `source-urls/<source>` | Private feed links | API, worker |
| `bridge-key` | Signing the addresses FreshRSS is given for bridged sources | API, worker, egress |
| `feed-trim-key` | Signing the addresses FreshRSS is given for big feeds | Worker, egress |
| `feed-key` | Recognising a private link followed a second time | API |
| `sign-in-key` | Signing the "known browser" values | API |
| `mail-queue-key` | Sealing queued mail | API |
| `oauth-refresh-key` | Signing assistants' refresh tokens | API |
| `jev-server-key` | The server's Smart filter key | API, worker |

[Backups and restore](self-hosting.md#backups-and-restore) says what to keep together. A restore
without `secrets/` ends assistants' OAuth grants, makes private sources ask to be reconnected, and
leaves queued mail unreadable.

## Limits worth knowing

- **No end-to-end encryption**, no encryption at rest by PURSS, and unencrypted backups: see above.
- **Rate limits** reset when the API restarts.
- **The API, worker and egress share the data and secrets volumes**, the worker and egress parse
  hostile pages and feeds, and FreshRSS holds every account's subscriptions. Isolation is by network
  and file permission, not by a sandbox.
- **Device tokens aren't rotated.** A stolen phone or desktop token works until it is revoked or goes
  90 days unused; it can do what the account's person can do, except the changes that need a recent
  sign-in.
- **Export needs no recent sign-in** (6 an hour per account), so a stolen session or phone or desktop
  token can export the library.
- **Interface updates aren't signed**, so connecting an app to a server means trusting that server's
  interface.
- **`find_sources`** lets an assistant with organise access choose addresses the server fetches.

## Reporting a vulnerability

Report problems privately, not in a public issue, through **Report a vulnerability** under the
repository's Security tab. [SECURITY.md](../SECURITY.md) says what to include and what to avoid
(other people's accounts and data, tests that slow the service down). Reports about the hosted
service and about the code are both welcome.
