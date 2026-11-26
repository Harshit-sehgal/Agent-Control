#!/usr/bin/env bash
# Nightly encrypted backup of the Agent Control data volume (run on the server, e.g. from cron).
#
# The database is copied with sqlite's own .backup (safe while the app writes), with the vault key
# and the device record, packed, then encrypted to a PUBLIC certificate. Only the holder of the
# matching PRIVATE key can open a copy, and that key never lives on this server
# (see deploy/restore-encrypted.sh and docs/OPERATIONS.md).
set -euo pipefail

DATA="${DATA_DIR:-/var/lib/docker/volumes/deploy_data/_data}"
CERT="${BACKUP_CERT:-/var/backups/agent-control/backup-cert.pem}"
OUT="${BACKUP_DIR:-/var/backups/agent-control}"
KEEP="${BACKUP_KEEP:-14}"

umask 077
mkdir -p "$OUT"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sqlite3 "$DATA/state.db" ".backup '$work/state.db'"
cp "$DATA/vault.key" "$work/vault.key"
if [ -f "$DATA/local-agent.json" ]; then cp "$DATA/local-agent.json" "$work/local-agent.json"; fi

tar -C "$work" -czf "$work.tgz" state.db vault.key $( [ -f "$work/local-agent.json" ] && echo local-agent.json )
target="$OUT/agent-control-$stamp.tgz.enc"
openssl smime -encrypt -aes256 -binary -in "$work.tgz" -out "$target" "$CERT"
rm -f "$work.tgz"

# Keep the newest $KEEP copies.
ls -1t "$OUT"/agent-control-*.tgz.enc | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$target"
