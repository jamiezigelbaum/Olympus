#!/usr/bin/env bash
# Builds the relay from this checkout's exact commit and installs it on the
# relay host. Usage (from anywhere in the repo, with a clean tree):
#
#   connect-relay/deploy/deploy.sh
#
# Overrides: RELAY_SSH_TARGET (default relayadmin@188.245.18.84),
#            RELAY_SSH_KEY    (default ~/.ssh/id_ed25519_olympus_relay),
#            RELAY_PUBLIC_HOST (default mcp.olympusplugin.ai),
#            RELAY_REVIEWER_CHECK (default `demo`; `no-demo` when no reviewer
#              demo engine is meant to be running; `off` only for a host that
#              does not serve the ChatGPT directory plugin).
#
# What it does:
#   1. bun build --compile for linux-x64, named by commit SHA;
#   2. copies the binary, systemd unit, Caddyfile (and its systemd drop-in
#      for Caddy's admin socket) and remote-install.sh to a
#      fresh directory on the host;
#   3. runs remote-install.sh with sudo there: installs Caddy from Ubuntu's
#      apt repository if missing, installs the binary under /opt/olympus-relay
#      (previous builds stay for rollback), the unit and the Caddyfile,
#      validates, restarts the relay, reloads Caddy and checks /healthz;
#   4. walks the ChatGPT directory reviewer's path (reviewer-check.ts) before
#      and after: a path already broken stops the deploy, and one the new
#      build breaks switches the relay back to the build it replaced.
set -euo pipefail

TARGET="${RELAY_SSH_TARGET:-relayadmin@188.245.18.84}"
KEY="${RELAY_SSH_KEY:-$HOME/.ssh/id_ed25519_olympus_relay}"
PUBLIC_HOST="${RELAY_PUBLIC_HOST:-mcp.olympusplugin.ai}"
REVIEWER_CHECK="${RELAY_REVIEWER_CHECK:-demo}"
ROOT="$(git rev-parse --show-toplevel)"
DEPLOY_DIR="$ROOT/connect-relay/deploy"

case "$REVIEWER_CHECK" in
  demo) CHECK_ARGS=(--host "$PUBLIC_HOST") ;;
  no-demo) CHECK_ARGS=(--host "$PUBLIC_HOST" --no-demo) ;;
  off) CHECK_ARGS=() ;;
  *) echo "RELAY_REVIEWER_CHECK must be demo, no-demo or off" >&2; exit 1 ;;
esac
reviewer_check() {
  [ "$REVIEWER_CHECK" = off ] && return 0
  bun "$DEPLOY_DIR/reviewer-check.ts" "${CHECK_ARGS[@]}" "$@"
}

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
cp "$DEPLOY_DIR/olympus-relay.service" "$DEPLOY_DIR/Caddyfile" "$DEPLOY_DIR/caddy-admin.conf" "$DEPLOY_DIR/remote-install.sh" "$BUILD_DIR/"
cp "$ROOT/site/deploy/Caddyfile.site" "$BUILD_DIR/olympus-site.caddy"
printf '%s\n' "$SHA" > "$BUILD_DIR/BUILD_SHA"

SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
REMOTE_DIR="olympus-relay-deploy-${SHORT}"

echo "Checking the reviewer path before deploying"
if ! reviewer_check; then
  echo "The reviewer path is already failing on ${PUBLIC_HOST}; fix that first (nothing was deployed)." >&2
  exit 1
fi
PREVIOUS="$(ssh "${SSH_OPTS[@]}" "$TARGET" "readlink -f /usr/local/bin/olympus-relay")"
echo "Copying to ${TARGET}:${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf ${REMOTE_DIR} && mkdir -m 700 ${REMOTE_DIR}"
scp "${SSH_OPTS[@]}" "$BUILD_DIR"/* "$TARGET:${REMOTE_DIR}/"
echo "Installing"
# remote-install.sh switches the symlink before it restarts and checks the
# relay, so a failure there (or a dropped connection) may leave the new build
# active: every failure from here on goes back to the build it replaced.
roll_back() {
  echo "$1; rolling back to ${PREVIOUS}" >&2
  if ssh "${SSH_OPTS[@]}" "$TARGET" "sudo ln -sfn '${PREVIOUS}' /usr/local/bin/olympus-relay && sudo systemctl restart olympus-relay.service && for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:8787/healthz >/dev/null && exit 0; sleep 1; done; exit 1" \
    && reviewer_check --wait 90; then
    echo "Rolled back to ${PREVIOUS}; the reviewer path passes again." >&2
  else
    echo "Rolled back to ${PREVIOUS}, but the relay or the reviewer path still fails: look now." >&2
  fi
  exit 1
}

if ! ssh "${SSH_OPTS[@]}" "$TARGET" "sudo bash ${REMOTE_DIR}/remote-install.sh ${REMOTE_DIR} ${SHORT}"; then
  roll_back "Installing olympus-relay ${SHORT} failed or did not confirm"
fi

echo "Checking the reviewer path on the new build"
if ! reviewer_check --wait 90; then
  roll_back "olympus-relay ${SHORT} changes or breaks the reviewer path"
fi
echo "Deployed olympus-relay ${SHORT}"
