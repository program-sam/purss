# Connected apps and duplicate-aware keeping

The owner approved a Capacitor mobile app and a browser extension. Both are other
programs, not pages of PURSS, so they can't use the session cookie with its
same-origin and CSRF checks. This document records the shared foundation they use: a
connection flow, device tokens, CORS for their origins, and keeping a link without
making duplicates. The apps themselves are separate work.

Self-hosters set nothing up for the connection itself: the client kinds, their return addresses and their
permissions are fixed in code, with no client registration, OAuth provider or email. (Whatever external sign-ins
the operator configured, such as Google, appear in the app too: `PURSS_OIDC`, [plan/21](21-identity-and-administration.md).)

## Connecting

```text
app                              system browser (PURSS origin)                   API
 │ verifier = 32+ random bytes
 │ challenge = BASE64URL(SHA-256(verifier))
 ├─ open /connect?client=mobile&redirect_uri=purss://connect&state=S
 │        &code_challenge=C&code_challenge_method=S256&device_name=Pixel 8
 │                                 signed out? → /signin?next=… (any method, then back)
 │                                 GET /api/connect/request ─────────────────────► validate, describe
 │                                 person checks kind, target, name; Connect
 │                                 POST /api/connect/approve (same origin, CSRF, ─► one-time code
 │                                      recent sign-in)                              (5 min, hashed)
 │ ◄── purss://connect?code=K&state=S&iss=<origin>
 ├─ POST /api/connect/token {client, code: K, codeVerifier, redirectUri} ─────────► device token, once
 └─ Authorization: Bearer purss_dev_… on /api/*
```

Apps that can't receive a redirect (Safari's extension API has no `launchWebAuthFlow`)
leave out `redirect_uri` and `state`; the page then shows a short code
(`xxxx-xxxx-xxxx`) that the person types into the app, which exchanges it the same way
with its verifier. Declining sends the app `error=access_denied` with its `state`.

