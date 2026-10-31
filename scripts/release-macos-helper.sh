#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo 'Release helper builds require macOS.' >&2; exit 1; }
: "${OLYMPUS_MACOS_SIGNING_IDENTITY:?Set the Developer ID signing identity}"
: "${OLYMPUS_MACOS_NOTARY_PROFILE:?Set the notary profile}"
expected_team=ND2P3ZTQRD
[ "${OLYMPUS_MACOS_HELPER_TEAM_ID:-$expected_team}" = "$expected_team" ] || { echo 'Signing team does not match the required team.' >&2; exit 1; }
out="${1:?Pass an output directory}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$root/scripts/build-macos-helper.sh" --out "$work"
app="$work/Olympus Engine.app"
details="$(codesign -dvv "$app" 2>&1)"
printf '%s\n' "$details" | grep -Fx "TeamIdentifier=$expected_team" >/dev/null || { echo 'Signing team does not match.' >&2; exit 1; }
assessment="$(spctl -a -t exec -vv "$app" 2>&1)" || { printf '%s\n' "$assessment" >&2; exit 1; }
printf '%s\n' "$assessment"
printf '%s\n' "$assessment" | grep -F 'source=Notarized Developer ID' >/dev/null || { echo 'Helper is not notarized.' >&2; exit 1; }
xcrun stapler validate "$app"
name="$(bun "$root/scripts/macos-helper-name.ts" "$root")"
[ ! -e "$out/$name" ] || { echo "Refusing to overwrite $out/$name" >&2; exit 1; }
ditto -c -k --keepParent "$app" "$work/$name"
mv "$work/$name" "$out/$name"
printf 'Asset: %s\nSHA-256: %s\nBytes: %s\n' "$name" "$(shasum -a 256 "$out/$name" | cut -d ' ' -f 1)" "$(wc -c < "$out/$name" | tr -d ' ')"
