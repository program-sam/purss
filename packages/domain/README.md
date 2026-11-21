# Domain package

The contracts every part of PURSS shares, with no dependency on the UI, a database driver or FreshRSS: identifiers,
workflow states, the query tree, the API's request and response shapes, the job contract between the API and the worker,
storage accounting, plans, and the rules that must be the same on the server and in the apps. The only dependency is
`zod`, which validates what crosses a boundary. The API validates every request with these schemas, the worker validates
its jobs with them, and the web app and the extension import their types so both sides agree.

| Module | What it defines |
| --- | --- |
| `ids.ts` | `newId(prefix)`: sortable, URL-safe identifiers (10 characters of millisecond time and 16 random ones) with a prefix per kind; `isId` |
| `workflow.ts` | The workflow states (Undecided, To read, In progress, Finished, Ignored; the stored value `new` is shown as Undecided), their labels and the board's columns. Reading progress, the New marker, collection and basket membership and retention are separate fields, never states |
| `query.ts` | The typed query tree behind query collections and smart views: validated on the server and compiled to parameterised SQL, never stored or run as raw SQL or a regular expression; sorts and item kinds |
| `api.ts`, `features.ts` | The `/api` request and response shapes (items, sources, collections, baskets, search, the state-change command with its revision check) and those of the feature routes: sharing, export and import, reconciliation, administration |
| `jobs.ts` | The job contract between the API, the only database writer, and the worker: kinds, leases, sync batches with their checkpoints, results and failures |
| `storage.ts` | Logical storage accounting: an account's usage is the measured bytes of its stored objects, not physical disk usage, and each object kind is measured one defined way |
| `plans.ts` | The hosted plans and what each allows; self-hosted installations have no such limits |
| `annotations.ts`, `media.ts`, `downloads.ts`, `news.ts`, `ai-filters.ts`, `ai-limits.ts` | Highlights and notes with their limits; the audio or video file an item offers (never a page, playlist or platform's page); the rules for which downloads a device wants and its limit; an installation's own news; smart filters (the limits are in their own module so the web app ships no validation library) |
| `quiet-hours.ts` | `inQuietHours`, the one rule browser alerts and phone wakes both use |
| `initials.ts` | `initialsFor`, the letters on a source's avatar when it has no icon; the server and the website's pictures of the app both use it |
| `workspace-address.ts`, `distribution.ts`, `app-bundle.ts`, `version.ts`, `paths.ts` | What the apps and the extension share with the server: the PURSS address rule (HTTPS, except this device and the local network), where the official server, the stores and the downloads are, the live-update offer, the version number and where the web app lives (`/app`) |

Everything is exported from `@purss/domain`. The modules that browsers, the website or the packaging scripts import
without the rest are also separate entry points (`@purss/domain/workspace-address`, `/distribution`, `/app-bundle`,
`/paths`, `/plans`, `/initials`, `/version`).

Keep this package independent of the UI, database drivers and FreshRSS protocol details, and put an invariant here with
a focused test before it reaches storage. The tests sit next to the code (`*.test.ts`) and run with `npm test`. What the
domain's separate concepts mean for people is in [the user guide](../../docs/user-guide.md) and how retention and storage
are counted is in [storage and retention](../../docs/storage-and-retention.md).
