# Assistants (MCP)

PURSS runs an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can work with one
person's PURSS: search and read it and, if allowed, organise it. The server is `POST /mcp` on
the public address (`<PURSS_PUBLIC_ORIGIN>/mcp`), in the API process, so every tool runs as the
person's account through the same services as the web app: the same scoping, plan limits, storage
rules and audit. The [user guide](user-guide.md#assistants-mcp) walks a person through connecting
one; this page describes what is on offer, how it is switched on and limited, and what a client
author or administrator can rely on. The threat model is in [Security](security.md).

## Two switches

Assistant access works only while both are on. Both are off by default.

| Switch | Where | Who | Effect of turning it off |
| --- | --- | --- | --- |
| Installation | *Administration → Assistants* | An administrator, after confirming it's them | Every token and connected assistant stops at once (`/mcp` answers 403). They are kept and work again when it is turned back on. The panel counts the accounts that turned it on, the tokens and the connected assistants |
| Account | *Settings → Assistants → Let assistants use my PURSS* | The person; can't be turned on while the installation switch is off | The account's tokens are revoked and its connected assistants disconnected |

Other things that end or pause an assistant's access: a password reset (by email or with the
administrator's `password-reset-link`) and signing out everywhere revoke the account's tokens and
connected assistants; suspending the account stops them at once and resuming brings them back;
deleting the account deletes them.

## Personal access tokens

A person makes a token in *Settings → Assistants → New token*, after confirming it's them (a recent
sign-in is required, as for any other credential).

- **Name** of 1 to 80 characters, to recognise it later.
- **Access level**: *Read only* or *Read and organise*.
- **Lifetime**: 30, 90 (the default) or 365 days, or no expiry.
- **Secret**: `purss_mcp_…`, shown once. Only its SHA-256 is stored. The page offers the address and
  ready-made connection settings, for example
  `claude mcp add --transport http purss <address> --header "Authorization: Bearer <token>"`.
- **Limit**: 20 tokens per account. A token can be revoked at any time; the list shows when each was
  last used (recorded at most once a minute).

An assistant sends the token as `Authorization: Bearer <token>`. Cookies are ignored on `/mcp`, and a
request carrying a browser `Origin` other than PURSS's own is refused, so a web page can't act for a
signed-in person. A token acts as its account's principal, never as an administrator and never as a
recent sign-in, so administration, account security and the actions that ask to confirm it's you stay
out of reach. Over plain HTTP other than `localhost` a token travels unencrypted; *Settings →
Assistants* warns about it.

## What an assistant can do

A token or connected assistant is *read* or *write*. A read assistant is shown only the reading
tools in `tools/list`; calling a writing tool answers a tool error saying that it can only read.
Failures an assistant can act on (invalid arguments, a plan limit, a full storage allowance, an item that
doesn't exist) come back as results with `isError: true` and a message, not as protocol errors.

| Tool | Level | What it does |
| --- | --- | --- |
| `search_items` | read | Full-text search over titles, summaries, authors, feed content, readable copies and the person's own highlights and notes, including finished and ignored items. `query` 1 to 200 characters, `limit` 1 to 50 (20) |
| `list_items` | read | Items, newest first unless `sort` is `oldest`, `source` or `title`, optionally in one collection, source or basket (`place` and `id`, or `all`, or `new` for items marked New) and one workflow state. Without a state, ignored items are left out. `limit` 1 to 100 (30), paged with `nextCursor` |
| `get_item` | read | One item with its text: the readable copy when there is one, otherwise what the feed carried (`textSource` says which). `maxChars` 500 to 60,000 (20,000) cuts the text and the annotations that go with it; `textTruncated` and `annotationsTruncated` say so. Also the person's highlights and notes on it, the collections it is in and when it was kept |
| `list_sources` | read | The followed sources with their collections, health, whether full articles are fetched, notification setting and item counts |
| `list_collections` | read | Collections, whether they group sources or match a filter, with counts |
| `list_baskets` | read | Baskets, whether each keeps readable text, and counts |
| `set_item_state` | write | Moves up to 100 items to one workflow state: `undecided`, `toread`, `inprogress`, `finished` or `ignored`. Nothing is deleted |
| `clear_new` | write | Removes the New marker from up to 100 items without changing their state |
| `keep_items` | write | Keeps up to 100 items in a basket. The kept version of each item as it is now, and in a basket that keeps readable text the page's readable copy when it can be fetched and there is room, are saved under the normal storage rules |
| `remove_from_basket` | write | Takes up to 100 items out of a basket; the items stay in PURSS |
| `create_basket` | write | Creates a basket (`name` 1 to 80 characters, `keepReadableText`) |
| `create_collection` | write | Creates a collection of sources (`name`, up to 500 `sourceIds`) |
| `find_sources` | write | Looks up what can be followed at a link (website, feed, YouTube channel or video, podcast, Mastodon or Bluesky account) and returns candidates, each with a `followToken`. Nothing is followed. A token is held in memory for an hour and is forgotten when the API restarts |
| `follow_source` | write | Follows a candidate, optionally into an existing collection or one it creates, with full articles on or off. The posts the feed already has stay on the source's page and in search and are left out of Home and its counts, as in the app. Subject to the account's plan limits |
| `update_source` | write | Renames, pauses or resumes a source, turns full articles on or off, sets its notifications (`default`, `on`, `muted`) or sets its collections (up to 20, replacing the list) |
| `unfollow_source` | write | Stops following a source. Items kept in baskets stay; its other items drop out of lists and search without being deleted, and following it again brings them back |

`find_sources` is a writing tool because it makes the server fetch an address the assistant chose.
The fetch goes through the same safe fetcher as the app's own lookups (public addresses only, no
redirects to internal ones), and its budget is shared with them: 120 lookups per 10 minutes per
account.

