# Host it yourself

A step-by-step guide to running your own PURSS on a computer you control: a home server,
a spare machine, or a rented server. It takes about half an hour, most of it waiting for the
first build. For every option and the details behind each step, see
[self-hosting](self-hosting.md).

PURSS is a preliminary build. It works end to end, but it hasn't been reviewed for
exposure to the public internet; read [step 2](#2-choose-who-will-reach-it) before opening it
up.

## 1. What you need

- A Linux machine that stays on, with **Docker Engine** and the **Docker Compose plugin**
  (Compose v2). Check with `docker compose version`.
- About **1 GiB of free memory** (the containers are capped at roughly 870 MiB together) and a
  few GiB of disk. PURSS pauses collecting when less than 1 GiB of disk is left.
- **Git**, and a copy of this repository.
- Internet access from the machine, to fetch feeds.

You don't need Node.js or a database server: everything runs in containers.

## 2. Choose who will reach it

Pick one. You can change it later by editing `.env` and starting again (step 5).

| Option | Who can open it | How people sign in |
| --- | --- | --- |
| **A. Only this machine** | You, at `http://localhost:8940`, or from another computer through an SSH tunnel | Email address and password, and fingerprint, face or screen lock if you add it |
| **B. Your home network** | Everyone on your Wi-Fi, at the server's address, e.g. `http://192.168.1.20:8940` | Email address and password |
| **C. The internet, with HTTPS** | Anyone you invite, at your own domain, e.g. `https://purss.example.com` | Email address and password, and fingerprint, face or screen lock if you add it |

- **Fingerprint, face or screen lock** (a passkey) works over HTTPS or at `localhost`; browsers
  refuse it on a plain `http://` address. Use Touch ID, Face ID, Windows Hello, your phone's
  screen lock or a password manager. On option B the app therefore doesn't offer it; everyone
  signs in with their email address and password.
- **Option B** sends everything unencrypted over your network. Use it only on a network you
  trust.
- **Option C** needs a domain name and a reverse proxy that handles HTTPS certificates, such as
  Nginx Proxy Manager, Caddy or Traefik, running in Docker on the same machine.

## 3. Get the code

```sh
git clone <address of your copy of this repository> purss
cd purss
```

## 4. Write the settings file

Create a file called `.env` in the `purss` folder. It is ignored by Git. Copy the block for your
option and change the example address.

**A. Only this machine:** no settings needed. Create an empty `.env`:

```sh
touch .env
```

**B. Your home network.** Use the server's own address on your network. Find it with
`hostname -I`; the first number is usually the right one. Ask your router to always give the
server that address, so the link keeps working.

```sh
PURSS_BIND_ADDRESS=192.168.1.20
PURSS_PUBLIC_ORIGIN=http://192.168.1.20:8940
```

**C. The internet, with HTTPS.** Point your domain's DNS at the server first.

```sh
PURSS_PUBLIC_ORIGIN=https://purss.example.com
PURSS_PROXY_NETWORK=<the Docker network your reverse proxy is on>
```

Find the proxy's network with `docker network ls`. Then, in the proxy, add a site for your
domain that forwards to `http://purss-workspace:8940` and requests an HTTPS certificate. Leave
buffering off for `/api/events` and allow uploads of at least 128 MiB, for imports. The
[proxy section](self-hosting.md#behind-an-https-reverse-proxy) has the full list.

`PURSS_PUBLIC_ORIGIN` must be exactly the address people type, including `http` or `https` and
the port, if any. If it doesn't match, the app refuses changes with "This request didn't come
from the PURSS page."

**Optional, for a service run for others:** add `PURSS_MODE=hosted` for plans and per-account
storage limits an administrator can set (none unless `PURSS_DEFAULT_ALLOCATION_BYTES` gives new
accounts one). Add
`PURSS_SIGNUP=open` too only if strangers should be able to create accounts; that also needs
[outgoing email](self-hosting.md#outgoing-email). Leave both out for a household or yourself; see
[self and hosted mode](self-hosting.md#self-and-hosted-mode).

## 5. Start it

**A or B:**

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

**C:**

```sh
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.proxy.yaml up -d --build
```

The first build takes several minutes. Then check that everything runs:

```sh
docker compose -f infra/compose.yaml ps
```

`api`, `worker`, `egress` and `engine` should be up, with `engine` marked healthy. `init` and
`engine-setup` run once and then exit; that's expected.

## 6. Claim it with the setup code

The first person to enter the one-time setup code becomes the owner and administrator. Read
it on the server:

```sh
docker compose -f infra/compose.yaml exec api cat /data/secrets/setup-code
```

Open your address (step 2); it takes you to the setup page (`/app/setup`). Then:

1. Enter the setup code and, if you like, a display name.
2. Enter your email address and choose a password, typed twice. You sign in with them on any
   computer, including borrowed ones.
3. Add fingerprint, face or screen lock (a passkey) if you like, or skip it and add it later in
   *Settings → Security*. Use Touch ID, Face ID, Windows Hello, your phone's screen lock or a
   password manager. On option B the app goes straight into PURSS after step 2.

The setup code stops working once it has been used.

## 7. Add the rest of your household

Open **Administration → Invitations**, choose **Invite someone** and type the person's email
address; that is the address they will sign in with. Where the server sends email, the invitation
is emailed to them and you never see its code. Otherwise send them the link it shows; it is shown
only once. It works for that address only, and expires after 14 days unless you choose otherwise. Each person gets their own PURSS; the app never shows one account's items to another,
administrators included.

Under **Administration → Accounts** you can suspend an account, or make someone a fellow
administrator.

## 8. Start using it

Choose **Add source** and paste the address of a site, blog, podcast or YouTube channel you
follow. The [user guide](user-guide.md) explains the rest. The first items take a few minutes
to arrive.

## Keeping it running

**Back up** regularly. This works while the app runs:

```sh
docker compose -f infra/compose.yaml exec api node scripts/backup.ts
docker compose -f infra/compose.yaml cp api:/data/backups ./backups
```

Keep the copies somewhere other than the server. Restoring is described under
[backups and restore](self-hosting.md#backups-and-restore).

**Update** by taking a backup, fetching the new code and running the same start command as in
step 5:

```sh
git pull
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

(add `-f infra/compose.proxy.yaml` for option C). Database changes apply automatically on start.

**Stop** it with `docker compose -f infra/compose.yaml down`. Your data stays in Docker volumes
and is there again on the next start. Never add `-v` unless you mean to delete everything.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| The page doesn't load | Check `docker compose -f infra/compose.yaml ps` and the logs: `docker compose -f infra/compose.yaml logs --tail 50 api` |
| "This request didn't come from the PURSS page." | `PURSS_PUBLIC_ORIGIN` doesn't match the address in the browser. Fix `.env` and run the start command again |
| No fingerprint, face or screen lock option | Expected on a plain `http://` address other than `localhost`. Use your email address and password, or set up HTTPS (option C) |
| Someone forgot their password (or you did, as administrator) | On the server: `docker compose -f infra/compose.yaml exec api node apps/api/src/cli.ts password-reset-link "<their email address>"`. It prints a link, shown once and valid for 60 minutes, to give them; it opens a page where they choose a new password (see [forgotten passwords](self-hosting.md#forgotten-passwords)) |
| You lost the setup code before using it | Read it again with the command in step 6 |
| Feeds don't update | Look at **Administration → Health**; the engine and egress cards say what is wrong |
| "Port is already allocated" when starting | Another program uses port 8940. Set `PURSS_HOST_PORT=8950` in `.env`, change the port in `PURSS_PUBLIC_ORIGIN` to match, and start again |
