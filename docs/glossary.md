# Glossary

The words PURSS uses, in the interface, the docs, the API, the database and the code. Each term has
one meaning. Visible text and prose use British English; code follows it, except for outside names and
platform APIs.

## People and places

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **PURSS** | The product | `purss` | |
| **Your PURSS** | Everything one person has gathered and arranged | scoped by `account_id` | workspace, tenant |
| **Account** | The sign-in, plan and ownership boundary around a PURSS | `account_id`, `accountId` | workspace, user |
| **Person** | A human using PURSS | | user, reader, owner |
| **Administrator** | A person who runs an installation | `admin` | operator |
| **Owner** | The owner of this project, in repository instructions only | | an account holder |
| **Installation** | One running deployment of PURSS | `installation` | "a PURSS", instance |
| **PURSS address** | The web address of an installation | `parsePurssAddress` | workspace address |

## What people read and follow

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **Item** | Any piece of content in a PURSS | `item` | story |
| **Article, video, paper, post, podcast, link** | The kinds of item | `kind` | any of these for items in general |
| **Entry** | A FreshRSS record, before it becomes an item | `entry` | an item; "incoming item" in the interface |
| **Source** | Something a person follows | `source` | subscription |
| **Feed** | The RSS, Atom or JSON address and stream a source is fetched from | `feed_url`, kind `feed` | Home, "your feed" |
| **Page list** | A source built from a web page that has no feed | `pageList` | feedless |
| **Recipe** | The rule for reading a page list | `PageListRecipe` | |
| **Backlog** | The older posts a source already had when it was followed from now, added as Ignored | `backlog` | back catalogue |

## Arranging and keeping

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **Home** | The dashboard | `home` | feed, dashboard |
| **Box** | One section of Home | `box` | list |
| **Collection** | What a person sees together: a **source collection** or a **filter collection** | `mode` `sources` or `filter` | a fetching process |
| **Basket** | A hand-gathered set of kept items | `basket` | folder |
| **Keep** | Preserve an item in a basket | `kept` | bookmark, save |
| **Kept links** | Links a person kept by hand, and the export of them | `keptLinks` | saved links |
| **List** | The compact view layout | `list` | a Home section, a source |
| **State filter** | The chips that narrow a list by state | `all`, `all_with_ignored`, `new`, a workflow state | bare "filter" |
| **Smart filter** | The AI filter on a source or collection | `ai_filters` | bare "filter" |

## Reading state

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **Workflow state** | Undecided, To read, In progress, Finished or Ignored | `undecided`, `toread`, `inprogress`, `finished`, `ignored` | |
| **New** | The marker on an item that has arrived and not been seen | `is_new`, `isNew` | fresh |
| **Seen** | Looked at, for items and notifications | `seen_at`, `markSeen` | read, unread |

## Stored copies and space

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **Kept version** | The version of an item a basket preserves | `version_id` | bare "copy" |
| **Readable copy** | A readable capture of an item's page | `fulltext` | full text, bare "copy" |
| **Offline copy** | What a device holds for reading offline | `offline` | bare "copy" |
| **Engine data** | What FreshRSS holds | | bare "copy" |
| **Storage allowance** | The limit on what an account stores | `allowance_bytes` | allocation, quota |
| **Storage used** | What counts against the storage allowance | `used_bytes` | |
| **Disk usage** | Physical space on the server | | storage used |
| **Plan limits** | All the limits on a plan | `PlanLimits`; an account's standing is `PlanUsage` | capacity |

A Smart filter also has a weekly allowance. Always say which allowance is meant.

## Finding sources

| Term | Meaning | In code | Avoid |
| --- | --- | --- | --- |
| **Discovery** | The feature for finding new sources | `discover`, `/api/suggestions` | |
| **Catalogue** | Discovery's list of popular sources | `catalogue` | translations, widget choices, bridge list |
| **Link lookup** | Resolving a pasted address into sources | `lookupLink`, `/api/link-lookup` | discover |
| **On this day** | Anniversary reminders over kept items | `onThisDayRouter` | rediscovery |

## Components

| Term | Meaning | Where |
| --- | --- | --- |
| **Web app** | The interface in a browser | `apps/web` |
| **Desktop app** | The web app in a native window | `apps/desktop` |
| **Mobile app** | The web app in the Android and iOS apps | `apps/mobile` |
| **Native shell** | The native wrapper around the web app in the desktop and mobile apps | `apps/desktop`, `apps/mobile` |
| **Browser extension** | Keeps and follows pages from the browser | `apps/extension` |
| **Public site** | The PURSS website; a **website** is someone else's | `apps/site` |
| **API** | The product server | `apps/api` |
| **Worker** | The background job runner; the browser's is always a **service worker** | `apps/worker` |
| **Engine** | FreshRSS, which **fetches** sources | `packages/freshrss`, `infra/engine` |
| **Connector** | A source adapter; an assistant has an **assistant connection** | `packages/connectors` |
| **Bridge** | RSS-Bridge | `apps/egress`, `infra/compose.yaml` |
| **Egress** | The controlled way out to the internet | `apps/egress` |
| **Push relay** | Delivers phone notifications | `apps/push-relay` |
| **Translations** | Every word people read, in **translation files** | `packages/translations` |

A **provider** is always named: a **sign-in provider**, an **AI provider** or a hosting provider.
