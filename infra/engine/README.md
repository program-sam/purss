# FreshRSS engine (development and self-hosted baseline)

The engine is FreshRSS **1.30.4**, pinned by digest:

```text
docker.io/freshrss/freshrss@sha256:a003730e81c89abf86c3ca9c8b263c818804734b574469d59586234364f425b0
```

Upstream reference for the notes below: `FreshRSS/FreshRSS@08f97bd497ace733c151ea1c709d85cd5b65cc53`,
cross-checked against the source inside the pinned image (`/var/www/FreshRSS`). The product talks to it only through
its GReader API and a small set of fixed administration commands; it never reads or writes FreshRSS's database.
What was actually observed is in [`packages/freshrss/CAPABILITIES.md`](../../packages/freshrss/CAPABILITIES.md).

## Commands

```sh
node scripts/engine.ts up              # start or resume; safe to run any number of times
node scripts/engine.ts status [--json] # container, API login, egress enforcement, retention, identity
node scripts/engine.ts down            # remove the container; data stays in data/engine
node scripts/engine.ts reset-confirm   # destroy the engine's data (asks you to type the container name)
```

`npm run dev` calls `up` and `down` for you. `up` never deletes data and never needs a volume to be recreated to change a
setting (see *Changing settings*).

| What | Where / value |
| --- | --- |
| Container | `purss-freshrss` (`PURSS_ENGINE_CONTAINER`) |
| Listener | `127.0.0.1:8941` only (`PURSS_ENGINE_PORT`); the FreshRSS web UI is on the same port for the operator |
| Engine data | `data/engine` (git-ignored), bind-mounted at `/var/www/FreshRSS/data`, SELinux-labelled |
| Operator login | `data/secrets/engine-admin` (0600, JSON `{username, password, apiPassword}`), generated on first `up` |
| Product users' API passwords | `data/secrets/engine-users/<engineUserId>` (0600), written and read only by the worker |
| Record of what was configured | `data/engine/purss-engine.json` |

## First run, interrupted setup, repeat runs

FreshRSS's Docker entrypoint runs `cli/do-install.php` (`FRESHRSS_INSTALL`) and `cli/create-user.php` (`FRESHRSS_USER`)
at every container start; both exit with "already exists" when there is nothing to do. `up` relies on that:

1. Generate `data/secrets/engine-admin` if missing, and write `config.custom.php` and `config-user.custom.php` into the data
   directory **before** the container's first start. They are read by FreshRSS's installer and user creation, so the very first
   fetch already goes through the proxy and the first user already has the retention policy.
2. Create the container if it does not exist, recreate it (data untouched) if its settings hash changed, start it if stopped.
3. Wait until the install marker exists and the API answers.
4. Make sure the operator admin can log in: if the user is missing the container is restarted (the entrypoint creates it);
   if it exists but cannot log in, its API password is reset to the stored one. Anything beyond that is reported, not guessed.
5. Verify the proxy settings in `data/config.php` and correct them in place if they drifted.

An `up` that died half-way is resumed by running `up` again: the same credentials are reused and nothing is reinstalled.
The admin password is passed to `podman run` through the process environment (`--env NAME`), not on the command line.

## All feed fetches go through the egress proxy

`PURSS_EGRESS_PROXY` (default `http://host.containers.internal:8946`) is an HTTP forward proxy. It is applied through FreshRSS's
global cURL options in `data/config.php` (`curl_options`: `CURLOPT_PROXYTYPE = CURLPROXY_HTTP`, `CURLOPT_PROXY = <ip>:<port>`).
Verified in the pinned source:

- feed fetching (`SimplePieCustom`), quick-add discovery, favicons and full-content fetching all start from
  `systemConf()->curl_options`; a per-feed `curl_params` can override the proxy but only through the trusted OPML import,
  which the product never feeds user data into;
- when a proxy is configured, FreshRSS skips its own address-based SSRF check for the target and instead checks the **proxy's**
  address against `internal_host_allowlist`. The proxy lives on an internal address, so exactly that one `ip:port` is allowed
  and nothing else (never `*`). Everything about *where feeds may point* is therefore decided by the proxy
  (`apps/egress`), which is where the product's SSRF rules live;
