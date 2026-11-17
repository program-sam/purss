# Big feeds

The owner approved following feeds that are too big for the collection engine to read through PURSS's own feed
gateway, which gives FreshRSS a smaller copy of the same public feed. FreshRSS stays the only engine that
collects; the gateway never inserts product items. A person following a big feed is told nothing about its size: the
gateway serves the newest items it could read, silently, and no message in the product speaks of it. This page records
the problem as measured, the design, and what it defers.

## The problem

FreshRSS reads a feed whole before it keeps anything: SimplePie parses the document, then the engine
serializes it into its fetch cache, all inside PHP's `memory_limit` of 128 MB per request. Podcast hosts publish
feeds that grow for ever and repeat each episode's notes in `content:encoded`, `description` and `itunes:summary`.
The Daily (`https://feeds.simplecast.com/54nAGcIl`) is 20.7 MB for 3,039 episodes. Measured in FreshRSS:
SimplePie's parse peaks at 115 MB and the cache serialization at 277 MB (100 MB of serialized data), so a
quick-add through Apache dies at the limit with an HTTP 500, which a person was told as *The site isn't
answering right now; we'll keep trying.* Production runs on a 961 MB server with about 255 MB free; the engine
container has 256 MB, egress 192 MB. FreshRSS's retention keeps a feed's items for 90 days, at least its newest 50 and at most 1,000 (`DEFAULT_ARCHIVING`),
so it never needs a feed's whole back catalogue.

## Decision

Big feeds reach FreshRSS through the egress feed gateway, which streams the upstream feed to its end and serves the engine
the channel's metadata and the newest 50 items, otherwise untouched. Fifty is what FreshRSS keeps of any feed at the least, and
the smaller copy is cheaper for it: measured on The Daily, the copy is 330 KB, which the engine parses and caches in about 24 ms at a
6 MB peak (a 100-item copy was 660 KB, 35 ms and 10 MB). Considered and not taken:

- *Raise the engine's memory limit.* The container, not PHP's limit, is the budget: three concurrent big
  requests would need more than the server has free, and the limit would have to follow the largest feed.
- *The gateway's adapter framework as it is* (`apps/egress/src/gateway/service.ts`): it stages entries as
  JSON, serves them back as RSS the gateway writes itself, releases them only when the product acknowledges
  them, and authenticates each feed with a Basic credential stored in its own database. That is the right model
  for a private service that has to be polled for the engine; for a public feed that already is RSS it would
  re-write every item (losing `itunes:` and other markup), need a feed record, a credential and an
  acknowledgement for each source, and nothing in the product (API, worker) uses it today. The trimming route
  is stateless and sits on the same listener and alias.
- *A competing fetch engine* in the product: forbidden by the project rules.

The route follows the bridge router's pattern ([plan/41](41-source-bridges.md)): an HMAC-signed address made by
the worker, so a public feed that redirects FreshRSS to the alias gets nothing.

## What the engine is given

