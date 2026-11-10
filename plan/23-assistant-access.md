# Assistant access (MCP)

The owner approved an MCP server with personal access tokens and with write tools for
organising items and managing sources. Assistants that only accept OAuth connect through the
additions in [plan/33](33-assistant-oauth.md); tokens remain the default. It is off by default; an
administrator turns it on for the installation and each person turns it on for themselves.
This document records the build decisions.

## Why

An assistant working over a person's own library can do what the web app can't: summarise
what's waiting in To read, answer "what did I keep about X", triage a backlog, or set up
sources from a conversation. The value is mostly in reading; writing is a convenience with
more risk, so it is a separate, opt-in token level.

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Transport | One `POST /mcp` on the public listener; JSON answers; no sessions | Same process as the API, so the same scoping, storage rules and audit apply |
| Protocol | Dual era: 2026-07-28 (per-request `_meta` version, `server/discover`, header checks) and the `initialize` handshake of 2025-03-26 to 2025-11-25 | Most clients in use still speak the handshake; the current spec is stateless |
| Implementation | Hand-written JSON-RPC (`apps/api/src/mcp`), no SDK | Three methods per era over `node:http`; small surface we control (plan/22) |
| Authentication | Personal access token (`purss_mcp_…`) as a Bearer header; only its SHA-256 is stored; cookies are ignored on `/mcp`; a browser `Origin` other than the PURSS's is refused. Where the installation offers OAuth, an OAuth access token works the same way (plan/33) | Tokens need no setup anywhere; a web page can't act for a signed-in person |
| Token lifetime | Name, access level, 30/90/365 days or no expiry; revoke any time; up to 20 per account; making one needs a recent sign-in | Tokens are credentials, like passkeys |
| Switches | Installation switch (administrator, with step-up) and account switch, both off by default. Installation off stops every token and keeps them; account off revokes its tokens | Matches "off by default, configurable by user and admin" |
| Identity | A token acts as its account's principal, never as an administrator and never as a recent sign-in | Administration, account security and step-up actions stay out of reach |
| Access levels | `read`: search, list and read items, sources, collections, baskets. `write`: also states, New markers, keep and remove, create baskets and collections, find/follow/change/unfollow sources | Owner asked for organising and source management |
| Not offered | Permanent deletion, sharing or publishing, export, sign-in and security, administration, arbitrary URL fetches beyond source discovery | Irreversible or outward-facing actions stay in the app |
| Untrusted text | Publisher text is returned in fields named as such (`contentFromPublisher`, `excerptFromPublisher`); server instructions say to treat it as data and to confirm bulk changes and unfollows | Feed content can carry prompt injection |
| Private sources | Item links of private sources and any link with credentials are left out; private feed addresses never appear | Same rule as export (plan/10) |
| Limits | 120 calls a minute per token; discovery shares the account's existing budget; request body ≤ 256 kB; bulk tools take ≤ 100 items | Bounded load and blast radius |
| Audit | Token creation and revocation, both switches, and every write tool call (tool, target, outcome, token id); reads update the token's last use | Recoverable and explainable without logging content |

## Not built

Resources and prompts, `subscriptions/listen`, SSE responses, a stdio bridge, and a
registry listing. Each needs the owner's go-ahead.
