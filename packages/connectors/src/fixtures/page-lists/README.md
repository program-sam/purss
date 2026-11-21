# Page-list fixtures

Public list pages saved on 2026-11-21 for the page-list detector's tests (`page-lists.test.ts`). Each is cut down to
what the detector reads: scripts, styles, comments, inline graphics, forms' option lists and every attribute other
than `class`, `id`, `href`, `datetime`, `itemprop`, `itemtype`, `itemscope`, `role`, `lang`, `rel`, `content`,
`colspan` and ISO dates in `title` are gone; the text and the nesting are kept. The detector reads each cut-down page
the same as the page it came from. A few very long runs of identical items (agenda, news, search results) are cut
after 40 of them. The pages and their text belong to their publishers.

| File | Page | Why it is here |
| --- | --- | --- |
| `anthropic-research.html` | https://www.anthropic.com/research | a blog index with a pinned post and dates in `<time>` |
| `anthropic-news.html` | https://www.anthropic.com/news | the full dated list beats the curated block above it |
| `stripe-blog.html` | https://stripe.com/blog | two lists nearly as good as each other |
| `firefox-releases.html` | https://www.firefox.com/en-US/releases/ | several plausible lists, no dates |
| `paulgraham.html` | https://paulgraham.com/articles.html | bare links, no dates |
| `h-tk-kamernieuws.html` | https://www.tweedekamer.nl/nieuws/kamernieuws | a Dutch page with Dutch dates |
| `nos-nieuws.html` | https://nos.nl/nieuws | Dutch news, links as the items |
| `go-release.html` | https://go.dev/doc/devel/release | a changelog on one page: headings with ids |
| `hn-front.html`, `hn-jobs.html` | https://news.ycombinator.com/, https://news.ycombinator.com/jobs | dates in the `title` attribute, a table layout |
| `melkweg.html` | https://www.melkweg.nl/nl/agenda | an agenda grouped by day, dates from the heading above |
| `govuk-news.html` | https://www.gov.uk/search/news-and-communications | a government list in a search page |
| `rijksoverheid-nieuws.html` | https://www.rijksoverheid.nl/actueel/nieuws | the list is drawn by script: only footer links are left |
| `ec-presscorner.html` | https://ec.europa.eu/commission/presscorner/home/en | an application shell with no content |