The tools also carry MCP annotations: the reading tools and `find_sources` are `readOnlyHint`,
`unfollow_source` is `destructiveHint`, and `find_sources` and `follow_source` are `openWorldHint`.

### What is not offered

Permanent deletion of anything, sharing or publishing, export, sign-in and account security,
administration, creating tokens, changing highlights or notes, and fetching arbitrary addresses
beyond source lookup. An assistant sees only its own account's PURSS.

## Text from publishers

Titles, summaries and article text come from third-party websites and may contain text meant to
steer an assistant. PURSS returns long publisher text in fields named for it, `contentFromPublisher`,
`excerptFromPublisher`, `recentTitlesFromPublisher` and `passageFromPublisher` (the part of an item
the person highlighted), and the person's own words in `writtenByThePerson`. Item titles, source names
and authors are publisher text too and keep their plain names. The server's instructions, sent when
the assistant connects, tell it to treat all of this as data and never as instructions, and to confirm
with the person before changing many items at once or unfollowing a source. Nothing in PURSS enforces
that on the assistant's side: what an assistant reads leaves the server for its AI provider.

Links of items from private sources, any link carrying credentials (a login name, or a query value under
a secret-looking name such as `api_key`) and private feed addresses are left out of every answer.

## Limits

| Limit | Value |
| --- | --- |
| Calls | 120 a minute per token, or per connected assistant; over it `429` with `Retry-After: 60` |
| Request body | 256,000 bytes, one JSON-RPC message per POST; over it `413`. A body that stalls answers `408` and one that arrives while the server is busy `503`, each with `Retry-After` |
| Bulk tools | 100 items per call |
| Tokens and connected assistants | 20 of each per account |
| Lookups (`find_sources`) | 120 per 10 minutes per account, shared with the app's own lookups |

## Audit

Recorded in the audit log (*Administration → Audit*), never with content or secrets:

- both switches (`assistant_installation_on`, `assistant_installation_off`, `assistant_access_on`,
  `assistant_access_off`);
- token creation (with its level) and revocation (`assistant_token_created`, `assistant_token_revoked`);
- every call of a writing tool except `find_sources`, as `assistant_<tool>` (for example
  `assistant_set_item_state`), with the target (a source or basket id, an item id, a count of items or a
  name), the outcome and the id of the token or connected assistant used. A failed call records its error
  code;
- the OAuth events below.

Reading calls are not logged; they update the token's last-used time.

## Signing in with OAuth

Some assistants, such as the custom connectors of Claude and ChatGPT, take an address and sign the person
in instead of taking a token. PURSS is an OAuth 2.1 protected resource for `/mcp`, with a small
authorization server in the API. Tokens keep working whether it is on or not.

