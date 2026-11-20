# Copy package

Every word people read in PURSS lives here, so wording can be changed in one place and a
language can be added later. Code imports the catalog for its audience and never writes visible
text inline.

| Import | Audience | Files |
|---|---|---|
| `@purss/copy/site` | the public website (`apps/site`) | `src/site/en/` |
| `@purss/copy/app` | the web app, which the desktop and mobile apps also run | `src/app/en/<area>.ts`, one per folder of `apps/web/src` |
| `@purss/copy/ui` | the shared UI kit (`packages/ui`) | `src/ui/en/` |
| `@purss/copy/extension` | the browser extension | `src/extension/en/` |
| `@purss/copy/server` | what the server sends to people: API errors, emails, public pages, source messages, the push relay's fallback notification | `src/server/en/` |
| `@purss/copy/common` | text the app and the server share (`packages/domain`), including the store and download names in `distribution.ts` | `src/common/en/` |
| `@purss/copy/native` | the Android app's string resources, the iOS widgets' and notification extension's Swift, and the desktop app's Rust code | `src/native/en/` |

The catalogs are split by audience so the website, the app and the extension each bundle only
their own text. English is the only language; its files sit under `en/`.

## Editing copy

Find the text in the catalog for the screen it appears on (the app's areas follow the folders of
`apps/web/src`, the site's files follow `apps/site/src`) and change the string. In an entry
that is a function, keep its `${…}` values; `npm run check` catches a misspelled one. Tests take
the text they look for from the catalogs, so rewording an entry never breaks one; a test that
writes visible text out instead of reading it from a catalog is a mistake. The end-to-end tests
run against a built app, so build it again after changing copy.

Code never decides anything by the words it shows. The server stores a state or a code and shows
the catalog's words for it when read: a source waiting for its first items stores no text, a
failed follow stores its reason (`sources.health_reason`) beside the message, and the source that
holds links kept by hand is recognised by its kind and takes the catalog's name each time the API
starts. Messages written when something happened (notifications, a source's failure message) keep
the words they were written with.

`scripts/copy-guard.test.ts` fails when a component of the app, the UI kit or the extension writes
visible text inline.

## Writing catalog entries

- Plain text is a string: `title: "Muted words"`.
- Text with values is a function returning a string: `until: (date: string) => \`until ${date}\``.
  Plurals are functions too: `hidden: (n: number) => n === 1 ? "1 item hidden" : \`${n} items hidden\``.
- Text with a link or emphasis inside is split into its pieces, and the code puts the markup
  between them: `{ before: "Read the ", link: "install guide", after: " first." }`. The catalogs
  hold no React or HTML, except where the website or an email already builds its pages as HTML
  strings, where an entry may hold the HTML it always had.
- Group entries by component or page, named after it: `app.dialogs.mutedWords.title`.
- Keep the text exactly as people see it, including punctuation, curly quotes and non-breaking
  spaces.

## Native shells

Android resources, Swift and Rust code can't import TypeScript, so `scripts/native-copy.ts` writes their
files from `@purss/copy/native`. After changing a text there, run `npm run copy:native`; the
generated files are committed, start with a note saying where to edit, and are never edited by
hand. A test (`scripts/native-copy.test.ts`, part of `npm test`) fails when one is out of date, and
when the app uses an Android string the catalog doesn't write or the catalog writes one the app
doesn't use.

- **Android** (`src/native/en/android.ts`): a group and a key make the resource's name, so
  `push.channelName` is `@string/push_channel_name`. The `widget` and `widgetPreview` groups are written to
  `values/widget_strings.xml`, the others to `values/strings.xml`; `values/app_identifiers.xml` (the
  application id and URL scheme, which are not text) is edited by hand.
- **Both phones' widgets** (`src/native/en/widget.ts`): Android writes them to `values/widget_strings.xml` as
  `widget_…`, iOS reads them as `NativeCopy.Widget`.
- **iOS** (`src/native/en/ios.ts`, and `widget.ts`): `apps/mobile/ios/App/Widgets/NativeCopy.swift`, compiled into the
  app, the widgets and the notification extension; a group becomes a nested enum, a plain text a constant
  (`NativeCopy.Widget.loading`) and a text with values a function (`NativeCopy.Ios.Notification.more(count:)`). The
  widget settings' App Intent names have to be written out where they are declared, because Xcode reads them while
  building: in `PanelChoice.swift` a line ending in `// copy: ios.panelChoice.source` gets that text written into its
  string by the same script.
- **Desktop** (`src/native/en/desktop.ts`): a group becomes a module of `apps/desktop/src-tauri/src/copy.rs`, a
  plain text a constant (`copy::tray::OPEN`) and a text with values a function (`copy::tray::restart(version)`).
- Unlike the other catalogs, this one holds plain strings and no functions. A `{name}` (lower-case letters and
  digits) stands for a value the code fills in; the generator turns it into the platform's own placeholder.
  Values are numbered by where their names first appear in the text (Android's `%1$s`, `%2$s`; a Rust function's
  arguments), so moving a `{name}` before another in a sentence also changes the order the code passes them in.

## What stays in code

Ids, keys, CSS classes, URLs, log and console messages, error codes, command-line output for
operators, and labels only screen readers announce stay where they are used. So do:

- the static HTML titles and loading messages (`apps/web/index.html`, the extension's `popup.html`
  and `options.html`);
- the messages the phone and desktop plugins reject a call with (`call.reject(...)` in Kotlin and Swift,
  the desktop's one-word codes and lower-case diagnostics), which only developers read (the page words a
  failed download itself from the error code);
- the desktop installer's own metadata (`apps/desktop/src-tauri/tauri.conf.json`'s window title, short
  description and file type names);
- the iOS app's name (`CFBundleDisplayName` in the four `Info.plist` files).
