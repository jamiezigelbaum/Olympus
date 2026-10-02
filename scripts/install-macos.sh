#!/bin/sh
# Olympus standalone engine installer for macOS -- DRAFT.
#
# PENDING SIGNED PACKAGING: this draft installs the published npm package
# tarball and a Bun runtime, both verified by SHA-256. The product installer
# replaces it with a notarized, Developer ID-signed artifact (bun build
# --compile with hardened runtime + allow-jit, inside a stapled .pkg/zip) and
# `codesign --verify` / `spctl -a -t install` checks. Do not distribute this
# script as the public install path until that lands.
#
# Per-user only: no administrator password, nothing outside $HOME.
#   ~/Library/Application Support/Olympus/app           the Olympus package
#   ~/Library/Application Support/Olympus/app.previous  the one an upgrade replaced
#   ~/Library/Application Support/Olympus/runtime       Bun, when no suitable one is installed
#   ~/Library/LaunchAgents/ai.olympusplugin.engine.plist (via olympus engine install)
#
# Upgrades: the new package is swapped in, then `engine install --restart`
# reloads the agent so launchd runs the new build (the plist carries the build
# identity) and waits (up to 60 s) for proof that the engine runs that build
# and its worker answers; it exits non-zero without that proof. Then the
# previous package is put back, started again, and checked the same way with
# `engine verify` (the previous package's, or the new one's when the previous
# predates it). The installer says which of the two outcomes happened; a
# restore that fails is reported, never ignored. `olympus engine rollback`
# returns to app.previous later.
#
# Disk: after install, Olympus downloads its built-in search model (about
# 225 MB) and, on Apple-silicon Macs, a private answer model of 1.3 to 2.7 GB
# depending on memory (5.7 GB if the large one is chosen). The private model
# waits, and says so on the dashboard, while the disk has less than its size
# plus 2 GB free.
#
# Usage:
#   OLYMPUS_ARTIFACT_URL=https://.../olympus-<version>.tgz \
#   OLYMPUS_ARTIFACT_SHA256=<hex> \
#   sh scripts/install-macos.sh
#
# For a local checkout instead (development):
#   bun run build && bun dist/cli.js engine install --from-checkout "$PWD"
set -eu

die() { printf 'olympus install: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS."
[ "$(id -u)" != "0" ] || die "run as your own user, not root; Olympus installs per user."

ARTIFACT_URL=${OLYMPUS_ARTIFACT_URL:-}
ARTIFACT_SHA256=${OLYMPUS_ARTIFACT_SHA256:-}
[ -n "$ARTIFACT_URL" ] || die "set OLYMPUS_ARTIFACT_URL to the release tarball URL."
printf '%s' "$ARTIFACT_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die "set OLYMPUS_ARTIFACT_SHA256 to the tarball's lowercase SHA-256."
case "$ARTIFACT_URL" in https://*) ;; *) die "OLYMPUS_ARTIFACT_URL must be https." ;; esac

# Bun this script installs when no suitable one is on the Mac: pinned by
# version and by the SHA-256 of each release archive (from Bun's published
# SHASUMS256.txt and GitHub's asset digests for bun-v1.3.14, which agree).
BUN_VERSION=1.3.14
BUN_SHA256_DARWIN_AARCH64=d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620
BUN_SHA256_DARWIN_X64=4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633
# The oldest Bun the engine runs on; an older one on PATH is not used.
BUN_MIN_VERSION=1.3.0
SUPPORT="$HOME/Library/Application Support/Olympus"
APP="$SUPPORT/app"
RUNTIME="$SUPPORT/runtime"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/olympus-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# version_at_least <have> <want>: numeric major.minor.patch comparison.
version_at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    split(have, h, /[.+-]/); split(want, w, /[.+-]/)
    for (i = 1; i <= 3; i++) {
      if (h[i] !~ /^[0-9]+$/) exit 1
      if (h[i] + 0 > w[i] + 0) exit 0
      if (h[i] + 0 < w[i] + 0) exit 1
    }
    exit 0
  }'
}

usable_bun() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  have=$("$1" --version 2>/dev/null) || return 1
  version_at_least "$have" "$BUN_MIN_VERSION"
}

