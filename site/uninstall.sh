#!/bin/sh
# Olympus uninstaller for macOS.
#
#   curl -fsSL https://olympusplugin.ai/uninstall.sh | sh
#
# Removes what https://olympusplugin.ai/install.sh put on this Mac, for the
# user running it (no administrator password):
#   - stops Olympus and removes its login item (`olympus engine uninstall`:
#     ~/Library/LaunchAgents/ai.olympusplugin.engine.plist);
#   - deletes ~/Library/Application Support/Olympus (the app, the previous
#     app and the Bun runtime the installer downloaded);
#   - deletes ~/.local/bin/olympus when the installer wrote it, and the one
#     PATH line the installer added to ~/.zprofile or ~/.bash_profile.
#
# It keeps your data and settings, and lists where they are. To delete your
# data too, run `olympus engine stop` and then `olympus data delete --all`
# BEFORE running this. ChatGPT stays linked to this Mac until you remove
# Olympus in ChatGPT or delete the data.
#
# Served as-is from site/uninstall.sh; it downloads and runs nothing.
set -eu

LAUNCHER_MARK='Written by the Olympus installer'
PATH_MARK='# Added by the Olympus installer'
LABEL=ai.olympusplugin.engine

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }
die() {
  printf '\nOlympus was not uninstalled: %s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >&2; fi
  exit 1
}

# remove_marked_line <file>: drop the installer's PATH line, keep the rest.
remove_marked_line() {
  [ -f "$1" ] && grep -qF "$PATH_MARK" "$1" || return 0
  grep -vF "$PATH_MARK" "$1" > "$1.olympus-uninstall" || true
  # Rewrite in place so a symlinked profile and its permissions survive.
  cat "$1.olympus-uninstall" > "$1"
  rm -f "$1.olympus-uninstall"
  step "Removed the Olympus PATH line from $1."
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "this uninstaller is for macOS."
  [ "$(id -u)" != "0" ] \
    || die "it was run as root (for example with sudo)." "Run it again as yourself, without sudo."
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then die "your home folder (\$HOME) was not found."; fi

  SUPPORT="$HOME/Library/Application Support/Olympus"
  APP="$SUPPORT/app"
  BUN="$SUPPORT/runtime/bun"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOGDIR="$HOME/Library/Logs/Olympus"
  LAUNCHER="$HOME/.local/bin/olympus"

  say "Uninstalling Olympus from this Mac."
  if [ -x "$BUN" ] && [ -f "$APP/dist/cli.js" ]; then
    mkdir -p "$LOGDIR"
    printf '\n== Olympus uninstaller, %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOGDIR/install.log"
    "$BUN" "$APP/dist/cli.js" engine uninstall >> "$LOGDIR/install.log" 2>&1 </dev/null \
      || die "Olympus could not be stopped, so nothing was removed." "Details are in $LOGDIR/install.log. Email support@olympusplugin.ai with that file."
    step "Stopped Olympus and removed its login item."
  elif [ -f "$PLIST" ]; then
    # The app is already gone: unload and remove the agent directly.
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    step "Stopped Olympus and removed its login item."
  else
    step "Olympus was not running from this installer's location."
  fi

  if [ -d "$SUPPORT" ]; then
    rm -rf "$SUPPORT"
    step "Deleted $SUPPORT."
  fi
  if [ -f "$LAUNCHER" ] && grep -qF "$LAUNCHER_MARK" "$LAUNCHER"; then
    rm -f "$LAUNCHER"
    step "Deleted the olympus command ($LAUNCHER)."
  fi
  remove_marked_line "$HOME/.zprofile"
  remove_marked_line "$HOME/.bash_profile"

  say ""
  say "Olympus is uninstalled. Your data and settings are still on this Mac:"
  for kept in \
    "$HOME/.olympus" \
    "$HOME/.config/olympus" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/openclaw/olympus" \
    "$LOGDIR"; do
    if [ -e "$kept" ]; then say "  $kept"; fi
  done
  say "Reinstalling Olympus picks them up again. To delete them, reinstall, run"
  say "olympus engine stop and then olympus data delete --all, and uninstall again."
  say "To disconnect ChatGPT, remove Olympus in ChatGPT."
}

main "$@"
