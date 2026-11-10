# Shareable collections and subscriptions

## Intent

Let someone follow a friend's reading selection, a favorite creator's discoveries,
or an expert's topic collection alongside their own sources. Human curation is
an optional discovery path, not an engagement-ranked social feed. Users can browse
before following, understand who curates a collection, and leave without losing
their own organization. Sharing a basket or a collection (source or filter) is built (plan/22);
source bundles for followers (below) are later work.

## What is shared

Sharing is a setting on a basket or a collection, not a separate list (owner decision). A basket or
collection stays private unless its owner shares it with **Share**, which creates its public page
and Atom feed: a live projection of its items, under its name, with a chosen attribution, an
optional description and an opt-in for search listing. The Sharing page lists everything shared,
with its state. On hosted installations sharing is part of Plus (administrators always);
self-hosted installations always have it. A page whose account's plan no longer includes sharing
stops showing; nothing is deleted.

- What visitors see per item: title, original link, a short plain-text summary, source name and
  date, and the owner's public note when they wrote one. Never reading progress or states, private
  notes and highlights, saved text, or anything else from PURSS. Items from private
  sources and links that carry a key never show. A basket's page is newest-kept first; a
  collection's newest first; the page shows up to 200 items, the feed 100.
- Filter collections can be shared unless their rules read reading state (`workflow`, `fresh`,
  `opened`, `capture`); one changed that way after sharing stops showing. A text rule on a shared
  page matches the items' own text only, never annotations. Rules on baskets are allowed and
  pointed out in the review.
- Before sharing, the review shows the exact page and what of the person's own becomes public
  (everything kept in a basket from then on, links they saved themselves with their own titles,
  their public notes) and asks for confirmation. The confirmation covers the settings reviewed;
  the items are live. Changing settings voids it; listing an already public page asks again.
- Public notes are per share and item (plain text, 500 characters), shown with the chosen name on
  the page and as the entry's content in the feed; the editor says each time who will see them.
- Curator attribution is a chosen public display name, with pseudonyms allowed; never default it
  from account email, login, or internal IDs. Feed author metadata carries the chosen name, never
  an account email.
- Pause hides the page; Stop sharing removes it, its address and its notes; deleting the basket or
  collection stops sharing it. Older export files may hold separate shared collections; an import
  skips them.

Keep two subscription meanings explicit:

- Curated items: follow the items a person selects, including later additions.
- Source bundle: explicitly opt to follow selected publications/channels; this can
  produce many more items than the curator personally selected. Show the sources
  and expected difference before confirmation. Never subscribe to each linked
  source merely because someone followed a curated-item collection.

A shared page never exposes the owner's raw filter rules. Sharing is not permission to
redistribute full articles, paid material, or stored basket captures: pages carry attributable
public links and minimal share-safe metadata. Private/authenticated sources, links that carry a
credential (in user info, the query or a secret-looking path), annotations, workflow, read history
and saved text are excluded.

## Following and ownership

Offer a share page and a standards-based RSS/Atom output that other readers can
subscribe to. In this product, guide users from the share link to a preview and
Follow action; FreshRSS remains the ingestion engine. Do not require an account on
the curator's installation to read a public publication. Self-hosted and official
hosted installations should interoperate through the same publication contract,
without requiring a central discovery service or a new federation protocol.

Subscribers choose their own views, workflow, and baskets. Curator identity and the
original author/source remain distinct. Following is live; if one-time import
is ever offered, label it separately. Overlapping collections and directly followed sources
must preserve provenance and use the existing identity/reconciliation rules rather
than blindly collapsing equal URLs or creating duplicate libraries.

Unfollowing stops updates, not deliberate keeps. Removing an item or unpublishing
stops future publication but cannot recall copies already fetched, exported, cached,
or kept by recipients. Explain this before the first share. Publisher deletion and
subscriber retention are separate; never promise remote erasure. Feed windows are
bounded discovery outputs, not complete archives. Specify pagination/backfill and
edit/removal behavior before implementation; plain RSS alone cannot guarantee all
historical items or reliably propagate retractions to other readers.
Account deletion or suspension unpublishes its outputs; a managed uninstall includes
stopping publication. Retiring a self-hosted installation requires the operator to
remove remaining public hosting/caches. None of these actions recalls existing copies.

## Privacy, limits, and delivery gate

First sharing slice: deliberate public publication only, private by default.
Unlisted links are not private authorization. Invite-only audiences need a separate
reviewed authentication and revocation design; no guessable private feeds or secret
tokens in public URLs, analytics, or logs. No people graph, messaging, collaborative
editing, or follower-count ranking is required.
Curators are not shown follower identities; following must not disclose the
subscriber's workspace or account. Publication access logs are minimized and kept
only under the operator's stated retention policy. Remote feed servers can observe
fetcher IPs and request metadata, so do not promise anonymous following or that a
self-hosting operator cannot inspect their own server logs. First-slice following
is poll-only; push callbacks need their own privacy review before being offered.
Share pages and feeds request no search indexing by default; indexing is an explicit opt-in.
This is discoverability guidance, not access control or a guarantee against indexing.

Serve only the published projection, never internal workspace IDs or unrestricted
item endpoints. Sanitize metadata, rate-limit publication reads and following, and
apply existing SSRF/egress protections to remote collection URLs. Charge retained
subscriber copies under their own storage rules; publishing must not silently create
extra durable copies or evade quotas.

Every installation shares under one abuse policy:

- Each public page links to a report form (`/p/<slug>/report`, a plain form that posts only to
  itself). A report keeps the chosen reason, the visitor's explanation and an optional contact,
  never their address; at most five per address an hour and 50 open per page, past which more
  are thanked but not stored. Every administrator gets one bell entry per page per day.
- *Administration → Reports* lists reports and shows only a reported page, as visitors saw it.
  Taking it down (with step-up and a reason) pauses it at once, closes its open reports and tells
  the owner why; the owner keeps the basket or collection but can't share it again, or remove its
  page, until an administrator restores it. Dismissing closes one report. Every step is audited.
- Removal: pages and feeds are cached for at most 60 seconds, so pause, stop and takedown
  reach visitors within a minute; copies that visitors or feed readers already fetched can't be
  recalled, and the publish statement says so.
- Search indexing stays opt-in per page; turning it on for an already public page needs its
  own confirmation. Item links are always `nofollow`, so listed pages are no use for link spam.
- `/follow?url=…` is a follow page any site can link to (a "Follow" button made in Settings →
  Connected apps, or a shared page's follow link): it opens Add source here with the
  address filled in, or tells visitors to paste the feed into any reader. Hosted pages also link
  to the product.

Gate 7 follows the private-PURSS core and deployment/security gates; it may be
delivered self-hosted without waiting for official hosted signup. Require owner
approval before implementation or public exposure. Prove preview/publish/unpublish,
external-reader subscription, cross-install following, mixed-source presentation,
overlap handling, privacy isolation, storage behavior, and the limits of revocation.
People can curate for others without surrendering control of their private PURSS.
