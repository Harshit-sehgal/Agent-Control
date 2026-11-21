#!/usr/bin/env bash
# Roll the app back to an earlier commit: back up the data first, build that commit's image from a temporary
# checkout, and restart the app with it. The data volume is not reverted. A database written by a newer schema
# is refused by an older build (it fails to start and says so), so then restore the backup taken before the upgrade.
#
#   deploy/rollback.sh <commit>
#   ROLLBACK_SKIP_BACKUP=1 deploy/rollback.sh <commit>   # only if you have a backup of your own
set -euo pipefail

commit="${1:?usage: deploy/rollback.sh <commit>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null || { echo "rollback: unknown commit $commit" >&2; exit 1; }
[ -f "$root/deploy/.env" ] || { echo "rollback: deploy/.env is missing; the app needs it to start" >&2; exit 1; }

if [ "${ROLLBACK_SKIP_BACKUP:-0}" != "1" ]; then
  cert="${BACKUP_CERT:-/var/backups/agent-control/backup-cert.pem}"
  [ -f "$cert" ] || { echo "rollback: no backup certificate at $cert. Set BACKUP_CERT, or ROLLBACK_SKIP_BACKUP=1 to skip the backup." >&2; exit 1; }
  "$root/deploy/backup-encrypted.sh"
fi

tree="$(mktemp -d)"
override="$(mktemp)"
cleanup() {
  git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"
  rm -f "$override"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$tree" "$commit" >/dev/null
# Compose merges this over compose.yaml: the same service, built from the older checkout.
cat > "$override" <<YAML
services:
  app:
    build:
      context: $tree
YAML

cd "$root/deploy"
docker compose -f compose.yaml -f "$override" up -d --build app

# Wait for the health answer. A build that refuses the database (a newer schema) never gets healthy.
for _ in $(seq 1 30); do
  if docker compose -f compose.yaml exec -T app node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo "rollback: app is healthy at commit $(git -C "$root" rev-parse --short "$commit")"
    exit 0
  fi
  sleep 2
done
echo "rollback: the app did not become healthy. Read its log with: docker compose logs app" >&2
echo "rollback: if it reports a newer schema, restore the backup taken before the upgrade (deploy/restore-encrypted.sh)." >&2
exit 1
