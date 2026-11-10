# Push relay

A small service that wakes phone apps. A phone app registers its FCM (Android) or APNs
(iOS) device token and gets back an unguessable **handle**. A PURSS, self-hosted or
official, later asks the relay to wake the device by handle only. The relay holds the
project's FCM and APNs credentials so a self-hosted PURSS never needs its own.

Pushes carry **no content**: FCM gets `{"purss":"1"}`, APNs gets a neutral alert ("You have
something new in your PURSS.") that the app's notification extension replaces with the
real text it fetches from the PURSS. There are no user accounts.

Run it with `node apps/push-relay/src/main.ts` (tests: `node --test apps/push-relay/src/*.test.ts`,
also part of `npm test`).

## Protocol

All bodies are JSON objects with exactly the listed keys, at most 4096 bytes, sent with
`Content-Type: application/json`. Anything else is answered 400 (bad shape), 413 (too large),
415 (wrong content type), 404 (unknown path) or 405 (wrong method).

| Request | Success | Other answers |
| --- | --- | --- |
| `POST /v1/register` `{"platform":"fcm"\|"apns","token":…,"scope":…}` | 200 `{"handle":"rh_…"}` | 400, 429 |
| `POST /v1/unregister` `{"handle":…}` | 204, also for an unknown handle | 400, 429 |
| `POST /v1/notify` `{"handle":…}` | 202 `{"ok":true}` once the push service accepted it | 404 `gone`, 429 `slow_down`, 502 `provider`, 503 `unavailable` |
| `GET /healthz` | 200 `{"ok":true,"fcm":bool,"apns":bool}` | |

- `token`: FCM `[A-Za-z0-9_:-]{20,512}`; APNs 64 to 200 hex digits (stored lower-case).
- `scope`: 22 to 64 characters `[A-Za-z0-9_-]`, picked at random by the app for each
  connection to a PURSS.
- The handle is `rh_` plus the base64url HMAC-SHA256 of `platform\ntoken\nscope` under a
  secret only the relay knows. Registering the same triple again returns the same handle;
  a new connection (new scope) gets a new handle, so two PURSSes cannot tell that they
  reach the same phone. At most five handles are kept per device token; the oldest go.
- `notify` answers 404 when the handle is unknown or the push service reported the token
  dead (the entry is then deleted). The app registers again on its next start. 429 and
  `Retry-After` come from the limits below; 503 means that platform has no credentials here.
- `register` and `unregister` answer CORS only for the origins `capacitor://localhost`,
  `https://localhost` and `http://localhost` (the app's web view). `notify` has no CORS.

Limits (in memory, per relay process): register 30 and unregister 60 per 10 minutes per
client address, and all registrations together 300 at once refilling 5 a second; notify 600 per
minute per sending address and, per handle, a burst of 5 refilling one per minute and at most
200 a day. An IPv6 client is limited by its /64. Each limit holds at most 50,000 addresses or
handles in memory, dropping the least recently used first.

FCM messages carry a collapse key: a phone that was offline gets one wake, which fetches
everything waiting. APNs alerts carry no collapse id, so one never replaces an earlier one
on the lock screen.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PURSS_RELAY_HOST` | `127.0.0.1` | Listen address |
| `PURSS_RELAY_PORT` | `8950` | Listen port |
| `PURSS_RELAY_DATA_DIR` | `<repo>/data/push-relay` | Holds `relay.db` (SQLite, WAL) |
| `PURSS_RELAY_SECRET_FILE` | `<data dir>/handle-secret` | HMAC secret; 32 random bytes are created (mode 0600) on first start. Losing it changes every handle; apps register again on their next start. |
| `PURSS_RELAY_TRUST_PROXY` | off | `1` takes the client address from the right-most `X-Forwarded-For` hop when the peer is a private or loopback address (`X-Real-IP` is ignored) |
| `PURSS_RELAY_FCM_CREDENTIALS` | none | Path to the Google service-account JSON (`project_id`, `client_email`, `private_key`, `token_uri`) |
| `PURSS_RELAY_FCM_URL` | `https://fcm.googleapis.com` | FCM base URL |
| `PURSS_RELAY_APNS_KEY` | none | Path to the `.p8` signing key |
| `PURSS_RELAY_APNS_KEY_ID`, `PURSS_RELAY_APNS_TEAM_ID` | none | Required with the key |
| `PURSS_RELAY_APNS_TOPIC` | `app.purss` | App bundle id |
| `PURSS_RELAY_APNS_URL` | `https://api.push.apple.com` | Production endpoint |
| `PURSS_RELAY_APNS_SANDBOX_URL` | `https://api.sandbox.push.apple.com` | Development endpoint; empty turns the sandbox fallback off |

A platform without credentials is simply unavailable (503, `false` in `/healthz`); the
relay still starts. A credential file that is set but unreadable stops it with a message.
When APNs rejects a production token as bad, the relay tries the sandbox once and
remembers the environment if that works; otherwise the entry is deleted.

## Deploy

`compose.yaml` builds `Containerfile` (build context: the repository root) and binds
`${PURSS_RELAY_BIND:-127.0.0.1}:8950`. Put an HTTPS reverse proxy in front of it and set
`PURSS_RELAY_TRUST_PROXY=1` there (the compose file's default). The proxy must append the client's
address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
the default in Nginx Proxy Manager and Caddy); the relay uses only that right-most hop, since anything
left of it came from the client. Without a proxy, set `PURSS_RELAY_TRUST_PROXY=0`. Keep the credential files in a host directory outside Git
and name it:

```sh
# apps/push-relay/.env (ignored by Git)
PURSS_RELAY_SECRETS_DIR=/srv/push-relay/secrets
PURSS_RELAY_FCM_CREDENTIALS=/run/relay-secrets/fcm-service-account.json
PURSS_RELAY_APNS_KEY=/run/relay-secrets/apns-key.p8
PURSS_RELAY_APNS_KEY_ID=ABC123DEFG
PURSS_RELAY_APNS_TEAM_ID=TEAM123456

docker compose -f apps/push-relay/compose.yaml up -d --build
```

The secrets directory is mounted read-only at `/run/relay-secrets`. A platform whose variables are
left empty stays off (Android first and iOS later works); a path that points at a missing file
stops the relay. The data volume holds `relay.db` and `handle-secret`; back up
`handle-secret` or accept that apps re-register after a loss.

## What it stores and sees

- Stored: per device the SHA-256 of the handle, platform, device token, APNs environment,
  and created and last-seen times. The handle itself is never stored, so a database copy
  cannot wake devices. Entries not seen for 180 days are deleted by an hourly sweep; a
  successful push refreshes the time.
- Seen: the sending address of each request and the handle in a notify call, in memory only
  for rate limiting. Logs hold start and stop, push-service failures by status code and an
  hourly count of outcomes; never tokens, handles, scopes or addresses.
- Never seen: PURSS addresses, accounts, item titles or any content. The push services
  themselves see the device token and the neutral wake-up payload.
