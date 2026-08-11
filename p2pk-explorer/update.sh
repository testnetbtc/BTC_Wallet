#!/bin/bash
# Daily P2PK Explorer refresh: rescan new blocks from our node + refresh the
# curated seed's spent-status, then publish the static site to olesia.io/p2pk.
# Wire via cron (see README). Requires CLOUDFLARE_* env for the deploy.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

# Cloudflare creds live in a gitignored file (never in crontab)
CREDS="$ROOT/packages/bitcoin/.secrets/cloudflare.env"
[ -f "$CREDS" ] && set -a && . "$CREDS" && set +a

node build.mjs

# publish the landing site (includes /p2pk) to production
cd "$ROOT"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  npx --yes wrangler@3.114.0 pages deploy landing --project-name=olesia-landing --branch=main 2>&1 | grep -iE "complete|alias" || true
else
  echo "CLOUDFLARE_API_TOKEN not set — built data only, skipped deploy"
fi
