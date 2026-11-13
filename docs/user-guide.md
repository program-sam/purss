# User guide

PURSS collects what your sources publish, lets you organise it, and keeps what you
choose. This guide covers what the app does today. Anything marked *not built* does not exist
yet.

## First-time setup

1. Open the PURSS address your operator gave you (on your own machine this is usually
   `http://localhost:8940`).
2. Enter the **setup code**. The operator reads it from the server (see
   [self-hosting](self-hosting.md#the-first-administrator)). Whoever enters it first becomes the
   owner and administrator, and the code stops working.
3. Enter your **email address** and choose a **password** (typed twice); a name is optional. You
   sign in with the address and password on any computer, including borrowed ones.
4. Add **fingerprint, face or screen lock** if you like. Use Touch ID, Face ID, Windows Hello,
   your phone's screen lock or a password manager. You can skip this and add it later in
   *Settings → Security*.

Fingerprint, face or screen lock works over **HTTPS**, or at `http://localhost`. It doesn't work
over plain HTTP at another address, such as a LAN IP. It is tied to the exact host name you use,
so one added at `localhost` won't work at `127.0.0.1`.

**Joining an existing installation:** an administrator invites you by your email address, on a home
server as well as a hosted one. Where the server sends email the invitation arrives as a link
(`/app/invite?code=…`); otherwise the administrator gives you the link or code. Type the address you
were invited with, choose a password and, if you like, a name; the rest is the same as above.

A hosted installation may also offer *create an account* on the sign-in page when its operator has
turned open sign-up on. It starts with your email address: a link arrives there, and opening it lets
you choose your password and finish (no card needed). No account exists until you open the link. If
the address already has an account, the message says so and links to signing in and resetting the
password instead. The button stays busy while the account is made; if the page was closed before it
finished, sign in with your address and password.

## Signing in

- **Email address and password:** works on any computer, including borrowed ones. Each address
  belongs to one account; capital letters don't matter.
- **Fingerprint, face or screen lock:** sign in with Touch ID, Face ID, Windows Hello, your
  phone's screen lock or a password manager, once you have added it in *Settings → Security*.
- **External sign-in** (OpenID Connect) appears only when the operator has configured a
  provider, and only for an identity you linked while signed in (*Settings → Security*).

Your browser stays signed in while you use it, and signs out after 30 days without a visit. On
the sign-in page, choose **This is a shared computer** on a library, work or borrowed computer:
that browser session ends when the browser closes and after eight hours at the latest, and the
header shows **Sign out** so leaving takes one press. *Settings
→ Security* lists the browser, system and approximate last use for each signed-in device, marks
this device, and lets you sign out one device or **Sign out everywhere else**.

*Settings → Security* is also where you change your email address or password, add or remove
fingerprint, face or screen lock, and link or remove an external sign-in. The password can be
changed but not removed; changing it asks for your current password. The other changes need a
recent sign-in: the screen asks you to confirm it's you with your password or with fingerprint, face
or screen lock, then carries on.

**Forgotten your password?** On the sign-in page, **Can't sign in?** leads to a password reset by
email where the installation sends email (always on the hosted service). Otherwise it says to ask
the server's administrator for a password reset link; the administrator's side is described in
[forgotten passwords](self-hosting.md#forgotten-passwords).

**Your email address** is the one you sign in with. Change it in *Settings → Security* (that asks you
to confirm it's you). Where the installation sends email (always on the hosted service), the new
address gets a confirmation link and takes over only once you open it; until then you keep signing in
with the old one, which is told about the change afterwards. On a server without email the change
applies at once. Another account's address can't be taken. If you forget your password, the reset by
email sends a link to your confirmed address; it works once, for an hour. Choosing a new password
signs you out everywhere, disconnects your connected apps and assistants, and the address is told.
The address is otherwise used for messages about your account and, if you choose that in
*Settings → Notifications and New*, for [reminders](#reminders). Every link in a message is on a line
of its own, so nothing gets stuck to its end. Administrator accounts get a password reset link from
the operator at the server instead.

## Adding sources

Choose **Add source** (sidebar, Home, the search palette, or the bar along the bottom on a
phone, which also has Home, Collections (your collections and baskets), and Search), paste a link and press
**Find**. PURSS looks for feeds there, then shows the sources it found: the title, kind,
how often it publishes ("about 2 posts a week"), a few recent items, and whether the feed only
gives summaries. Pick one and **Follow**. When a page lists several feeds, the one that is the page's own
is chosen for you; if none of them clearly is, none is chosen until you pick. A feed with no posts yet
can still be followed ("No posts yet" shows on its page until the first one arrives). If you already
follow a source with the same name under another address, the result says so before you follow a second. The collection starts as *No collection*: you never
have to name one to follow something (choose an existing collection, or *New collection…*, if
you want to group it). *Fetch the full article for new items* starts unticked, because it uses
storage for every new post (see [Full articles](#full-articles)); tick it for a feed whose posts you
want to read in full. A source in no collection is listed in the sidebar and shows in the *Other sources* box on Home.

The first items appear once the collection engine has fetched the feed. By default it checks
feeds about every 15 minutes, and PURSS picks up new items every two minutes, so new
posts take a while to show.

What you can paste:

| Link | What happens |
| --- | --- |
| A website or blog page | The page's advertised feeds are offered, or the usual feed addresses on the same site are tried (`/feed`, `/rss`, `/atom.xml`, `/rss.php`, `/comic/rss`, `/xml/rss2_0.xml` and a few more). If the front page itself fails or refuses (an error 500 or 403) those addresses are still tried, and the result says the front page didn't open. A usual address that the site sends to a person's page or feed (a site that reads `/atom.xml` as the user "atom") is not taken for the site's feed |
| A feed address (RSS, Atom, JSON Feed, or `feed:`/`podcast:` links) | Followed directly |
| A podcast feed | Followed as a podcast; episodes play in PURSS ([Listening and watching](#listening-and-watching)) |
| A YouTube channel (`youtube.com/@name`, `/channel/UC…`, `/user/…`) | The channel's video feed |
| A YouTube video | Keeping the video (with its real title, channel and picture) and following its channel are choices in one list, starting on keeping the video. If the link names a playlist, that playlist is offered too |
| A podcast's name instead of a link | **Search podcasts** looks the name up in Apple's podcast directory (what you typed is sent there, and the screen says so). Choose a show to see its latest episodes, then follow its own feed |
| A series page of the Guardian whose series is a podcast | The podcast feed is offered first and chosen; the articles feed comes second |
| A subreddit or a Reddit user (`reddit.com/r/name`, `/user/name`) | Followed through Reddit's own feed, named *r/name* or *u/name*. When Reddit is limiting requests the feed is still offered and PURSS keeps trying |
| A GitHub repository (`github.com/owner/repo`) | Its *Releases* and *Tags* feeds are offered |
| A GitHub user or organisation (`github.com/name`) | Its public activity feed |
| A game's page in the Steam store (`store.steampowered.com/app/…`) | The game's news feed, named after the game as the address spells it |
| An arXiv listing (`arxiv.org/list/cs.LG/…`) | The category's daily feed. It is empty at weekends and says so |
| A Dailymotion channel (`dailymotion.com/name`), an Odysee channel (`odysee.com/@name:id`, the form Odysee's own links take), a DeviantArt profile or gallery (`deviantart.com/name`) or a Behance profile (`behance.net/name`) | That account's own feed. Pages of those sites that aren't an account (search, settings, a single project or video) are looked at like any other page |
| A PeerTube account or channel (`/a/name`, `/c/name`, on any PeerTube server) | The server's feed for that account or channel, offered only when the server answers with a PeerTube feed |
| An Apple Podcasts show link | The show's own feed, looked up from Apple's public podcast directory |
| A Substack, a Medium writer or publication, a Tumblr or Blogger blog, a WordPress.com site, a Vimeo channel or a Pinterest board | The service's known feed address |
| A YouTube playlist | The playlist's feed |
| Someone's shared page (`…/p/…`) | Its Atom feed, like any other feed |
| A follow link (`…/follow?url=…`) from a Follow button on a site or a shared page | The feed it carries |
| A Mastodon or other fediverse account: `@name@server`, or its profile page (`https://server/@name`) | The account's public feed, which its profile page advertises |
| A Bluesky account: `@name.bsky.social`, a custom-domain handle such as `@example.com`, `name.bsky.social`, or a `bsky.app/profile/…` link | The account's public feed on bsky.app; a post link offers its author to confirm |
| A private feed link (one containing a token or key) | Followed and marked private (below) |
| A public Telegram channel (`t.me/name`, `t.me/s/name`, or one of its posts), a Bandcamp artist or label (`name.bandcamp.com`), a SoundCloud account (`soundcloud.com/name`), a Twitch channel's videos (`twitch.tv/name`), a Mixcloud account's own shows (`mixcloud.com/name`), a Rutube channel (`rutube.ru/channel/123…`) or an Apple Music artist's releases (`music.apple.com/…/artist/…/123…`) | Collected by the server's bridge from the public page, as the latest posts at each check. The preview says so. A bridge source can stop working when the service changes its site, and an export lists it by its page address. A server without the bridge says the service has no feeds |

What doesn't work:

- Pages with no feed. You can still **keep the single link** in a basket instead of following it.
  You choose the basket (none is chosen for you; with no basket yet, the name box for a new one is
  open), and *Keep readable text too* also saves the page's text whatever the basket does by
  itself. The title, picture and site are read from the page when it allows, and you can rename the
  link afterwards (*More → Rename…* in the item). On a page that is part of a bigger site, the
  page's own feed comes first; a feed for the whole site is offered only when nothing narrower
  exists, and is labelled *Whole site feed*.
- Services that publish no feeds: Instagram, TikTok, Facebook, X (Twitter), Threads, WhatsApp,
  Discord, Signal, Snapchat, Spotify and LinkedIn, and the pages of Telegram, Twitch and
  Bandcamp that aren't a channel or artist (an invite link, say). You're told so at once, and
  pointed at a YouTube channel, blog or newsletter the same person may have. You can still keep
  the link.
- An email address (a newsletter that only arrives by email can't be followed yet; many have a
  web page with a feed) and the name of anything but a podcast.
- A site that is slow or busy. If looking takes too long you're told that and can try again; it
  is never reported as "nothing to follow". An address that doesn't exist says so. YouTube is
  asked a second time before giving up, and a handle YouTube has no page for is not called a
  channel that doesn't exist (handles get renamed): paste a link to one of its videos instead.
- YouTube search results, home page, subscriptions, history, mixes, liked videos and watch
  later. YouTube sometimes refuses its feed for a while; you're told when that happens.
- A bare `@name`: paste the full address or the whole handle (`@name@server`, `@name.bsky.social`).
- Bluesky custom feeds, lists and hashtags, Mastodon hashtags, and fediverse accounts whose server
  publishes no feed (GoToSocial only does when the account's owner turns it on). A Bluesky account
  that asks not to be shown to signed-out people can't be followed.
- Services without a feed that would need an account connection. No service connectors are
  built.
- Addresses with a username and password in them, and anything on a private or internal
  network: these are refused for safety.

A feed shows only what its publisher includes, usually recent items. A YouTube channel feed
lists only the latest videos, never the full history. Following doesn't fetch old archives.
A social account's feed has its public posts only: Mastodon gives the latest 20, without boosts
or replies; Bluesky the most recent ones, without reposts or replies. Posts have no titles, so
the start of the text stands in. A post its author later deletes or edits stays in your
PURSS as it was collected.

**Private links.** If a feed address looks like it contains a secret, or you tick the option
to mark it private, PURSS treats it as private: the address is stored apart from your
data and never shown again; it's left out of exports and OPML; item titles never appear in
notifications; readable copies aren't made; and its items can't be shared publicly. Pasting or
listing the same private link again is recognised as already followed: PURSS keeps only a keyed
fingerprint of the link (made with a key in the server's secrets folder), never the link itself. A
podcast host's public show addresses (Acast, Omny, Megaphone, Simplecast and the like), addresses with a
topic in the query (`?key=tech-news`) and ordinary slugs are not taken for private links.

**Importing a list.** *Your data → OPML* takes a subscription list from another reader. You
pick which feeds to follow, and each one goes through the same look-up as pasting a link, keeping
the name the file gave it. The list is followed on the server, one feed after the other: you can
close the window, leave the page or sign out, and the progress and the result of every feed are on
the Your data page when you come back. **Stop after this one** ends it early. One list runs at a
time per account, and the record of a finished list can be forgotten. Each feed is looked up like a
link pasted in Add source and counts against the same allowance (a list uses up to 100 of the 120
look-ups per ten minutes, leaving the rest for you), so a very long list takes a while; when the
allowance is used up it waits instead of failing feeds. Lists from different accounts take turns, one
feed each.

## Sources

Open a source from the sidebar to see its items. The sidebar's collections start closed each
time PURSS opens; open one with its arrow to see its sources. Its page header has **Notifications** (mute
or same as Settings), **Full articles** and **Manage**, which pauses, renames, changes
its **collections** or **unfollows** it. Right-click a source,
collection, basket or item in the sidebar or a list for the same actions (Shift + right-click
gives the browser's own menu).

- **Paused:** **Manage → Pause collecting** pauses for a week, for a month or until you resume
  it. A pause for a week or a month ends by itself and the source says when. Nothing new is
  added while it is paused. After you resume, some items published during the pause may still
  arrive, but there's no guarantee that all of them will.
- **Back catalogue:** what a source already had when you followed it is not New and sends no
  notification. Following an old podcast never shows "1,359 new"; only what comes after is New.
- **Unfollow:** collection stops and the source leaves your collections. Kept items stay; the
  rest no longer show in lists or search. Tick *Also delete the items you haven't kept* to
  delete those permanently and free their storage (kept and shared items are never deleted).
  You can follow the source again later.
- **Rename:** give a source your own name from its page or right-click menu; the feed itself
  is unchanged.
- **Icon:** each source shows its own picture where PURSS can find one: a podcast's
  artwork, a YouTube channel's avatar, or the website's icon. It appears within a minute or so
  of following and is checked again weekly. Sources without one, including sites that turn
  automated visitors away, keep the coloured tile with their initials.
- **Full articles:** see below.
- The source's status shows when something needs attention: still collecting the first items,
  quiet (nothing new for 30 days), failing, paused, or needs reconnecting (a private source
  whose link is missing, for example after an import).
- A source that couldn't be collected shows the reason in the words PURSS gives (for example that it is waiting to try again, or has given up) and offers **Try again** on its page, in *Needs attention* on Home, in the activity list and in its right-click menu.
- **PURSS news:** once the installation's administrators publish their first post,
  every PURSS gets this source, with the newest three posts; later posts arrive as New
  (paused or full accounts get them once they can take them again). It shows the app's own icon
  and works like any source:
  pause, rename, mute or unfollow it. Unfollowed, it stays unfollowed; to follow it again, add
  the news page (`/news` on your PURSS's address) as a source. Its posts are also public at
  `/news` and in the Atom feed `/news/feed.atom`, for any feed reader. When an administrator
  edits a post your copy changes too, unless you kept it; when they delete one, your copy goes
  unless you kept it, published it or wrote notes on it. Administrators see, per post, how many
  PURSSes opened, kept or ignored it, never whose.

## Full articles

Many feeds carry only a summary. Turn on **Full articles** on a source's page (or *Fetch full
articles* in its right-click menu) and PURSS fetches each new post's page and saves a
readable copy of the article. The reader then shows that copy instead of the summary, search
covers it, and it is there for [offline reading](#install-and-offline-reading).

- It applies to new items, and to up to 20 of the source's newest items you haven't finished or
  ignored when you turn it on. Copies are fetched a few seconds apart, so a burst of new posts
  takes a little while.
- It is the same readable copy a *Keep readable text too* basket makes: text and links, no
  scripts. The copy reflects the page when it was fetched. Some sites need a login, block
  automated readers or only work with JavaScript; then the item keeps its feed summary and its
  panel says the copy failed.
- When the server is short of space, new items still arrive, without a copy. Deleting or cleaning up an item deletes its copy.
- Turning it off stops new copies; copies already saved stay, and ones already waiting still
  finish.
- Not available for private sources, YouTube channels, podcasts or links you kept by hand.
- When a feed gave only a summary and no readable copy has been made, the item panel says
  **Summary only — the full article stays on the original site**, and the reading time (which
  would only describe the summary) is left out. When a copy is made, the reading time is
  worked out again from it. If a copy failed, the panel lists it with **Try again**.
- When a feed's own text was too large to store, the item keeps its details and summary, and the panel says **The feed's full text was too large to store; open the original.**

## Listening and watching

An item whose feed offers an audio or video file (most podcast episodes, some video feeds) shows a
**Listen** or **Watch** button in its panel. It plays in the player at the bottom of the screen, which
keeps playing while you move around: tap its title to go back to the item, skip back 15 or forward 30
seconds, change the speed (0.8× to 2×, remembered on this device), set a sleep timer that pauses in 5 to
60 minutes, make it smaller (one row with play and pause; this device remembers it), or close it. Your phone's or computer's own media controls and headset buttons work too: one
press plays or pauses, a double press (or a car's or headset's next button) skips forward 30 seconds,
and the previous button skips back 15.

- **Where it plays from:** the publisher's site (or, in the phone apps, the download on your phone when
  you have one). The player says which. PURSS never stores audio or video files: it only plays the
  publisher's own file, so if the publisher removes it, it is gone. Streaming from the publisher works like
  loading their images: they see your address.
- **Videos on YouTube, Vimeo, Dailymotion, Odysee and Twitch** aren't files: pressing the picture in
  the panel plays the video right there, in that site's own player. Nothing loads from the site until you
  press play; then it counts the view and shows its ads as on its own site. The video stops when you close
  the panel, and your place in it isn't kept. Some videos can't be played outside their site (the player
  says so); *Open on YouTube* (or the other site) beside it always opens the video's own page. Twitch plays
  here only when PURSS is on an https address (or `localhost`). In the desktop app on a Mac or Linux and
  in the iPhone app, only Odysee plays here: the other sites refuse to play inside those apps, so their
  videos open on the site. Other sites, PeerTube included, open in a new tab.
- **Picking up where you stopped:** the position is kept on the server, so another device offers
  *Listen from 12:34*. A position reached without a connection is kept on the device and sent once
  it is back; whichever position was reached last wins. Near the end counts as finished, and it starts from the beginning next time.
  It is separate from reading progress and from To read / Finished.
- **Downloading a file** is only for the phone apps: *Download to this device* in the reader, or the
  download button on a row or card, keeps the file on your phone (see *Downloaded* below). A browser has
  no download button, because PURSS has no copy to give you.
- Not available for private sources: their file links can contain your membership key.

## Collections and baskets

**Collections** decide what you *see* together. **Baskets** decide what you *keep*. They are
independent: putting a source in a collection keeps nothing, and keeping an item doesn't add
it to a collection.

A collection is one of two kinds:

- **Sources:** everything the chosen sources publish. A source can be in several collections.
- **Filter:** items that match conditions you choose (text, sources, kind, state, kept or not,
  date ranges).

Deleting a collection removes only the grouping. Sources and items stay.

A **basket** is how you gather individual items by hand, from any source, and it keeps a copy
of each item as it is when you keep it (⋯ → *Keep in…*, right-click, or the item panel). That copy stays even if the feed later
drops the item or the original changes; when the original has changed you can see both. An item can be in several baskets and is stored
once. Each basket has a capture mode:

- **Keep link and summary** (the default): keeps the item's details and whatever content its
  feed supplied, with no extra copy of the page.
- **Keep readable text too:** also queues a readable copy of the page in the background (unless the
  item already has one). The copy reflects the page when it is fetched, if it can be fetched.
  Not done for private sources, or when the server is short of space. The basket also keeps the item's picture
  and the pictures inside the readable text (up to 20 pictures and 10 MB for one item), so a
  webcomic or a visual reference stays whole. They are kept once, however many baskets keep the
  item, and are in your export. Items that only come from a feed, and baskets that keep the link
  and summary, keep no pictures.

Keeping a link PURSS already has (from a source you follow, or kept before) keeps that
item rather than adding it twice. Addresses count as the same page when they differ only in
`http`/`https`, letter case of the site name, a trailing slash, the part after `#`, or tracking
parameters such as `utm_source`.

Changing a basket's mode applies to items you keep from then on. A basket is your own record,
not a guarantee: the original page, video or audio can still change or disappear. Videos and
audio are never downloaded.

## Views and Home

Every collection, source and basket can be shown as:

- **List:** compact rows.
- **Cards:** larger tiles with images.
- **Board:** columns for Undecided, To read, In progress and Finished; drag a card to change its state.
- **Table:** sortable columns.
- **Timeline:** grouped by day.

Each collection remembers its view. **Customise Home** picks one of four Home layouts (one box
per collection, one feed, only new items, or a front page with headlines and baskets) and which
collections appear there, and in what order. Sources that are in no collection appear together in
an **Other sources** box, which is listed there like a collection (shown by default).

**Home when you come back.** Whatever the layout, Home starts with a summary line ("Since your
last visit (3 days ago): 412 new in 6 collections") and, when there is something to say, these
rows. To read, To listen, Recently kept and Needs attention start closed; one you open stays open
in that browser.

- **Coming up:** the reminders you set on kept items for today and the next six days
  ([Reminders](#reminders)). Not there when you have none.
- **To read:** the oldest items you marked To read, with *Show all*.
- **Recently kept:** what you kept in the last month.
- **Needs attention:** sources that are failing, paused or being limited by their site.
- **Mark all as seen:** marks every New item as seen (Undo brings the markers back). Nothing is
  finished, ignored or deleted. Shown when you come back after more than 30 days, or when
  50 or more items are New.

Recently kept and filter collections leave out items from collections you hide from
Home, and an item is listed in one Home section
only, the first that has it. A new filter collection starts off Home. Items that match your
[muted words](#muted-words) are left out of Home too.

A visit starts when you come back after half an hour away. **To read** in the sidebar lists every
item you marked To read, across collections; its page is titled **To read, watch and listen**,
because a video's To read is *To watch* and a podcast's is *To listen*. Home's boxes and its one feed show
what you haven't dealt with: New items first, then To read, newest first within each. Finished,
ignored and in-progress items leave Home.
With *Show counts* off the numbers are left out of the summary. When nothing is marked New, the
summary says "Nothing new since your last visit" while older items you haven't looked at are still
on Home; "You're up to date" is for a Home with nothing waiting.

**Background activity.** The line at the foot of the sidebar says what PURSS is doing
("Checking 12 sources…", "Saving text for 2 items…", "Up to date · checked 4 min ago"). Press it
for what arrived and when each source was last checked, with the time the next check is expected
(an estimate: sources are checked every few minutes, not the moment something is published).

## Narrowing a list

The **Show** button above a list (the filter menu) narrows it by state (*All*, *New*,
*Undecided*, *To read*, *In progress*, *Finished* or *Ignored*) and, below that, by:

- **Type:** *Articles*, *Videos*, *Podcasts*; tick one or several.
- **Length:** *Short (up to 5 min)* or *Long (over 5 min)*, in minutes of reading or playing. An
  item whose length isn't known is in neither.

*All* leaves ignored items out; tick **Show ignored items** in the menu (or **Show ignored** under
the list) to see them too.

A collection opens on *New* while it has new items, and on *All* once it has none (in
the Board view it always shows everything, since the columns are the states). Pages for a single
source, baskets and To read open on *All*.

The button says what is on ("Videos, Short"). A collection with several sources has a **Sources**
drop-down below it, set to *All sources*. Untick a busy source to leave it out, press **Only** next
to a source to show just that one, and choose *All sources* to bring every source back. All of this
changes only what the list shows.

### Muted words

*Settings → General → Muted words* leaves out items you don't want to see for a while. Add a word
or a phrase and choose *For a week*, *For a month* or *Until I remove it*. Items with it in the
title or summary are left out of Home and lists, and Home and each list say "N items hidden by
muted words" with a link to show them. They stay in your PURSS, in baskets, and in search. A
muted word that has run out stops working by itself and is dropped from the list.

### Smart filters

For a source that floods your lists, or a collection of sources you want curated, an **AI
filter** keeps only the posts you describe. Open the source's or collection's *Manage* (or
*More*) menu and choose *Smart filter…*:

- Write which posts to **keep** ("are about Rust compiler internals or language design"), and if
  you like which to **drop** ("are job ads or sponsored posts"). Choose what happens when Jev
  isn't sure: keep the post, or drop it.
- **Try on the latest 20 posts** shows what the filter would keep and drop, with how sure Jev is
  about each. Nothing changes yet, so adjust the words and try again until it fits.
- **Turn on**: from then on each new post is judged as it arrives. A post the filter drops is
  marked *Ignored*, so it leaves your lists and New, and you aren't notified about it. Nothing is
  deleted: show ignored items (*Show → Show ignored items*) to see what it dropped.
- A post you open, keep or move yourself is yours: the filter never changes it again. Changing the
  words checks the Undecided posts of the last 30 days again, and gives back posts the filter
  dropped that it would now keep. A collection's filter applies to every source in it; a post a
  filter drops stays Ignored when you turn the filter off or remove it.

Filters use Jev, an AI model by TypeSafe AI that answers yes or no; each post's title, summary,
author and source name are sent to it. On the hosted service the **Pro** plan includes Smart
filters; on a self-hosted server every account can use them once the administrator has set them
up. If they aren't set up yet, or you've used this week's allowance, the filter dialog says so:
ask your administrator.

## Copying a link

An item's **More** menu has two links. **Copy link** copies the original page's address: the one to
send to someone, who can open it without an account here. **Copy link to this item in your
PURSS** copies the address that opens the item in your PURSS; only you can open it (anyone
else gets the sign-in page). You can also share a whole basket or collection as a
[public page](#sharing-a-basket-or-collection).

## Workflow states

Every item is in one state: **Undecided**, **To read**, **In progress**, **Finished** or **Ignored**.
Change it from the item panel, the board, the keyboard, or for many items at once with
**Select** (*Select all* takes every item the list shows, not only the ones loaded so far, up to
5,000). In the item panel the status button says **Set status** while nothing is chosen
(Undecided is what filters, the board and the status menu call it), and the state's name after that. Any state can move to any other. Finished doesn't delete anything; Ignored hides an
item from the usual lists (tick *Show ignored items* to see it) and doesn't unfollow its
source.

Changing an item's state, or keeping it in or taking it out of a basket, clears its New marker.
Otherwise state, baskets and collections never change each other.

A video's "To read" is **To watch** and a podcast's is **To listen**; the stored state is the same.
Reading progress (how far you scrolled) is kept for text only, never for videos or podcasts.

### Changes that wait to be sent

Marking an item (or several selected ones), keeping it in a basket or taking it out, and clearing New markers on chosen items show at once
and are sent in the background, in order. If a change hasn't been confirmed yet, the item carries
a small clock ("Not sent yet") and the item panel says so. A change is kept on this device until
PURSS confirms it, so it survives a closed tab, a lost connection or a reload, and it is
sent again when you next open PURSS or the connection returns. An Undo that could not be checked because the connection was down waits the same way, even across a sign-out: on your next sign-in on this device it first looks at the item, and only puts the old state back if the item is still as you left it. The browser asks before you
leave a page that still has changes waiting.

A change to an item's state is sent with the version of the item you saw. If the item has changed
since (on another device, say), PURSS looks at it: if it already has the state you chose
(for instance because an earlier send arrived but its answer was lost), nothing more happens;
otherwise your change is dropped and you are told: "Not changed: this item was changed on another
device." Keeping and un-keeping can simply be repeated. "Kept on…" in the item panel appears only
after PURSS has confirmed the keep; until then it says the item is being kept.

**Mark all as seen** on Home or on a whole page needs a connection and say so when offline: sent later, they would clear items that arrived in the meantime. Selecting items and choosing **Mark as seen** is kept and sent like any other change.

Waiting changes belong to one PURSS and one account on this browser. When someone else signs
in, yours are set aside untouched and are never sent under their name; they are sent when you
sign in again. **Signing out with changes that haven't been sent asks what to do**: *Send them
first*, *Discard them* (they are deleted from this device), or *Stay signed in*. If sending first
doesn't work (no connection), it asks again.

## Highlights and notes

Your own writing on an item, kept with it in your PURSS:

- **Highlight:** select text in the article (drag with a mouse, or hold and drag the handles on a
  phone or tablet), then press **Highlight** in the small bar under the selection. **Add comment**
  highlights it with a comment. With the keyboard, select text and press `h` to highlight or `c`
  to comment.
- **Change or remove a highlight:** press it in the article (or focus it with Tab and press
  `Enter`) to edit its comment or remove it. Removing shows Undo.
- **Notes:** *Your notes and highlights* in the item panel has **Add a note** for thoughts about
  the whole item, and lists every highlight with its comment and *Show in text*.

Annotating an item doesn't keep it, change its state or add it to a collection, and keeping an item
doesn't annotate it. A highlight remembers the passage it marked, so when the text changes (the feed
edits the article, a readable copy arrives, or you switch to the latest version) it is found again by
its words. If the passage is no longer in the text shown, the highlight stays in the list with its
quote, marked *Not found in the text shown*; it is never dropped. Search finds items by your comments,
notes and highlighted passages. Highlights and notes are private: they never appear on shared pages.

**Offline:** highlights and notes are saved with the offline reading copies, and you can add,
change and remove them without a connection. Each change waits on this device, marked **Waiting to
sync**, survives closing the app, and is sent when the connection is back. If the same note was
changed on two devices, the later change wins. Signing out deletes changes that haven't synced yet,
and *Settings → Security* warns before you do.

Items with your highlights or notes are never removed by *Clean up old items* or by unfollowing a
source with *Also delete the items you haven't kept*, and they stay in your lists and search after you
unfollow their source. **Delete permanently** says which items carry your writing and deletes it with
them only after you confirm.

## New markers

Newly arrived items carry a **New** marker (a dot). **Mark all as seen** on a page, **Mark as
seen** for selected items, or **Mark all as seen** on Home removes the markers without changing
anything else. Opening an item, giving it another state, reading partway, or keeping it in or taking it out of a
basket removes its marker too (Undo brings it back). While an item you opened is open, the list
behind keeps it in its place with its marker, even under *New*; it leaves when you close it. Markers also go by themselves after 30 days (7, 14, 90 days or never: *Settings →
Notifications and New → Keep items marked New for*); only the marker goes, never the item. If you
have been away for a long time, what arrived since your previous visit keeps its marker until
your next visit, so it is still there when you come back. The Undecided state is separate: an
item can be New and To read, or Undecided and no longer New. *Settings → Notifications and New* can
hide the markers and the counts.

The first time you open PURSS, it asks how often to tell you about new things (a weekly
digest on Monday at 08:00 is suggested) and how long items stay New; *Not now* keeps the defaults. Both stay
in Settings.

## Search

Press `/` or `Ctrl K` (`⌘K` on a Mac). Search covers item titles, summaries, authors, feed
content and saved readable text, your highlights, comments and notes, plus the names of sources,
collections and baskets, and the app's actions. Pick a result to jump to it.

Search matches the start of words and ignores capitals and accents. Arabic is read without its
vowel marks, stretched letters, alef and heh variants and the leading *al-* ("the"), so
*كتاب* finds *الكِتَابُ*. An English plural also finds the singular ("sleeves" finds "sleeve"). Words inside
longer compounds are not matched. After an upgrade that changes this, PURSS re-indexes
your items in the background (a few seconds for a few thousand items); until it has finished,
Arabic searches can miss items it hasn't reached yet.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `j` / `k` | Next / previous item |
| `o` or `Enter` | Open the item in the panel |
| `r` | To read |
| `e` | Finished |
| `i` | Ignore, or restore an ignored item |
| `x` | Select the focused item (turns Select on), or unselect it |
| `h` / `c` | With text selected in an article: highlight it / highlight it with a comment |
| `/` or `Ctrl K` / `⌘K` | Search and jump |
| `?` | Show the shortcuts |
| `Ctrl Z` / `⌘Z` | Undo the change in the message that is showing |
| `Esc` | Close a popup, menu or the panel; focus goes back to where you were |

Item shortcuts don't fire while you are typing (`Ctrl K` / `⌘K` still works), and arrow keys are
left to scrolling and screen readers. Right-click opens actions for whatever is under the
pointer; Shift + right-click gives the browser's own menu.

## Undo

Most changes show a message with **Undo**: state changes, keeping and removing from baskets,
clearing New markers, bulk actions, following, and collection settings. Use it while the message is
showing (a message with Undo stays for about 20 seconds; a newer message replaces it). Press
`Ctrl Z` (`⌘Z` on a Mac) to undo without the mouse; it does nothing while you are typing in a
field, where it undoes the text. Screen readers are told that Undo is available, and which key to press only where a keyboard is likely (a mouse or trackpad is the main pointer, not a touch screen). A change that
is still waiting to be sent is undone by taking it back; one that may already have reached PURSS (another tab sent it, or the answer was lost) is undone by sending the opposite change. Removing a highlight or note has Undo too. **Delete permanently** has
no undo; it always asks first, and warns when any of the items are kept in a basket or carry your
highlights or notes.

## Your plan

The meter at the foot of the sidebar shows how many sources you follow of what your plan allows;
select it to see collections too.

- On a hosted installation every account has a plan: **Free** allows 100 sources and 4
  collections, **Plus** 1,000 sources and any number of collections, and **Pro** 5,000 sources,
  any number of collections and [Smart filters](#smart-filters).
  Administrators are not limited. Saved links and sources you no longer follow don't count.
- At the limit, following another source, adding a collection or importing more than fits is
  refused with a message; unfollow a source or remove a collection first. Moving to a smaller
  plan never removes anything: what you have stays, and only new follows and collections wait
  until you are under the limits.
- A self-hosted PURSS has no plans or limits.
- To protect the server, each account also has a limit on the space it takes (set by an
  administrator; a self-hosted install has none unless its operator sets one). If an account
  reaches it, or the server's disk runs low, reading and organising keep working while new items
  and readable copies pause. Nothing you kept is ever removed to make space.

## Statistics

**Statistics** on a source's page, and on a collection's page, lists plain numbers about the
items you hold. They are private to your account: they never appear on shared pages or in their
feeds, and the app doesn't read anything into them.

- **Items per week:** the items in each of the last 26 weeks (consecutive seven-day periods
  counting back from now), as small bars and as an average. An item is placed by the date its
  feed gave it, or by the day it arrived when the feed gave none, so a feed you have just
  followed doesn't show its back catalogue as one burst. Items dated in the future count in the
  total but aren't placed in a week.
- **Items** and **Latest item:** how many items the source has, and the date of the newest.
- **Longest gap:** the most days between two consecutive items dated in the last 12 months.
- **Workflow states:** how many items are in each state, as a count with its share of the
  source's items, such as "31 (24%)". The count always comes first.
- **Filtered out by a Smart filter:** of the Ignored items, those a Smart filter moved there and
  whose workflow you haven't changed since. It appears only when there are some, also after the
  filter is turned off; deleting the filter removes its record, so its posts then count as plain
  Ignored. Moved to Ignored in the last 30 days includes the filter's moves.
- **Opened** and **In baskets:** items you have opened at least once, and items in at least one
  basket.
- **Moved to Finished / Ignored in the last 30 days:** counted from a log of your own workflow
  changes, once per item. The log starts when this feature arrived; earlier changes aren't in it.

A collection page shows one row per source, a total row, and a sort button on every column. Rows
start in name order. For a filter collection the rows are the sources of the items that match the
filter, counted over those items only. The log is deleted with its item, and it is part of your
export and import.

## Discovery

On the hosted service, **Discovery** suggests new sources, picked from what readers like you
follow. Each suggestion says which of your sources led to it. A few random picks are mixed in,
and the list changes daily. **Follow…** opens Add source; **Not interested** hides a suggestion
for good.

To get suggestions, keep **Share my sources** on (Settings → General, or on the Discovery page).
Your sources then count anonymously: a source only counts once 10 people follow it, nobody sees
who follows what, and private sources never count. Turn it off and your sources leave the counts
within minutes, and you stop getting suggestions.

The page says **Coming soon** until enough people share. Self-hosted PURSSes have no Discovery.

## Reminders

**Remind me.** On any item you have kept in a basket, **Remind me** (in the item panel) sets a day
and, if you like, a note ("Book the train", "Closes Friday"). Pick the day in the date field, or
choose *Tomorrow*, *In a week* or *In a month*. It is a calendar day in your time zone, from today
to five years ahead. An item has one reminder: change it or remove it from the same place.

- **Coming up:** Home lists the reminders for today and the next six days, soonest first. Press
  one to open the item.
- **On the day** the bell says so: "A reminder you set is due", or, when *Show item titles in
  notifications* is on and the item isn't from a private source, "Reminder:" and the title with
  your note. Several on one day make one notification.
- **By email:** where the installation sends email and your address is confirmed, *Settings →
  Notifications and New → Email me reminders* (off until you tick it) also sends a message on the
  day, with a link to the item on a line of its own. Titles and notes are left out of it unless
  titles are on in notifications, like every notification.
- A reminder belongs to the keeping: while the item is in no basket, its reminder is hidden and
  not announced, and it comes back when you keep the item again. Each is announced once. One whose
  day was missed by more than three days (the server was off) is dropped quietly, and a reminder
  is deleted 30 days after its day. With notifications set to *Don't tell me*, or *Reminders*
  unticked under *What about*, the bell and email stay quiet and Coming up still lists them.
- Reminders are part of [your data](#your-data): they are in the export and come back with an
  import (days that have gone by are left out).

Reminders are never inferred. Nothing is reminded that you didn't ask about, apart from the
anniversaries below.

**Anniversaries.** Home sometimes shows a quiet note about something you kept on this date in an
earlier year. Hide or snooze each one, or turn them off in *Settings → General → Anniversary
reminders*. The bell says "On this day" for these.

## Notifications

The bell lists what you chose to be told about. *Settings → Notifications and New* chooses:

- **How often:** a **daily digest** at a time you pick, a **weekly digest** on a day and time you
  pick (in your time zone), or *Don't tell me*. A digest is one notification, "Your daily digest:
  54 new in 4 collections", with a line per collection counting what is still New. Items you have
  already dealt with don't count. A digest with nothing in it isn't sent. Where the installation
  sends email and your address is confirmed, the digest also comes **by email** (*Email me the
  digest*, on by default). The email looks like Home: a box per collection with its newest items,
  each a link to open it. It shows titles even when titles in notifications are off (it goes only
  to you), but never those of private sources.
- **What about:** new items from every collection shown on Home, or only from the collections you
  tick; sources that stop working; reminders ("On this day" notes and the days you set with
  [Remind me](#reminders)); saved text that couldn't be saved.
  Collections you hide from Home are left out unless you tick them. A source's own setting wins:
  *Mute* never notifies, *Notify me* tells you as items arrive (at most one notification per source per hour, which grows
  as more arrive), whatever the general setting.
- **Where:** the bell, or also **browser alerts while this page is open** (press *Allow browser
  notifications* once).
- **Show item titles in notifications:** off by default, so notifications leave out item titles. The
  source's name is still shown ("New from …"), and a private source's titles are never shown.
- **Quiet hours:** browser alerts are held back; everything still waits in the bell.

With notifications off the bell shows no number. Notifications are deleted after 90 days (and
only the newest 500 are kept), and a source's notifications go when you unfollow it. Alerts to a
closed browser (push) are *not built*. Email carries the digest (unless you turn it off), your
[reminders](#reminders) when you ask for that, and your account's own messages; notifications of
*Notify me* sources, failing sources and failed text saves stay in the bell.

## Install and offline reading

**Install it as an app.** Open PURSS over HTTPS (or at `http://localhost`) and your
browser can install it: its own window, an icon on your home screen, desktop or dock, and a start
that doesn't depend on finding the tab. In Chrome, Edge and other Chromium browsers, press
*Settings → General → Install app* (or use the install button in the address bar or menu). On an
iPhone or iPad, use Share → Add to Home Screen. Safari on a Mac offers File → Add to Dock. A plain
HTTP address other than `localhost` can't be installed, and a browser that can't install it still
runs PURSS in an ordinary tab. Installing changes nothing about your account or data.

**Read without a connection.** *Settings → General → Offline reading on this device* keeps your
reading list on this device:

- your **To read** and **In progress** items; then what you **kept** in baskets that keep readable
  text (up to 100, the most recently kept first), with the text you kept; then items that are
  **New** and still **Undecided**, newest first; up to 200 items in all, with each item's text as
  PURSS holds it (the feed's content, or the readable text when one was captured);
- Home, your collections and the sources behind those items, as they were when they were saved,
  plus any page or item you opened while online.

Saved items carry no mark: keeping your reading list readable is what the app does. That copy is
the text only, as PURSS holds it; to keep an episode's or video's file, or an article's
full text when PURSS has only its summary, download the item (see *Downloaded*), which
marks it **Downloaded**.

The saved set is rebuilt whenever it is missing or out of date, not only when you switch the
setting: when the app opens, at once if the device has lost copies it should hold (a browser that
cleared its storage, say), within about half a minute of you marking something To read or keeping
something (only the reading list is refreshed then), when new items arrive and when the connection
comes back. Apart from those, it saves no more than every 15 minutes. **Article images are not
saved**, so offline you read the text and images need a connection. Settings shows how many items are saved, when they were last saved, and
how much of **this device's browser storage** the app uses. Saved copies take no space on the
server.

While you are offline, or when what you see came from the saved copies, a notice under the header
says **Offline · showing what this device saved**. You can open lists and items that were saved.
Changes to items (marking one, keeping it in a basket or taking it out, clearing New markers) are
**kept on this device and sent when the connection is back**, in the order you made them; the
notice says how many are waiting. See [Changes that wait to be sent](#changes-that-wait-to-be-sent).
[Highlights and notes](#highlights-and-notes) can be written offline too, in their own queue.
Following a source, renaming, settings and the other changes still need a connection and fail with
a plain message. Search, Sharing, Your data, administration and sign-in settings are never
saved, so they need a connection.

- **It is on by default only in the installed app.** In an ordinary browser tab it is off, so a
  shared computer's browser doesn't quietly keep a copy of what you read. You can change it either
  way. The choice belongs to this device, like Sounds.
- **Turning it off, pressing *Remove offline copies*, or signing out deletes the copies.** The app
  itself, which holds none of your data, stays so it can start. *Remove offline copies* also turns
  the setting off; turn it on again to save afresh.
- **Copies are a convenience, not a keep.** They follow your reading list, a browser may clear
  them to free space, and they aren't a guarantee about the original page. To keep an item,
  put it in a basket.

When a new version of PURSS is available, the installed app shows **A new version is
ready**; press *Reload* to switch to it.

## Apps and extensions

PURSS reaches beyond its browser tab. *Settings → Connected apps* lists all of these
under **Apps and extensions**; Add source, an empty basket and the command palette link there.

- **Browser extension** (Chrome, Edge, Firefox and Safari): keep the page you are reading, add its
  site as a source and search your PURSS from the address bar. See
  [Browser extension and bookmarklets](#browser-extension-and-bookmarklets).
- **Phone and tablet app** (Android and iOS): the same PURSS made for a phone, with listening
  while the screen is off, downloads for reading offline and sharing links into it. See
  [The phone app](#the-phone-app).
- **Desktop app** (Windows, Mac and Linux): the same PURSS in its own window, running on in the
  tray with notifications and downloads, opening feed links and OPML files. See
  [The desktop app](#the-desktop-app).
- **Bookmarklets**: nothing to install; two bookmarks that bring any page to Add source or a basket.
- **Assistants**: an AI assistant can search and read your PURSS, and organise it if you
  allow. Off until you turn it on. See [Assistants (MCP)](#assistants-mcp).
- **E-ink display**: black on white with page buttons, for e-readers. See [Settings](#settings).
- **Install as an app**: your browser's own install, with offline reading. See
  [Install and offline reading](#install-and-offline-reading).

**Not in the stores yet.** The extension and the phone app aren't published in any browser or
app store yet (the desktop app is downloaded from this project's releases); Settings says so, and store buttons appear there once they are. Until then they are
installed from the source code: the extension as described in
[its README](../apps/extension/README.md#try-it-unpacked), the phone app by building it as described
in [the mobile README](../apps/mobile/README.md#build). Bookmarklets, assistants, the e-ink display
and installing the web app need nothing extra.

## Assistants (MCP)

An AI assistant that supports MCP (Claude, ChatGPT, Cursor and others) can work with your
PURSS: search and read your items, and, if you allow it, organise them. It is off unless your
administrator turns it on for the installation (*Administration → Assistants*) and you turn it on
for yourself in *Settings → Assistants*.

1. Turn on **Let assistants use my PURSS**.
2. Press **New token**, give it a name, choose what it may do and how long it lasts, and press
   **Create token**. You confirm it's you first.
3. Copy the token and the connection details. They are shown once. In Claude Code you can paste
   the command shown; other assistants take the address and an `Authorization: Bearer` header.

Some assistants, such as Claude and ChatGPT custom connectors, don't take a token: they ask you to
sign in. Where your PURSS offers this (the official hosted service does; a self-hosted one
only if its operator turned it on), *Settings → Assistants* shows the address to add as a custom
connector. The assistant then opens a page of your PURSS that asks whether to allow it:

- It names the assistant, the site that identifies it, and where you'll be sent back. Allow only
  an assistant you just asked to connect yourself.
- If the assistant asked to organise, you can untick **Also let it organise** to let it only read.
- If assistant access is off for your account, the page lets you turn it on.
- Press **Allow** (you confirm it's you if you signed in a while ago), and you go back to the
  assistant. **Don't allow** sends it away with nothing.

Connected assistants are listed under **Connected assistants** with what they may do and when they
were last used; **Disconnect** stops one at once. One that isn't used for 90 days stops on its own.

What a token or a connected assistant may do:

- **Read only:** search; list and read items (with their saved full text and your own highlights
  and notes, labelled as yours), sources, collections and baskets. Assistants can't change
  highlights or notes.
- **Read and organise:** also change workflow states, clear New markers, keep items in baskets or
  take them out, create baskets and collections, look up and follow sources, rename, pause or
  change a source (full articles, notifications, collections), and unfollow one.

An assistant can never delete anything permanently, share or publish, export, change your sign-in
or reach administration, and it only ever sees your own PURSS. Links of items from private
sources are left out.

- What the assistant reads is sent to it and to its provider.
- Item text comes from the publishers you follow. A page could contain text meant to steer an
  assistant; PURSS labels it as the publisher's text, but check what an assistant proposes
  before it changes many things or unfollows a source.
- Each token shows when it was last used. **Revoke** stops it at once. Turning the switch off
  revokes all your tokens and disconnects your assistants; if your administrator turns assistant
  access off, they stop working until it is back on.
- Over plain HTTP (other than `localhost`) a token travels unencrypted; the page warns you.

## Connected apps

The PURSS app for phones and the browser extension connect to your PURSS without sharing
your password. When an app asks to connect, your browser opens PURSS's **Connect** page:

1. Sign in if needed (you return to the page afterwards). If you signed in a while ago, you confirm
   it's you.
2. Check what is asking (the phone app or a browser extension) and give it a name you'll recognise.
3. Press **Connect**. You go back to the app, or, for apps that can't receive that, you get a short
   code to type into the app. It works once, for five minutes. Never give it to anyone.

Only connect what you started yourself, just now. **Don't connect** sends nothing.

- The phone app can do what you do in PURSS, except sign-in and security settings,
  administration and assistant access, which stay in the browser.
- The extension can only keep links (with the page's text, if you ask), check whether you already
  have a page and which of your sources it belongs to, search, and find and follow sources. See
  [Browser extension and bookmarklets](#browser-extension-and-bookmarklets).
- *Settings → Connected apps* lists each app with when it was connected and last used.
  **Disconnect** stops it at once. An app that isn't used for 90 days is disconnected on its own.
  An administrator suspending your account, or a password reset (by email, or with a link the operator
  made at the server), disconnects them all.

## The desktop app

The app for Windows, Mac and Linux is the same PURSS in a window of its own. Download it from the website or
from *Settings → Connected apps*; it updates itself. It isn't signed by Microsoft or Apple yet, so the first time you
open it Windows asks you to confirm (*More info*, then *Run anyway*) and a Mac asks you to allow it in
*System Settings → Privacy & Security*.

**Connecting.** As in the phone app: sign in to the official server, or choose *Use another server*, with your
email address and password. To use a passkey or a linked account, choose *Sign in in your browser*:
your browser opens the server's Connect page, and the app connects when you press *Connect* there. Your connection
is kept in your computer's keyring (on a Linux computer without one, in a file only your user account can read).
The app connects only to servers updated for it; to the app an older one looks unreachable.

**In the background.** Closing the window keeps the app running in the tray (the system tray or menu bar), so
notifications and automatic downloads go on; quit it from the tray icon. *Settings → This device → Start when you
sign in to the computer* starts it in the tray when you sign in. The number of unread notifications shows on the
app's icon where your system shows such numbers.

**Notifications.** In *Settings → Notifications and New*, choose *Also as notifications on this computer*: new
arrivals then appear as system notifications, outside your quiet hours, even with the window closed. Clicking one
brings the app to the front; on Linux it also opens what the notification is about.

**Downloads.** Downloads are files in an *PURSS* folder in your Downloads folder, one folder per item,
which other programs can open. *Settings → This device → Change folder…* moves them; *Show in folder* opens it.
Disconnecting removes them; anything else you put in that folder stays.

**Feed links and subscription lists.** Links that start with `feed:` or `podcast:` open *Add source* with the
address filled in, and OPML files open the list of their feeds to choose from, as an import does.

**Updates.** New versions of the app download by themselves; *Settings → This device* offers *Restart to update*,
and quitting from the tray installs it too. The PURSS you are connected to can also update the app's screens,
as in the phone app.

## The phone app

The Android and iOS app is the same PURSS as in the browser, made for a phone. It connects to
the official server unless you choose another one: your own, or another hosted one.

**Signing in.** The app opens on the official server's sign-in: sign in with your email address and
password. Where the server sends email, *Forgot your password?* emails you a link to set a
new one; on a server that doesn't, its administrator can give you a reset link to open in a browser. To sign in with your fingerprint, face or screen lock, or a linked account, choose *Use fingerprint, face or a linked account*:
a sign-in tab opens the server's Connect page; sign in there, check that it names this device, and
press *Connect* (see [Connected apps](#connected-apps)).

**New here?** Choose *Create an account*. With an invitation, enter its code, the email address you
were invited with, your name if you like, and a password; the app connects straight away. Where the
server lets anyone sign up, enter your email address instead: open the link that arrives, finish
creating the account in the browser, then sign in in the app.

**Another server.** Press **Use another server** under the sign-in and type the address you open
your PURSS at (it needs **https://**, except on your own computer or home network, where the
app warns that plain http isn't encrypted). The app remembers the server you chose and opens on it
next time. *Settings → This device* shows which server the app is connected to; to change it, press
*Disconnect this app* there and connect again.

**Updates.** The app's screens update from the server you're connected to, without an update from
the app store, so they match the PURSS that server runs. The update takes over the next time
you open the app, or when you come back to it after an hour away (never while something is playing).
A server other than the official one asks first: *Let this server update the app?* That code runs in
the app with your sign-in, so allow it only for a server you trust. You can change your answer in
*Settings → This device → Updates of the app*. Changes to the app itself (new permissions and the
like) come as a new version of the app: Google Play, F-Droid and the App Store install it as they do for
other apps. If you installed the app from the PURSS-android.apk file, the app checks once a day for a newer
one and says *Version … of the app is out*: press **Download** and open the file, and Android installs it
over the app, keeping everything in it. When the server's newest screens need a newer app than yours,
the app tells you once, and *Settings → This device → New version of the app* keeps saying so until you update.

**What is different in the app.**

- Everything in the browser is in the app too: Settings (with *This device* for downloads and the
  connection), Security, Connected apps, Assistants, *Your data* and administration. When the app
  asks you to confirm it's you, use your password (or fingerprint, face or screen lock where the app has it). Exports
  open the share sheet, so you can save them to Files or a cloud drive.
- Links to other sites open in a browser tab over the app.
- **Listening** carries on with the screen off or in another app, with play, pause and skipping on
  the lock screen and in the notification.
- **Offline reading** is on from the start, as in an installed browser app. Where you stopped
  listening and how far you read without a connection are kept on the phone and sent when it is
  back; a later position from another device isn't overwritten by an older one from this phone.
- **Sharing into the app.** In another app, choose Share → PURSS. Then either **Keep
  link** (it says whether you already have the page and where; pick a basket, and a page you
  already have is kept once) or **Add as source** (the address is
  filled in; nothing is looked up until you press *Find*).

**Downloaded.** *Download to this device*, in an item's reader, keeps its text, your highlights and
notes, and its audio or video file on this phone, to read and play without a connection. The
**Downloaded** page lists them.

- While it downloads, a ring around the row's download button fills up (it turns when the publisher
  doesn't say how big the file is), and the reader shows how much has arrived. Once it's done, the
  button becomes a filled check, the item shows **Downloaded** in lists and in the reader, and the
  reader says *Downloaded to this device*. A download that didn't finish shows a warning instead;
  press it to try again.
- **Articles your PURSS has only a summary of:** the download reads the full article from the
  publisher's page, on the phone, and the reader shows it with a note saying so. That copy stays on
  this device only: your PURSS and your other devices keep the summary, and you can't highlight
  on it. Only secure (`https`) pages on public sites are fetched, and the publisher sees this
  device's address. If the page can't be read (gone, behind a login, built with JavaScript), the
  download keeps the summary and says why, with *Try again*. Pictures in the article still load
  from the publisher, so they show only with a connection.
- *All downloads*, under *Downloaded to this device* in the reader, opens the **Downloaded** page.

- A download is a copy on this device only. PURSS stores no audio or video files, so an
  episode's file comes straight from the publisher
  (over a secure connection only), who sees this device's address.
- Nothing guarantees the publisher keeps the original available; if it goes, a download on this device is the only copy.
- *Settings → This device → Automatic downloads*: download To read podcast episodes; only on Wi-Fi
  (on unless you change it); a limit that
  automatic downloads never pass (downloads you start yourself always go ahead and count toward
  it); and removing downloads once an item is finished (marked Finished or Ignored, or played to
  the end). All are off until you turn them on, and they run while the app is open.
- The same page shows how much the downloads take on this device, and *Remove all downloads*. Removing a download never changes your PURSS. An item
  deleted in PURSS disappears from Downloaded the next time the app is online.

**Disconnecting.** *Settings → This device → Disconnect this app* disconnects it and removes
everything it kept on this phone: offline copies, downloads, and highlights or notes not yet sent
(it warns you first). If the app is disconnected from elsewhere (Settings → Connected apps in the
browser, or after 90 days unused), it removes the same and asks you to connect again, except your
unsent highlights and notes: they stay on the phone and are sent when you connect again with the same
account. If you connect with another account, *Settings → This device* lets you copy them as text or
discard them.

## Browser extension and bookmarklets

Keep the page you are reading, or follow its site, without leaving it.

**The extension** (Chrome, Edge, Firefox and Safari; not in their stores yet, see
[Apps and extensions](#apps-and-extensions)) connects in its options: the official server is
already chosen, so press **Connect** and approve it in PURSS (see
[Connected apps](#connected-apps)). For your own or another server, press **Change server** and
type its address first; the extension remembers it. Then:

- **The toolbar button** on any page says whether it is already kept and in which baskets, and which
  of your sources publish on that site. Pick a basket and press **Keep**. The basket you used last is
  picked next time.
- **Also keep its text as you see it** saves the readable part of the page as your browser shows it,
  including pages you are signed in to. The item then says **Captured in your browser** with the
  date: PURSS didn't fetch that page, so it can't confirm the text matches the original.
  If the server can't take it, the link is still kept and the popup says why.
  Doing it again on the same page replaces that text (the popup says so first).
- **Add as a source** appears when the page offers a feed, or is a YouTube channel or video. It
  opens Add source in your PURSS with the address filled in; press **Find** and choose as usual.
- **Right-click** a page or a link for *Keep page in* or *Keep link in* and a basket. The toolbar
  button shows ✓ when it worked and ! when it didn't (hover over it for the reason).
- **Search**: type `purss`, a space and your words in the address bar, then Enter.
- **Mark pages you've kept** (in the extension's options, off unless you turn it on) shows ✓ on the
  toolbar button whenever the page you open is already kept. For that, the extension asks your
  PURSS about every page you open in a normal window (never in private windows). When it's off,
  it asks only when you click the toolbar button.

The extension sends nothing anywhere but your own PURSS, and only the page's address and title,
the page's text when you ask for it, and your search words. **Disconnect** in its options, or in
*Settings → Connected apps*, stops it at once.

**Bookmarklets** do less, with nothing to install. In *Settings → Connected apps*, drag **Add as
source** or **Keep this page** to your bookmarks bar (or copy one and paste it as a new bookmark's
address). Clicking one on any page opens your PURSS in a new tab, with Add source filled in or
asking which basket to keep the page in. They only open PURSS; nothing is looked up or kept
until you press **Find** or **Keep** there. If you aren't signed in, you sign in first and come back
to it.

## Sharing a basket or collection

Any basket or collection can become a public page and an Atom feed: press **Share** under its name.
Anyone with the link can read it without an account, and follow it to get what you add next. On
hosted installations sharing is part of Plus; a self-hosted PURSS always has it.

1. Choose the name to show on the page (a pseudonym is fine; it is never taken from your
   account), an optional description, and whether search engines may list the page (off unless
   you turn it on).
2. **Review** what visitors will see, the exact page, and what of yours becomes public: sharing a
   basket shows everything you keep in it from then on, links you saved yourself show with the
   title you gave them, and your public notes show with your name. Then confirm and **Share**.

The page shows each item's title, link, a short summary, source name and date, newest first (for a
basket: most recently kept first), up to 200 items, and its feed the newest 100. Items from private
sources and links that carry a key never show. Your reading progress and states, private notes and
highlights, and saved text never do. The page is live: what you keep in the basket, or what the
collection gathers, appears on it without another review; taking something out of the basket takes
it off the page.

A filter collection can be shared unless its rules use your reading state (To read and the other
states, New, opened, saved text). If you change its rules that way later, its page stops showing
until you change them back. A text rule on a shared page matches the items' own text only, never
your notes and highlights. Rules on baskets are allowed; the review says the page then shows what
you keep.

**Public notes.** Under **Share → Public notes…**, add a note to any item on the page to say why it
is worth reading. It shows under the item on the page and in the feed, next to the name you chose;
on a public page, as soon as you save it. The editor says so each time.

**Managing it.** Share shows the page's three addresses: the **Page**, its **Feed**, and a **Follow
link**. The follow link opens a page where people follow it in their PURSS here (after signing
in), or copy its feed into any other reader; share it anywhere. Other PURSSes can also follow
the page by pasting its link into Add source. **Pause** hides the page and feed until you review and
share again; **Stop sharing** removes the page, its address and its public notes. Deleting the
basket or collection stops sharing it. Turning on search-engine listing for a page that is already
public asks you to confirm first; unless you turned it on, search engines are asked not to index
the page, but that is a request, not access control. Copies people already fetched can't be
recalled. The **Sharing** page lists everything you share, with its state.

**Reports and takedowns.** Every public page has a **Report this page** link. Visitors pick a
reason and explain; only what they type is kept, never their address, and you don't see it. An
administrator reviews reports under *Administration → Reports* (only reported pages are shown
there, as visitors see them). If they take a page down, the server stops showing its page and feed at once (a copy fetched in
the minute before may still show in a browser or feed reader), Share and
the Sharing page say why and the bell tells you; you can still change it, but sharing it again (or
removing it) waits until an administrator restores it.

## A Follow button for your site

Write a blog or run a site? In *Settings → Connected apps → Follow button for your site*, paste
its feed address. You get a button to paste into your pages, and the plain follow link. Readers who
press it land on this PURSS's follow page: they follow your site here, or copy the feed into
their own reader. The button is one link with no script or image, so nobody is tracked.

## Your data

*Settings → General → Your data*:

- **Export everything:** one JSON file with your sources, collections, baskets and kept items,
  saved text and the pictures kept with it, states and the log of your workflow changes, your
  highlights and notes, your [reminders](#reminders), preferences and shared-collection
  definitions. It leaves
  out sign-in methods, sessions and private links.
- **Kept links as a list:** a web page (or a Markdown file) with every basket and the items kept
  in it: title as a link to the original, where it came from, and the dates published and
  kept. For reading and printing; it isn't something to import again.
- **Import:** shows what an export file would add before anything changes. Nothing is deleted,
  items already here aren't added twice, sharing settings arrive switched off, and private
  sources arrive as *needs reconnecting*. Reminders come back on their items when the item is
  kept; days that have gone by, and items that already have a reminder, are left alone.
- **OPML:** export the public feeds you follow, or import a list (see above).
- **Reconnect** a private source by pasting its link again.

If the collection engine is replaced by a different installation, its entries wait on a
**Review** page, announced on Home, where you match each to an item you already have, add it as new, or dismiss it.

## Deleting your account

*Settings → Account → Delete account* deletes your PURSS: sources, collections, baskets
and everything kept in them, saved text and browser captures, and where you
stopped listening, highlights and notes, reading history and statistics, preferences, shared
collections, your email address, sign-in methods, connected apps and assistants. The dialog offers **Export first**, so you
can keep a copy to import elsewhere. To confirm, type your display name exactly as shown (or
the word `delete` if your account has none), and confirm it's you with fingerprint, face or screen lock or a password
if you haven't signed in recently.

- **Straight away:** you are signed out on every device, the phone apps and browser extension
  are disconnected, assistants (tokens and those connected with OAuth) stop working, your shared pages are switched off, and nothing new is
  collected for you. Offline copies and downloads on the device you used are deleted; other
  devices remove theirs when they next notice they were signed out.
- **For 7 days:** signing in (any way you normally do) doesn't open PURSS; it asks
  whether to **Keep my account** or **Leave it**. Keeping it ends the deletion and signs you in
  with everything as it was; shared pages stay switched off until you share them again,
  and apps, extensions and assistants have to be connected again. If you forgot your password,
  a reset by email, or a link from the operator, still works during these days.
- **After 7 days:** signing in is refused and the account can't be kept. Everything is removed
  from PURSS and from the collection engine. Only the administration audit log keeps a
  record that an account with that id was deleted.

The last administrator of an installation can't delete their account; make someone else an
administrator first. Copies of shared pages that visitors already fetched, and backups an
operator made earlier, aren't recalled.

## Settings

At the bottom of Settings is the version you're running, e.g. **Version 2631214**: mention it when you report
a problem, and look for it in update posts. In the phone app the line also names the installed app's version,
and the server's when the app runs other screens than the server offers.

- **General:** theme (light, dark, match device), accent colour, density, anniversary reminders, muted words, time zone (used for "Today" and "Yesterday"; taken from your device the
  first time you sign in), **E-ink display**, **Text size** and **Sounds**.
- **E-ink display:** for e-readers. Pure black on white with nothing that moves, no
  shadows or shading, row actions always shown, larger buttons, and **Page up** / **Page down**
  buttons on lists and articles that move one screen at a time instead of scrolling. It overrides
  the theme on that device only and is saved on this device; it is never switched on by itself.
- **Offline reading:** see [Install and offline reading](#install-and-offline-reading).
- **Connected apps:** where to get the extension and the phone app ([Apps and extensions](#apps-and-extensions)),
  what is connected ([Connected apps](#connected-apps)), and the bookmarklets.
- **This device** (the phone app only): see [The phone app](#the-phone-app).
- **Assistants:** see [Assistants (MCP)](#assistants-mcp).
- **Text size:** 100%, 115%, 130% or 150%. It scales the text and controls of the whole app and
  is saved on this device only. (Your browser's own zoom works as well.)
- **Sounds:** soft interface sounds for your own actions; arrivals stay silent. Off by default;
  turn them on, set the volume and pick one of four styles. Saved on this device only.
- **Notifications and New:** how often and about what you are told, whether the digest and [reminders](#reminders) also come by email, quiet hours, how long items stay New, and whether New markers and counts show. See above.
- **Security:** password, fingerprint, face or screen lock, linked sign-in
  and signed-in devices, and your email address where the installation sends email. On a phone,
  Settings also has a button in the header; on a shared computer the header has **Sign out**.
- **Account:** delete your account; see [Deleting your account](#deleting-your-account).
