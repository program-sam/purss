# Acceptance journey

`npm run test:e2e` runs the plan's core journey against the real stack, not mocks:
a separate FreshRSS container (`purss-freshrss-acceptance`), the egress proxy, API and
worker on their own ports (189xx) and a throwaway data directory, driven in Chromium.

Set up with the one-time code and a username and password → add a passkey (virtual
authenticator) → paste and follow two real public sources → items arrive through
FreshRSS, egress and the worker → browse a collection in every view → open an item
with the keyboard → To read → keep in a text basket and wait for the readable-text
capture → search finds it → restart API and worker → sign out and back in with the
passkey → the kept item is in its basket → storage counts it → an invited second account (username
and password, passkey skipped) asks to be deleted, is signed out, and keeps its account by signing in
again with its password.

Needs Node 26, podman with the pinned FreshRSS image, network access to the public
feeds, and Playwright's Chromium (`npx playwright install chromium`). It takes a few
minutes; run it under the host's work lock. On failure it prints the job and capture
state and saves a screenshot to the system temp directory; the containers and data
are always removed.

Not yet covered here (tested elsewhere or still manual): engine outage recovery,
quota/disk pause, multi-basket and deletion paths (API integration tests), sharing,
export/import and admin (API route tests and the web executor's browser passes),
mobile layouts and screen readers. See [the acceptance matrix](../../plan/13-validation.md).

## Install and offline reading

`tests/acceptance/offline.ts` is a second, hermetic journey for the installable app; `npm run
test:e2e` builds the web app and runs it after the core journey, and `node tests/acceptance/offline.ts`
(after `npm run build`) runs it alone. It needs only Node 26 and Playwright's Chromium: no podman, FreshRSS or network. It
starts the API on its own ports (199xx) with a throwaway data directory and a copy of the web build,
and seeds a small library from the API's own test fixtures, posted through the same sync path the
worker uses. The hermetic journeys make their account in-process with a username and the shared test
password (`testPassword` and `TEST_PASSWORD` in `apps/api/src/testing.ts`) and sign in with them on the
sign-in page.

It checks that the manifest, icons, `/sw.js` and the page's install tags are served with the right
types and caching; signs in with a username and password; marks an item To read; highlights a passage with the
selection bar and comments on another with the keyboard, reopens both and finds the item by its
comment; turns offline reading on
and waits for the pack to save; goes offline, reloads and reads the item's text with its highlights; writes a note offline that
shows *Waiting to sync*, survives a reload and is synced when the connection returns; sees changes fail
with the usual message; comes back online; switches to a new worker build through the "A new version
is ready" toast; checks that turning the setting off or removing the copies wipes them; leaves a note the
server can't take yet, sees the sign-out warning and that sign-out deletes it; signs out and
checks that no saved copy or record stays while the app shell does; and, in a context that reports
itself as an installed app, that offline reading starts on by itself.

## Connected apps

`tests/acceptance/connect.ts` is a hermetic journey for connecting the phone app and the browser
extension (plan/24); `npm run test:e2e` runs it after the offline journey, and `node tests/acceptance/connect.ts` (after
`npm run build`) runs it alone. Like the offline journey it needs only Node 26 and Playwright's
Chromium, and starts the API on free ports with a throwaway data directory. A browser
extension's request sends a signed-out person through sign-in and back to the approval page; the
typed code and PKCE verifier give it a token that looks up a kept page, keeps a link once and is
refused elsewhere; the phone app's code arrives at `purss://connect` (seen through the browser's
navigation events) and a decline sends `access_denied`; a foreign return address is refused on the
page; Settings → Connected apps lists both and disconnecting stops a token at once. Once the session's
sign-in is older than the ten-minute step-up window (the journey ages it in the database), Settings →
Security → *Change username or password* asks to confirm it's you: a wrong password is refused, the right
one opens the password form.

## Assistants signing in with OAuth

`tests/acceptance/oauth.ts` is a hermetic journey for assistants that connect with OAuth (plan/33);
`npm run test:e2e` runs it after the connected-apps journey, and `node tests/acceptance/oauth.ts`
(after `npm run build`) runs it alone. It needs Node 26, Playwright's Chromium and `openssl`, and
runs the API in its own process on free ports with OAuth turned on, so the client metadata document
can come from a local HTTPS server through the safe fetcher's in-process test hooks. The script acts
as the assistant: `/mcp`'s 401 leads it to the protected resource and authorization server
metadata; the browser opens the consent page signed out, signs in with the username and password and comes
back; the person turns assistant access on from the page, unticks organising and allows; the browser
arrives at the assistant's callback with the code, `state` and `iss`; the code and PKCE verifier give
a read-only token that lists only reading tools and finds an item; refreshing rotates the tokens;
Settings → Assistants lists the assistant; revoking ends it; declining sends `access_denied`; and a
foreign return address is stopped on the page.

