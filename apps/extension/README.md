# Browser extension

Keep the page you're reading in your PURSS, hand its site to Add source, and search the
PURSS from the address bar. One Manifest V3 code base builds for Chrome and Edge (`chromium`),
Firefox (`firefox`) and Safari (`safari`); the manifests differ only in how the background runs (service worker or
event page), Firefox's add-on id and data-collection declaration, and Safari having no `identity` API. How people use
it: [user guide](../../docs/user-guide.md#browser-extension-and-bookmarklets). Device tokens, what the extension's
token reaches and the threats considered: [security](../../docs/security.md#browser-extension).

## What it does

| Surface | Does | Never |
| --- | --- | --- |
| Toolbar popup | On open, three requests side by side: a lookup of the page (kept, in which baskets, followed sources that publish on that site), the baskets, and the page's feed hints. **Keep** with a basket picker (it starts on the last basket used), optionally **Also keep its text as you see it**, **Add as a source** when the page advertises a feed or is a YouTube channel or video, and **Open it in your PURSS** | Do anything without a click |
| Right-click menu | *Keep page in ›* and *Keep link in ›* with up to 12 baskets (names cached from the last popup, connection or browser start); the toolbar shows ✓ or ! with the outcome. Not where the browser has no context menus (iOS) | Send more than the address and title, or read the page |
| Toolbar mark | The popup sets ✓ on the tab after its lookup. Marking pages as they open is a setting, **off by default**; turning it on asks for the `tabs` permission at that moment. Each page opened in a normal window (never a private one) is then looked up after 1.2 s on it, with answers kept 10 minutes per address (fragment ignored, at most 500) | Send addresses of visited pages to the PURSS unless that setting is on |
| Address bar | The keyword `purss`: Enter opens search in the PURSS (`/?dialog=search&q=…`) | Suggest while typing, since each keystroke would go to the PURSS |

The extension never re-implements discovery, following or the choice of a collection: **Add as a source** and a keep
that needs a basket choice open the PURSS in a tab through deep links (`/?dialog=add&url=…`,
`/?dialog=keep&url=…&title=…`, `/?dialog=search&q=…`), which survive signing in. A deep link only fills a dialog in:
nothing is looked up until the person presses Find, and nothing is kept until they press Keep. Feed hints are
addresses that go through Add source's safe fetching: the extension sends addresses, never feed contents, so FreshRSS
stays the only fetcher. Bookmarklets, which need no extension, are offered in Settings → Connected apps; they only open
a deep link in a new tab and never call the API.

**Feed hints.** A content script, injected only when the popup opens, reads `<link rel="alternate">` feeds (RSS, Atom,
JSON Feed, RDF; up to 8) and the YouTube channel. A channel page is read from its address; a video's channel from its
microdata only when that microdata is about this video, else the video's own address is handed over, since YouTube
changes pages without reloading and the head can describe the previous page.

**Browser capture** happens on request only. In the page, Mozilla Readability reads a clone of the document (the page
itself is untouched), at most 2,000,000 characters; `POST /api/items/browser-capture` keeps the page like
`/api/items/manual` (same duplicate rules) and stores the HTML as a capture of kind `browser`, sanitized again with the
server's allowlist. The server fetches nothing, so the text is what the person saw, including a page behind their own
sign-in. The item says *Saved from your browser* with the date, and an assistant's `get_item` reports the text source as
text saved from the person's browser: it is never presented as a copy the server fetched or a promise about the
original. An item has at most one browser capture; capturing again replaces its text in place (keeping its id, so
highlights made on it still name it), and the popup says *Replaces the text kept from your browser on …* first. The
text counts against the account's storage like a server capture; text that doesn't fit is refused while the link is
still kept. Limits: request body 8 MB, 60 captures per 10 minutes per account, title at most 300 characters.

## Permissions and the connection

The manifest asks for `activeTab`, `scripting`, `storage`, `contextMenus` and `identity` (not Safari), and the optional
`tabs` for the toolbar mark. It declares no host permissions, no content scripts, no `<all_urls>`, cookies or web
requests: the PURSS answers the extension's requests with CORS, and a page is read only when the person opens the popup
or the right-click menu on it (`activeTab`), by a script injected for that purpose. That gives a short install warning
and a faster store review.

- **Server.** The official server (`OFFICIAL_PURSS_ORIGIN` in `packages/domain/src/distribution.ts`) is preselected:
  the options page shows *Server: …* and **Connect**, with a small **Change server** that reveals the address field (and
  *Use the official server* to go back). The server last connected to is remembered in the extension's storage, also
  after disconnecting. With the constant empty only the address field is shown.
- **Address rule.** One rule with the apps (`parsePurssAddress` in `packages/domain/src/purss-address.ts`):
  `https://` when no scheme is typed, and plain `http://` only for this computer, private, shared (CGNAT) and link-local
  ranges (IPv4 and IPv6) and the names `.local`, `.lan`, `.internal` and `.home.arpa`, with a warning when it isn't
  loopback.
- **Connecting.** The options page checks that `/api/connect/info` names a PURSS that calls itself by that address, then
  `identity.launchWebAuthFlow` opens the server's `/connect` page with PKCE (S256), a fresh `state` and the browser's own
  redirect (`https://<id>.chromiumapp.org/…`, `https://<hash>.extensions.allizom.org/…`). The answer must carry that
  `state` and an `iss` equal to the PURSS. Safari, and anyone who prefers it, types the short code the approval page
  shows. The connection runs in the options tab, because a popup closes when the approval window takes focus.
- **Token.** Kept in the extension's local storage, never synced; sent only as a bearer header with
  `credentials: "omit"`, and only to the connected PURSS. The server gives an `extension` token an exact list of routes
  (look up a page, list baskets and collections, keep a link, keep a link with the page's text, search, find and follow a
  source, read the session, disconnect itself), never an administrator's rights or a recent sign-in. A 401 makes the
  extension forget the token; **Disconnect** calls `DELETE /api/connect/device` and forgets it even when the PURSS can't be
  reached.

## Build

```text
npm run build:extension          # from the repository root (or: npm run build -w @purss/extension)
```

It writes, for each browser, the unpacked extension and a ZIP for its store:

```text
apps/extension/dist/chromium/                  apps/extension/dist/purss-chromium.zip
apps/extension/dist/firefox/                   apps/extension/dist/purss-firefox.zip
apps/extension/dist/safari/                    apps/extension/dist/purss-safari.zip
```

`dist/` is ignored by Git. The build (`src/packaging/build.ts`) uses Vite, already the web app's bundler,
with exact versions: the popup and options pages are a Vite multi-page build, the background and the
two page readers single classic scripts. The manifests come from `src/packaging/manifest.ts`, the icons from
the web app's `icon.svg`, and the ZIPs are reproducible (sorted names, fixed timestamps). Output isn't
minified, so reviewers can read it; `licenses.md` lists bundled third-party code (Mozilla Readability).

## Try it unpacked

Build first, then:

- **Chrome or Edge:** open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*,
  choose *Load unpacked* and pick `apps/extension/dist/chromium`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on…* and pick
  `apps/extension/dist/firefox/manifest.json`. It stays until Firefox restarts.
- **Safari (Mac):** run `xcrun safari-web-extension-converter apps/extension/dist/safari` to make an
  Xcode project, run it, turn on *Develop → Allow Unsigned Extensions* and enable the extension in
  Safari's settings. Safari connects with the typed code (it has no `identity` API).

Then open the extension's options and press **Connect** for the official server
(`OFFICIAL_PURSS_ORIGIN` in `packages/domain/src/distribution.ts`), or **Change server** and
enter your PURSS address (for a local development stack, `localhost:8940`), and approve the
connection in the PURSS. The extension remembers the server it last connected to.

## Layout

| Path | What lives there |
| --- | --- |
| `src/background.ts` | Right-click menu, address-bar keyword `purss`, the opt-in toolbar mark |
| `src/popup/` | The toolbar popup for the open page |
| `src/options/` | Connecting, disconnecting, settings |
| `src/content/` | The two scripts injected into a page on request: feed hints, readable text |
| `src/lib/` | Address rules and deep links, the workspace client, connecting (PKCE), feed detection, capture, popup wording, menus, the mark's cache; each with tests |
| `src/packaging/` | Manifests per browser, the ZIP writer, the build script, the store uploads |

The extension imports only types from `@purss/domain` and the design tokens and primitives (CSS) from
`@purss/ui`. Tests run with the repository's `npm test`; the browser journey is
`tests/acceptance/extension.ts` (see the [acceptance README](../../tests/acceptance/README.md#browser-extension-and-bookmarklets)); it
drives Chromium; Firefox is checked with `web-ext lint`, and Safari has no automated run.

The extension keeps only readable text: it doesn't capture images, styles or whole-page archives or a selection as a
quote, and a browser capture is removed only by deleting its item. Firefox for Android is not a target.

## Publishing

Store accounts, signing keys and API keys belong to the owner and never go into the repository.
The version is the product's, a number made from the commit's UTC day and its place among that day's commits on
`main`, spelled `26.312.14` in the extension's manifest, so every build
from main is higher than the last, as the stores require: build from an up-to-date checkout of main and
upload the matching ZIP. Once a listing is live, the *Browser extension* workflow
(`.github/workflows/extension.yml`, monthly and on demand) sends new versions to the Chrome Web Store and
addons.mozilla.org for review: only when the extension changed, and not while an earlier version waits for
review (`src/packaging/stores.ts`). Its keys are the repository secrets `CHROME_WEBSTORE_SERVICE_ACCOUNT`
(a Google Cloud service account's JSON key; add the account under *Account* in the Chrome Web Store
dashboard) and `AMO_JWT_ISSUER` with `AMO_JWT_SECRET` (addons.mozilla.org → Tools → Manage API Keys). When a
listing is live, put its address in
`STORE_LISTINGS` in `packages/domain/src/distribution.ts`: Settings → Connected apps and the website
then show its store button instead of naming the store as "not … yet".

- **Chrome Web Store:** register a developer account (one-time fee), create an item in the
  Developer Dashboard and upload `purss-chromium.zip`. In *Privacy*, state the single
  purpose (keep pages in your own PURSS), justify each permission (`activeTab`, `scripting`,
  `storage`, `contextMenus`, `identity`, optional `tabs`), and declare that page addresses and, on
  request, page text are sent to the PURSS the user connects, not to the developer. Review takes
  days; there are no host permissions to slow it down.
- **Microsoft Edge Add-ons:** in Partner Center, upload the same `purss-chromium.zip`.
- **Firefox (addons.mozilla.org):** the add-on id (`FIREFOX_ID` in `src/packaging/manifest.ts`) is
  published and can't change; the connect flow's return address is derived from it. Upload
  `purss-firefox.zip` in the Developer Hub. Because the scripts are bundled, AMO asks for the source:
  upload a source archive of the repository with these build steps (`npm ci`, `npm run build:extension`, Node 26). Check that the data-collection
  declaration in the manifest matches the listing. For self-distribution instead, `web-ext sign
  --channel=unlisted` with AMO API keys kept outside the repository.
- **Safari (macOS and iOS):** needs an Apple Developer Program membership. In App Store Connect,
  use the Safari Web Extension Packager with `purss-safari.zip` (or, on a Mac, Xcode with
  `safari-web-extension-converter`); it produces the app that contains the extension, which goes
  through TestFlight and App Review. Updates ship as new app versions.

Firefox can be checked locally before uploading with `npx web-ext lint --source-dir apps/extension/dist/firefox`.
It reports no errors; it warns that Firefox for Android reads the data-collection declaration only
from version 142 (Android isn't a target), and about `innerHTML` inside the bundled Readability,
which works on a copy of the page, never on the page itself.
