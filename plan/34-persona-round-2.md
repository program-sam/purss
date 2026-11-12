# 34 — Persona round 2: what changes

Source: 40 simulated reports on 2026-11-06 (20 people using the app at e27d1dd, 20 comparing the
public website blind against ten other readers). Consolidated list:
`data/persona-sim2/FINDINGS.md` (ignored by Git; IDs A01…H below refer to it). Work is on the
latest main (275c0f2), so each item is first confirmed there.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Captured text honesty (A01) | A capture is checked before it is called the full text: login/paywall/consent boilerplate, a body that is mostly a reference list, or a body shorter than the feed's own text marks it *partial* ("Only part of the page could be saved: it looks like a sign-in or subscription page"). The reader then shows the feed's own text first, with the capture behind a toggle. "Full text captured" only for a capture that passed | A confident wrong label is worse than none (Leila, Farah, Evelyn) |
| Fetch full article default (A04, A08) | Off for new sources; the follow dialog says what it costs. Confirm that unticking it is honoured | Silent storage growth and failure noise for people who never asked |
| Capture failures in the bell (A03) | One row per source and day: "Couldn't save the text of 3 items from kottke.org", opening that source filtered to those items; counts are items, not attempts; only for sources or baskets where the person turned text saving on | Unnamed, unclickable counts were the most common complaint |
| Kept copy status in lists (A02, A06, A07) | Basket rows and cards show the copy state (text saved / summary only / couldn't save) and the first line of the note; search results show a note snippet when the match is in a note; kept links show their site (domain) instead of "Saved links"; bot-wall titles ("Radware Page", "Just a moment…", "Access denied") are replaced by a title from the address | People must see what they kept without opening every item (Kenji's safety note) |
| Images in kept copies (A08, Bea, Eli) | A basket that keeps readable text also keeps the item's picture and the images inside the captured text, through the egress proxy, up to 20 images and 10 MB per item, counted once in kept storage like the text. Feed items are unchanged | A webcomic or a visual reference *is* the picture |
| Home sections (B01) | Recently kept and filter collections leave out items from collections hidden on Home; an item shows in one Home section only (the first); new filter collections start off Home. | Hidden work kept coming back three times (Leila, Tomas, Ivo) |
| Reading progress (B03, B04) | Progress counts only after the reader is actually scrolled (or 20 s visible for items that fit the screen); reopening resumes at the saved position | "100% read" after a glance, and reopening at the top |
| "Up to date" (B02) | Wording follows the facts: "Nothing new since your last visit" while older unread items exist; "Mark as seen" on non-New items says they were not marked New | Contradicted the pile under it |
| Feed order (B05, B06) | "One feed, newest first" is strict date order; turns stay for the boxed layouts. Home choices per source: More / Normal / Fewer / Only in its own page; Fewer and More apply in every layout | Jules, Farah, Dalia |
| Busy sources in collections (B07) | Source chips can hide a source from the current list ("All but kottke") | Ivo, Evelyn |
| Muted words (B08) | Settings → Muted words: words or phrases, for a week, a month or until removed; matching items stay stored but are left out of Home and lists, with "N items hidden by muted words" | Evelyn's "skip a topic for a month" |
| Type and length filters (B08) | The filter menu adds Type (articles, videos, podcasts) and Length (short ≤ 5 min, long) | Ade's lunch versus rainy evening |
| Reminders on kept items (B08) | "Remind me" on any kept item: a date (and optional note); on that day the bell (and email, if set up) says so, and Home shows "Coming up" for the next 7 days | Luca's exhibition and grant deadline, Sana's closing dates |
| Copy link (F02) | "Copy link" copies the original address; "Copy link to this item in your PURSS" is separate | Recipients got a sign-in page |
| Offline (A05) | The offline set is rebuilt whenever it is missing or stale (not only when the switch flips), and again after To read or keeps change; items show "On this device"; kept items with saved text are included | Ana's toggle repro |
| Sources (C01–C07) | Diagnose the YouTube "took too long" (egress shows quick closes); handle pages that 404 fall back to the channel feed when the channel id is known; multi-feed results preselect the feed matching the pasted page; an empty feed is followed as "No posts yet"; a page whose feed is a podcast is offered as a podcast; a second source with the same name is pointed out; OPML import runs on the server and keeps the file's titles; feed titles like "QC RSS v2" and "Release notes from node" are tidied; "Keep this link" asks which basket (no silent default) and offers readable text; typing a podcast name searches the Apple podcast directory (says so) | |
| Rendering (D01–D06) | YouTube: drop the 💾 enclosure link and the repeated thumbnail; summaries skip lines that are only links or sponsor boilerplate. Bidi: names inside metadata lines are isolated. Large text: rows, sign-in card, sidebar footer and chips wrap instead of clipping. Words in relative dates follow the interface language. Exact version tokens rank first in search. Author lists with semicolons are read as "Kaur S., Turin T. C." | |
| Accessibility (E01–E06) | Keep and Notifications popovers move focus in, are reachable and closable by keyboard, and return focus; item names are title, source and date (excerpt as description); Add source announces a short status, not the whole form; the player is announced, reachable (shortcut and skip link) and returns focus on close; each page sets its title; focus lands on the new page's heading; menus move focus in; links opening a new tab say so; custom checkboxes and radios react to taps on the control | Amara could not keep anything |
| Account (F01, F03–F08) | sign-up's button stays busy and is idempotent (a repeated press finds the account it made only with the same email address and password, and then simply signs in); a confirm link without a session offers the sign-in page; Settings is reachable from the phone header; a shared-computer session shows "Sign out" in the header; password sign-in is by email address; emails put links on their own line; the verify page's 403 is fixed; sign-up shows the free plan's limits on hosted installs; the status button says "Set status" when nothing is set; the To read page is titled "To read, watch and listen"; "Press Control Z" only with a keyboard; docs/user-guide.md matches the app | |
| Website (G) | Prices and the comparison table belong to the annual-billing work (site/annual-billing) and are left alone here. Phone app: "Coming to the app stores. Until then, install it from your browser" instead of "How to build it"; self-hosting detail moves below the hosted story; everyday examples instead of "Thesis sources"; FAQ answers for languages and right-to-left text, reminders, sharing, images, offline, passwords on borrowed computers, who runs it, accessibility; "Passkey or password sign-in"; mockup controls hidden from assistive tech; the phone pill shows the hosted plan too | |

