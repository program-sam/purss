#!/usr/bin/env bash
# Deploys one commit of PURSS that arrives as a gzip'd `git archive` on stdin.
#
# Installed on the server as /usr/local/bin/purss-deploy and run only as the forced command of
# the CI deploy key (see infra/README.md), so that key can do nothing else. The client's
# requested command is read from SSH_ORIGINAL_COMMAND and must be `deploy <40-hex commit>`.
#
# Server-only files in the install directory (.env) and the Docker volumes are never touched.
# Which Compose files to use comes from COMPOSE_FILE in that .env, e.g.
#   COMPOSE_FILE=infra/compose.yaml:infra/compose.proxy.yaml
set -euo pipefail

APP_DIR="${PURSS_DEPLOY_DIR:-/opt/purss}"
KEEP=(.env)  # never replaced or deleted by a deploy

request="${SSH_ORIGINAL_COMMAND:-${1:-} ${2:-}}"
read -r verb commit extra <<<"$request" || true
if [[ "$verb" != "deploy" || ! "$commit" =~ ^[0-9a-f]{40}$ || -n "${extra:-}" ]]; then
  echo "usage: deploy <40-character commit id>" >&2
  exit 2
fi

exec 9>/run/lock/purss-deploy.lock
flock -w 600 9 || { echo "another deploy is still running" >&2; exit 75; }

stage="$(mktemp -d /tmp/purss-deploy.XXXXXX)"
trap 'rm -rf "$stage"' EXIT

# Unpack into an empty staging directory (GNU tar drops absolute and ../ member paths).
head -c 200000000 | tar -xz -C "$stage" --no-same-owner --no-same-permissions
if [[ ! -f "$stage/infra/compose.yaml" || ! -f "$stage/package.json" ]]; then
  echo "the archive is not a PURSS checkout" >&2
  exit 3
fi

excludes=()
for f in "${KEEP[@]}"; do excludes+=(--exclude "/$f"); done
rsync -a --delete "${excludes[@]}" "$stage/" "$APP_DIR/"
printf '%s\n' "$commit" >"$APP_DIR/.deployed-commit"

cd "$APP_DIR"
if ! grep -qE '^COMPOSE_FILE=' .env; then
  echo "set COMPOSE_FILE in $APP_DIR/.env (for example infra/compose.yaml)" >&2
  exit 4
fi
compose=(docker compose --env-file .env)

echo "building ${commit:0:7}"
"${compose[@]}" build --quiet
"${compose[@]}" up -d --remove-orphans

# Wait for the API to answer before calling the deploy done.
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:8940/api/session').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    "${compose[@]}" ps --format '{{.Service}} {{.Status}}'
    echo "deployed ${commit:0:7}"
    exit 0
  fi
  sleep 4
done
echo "the API did not answer within two minutes after deploying ${commit:0:7}" >&2
"${compose[@]}" logs --tail 40 api >&2 || true
exit 1
