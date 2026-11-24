# Storage and retention

What PURSS keeps, what it counts against an account, what happens when room runs out, and what leaves the
installation when someone exports. The view for people using PURSS is in the [user guide](user-guide.md#your-data); how
the parts work together is in the [architecture](architecture.md).

## What is kept, and what removes it

PURSS never deletes an item by itself. There is no age limit, no cleanup job and no eviction when storage is
full. An item is removed only by one of these:

| Action | What goes | What stays |
| --- | --- | --- |
| **Delete permanently** on chosen items | The items with their versions, readable copies, kept pictures, highlights and notes, state and playback position, basket pins | A tombstone per engine entry, so the entry is not added again |
| **Unfollow** with *Also delete the items you haven't kept* | The source's items that no basket holds, that carry no highlight or note and no public note on a shared page | Everything else; the source's kept items stay |
| **Unfollow** alone | Nothing; the source's unkept items leave lists and search, except those with highlights or notes | Everything |
| Deleting a **news post** (an administrator) | Its items that nobody kept, shared or annotated | The rest |
| **Deleting an account** | Everything, after a 7-day grace period (see [architecture](architecture.md)) | Nothing but the audit log's account id |

Two records belong to the installation and to no account: `discovery_misses` (the site, by registrable domain, and why a lookup
failed) and `discovery_routes` (which route link lookup offered and which was followed, as two ids from fixed lists, with counts). Each is kept per
UTC day for 180 days, holds no account, source, address or title, and is no part of anyone's export or of deleting an account.
A followed source also keeps, on its own row, which route found it, how the person got to the lookup and when it was unfollowed; that is the account's
own data and goes with the account, but it is not the person's own content and no export, archive or OPML file carries it.

Finishing, ignoring or leaving an item undecided deletes nothing. Taking an item out of a basket, or deleting a
basket, removes the pins and leaves the items. Permanent delete asks for a preview first: it lists the kept items
with their baskets, the items that carry the person's notes, and the bytes it releases, and its confirmation
lasts 10 minutes. There is no undo or trash. It is never refused because the storage allowance is full.

FreshRSS is a bounded buffer, not the library: it keeps each feed's newest 50 entries and drops the rest once
they are older than 90 days or beyond 1,000, whether read, starred or labelled. Items already imported into
PURSS are unaffected by what FreshRSS drops, and an entry that left FreshRSS before the next sync walk is not
recoverable ([sync](architecture.md#sync)).

## Keeping an item in a basket

A basket is the only thing that pins content. Keeping inserts a membership that names the item's current
version, together with a small record in the storage ledger, in one transaction.

- **Keeping an item PURSS has** adds no content, only the pin and its record. If the record cannot be stored,
  even within the small headroom given to controls (see [at the limit](#at-the-limit)), nothing is kept and the
  person is told.
- **Keeping a page PURSS has no item for** (a kept link) stores a new item and its first version as ordinary
  growth, so it fails whole when there is no room. A page PURSS already has, matched by address, is kept as
  that item instead of a second one ([architecture](architecture.md#flows)).
- **The pinned version is immutable.** When the publisher edits the post, the edit becomes a new version and
  the item shows the kept version, with the current one offered next to it. A version that no basket pins and that
  is not current is released, so removing the last keep of an item whose post has changed since drops the kept
  version; the current one stays.
- **A readable copy is a second step.** A basket that keeps *Readable copy too* also reserves room and queues a
  fetch of the page. If the reservation does not fit, the keep still stands and says that no readable copy was made.
  Readable copies are not made for private sources, or for a video, podcast episode or post that comes whole in its feed
  (a page kept by hand always gets one).
- **Removing the last keep releases the pin, not the readable copies.** The item's readable copies and kept pictures stay
  with the item and are counted with the feed's items.

### What a kept item holds

The reader labels each item with the most it has:

| Level | Label | Meaning |
| --- | --- | --- |
| Saved details | Saved details (title, link and summary) | The feed gave no text; the title, link, source, dates and any summary are kept |
| Feed text | Saved the feed's text | The text the feed itself carried is kept with the version |
| Full text | Full text saved | A readable copy of the page, fetched by the server, that passed the checks |
| Partial | Only part of the page was saved | A fetched readable copy that is a sign-in, consent or security-check page (`gated`), mostly references (`references`) or under 60% of the feed's own text (`short`); it is kept and counted but not called the article, and the reason is shown |
| Browser | Kept from your browser | The readable text the person's browser sent; the server fetched nothing and cannot confirm it matches the original |
| Pending | Saving readable text… | A fetch is queued or running |
| Failed | Couldn't save the text | The try failed, with the reason; **Try again** queues another |

A readable copy replaces an earlier one only when it is better: full beats partial, and among partial readable copies a fragment
beats a bibliography beats a wall. A try that is no better is dropped and recorded as such. A readable copy
reflects the page when it was fetched; some sites need a login, turn automated readers away or work only with
JavaScript, and then the item keeps what the feed gave.

### Pictures that are stored

A basket that keeps readable text also keeps the item's own picture and the pictures in its text: up to 20
pictures and 10 MB per item, fetched under the same address rules as every other fetch, with the type read from
the bytes and no SVG. They belong to the item, so an item in two baskets has one set. A picture that does not fit
is left out; the reader keeps showing its original address.

Instagram's picture servers refuse other sites, so an Instagram post shows its pictures only from the pictures kept,
made small (WebP, at most 720 px wide). A basket that keeps readable text stores every picture of a carousel
while Instagram's addresses for them are valid, a few days, and afterwards the first picture (a video's still);
a post nobody kept loads nothing from Instagram.

A source's icon is also stored (one small WebP per source, re-found weekly); it can be rebuilt, so it is neither
counted nor exported.

### What is not stored

- **Audio and video files.** The server holds none and has no job that downloads one. An episode plays from the
  publisher's own `https` address, and the phone and desktop apps can download it to the device itself. If the
  publisher removes the file, nothing remains on the server.
- **Anything a basket did not capture.** A keep is not a promise that the page, video or audio stays at its
  address, or that a readable copy exists. The reader says what was saved (levels above), and the export says
  the same.

## What is counted

Usage is the sum of the measured sizes of an account's live stored objects, held as a total that changes in the
same transaction as the object.

| Object | Measured as | Created | Released |
| --- | --- | --- | --- |
| Item version | UTF-8 bytes of the canonical JSON of title, link, author, summary, content, picture address, enclosures and date | An item arrives or is kept, or a feed edit adds a version | The item is deleted; a version is released when a feed edit supersedes it and no basket pins it, or when its last pin goes |
| Readable copy | The same for its title, text, HTML and final address (fetched by the server or captured in the browser) | A readable copy completes or a browser capture is saved | The item is deleted; a better readable copy or a new browser capture replaces it |
| Kept picture | The picture's byte length | It is stored | The item is deleted |
| Small record | The size of the record: an item's state (64 bytes, with its workflow history), a basket pin, a highlight or note, a playback position (64 bytes) | The state first changes, an item is kept, an annotation is written, a position is saved | The item, basket pin or annotation is removed |

Each object is counted once. An item in three baskets has one version and one set of readable copies and pictures; each
extra basket adds one pin record of about 120 bytes. Taking an item out of a basket releases its pin record and
leaves the other objects as they are.

Not counted: the search indexes, source icons, the definitions of sources, collections and baskets,
preferences, reminders, notifications, shared-page settings and public notes, sessions, jobs, logs, Discovery's
data, the engine's data, and backups. A media file is not counted because the server holds none.

The sidebar meter shows followed sources against the plan limit, and its panel adds, where a storage allowance is set, the bytes used against it.

### Logical bytes and disk

Account usage is logical: the measured size of the fields above. It is not the account's share of the disk. The
database file also holds indexes, the search tables, the write-ahead log, free pages and the unmetered rows, and
the machine holds the engine's data and backups. PURSS never compacts the database file, so deleting frees room inside
it for new data rather than making the file smaller.

The server's physical state is the administrator's: *Service health* shows the free and total space of the data
volume, the reserve, and the sizes of the database and its log. `node apps/api/src/cli.ts reconcile-usage`
compares each account's ledger with its objects and corrects the total if it drifted
([self-hosting](self-hosting.md#administrator-cli)).

### Storage allowance and plan limits

- **Storage allowance** is a number of bytes an administrator sets for an account. Self-hosted installations have none
  unless the administrator sets one with the CLI. Hosted installations take `PURSS_DEFAULT_ALLOWANCE_BYTES` (empty
  means none), an invitation's allowance or a per-account value. It is an administrator's safeguard against
  runaway use; plans are not priced in bytes.
- **Plan limits** (hosted only) cap followed sources and collections, not bytes: Free 100 sources and 5 collections,
  Plus 1,000 sources and no collection limit, Pro 5,000 and no limit, Unlimited for exempted accounts and
  administrators. Kept links are not sources. The limits are checked in the transaction that adds a source or a
  collection, on every path (following, OPML, import, assistants). An account over its plan, after moving to a
  smaller one, keeps everything: following and creating wait until it is back under, and reading and export are
  unaffected. See [self-hosting](self-hosting.md#plans-in-hosted-mode).

## At the limit

Growth is admitted inside the transaction that writes it, against the allowance plus live reservations. The API
is the only writer, so two requests cannot spend the same free bytes.

- **Reservations.** A keep with a readable copy reserves 1,500,000 bytes before the fetch. The reservation settles to the
  real size when the copy completes; a failure or an expired reservation (one hour) releases it. Optional readable copies
  reserve nothing: a *Full articles* readable copy and kept pictures are admitted when they finish if they fit and
  dropped otherwise, without marking growth paused.
- **Disk reserve.** A write that is not a control is refused when it would leave the data volume with less than
  `PURSS_DISK_RESERVE_BYTES` free (1 GiB by default), whatever the account's allowance.
- **Control headroom.** State changes, a pin on an item PURSS already has, notes and playback positions may exceed
  a full allowance by at most 2 MiB, and are counted. They never admit content, and the disk reserve does not
  stop them.

When room runs out, growth pauses and nothing is evicted:

| Stops | Keeps working |
| --- | --- |
| New items from sync: the batch rolls back whole, its checkpoint does not move, and the next pass tries again | Reading, search, workflow changes, undo |
| Readable copies and kept pictures | Keeping an item PURSS already has (within the headroom) |
| Saving a page PURSS has no item for | Highlights, notes, playback positions |
| An upstream edit to an item (it waits for room) | Deleting anything, which is never refused |
| An import, whose preview says it does not fit and leaves the staged file for a retry | Export, which does not touch the ledger |

The pause shows on the sidebar meter (its label says new items are paused, its panel says why, in plain words for
a full allowance or a low disk) and as the answer to an action that needed room. It lifts by itself: the
maintenance tick checks whether growth fits again, and deleting items or raising the allowance checks at once. Lowering a storage allowance below what an account holds keeps the data and pauses growth.

While growth is paused, FreshRSS keeps fetching into its own buffer under its retention, so entries that age
out of it before room returns are never imported. Resuming does not recover them.

## Deleting

Deleting an item releases all its objects in the ledger at once, and the pause lifts when the freed room admits
growth again. Removing a pin releases one small record, so it often frees almost nothing.

## Export and import

*Settings → General → Your data → Export everything* streams one JSON file in the `purss-export` format (`GET /api/export`). It reads a
consistent snapshot, never touches the ledger and works while the account is over its storage allowance; one runs at a time per
account and six an hour. A manifest at the end holds the count and SHA-256 of each section, and the file lists in
plain words what it leaves out.

**In the file:** sources (followed and unfollowed), collections and their filters, baskets, memberships with the
version each keeps and when, every item (kept or not) with all its stored versions (each saying whether the feed's text was
too large to store, so that it holds the summary only), its readable copies
(server-fetched and browser, finished and failed) and its workflow, progress and New state, preferences (muted
words included), the log of workflow changes, the person's live highlights and notes, kept pictures, reminders,
and sharing settings with public notes.

**Never in the file:** passwords, passkeys, sessions and access tokens; service secrets, FreshRSS's data and
identifiers; how a source was found and when it was unfollowed; private source links and any link, picture or media address of an item from a private source;
addresses that carry a password or access key; readable copies still in progress, undo history, pending confirmations,
notifications, Discovery's previews and dismissals; Smart filters, playback positions and source icons; and anything never
captured (pages, pictures, audio and video that stayed at the publisher).

A private source is exported as a reference without its link and comes back as *needs reconnecting*: the person
pastes the link again, and until then it fetches nothing. Export is never tied to a plan.

*Kept links as a list* (`GET /api/export/kept-links`, HTML or Markdown) is a readable list of each basket with
title, origin, publication and keep dates, for reading and printing; it is not an import format. The OPML export
lists the public feeds followed and leaves private sources out.

**Import** checks the file against its manifest, refuses a newer schema version, and shows what it would add
and whether it fits the allowance and the plan, before changing anything. One staged file waits per account for 24
hours. Applying is one transaction that lands completely or not at all, and over a limit nothing is written and
the staged file stays for a retry. Sources already here are recognised by their address as when following one
(a private source by the id it has here when the file came from this account, even after a rename, else by its name, as the
file holds no link: two private sources that share a name stay two, and one already here stands for at most one of them),
and an unfollowed one the file follows is taken up again. Import deletes nothing: items already here are not added twice, sharing
arrives switched off, private sources arrive as *needs reconnecting*, and preferences are applied only when the
account has none. Moving to a fresh installation recreates the followed public sources, and the entries its engine
then delivers are matched by link to the imported items instead of being added a second time.

## Backups

Indefinite means no automatic expiry; it still depends on the administrator's disk and backups. A backup of
`product.db` holds everything counted here, and private source links only when the secrets folder is included
([self-hosting](self-hosting.md#backups-and-restore)).