## The player and playback positions

`tests/acceptance/media.ts` is a hermetic journey like the offline one (Node 26 and Chromium only;
`npm run test:e2e` runs it after the connected-apps journey, or `node tests/acceptance/media.ts` after `npm run build`). The server
keeps no audio or video files, so the journey first leaves a media folder as an earlier version would have and
checks the API removes it when it starts, and that the page's `media-src` policy allows publishers' https files only. It seeds a
podcast source with two episodes and plays one from the publisher's own address (the browser answers that address with a
generated WAV, as the page may only play https files), keeps it playing across pages, pauses and checks the
position on the server, changes speed, resumes after a reload, sees a plain failure for a publisher file
that can't be reached, checks that nothing offers to save or download the file (in a browser there are no device downloads),
and checks the player fits a phone screen.

## E-ink display

`tests/acceptance/eink.ts` is a hermetic check that `npm run test:e2e` runs after the media journey (or alone with
`node tests/acceptance/eink.ts` after `npm run build`; API on ports 19970 and 19978). It seeds a 40-item
library, records the standard look, turns on *E-ink display* in Settings, and checks computed styles:
white page, black text and borders, no gradients, shadows, transitions or dialog animation, row
actions shown without hovering. It pages the list and an article with the Page buttons (exactly one
screen less one line, at once), reloads (still e-ink, still light over a dark account theme), turns
it off and checks the standard look is exactly what it was, and repeats the paging on a phone-sized
screen. Screenshots of each look go to the system temp directory (`purss-eink-*.png`).

## Account email

`tests/acceptance/email.ts` runs last in `npm run test:e2e` (alone: `node tests/acceptance/email.ts`
after `npm run build`; ports 19980 and 19988). It starts a local SMTP server (`apps/api/src/mail/testing.ts`)
and a hosted installation with open sign-up, waits for sign-up to open once the mail check passes,
signs a new person up with an address, a username and a password (skipping the passkey offer), confirms
the address from the received message, follows *Reset your password by email* from the sign-in page and
asks for a reset with an unknown username (same answer, no message) and with the address,
sets a new password from the emailed link, checks the notice, that the first browser was signed out,
and that only the new password works.

## Browser extension and bookmarklets

`tests/acceptance/extension.ts` runs last in `npm run test:e2e` (alone: `node tests/acceptance/extension.ts`
after `npm run build` and `npm run build:extension`). Like the other hermetic journeys it needs only Node
24 and Playwright's Chromium; it starts the API on free ports and a small local "publisher" site. It loads
the built Chromium extension unpacked into Chromium's new headless mode (the headless shell can't run
extensions), with access to the publisher's site added to its manifest in place of the `activeTab` grant
a real click on the toolbar button gives. The toolbar popup is opened with `action.openPopup()` and
driven through the extension's options page, which can reach the popup's document.

A "Keep this page" deep link opened while signed out comes back after sign-in and keeps after a basket
is picked; the extension connects through `launchWebAuthFlow`, the approval page and PKCE; the popup on a
blog post offers its feed, keeps the page with its text as the browser shows it, and on reopening shows
it as kept (and ✓ on the toolbar button); PURSS shows the text as "Captured in your browser" with
its date and without the page's furniture; "Add as a source" opens Add source with the feed filled in and
no discovery request; *Settings → Connected apps* lists the extension and offers the bookmarklets, and
running one opens Add source; disconnecting revokes the token. The right-click menu and the address-bar
keyword can't be driven from Playwright; their logic has unit tests.

## Signing in with Google

`tests/acceptance/google.ts` is a hermetic journey for signing in with an external OpenID Connect provider
([plan/21](../../plan/21-identity-and-administration.md)); `npm run test:e2e` runs it after the email journey, and
`node tests/acceptance/google.ts` (after `npm run build`) runs it alone. It needs only Node 26 and Playwright's
Chromium: a hosted API with open sign-up, a local SMTP server (open sign-up needs working email) and a local fake issuer
(`oauth2-mock-server`) configured as Google. A stranger makes an account with *Continue with Google* (no username or
password) and reaches Home; Settings → Security lists Google and refuses to remove the last way in; signing out and in
again with Google uses the same account; with the sign-in older than ten minutes, *Add a password* asks to confirm
it's you, *Confirm with Google* does, and the password is added. Someone whose Google email already belongs to an
account, or whom Google doesn't vouch for, is refused with nothing made or linked. The phone app's browser path
(`providerStartUrl`) signs a third person up through the provider in the system browser, lands on the approval page,
hands the code to `purss://connect` and gets a device token; the app then confirms it's it through a single-use
ticket and the system browser. It checks Google's button (white, its inline G, no remote image) and that nothing loads
from outside PURSS and the issuer, and saves screenshots to `.output/google-signin/`.
