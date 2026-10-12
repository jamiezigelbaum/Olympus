#!/bin/sh
# DRAFT: receipt-bounded Linux CLI removal. Full system-tools-only recovery
# (including missing Bun/app) is PR 3c's remaining work, not claimed here.
# Never source the receipt, execute an unverified package, or guess paths to rm.
# Guard chains intentionally refuse when ANY prerequisite is false.
# shellcheck disable=SC2015
set -eu

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "Olympus removal is incomplete: $*" >&2; exit 1; }
sha256_of() { sha256sum "$1" | awk '{print $1}'; }
check_path() {
  case "$1" in /*) ;; *) die "Receipt paths must be absolute: $1" ;; esac
  case "$1" in *'
'*|*'	'*|*/../*|*/./*|*/..|*/.|*//*) die "Unsafe receipt path: $1" ;; esac
  path=$1
  while [ "$path" != / ]; do
    [ ! -L "$path" ] || die "Symbolic link refused: $path"
    if [ -e "$path" ]; then
      owner=$(stat -c %u "$path")
      [ "$owner" = "$USER_ID" ] || [ "$owner" = 0 ] || die "Foreign-owned path: $path"
      if [ -n "$(find "$path" -maxdepth 0 -perm /022 -print)" ]; then
        [ "$owner" = 0 ] && [ -d "$path" ] && [ -k "$path" ] || die "Writable by other users: $path"
      fi
    fi
    path=$(dirname "$path")
  done
}
# Fixed, non-executable TSV projection of SVC's private receipt. SVC validates
# its canonical receipt and exact generation again under the same lock.
field() { awk -F '\t' -v key="$1" '$1==key {print $2}' "$RECEIPT"; }

