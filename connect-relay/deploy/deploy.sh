#!/usr/bin/env bash
# Builds the relay from this checkout's exact commit and installs it on the
# relay host. Usage (from anywhere in the repo, with a clean tree):
#
#   connect-relay/deploy/deploy.sh
#
# Overrides: RELAY_SSH_TARGET (default relayadmin@188.245.18.84),
#            RELAY_SSH_KEY    (default ~/.ssh/id_ed25519_olympus_relay).
#
# What it does:
#   1. bun build --compile for linux-x64, named by commit SHA;
#   2. copies the binary, systemd unit, Caddyfile and remote-install.sh to a
#      fresh directory on the host;
#   3. runs remote-install.sh with sudo there: installs Caddy from Ubuntu's
#      apt repository if missing, installs the binary under /opt/olympus-relay
#      (previous builds stay for rollback), the unit and the Caddyfile,
#      validates, restarts the relay, reloads Caddy and checks /healthz.
set -euo pipefail

TARGET="${RELAY_SSH_TARGET:-relayadmin@188.245.18.84}"
KEY="${RELAY_SSH_KEY:-$HOME/.ssh/id_ed25519_olympus_relay}"
ROOT="$(git rev-parse --show-toplevel)"
DEPLOY_DIR="$ROOT/connect-relay/deploy"

if [ -n "$(git -C "$ROOT" status --porcelain -- connect-relay)" ]; then
  echo "connect-relay/ has uncommitted changes; deploy builds an exact commit only." >&2
  exit 1
fi
SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHORT="${SHA:0:12}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Building olympus-relay ${SHORT} for linux-x64"
bun build --compile --target=bun-linux-x64 "$ROOT/connect-relay/server/main.ts" --outfile "$BUILD_DIR/olympus-relay-${SHORT}"
cp "$DEPLOY_DIR/olympus-relay.service" "$DEPLOY_DIR/Caddyfile" "$DEPLOY_DIR/remote-install.sh" "$BUILD_DIR/"
cp "$ROOT/site/deploy/Caddyfile.site" "$BUILD_DIR/olympus-site.caddy"
printf '%s\n' "$SHA" > "$BUILD_DIR/BUILD_SHA"

SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
REMOTE_DIR="olympus-relay-deploy-${SHORT}"
echo "Copying to ${TARGET}:${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf ${REMOTE_DIR} && mkdir -m 700 ${REMOTE_DIR}"
scp "${SSH_OPTS[@]}" "$BUILD_DIR"/* "$TARGET:${REMOTE_DIR}/"
echo "Installing"
ssh "${SSH_OPTS[@]}" "$TARGET" "sudo bash ${REMOTE_DIR}/remote-install.sh ${REMOTE_DIR} ${SHORT}"
echo "Deployed olympus-relay ${SHORT}"
