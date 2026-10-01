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
#   ~/Library/Application Support/Olympus/app       the Olympus package
#   ~/Library/Application Support/Olympus/runtime   Bun, when none is installed
#   ~/Library/LaunchAgents/ai.olympusplugin.engine.plist (via olympus engine install)
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

BUN_VERSION=${OLYMPUS_BUN_VERSION:-1.3.14}
SUPPORT="$HOME/Library/Application Support/Olympus"
APP="$SUPPORT/app"
RUNTIME="$SUPPORT/runtime"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/olympus-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# 1. Olympus package: download, verify, unpack beside the current one, swap.
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
if [ -d "$APP" ]; then rm -rf "$APP.previous"; mv "$APP" "$APP.previous"; fi
mv "$APP.next" "$APP"

# 2. Bun: use an installed one, else fetch the official release and check it
#    against Bun's published SHASUMS256.txt.
BUN=$(command -v bun 2>/dev/null || true)
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  case "$(uname -m)" in
    arm64) BUN_ZIP=bun-darwin-aarch64 ;;
    x86_64) BUN_ZIP=bun-darwin-x64 ;;
    *) die "unsupported CPU $(uname -m)." ;;
  esac
  BUN_BASE="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  printf 'Downloading Bun %s...\n' "$BUN_VERSION"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/$BUN_ZIP.zip" "$BUN_BASE/$BUN_ZIP.zip"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/SHASUMS256.txt" "$BUN_BASE/SHASUMS256.txt"
  EXPECTED=$(awk -v f="$BUN_ZIP.zip" '$2 == f {print $1}' "$WORK/SHASUMS256.txt")
  [ -n "$EXPECTED" ] && [ "$(sha256_of "$WORK/$BUN_ZIP.zip")" = "$EXPECTED" ] || die "Bun checksum mismatch; nothing was installed."
  (cd "$WORK" && unzip -q "$BUN_ZIP.zip")
  mkdir -p "$RUNTIME"
  mv "$WORK/$BUN_ZIP/bun" "$RUNTIME/bun"
  chmod 755 "$RUNTIME/bun"
  BUN="$RUNTIME/bun"
fi

# 3. Register and start the per-user LaunchAgent (idempotent).
"$BUN" "$APP/dist/cli.js" engine install --bun "$BUN"
printf '\nOlympus is installed. Check it with:\n  "%s" "%s/dist/cli.js" engine status\n' "$BUN" "$APP"
