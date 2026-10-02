#!/usr/bin/env bash
# Publishes the olympusplugin.ai static site to the relay host.
#
#   site/deploy/deploy.sh            # copy site/ (minus deploy/) to the host
#   site/deploy/deploy.sh --dry-run  # show what would change, copy nothing
#
# The site includes the Mac installer: site/install.sh and the release tarball
# under site/releases/<version>/, both written by
# `bun scripts/publish-release-to-site.ts` and never committed. This script
# refuses to publish unless `publish-release-to-site.ts --check` passes (the
# served installer is the template rendered with its pins, and the tarball it
# pins is present with that SHA-256), and it uploads releases/ before the rest
# so the live install.sh never names a tarball the host does not have yet.
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
if ! bun "$SITE_DIR/../scripts/publish-release-to-site.ts" --check; then
  echo "Refusing to publish: run bun scripts/publish-release-to-site.ts first." >&2
  exit 1
fi

SSH_CMD="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"
echo "Publishing $SITE_DIR to $TARGET:$REMOTE_DIR"
# Releases first, without --delete, so the tarball is live before the
# install.sh that pins it.
rsync -rlt --itemize-changes ${DRY_RUN[@]+"${DRY_RUN[@]}"} \
  --exclude '.*' \
  -e "$SSH_CMD" \
  "$SITE_DIR/releases/" "$TARGET:$REMOTE_DIR/releases/"
rsync -rlt --delete --itemize-changes ${DRY_RUN[@]+"${DRY_RUN[@]}"} \
  --exclude '/deploy/' \
  --exclude '.*' \
  -e "$SSH_CMD" \
  "$SITE_DIR/" "$TARGET:$REMOTE_DIR/"
# macOS ships openrsync, which has no --chmod: set modes on the host instead.
if [ ${#DRY_RUN[@]} -eq 0 ]; then
  $SSH_CMD "$TARGET" \
    "find '$REMOTE_DIR' -type d -exec chmod 755 {} + && find '$REMOTE_DIR' -type f -exec chmod 644 {} +"
fi
echo "Done."
