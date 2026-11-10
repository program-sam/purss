# Product

## Promise

Your internet, organized by you: follow sources, collect what matters, and choose
how to see it. No opaque engagement ranking, advertising-driven feed, or mandatory
AI service. Deterministic filters, chronological order, and user-chosen rules are welcome.
The goal is to embrace personal curation, not persuade people to dislike algorithms.
The experience should be appealing, lively, and fun. Familiar engagement patterns,
notifications, new-content highlights, and satisfying interactions are welcome when
they support what the user chose to follow and remain understandable and controllable.
Self-ownership means understandable storage and reliable exit/export, not merely
running software on one's own server. An official hosted service with account
creation and a free storage allocation is also a planned delivery mode.

Sources share one experience whether their updates originate as RSS or through an
approved proprietary-service adapter. RSS/FreshRSS remains the collection backbone;
service origin, access limits, and privacy remain visible. Prefer external sign-in
and source authorization, with separate consent and no collection of service passwords.
Include role-scoped administrator accounts and tooling without exposing those
controls in everyday browsing. Unsupported integrations are an honest product state.

## Users and jobs

- A researcher follows journals, saves papers by topic, and revisits a durable library.
- A curious reader follows people and websites without maintaining separate inboxes.
- A viewer follows video channels and keeps a watch-later board with clear source identity.
- A self-hoster installs one product without administering several user-facing tools.
- A nontechnical user pastes a link, sees a preview, and understands what following it means.

## Product vocabulary

Expose Sources, Collections, Baskets, and Views. Use To read / In progress / Finished
for workflow, with Undecided and Ignored as additional outcomes. Keep technical concepts
such as provider instance, FreshRSS user, XPath, and bridge route out of normal navigation.
Vocabulary is a usability hypothesis; test whether users distinguish collections
and baskets before committing to labels.

## First usable slice

One owner, a private PURSS, managed FreshRSS, native feed discovery, journal/blog
and YouTube-channel subscriptions where an official feed is available, collections
(followed-source and query modes), gallery and list views, a workflow board, durable
baskets, and basic search. A single item must be usable across these surfaces without
duplicate copies or conflicting state.
Make fresh arrivals easy to notice with clear new-content highlights and optional
counts; freshness cues must not overwrite workflow or reading progress.
Include a compact storage indicator and a useful breakdown for feeds and kept
items, with transparent limits, freshness, and a confirmed deletion path for unkept
content. The complete storage-management page and account export follow in Gate 4;
do not show dead links to those features in the first slice.

## Subsequent capabilities

Tables, timeline and query-mode collections, configurable dashboard
sections, reviewed connector catalog, manual URL capture, export/import of PURSS
data, accessible bulk actions, and configurable notifications for followed sources
and collections. Notification channels and delivery guarantees need implementation
validation; following a source must not imply instant or exhaustive alerts.
Custom fields, household/multi-user hosting,
shareable collections that others can subscribe to, and extensive dashboard composition
require later gates. Follow friends' or creators' selections without an algorithmic
social feed; sharing is optional and private collections never become public by default.
See [shareable collections](19-shareable-collections.md). Highlights and notes on items are built ([annotations](26-annotations.md)), and so is browser-assisted capture through the browser extension ([plan/32](32-browser-extension.md)).

## Non-goals

No full Notion clone, general social publishing, native mobile application, video
downloader, paywall bypass, arbitrary plugin marketplace, collaborative editing, or
universal website guarantee in the MVP. Readability extraction is not a promise to
archive an external site's full content. The first delivery target is self-hosting
with a consumer-quality UI. The planned hosted service follows separate isolation,
operations, and safety gates; its pricing and funding model are not settled.

## Success evidence

Observe users adding an ordinary feed and a video channel without seeing backend
settings; moving an item between workflow states; keeping it in a basket; finding
it later in another view; and understanding a broken source. Record task completion,
confusion points, and accessibility failures rather than inventing conversion targets.
