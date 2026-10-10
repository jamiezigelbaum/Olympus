#!/usr/bin/env bash
# Runs on the relay host as root (deploy.sh calls it with sudo).
# Arguments: <upload directory> <short sha>
set -euo pipefail

SRC="$(cd "$1" && pwd)"
SHORT="$2"
BINARY="$SRC/olympus-relay-${SHORT}"
[ -x "$BINARY" ] || chmod 0755 "$BINARY"

# Caddy from Ubuntu's own repository (the upstream apt repository's signing
# key is not used here).
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy
fi

# The service user exists on the host already; create it only if missing.
if ! id relay >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin relay
fi

# Exact build, kept beside earlier ones for rollback (re-point the symlink).
install -d -m 0755 /opt/olympus-relay
install -m 0755 "$BINARY" "/opt/olympus-relay/olympus-relay-${SHORT}"
install -m 0644 "$SRC/BUILD_SHA" "/opt/olympus-relay/olympus-relay-${SHORT}.sha"
ln -sfn "/opt/olympus-relay/olympus-relay-${SHORT}" /usr/local/bin/olympus-relay

install -m 0644 "$SRC/olympus-relay.service" /etc/systemd/system/olympus-relay.service
# Caddy's admin socket directory (/run/caddy, see the Caddyfile's `admin`).
install -d -m 0755 /etc/systemd/system/caddy.service.d
install -m 0644 "$SRC/caddy-admin.conf" /etc/systemd/system/caddy.service.d/olympus-admin.conf
# The static site: its Caddy blocks, and a directory the deploy user publishes into.
install -m 0644 "$SRC/olympus-site.caddy" /etc/caddy/olympus-site.caddy
install -d -m 0755 -o "${SUDO_USER:-relayadmin}" /srv/olympus-site
install -m 0644 "$SRC/Caddyfile" /etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile

# The privacy policy promises relay event logs are kept 14 days: journald
# holds them (the service logs to stdout), so cap its retention host-wide.
install -d -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=14day\n' > /etc/systemd/journald.conf.d/olympus-retention.conf
systemctl restart systemd-journald

systemctl daemon-reload
systemctl enable olympus-relay.service >/dev/null
systemctl restart olympus-relay.service
# A reload reaches the running Caddy over the admin address in the NEW
# config; the first deploy that moves admin from TCP to the Unix socket finds
# no socket yet, so it falls back to a restart (which also creates /run/caddy).
systemctl reload caddy || systemctl restart caddy

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    echo "olympus-relay ${SHORT} is answering on 127.0.0.1:8787"
    rm -rf "$SRC"
    exit 0
  fi
  sleep 1
done
echo "olympus-relay did not answer /healthz; journalctl -u olympus-relay shows why" >&2
systemctl --no-pager status olympus-relay.service >&2 || true
exit 1