main() {
  [ "$#" = 0 ] || die 'This draft keeps data. Explicit purge and linger restoration require the completed PR 3c removal contract.'
  missing=''
  for tool in uname id stat sha256sum awk grep find dirname flock systemctl; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    say "Missing required tools:$missing" >&2
    say 'Arch / Omarchy: sudo pacman -S --needed coreutils findutils gawk grep util-linux systemd' >&2
    say 'Ubuntu: sudo apt install coreutils findutils gawk grep util-linux systemd' >&2
    die 'Install the missing packages and retry; nothing was removed.'
  fi
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die 'This draft supports Linux x64 only; arm64 is unavailable.'
  USER_ID=$(id -u)
  [ "$USER_ID" != 0 ] || die 'Run as yourself, without sudo.'
  flock --version | grep -q util-linux || die 'util-linux flock is required.'
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die 'Your home directory was not found.'
  CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
  check_path "$CONFIG/olympus/uninstall-receipt.tsv"
  RECEIPT="$CONFIG/olympus/uninstall-receipt.tsv"
  if [ "$CONFIG" != "$HOME/.config" ] && [ -e "$HOME/.config/olympus/uninstall-receipt.tsv" ]; then
    die "Ambiguous receipts: $RECEIPT and $HOME/.config/olympus/uninstall-receipt.tsv. Select the original installation; nothing was removed."
  fi
  [ -f "$RECEIPT" ] && [ "$(stat -c %u "$RECEIPT")" = "$USER_ID" ] && [ "$(stat -c %a "$RECEIPT")" = 600 ] \
    || die "A private owned receipt is required at $RECEIPT; nothing was removed."
  # Exactly these keys, once each, two fields; unknown/duplicate records refuse.
  awk -F '\t' 'BEGIN {n=split("schema uid bun bun_sha256 cli cli_sha256 config_root data_root state_root cache_root linger_before",keys," "); for(i=1;i<=n;i++) allowed[keys[i]]=1}
    NF!=2 || !allowed[$1] || seen[$1]++ || $2=="" || $2 ~ /[[:cntrl:]]/ {bad=1}
    END {if(NR!=n) bad=1; exit bad}' "$RECEIPT" || die 'Malformed or ambiguous removal receipt; nothing was removed.'
  [ "$(field schema)" = olympus.linux-uninstall.v1 ] && [ "$(field uid)" = "$USER_ID" ] || die 'Foreign or unsupported removal receipt.'
  [ "$(field config_root)" = "$CONFIG" ] || die 'Receipt config root disagrees with discovery.'
  BUN=$(field bun)
  CLI=$(field cli)
  XDG_CONFIG_HOME=$CONFIG
  XDG_DATA_HOME=$(field data_root)
  XDG_STATE_HOME=$(field state_root)
  XDG_CACHE_HOME=$(field cache_root)
  export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
  for root in "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"; do check_path "$root"; done
  case "$BUN" in "$XDG_DATA_HOME/olympus/engine/"*) ;; *) die 'Runtime is outside the receipt engine root.' ;; esac
  case "$CLI" in "$XDG_DATA_HOME/olympus/engine/"*/dist/cli.js) ;; *) die 'CLI is outside the receipt engine root.' ;; esac
  for file in "$BUN" "$CLI"; do
    check_path "$file"
    [ -f "$file" ] && [ "$(stat -c %u "$file")" = "$USER_ID" ] \
      || die "Missing/unowned runtime or app: $file. This draft cannot perform Bun-free removal; retained all artifacts and data."
  done
  for key in bun_sha256 cli_sha256; do
    field "$key" | grep -Eq '^[0-9a-f]{64}$' || die 'Invalid executable digest in receipt.'
  done
  [ "$(sha256_of "$BUN")" = "$(field bun_sha256)" ] && [ "$(sha256_of "$CLI")" = "$(field cli_sha256)" ] \
    || die 'An installed executable was replaced or corrupted; it was not executed and nothing was removed.'
  case "$(field linger_before)" in yes|no) ;; *) die 'Unknown prior linger state.' ;; esac
  [ -n "${XDG_RUNTIME_DIR:-}" ] || die 'A working user session and XDG_RUNTIME_DIR are required.'
  check_path "$XDG_RUNTIME_DIR/olympus/lifecycle.lock"
  for dir in "$XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR/olympus"; do
    [ -d "$dir" ] && [ "$(stat -c %u "$dir")" = "$USER_ID" ] && [ "$(stat -c %a "$dir")" = 700 ] || die "Unsafe runtime directory: $dir"
  done
  LOCK="$XDG_RUNTIME_DIR/olympus/lifecycle.lock"
  [ -f "$LOCK" ] && [ "$(stat -c %u "$LOCK")" = "$USER_ID" ] && [ "$(stat -c %a "$LOCK")" = 600 ] || die 'Missing/unsafe lifecycle lock; nothing was removed.'
  systemctl --user show-environment >/dev/null 2>&1 || die 'The user manager is unavailable; nothing was removed.'
  say 'Removing receipt-owned machinery. Personal data, settings, secrets and account-wide linger will be kept.'
  # SVC seam: uninstall revalidates receipt and custody while locked, refuses
  # unknown custody, retains replacements, deletes only enumerated machinery,
  # and returns nonzero for incomplete cleanup. Never unlink the lock inode.
  trap '' HUP INT TERM
  result=0
  flock --nonblock --close "$LOCK" "$BUN" --no-env-file "$CLI" engine uninstall || result=$?
  trap - HUP INT TERM
  [ "$result" = 0 ] || die "Lifecycle removal failed (status $result); see the engine's recovery report."
  say 'Olympus machinery was removed. Data and settings were kept under:'
  say "  $XDG_CONFIG_HOME/olympus (including encrypted secrets and wrapping key)"
  say "  $XDG_DATA_HOME/openclaw/olympus"
  say "  $XDG_STATE_HOME/olympus/engine"
  say "  $XDG_CACHE_HOME/olympus/engine"
  say "The inert lock remains at $LOCK until the user runtime directory is torn down at logout/reboot."
  say 'Linger was preserved. Restoring it is an explicit account-wide decision affecting other services.'
  say 'OS journal metadata may remain. To disconnect ChatGPT, remove Olympus in ChatGPT; provider revocation is not claimed.'
}

main "$@"