**When it is on.** `PURSS_ASSISTANT_OAUTH` decides: unset, it is on in hosted mode and off when
self-hosted; `on` opts in when self-hosted; `off` turns it off in hosted mode. It needs an https
`PURSS_PUBLIC_ORIGIN` reachable from the internet (a localhost origin is accepted for testing). `on`
with any other plain-http origin stops the API from starting, and hosted mode over plain http leaves it
off. When it is off none of the OAuth endpoints exist and OAuth tokens are refused. Nothing else is
configured: the issuer and the resource come from `PURSS_PUBLIC_ORIGIN`, tokens are opaque and looked
up, and there is no client registry and no client secret. The reverse proxy must pass the paths in the
table below ([self-hosting](self-hosting.md#behind-an-https-reverse-proxy)). Both switches above apply
unchanged, and *Settings → Assistants* lists connected assistants next to tokens.

| Path | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-protected-resource` | Protected resource metadata (RFC 9728): the resource `<origin>/mcp`, the authorization server (the origin), scopes `read` and `write`, tokens in the `Authorization` header |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414): the issuer (the origin), the endpoints below, `S256` only, client authentication `none`, `client_id_metadata_document_supported`, `authorization_response_iss_parameter_supported` |
| `GET /app/oauth/authorize` | The consent page, a page of the web app (the `authorization_endpoint`) |
| `POST /oauth/token` | The `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | Revocation (RFC 7009) |

A request to `/mcp` without a valid token answers `401` with `WWW-Authenticate: Bearer realm="PURSS",
resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="read write"` (and
`error="invalid_token"` for a token that is no longer valid), which is where an assistant starts. The
OAuth endpoints read no cookies and send no CORS headers: assistants call them from their own servers
or programs. Their bodies are form-encoded, each parameter once, at most 8 kB.

### Who is asking

Clients identify themselves with a **Client ID Metadata Document**. The `client_id` is an https
address with a path, in normal form; the document there is JSON that must:

- repeat the same `client_id`, and give a `client_name`;
- hold no client secret, and declare client authentication `none` (a shared-secret method in either
  `token_endpoint_auth_method` or `token_endpoint_auth_methods_supported` refuses the document; with
  neither present `none` is assumed);
- list up to 20 `redirect_uris`, at least one of them usable (https, or plain http on `localhost`,
  `127.0.0.1` or `[::1]`; custom schemes and others are ignored).

PURSS fetches the document with the same safe fetcher as source lookups: https only, public addresses
only, no redirects, status 200 only, at most 5 kB and 5 seconds. Valid documents are cached for their
`max-age` (an hour when unstated, at most a day; `no-store` and `no-cache` are not cached; up to 1,000
documents), and failures are never cached. Only a signed-in person's consent page triggers a fetch, at
most 30 uncached fetches per account per 10 minutes. PURSS stores nothing about a client beyond the
grants people approve.

A redirect URI must match one the document lists exactly; on the loopback interface any port matches
(for a program on the person's own computer). Dynamic Client Registration is not offered, so a client
that needs it, or a pre-registered or confidential client, can't connect with OAuth; it can use a
token.

### Consent

The consent page opens at `/app/oauth/authorize` with the assistant's query: `response_type=code`,
`client_id`, `redirect_uri` (required), `state`, `code_challenge` with `code_challenge_method=S256`
(required), `scope` and `resource`. A signed-out visitor signs in and comes back. A parameter given
twice is refused on the page, before anything is fetched. A `resource` that is given must be
`<origin>/mcp` (case of scheme and host, a default port and one trailing slash don't matter).

The page shows the assistant's own name (control and direction-changing characters removed, at most 80
characters), the host that identifies it (the metadata address) and the host it sends the person back to,
with an extra warning when that is a program on the person's own computer, and what the assistant will be
able to do. The scope `write` asks for *read and organise*, anything else for *read only*, and other values
are ignored. Organising stays off until the person ticks *Allow the assistant to make changes in your PURSS*,
which is offered only when the assistant asks for it, so the person can allow less than asked, never more. **Allow**
needs both switches on (the page offers to turn the account switch on) and a sign-in within the last 10
minutes (otherwise it asks to confirm it's them); it is limited to 30 approvals per account per 10
minutes and 20 connected assistants per account. The page can't be shown in a frame.

Until the client and its redirect URI are verified an error is only shown on the page and nothing is
sent anywhere. After that, errors go back to the redirect URI with `error`, `error_description`,
`state` and `iss` (RFC 9207), as does the success answer, `code`, `state` and `iss`.

### Tokens

- **Authorization code**: one-time, 5 minutes, bound to the client, the redirect URI and the PKCE
  challenge (S256 only); stored as a hash. Any failed attempt burns it, and presenting one again after it
  made a grant revokes that grant. The token request may leave out `redirect_uri`; when it is sent it
  must match exactly.
- **Access token**: `purss_oat_…`, valid for one hour, sent as a Bearer header to `/mcp` only. It resolves
  to the same kind of caller as a personal access token of the same level: the account's principal,
  never an administrator, the same tools, the same rate limit (per grant) and the same audit of writing
  calls (with the grant id).
- **Refresh token**: `purss_ort_…`, single use. Each refresh returns a fresh pair and moves the end of
  the grant to 90 days from then; a grant that isn't refreshed for 90 days ends. Presenting a spent
  refresh token again means two parties hold it, and revokes the whole grant. Recognising a spent
  token needs the key in `secrets/oauth-refresh-key`, made on first use: a grant made under a key that
  is no longer the server's ends at its next refresh, and the assistant connects again. Back the key up
  with the rest of `secrets/`. Refreshes are limited to 30 an hour per grant and 120 an hour per account;
  over either, `429` with `error=temporarily_unavailable` and `Retry-After`, and the same token still
  works later.
- **Responses**: `{access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope}` with
  `Cache-Control: no-store`; errors are `{error, error_description}`. Only public clients are
  accepted: an `Authorization` header, a `client_secret` or a `client_assertion` answers `invalid_client`.
  The grant's level always applies and is returned in `scope`, whatever scope a refresh names.
- **Audience**: `/mcp` accepts only access tokens issued for its own current address, and OAuth tokens are
  never accepted on `/api` nor device tokens on `/mcp`. Changing `PURSS_PUBLIC_ORIGIN` ends every grant.
- **While the installation switch is off**: `/mcp` answers 403 and refreshes are refused, keeping the
  grant and the refresh token, so both work again when it is back on.

A person disconnects an assistant in *Settings → Assistants* (it lists each with its name, the host that
identifies it, its level, when it connected and when it was last used). The assistant can end its own
grant with `POST /oauth/revoke` and either of its tokens: holding the token is the proof, the whole
grant ends, and an unknown token answers 200.

OAuth events in the audit log: `assistant_oauth_approve` (level and client host), `assistant_grant_created`
(on success, or on failure with the reason: verifier, redirect, client, expired, switch off, too many) and
`assistant_grant_revoked` (revoked in Settings, by the assistant, an authorization code used twice, a
refresh token used twice, or a refresh key that changed). A refused refresh is not audited one by one.

Not offered: Dynamic Client Registration, confidential clients, OpenID Connect discovery and ID tokens,
token introspection, sender-constrained tokens, CORS on the OAuth endpoints, and a `403
insufficient_scope` step-up (a read grant sees only reading tools; widening it means connecting again).

## Protocol

One JSON-RPC 2.0 request or notification per POST, answered with JSON; a notification (no `id`) is
answered `202` with no body. Only `POST` is accepted. There are no sessions: no session id is issued, so
every request stands alone.

| Era | Versions | How a client speaks it |
| --- | --- | --- |
| Current | 2026-07-28 | Every request names the version in `params._meta["io.modelcontextprotocol/protocolVersion"]` and in the `MCP-Protocol-Version` and `Mcp-Method` headers (and `Mcp-Name` for `tools/call`, which may be `=?base64?…?=` when not plain ASCII); they must match the body, or the answer is 400 (`-32020`). Methods `server/discover`, `tools/list`, `tools/call`. Results carry `resultType: "complete"`, the server's identity in `_meta`, and for `server/discover` and `tools/list` `ttlMs` of one hour with `cacheScope: "private"` |
| Handshake | 2025-03-26, 2025-06-18, 2025-11-25 | `initialize` (the requested version is echoed when supported), then `ping`, `tools/list` and `tools/call`. `notifications/initialized` needs no answer |

An unsupported version in a current-era request answers `-32022` with the versions supported. A tool
result holds the answer as JSON text in `content` and the same value in `structuredContent`. An unknown
tool answers `-32602`.

Not offered, as plain facts: resources, prompts, `subscriptions/listen` and other server-initiated
messages, streamed (SSE) responses, a stdio transport, and any other method. The only capability is
tools.

## See also

- [User guide: Assistants (MCP)](user-guide.md#assistants-mcp): connecting an assistant, step by step.
- [Self-hosting](self-hosting.md): `PURSS_ASSISTANT_OAUTH`, the reverse proxy paths, the administrator CLI.
- [Security](security.md): the threat model for tokens, grants and untrusted text.
