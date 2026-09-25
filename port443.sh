#!/usr/bin/env bash
# Move the pithagoras portal from 4100 -> 443 (standard HTTPS port).
# Idempotent + backs up .env first (rollback = restore the backup).
set -euo pipefail
cd /opt/pithagoras
cp -n .env .env.bak-443   # one-time backup (no clobber)
if grep -qE '^PORT=' .env; then
  sed -i 's/^PORT=.*/PORT=443/' .env
  echo "updated: PORT=443 (replaced existing PORT line)"
else
  {
    echo ""
    echo "# Standard HTTPS port (added $(date +%F))"
    echo "PORT=443"
  } >> .env
  echo "appended: PORT=443"
fi
echo "--- PORT + TLS lines now in .env ---"
grep -E '^(PORT|PORTAL_TLS)' .env
echo "--- backup present: ---"
ls -la .env.bak-443