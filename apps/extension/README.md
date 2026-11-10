# Browser extension

Keep the page you're reading in your PURSS, hand its site to Add source, and search the
PURSS from the address bar. One Manifest V3 code base builds for Chrome and Edge (`chromium`),
Firefox (`firefox`) and Safari (`safari`). Decisions and threats: [plan/32](../../plan/32-browser-extension.md);
the connection it uses: [plan/24](../../plan/24-connected-apps.md); how people use it:
[user guide](../../docs/user-guide.md#browser-extension-and-bookmarklets).

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
(`OFFICIAL_WORKSPACE_ORIGIN` in `packages/domain/src/distribution.ts`), or **Change server** and
enter your PURSS address (for a local development stack, `localhost:8940`), and approve the
connection in the PURSS. The extension remembers the server it last connected to.

## Layout

| Path | What lives there |
| --- | --- |
| `src/background.ts` | Right-click menu, address-bar keyword `ws`, the opt-in toolbar mark |
| `src/popup/` | The toolbar popup for the open page |
| `src/options/` | Connecting, disconnecting, settings |
| `src/content/` | The two scripts injected into a page on request: feed hints, readable text |
| `src/lib/` | Address rules and deep links, the workspace client, connecting (PKCE), feed detection, capture, popup wording, menus, the mark's cache; each with tests |
| `src/packaging/` | Manifests per browser, the ZIP writer, the build script |

The extension imports only types from `@purss/domain` and the design tokens and primitives (CSS) from
`@purss/ui`. Tests run with the repository's `npm test`; the browser journey is
`tests/acceptance/extension.ts` (see the [acceptance README](../../tests/acceptance/README.md)).

## Publishing (the owner)

Store accounts, signing keys and API keys belong to the owner and never go into the repository.
The version is the product's ([plan/40](../../plan/40-versions.md)), spelled `26.312.14`, so every build
from main is higher than the last, as the stores require: build from an up-to-date checkout of main and
upload the matching ZIP. Once a listing is live, put its address in
`STORE_LISTINGS` in `packages/domain/src/distribution.ts`: Settings → Connected apps and the website
then show its store button instead of "Not in the stores yet".

- **Chrome Web Store:** register a developer account (one-time fee), create an item in the
  Developer Dashboard and upload `purss-chromium.zip`. In *Privacy*, state the single
  purpose (keep pages in your own PURSS), justify each permission (`activeTab`, `scripting`,
  `storage`, `contextMenus`, `identity`, optional `tabs`), and declare that page addresses and, on
  request, page text are sent to the PURSS the user connects, not to the developer. Review takes
  days; there are no host permissions to slow it down.
- **Microsoft Edge Add-ons:** in Partner Center, upload the same `purss-chromium.zip`.
- **Firefox (addons.mozilla.org):** first make the add-on id final (`FIREFOX_ID` in
  `src/packaging/manifest.ts`; it can't change after the first upload, and the connect flow's return
  address is derived from it). Upload `purss-firefox.zip` in the Developer Hub. Because
  the scripts are bundled, AMO asks for the source: upload a source archive of the repository with
  these build steps (`npm ci`, `npm run build:extension`, Node 26). Check that the data-collection
  declaration in the manifest matches the listing. For self-distribution instead, `web-ext sign
  --channel=unlisted` with AMO API keys kept outside the repository.
- **Safari (macOS and iOS):** needs an Apple Developer Program membership. In App Store Connect,
  use the Safari Web Extension Packager with `purss-safari.zip` (or, on a Mac, Xcode with
  `safari-web-extension-converter`); it produces the app that contains the extension, which goes
  through TestFlight and App Review. Updates ship as new app versions.

Firefox can be checked locally before uploading with `npx web-ext lint --source-dir apps/extension/dist/firefox`.
It reports no errors; it warns that Firefox for Android reads the data-collection declaration only
from version 142 (Android isn't a target yet), and about `innerHTML` inside the bundled Readability,
which works on a copy of the page, never on the page itself.