`GET /api/connect/info` (no sign-in) tells an app that an address is a PURSS: its
origin, the connect page and token addresses, the S256 method, each kind's return
addresses, and feature flags (`urlLookup: true`; `browserCapture: true`, plan/32).

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Protocol | Authorization code with PKCE (RFC 7636, S256 only), no client secret, no registration; `iss` on the redirect (RFC 9207) | The standard flow for public clients; the same core serves the OAuth server for assistants (plan/33) |
| Core | `apps/api/src/connect/codes.ts`: issue and redeem codes, nothing about HTTP or tokens | Small enough to review on its own and reuse |
| Client kinds | `mobile`: the whole user API except browser-only routes. `extension`: an exact list (keep a link, with the page's text captured in the browser ([plan/32](32-browser-extension.md)), look up a page, list baskets and collections, search, find and follow a source, disconnect itself) | The extension needs little; a narrow token limits what a stolen one does |
| What each app reaches | The phone app: everything the browser does (owner's decision: some people only use the app). Its token is a full sign-in: an administrator's is an administrator, and its `auth_at` (set when it signs in or is approved, `NULL` for connections from before) is the step-up clock that `requireRecentAuth`, `sessionWrite` and `credentialWrite` read for it as they read a session's; *confirm it's you* (`/api/auth/step-up/*`) refreshes it. Only approving another app's connection (`/api/connect/request`, `/api/connect/approve`) or an assistant's sign-in (`/api/assistant/oauth/*`) stays with the browser that app or assistant opened. The extension: its exact list, never an administrator or a recent sign-in. The app signs in and creates accounts through open endpoints like the code exchange: `POST /api/connect/signin` (username and password, or a passkey where the PURSS vouches for the app, with the browser's limits and answers; an account set to be deleted answers 409 `deletion_pending` with a single-use `keepToken` for `POST /api/connect/keep-account`), `POST /api/connect/signup` (invitation or open sign-up, account, password and token in one transaction) and `POST /api/password-reset` | The check runs on the route the router matched, and routes answer only their canonical path (no empty segment, trailing slash or encoded slash; dot segments resolved by URL parsing), so no other spelling of a path reaches a route the check didn't see |
| Return addresses | mobile: exactly `purss://connect` (the scheme the app registers). extension: `https://<32-letter id>.chromiumapp.org/…` and `https://<SHA-1 hex of the add-on id>.extensions.allizom.org/…` (what `identity.getRedirectURL()` returns, checked in Firefox's source: pref `extensions.webextensions.identity.redirectDomain`). No query, fragment, port or credentials; exact normal form | The approval page never redirects anywhere else, so it can't be an open redirect that hands out codes. Firefox's loopback form (`http://127.0.0.1/mozoauth2/…`) is refused: any local program could listen there |
| Codes | Redirect codes 32 random bytes; typed codes about 59 bits. Five minutes, single use, SHA-256 stored, bound to challenge, kind and exact return address. A failed exchange burns the code | Interception without the verifier gets nothing; whoever intercepts gets one try |
| Approval | Same-origin POST with the CSRF header (the existing cookie checks), a recent sign-in (step-up when older than 10 minutes), the page can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) | A device token is a long-lived credential, like a passkey or an assistant token |
| Token | `purss_dev_` + 32 random bytes; SHA-256 stored; shown once. One long-lived bearer token with a sliding idle limit, no refresh tokens | It is no weaker than the session cookie it replaces (also an opaque bearer secret with a sliding lifetime). See open questions |
| Lifetime | Stops after 90 days without use (sliding; last use written at most hourly); revocable from Settings → Connected apps or by the app itself (`DELETE /api/connect/device`); up to 20 per account | A phone or extension used monthly stays connected; a lost or forgotten one stops on its own within three months. Sessions are 30 days, but reconnecting an app takes a trip through the browser |
| Revocation | Looked up on every request, so it applies to the next one; an open event stream of that app is closed. The operator's `password-reset-link`, a password reset by email and suspension disconnect every app of the account and drop its codes not yet exchanged (one function, `auth/sign-out.ts`); asking to delete the account does too (the grace period lets no app connect), and its removal deletes the tokens | Same reach as sessions and assistant tokens |
| Audit | Approvals, token issue, failed exchanges (with reason), disconnects (from Settings or the app) | Recoverable without logging secrets |
| Limits | Token exchange 30 per 10 minutes per address; approvals 30 per 10 minutes per account | Bounded guessing and code minting |
| Return path | `/signin?next=` (a same-site path only) for passkey and password sign-in, and a short cookie through a linked (OIDC) sign-in | The person lands back on the approval page |
| Continue with a provider | `GET /api/connect/info` lists the external sign-ins (`signin.providers`: id, label, start address). The app's *Continue with Google* opens `<origin>/api/auth/oidc/<id>/start?next=/connect?…` in the system browser, never the app's web view (Google refuses embedded web views, `disallowed_useragent`), with the same PKCE request as the Connect page. The person signs in there, or an account is made by that sign-in where open sign-up allows it ([plan/21](21-identity-and-administration.md)); the callback lands on the approval page, where *Connect* sends the code to `purss://connect` as usual | One approval path for every way to sign in: the app connects by itself afterwards, and a person with only a provider sign-in has no password to type into an app |
| Linking or confirming with a provider from an app | `POST /api/auth/oidc/<id>/ticket` (the app's token; a *link* needs a recent sign-in first) takes `purpose` (`link` or `stepup`), the S256 challenge of a verifier only the app holds and a state, and answers a single-use, five-minute address for the system browser: `…/start?ticket=…`. That browser has no session, so the flow is bound to its binder cookie and to the app's connection named by the ticket; the identity that signs in must be linked to that account (for *confirm*, one the provider may confirm: [plan/21](21-identity-and-administration.md)). The browser changes nothing: it shows a page that goes to `purss://connect?link_code=…` or `?confirm_code=…` with the `state` and `iss=<origin>` (and offers the link), and the app redeems the code with its token and the verifier at `POST /api/auth/oidc/<id>/link` (the identity is then linked) or `/confirm` (that connection's `auth_at` is then refreshed, and no other's). A code is single use, five minutes, stored hashed, only valid for the account and connection the ticket was made for, a link's and a confirmation's are separate (one never redeems as the other), and any attempt spends it; a confirmation also needs the identity still linked and still allowed to confirm. The app waits for the code at `purss://connect` for up to five minutes | A provider-only account in the app can pass every recent-authentication gate and link a provider, like the browser's, and a ticket handed to someone else can neither attach their identity nor refresh the app's recent sign-in |

## Why bearer requests skip the Origin/CSRF check, and why the CORS rules are safe

CSRF works because the browser attaches the session cookie to any request to the
PURSS, whichever page made it. A bearer token is never attached by the browser: a
page can only send one it already holds, and then it doesn't need to forge anything. So
`Authorization: Bearer purss_dev_…` requests skip the Origin and CSRF checks, and ignore
cookies entirely (an invalid token is refused, never replaced by a cookie). Requests
without such a header go through exactly the old path. Other Authorization values (HTTP
Basic added by a reverse proxy, an assistant token) are ignored on `/api` as before.

CORS only lets a page *read* responses or send non-simple requests. The API answers CORS
for:

- origins of the apps only: `capacitor://localhost`, `https://localhost`, `http://localhost`
  (the Capacitor WebView on iOS and Android), `tauri://localhost` and `http://tauri.localhost`
  (the desktop app, [plan/42](42-desktop-app.md), which connects as kind `mobile`) and `chrome-extension://`,
  `moz-extension://`, `safari-web-extension://` pages. Extension ids aren't pinned:
  self-built and Firefox per-install origins differ;
- requests that carry a device token, and the two endpoints used before there is one
  (`/api/connect/info`, `/api/connect/token`, which read no credentials at all);
- preflights that announce an `Authorization` header (a preflight never carries the token
  itself, so the real request must still present a valid one) or target those two endpoints;
- never with `Access-Control-Allow-Credentials`, so a browser never exposes a
  cookie-authenticated response cross-origin, and a cookie request from an app origin still
  fails the Origin check.

A token sent from any other web origin is refused outright (as `/mcp` does). The origin
list grants nothing on its own: without a token, a request from an app origin is an
ordinary cookie request with all the old checks.

## Threats and what answers them

| Threat | Answer |
| --- | --- |
| Code intercepted on the way to the app (another app registering `purss://`) | PKCE: useless without the verifier; single use; five minutes. On iOS, `ASWebAuthenticationSession` delivers the callback only to the app that started it |
| A link that starts a connection for an attacker's app | The approval page names the kind and return address, asks for a recent sign-in and warns to connect only what you started yourself. A malicious app already on the device that registers `purss://` remains a residual risk, as with any custom scheme; an https app link needs a domain per server, which self-hosting rules out |
| Someone sends a typed-code connection link and asks the person to read out the code | The code is bound to the challenge of whoever started the request, so this works only by persuading the person; the page says never to share it and to connect only what they started. Same residual risk as above |
| Open redirect | Return addresses checked against fixed rules before anything is shown or issued; an invalid one is an error on the page |
| CSRF on approval | Existing same-origin and per-session CSRF checks; approve is a POST |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every page |
| Token theft | Hash only at rest; shown once; idle expiry; revocation on the next request; narrow scope for the extension, never an administrator or a recent sign-in; the phone app's token is a recent sign-in only for ten minutes after the person proved who they are, so a stolen one can't change sign-in methods or administration without the password or a passkey |
| Brute force | Codes have 59 to 256 bits and need the verifier; exchanges are rate-limited per address; a wrong verifier burns the code |
| Timing | Codes and tokens are looked up by SHA-256; the verifier is compared in constant time |
| An app's ticket address handed to someone else, or a stolen app token used to start one | The browser changes nothing, for a link or a confirmation. The identity waits behind a code that goes only to `purss://connect` on the device the browser runs on, and is redeemed with the app's own token and a verifier only that app holds: so another person's identity can't be attached to the app's account, and a stolen token can't have the account's owner confirm for it (the owner's device never sends the code to the thief's app, and the code is useless without the verifier). *Confirm* also asks the identity that signs in to be one already linked to that account. What remains is a malicious app on the same device that registers `purss://`: it sees the code but has no verifier |
| Cross-tenant access | The token resolves to its account's workspace; every route keeps its existing workspace scoping; lookup and keep query only that workspace |
| Weakened cookie path | Cookie requests are unchanged; tests cover app origins, foreign origins and no origin |

## Duplicate-aware keeping

`items.url_key` holds a comparison key of each item's address (`services/url-key.ts`), with an
index on `(workspace_id, url_key)`. The key:

- exists only for http and https addresses, and leaves out the scheme (feeds still link with
  plain http to pages opened over https);
- lower-cases the host (punycode for international names) and drops a trailing dot; keeps
  `www.` (it can be another site) and a non-default port;
- drops the fragment, except `#/…` and `#!…` routes that single-page sites use;
- drops one trailing slash from a path other than `/`;
- removes `utm_*` and well-known click ids (`fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`,
  `msclkid`, `yclid`, `twclid`, `igshid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `mkt_tok`); other
  parameters keep their order and spelling.

`POST /api/items/manual` now keeps the PURSS's existing item for that key (one already
kept first, then one shown in lists, then the oldest) in the requested basket, and answers
`existing` and `alreadyInBasket`; only a page the PURSS doesn't have becomes a new saved
link. `GET /api/items/lookup?url=` answers the best match (id, title, address, workflow
state, baskets) and the followed sources whose site address contains the page (same host
ignoring `www.`, and within the site's path, so a YouTube channel doesn't claim every
video). Following a site never means every page of it was collected.

The migration fills in existing rows. SQLite has no URL parser, so the Database class
registers the same `urlKey` function as a deterministic SQL function (`purss_url_key`) on
every connection, and migration 025 runs `UPDATE items SET url_key = purss_url_key(url)` in
its own transaction. A later change to the rules would ship as a new migration doing the
same. Inserts from sync, manual keeping and import, and upstream edits that change an
address, write the key directly.

## Not built

Push delivery to apps (the mobile apps are in [plan/31](31-mobile-apps.md), the extension in [plan/32](32-browser-extension.md)); refresh-token
rotation; per-app rate limits beyond the code exchange; an https app-link return address;
pinning official extension ids; Safari's redirect flow (it uses the typed code).

## Open questions for the owner

- Single long-lived token versus short access tokens with rotating refresh tokens. The
  conservative choice for a self-hosted product was the simpler one with the same strength
  as a session cookie; rotation with reuse detection would add detection of a copied token
  at the cost of races on a phone that goes offline mid-refresh.
- Whether to pin official extension ids once they exist (self-built extensions would then
  need the typed code).
