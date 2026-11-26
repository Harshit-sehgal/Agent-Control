#!/usr/bin/env bash
# Restore check for an encrypted backup. Run it on your own machine, where the private key is.
#   restore-encrypted.sh <backup.tgz.enc> <private-key.pem> <destination-folder>
# It decrypts, unpacks, and checks the database. A restore is only real once the app starts on it.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <backup.tgz.enc> <private-key.pem> <destination>" >&2
  exit 2
fi
backup="$1"; key="$2"; dest="$3"

umask 077
mkdir -p "$dest"
openssl smime -decrypt -binary -in "$backup" -inkey "$key" | tar -xz -C "$dest"

test -s "$dest/state.db"
test -s "$dest/vault.key"
check="$(sqlite3 "$dest/state.db" 'PRAGMA integrity_check;')"
if [ "$check" != "ok" ]; then
  echo "database check failed: $check" >&2
  exit 1
fi
echo "restored to $dest: database integrity ok"
