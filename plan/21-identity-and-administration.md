# Identity, administrator accounts, and tooling

## Separate identity from source authorization

Product sign-in, a connected service grant, and the internal FreshRSS account are
distinct relationships. Signing in with a provider never follows its sources or
grants reading access to them. Connecting a source never creates an admin account,
replaces product sign-in, or grants a new workspace membership. Keep independent
consent, scopes, revocation, and health for each use of the same provider.

Prefer supported external authentication for product signup/sign-in, using OpenID
Connect (OIDC) or an explicitly documented provider identity flow; OAuth authorization
alone is not the sign-in identity contract. Source connections prefer OAuth with
least-privilege, read-only scopes and provider-hosted authorization where available.
Use a maintained auth implementation, not custom cryptography or protocol parsing.
Providers, client registration, callback origins, and hosted/self-hosted setup need
a feasibility decision; do not show buttons for providers not actually configured.
Self-hosted source adapters use operator-registered clients, or public clients with
PKCE where explicitly supported. Never bundle a project-owned confidential client
secret in images or depend on an unreviewed central callback/token relay. A provider
restricted to one central client is hosted-only or unsupported for self-hosting;
the source catalog must show this before an authorization attempt.

Keep stable product account IDs separate from external identities. Bind OIDC accounts
by validated issuer and subject, not email as a primary key. Validate tokens and
issuer/audience, nonce and callback transaction; use authorization code plus PKCE,
exact registered redirects, CSRF/state protection, and server-side session issuance.
Keep provider tokens server-side, encrypt with keys outside the data store, and
define refresh serialization/rotation, expiry, revocation, and recovery behavior.
Never automatically link accounts or grant admin by matching email/domain/profile
claims. Adding/removing a sign-in method requires authenticated confirmation and
recent reauthentication; prevent lockout when removing the last usable method (the password
cannot be removed, so one always remains).

Self-hosting must not require a particular commercial identity provider. The
provider-independent sign-in is a username and password, chosen when the account is made
(first-run claim, invitation, open sign-up, the phone app's sign-up): the password is created
together with the account, and it can be changed or reset but never removed, so every account
keeps a way in that depends on no provider, device or origin. Fingerprint, face or screen lock
(a passkey) is offered right after, can be skipped and added later in Settings → Security;
passkeys and linked provider sign-ins can be removed. Enrollment is therefore the username and
password, then optionally a passkey, and "confirm it's you" accepts the password or a passkey.
Prove enrollment, lost-device, provider-outage and public-origin-change recovery before account
creation ships: a lost device or a provider outage is answered by signing in with the password
on another device, and a changed public origin leaves the password working while passkeys
(bound to the origin) are added again.
Guided origin changes warn before applying, preserve an independent recovery path,
and guide callback re-registration and sign-in-method re-enrollment as required;
never temporarily turn authentication off to restore access. A one-time installation
claim is not the permanent everyday login method: it chooses the owner's username and
password. Hosted recovery must not bypass tenant identity or allow an admin to impersonate
users without an explicit policy.
A forgotten password is recovered by an email link where the installation sends email (always
on the hosted service), sent to the address confirmed at sign-up (or added later in
Settings → Security); the link works once, for an
hour, and choosing a new password signs the account out everywhere (sessions, connected apps,
assistants). Hosted or approved multi-user admin-assisted recovery needs a reviewed
ownership-proof policy, admin step-up,
audit, notifications to existing verified channels, and a disclosed delay before
any identity change. If proof is insufficient, deny recovery rather than rebind an
account on request. The dashboard has no direct attach/rebind-sign-in control.
Self-host recovery, and recovery for administrators (who do not reset by email), is an
audited host-level procedure: `node apps/api/src/cli.ts password-reset-link <account>` prints a
single-use link, shown once and valid for 60 minutes, that opens the ordinary "Choose a new
password" page for the existing account's username. Using it signs the account out everywhere.
It is not a dashboard rebind and creates no other user. It verifies operator control without
requiring an existing verified email channel or the old public origin, works whether or not
email is set up, and refuses an account without a password or one already being deleted;
normal authentication remains enforced throughout. Where the installation has no email, the
sign-in page tells the person to ask the server's administrator for such a link.

## Roles and authorization

Define capability checks centrally, enforced server-side on APIs, jobs, data access,
and admin actions, not merely hidden navigation:

| Role/boundary | Responsibility |
| --- | --- |
| Account/workspace owner | Own sources, items, captures, settings, sessions, export, and permitted connections |
| Installation administrator | Approved users/access policy, service health, resource/capacity policy, connectors, and operational actions |
| Worker/service identity | Only the narrowly scoped engine/gateway/job operations it requires; not an interactive administrator |

The first self-hosted owner may also be an administrator through explicit, protected
bootstrap. Ownership and administration remain separate permissions in the model.
Hosted signup creates ordinary owners only. Admin grants/removals are explicit,
audited, and require recent strong authentication; protect the last usable admin
and provide an operator-only recovery procedure. Provider account claims never
silently assign installation permissions. Future support/moderator roles require
an explicit capability split; do not grant every helper full administration.

## Administrator dashboard and tooling

Use a clearly separate Admin area within the same product, with concise summaries,
progressive detail, and operator CLI/runbook equivalents for recovery:

- Health: engine/gateway reachability, freshness/lag, error classes, job backlog,
  resource use, physical disk reserve, database/capture/backup health where measurable.
- Accounts: authorized user list, signup/invite policy, status, capacity allowances,
  session revocation and suspension/recovery controls. Hosted tools wait for Gate 6.
  Self-hosted installations (owner decision) also let administrators add household
  members by invitation, suspend accounts and grant or remove the administrator role;
  there is no public signup and no storage allowances. Hosted installations add
  allowances and optional open signup. Each account still has its own private
  workspace; shared workspaces are not implied. Recovery controls follow the policy above;
  they are not an alternative identity-linking path.
- Sources: connector availability, versions/capabilities, rate limits, circuit-breaker
  pause/resume, and maintenance notices without exposing private item titles/tokens.
- Operations: bounded retry/cancel, usage reconciliation, backup/restore status,
  migration readiness, sanitized diagnostics, and a security audit trail.

Dashboard controls invoke fixed, permissioned, replay-safe domain operations with
confirmation/impact preview where destructive; no arbitrary shell, database console,
generic fetch proxy, raw token viewer, or unrestricted user impersonation. Show only
implemented controls. Audit actor, action, target scope, time, and outcome without
content/secrets; define audit retention/access and durable failure handling before
sensitive actions ship. Rate-limit expensive actions and make long jobs observable.

Administration does not mean routine access to everyone's reading. Default dashboard
views use operational aggregates and minimal account metadata. Any exceptional
content access requires a separately approved, scoped, time-bounded, audited support
policy, disclosed to users. This is not end-to-end encryption: a server operator
with filesystem/database access can access server-readable data. Explain these
limits, protect backup/secret access, and never claim that UI permissions constrain
someone who controls the host.

## Gates and reference guidance

Gate 1 evaluates auth/provider/callback and recovery choices without public signup.
Gate 3 includes secure owner/admin bootstrap, central authorization, sign-in/recovery,
and basic health/storage/source diagnostics. Gate 5 proves operational tooling,
admin step-up, auditing and recovery before exposed self-hosting. Gate 6 adds hosted
account management and adversarial account/admin/worker isolation tests before signup.
No administrator feature authorizes deployment or bypasses the launch gates.

References: [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) defines
the external identity layer; [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)
provides OAuth security guidance. These inform the proposal, not a claim that an
auth library, provider, admin system, or recovery implementation has been selected.
