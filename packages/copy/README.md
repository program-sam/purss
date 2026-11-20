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
| `@purss/copy/server` | what the server sends to people: API errors, emails, public pages, source messages | `src/server/en/` |
| `@purss/copy/common` | text the app and the server share (`packages/domain`) | `src/common/en/` |

The catalogs are split by audience so the website, the app and the extension each bundle only
their own text. English is the only language; its files sit under `en/`.

## Editing copy

Find the text in the catalog for the screen it appears on (the app's areas follow the folders of
`apps/web/src`, the site's files follow `apps/site/src`) and change the string. In an entry
that is a function, keep its `${…}` values; `npm run check` catches a misspelled one. The
end-to-end tests look for some buttons and headings by their English text, so rewording one of
those means updating the test too.

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

## What stays in code

Ids, keys, CSS classes, URLs, log and console messages, error codes, command-line output for
operators, and labels only screen readers announce stay where they are used. So do the push
relay's one fallback notification (the relay deploys on its own) and the store names in
`packages/domain/src/distribution.ts` (the desktop release job runs it without installing
packages). The native shells keep their platform's own resource files: Android in
`apps/mobile/android/app/src/main/res/values/`, the desktop tray and menus in
`apps/desktop/src-tauri/src`.