# 1. Bun first, so a failed download leaves the installed Olympus untouched.
BUN=""
for candidate in "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun" "$RUNTIME/bun"; do
  if usable_bun "$candidate"; then BUN=$candidate; break; fi
done
if [ -z "$BUN" ]; then
  case "$(uname -m)" in
    arm64) BUN_ZIP=bun-darwin-aarch64; BUN_SHA256=$BUN_SHA256_DARWIN_AARCH64 ;;
    x86_64) BUN_ZIP=bun-darwin-x64; BUN_SHA256=$BUN_SHA256_DARWIN_X64 ;;
    *) die "unsupported CPU $(uname -m)." ;;
  esac
  BUN_BASE="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  printf 'Downloading Bun %s...\n' "$BUN_VERSION"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/$BUN_ZIP.zip" "$BUN_BASE/$BUN_ZIP.zip"
  [ "$(sha256_of "$WORK/$BUN_ZIP.zip")" = "$BUN_SHA256" ] || die "Bun checksum mismatch; nothing was installed."
  (cd "$WORK" && unzip -q "$BUN_ZIP.zip")
  mkdir -p "$SUPPORT"
  chmod 700 "$SUPPORT"
  mkdir -p "$RUNTIME"
  mv "$WORK/$BUN_ZIP/bun" "$RUNTIME/bun.next"
  chmod 755 "$RUNTIME/bun.next"
  mv "$RUNTIME/bun.next" "$RUNTIME/bun"
  BUN="$RUNTIME/bun"
fi

# 2. Olympus package: download, verify, unpack beside the current one, swap.
printf 'Downloading Olympus...\n'
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/olympus.tgz" "$ARTIFACT_URL"
[ "$(sha256_of "$WORK/olympus.tgz")" = "$ARTIFACT_SHA256" ] || die "checksum mismatch for $ARTIFACT_URL; nothing was installed."
mkdir -p "$WORK/unpacked"
tar -xzf "$WORK/olympus.tgz" -C "$WORK/unpacked"
[ -f "$WORK/unpacked/package/dist/cli.js" ] || die "the tarball has no package/dist/cli.js."
mkdir -p "$SUPPORT"
chmod 700 "$SUPPORT"
rm -rf "$APP.next"
mv "$WORK/unpacked/package" "$APP.next"
UPGRADE=0
if [ -d "$APP" ]; then
  UPGRADE=1
  # The running engine was restarted onto $APP by the last install, so
  # app.previous is not in use and can go.
  rm -rf "$APP.previous"
  mv "$APP" "$APP.previous"
fi
mv "$APP.next" "$APP"

# 3. Register the per-user LaunchAgent and (re)start it on this build. The
#    plist names the build, so an upgrade reloads the agent; --restart covers
#    an agent loaded from an identical plist. The command succeeds only once
#    the engine proves this build healthy.
if ! "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" --restart; then
  if [ "$UPGRADE" = 1 ] && [ -d "$APP.previous" ]; then
    printf 'olympus install: the new version could not be started; restoring the previous one.\n' >&2
    rm -rf "$APP.failed"
    mv "$APP" "$APP.failed"
    mv "$APP.previous" "$APP"
    RESTORED=0
    # A previous version from before --restart reloads anyway: its plist differs.
    if "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" --restart >/dev/null 2>&1 \
      || "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" >/dev/null 2>&1; then
      # Proof, not launchd's word: the previous package's own `engine verify`,
      # or, when it predates that command, the new package's.
      if "$BUN" "$APP/dist/cli.js" engine verify >/dev/null 2>&1 \
        || "$BUN" "$APP.failed/dist/cli.js" engine verify >/dev/null 2>&1; then
        RESTORED=1
      fi
    fi
    rm -rf "$APP.failed"
    if [ "$RESTORED" = 1 ]; then
      die "the new version could not be started; the previous version was restored and is running. See olympus engine logs."
    fi
    die "the new version could not be started, and the restored previous version did not come back healthy either. See olympus engine logs."
  fi
  die "the engine could not be started; see olympus engine logs."
fi
printf '\nOlympus is installed and running. Check it with:\n  "%s" "%s/dist/cli.js" engine status\n' "$BUN" "$APP"