- FreshRSS resolves the proxy name with DNS only, not `/etc/hosts`, so the proxy must be an IPv4 literal. `host.containers.internal`
  is accepted as an alias for the address podman maps to the host's loopback (`169.254.1.2`);
- with the proxy unreachable the fetch fails; there is no fallback to a direct request (tested in `tests/engine`).

The container reaches host-loopback services only through that one mapped address (`pasta --map-host-loopback`), which is what
lets a proxy bound to `127.0.0.1` work. That also means the container can address any host-loopback port at `169.254.1.2`;
the controls above stop FreshRSS code from doing so, but this is a development convenience. The Compose deployment must put the
engine on an internal network whose only reachable service is the proxy.

## Scheduled refresh and retention

- Refresh: the container's cron runs FreshRSS's `actualize_script.php` at `CRON_MIN` (default minutes `3,18,33,48`,
  `PURSS_ENGINE_CRON_MIN`). A feed is due again after `ttl_default` = 900 s.
- Retention (recorded in `data/engine/purss-engine.json`, applied to every user created afterwards through
  `config-user.custom.php`): keep the newest 50 entries per feed always; otherwise purge entries that are no longer in the feed
  **and** have not been seen for 90 days (`keep_period: P90D`), or that exceed 1000 per feed (`keep_max`); favourites, labels
  and unread entries get **no** exemption, so the engine is a bounded transit buffer and not a second library. The product's
  copy of an item and its baskets never depend on the engine still having it.
- Consequence to surface in sync health: if the product's last successful sync is older than about 90 days, or a feed adds more
  than 1000 entries between two syncs, the engine may have purged entries the product never imported. A resumed sync does not
  prove completeness; it only proves nothing newer is missing.

## Changing settings

Never delete the data directory to apply a setting.

| Change | How |
| --- | --- |
| Port, cron minutes, memory limit | change the environment value, run `up`: the container is recreated, data untouched |
| Proxy address | change `PURSS_EGRESS_PROXY`, run `up`: `config.php` is corrected in place |
| Retention for **new** users | `archiving` in `EngineConfig`; existing users keep theirs (change them in the FreshRSS UI as operator) |
| Start over | `reset-confirm`: deletes `data/engine`, the operator secret and all engine-user secrets, after you type the container name. Imported product items are unaffected; the engine gets a new identity and a new sync starts from scratch |

## Fixed administration operations

`packages/freshrss` runs a closed set of operations through `PURSS_ENGINE_EXEC`
(default `podman exec --user www-data purss-freshrss`): `create-user.php`, `update-user.php` (API password), `list-users.php`,
`actualize-user.php`, `delete-user.php` (removing a deleted account's engine user), and three fixed `php -r` snippets (identity hash, archiving read, proxy keys). Arguments are structured
(`--option=value`), usernames and passwords are validated against a strict alphabet first, and nothing is interpreted by a shell.
`PURSS_ENGINE_EXEC` is whitespace-separated words, or a JSON array of strings when a word contains spaces.
Product users are created without a web password and without default feeds, so they can authenticate to the GReader API only.
The command line of `podman exec` is visible to other processes of the same user for the moment it runs.

## Tests

`npm run test:engine` starts isolated engines (own container, port and `data/test-engine/<id>` directory) with a recording test
proxy as their only way out, and removes them afterwards. On this host: `~/.t3/bin/hostlock work engine-tests -- npm run test:engine`
(about six minutes on a loaded machine: it includes one scheduled-refresh wait and several container starts).

- `tests/engine/engine.test.ts`: provisioning, egress enforcement, subscription management, paging, incremental sync, edits, late
  arrivals, removal, read/star mirroring, scheduled refresh, GUID export, engine identity.
- `tests/engine/resume.test.ts`: interrupted first runs and repeated `up`.

It does not exercise the real `apps/egress` proxy, so HTTPS (`CONNECT`) through the proxy is untested here.
