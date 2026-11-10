# Site

The public website: a home page (`index.html`, built from `src/home.ts`) and the Terms,
Privacy and Legal notice pages (`terms.html`, `privacy.html`, `legal.html`, from
`src/legal.ts`). It is static and uses the app's own design tokens, primitives and styles, so
its illustrations of PURSS are built from the real app CSS (`src/kit.ts`).

```sh
npx vite              # in apps/site: http://127.0.0.1:5181
npx vite build        # writes apps/site/dist
```

Every page's HTML and metadata is rendered at build time (and on each request in `vite dev`)
from `src/pages.ts`, so crawlers and link previews see the whole page without scripts; the
browser script only runs the views demo and the small-screen menu. Each page has its own title,
description, canonical link and link-preview tags; the home page also has structured data for
the plans. The build also writes `robots.txt`, `sitemap.xml` and a `404.html`.

## Launch settings

The addresses the site links to and names in its metadata are set at build time. Until they
are set, the build uses placeholders and warns about each one still on a `.example` address.

| Variable | Used for | Placeholder |
|---|---|---|
| `SITE_ORIGIN` | canonical links, link previews, sitemap | `https://purss.app` |
| `SITE_APP_URL` | Open dashboard and sign-up (`/signup`) links; a path is on `SITE_ORIGIN` | `/app` |
| `SITE_REPO_URL` | source, docs and install guide links, the clone command | `https://github.com/program-sam/purss` |

Set them in the environment or in `apps/site/.env` (ignored by Git), for example
`SITE_ORIGIN=https://example.org npx vite build`. The defaults live in `src/site.ts`.

In hosted mode the API serves `dist` at the root of the PURSS's address, next to the app at
`/app/`, and answers unknown paths with `404.html` (`apps/api/src/web-routes.ts`). Someone already
signed in who opens the root goes straight to the app; the Docker image
builds it with `SITE_ORIGIN` set to `PURSS_PUBLIC_ORIGIN`. Self-hosted installations have no website:
their root opens the app.

The site sets no cookies and loads no third-party scripts. Plans, prices and comparison
figures live in `src/kit.ts`. Store buttons for the browser extension and the phone app come from
`packages/domain/src/distribution.ts`, shared with the app's Settings; until a store listing exists
the apps section says they are coming to the stores and what works meanwhile (installing the
PURSS from the browser, bookmarklets), and the build and load-unpacked instructions are
developer links under the self-hosting commands. The mock screens are pictures: their contents
are `inert` and `aria-hidden`, so no button inside them is exposed. Competitor prices must be
checked against the pricing pages linked in the comparison footnote before publishing.

`node --test src/pages.test.ts` (part of `npm test`) renders every page and checks that no link
is dead, the pictures hide their controls, and the page order and the answers people looked for
are still there.
