# Self-hosting

How to run and operate PURSS. It is a preliminary build: implemented end to end and
tested on one host, but **not hardened or security-reviewed for exposure to the public
internet** (see [Security notes](#security-notes)). [Architecture](architecture.md) explains the
parts named here.

## Requirements

- **Local run:** Node.js 26 or newer, and podman (rootless works). The pinned FreshRSS image
  is pulled on first start if it is missing.
- **Docker Compose:** Docker Engine with a recent Compose v2 (the proxy overlay uses
  `!reset`). The containers are limited to about 870 MiB of memory together (API 256 MiB,
  worker 192 MiB, egress 160 MiB, FreshRSS 256 MiB).
- **Disk:** keep more than 1 GiB free on the data volume. Below that reserve, PURSS
  pauses growth (see `PURSS_DISK_RESERVE_BYTES`).
- Outbound internet access for fetching feeds and pages.

## Running locally

```sh
npm install
npm run dev
```

`npm run dev` builds the web app, creates `data/secrets/service-token` and
`data/secrets/bridge-key` if needed, starts RSS-Bridge in podman (`node scripts/bridge.ts up`; on
127.0.0.1:8944, the image and settings Compose uses), the egress proxy and bridge router, starts
or resumes FreshRSS in podman (`node scripts/engine.ts up`), then the API and the worker. If
RSS-Bridge doesn't start, the stack runs without it and the bridged services say they have no
feeds. Their logs share the terminal, each line prefixed with the process name.
Ctrl+C stops everything and removes the FreshRSS and RSS-Bridge containers (FreshRSS's data stays in `data/engine`).

- `npm run dev -- --keep-engine` leaves FreshRSS and RSS-Bridge running on exit.
- `npm run dev -- --no-build` skips the web build.

Open `http://localhost:8940`. Use `localhost`, not `127.0.0.1`: the API only accepts changes
from the exact origin in `PURSS_PUBLIC_ORIGIN` (default `http://localhost:8940`), and passkeys
are tied to that host name.

All state lives in `data/` (ignored by Git): `product.db`, `secrets/`, `engine/` (FreshRSS),
`egress/` (gateway state and the bridge fetch log) and `backups/`. The server stores no audio or video files; a `media/` folder
that an earlier version filled is deleted when the API starts.

Local listeners, all on 127.0.0.1:

| Port | Service |
| --- | --- |
| 8940 | PURSS: web app, `/api`, public share pages |
| 8941 | FreshRSS (operator web UI and GReader API) |
| 8944 | RSS-Bridge (development only; reached by the bridge router) |
| 8945 | Bridge router (signed source addresses for FreshRSS and the API's previews) |
| 8946 | Egress proxy (FreshRSS's only way out) |
| 8947 | Private feed gateway |
| 8948 | API internal listener (worker jobs; service token) |
| 8949 | Egress control (service token) |

Engine commands (`status`, `down`, `reset-confirm`) are in
[infra/engine/README.md](../infra/engine/README.md).

## Docker Compose

[infra/compose.yaml](../infra/compose.yaml) builds two images, the product image (API, worker,
egress and two one-shot setup steps) and a thin FreshRSS image, pulls a pinned RSS-Bridge image,
and runs:

| Service | Role | Networks |
| --- | --- | --- |
| `init` | Creates secrets and FreshRSS's install-time settings, then exits | none |
| `egress` | Egress proxy, feed gateway, bridge router, control listener; on the bridge network also the proxy and a DNS resolver for RSS-Bridge | internal, bridge-net, outside |
| `bridge` | RSS-Bridge, pinned by digest, with only the bridges PURSS uses; its only way out is egress | bridge-net only |
| `engine` | FreshRSS with the fixed admin helper | internal only |
| `engine-setup` | Checks the proxy setting and operator sign-in once FreshRSS is healthy, then exits | internal |
| `api` | Web app and API | internal, outside (plus the proxy network in proxy mode) |
| `worker` | Background jobs | internal, outside |

Volumes: `data` (product database, gateway state, bridge fetch log, backups), `secrets` (service
token, bridge key, engine operator credentials, engine-user passwords, private source links, the setup code) and
`engine-data` (FreshRSS). FreshRSS can read only the service token and its operator secret.

Settings go in a `.env` file at the repository root (ignored by Git). Compose reads only the
variables `compose.yaml` refers to:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PURSS_PUBLIC_ORIGIN` | `http://localhost:8940` | The exact address people open (scheme, host, port) |
| `PURSS_HOST_PORT` | `8940` | Host port in localhost mode; change `PURSS_PUBLIC_ORIGIN` to match |
| `PURSS_BIND_ADDRESS` | `127.0.0.1` | Host address the port is published on; a LAN address opens it to the home network |
| `PURSS_PROXY_NETWORK` | `nginx_default` | Proxy mode: the reverse proxy's Docker network |
| `PURSS_MODE` | `self` | `hosted` adds plans, optional storage allocations and optional open sign-up |
| `PURSS_SIGNUP` | `invite` | `open` (hosted mode only, needs outgoing email): anyone can create an account |
| `PURSS_SIGNUP_DAILY_LIMIT` | `50` | Most open sign-ups accepted per day |
| `PURSS_DEFAULT_ALLOCATION_BYTES` | empty | Hosted mode's allocation for new accounts; empty means no limit |
| `PURSS_SMTP_HOST` … `PURSS_MAIL_FROM` | empty | Optional outgoing email; see [Outgoing email](#outgoing-email) |
| `PURSS_ASSISTANT_OAUTH` | empty | Assistants signing in with OAuth: on in hosted mode; `on` opts in when self-hosted (needs https) |
| `PURSS_PUSH_RELAY_URL` | unset | Phone notifications go through the project's relay; set it empty (`PURSS_PUSH_RELAY_URL=`) or `off` to turn them off |
| `PURSS_APP_ANDROID_CERT_SHA256`, `PURSS_APP_ANDROID_PACKAGE`, `PURSS_APP_IOS_APP_ID` | empty | The phone apps this PURSS vouches for, so they can use its passkeys; see [Configuration](#configuration) |
| `PURSS_DISK_RESERVE_BYTES` | empty | Free disk kept in reserve; empty means 1 GiB |
| `PURSS_OIDC` | empty | Sign-in with other providers; see [Configuration](#configuration) |
| `PURSS_SYNC_INTERVAL` | empty | Seconds between scheduled syncs per account; empty means 120 |
| `PURSS_JEV_URL`, `PURSS_JEV_MODEL` | empty | Jev's address and model for Smart filters; empty means TypeSafe's and the newest Jev |

Other variables from the [configuration list](#configuration) are not passed to the
containers by `compose.yaml`. To set them, add an `environment:` entry for the
`api` service (and `worker` where relevant) in a Compose file of your own, passed with another
`-f`.

### Localhost mode

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

PURSS listens on `127.0.0.1:8940` of the host only. Reach it from another machine
through an SSH tunnel (`ssh -L 8940:127.0.0.1:8940 <host>`) and open `http://localhost:8940`, so
passkeys work.

### On a home network over plain HTTP

To let everyone in the house open it at the server's LAN address, set in `.env`:

```sh
PURSS_BIND_ADDRESS=192.168.1.20
PURSS_PUBLIC_ORIGIN=http://192.168.1.20:8940
```

Browsers refuse passkeys on plain HTTP outside `localhost`, so on such an address the app
doesn't offer fingerprint, face or screen lock: everyone signs in with their **username and
password**, chosen during setup or when they accept an invitation. Anyone on the network can see traffic to a
plain-HTTP address; keep it to a network you trust, or put it behind HTTPS (below) to use
passkeys. Browsers also install the app and keep offline copies only over HTTPS or at
`localhost`, so on a plain-HTTP LAN address those features are unavailable. The Android and iOS
apps and the browser extension connect to a plain-HTTP address only on the local network (private,
CGNAT and link-local ranges, and `.local`, `.lan`, `.internal` and `.home.arpa` names), and say
that it isn't encrypted; anywhere else they need HTTPS.

### Behind an HTTPS reverse proxy

```sh
# .env
PURSS_PUBLIC_ORIGIN=https://purss.example.com
PURSS_PROXY_NETWORK=<your proxy's Docker network>

docker compose --env-file .env -f infra/compose.yaml -f infra/compose.proxy.yaml up -d --build
```

[compose.proxy.yaml](../infra/compose.proxy.yaml) removes the host port, joins the API to the
proxy's (external) network under the alias `purss-workspace`, requires `PURSS_PUBLIC_ORIGIN`, and
sets `PURSS_TRUST_PROXY=1`. Point the proxy at `http://purss-workspace:8940`. The proxy should:

- serve HTTPS at exactly `PURSS_PUBLIC_ORIGIN` and pass the `Host` and `Origin` headers through;
- append the client's address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;`, which Nginx Proxy Manager and Caddy do by default). Only the right-most hop is
  used, for sign-in rate limits, and only from private addresses; `X-Real-IP` is ignored, since a proxy
  that doesn't set it passes on whatever the client sent;
- not buffer `/api/events` (a server-sent event stream; the API sends `X-Accel-Buffering: no`);
- pass `/mcp` and its `Authorization` header through unchanged, if assistant access is used, and
  with assistant OAuth on also `/.well-known/oauth-protected-resource…`,
  `/.well-known/oauth-authorization-server` and `/oauth/…`;
- pass `Authorization` headers and `OPTIONS` requests on `/api` through unchanged, and add no CORS
  headers of its own: the phone app and browser extension use them (there is nothing to configure);
- allow request bodies large enough for imports (the import endpoint accepts up to 128 MiB) and for
  pages kept with their text from the browser extension (up to 8 MiB);
- add HSTS if you want it; the API doesn't;
- leave `/sw.js` and `/manifest.webmanifest` uncached (the API sends `Cache-Control: no-cache`), so
  a new version reaches installed apps promptly. Installing the app and offline reading need this
  HTTPS address.

### Reading the setup code

```sh
docker compose -f infra/compose.yaml exec api cat /data/secrets/setup-code
```

Locally it is `data/secrets/setup-code`. The API also logs where to find it at start-up while
the installation is unclaimed.

### Logs

```sh
docker compose -f infra/compose.yaml logs -f api worker egress engine
docker compose -f infra/compose.yaml logs init engine-setup     # one-shot setup steps
```

Worker and egress write JSON lines with credentials, query strings and token-like path parts
redacted. FreshRSS's access log is off. The API logs plain lines.

## The first administrator

On start, an API with no accounts writes a one-time **setup code** to `secrets/setup-code`
(mode 0600) and stores only its hash. Whoever enters it at `/app/setup` becomes the owner and the
administrator. The setup page asks for the code and for a **username and password** (typed twice),
and then, where the browser supports it, offers fingerprint, face or screen lock (a passkey), which
can be skipped and added later in *Settings → Security*. The code works once; the
file is removed the next time the API starts. There is no first-visitor-wins page and no other
way to become administrator: invitations never grant administration.

## Forgotten passwords

Every account has a username and a password, and a password can be changed (*Settings → Security*)
or reset but never removed. Someone who has forgotten theirs gets back in in one of two ways:

- **By email**, where the installation has [outgoing email](#outgoing-email) and the account has a
  confirmed address: **Can't sign in?** on the sign-in page leads to a page that emails a link to
  that address. The link works once, for an hour.
- **With a link from the operator**, for a server without email, an account without a confirmed
  address, and administrators (who don't reset by email). On the server:

  ```sh
  docker compose -f infra/compose.yaml exec api node apps/api/src/cli.ts password-reset-link "Alex"
  ```

  (Locally: `node apps/api/src/cli.ts password-reset-link "Alex"`, with `PURSS_DATA_DIR` set if the
  data isn't in `./data`.) The account is an id (`acc_…`) or a unique display name. The command needs only the data
  directory, like the other [operator commands](#operator-cli). It
  prints a single-use link such as `https://purss.example/app/reset-password?token=…`, which is
  shown once and valid for 60 minutes. Give it only to the person it is for, by a channel you
  trust. Opening the link shows the ordinary **Choose a new password** page: they keep their
  username and choose a new password, then sign in with it. Choosing it signs the account out
  everywhere: browser sessions, connected apps and assistant tokens. It works whether or not
  email is set up, and is recorded in the audit log as a host-level action. It refuses an account
  that has no password or whose removal has already started.

When the sign-in page can't offer the email reset, it tells the person to ask the server's
administrator for a password reset link.

## Self and hosted mode

`PURSS_MODE` selects what an installation offers on top of accounts. Every installation can have
several accounts, for example one per member of a household: an administrator invites people,
and each account has its own PURSS and FreshRSS user, isolated from the others.

| | `self` (default) | `hosted` |
| --- | --- | --- |
| Accounts | The owner plus people an administrator invites | The same, plus optional open sign-up |
| Plans | None: no source or collection limits | Free (100 sources, 4 collections) for new accounts, Plus (1,000 sources) or Unlimited, set per account by an administrator; administrators are Unlimited |
| Space allocation | None, unless set with the CLI | None, unless set by `PURSS_DEFAULT_ALLOCATION_BYTES`, per invitation or per account; a safeguard users don't see |
| Sharing baskets and collections | Available, with a report link and takedowns | Plus only, with a report link and takedowns |
| Discovery | None: nothing is compared or kept | Source suggestions from what accounts that share follow together ([plan/35](../plan/35-discover.md)); the graph is rebuilt every 6 hours in the API process |
| Administration | Health, jobs, audit log, usage check, accounts (suspend, admin role), invitations, assistant access, reports about shared pages and news | Also plans and allocations |

**Administration → News** is where administrators write posts for everyone on the installation.
A draft stays there; publishing (which asks to confirm it's you) puts the post on the public
page `/news`, in the Atom feed `/news/feed.atom`, and into every PURSS's *PURSS
news* source, which each PURSS gets with the first published post. Nothing is fetched for
this: the API writes the posts into each PURSS itself, so it works behind any firewall. Editing
a published post updates every copy (a kept copy keeps its version); deleting one removes the
copies nobody kept. Each post shows how many PURSSes it reached and how many opened, kept,
ignored or deleted it, as counts only.

**Administration → Health** shows the engine, jobs, disk, database, followed sources, egress and, when it is
set up, outgoing email. Two more sections show how well following works:

- **Bridged sources** appears when this server runs the bridge for services that publish no feed
  ([plan/41](../plan/41-source-bridges.md)). For each service it shows the last 7 days: attempts, how
  many worked, came back empty or failed, answers repeated from the bridge's cache, and the success
  rate (an empty feed counts as a success). Below that it lists the sources failing now: what failed,
  since when and when each last worked. The numbers come from the egress service's log of bridge
  requests, which keeps 30 days and is not tied to any account; if egress doesn't answer, the section
  says so. A server without the bridge says that instead.
- **Sites people couldn't follow** lists the sites most often pasted without success over the last 30
  days, with the reason (no feed found, can't be followed, couldn't be reached, took too long). Only the
  site is counted (`bandcamp.com`, never the page, a creator's subdomain or who looked), kept 180 days.

An administrator creates invitations under **Administration → Invitations** (confirming with
fingerprint, face or screen lock or a password) or with the CLI, and can list and
revoke open ones there. An
invitation is a code, valid 1 to 60 days (14 by default), delivered as a link
`/app/invite?code=…`; it can be used once and never grants administration. Under **Accounts** an
administrator can suspend an account or grant and remove the administrator role; nobody can
remove their own role or the last administrator.

People delete their own accounts in *Settings → Account*, on every installation. A deletion has
a 7-day grace period in which signing in can keep the account; **Accounts** shows it as
*Deleting on* its date and refuses changes to it. The last active administrator can't delete
their own account until someone else is an administrator. After the grace period the API
removes the account's data and files and the worker removes its FreshRSS user. If that user is
found missing after a removal attempt that wasn't confirmed, the account shows *Confirm engine
removal…*: check that the user's folder under the engine's `data/users/` is gone, then confirm
to finish the deletion. Administrators can't delete other people's accounts. Backups made before
a deletion still contain the account.

Open sign-up exists only in hosted mode and is off by default. `PURSS_SIGNUP=open` adds *create
an account* to the sign-in page; attempts are limited to 30 per address an hour, successful
account creations to 10 per address an hour, and the installation-wide daily cap is
`PURSS_SIGNUP_DAILY_LIMIT` (50 a day by default). When every blocking limit has a known release,
refusals include the latest release time. It also needs
[outgoing email](#outgoing-email): every new account gives an address, confirmed by a link, that
can receive a password-reset link. Without a mail server, or while the mail server check fails,
sign-up stays closed and the API says so in its log at start. Payments, abuse and verification
tooling and a public launch are *not built*.

## Outgoing email

Optional. Without it everything works as before. With it set, the API can send a few account
messages through a mail server you name:

- **Invitations:** an administrator can type an address when making an invitation, and the link
  is sent there (the address isn't stored).
- **Account addresses:** each account can add an email address in *Settings → Security* (hosted
  open sign-up asks for one), confirmed by a link; a forgotten password can be reset with a link
  sent to a confirmed address (**Can't sign in?** on the sign-in page). Resetting signs the account out everywhere,
  revokes its assistant tokens and tells the address. Administrators don't get reset links by email: the operator
  makes one with `password-reset-link` ([forgotten passwords](#forgotten-passwords)). A confirmed address can be typed in place of the
  username when signing in with a password (with the same limits and the same error for every
  name that isn't known; an address that several accounts share signs in none of them); it is never
  used to link accounts or grant anything.
- **Reminders:** a person can ask for the days they set with *Remind me* to be emailed too
  (*Settings → Notifications and New*, off by default); it needs a confirmed address.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PURSS_SMTP_HOST` | empty | Mail server host name; empty turns outgoing email off |
| `PURSS_SMTP_PORT` | `587` (`465` with `tls`) | Mail server port |
| `PURSS_SMTP_SECURITY` | `starttls` | `starttls`: upgrade the connection and refuse to send without TLS; `tls`: TLS from the start (port 465); `none`: no encryption, only for a relay on the same host or a private network |
| `PURSS_SMTP_USER`, `PURSS_SMTP_PASSWORD` | empty | Login, if the server needs one |
| `PURSS_MAIL_FROM` | (required with a host) | Sender, for example `PURSS <purss@example.com>`; the server must allow it |

The API checks the server (connect and log in) when it starts and every 10 minutes while that
fails; *Administration → Health* shows the result and how many messages were sent or refused in
the last day. Check it by hand with `node apps/api/src/cli.ts test-email you@example.com`. Each
message is recorded in the database with its kind, a masked recipient (`a•••@example.com`), the
outcome and an error code, never its text or links, and the records are deleted after 90 days.
Links in messages are single-use: a confirmation works for 48 hours, a reset link for one hour.

## Smart filters

A source or collection can have a Smart filter (plan/36) that marks the posts its owner doesn't want
as Ignored. Filters are off until someone adds one, and they ask
[Jev](https://docs.typesafe.ai), TypeSafe AI's decision model, about each new post: its title,
summary, author and source name are sent to Jev's address (TypeSafe's by default, or
OpenRouter's; see below). Jev is not open source and
can't run on your own server.

- **Key.** Filters use one Jev key for the whole server, which only an administrator adds, in
  *Admin → Smart filters*. People never enter a key of their own. It is stored in
  `<data>/secrets/jev-server-key` (mode 0600), read by the API (to try a filter) and the worker
  (to run it), and shown again only by its last four characters.
- **Self-hosted:** once an administrator has added the server key, every account on the server
  can use it. Nothing else to set up.
- **Hosted:** the server key is used by accounts on the **Pro** plan (25 million Jev input tokens
  a week each, Monday to Sunday UTC; people never see this number); administrators set plans in
  *Admin → Accounts*, and administrators always have it. When the week's allowance is used up,
  that account's filters wait until the next week and new posts arrive unfiltered. There is no payment handling yet.

Each judged post costs about 200 to 500 input tokens (output is free), so a week's allowance is
roughly 50,000 posts. Jev is reached at TypeSafe (`https://api.typesafe.ai`) by default; to use
an OpenRouter key instead, set `PURSS_JEV_URL=https://openrouter.ai/api`. Keys must come from the
provider set here, and the key field in Admin says which one. The model is the newest Jev
(`jev-latest`, or `~typesafe/jev-latest` on OpenRouter); pin one with `PURSS_JEV_MODEL` (for
example `jev-1.13.0`, or `typesafe/jev-1.13` on OpenRouter) if a new release judges worse. The
address is always the operator's, never a person's. When Jev refuses the
key, the Admin page says so, and filters stop using it until it is replaced.

## Operator CLI

For the operator, including when the web app can't be used. It works on the database file directly and needs
only the data directory; every change is written to the audit log as a host-level action.

```sh
node apps/api/src/cli.ts status
node apps/api/src/cli.ts create-invite [--note "text"] [--allocation <bytes>] [--days <n>]
node apps/api/src/cli.ts set-allocation <account> <bytes|none>
node apps/api/src/cli.ts set-plan <account> <free|plus|unlimited>
node apps/api/src/cli.ts password-reset-link <account>
node apps/api/src/cli.ts reconcile-usage
node apps/api/src/cli.ts test-email <address>
```

`<account>` is an account id (`acc_…`) or a unique display name.

- `status`: data directory, mode, database and log size, migrations, counts of accounts
  (administrators, suspended, being deleted), sources, items, kept items, jobs and open review
  entries, and the outgoing email server if any.
- `create-invite`: prints a code once. `--allocation` only takes effect in hosted mode; the CLI
  warns when it is given elsewhere.
- `set-allocation`: changes an account's allocation; over the new limit, growth pauses and
  nothing is deleted. Refused for an account that is being deleted.
- `set-plan` (hosted only): changes an account's plan. Over the new plan's limits nothing is
  removed; new follows and collections wait until the account is under them.
- `password-reset-link`: prints a single-use link, shown once and valid for 60 minutes, to
  `<public origin>/app/reset-password?token=…`, the ordinary *Choose a new password* page. Using it
  sets a new password for the account's existing username, signs the account out everywhere,
  revokes its assistant tokens and OAuth grants, disconnects its connected apps and ends connections
  still waiting for their code. Use it for someone who forgot their password on a server without
  email, and for administrators ([forgotten passwords](#forgotten-passwords)). It is refused for an
  account that has no password. During an account's deletion grace period the new password lets
  its owner sign in and keep the account; once removal has started it is refused.
- `reconcile-usage`: compares each account's storage ledger with its stored objects and reports
  differences without changing them; exits 1 if any differ. It also recounts the used-bytes
  total the quota check reads (and the flags the storage summary reads) and corrects them if
  they have drifted.
- `test-email`: checks the mail server and sends a test message to the address, with the
  server's error code if it fails. Needs the same `PURSS_SMTP_*` and `PURSS_MAIL_FROM` settings as
  the API (under Compose, `exec api` has them).

Locally run it from the repository; set `PURSS_DATA_DIR` if the data isn't in `./data`. Under
Compose: `docker compose -f infra/compose.yaml exec api node apps/api/src/cli.ts status`. The
CLI reads `PURSS_MODE` from its own environment, so the allocation warning only reflects the
running service when both see the same value. Opening the database applies any pending
migrations.

## Backups and restore

```sh
node scripts/backup.ts [--data-dir <dir>] [--out <dir>] [--include-secrets]
```

The backup uses SQLite's online backup API, so the app can keep running. It writes
`<out>/<timestamp>/product.db` and `manifest.json` (counts, migrations, sizes and SHA-256 of every
file), checks integrity, and refuses to start without room for a full copy. `--out` defaults
to `<data>/backups`. Never copy `product.db` by hand while the app runs.

- `--include-secrets` adds the secrets directory (service token, bridge key, private source links, and the
  server's Jev key for Smart filters). Such a backup must be protected like a
  password, and a restore puts the keys back. Without it, private sources need reconnecting and
  the Jev key adding again after a restore. Data exports from the app never contain keys.
- FreshRSS's data is **not** included. Back it up separately (`data/engine` locally, the
  `engine-data` volume under Compose) while the engine is stopped.
- For a full recovery keep all three together: the product database, the secrets directory
  (it holds each account's engine password in `engine-users/`) and FreshRSS's data. Restoring
  only the database brings back your product data, but nothing rebuilds the engine users,
  their passwords or their subscriptions automatically, so collection stops until that is
  done by hand. Restoring the same FreshRSS data keeps its identity. If FreshRSS is replaced by
  an installation with a different identity while PURSS already has items from the old
  one, incoming entries wait in the **Review** queue.

Under Compose the backup lands inside the `data` volume; copy it out:

```sh
docker compose -f infra/compose.yaml exec api node scripts/backup.ts
docker compose -f infra/compose.yaml cp api:/data/backups ./backups
```

Restore into an empty data directory, with the API and worker stopped:

```sh
node scripts/restore.ts <backup-dir> --data-dir <target> [--force] [--skip-secrets]
```

The restore accepts only the file names a backup holds (the database and `secrets/…`, each inside the
backup and the target folder; the saved media files that a backup made by an earlier version lists are
not restored), verifies every checksum, refuses backups
that contain migrations this version
doesn't know, checks integrity and foreign keys, applies newer migrations, rebuilds the search
index, and reports any storage-ledger differences
(`reconcile-usage`). A non-empty target is refused unless `--force`, which moves the existing
database (and secrets, when the backup includes them) aside with a
`.replaced-<timestamp>` suffix instead of deleting them. On failure
everything is rolled back.

Restoring inside the Compose `data` volume has not been exercised. Note that `/data/secrets` is
a separate mounted volume there, which `--force` can't move aside; use `--skip-secrets` and keep
the existing secrets volume.

## Upgrades

Update the repository, take a backup, and rebuild:

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build   # add -f infra/compose.proxy.yaml in proxy mode
```

The image takes its version ([plan/40](../plan/40-versions.md)) from your clone's history, so it changes with
every update you pull; Settings shows it at the bottom. A copy downloaded without history has none.

Locally, restart `npm run dev`. Database migrations apply automatically when the API opens
the database; there are no down migrations, so go back to an older version only by restoring a
backup made with it. FreshRSS is pinned by digest and changes only when the repository changes
the pin. `init` never overwrites existing secrets. Browsers that have the app open pick up the new
build in the background and show **A new version is ready**; people press *Reload* to switch.
The phone apps connected to your server take its new interface too: the image packs it for them, they
download it and switch the next time they're opened (after asking once whether your server may update
them). A build made for a newer version of the app's native code waits until the app itself is updated
from the store. See [plan/39](../plan/39-live-updates.md).

## Configuration

Variables read by the code, with defaults. Paths default relative to the repository.

**API** (`apps/api/src/config.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PURSS_DATA_DIR` | `<repo>/data` (`/data` in the image) | Data directory; secrets in `<data>/secrets` |
| `PURSS_DB_FILE` | `<data>/product.db` | Product database |
| `PURSS_HOST`, `PURSS_PORT` | `127.0.0.1`, `8940` | Public listener |
| `PURSS_PUBLIC_ORIGIN` | `http://localhost:<PURSS_PORT>` | Exact public origin: request origin checks, passkey host, `Secure` cookies when https, share and OIDC callback links |
| `PURSS_INTERNAL_HOST`, `PURSS_INTERNAL_PORT` | `127.0.0.1`, `8948` | Internal job listener (service token) |
| `PURSS_MODE` | `self` | `hosted` adds plans, optional storage allocations and optional open sign-up, and links public share and follow pages to the website |
| `PURSS_SIGNUP` | `invite` | `open` (hosted mode only, with working outgoing email): anyone can create an account; attempts are limited to 30/hour/address and successful creations to 10/hour/address |
| `PURSS_SIGNUP_DAILY_LIMIT` | `50` | Most open sign-ups accepted per day installation-wide |
| `PURSS_SMTP_HOST`, `PURSS_SMTP_PORT`, `PURSS_SMTP_SECURITY`, `PURSS_SMTP_USER`, `PURSS_SMTP_PASSWORD`, `PURSS_MAIL_FROM` | off | Optional outgoing email; see [Outgoing email](#outgoing-email) |
| `PURSS_ASSISTANT_OAUTH` | on in hosted mode, otherwise off | `on`: assistants that only connect by signing in (Claude and ChatGPT custom connectors) can use `/mcp` with OAuth as well as with tokens. Needs an https `PURSS_PUBLIC_ORIGIN` (or localhost) reachable from the internet; nothing else to set up. `off` turns it off in hosted mode |
| `PURSS_PUSH_RELAY_URL` | the project's relay | Where the API asks for connected phones to be woken (plan/37). Unset or `official`: the project's relay; empty or `off`: no phone notifications; or the https address of another relay that holds your own app build's push credentials. Nothing to set up for the official apps |
| `PURSS_APP_ANDROID_CERT_SHA256` | empty | SHA-256 fingerprints (`AB:CD:…`, comma-separated) of the keys that sign the Android app you hand out. PURSS then serves `/.well-known/assetlinks.json` for it, and the app can sign in and confirm it's you with the phone's passkeys (the same passkeys as in a browser on this address). Get one with `keytool -list -v -keystore release.jks` (or from Play Console → App signing). Needs https |
| `PURSS_APP_ANDROID_PACKAGE` | `app.purss` | The Android app's package name, if you build it under another one |
| `PURSS_APP_IOS_APP_ID` | empty | `TEAMID.bundle.id` of the iOS app (comma-separated): serves `/.well-known/apple-app-site-association`. iOS also needs this PURSS's domain in the app's own build (see Passkeys in apps/mobile/README.md) |
| `PURSS_DEFAULT_ALLOCATION_BYTES` | none | Allocation for new hosted accounts; empty means no limit; not used in self mode |
| `PURSS_DISK_RESERVE_BYTES` | 1 GiB | Free disk below which growth pauses |
| `PURSS_OIDC` | none | JSON array of `{id, label, issuer, clientId, clientSecret?}`; callback `<origin>/api/auth/oidc/<id>/callback` |
| `PURSS_ENGINE_URL` | `http://127.0.0.1:8941` | FreshRSS address handed to the worker |
| `PURSS_EGRESS_CONTROL_URL` | `http://127.0.0.1:8949/status` | Egress status for admin health |
| `PURSS_BRIDGE_URL` | none | The bridge router (`http://127.0.0.1:8945` in development). Unset, the bridged services (Telegram, Bandcamp and the rest of [plan/41](../plan/41-source-bridges.md)) get the "no feeds" answer |
| `PURSS_SYNC_INTERVAL` | `120` | Seconds between scheduled syncs per account |
| `PURSS_JEV_URL`, `PURSS_JEV_MODEL` | `https://api.typesafe.ai`, the newest Jev | Jev's address (`https://openrouter.ai/api` for OpenRouter keys) and the model Smart filters use (API and worker) |
| `PURSS_TRUST_PROXY` | off | `1`: take the client address from the right-most `X-Forwarded-For` hop when the peer is private |
| `PURSS_WEB_DIST` | `apps/web/dist` | Built web app, served at `/app/` |
| `PURSS_SITE_DIST` | `apps/site/dist` | Built public website, served at `/` in hosted mode (signed in, `/` opens the app); self-hosted, `/` opens the app |

**Worker** (`apps/worker/src/config.ts`; details in the [worker README](../apps/worker/README.md)):
`PURSS_INTERNAL_URL` (`http://127.0.0.1:8948`), `PURSS_DATA_DIR`, `PURSS_ENGINE_EXEC`
(`podman exec --user www-data purss-freshrss`), `PURSS_ENGINE_ADMIN_URL` (engine admin helper,
used instead of `PURSS_ENGINE_EXEC` under Compose), `PURSS_WORKER_CONCURRENCY` (4),
`PURSS_WORKER_POLL_MS` (2000), `PURSS_WORKER_MAX_BACKOFF_MS` (60000), `PURSS_WORKER_DRAIN_MS`
(25000), `PURSS_WORKER_REQUEST_TIMEOUT_MS` (30000), `PURSS_SYNC_PAGE_SIZE` (200, max 500),
`PURSS_SYNC_OVERLAP_SECONDS` (3600), `PURSS_SYNC_MAX_BATCH_BYTES` (700000), `PURSS_BRIDGE_ENGINE_URL`
(`http://feed-bridge.internal:8945`, where FreshRSS reaches the bridge router through the proxy).

**Egress** (`apps/egress/src/config.ts`; table in the [egress README](../apps/egress/README.md)):
`EGRESS_PROXY_HOST`/`_PORT` (`127.0.0.1`/8946), `EGRESS_GATEWAY_HOST`/`_PORT` (8947),
`EGRESS_CONTROL_HOST`/`_PORT` (8949), `EGRESS_GATEWAY_ALIAS`, `EGRESS_INTERNAL_DESTINATIONS`,
`EGRESS_GATEWAY_DB`, `EGRESS_SERVICE_TOKEN_FILE`, `EGRESS_MAX_CONNECTIONS` (256),
`EGRESS_CONNECT_TIMEOUT_MS` (10 s), `EGRESS_IDLE_TIMEOUT_MS` (30 s), `EGRESS_REQUEST_TIMEOUT_MS`
(60 s), `EGRESS_MAX_RESPONSE_BYTES` (32 MiB), `EGRESS_MAX_REQUEST_BODY_BYTES` (1 MiB),
`EGRESS_MAX_TUNNEL_BYTES` (64 MiB), `EGRESS_MAX_TUNNEL_MS` (120 s); the bridge router runs only
when `EGRESS_BRIDGE_BACKEND` (RSS-Bridge's `http://ip:port`) is set, with `EGRESS_BRIDGE_HOST`/`_PORT`
(`127.0.0.1`/8945), `EGRESS_BRIDGE_ALIAS` (`feed-bridge.internal`), `EGRESS_BRIDGE_KEY_FILE`
(`<data>/secrets/bridge-key`), `EGRESS_BRIDGE_DB` (`<data>/egress/bridge.db`), and
`EGRESS_BRIDGE_NET_HOST`/`EGRESS_BRIDGE_DNS_PORT` (egress's address on RSS-Bridge's network, where
the proxy and a DNS resolver also listen; port 53). Listeners accept only
loopback or private addresses. Egress resolves a relative `PURSS_DATA_DIR` (default `data`)
against its working directory.

**Local engine** (`scripts/engine.ts`): `PURSS_ENGINE_CONTAINER` (`purss-freshrss`),
`PURSS_ENGINE_PORT` (8941), `PURSS_EGRESS_PROXY` (`http://host.containers.internal:8946`),
`PURSS_ENGINE_CRON_MIN` (`3,18,33,48`).

**Local bridge** (`scripts/bridge.ts`): `PURSS_BRIDGE_CONTAINER` (`purss-rss-bridge`),
`PURSS_BRIDGE_BACKEND_PORT` (8944). Unlike under Compose, the development RSS-Bridge isn't cut off
from the network: its requests go through the egress proxy, but its name lookups use the host's.

**Web dev server** (`apps/web/vite.config.ts`): `PURSS_API_URL` (`http://127.0.0.1:8940`),
`PURSS_WEB_PORT` (5173).

Set internally and not meant for operators: `PURSS_ENGINE_PROXY` and `PURSS_ENGINE_DATA_DIR`
(Compose setup steps), `PURSS_ENGINE_ADMIN_PASSWORD` and `PURSS_ENGINE_ADMIN_API_PASSWORD`
(handed to FreshRSS's first-run install).

## Security notes

- **Not reviewed for public exposure.** Run it on localhost, over an SSH tunnel, or behind an
  HTTPS proxy you control, and treat internet exposure as untested.
- **HTTPS:** use it for anything but localhost or a trusted home network. Passkeys need it, and
  session cookies get the `Secure` flag only when `PURSS_PUBLIC_ORIGIN` is https.
- **Offline copies:** with "Offline reading on this device" on, a browser keeps the person's reading
  list in its own Cache Storage, per account. It is off by default in an ordinary tab and on in an
  installed app, and it is deleted at sign-out, when the session ends, or when the setting is turned off.
  The server stores nothing for it. A shared computer's browser profile should keep the setting off.
- **Assistant access (MCP):** off until an administrator turns it on under *Administration →
  Assistants* and a person turns it on for themselves. `/mcp` accepts only personal access tokens
  (stored as SHA-256 hashes; cookies are ignored there), acts as that one account, never as an
  administrator, and offers no permanent deletion, sharing, export or account-security actions.
  Calls are limited to 120 a minute per token; write calls are in the audit log. What an
  assistant reads leaves the server for the assistant's provider. See
  [plan/23](../plan/23-assistant-access.md).
- **Phone notifications:** when a connected phone app turns on *Notifications on this phone*, it
  registers a handle from the project's push relay with this server. When something new reaches the
  bell (outside quiet hours, and unless notifications are off), the API asks the relay, by that handle
  only, to wake the phone: a POST through the same safe fetcher (https, public addresses only, no
  redirects, 10 seconds). The relay, Google and Apple learn that this server has something new for that
  phone, never what; the phone then fetches the texts from this server. Nothing is sent while no phone
  has registered. `PURSS_PUSH_RELAY_URL=` (empty) or `off` turns it off. See
  [plan/37](../plan/37-push-notifications.md).
- **Assistant OAuth:** off when self-hosted unless `PURSS_ASSISTANT_OAUTH=on`; personal access tokens
  work either way. When on, the same two switches apply, a person allows each assistant on a
  consent page (recent sign-in, can't be framed), and *Settings → Assistants* lists and disconnects
  them. The API then fetches an assistant's public client metadata document (its `client_id` URL)
  through the same safe fetcher as source discovery: https only, public addresses only, no
  redirects, 5 kB, 5 seconds. Access tokens last an hour; refresh tokens rotate, and an earlier one
  presented again ends that assistant's access (it is recognised with `secrets/oauth-refresh-key`;
  restored without that key, assistants connected before must connect again). Refreshes are limited to 30 an hour per assistant and 120 per
  account. Changing `PURSS_PUBLIC_ORIGIN` ends every OAuth connection. See
  [plan/33](../plan/33-assistant-oauth.md).
- **Connected apps:** the phone app and browser extension connect with a one-time code and PKCE
  approved in the browser, then use a device token (stored as a SHA-256 hash) instead of cookies.
  Return addresses are fixed in code, so no client registration or OAuth setup is needed. A token
  is never an administrator, can't change sign-in or security settings, stops after 90 days unused,
  and is revoked from *Settings → Connected apps*, by suspension, by a password reset (by email, or with a link
  from `password-reset-link`).
  The browser extension's text captures are what the person's browser showed; the server sanitizes
  them and fetches nothing for them ([plan/32](../plan/32-browser-extension.md)).
  CORS is answered only for the apps' own origins and only for token requests, never with
  credentials. See [plan/24](../plan/24-connected-apps.md).
- **Passwords:** stored only as salted scrypt hashes. Sign-in attempts are limited per address
  and per username, and an unknown username takes as long to refuse as a wrong password.
- **Egress:** FreshRSS fetches every feed through the egress proxy, which refuses loopback,
  private, link-local, metadata and other internal destinations on every request and redirect,
  and pins each connection to the address it checked. Discovery (in the API) and readable-text
  capture (in the worker) fetch directly with the same address rules. No setting turns these rules off.
- **Media:** the server stores and serves no audio or video files. The page's CSP allows
  `media-src https:`, so playing an episode streams it from the publisher, who sees the listener's
  address; the mobile apps' downloads also come straight from the publisher, only over `https`.
- **FreshRSS isolation:** under Compose, FreshRSS sits on an internal network with no route out
  except egress, has no published port, and is administered only through a helper that runs a
  fixed list of commands and requires the service token. Locally it listens on loopback and
  reaches the egress proxy through podman's mapped host loopback, which also lets it address
  other loopback ports; that is a development convenience.
- **Service token:** `secrets/service-token` authenticates the worker to the API's internal
  listener, the API to egress control, and (under Compose) the worker to the engine helper. Anyone
  holding it can drive those internal routes. Under Compose the internal listener (8948) binds
  every interface of the API container: it is not published on the host, but other containers
  on the same Docker networks, including the shared proxy network, can reach it.
- **Feed key:** `secrets/feed-key` keys the fingerprints that recognise a private feed link followed a second
  time. Back it up with the rest of `secrets/`; if it is lost, the API warns in its log and makes the
  fingerprints again from the private link files, so nothing is lost as long as those files are there.
- **Browser side:** strict Content Security Policy (scripts, styles, fonts and API calls are
  same-origin; feed and article images load directly from publishers over HTTPS), same-origin check
  plus a per-session CSRF token on every change, HttpOnly SameSite=Lax session cookies, and
  in-memory rate limits on sign-in, setup and invitation attempts.
- **Secrets on disk:** the database holds only hashes of the setup code and
  invitations (the setup code's plain text is the operator's file). Private source links and
  engine passwords are files under `secrets/` (0600), never in the database or job payloads.
- **Not built:** Web Push, real private-service connectors (the private feed gateway registers
  none), a guided installer, payments, and abuse tooling for open sign-up.

Rationale and threat model: [plan/10](../plan/10-security-and-privacy.md),
[plan/11](../plan/11-packaging-and-operations.md), [plan/21](../plan/21-identity-and-administration.md).