`http://feed-gateway.internal:8947/t/<signature>/<address>`, where `<address>` is the feed's own address in
base64url and `<signature>` is the HMAC-SHA-256 of `trim\n<address>` under `secrets/feed-trim-key` (made by
`npm run dev` and Compose's `init`; egress and the worker read it, FreshRSS never does). The same feed always has
the same gateway address, so accounts that follow the same feed share the engine's one fetch of it. The
**source's own address stays the feed's**: it is what is shown, exported (OPML writes it) and compared (a
second follow of it is found); `sources.via_gateway` (migration 068) only says which address the worker gives
the engine. A private link goes through the gateway the same way: its link stays in `secrets/source-urls/`, the job carries
the reference and the instruction (`trim: true`), and the worker wraps what it reads.

**The document's base.** The copy is served from the gateway's address, so a relative link in it (an Atom `<link href="/posts/one"/>`,
an RSS item's relative `<link>` or enclosure, a relative `xml:base`) would resolve against `http://feed-gateway.internal:8947` instead of the
publisher. The copy therefore declares where it was read: the gateway puts `xml:base="<address>"` on the root element, the address being the
feed's final one after redirects. A relative `xml:base` the root already has is resolved against it, an absolute one stays, and nothing else
changes (items are byte for byte; entries and items with their own `xml:base` resolve against the root's as before). Confirmed in the engine's SimplePie
(FreshRSS 1.30.4): without it, a feed with no channel link of its own had every relative link, enclosures included, on the gateway's host; with it,
RSS and Atom both resolve against the publisher. (An explicit `xml:base` is inherited by every element below it and takes precedence over the
channel's own link, which SimplePie otherwise uses as the base when a feed has one. So where a feed has an absolute channel link *and* path-relative item
links without a leading slash, they now resolve against the feed's address, as the XML Base standard says, where SimplePie reading the same feed itself
would resolve them against that link; root-relative and absolute links, nearly all of them, come out the same either way. A *relative* `xml:base` is the other
difference: SimplePie reading a feed itself resolves it against nothing and ignores it, so the copy, which resolves it against the feed's address first, is the
more faithful of the two.)

## The trimmer

`apps/egress/src/gateway/trim.ts`, fed by `safeFetch`'s new `sink` (the body is handed over chunk by chunk, never
buffered; every address, redirect, time and decoded-size rule is `safeFetch`'s). It works on the bytes as
Latin-1 text, so any ASCII-based encoding comes back byte for byte (UTF-16 is refused), and finds items by element
structure: comments, CDATA and processing instructions are skipped, so an `<item>` inside them is not one, and
nested elements of the item's own name don't end it. Nothing is parsed inside an item but its date.

**The whole document is read.** Nothing in a feed guarantees the order of its items: a pinned old item may come first, a feed may list 200
items newest first and append a newer batch after them (a 1,001-item feed whose first 200 items descend and whose newest item is the 201st
lost that item on every refresh when reading stopped once the first items were in order). So the trimmer never stops early: it reads to the end of the
document, or to its ceiling, and keeps the newest 50 in a bounded list ordered by date as the items go past, one item at a time. The cost is bandwidth,
not memory (see Memory), which is why the gateway spares the publisher and itself the repeated reads (Failure and bounds).

| Limit | Value | Why |
| --- | --- | --- |
| Items kept | 50 | what the engine keeps of any feed at the least |
| One item | 1 MiB | a bigger one is left out whole, never cut inside its markup (a feed of nothing but those is served as its channel) |
| Kept items together | 4 MiB | when the newest are bigger together, the oldest of them go |
| Channel details (before the first item) | 1 MiB | beyond it there is no feed to make of the document: it answers 422, *not a feed* |
| Document read | 64 MiB | the whole document is read, however it is ordered; past this (the gateway's ceiling) reading stops and the newest items of what was read are the answer, with the item the ceiling cut left out (a ceiling inside the first item leaves the channel alone, closed, and none of that item) |

Which items: the newest by `pubDate`, `dc:date`, `published`, `updated` (any namespace prefix); an item with no
date has the one before it (a feed with no dates at all keeps the first 50 listed). The copy is the head up to the first
item (its root tag carrying the `xml:base`), the kept items newest first, and the closing tags the head left open. Channel
elements listed after the first item are not carried.

## When a feed goes through it

- **Follow time.** Discovery reads a feed up to 4 MiB (`TRIM_FEED_BYTES`); a feed cut there is larger than that, and a feed read
  whole with more than 1,000 items (`TRIM_FEED_ITEMS`, counted in what was read) is large too. The candidate is held with
  `large: true` (never sent to the browser). Following it sets `sources.via_gateway = 1` and the subscribe job carries
  `trim: true`. RSS, Atom and RDF only: a JSON Feed is read by the engine as it is.
- **Why 4 MiB and 1,000 items.** Measured in the pinned engine under production's limits (a 256 MB container, Apache's PHP at
  128 MB; one quick-add at a time, the container's memory sampled every 150 ms, idle about 26 MB):

  | Feed | Direct to the engine | Through the gateway |
  | --- | --- | --- |
  | The Daily (20.7 MB, 3,039 items) | HTTP 500 after 4 s (container at its 256 MB) | 2.3 s, container peak 40 MB |
  | A feed shaped like it (17 MB, 3,000 episodes) | HTTP 500 after 2.7 s | 1.8 s, peak 55 MB |
  | The same, 1,500 episodes (8.5 MB) | read in 21 s, peak 141 MB | |
  | 6 MB / 4 MB / 2 MB of the same shape | 19 s, peak 130 MB / 12 s, 100 MB / 6 s, 71 MB | |
  | 24,000 one-line items (4 MB) | HTTP 500 after 3.6 s | |
  | 2,000 / 4,000 / 8,000 / 12,000 / 16,000 one-line items (0.3 to 2.6 MB) | 32 s, 58 MB / 73 s, 82 MB / 111 s, 107 MB / 153 s, 173 MB / HTTP 500 after 194 s | |

  So a feed's cost is in its bytes (about 18 times them while it is read: a 4 MB feed takes 75 MB more than an idle engine, and the
  256 MB container holds two such requests at once, not two of 8 MB) and in its items (the engine stores each one as it adds the
  feed: about 16 ms an item here, and the worker waits 30 s for the answer). 4 MiB is half of the largest shape that was read
  at all, and the cost of one feed in the preview's reach; 1,000 items is about 16 s of the worker's 30. The measurements
  are of this host while it was busy; the items' time is its CPU, so the item limit is the one to lower, not raise, on a slower
  machine. What a feed's text is matters too (a 20.7 MB feed that repeated one set of notes was read, in 67 s, where The Daily
  fails), which is why the bytes alone are not the rule.
- **Subscriptions the engine fails on.** The worker, when `engine.subscribe` gets the engine's own failure (an HTTP 500 from the quick-add
  or a dropped connection, with no reason: the engine words a failure of the feed's site with one; or its refusal of a feed over its download limit) for a web address that is
  not already trimmed, asks `isLargeFeed` (a streaming size check with `safeFetch`'s rules that stops at the first
  byte past 4 MiB), and if the feed is bigger subscribes at the gateway's address and reports `viaGateway`; the API marks the
  source. This covers imports (which never had a preview), retries and everything followed before this existed.
  A feed that is not that big keeps the engine's failure as before.
- **Sources already stuck.** The API's maintenance tick (`retryOverloadedSubscribes`) subscribes once more, once per
  source, the followed sources that say *The site isn't answering right now…* or *The site didn't answer…* and have no
  subscription and no subscription job waiting: those are what the engine's overload looked like. The worker then
  decides as above; for any other cause the answer is what it was.
  Earlier versions also stored *The feed is too large to follow.* (and a not-a-feed message that added *It may be too large*) on sources they gave up on.
  `retryEarlierSizeFailures`, on the same tick, rewords every such source to what the same failure says now (no size, ever) and, for
  a followed source with no subscription and none waiting, queues one more subscription **through the gateway** (`trim`), whether or not
  the source was already marked `via_gateway`. The old text is the marker and is replaced in the same transaction that queues the try, so a
  source is looked at once: a try that fails again says the plain message, which that tick does not match. A suspended or deleting account is left until it can act.
- **Subscriptions that work are left as they are.** Moving one means unsubscribing and subscribing again
  (a new stream), and the engine can't tell the product that a feed has since outgrown its limit (its per-feed errors
  are not read; plan/41 defers that too). A subscription that starts failing to refresh looks quiet, as any
  stalled source does. See Not built.

## What a person sees

Nothing about size, ever. A big feed is an ordinary source whose first items are its newest.

| Case | The source says |
| --- | --- |
| A big feed, through the gateway | an ordinary source; its first items arrive as any source's do |
| Past the gateway's ceiling, or with items over 1 MiB | an ordinary source: the newest items that were read, the rest left out without a word |
| A big feed on an installation without the feed-trim key | the engine is given the feed as it is; when it fails on it, *The collection engine couldn't follow this feed. Try again later or check the link.* (not retried; the worker's job log says why) |
| The engine can't read even the gateway's small copy (its HTTP 500) | the same generic words, not retried |
| The feed's own site down or slow (502/504) | *The site isn't answering right now; we'll keep trying.* (retried at 1, 5 and 30 minutes) |
| Not a feed, an encoding that can't be read, or channel details over 1 MiB (422) | *The address answers, but not with a feed we can read. It may be in a format we don't support.* |
| The feed's own 404, 403, 429 | as for any feed |

