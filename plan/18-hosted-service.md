# Official hosted service

## Direction and boundary

The owner intends an official hosted option: create an account, receive a free
storage allocation, and use the same self-ownership-oriented product without a
server. Optional extra paid capacity and/or donations may support it. This is an
approved planning direction, not a service launch, pricing decision, payment
integration, promise of free unlimited storage, or permission to enable signup now.

Self-hosting remains a complete supported path, not a deliberately degraded trial.
Keep one product/domain model and portable exports. One account owns one workspace
initially. Collaboration, organizations, and public curated feeds are separate work.

## Foundations required from the first schema

- Scope data, storage ledgers, search, jobs, captures, and secrets to owner/workspace.
- Distinguish installation mode and operator policy from product features.
- Separate capacity entitlements from a subscription/payment provider. Free,
  operator-granted, and any future paid allowances use the same admission rules.
- Preserve baskets and export rights independently of plan status.
- Keep account identity distinct from its upstream FreshRSS user/engine identity.

The single-owner first implementation may have only one of each, but must not bake
in globally unowned objects or a browser-selectable upstream user. Hosted topology,
database choice, job fairness, and per-user FreshRSS controls need a feasibility gate.
Do not claim the single-host SQLite proposal has already passed multi-tenant scaling.
Gate 3 only needs an operator-set allocation or an explicitly unallocated self-host
account. Free/paid grant lifecycles and billing integrations wait for the hosting
gate or later approval; the domain boundary is not a reason to build them early.

## Before hosted registration opens

Prefer supported external/OIDC signup with a reviewed recovery path, separate from
source OAuth grants. Public signup never creates administrators. Provide explicit
administrator accounts, a role-scoped dashboard, and operational tooling; routine
administration must not expose reading histories or service credentials. See
[identity and administration](21-identity-and-administration.md) for permissions,
provider-independent self-hosting, support access, and the operator threat boundary.

Prove signup verification and abuse resistance, account recovery/deletion, session
revocation, cross-tenant authorization, secret isolation, authorized object downloads,
worker fairness, per-account resource budgets, quotas, reconciliation, monitoring,
backup/restore, and incident response. Decide the registration/age/access policy,
privacy terms, support capacity, acceptable-use rules, and legal obligations with
appropriate review before launch. No jurisdiction or compliance result is assumed.

FreshRSS accounts must be isolated per customer or through a demonstrably stronger
boundary. Prove no leakage through engine operations, imports, identifiers, search,
health views, caches, background jobs, or exports. Never trust a workspace ID merely
because the caller supplied it. A storage quota alone does not stop fetch/CPU abuse.
Limit native engine backlog as well as product growth; keep a physical reserve.

## Plans, capacity and funding

The owner decided the hosted plans (packages/domain/src/plans.ts): **Free** allows
100 followed sources and 4 collections, **Plus** 1,000 sources and unlimited
collections, at €48 a year or €5 a month including VAT. Administrators are
Unlimited. The API enforces the counts inside the write transaction of every path
that adds a followed source or a collection (follow, re-follow, OPML, MCP, import);
saved links don't count. Users see sources used of their plan instead of storage.
The byte allocation stays as an administrator-only safeguard against disk abuse.
The server keeps no audio or video files for users; the apps download them to the
device only. On the hosted service people pay for a plan through Stripe; administrators
can still set any plan by hand, and self-hosted installs have no plans at all.

Paid plans: Plus (€5 a month or €48 a year: 1,000 sources, unlimited collections, sharing) and
Pro (€10 a month or €96 a year: everything in Plus, 5,000 sources and Smart filters with 25
million Jev tokens a week; see [Smart filters](36-ai-filters.md)).

Payments run in a separate billing service that the project keeps private: it holds the
Stripe keys, the prices, Checkout, the customer portal and the webhook. PURSS itself stores no
payment details and knows only an optional `PURSS_BILLING_URL` and `PURSS_BILLING_SECRET`
(hosted mode only, apps/api/src/billing.ts). Settings → Plan asks PURSS for a signed ticket
naming the account and sends the person to the service; the service sets Free, Plus or Pro back
through `POST /api/billing/plan`, signed with the same secret. It can never change an
administrator or an account the operator made Unlimited, and an account that no longer exists
answers 404, after which the service cancels its subscription. A cancelled plan lasts to the end
of the paid period and then becomes Free; nothing is removed (see below). Without the two
settings, Settings → Plan only shows the plan and says the administrator sets it.

If paid capacity is introduced, disclose the allowance and what counts, make renewal
and cancellation clear, and define grace/downgrade policy before accepting money.
Capacity reduction may leave an account over quota: preserve data and read/export
access, block new growth, and offer user-controlled cleanup or renewed capacity.
Do not automatically delete baskets to fit a lower plan.

A donation is voluntary support, not an implicit capacity purchase or recurring
entitlement. If a benefit is attached, explain it separately and define its rules.
Avoid advertising-driven incentives, sale of reading histories, or locking export
behind payment. Payment processing, if chosen, stays external to card-data handling
in this product; provider events require verification and idempotent entitlement updates.

## Hosted ownership is honest ownership

Users control organization, retention choices, and an exportable copy of captured
data; they do not own the operator's hardware or automatically gain publisher rights.
State clearly what is stored, who can administratively access it, encryption limits,
backup retention, account deletion timing, and how to leave. Do not claim end-to-end
encryption if the server reads/processes content.

Plan closure, inactivity of free accounts, prolonged nonpayment, abuse suspension, and service failure with
notice/export pathways where safe and lawful. Indefinite retention means no routine
automatic expiry of kept items, not a promise of perpetual hosting or perfect recovery.
Do not make a security/abuse suspension an avenue for accessing another tenant's data.
No inactive-account purge is authorized by this plan. Decide and disclose any
inactivity/closed-account retention policy before hosted beta, including advance
notice, return/grace handling, and a meaningful export opportunity. It must not
silently contradict the kept-item contract or retroactively change it without consent.

## Hosted launch gate

Run adversarial two-account tests, quota/concurrency/replay tests, resource-exhaustion
exercises, restore/export and hosted-to-self-host migration, plus independent security
review. Prove the consumer signup journey on real devices. Do not open registration
until these gates and operator readiness are approved. Funding experiments are a
later explicit decision, not a prerequisite for the first self-hosted vertical slice.
