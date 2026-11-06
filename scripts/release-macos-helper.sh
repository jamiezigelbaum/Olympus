#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo 'Release helper verification requires macOS.' >&2; exit 1; }
expected_team=ND2P3ZTQRD
expected_bundle=ai.olympusplugin.engine-host
[ "${OLYMPUS_MACOS_HELPER_TEAM_ID:-$expected_team}" = "$expected_team" ] || { echo 'Signing team does not match the required team.' >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="$(bun "$root/scripts/macos-helper-name.ts" "$root")"
if [ "${1:-}" = --verify-existing ]; then
  [ "$#" -eq 5 ] && [ "$3" = --notary-submission ] || { echo 'Usage: --verify-existing <zip> --notary-submission <id> <out-dir>' >&2; exit 64; }
  zip="$2"
  submission="$4"
  out="$5"
  [ "$(basename "$zip")" = "$name" ] || { echo 'Helper name does not match source fingerprint.' >&2; exit 1; }
  [ -f "$zip" ] || { echo 'Helper zip not found.' >&2; exit 1; }
  zip="$(cd "$(dirname "$zip")" && pwd)/$(basename "$zip")"
  ditto -x -k "$zip" "$work/unpacked"
  app="$work/unpacked/Olympus Engine.app"
else
  [ "$#" -eq 1 ] || { echo 'Pass an output directory.' >&2; exit 64; }
  : "${OLYMPUS_MACOS_SIGNING_IDENTITY:?Set the Developer ID signing identity}"
  : "${OLYMPUS_MACOS_NOTARY_PROFILE:?Set the notary profile}"
  out="$1"
  "$root/scripts/build-macos-helper.sh" --out "$work" | tee "$work/build.log"
  submission="$(awk '/^[[:space:]]*id: / { print $2; exit }' "$work/build.log")"
  app="$work/Olympus Engine.app"
fi
[[ "$submission" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { echo 'A valid notary submission ID is required.' >&2; exit 1; }
[ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = "$expected_bundle" ] || { echo 'Helper bundle identifier does not match.' >&2; exit 1; }
codesign --verify --strict --deep "$app"
details="$(codesign -dvv "$app" 2>&1)"
printf '%s\n' "$details" | grep -Fx "Identifier=$expected_bundle" >/dev/null || { echo 'Signing identifier does not match.' >&2; exit 1; }
printf '%s\n' "$details" | grep -Fx "TeamIdentifier=$expected_team" >/dev/null || { echo 'Signing team does not match.' >&2; exit 1; }
assessment="$(spctl -a -t exec -vv "$app" 2>&1)" || { printf '%s\n' "$assessment" >&2; exit 1; }
printf '%s\n' "$assessment"
printf '%s\n' "$assessment" | grep -F 'source=Notarized Developer ID' >/dev/null || { echo 'Helper is not notarized.' >&2; exit 1; }
xcrun stapler validate "$app"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
if [ "${1:-}" != --verify-existing ]; then
  [ ! -e "$out/$name" ] || { echo "Refusing to overwrite $out/$name" >&2; exit 1; }
  ditto -c -k --keepParent "$app" "$work/$name"
  zip="$work/$name"
fi
[ ! -e "$out/$name.receipt.json" ] || { echo 'Refusing to overwrite receipt.' >&2; exit 1; }
if [ "$zip" != "$out/$name" ]; then
  [ ! -e "$out/$name" ] || { echo "Refusing to overwrite $out/$name" >&2; exit 1; }
  cp "$zip" "$out/$name"
fi
zip="$out/$name"
sha="$(shasum -a 256 "$zip" | cut -d ' ' -f 1)"
bytes="$(wc -c < "$zip" | tr -d ' ')"
bun -e 'const [path,name,sha256,bytes,team,bundleId,notarySubmissionId] = process.argv.slice(1); await Bun.write(path, JSON.stringify({name,sha256,bytes:Number(bytes),team,bundleId,notarySubmissionId,createdAt:new Date().toISOString()}, null, 2) + "\n");' "$zip.receipt.json" "$name" "$sha" "$bytes" "$expected_team" "$expected_bundle" "$submission"
printf 'Asset: %s\nSHA-256: %s\nBytes: %s\n' "$name" "$sha" "$bytes"