## Failure and bounds of the gateway

`TrimService` (egress): one fetch per feed at a time (concurrent requests share it), two at once and sixteen
waiting before *busy* (503), a back-off after a failure with the last good answer served while the host is failing, never an empty
feed in place of a failure. Its log carries the feed's host, never its address. A fetch has the gateway's 60 s in all and 15 s of silence
(reading a feed whole is slower than reading its start, so a feed from a host that can't deliver all of it in that time, 64 MiB at the most, answers
*the site isn't answering* and is tried again). What a publisher declares is no reason to refuse its feed: the gateway reads through `safeFetch` with `streamPastDeclaredLength`, so a
`Content-Length` over 128 MiB (`safeFetch`'s limit for a body that is read as a stream) is read as far as the trimmer's own 64 MiB ceiling like any other,
and only the bytes that actually arrive are bounded. A transfer that still went past 128 MiB would be answered 502 with `too_large` in the log, for the operator. Since every refresh reads a feed to its end, the reads are shared and conditional:

- **One trimmed answer per upstream address, shared by every account.** Each account that follows a feed has its own engine subscription, but they all hold
  the same gateway address (the signature is a function of the address), and FreshRSS's cron refreshes the feeds that are due at minutes 3, 18, 33 and 48,
  so their requests for one feed come close together. The first request makes the answer, which is kept in memory for **ten minutes** (`cacheMs`) after it was made or last confirmed, and every
  other account's request in that time is given it. The key is the **whole upstream address**, a private feed's key in the query included: another token
  on the same path is another feed with its own fetch and answer, and a request is checked against its signature, valid for that exact address, before any
  answer is looked up (another address's signature, or none, is the same 404 whether or not an answer is kept).
- **Conditional requests.** When a kept answer is older than that, the gateway asks the publisher whether the feed changed, with `If-None-Match` and
  `If-Modified-Since` from the ETag and Last-Modified that came with the answer it holds. A `304` renews the kept answer for another window and reads nothing
  (log outcome `not_modified`, 0 bytes); a `200` is read in full and replaces the answer and its validators. A 304 that comes from another final address than
  the one the kept answer was read from (a redirect that moved) is not reused: the feed is read again, plainly, so the answer's base is always the address
  it was read from. A publisher that sends no validators is asked plainly each time. The validators go with the answer: when the answer is dropped, so are they.
- **Bounded memory.** The answers kept weigh 8 MiB in all (a body, the address and base it is kept under, and its validators; least recently used out), and at most
  500 addresses are remembered; an answer bigger than the whole budget is served once and not kept. The Daily's answer is 0.33 MB, so about 25 fit.

## Memory

Egress is the process that must not grow: its container is 192 MiB and the process holds about **125 MiB idle** (VmRSS of
`node apps/egress/src/main.ts` after start-up, the connectors being loaded for discovery and the bridge), which is also all the engine's
only way out has. Every feed is now read to its end, so every big feed is a full read. Measured with the real egress server in one process (its
`TrimService` behind the gateway listener; the process's idle level, 123 to 126 MiB resident after a collection, is the baseline), the feeds served by a second process and
asked for by `curl` (so that a client's own garbage is not counted), the peak being the process's high-water mark reset after the settling
collection (a throwaway script, not kept):

| Read | Answer | Time | Peak over idle |
| --- | --- | --- | --- |
| The Daily (20.7 MB, 3,039 episodes, newest first), read in full | 0.33 MB, 50 items | 0.4 s | 5.4 MiB (five in a row from a publisher with no validators: 16 MiB, levelling off) |
| Two of those at once | | 0.8 s | 13 MiB |
| A synthetic feed of 7,689 episodes (45.7 MB), newest first | 0.33 MB | 0.9 to 1.1 s | 11 MiB |
| The same listed in no order | 0.33 MB | 1.0 s | 17 MiB |
| Two of those at once (the most the gateway runs) | | 2.4 s | 32 MiB |
| **A refresh of an unchanged feed** (the publisher answers 304), either feed | the kept copy | 21 to 38 ms | nothing read: the peak rises 0.1 MiB |
| The answers kept, at their 8 MiB budget (The Daily's, 0.33 MB each, over 24 addresses) | 7.5 MiB in all | | 7.5 MiB held once collected; resident 26 to 30 MiB over idle while it filled |
| The worst case: the cache full, then two of the 45.7 MB feeds in no order at once | | 4.7 s | **42 MiB** (newest first: 30 MiB) |

Nothing is held but the text not yet classified, the channel's head, the item being read and the items kept (4 MiB at most), so the
footprint does not grow with the feed. What grows it is Node's garbage: a buffer for every piece off the wire and a string for every
piece read, collected only after tens of megabytes, which in so small a margin is the difference between a fetch and an out-of-memory kill of
the proxy. A fetch is therefore collected after each megabyte it reads past the first (`collectGarbage`, which turns on V8's `gc` at run
time) and when it ends if it read more than half a megabyte: a few milliseconds each, which a full read now pays on every feed (The Daily, with
its 20 collections, takes 0.4 s; the 45.7 MB feed about a second). The cache costs what it keeps (the answers, their addresses and validators: 8 MiB at most), and
Node keeps the pages it has used, so the process stays resident at what the largest recent read needed.
These runs were made when the copy held 100 items (0.6 MB for The Daily); the copy now holds 50 and is about half as big, which changes only what
an answer weighs and what the cache holds (the answer and cache rows above are those figures at the new size; the budget now holds about twice as many), not what
reading a feed costs. These runs were queued as `hostlock work`, not `hostlock measure`: a resident-memory peak does not depend on quiet cores, and the timings
here are only indications.

The worst case the limits allow, the cache full and two reads in full at once, is **42 MiB over idle: 167 of the container's 192 MiB, 25 MiB to
spare** for the proxy's own work and the bridge router at the same moment. It is a tighter margin than the early-stopping trimmer's (about 35 MiB, with two
reads of feeds in no order), and the levers, if it proves too tight, are the number of fetches at once (`concurrency`, 2)
and the cache's budget (`maxCachedBytes`, 8 MiB), not the limit.


## Self-hosting

The same code runs in the egress process under `npm run dev` and Compose. The key is created by `npm run dev` and
`init`; an installation upgraded under Compose gets it the next time `init` runs; without it nothing changes except
that a big feed goes to the engine as it is, and fails there if it must. `PURSS_GATEWAY_ENGINE_URL` (worker) must follow `EGRESS_GATEWAY_ALIAS` or the
gateway port if they are changed.

## Not built

- Trimming for JSON Feed.
- Moving subscriptions that work today, or noticing that a feed has outgrown the engine's limit since it was followed
  (needs the engine's per-feed errors, deferred in plan/41).
- A per-feed item count; 50 is fixed.
- Answering the engine's own conditional requests (the gateway sends no ETag, so a refresh costs the engine a local read of the 0.33 MB copy; the
  publisher is not touched by it while the answer is fresh).
- Per-source health from the gateway in the product (the administrator sees the outcome in egress's log line).

## Acceptance

`npm run check`, `npm test`, `npm run test:engine` (`tests/engine/big-feed.test.ts`: the 20 MB fixture fails when added
directly, is followed through the gateway within the engine's 128 MB with the whole feed read, a changed feed is read again on refresh,
an unchanged one is a 304 that gives the engine the kept copy, it moves, and an endless feed that is followed from what was read up to the ceiling),
plus unit tests for the trimmer (order, the default of 50, a newer item after 200 in order, CDATA, namespaces, huge items, the ceiling that serves what was read, malformed input, chunk
boundaries, the root's `xml:base`), the gateway (signature, address rules, failures that never speak of size, a feed past the ceiling, sharing, bounds, logs, a late newest item, conditional requests and
their 304, the cache keyed by the whole address, validators dropped with their answer, the base after a redirect), the follow decision, the retry
and migration 068. `tests/engine/big-feed.test.ts` also follows RSS and Atom feeds with relative links (root-relative and path-relative links and enclosures,
relative `xml:base` on the root and on an entry) through the gateway and compares each with the same feed read by the engine at its own address.
