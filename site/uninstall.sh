#!/bin/sh
# Olympus uninstaller for macOS.
#
#   curl -fsSL https://olympusplugin.ai/uninstall.sh | sh
#
# Removes what https://olympusplugin.ai/install.sh put on this Mac, for the
# user running it (no administrator password):
#   - stops Olympus with launchctl and removes its login item
#     (~/Library/LaunchAgents/ai.olympusplugin.engine.plist), but only once
#     launchd confirms it no longer has the agent;
#   - takes the olympus:// link handler (Olympus.app in the folder below)
#     out of LaunchServices, so olympus:// links stop opening anything;
#   - deletes ~/Library/Application Support/Olympus (the app, the previous
#     app, the link handler and the Bun runtime the installer downloaded);
#   - deletes ~/.local/bin/olympus when the installer wrote it, and the one
#     PATH line the installer added to ~/.zprofile or ~/.bash_profile.
#
# It uses only the tools macOS ships: it never runs the downloaded Bun or
# anything else the installer put in place, which it cannot vouch for.
#
# It keeps your data and settings, and lists where they are. To delete your
# data too, run `olympus engine stop` and then `olympus data delete --all`
# BEFORE running this. ChatGPT stays linked to this Mac until you remove
# Olympus in ChatGPT or delete the data.
#
# Served as-is from site/uninstall.sh; it downloads nothing and runs nothing
# it downloaded.
set -eu

LAUNCHER_MARK='Written by the Olympus installer'
PATH_MARK='# Added by the Olympus installer'
# shellcheck disable=SC2016 # Shown as written in the profile.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH" # Added by the Olympus installer'
LABEL=ai.olympusplugin.engine

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }
die() {
  printf '\nOlympus was not uninstalled: %s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >&2; fi
  exit 1
}

# leave_line <file> <why>: say why the PATH line stays, and how to remove it.
leave_line() {
  step "Left $1 unchanged: $2"
  step "  To finish, delete this line from it yourself: $PATH_LINE"
}

# remove_marked_line <file>: drop the installer's PATH line, keep the rest.
# The rest is written to a new file beside it, checked, and renamed over the
# original in one step, so the profile is never left half-written. A profile
# that is a symbolic link or not this user's own file is left alone.
remove_marked_line() {
  profile=$1
  if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then return 0; fi
  found=0
  grep -qF "$PATH_MARK" "$profile" 2>/dev/null || found=$?
  case "$found" in
    0) ;;
    1) return 0 ;;
    *) leave_line "$profile" "it could not be read."; return 0 ;;
  esac
  if [ -L "$profile" ]; then
    leave_line "$profile" "it is a symbolic link."
    return 0
  fi
  if [ ! -f "$profile" ] || [ -z "$(find "$profile" -prune -user "$(id -u)" 2>/dev/null)" ]; then
    leave_line "$profile" "it is not a regular file of yours."
    return 0
  fi
  dir=$(dirname "$profile")
  if ! next=$(mktemp "$dir/.olympus-uninstall.XXXXXX" 2>/dev/null); then
    leave_line "$profile" "a new copy could not be written beside it."
    return 0
  fi
  # The new file takes the profile's permissions before its contents.
  kept=0
  if cp -p "$profile" "$next" 2>/dev/null; then
    grep -vF "$PATH_MARK" "$profile" > "$next" 2>/dev/null || kept=$?
  else
    kept=2
  fi
  # grep -v: 0 wrote lines, 1 wrote none (the profile held only that line), more is an error.
  total=$(grep -c '' "$profile" 2>/dev/null || true)
  marked=$(grep -cF "$PATH_MARK" "$profile" 2>/dev/null || true)
  left=$(grep -c '' "$next" 2>/dev/null || true)
  for count in "$total" "$marked" "$left"; do
    case "$count" in ''|*[!0-9]*) kept=2 ;; esac
  done
  if [ "$kept" -gt 1 ] || grep -qF "$PATH_MARK" "$next" 2>/dev/null || [ "$((left + marked))" != "$total" ]; then
    rm -f "$next"
    leave_line "$profile" "the new copy did not check out."
    return 0
  fi
  if ! mv -f "$next" "$profile"; then
    rm -f "$next"
    leave_line "$profile" "it could not be replaced."
    return 0
  fi
  step "Removed the Olympus PATH line from $profile."
}

