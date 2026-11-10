# Infrastructure

Two ways to run the stack:

- **Local development:** `npm run dev` (FreshRSS in rootless podman; egress, API and worker as
  Node processes). Engine operation is in [engine/README.md](engine/README.md).
- **Docker Compose on one host:** [compose.yaml](compose.yaml) builds two images: the product
  image ([Containerfile](Containerfile)) used for API, worker, egress and the setup steps, and a
  thin engine image ([engine/image](engine/image)) on the pinned FreshRSS 1.30.4.

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build                 # 127.0.0.1:8940 only
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.proxy.yaml up -d --build   # behind an HTTPS proxy
docker compose -f infra/compose.yaml exec api cat /data/secrets/setup-code          # one-time setup code
```

How Compose differs from the dev setup:

- FreshRSS sits on an internal network with no route out; its only way to the internet is the
  egress proxy, which refuses private and internal destinations.
- The worker never runs commands in the engine container. The engine image adds one endpoint
  (`/purss/admin.php`) that runs only the worker's fixed operations, listed in
  [allowlist.json](engine/image/allowlist.json) (a test keeps it equal to the worker's code), and
  requires the service token. It is reachable only on the internal network.
- `init` creates the secrets and the engine's install-time settings before the engine starts;
  `engine-setup` checks the proxy setting and operator sign-in once the engine is healthy.
- Volumes: `data` (product database), `secrets` (tokens and passwords; the engine can read only
  the service token and its operator secret), `engine-data` (FreshRSS).

Backups: `docker compose -f infra/compose.yaml exec api node scripts/backup.ts`. See
[packaging and operations](../plan/11-packaging-and-operations.md).

## Deploying from GitHub

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) runs `npm ci`, `npm run check`,
`npm test` and the web build on every push to `main` (or when started by hand). Only if they pass,
it sends that commit as a `git archive` over SSH to the server, where
[deploy/purss-deploy.sh](deploy/purss-deploy.sh) unpacks it into the install directory (keeping
`.env`), rebuilds, restarts, and waits for the API to answer. Deploys run one at a time in push
order. The deployed commit is written to `.deployed-commit` in the install directory.

One-time server setup:

1. Install the script: `install -m 755 infra/deploy/purss-deploy.sh /usr/local/bin/purss-deploy`.
2. In the install directory's `.env` (default `/opt/purss`, or `PURSS_DEPLOY_DIR`), set which Compose
   files to use, e.g. `COMPOSE_FILE=infra/compose.yaml:infra/compose.proxy.yaml`.
3. Make a key pair used for nothing else, and add its public key to the deploying user's
   `~/.ssh/authorized_keys` locked to the script:
   `restrict,command="/usr/local/bin/purss-deploy" ssh-ed25519 AAAA… purss-github-deploy`.
   With that, the key can only run a deploy: any other command gets a usage message.
4. Add repository secrets: `DEPLOY_HOST` (the server's address), `DEPLOY_KNOWN_HOSTS` (its
   `known_hosts` lines, so the host key is checked) and `DEPLOY_SSH_KEY` (the private key).

What the key allows: deploying arbitrary code from an archive, which runs on the server with the
privileges of Docker. Treat it like root access to the server: keep it only in the repository's
secrets, and remove its line from `authorized_keys` to revoke it.

Server settings that don't belong in Git (the public address, `PURSS_MODE` and the like) stay in
the server's `.env`; a deploy never changes it.

The project's own server adds `infra/compose.official.yaml` to its `COMPOSE_FILE`, so the same deploy
also runs the [push relay](../apps/push-relay/README.md) (its proxy sends `push.purss.app` to
`http://purss-push-relay:8950`; credential files sit in the host folder named by
`PURSS_RELAY_SECRETS_DIR`, outside Git) and passes the hosted service's billing settings to the API.
