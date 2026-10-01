#!/usr/bin/env bash
# Publishes the olympusplugin.ai static site to the relay host.
#
#   site/deploy/deploy.sh            # copy site/ (minus deploy/) to the host
#   site/deploy/deploy.sh --dry-run  # show what would change, copy nothing
#
# Overrides: SITE_SSH_TARGET (default relayadmin@188.245.18.84),
#            SITE_SSH_KEY    (default ~/.ssh/id_ed25519_olympus_relay),
#            SITE_REMOTE_DIR (default /srv/olympus-site).
#
# The remote directory must exist and be writable by the SSH user. Serving it
# is Caddy's job (site/deploy/Caddyfile.site); this script does not touch
# Caddy's configuration.
set -euo pipefail

TARGET="${SITE_SSH_TARGET:-relayadmin@188.245.18.84}"
KEY="${SITE_SSH_KEY:-$HOME/.ssh/id_ed25519_olympus_relay}"
REMOTE_DIR="${SITE_REMOTE_DIR:-/srv/olympus-site}"
SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=()
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=(--dry-run) ;;
  *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

if [ ! -f "$SITE_DIR/index.html" ]; then
  echo "No index.html in $SITE_DIR; refusing to publish." >&2
  exit 1
fi

echo "Publishing $SITE_DIR to $TARGET:$REMOTE_DIR"
rsync -rlt --delete --itemize-changes ${DRY_RUN[@]+"${DRY_RUN[@]}"} \
  --exclude '/deploy/' \
  --exclude '.*' \
  -e "ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes" \
  "$SITE_DIR/" "$TARGET:$REMOTE_DIR/"
# macOS ships openrsync, which has no --chmod: set modes on the host instead.
if [ ${#DRY_RUN[@]} -eq 0 ]; then
  ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$TARGET" \
    "find '$REMOTE_DIR' -type d -exec chmod 755 {} + && find '$REMOTE_DIR' -type f -exec chmod 644 {} +"
fi
echo "Done."
