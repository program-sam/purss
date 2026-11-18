# Registry fallbacks

When discovery finds nothing on a page (no feed advertised or at the usual addresses, a page
that refuses automated readers, a journal it can't place), it asks open registries what the
page is before giving up. The owner asked for OpenAlex and Wikidata; this page records what
each can do, what was built, and what it defers.

## What the registries can do

Measured on 2026-11-18 against the official addresses of 69 anthropology journals and a
dozen news sites:

- **Wikidata** records many sites' official website (P856), and for journals and newspapers
  their ISSN (P236) and sometimes a feed address (P1019). An exact lookup of a page address
  matched 18 of the 69 journal addresses (16 with an ISSN; none with a feed), and gave feeds
  for some news sites (The New York Times, Le Monde, Tagesschau; not NOS or The Guardian).
- **OpenAlex** can't be asked which journal an address belongs to: its journal records'
  homepage field is neither filterable nor searchable, and is often an old address (Ethnography's
  is a retired sagepub.com page). Without an API key every server behind one address shares a
  small daily allowance, and a key needs an e-mail address registered with OpenAlex. Its
  journal search by name adds nothing to Crossref's, which discovery already uses. **Not
  built**; reconsider only as a second article source for journals Crossref lacks, with a key
  the operator registers.

## The fallback

The last step of discovery for a web address, after everything else came back with nothing
and only after its generic answers: no feed found on the page, or a page that turns automated
readers away (403, 429, "busy or limiting") or is broken (5xx). Asking a registry puts no load
on the site, and whatever it names is checked like any feed. Not after a more particular
answer (a fediverse post, a page that isn't there, one that wants a password, Duke's message),
not for an address by number, and not when the journal's ISSN is already known, which the
Crossref step handles:

1. **Ask Wikidata which item has this page as its official website.** One search request,
   `action=query&list=search&srsearch=haswbstatement:P856=<a>|P856=<b>|…`, over the page's
   address variants: `http`/`https`, with and without `www.`, with and without a trailing
   slash; then the same for the site's front page when the page is not the front page. No
   query string or fragment is ever sent, and nothing is sent for an address that looks
   private (`privateUrlReason`). Then one `action=wbgetentities` request for the matching
   items (at most 5) with their P856, P236 and P1019 claims. Only items whose P856 really is
   one of the variants count (the search index can lag behind edits).
2. **Feeds Wikidata lists (P1019)**, at most 4, are probed like any other feed (safeFetch,
   the address rules) and offered when they answer, with a note that Wikidata, not the site,
   named them. One from the front page's item when the page is a section is offered as the
   whole site's feed (the existing whole-site note).
3. **ISSNs Wikidata lists (P236)** become the journal's ISSNs, and the Crossref step (plan/45)
   offers the journal through Crossref. Only the page's own item counts for ISSNs, not the
   front page's (a publisher's front page is not one journal). The publishers whose feeds are
   made from an ISSN (Wiley, Elsevier) are already found by their addresses.

Measured after building it, one site at a time, on 120 sites Wikidata lists with a feed: 86
were already found; of the 34 that weren't, 13 now are (among them DLR, Deutschlandfunk, the
University of Innsbruck, Stack Overflow, franceinfo, weather.gov, OVHcloud); the rest list
feeds that no longer answer, and none got worse. Of the 69
journal addresses, the two whose discovery failed and whose ISSN Wikidata knows (Ethnography on
SAGE, L'Homme on Cairn) now get the journal through Crossref.

Requests go to `https://www.wikidata.org/w/api.php` through discovery's own fetcher (safeFetch,
counted against the lookup's request cap) with a short deadline (8 s each) so a slow Wikidata
can't use up the lookup's budget; a failure or timeout there leaves discovery's own answer.
safeFetch's own User-Agent (Wikidata accepts it). Nothing is cached: the
step runs only when discovery would otherwise fail, which is rare and person-paced.

The pasted address (page and front page, without query) is sent to Wikidata; the user guide
says so, as it does for the names and ISSNs sent to Crossref.

## Not now

- OpenAlex (above).
- Asking what other people on this server follow for a site: it crosses accounts, so it needs
  its own privacy review.
- Wikidata's SPARQL service: slower, rate-limited (429s and 502s in the survey) and not
  needed for exact lookups.

## Acceptance

`npm run check`, `npm test`, plus recorded-answer tests: an address variant match, a lagging
search hit whose P856 doesn't match (ignored), feeds offered with the note and a dead one
dropped, a section page getting its front page's feed as the whole site's, ISSNs leading to
the Crossref choice, a private-looking address sending nothing, Wikidata failing or slow
leaving the original answer, and the step not running when discovery found something. Live:
the survey's journal addresses whose discovery fails today, before and after.