# stop_agent: unload the agent with launchctl, whether or not its plist is
# still there, and go on only once launchd says it does not have it (113 or
# 3). Stopping the agent stops the engine, which stops the helpers it
# started. The engine can take several seconds to shut down (launchd allows
# 20 before it kills it), so wait up to 30: a 3-second wait refused to
# uninstall an engine that stopped a moment later (zigelbot, 2026-10-04).
stop_agent() {
  target="gui/$(id -u)/$LABEL"
  launchctl bootout "$target" >/dev/null 2>&1 || true
  tries=0
  while :; do
    printed=0
    launchctl print "$target" >/dev/null 2>&1 || printed=$?
    case "$printed" in 113|3) return 0 ;; esac
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || break
    [ "$tries" -ne 2 ] || say "  Stopping Olympus (this can take up to 30 seconds)..."
    sleep 1
  done
  die "Olympus could not be stopped, so nothing was removed." "launchctl still reports $target (status $printed). Restart the Mac, then run this again, or email support@olympusplugin.ai."
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "this uninstaller is for macOS."
  [ "$(id -u)" != "0" ] \
    || die "it was run as root (for example with sudo)." "Run it again as yourself, without sudo."
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then die "your home folder (\$HOME) was not found."; fi

  SUPPORT="$HOME/Library/Application Support/Olympus"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOGDIR="$HOME/Library/Logs/Olympus"
  LAUNCHER="$HOME/.local/bin/olympus"
  # The olympus:// link handler `olympus engine install` builds (src/core/open-handler.ts).
  HANDLER="$SUPPORT/Olympus.app"
  LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  # The engine's record of the helper processes it started (as it runs, with HOME only).
  CHILDREN="$HOME/.local/share/openclaw/olympus/engine/children.json"

  say "Uninstalling Olympus from this Mac."
  if [ -e "$PLIST" ] && [ ! -L "$PLIST" ] && [ ! -f "$PLIST" ]; then
    die "$PLIST is not a file, so nothing was removed." "Move it aside, then run this again."
  fi

  # 1. Stop it: always ask launchd, even with the app and plist gone.
  stop_agent
  if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
    rm -f "$PLIST"
    step "Stopped Olympus and removed its login item."
  else
    step "Olympus is not running."
  fi
  # The engine stops its helpers when launchd stops it. One that ended
  # without doing so (a crash) leaves them recorded; telling them apart from
  # unrelated processes needs the engine, which this does not run.
  if [ -f "$CHILDREN" ] && grep -q '"pgid"' "$CHILDREN" 2>/dev/null; then
    step "Some Olympus helper processes may still be running; log out or restart the Mac to clear them."
  fi

  # 2. Forget the olympus:// link handler, then remove the app, the runtime
  #    and the command. lsregister is macOS's own; a missing one is not fatal.
  if [ ! -L "$SUPPORT" ] && [ -d "$HANDLER" ] && [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -u "$HANDLER" >/dev/null 2>&1 || true
    step "Removed the olympus:// link handler."
  fi
  if [ -L "$SUPPORT" ]; then
    rm -f "$SUPPORT"
    step "Deleted the link $SUPPORT."
  elif [ -d "$SUPPORT" ]; then
    rm -rf "$SUPPORT"
    step "Deleted $SUPPORT."
  fi
  # Only the installer's own launcher: a real file carrying its mark.
  if [ ! -L "$LAUNCHER" ] && [ -f "$LAUNCHER" ] && grep -qF "$LAUNCHER_MARK" "$LAUNCHER" 2>/dev/null; then
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
