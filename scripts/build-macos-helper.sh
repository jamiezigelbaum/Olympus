#!/bin/bash
# Build, bundle and sign the Olympus engine host (native/macos-engine-host):
# the small app macOS names when the engine asks to read Desktop, Documents,
# Downloads, iCloud Drive or a removable or network volume.
#
#   OLYMPUS_MACOS_SIGNING_IDENTITY="Developer ID Application: ..." \
#     scripts/build-macos-helper.sh --out "<dir>"
#
# The identity comes from the environment (a keychain name or SHA-1) and is
# never stored in the repository. Public builds use the organisation's
# Developer ID; a local build may use whichever identity the keychain holds.
# macOS keeps a folder grant against the signing identity and bundle id, so
# re-signing with the same identity keeps it. Without an identity the script
# stops; --adhoc makes an unsigned-identity bundle for tests only (its grants
# do not survive a rebuild).
#
# Notarization is optional: set OLYMPUS_MACOS_NOTARY_PROFILE to a
# `xcrun notarytool store-credentials` profile name to submit and staple.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/native/macos-engine-host"
out=""
adhoc=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    --adhoc) adhoc=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done
[ -n "$out" ] || { echo "Pass --out <directory> for the built app." >&2; exit 64; }

identity="${OLYMPUS_MACOS_SIGNING_IDENTITY:-}"
if [ -z "$identity" ] && [ "$adhoc" -ne 1 ]; then
  echo "Set OLYMPUS_MACOS_SIGNING_IDENTITY to a Developer ID Application identity (or pass --adhoc for a test-only build)." >&2
  exit 64
fi
[ "$(uname -s)" = "Darwin" ] || { echo "The engine host is built on macOS." >&2; exit 64; }

app="$out/Olympus Engine.app"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/Olympus Engine.app/Contents/MacOS"
clang -O2 -Wall -Werror -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -o "$work/Olympus Engine.app/Contents/MacOS/OlympusEngineHost" "$src/main.c"
cp "$src/Info.plist.in" "$work/Olympus Engine.app/Contents/Info.plist"
plutil -lint "$work/Olympus Engine.app/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$work/Olympus Engine.app/Contents/PkgInfo"

if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" \
    --identifier ai.olympusplugin.engine-host "$work/Olympus Engine.app"
else
  codesign --force --sign - --identifier ai.olympusplugin.engine-host "$work/Olympus Engine.app"
fi
codesign --verify --strict --deep "$work/Olympus Engine.app"

if [ -n "${OLYMPUS_MACOS_NOTARY_PROFILE:-}" ] && [ -n "$identity" ]; then
  ditto -c -k --keepParent "$work/Olympus Engine.app" "$work/notarize.zip"
  xcrun notarytool submit "$work/notarize.zip" --keychain-profile "$OLYMPUS_MACOS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$work/Olympus Engine.app"
fi

mkdir -p "$out"
rm -rf "$app"
ditto "$work/Olympus Engine.app" "$app"
echo "$app"
