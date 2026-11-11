# Assistant OAuth (MCP)

Cloud assistants such as Claude (claude.ai, Claude Desktop and mobile custom connectors) and
ChatGPT connect to remote MCP servers only through OAuth: they take an address, not a token. This
document records how `/mcp` became an OAuth 2.1 protected resource with a small authorization
server built into the API, next to the personal access tokens of
[plan/23](23-assistant-access.md), which keep working exactly as before and stay the default.

Self-hosting stays simple. OAuth is on in hosted mode and off otherwise unless the operator sets
`PURSS_ASSISTANT_OAUTH=on`; either way there is nothing else to configure: no client secrets, no
registration with Anthropic or OpenAI, no keys. Clients identify themselves with a Client ID
Metadata Document that the server fetches.

## Flow

```text
assistant                                  browser (PURSS origin)                        API
 ├─ POST /mcp (no token) ─────────────────────────────────────────────────────────────► 401 WWW-Authenticate: Bearer
 │                                                                                         resource_metadata=".../.well-known/oauth-protected-resource/mcp", scope="read write"
 ├─ GET /.well-known/oauth-protected-resource/mcp ────────────────────────────────────► resource, authorization_servers=[origin]
 ├─ GET /.well-known/oauth-authorization-server ──────────────────────────────────────► issuer=origin, S256, auth method none, CIMD supported, iss supported
 │ verifier, challenge = BASE64URL(SHA-256(verifier)), state
 ├─ open /oauth/authorize?response_type=code&client_id=<metadata URL>&redirect_uri&state
 │        &code_challenge&code_challenge_method=S256&scope&resource=<origin>/mcp
 │                                 signed out? → /signin?next=… and back
 │                                 GET /api/assistant/oauth/request ─────────────────► safeFetch(client_id) (5 kB, 5 s, no redirects,
 │                                                                                       public addresses only, cached); redirect_uri
 │                                                                                       must be listed there; describe
 │                                 person checks name, client host, return host, level;
 │                                 Allow (may untick "organise")
 │                                 POST /api/assistant/oauth/approve (same origin, ─► one-time code (5 min, hashed, bound to
 │                                      CSRF header, recent sign-in)                    client_id, redirect_uri, challenge, level)
 │ ◄── redirect_uri?code=K&state=S&iss=<origin>
 ├─ POST /oauth/token grant_type=authorization_code&code&client_id&code_verifier&resource[&redirect_uri]
 │                                                                                    ─► access token (1 h) + refresh token, scope
 ├─ POST /mcp Authorization: Bearer purss_oat_…  ─────────────────────────────────────► same tools as a token of that level
 ├─ POST /oauth/token grant_type=refresh_token&refresh_token&client_id ──────────────► new pair; the old refresh token is spent
 └─ POST /oauth/revoke token=… ───────────────────────────────────────────────────────► the whole grant ends
```

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| When it is on | `config.assistantOAuth`: on in hosted mode, `PURSS_ASSISTANT_OAUTH=on` to opt in when self-hosted, `off` to turn it off in hosted mode. Needs an https public origin (or localhost); explicit `on` over plain http refuses to start, hosted mode over plain http stays off | Owner: self-hosting stays simple and tokens stay the default. OAuth 2.1 requires TLS for its endpoints |
| Nothing to configure | Issuer and resource come from `PURSS_PUBLIC_ORIGIN`; no signing keys (tokens are opaque and looked up); no client registry | A self-hoster who turns it on sets one variable |
| Gates | The same two switches as plan/23 (installation, account). Installation off: tokens get 403 at `/mcp`, refreshes are refused but kept. Account off: its grants are revoked with its tokens. Approving needs both on; the consent page offers to turn the account switch on | One notion of "assistant access", whichever way an assistant connects |
| Identity | An OAuth access token resolves to exactly the caller a token of the same level would: the account's principal, never an administrator, never a recent sign-in, the same tools, the same rate limit (per grant), the same audit of write calls (with the grant id) | Owner requirement; `/mcp` can't tell them apart past `oauth/grants.ts` |
| Scopes | `read` and `write`, the access levels of tokens. `write` in the requested scope asks for "read and organise"; anything else asks for reading. Unknown values (`openid`, `offline_access`…) are ignored. The person may allow less than asked (an "Also let it organise" box), never more | Same choice people already make for tokens |
| Code flow | Authorization code with PKCE S256 only; no implicit, no password, no client credentials. Codes come from the shared core `connect/codes.ts` (plan/24): 32 random bytes, 5 minutes, single use, SHA-256 at rest, bound to kind `oauth`, the client_id, the exact redirect URI and the challenge, burned on any failed attempt. The token request may leave out `redirect_uri` (OAuth 2.1 §10.2 removed it: PKCE prevents code injection); OAuth 2.0 clients that send it must send exactly the one the code was issued for. Either way the grant records the redirect URI from the code | One reviewed implementation of codes for apps and assistants |
| Client identification | Client ID Metadata Documents only (draft-ietf-oauth-client-id-metadata-document-03). `client_id` must be an https URL with a path, in normal form (compared as a string). The document must be a JSON object whose `client_id` equals the URL, with a non-empty `client_name`, no secret, client authentication `none` (below), the code grant and at least one usable redirect URI (https, or http on loopback); others are ignored. Client authentication follows CIMD §4.1 and §5: a shared-secret method (`client_secret_basic`, `client_secret_post`, `client_secret_jwt`) in either property refuses the document, even listed next to `none`; otherwise `token_endpoint_auth_methods_supported`, when present, is what counts and must be a list including `none`; `token_endpoint_auth_method` (singular, not recommended by the draft) must then be one of its values, and on its own must be `none`; neither present means `none` (the draft forbids applying RFC 7591's `client_secret_basic` default). Anything else is refused on the page | Claude and ChatGPT both publish one. Nothing is stored about clients beyond approved grants |
| Fetching the document | `safeFetch` (every address validated, connection pinned, private and special-use ranges refused, per-phase time limits) with 5 kB, 5 s overall, no redirects, `Accept: application/json`, status 200 only. Valid documents cached for their `max-age` (an hour when unstated, at most a day; `no-store`/`no-cache` not cached; at most 1000 entries); failures never cached. Only a signed-in person's consent page triggers a fetch, at most 30 uncached fetches per account per 10 minutes | The draft's limits; AGENTS.md: no SSRF weakening |
| Redirect URIs | Exact string match against the document, except that on the loopback interface (`localhost`, `127.0.0.1`, `[::1]`, plain http) any port matches (RFC 8252 §7.3, the draft's one exception). Custom schemes are refused | No open redirect; Claude Code listens on a random local port |
| Errors on the page | A request that repeats any parameter the server reads (`resource` included: RFC 8707 allows several, but there is only one resource here) is refused on the page before anything is fetched, since which value was meant, even which `state` to return, is unknown; parameters the server doesn't read are ignored. The page passes the query on exactly as it came and approves with the parameters the server answered it read, so the page and the server can't disagree. Until the client and its redirect URI are verified, an error is only shown on the page. After that, errors go to the redirect URI with `error`, `error_description`, `state` and `iss` (RFC 9207), automatically or from a button | RFC 6749 §4.1.2.1 |
| Consent page | `/oauth/authorize` is a page of the web app outside the shell, like `/connect`. It shows the client's self-declared name, the host of its metadata URL ("Identified by…"), the redirect host ("Sends you back to…"), what it will be able to do, an extra warning for loopback redirects, and the plan/23 switch state. Approve is a same-origin POST with the CSRF header and a recent sign-in (step-up after 10 minutes), rate-limited per account; the page can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) | The MCP spec: show the redirect host, warn for localhost-only clients; the same protections as connecting an app |
| Tokens | `purss_oat_` access tokens (1 hour): 32 random bytes. `purss_ort_` refresh tokens: `purss_ort_<grant id>.<generation>.<nonce>.<mac>`, the generation 0 from the code and one more per refresh, a 32-byte random nonce, and an HMAC-SHA256 over grant id, generation and nonce with a server key (`secrets/oauth-refresh-key`, made on first use). Only SHA-256 hashes of current tokens are stored, looked up on every request. The grant ends 90 days after its last refresh | Short access tokens (MCP security considerations); revocation applies to the next request |
| Rotation and reuse | Every refresh spends the refresh token and issues a new pair. A spent refresh token presented again, or an authorization code presented again after it made a grant, revokes the whole grant (OAuth 2.1 §4.3.1, §4.1.3). A grant stores only its current refresh token (hash) and generation. A spent one is recognised, however many renewals ago, by a valid mac with a generation below the grant's; anything else (a made-up signature, a generation the grant hasn't reached, garbage) is refused without revoking. Two refreshes with one token are serialised by the database transaction: the first rotates, the second revokes. Each grant records which key signs its tokens; a grant made under a key that is no longer the server's (restored without `secrets/`, or the key replaced) can't recognise its spent tokens, so it ends at the next refresh or revocation and the assistant connects again (its access tokens run out within the hour). A database restored from an older backup refuses the assistant's newer token without revoking; it connects again | Detects a copied token: one of the two holders is not the assistant, and any earlier token of a live grant stays detectable. Storage per grant is constant however long it renews. A grant id is not a secret, so only the key can make a token that revokes |
| Audience | The grant records the resource (`<origin>/mcp`). `/mcp` accepts only access tokens whose grant names its own current address; `resource` in authorize and token requests must be that address (case of scheme and host, default port and one trailing slash normalised) or absent. OAuth tokens are never accepted on `/api` and device tokens never on `/mcp` (distinct prefixes and lookups) | RFC 8707; the MCP spec forbids accepting or passing on other tokens. Moving PURSS to a new address ends every grant |
| Revocation | `POST /oauth/revoke` with an access or refresh token ends the whole grant; unknown tokens answer 200. Settings → Assistants lists grants next to tokens (name, client host, level, connected, last used) with Disconnect | RFC 7009; people see every way an assistant reaches them in one place |
| Account events | Account switch off, a password reset (by email, or with the operator's `password-reset-link`) revoke grants with tokens and drop OAuth codes not yet exchanged (`revokeAllTokens`; a password reset signs the account out of everything through `auth/sign-out.ts`). Suspension stops them at once (status checked on every request) and resuming brings them back, as with tokens. Deleting an account deletes its grants (foreign keys cascade) | Same reach as tokens |
| Limits | 20 grants per account, like tokens. Refreshes: at most 30 in any hour per grant and 120 per account (all its grants together), counted in the database (`oauth_refreshes`) and checked in the refresh's own transaction before the refresh token is spent, so they hold across server processes and restarts; over either, `429` with `error=temporarily_unavailable` and `Retry-After`, and the same token works once enough of the hour's refreshes have aged out. Code exchanges are bounded by approvals (30 per account per 10 minutes, each needing a signed-in person). Nothing is limited per address: codes and refresh tokens carry 256 bits, and the hosted service's traffic from Claude or ChatGPT comes from a few shared addresses that a per-address limit would lock out. Refused refreshes are not audited one by one and do not count toward the limits. Rows: per grant one row with its current refresh token, access tokens until they expire (at most about 30 live), and the last hour's refreshes (at most 30); nothing grows with the grant's age. Bodies at most 8 kB | Bounded without breaking the hosted service: an assistant refreshes about once an hour |
| Audit | `assistant_oauth_approve` (level and client host), `assistant_grant_created` (success, or failure with the reason: verifier, redirect, client, expired, switch off, too many), `assistant_grant_revoked` (in Settings, by the assistant, code used twice, refresh token used twice). Write tool calls as in plan/23 | Recoverable without logging secrets |
| Code | `apps/api/src/oauth/`: `clients.ts` (metadata documents, redirect rules), `authorize.ts` (request checks, consent), `grants.ts` (codes to grants, tokens, rotation, revocation, `/mcp` lookup), `endpoints.ts` (metadata, token, revoke). Grants listing and revocation live with tokens in `services/assistant.ts`. Migration 029. No dependency added | Small enough to review on its own |

### Contracts

- `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource`:
  `{ resource, authorization_servers: [origin], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name }`.
- `GET /.well-known/oauth-authorization-server`: `issuer` (the public origin),
  `authorization_endpoint` (`/oauth/authorize`), `token_endpoint` (`/oauth/token`),
  `revocation_endpoint` (`/oauth/revoke`), `response_types_supported: ["code"]`,
  `grant_types_supported: ["authorization_code", "refresh_token"]`,
  `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
  `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`.
- `401` from `/mcp` with OAuth on: `WWW-Authenticate: Bearer realm="PURSS"[, error="invalid_token"], resource_metadata="…", scope="read write"`.
- Token responses: `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope }`,
  `Cache-Control: no-store`. Errors `{ error, error_description }`: 400, 401 for `invalid_client`, or 429
  `temporarily_unavailable` with `Retry-After` for a refresh over the limits.
- Browser API (session, browser only): `GET /api/assistant/oauth/request?<authorize query>` →
  `OAuthRequestSummary` (when it can ask, `request` holds the parameters read);
  `POST /api/assistant/oauth/approve { request, access }` → `{ redirectTo }`;
  `DELETE /api/assistant/grants/:id`. `GET /api/assistant` gains `oauth` and `grants`;
  `GET /api/admin/assistant` gains `oauth` and `grants`.

## Threat model

Assets: the person's library (read, and for write grants, organisation and source management), the
grant itself (a long-lived credential), and the server's network position (it fetches URLs).

| Threat | Answer |
| --- | --- |
| A phishing link starts a grant for an attacker's client | The consent page needs the person signed in and a recent sign-in, names the client with the host that vouches for it and the host the code goes to, and warns to allow only what they just started. The code goes only to a redirect URI the client's own document lists |
| An attacker's document claims a familiar name ("Claude") | The name is shown next to the host of the metadata URL ("Identified by attacker.example") and the return host. Names are stripped of control and direction-changing characters and cut to 80 characters |
| Open redirect / code sent to an attacker | No redirect of any kind until the client is fetched and the redirect URI matched exactly against its document; then only to that URI. Errors before that are shown on the page only |
| Impersonating a loopback client (Claude Code's public document lists `http://localhost/callback`) | Any website can start a flow with that client_id, but the code goes to a program listening on the person's own machine, which then still needs the verifier. The page warns that a program on this computer could ask in the client's name. Residual risk: malware already on the machine, as for any loopback client |
| Authorization code interception | PKCE S256 (verifier never leaves the client), single use, 5 minutes, bound to client and redirect URI; a failed attempt burns it; a replayed code revokes the grant it made. Residual: whoever saw a code can end the grant by replaying it (as OAuth 2.1 intends), but can't gain access |
| Refresh token theft | Rotation with reuse detection revokes the grant when both holders use it, whichever earlier token the thief has; 90-day idle end; revocable in Settings |
| Forged refresh tokens ending other people's grants | A grant id (shown in Settings and the audit log) is not enough: a token revokes only with a valid HMAC from the server's key, compared in constant time; the current token is compared by hash, also in constant time |
| Theft of the refresh key | With the key alone, one can make tokens that revoke grants whose ids are known (a denial of service), not tokens that work: a working token must match the stored hash of the current one. Database and key together still give no working token (the nonce is random and only its hash is stored) |
| Access token theft | One hour; hash at rest; refused when revoked, suspended or being deleted, a switch is off, or for another resource |
| Token for another resource (confused deputy, token passthrough) | Audience check on every request; the server never passes tokens on and calls no other service with them |
| SSRF through `client_id` | safeFetch: https only; private, loopback, link-local, metadata and special-use addresses refused after resolution, the connection pinned to the checked address; no redirects; 5 kB; 5 s; only from a signed-in person's consent page, 30 uncached fetches per account per 10 minutes. The response is parsed as JSON and only its fields are used; nothing in it is fetched (no logo) |
| Slow or huge metadata as a denial of service | Per-phase timeouts and a 5-second deadline; 5 kB read limit; the per-account fetch budget |
| CSRF on approval | Same-origin POST plus the per-session CSRF header (existing cookie checks); connected-app device tokens can't reach `/api/assistant/*` |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every page |
| Cross-tenant access | A grant resolves to its account's workspace only; every tool uses the workspace-scoped services; grants are listed and revoked only by their own account |
| Weakening token users | Token resolution is unchanged; OAuth tokens have their own prefix; with OAuth off none of the endpoints exist and OAuth tokens are refused |
| Prompt injection | Unchanged from plan/23: publisher text labelled as such, no exfiltration tools, write tools only for write grants |

## Deliberate deviations from the specifications

Each is a choice a reviewer should weigh:

1. **No Dynamic Client Registration.** The MCP 2026-07-28 revision deprecates it; Claude uses
   CIMD whenever the server advertises it together with auth method `none`, and ChatGPT prefers
   CIMD. Clients that only do DCR (or need a pre-registered client) can't connect with OAuth; they
   can use a personal access token.
2. **`redirect_uri` is required** in the authorization request (OAuth 2.1 makes it optional when a
   client has one registered URI). Every MCP client sends it; requiring it keeps matching simple.
3. **`resource` is optional.** The MCP spec says clients MUST send it; we accept its absence and
   bind the token to `/mcp` anyway (the only resource this server has).
4. **Scopes are lenient.** Unknown scope values are ignored instead of `invalid_scope`; no scope
   means `read`. On refresh, a scope wider than granted is not an error: the grant's level applies
   and is returned in `scope`. `offline_access` is not advertised (MCP: servers SHOULD NOT list it)
   and refresh tokens are issued regardless.
5. **No `403 insufficient_scope` step-up.** A read grant sees only reading tools, and calling a
   write tool answers a tool error, exactly as a read token does (owner requirement: OAuth behaves
   like tokens). Widening a grant means connecting again.
6. **Revocation authenticates by possession.** RFC 7009 asks the server to check the token was
   issued to the client revoking it; clients here are public, so holding the token is the proof,
   and `client_id` is not checked. Revoking either token ends the whole grant (RFC 7009 allows
   revoking related tokens; we always do).
7. **The loopback port exception** (any port on `localhost`, `127.0.0.1`, `[::1]`) follows RFC 8252
   and the CIMD draft, not the MCP text's plain "exact match". Claude Code needs it.
8. **`client_name` is required** in the metadata document, as the MCP text requires (the CIMD
   draft doesn't). It must be a string that is not empty once control and direction-changing
   characters are removed; the host of the metadata URL is always shown next to it, since the name
   is only the client's own claim.
9. **Authorization errors may need a click** when the page can't continue automatically; the
   decline and approve paths redirect automatically.
10. **Code lifetime 5 minutes**, under OAuth 2.1's recommended maximum of 10.
11. **A client whose declared authentication methods exclude `none` is refused on the consent
    page**, not answered with `invalid_client` at the redirect URI as CIMD §5 says: the document is
    what tells us whether the redirect URI can be trusted, so an unusable document never sends
    anything back (RFC 6749 §4.1.2.1). A document whose singular and plural methods disagree (the
    draft says the singular MUST be among the plural's values) is refused the same way.
12. **A refresh over the limits answers `429` with `error=temporarily_unavailable`.** RFC 6749 §5.2
    has no error for rate limiting at the token endpoint; `temporarily_unavailable` is the
    authorization endpoint's code for the same situation, and `invalid_grant` would make the
    assistant drop a token that still works.
13. **No token endpoint CORS.** Browser-based MCP clients can't use `/mcp` anyway (a foreign
    `Origin` is refused there, against DNS rebinding); every client checked calls from a server or a
    program.

## Sources (accessed 2026-11-05)

- MCP authorization, 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
  and its subpages `authorization-server-discovery`, `client-registration` (DCR deprecated, CIMD
  SHOULD), `security-considerations` (exact redirect matching, localhost warnings, show the
  redirect host, short-lived tokens); compared with 2025-11-25.
- Client ID Metadata Document, draft-ietf-oauth-client-id-metadata-document-03 (2 November 2026):
  https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-03.html (no
  redirects, 200 only, 5 kB, no caching of errors, special-use addresses refused, loopback port
  exception, no secrets, §5 client authentication methods).
- OAuth 2.1, draft-ietf-oauth-v2-1-17 (31 October 2026): https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-17.html
  (refresh rotation and replay, code reuse, 10-minute code lifetime, §10.2 `redirect_uri` no longer
  in the token request, §3.1 and §3.2 parameters never repeated).
- RFC 9728 (protected resource metadata), RFC 8414 (authorization server metadata), RFC 8707
  (resource indicators), RFC 7636 (PKCE), RFC 7009 (revocation), RFC 9207 (`iss`), RFC 8252 §7.3
  (loopback redirects).
- Claude connectors, authentication: https://claude.com/docs/connectors/building/authentication
  (callback `https://claude.ai/api/mcp/auth_callback`; CIMD chosen only when
  `client_id_metadata_document_supported` and `none` are both advertised, otherwise DCR; Claude Code
  CIMD `https://claude.ai/oauth/claude-code-client-metadata` with loopback redirects on any port;
  `resource` always sent; refresh on 401 and before expiry; only the first authorization server
  used). The hosted apps' document at `https://claude.ai/oauth/mcp-oauth-client-metadata` was
  fetched directly: public client, `none`, that one redirect URI. Which MCP revisions Claude speaks
  is not documented.
- OpenAI Apps SDK, authentication: https://developers.openai.com/apps-sdk/build/auth (CIMD preferred,
  client id `https://chatgpt.com/oauth/client.json`; the stable redirect
  `https://chatgpt.com/connector_platform_oauth_redirect` needs `iss` support advertised and returned
  on every authorization response; S256 required; `resource` sent; DCR still supported).

## Not built

Dynamic Client Registration; pre-registered clients; `private_key_jwt` and other confidential
clients; showing a client's logo (the draft requires prefetching it); `403 insufficient_scope`
step-up; token introspection; OpenID Connect discovery (`/.well-known/openid-configuration`) and ID
tokens; DPoP or other sender-constrained tokens; CORS on the OAuth endpoints; a per-grant activity
view. Not verified against the live Claude and ChatGPT services: that needs a public https test
instance and the owner's go-ahead.

## Open questions for the owner

- Whether to accept DCR-only clients (narrowly, with per-installation caps), should a client that
  matters turn out not to support CIMD.
- Whether the hosted service should restrict OAuth to known clients (Claude, ChatGPT) instead of any
  client with a valid metadata document. The conservative default here is any client, with the
  host always shown, matching how people already choose what to connect.