## Not changed, with reasons

- Interface translations (Dutch, German, Arabic): a whole-app translation layer is its own project; text direction of content already works.
- New workflow states (open / closed / applied): states stay reading states; notes and reminders carry deadlines.
- Hosted publishing of collections: stays off on hosted installs by earlier decision (plan/19).
- Playing YouTube inside the app: the app frames nothing (`frame-src 'none'`); embedding would bring YouTube's tracking into PURSS.
- Sites without feeds (councils, funders, venues, Instagram, TikTok, Facebook): no feed to follow; messages already say so.
- GitHub release feeds dated by update time: the feed's own data.

## Workstreams and file ownership

Migrations: 035 capture quality and pictures, 036 Home lists, 037 OPML imports, 038 reminders, 039 private feed keys, 040 search index target.
`packages/domain/src/api.ts` is shared: additive changes only, each workstream in its own block.

- WS1 capture and kept copies (API, worker, connectors capture code): A01–A04, A08 images.
- WS2 lists and Home data (API item queries, Home web page, reading progress, filters, muted words): B01–B08.
- WS3 sources (connectors discovery, Add source dialog, OPML): C01–C07.
- WS4 display and accessibility (item panel, rows, cards, menus, popovers, player, CSS, search results): A02/A06/A07 display, D, E.
- WS5 account, reminders, offline, copy link, emails, docs: A05, F, reminders.
- WS6 website: G.
