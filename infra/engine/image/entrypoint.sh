#!/bin/sh
# Engine image entrypoint for Compose: supply the operator admin's credentials (from the
# shared secrets volume) to FreshRSS's first-run install, then hand over to its entrypoint.
# Proxy and retention settings are written beforehand by the product's init step
# (config.custom.php and config-user.custom.php in the data volume).
set -eu
secret=/run/purss-secrets/engine-admin
if [ ! -s "$secret" ]; then echo "purss: $secret is missing; the init step creates it" >&2; exit 1; fi
PURSS_ENGINE_ADMIN_PASSWORD=$(php -r '$s = json_decode(file_get_contents($argv[1]), true); echo $s["password"];' "$secret")
PURSS_ENGINE_ADMIN_API_PASSWORD=$(php -r '$s = json_decode(file_get_contents($argv[1]), true); echo $s["apiPassword"];' "$secret")
export PURSS_ENGINE_ADMIN_PASSWORD PURSS_ENGINE_ADMIN_API_PASSWORD
exec ./Docker/entrypoint.sh "$@"
