# Crossref journal feeds

The owner asked for journals to be followable through Crossref, the open registry where
publishers register every article's DOI, as an extra choice next to a journal's own feeds.
The case that started it: Wiley switched off the feeds of its former Hindawi journals
(`/feed/cad/most-recent` answers 404, "There is no RSS feed available for this content
series"), so an open-access journal still publishing every week could not be followed. Duke
University Press refuses automated readers, so its journals (Public Culture, Ethnohistory)
had no feed either. Crossref has all of them.

Owner's decisions: offered on every installation (not only where RSS-Bridge runs); a
journal's own working feed stays the preselected choice, Crossref is listed after it, and
is first (so preselected) only when no publisher feed answered. FreshRSS stays the only
engine that polls.

## Source identity

A Crossref source is a bridged source (plan/41): `bridge:crossref/<issn>`, the ISSN without
its hyphen and with an upper-case check character (`bridge:crossref/15348687`), checked by
`normalIssn`. A journal has two ISSNs (print, electronic) and Crossref's records under each
differ (1,354 works under 1534-8687, 1,728 under 1520-3247 for the motivating journal), so a
source covers the records of its own ISSN. Discovery picks the electronic ISSN when Crossref
names one. Following the other ISSN as well makes a second source with its own items (GUIDs
are matched per source); that is accepted, not merged.

- Page address (site and OPML export): `https://portal.issn.org/resource/ISSN/1534-8687`.
  Discovery reads that address as the Crossref source itself, as it reads a bridged
  service's page (plan/41), so an exported Crossref source imports as the same source. A
  bare ISSN (`1534-8687`, `ISSN 1534-8687`) is a request for the journal's choices
  (Crossref, plus a publisher feed when the ISSN's publisher makes one from it, as
  `planFromIssns` already does).
- GUID: `doi:<doi lower-cased>`; link `resolverUrl(doi)` (each part escaped: old DOIs
  contain `#`, `<`, `;`). `postId` decodes the doi.org path once and lower-cases it, so
  GUID and link survive the router's round trip. DOIs are case-insensitive.
  The same article followed through the publisher's feed has another GUID; following both
  is the user's choice and shows both.

## Backend

The bridge router (apps/egress/src/bridge/router.ts) gets backends per service instead of
one list for all: the RSS-Bridge services keep `rss-bridge`, `crossref` gets a new
`crossref` backend. The router answers, caches, backs off and logs exactly as for the other
services (10-minute cache of good answers, one fetch per key at a time, 4 at once).

- Request: `GET https://api.crossref.org/journals/<ISSN-with-hyphen>/works?sort=created&order=desc&rows=40&select=DOI,title,subtitle,author,abstract,created,published-online,published,type,container-title`.
  `created` (when the DOI was registered) orders by arrival: an old article whose record is
  updated does not come back to the top, as it would with `indexed` or `updated`.
- Fetched in process with `safeFetch` (as egress's feed trimmer does): the origin is the
  constant `https://api.crossref.org`, the ISSN the only variable part and checked against
  the key pattern, no redirects followed, 30 s deadline, 4 MiB decoded body. User-Agent
  `PURSS feed bridge (+https://purss.app)`; no e-mail address (Crossref's polite pool asks
  for one; an operator setting can be added later).
- Crossref's public pool allows one request at a time and 5 a second (`x-concurrency-limit:
  1`, `x-rate-limit-limit: 5`, interval 1 s). The backend therefore runs its requests one at
  a time across all journals, at least 250 ms apart, and after a `429` (or `503`) waits out
  `Retry-After` (at least 60 s) for every journal, answering `http_429` meanwhile; the
  router then serves each journal's last good answer or its usual failure. Discovery's
  preview of a Crossref source goes through the router and so through the same queue. The
  API's own Crossref lookups (a DOI's journal, a journal-name search) are made only when a
  person pastes something, as today, and stay outside it.
- Crossref's JSON becomes RSS inside the backend (a pure function in
  `packages/connectors/src/crossref.ts`, fixture-tested), which the router then parses and
  re-serves like any backend output; `postId` reads the DOI back from the doi.org link.
  - title (+ subtitle after a colon), authors ("given family", at most 10, then "et al."),
    abstract: JATS markup reduced to plain paragraphs (`<jats:p>` → `<p>`, other tags
    dropped, entities kept; the router's existing sanitising applies after);
  - date: `published-online` when it has a day, else `created`.
  - Dropped: entries whose type isn't `journal-article`, and front-matter titles (Issue
    Information, Cover Image, Masthead, Editorial Board, Table of Contents, Front Matter,
    Back Matter), matched whole.
  - Channel title: the works' `container-title`, else "ISSN 1534-8687" (an ISSN without
    works).
- `404` from Crossref (an ISSN it doesn't know) is `http_404`, a failure, never an empty feed.

## Every installation

Today the router listens only when `EGRESS_BRIDGE_BACKEND` (RSS-Bridge's address) is set. It
becomes: the router listens whenever the bridge key exists; the RSS-Bridge services are
enabled only with `EGRESS_BRIDGE_BACKEND`, `crossref` always. The bridge key is created at
install on every installation already (`infra/compose/init.ts`, `scripts/dev.ts`); the API
and worker use it when present. `PURSS_BRIDGE_URL` is set in every compose file, and the dev
script gives the API the router's address whether or not RSS-Bridge started (today it does
so only when RSS-Bridge started). The local-run and self-hosting docs say which services
need RSS-Bridge and that Crossref doesn't.
Discovery offers a service only when the router serves it: `bridgeTargetForPage` and the
descriptor check ask the API which services this installation runs (a list the API gets
from its config: crossref always when the router is configured, the RSS-Bridge ones only
with the RSS-Bridge flag).

## Discovery

Wherever discovery identifies a journal and knows (or can learn) its ISSN, it previews
`bridge:crossref/<issn>` through the router and adds it as a candidate after the
publisher's feeds: origin "Crossref", via "Registered articles", note
"Every article the publisher registers with Crossref, the open registry of scholarly
articles. Can arrive a few days after the publisher's own feed, and some publishers send no
abstracts."

It is added after discovery's usual ordering and copy removal (so `orderByVia` doesn't rank
an unknown "Registered articles" above the publisher's feed, and `sameEntries` doesn't drop
it for carrying the same DOI links), and:

- when a publisher articles feed answered, it is marked `alternative: true`, a new optional
  candidate field ("another way to follow the same journal"); `preselect` decides among the
  other candidates as today and never starts on an alternative unless it is the only one;
- otherwise it is the journal's own feed (`matchesPage: true`) and so preselected.

Regressions: publisher feed and Crossref both matching (publisher chosen); identical DOI
links (both kept); a lone publisher feed that is only listed (choice unchanged).

Where the ISSN comes from:

1. Wiley journal addresses whose code is an ISSN (already parsed).
2. A DOI (pasted, in an article address): Crossref's work record, already read.
3. A page's scholarly metadata (`citation_issn`, `prism.issn`), already read.
4. Journals named only by a code, a slug or their feed: Crossref's journal search for the
   name, accepted only when exactly one journal's title matches exactly (letters compared;
   "Social Anthropology/Anthropologie sociale" also as "Social Anthropology") and, on a
   platform, its publisher is the platform's (Project MUSE hosts many publishers, so there
   the single exact title is enough):
   - a journal feed that answered on Taylor & Francis, Chicago, Berghahn or Project MUSE:
     the journal's name from the feed (Berghahn's and MUSE's entries carry no DOI);
   - Wiley codes that aren't ISSNs (`/journal/cad`): the name comes from Wiley's feed
     channel, which still answers with `<prism:publicationName>` when the feed is switched
     off (404 with an empty channel). Publisher accepted: Wiley or Hindawi.
   - Duke (`read.dukeupress.edu/<slug>`, `dukeupress.edu/<slug>`): the slug's words,
     publisher Duke University Press. Replaces `DUKE_MESSAGE` when found.
   - an Open Journal Systems journal (its pages name the software as their generator) that
     publishes no feed: the journal's name. Other sites are never looked up by name.

A switched-off Wiley feed (404 + empty channel) is no longer offered or treated as "the
journal's feed didn't answer just now"; it leads to the Crossref choice alone.

## Not now

- Following authors (ORCID), funders, publishers or searches through Crossref.
- Merging a journal's publisher-feed and Crossref items into one source.
- An operator e-mail for Crossref's polite pool.

## Acceptance

`npm run check`, `npm test`, `npm run test:engine`, `npm run test:e2e`, plus: fixture tests
for the JSON→RSS conversion (front matter dropped, JATS, dates, authors), the key pattern
and signature, per-service backends, discovery for each ISSN source above (recorded
fixtures), the Crossref-wide queue and 429 cooldown, the DOI round trip with reserved
characters (`#`, `;`, `<`, an encoded slash), and discovery plus following on a dev stack
whose RSS-Bridge isn't running. Live check: New Directions for
Child and Adolescent Development (`/journal/cad`), Public Culture and Ethnohistory (Duke),
Cultural Anthropology (OJS, page metadata), and a Wiley journal with a working feed
(Crossref listed second, publisher preselected), followed in the real app until FreshRSS
has fetched the Crossref source.
