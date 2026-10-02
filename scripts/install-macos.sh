#!/bin/sh
# Olympus installer for macOS.
#
#   curl -fsSL https://olympusplugin.ai/install.sh | sh
#
# This file is the template. scripts/publish-release-to-site.ts writes the
# release pins (version, SHA-256 and size of the release tarball) into the
# OLYMPUS_* lines below and writes the result to site/install.sh, served as
# https://olympusplugin.ai/install.sh next to the tarball at
# https://olympusplugin.ai/releases/<version>/olympus-<version>.tgz.
# The template itself refuses to run.
#
# What it does, for the user running it only (no administrator password,
# nothing written outside $HOME):
#   1. Checks the Mac: macOS 13 or later on Apple silicon. Intel Macs are
#      refused: the built-in models Olympus 1.0 depends on ship for Apple
#      silicon only.
#   2. Downloads Bun (the JavaScript runtime Olympus runs on) and the Olympus
#      release, over HTTPS only, and checks each against the SHA-256 pinned in
#      this file. Nothing downloaded runs, and nothing on the Mac changes,
#      until both match.
#   3. Puts them in place:
#        ~/Library/Application Support/Olympus/runtime/bun     pinned Bun
#        ~/Library/Application Support/Olympus/app             Olympus
#        ~/Library/Application Support/Olympus/app.previous    the version an upgrade replaced
#        ~/.local/bin/olympus                                   the `olympus` command
#      and, when ~/.local/bin is not on PATH, adds one marked line to
#      ~/.zprofile (zsh) or ~/.bash_profile (bash). OLYMPUS_NO_MODIFY_PATH=1
#      skips that.
#   4. Runs `olympus engine install --restart`, which registers the per-user
#      LaunchAgent (~/Library/LaunchAgents/ai.olympusplugin.engine.plist),
#      starts the engine on this build and waits (up to 60 s) for proof that
#      the engine runs it and is healthy. It exits non-zero without that proof.
#      Its output goes to ~/Library/Logs/Olympus/install.log.
#
# Re-running is safe. The same release again checks the engine and repairs it
# when needed; it does not touch app.previous. A new release is an upgrade:
# the new package is swapped in and the engine restarted on it. If the new
# version does not prove healthy, the previous package is put back, started
# again, and checked with `engine verify` (the previous package's, or the new
# one's when the previous predates it). The installer says which of the two
# outcomes happened; a restore that fails is reported, never ignored.
# `olympus engine rollback` returns to app.previous later.
#
# Disk: after install, Olympus downloads its built-in search model (about
# 225 MB) and a private answer model of 1.3 to 2.7 GB depending on memory
# (5.7 GB if the large one is chosen). The private model waits, and says so on
# the dashboard, while the disk has less than its size plus 2 GB free.
#
# Uninstall: curl -fsSL https://olympusplugin.ai/uninstall.sh | sh
# (source: site/uninstall.sh). It keeps your data; see that script.
#
# For a local checkout instead (development):
#   bun run build && bun dist/cli.js engine install --from-checkout "$PWD"
#
# The whole installer runs from one function called on the last line, so a
# download cut short runs nothing.
set -eu

# Release pins, written by scripts/publish-release-to-site.ts.
OLYMPUS_VERSION=@OLYMPUS_VERSION@
OLYMPUS_SHA256=@OLYMPUS_SHA256@
OLYMPUS_BYTES=@OLYMPUS_BYTES@
RELEASE_BASE=https://olympusplugin.ai/releases

# Bun, pinned by version and by the SHA-256 and size of its Apple-silicon
# release archive (from Bun's published SHASUMS256.txt and GitHub's asset
# digest for bun-v1.3.14, which agree). Bun 1.3.14 needs macOS 13 or later.
BUN_VERSION=1.3.14
BUN_SHA256_DARWIN_AARCH64=d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620
BUN_BYTES_DARWIN_AARCH64=23586433
BUN_BASE=https://github.com/oven-sh/bun/releases/download
MACOS_MIN_MAJOR=13

SUPPORT_EMAIL=support@olympusplugin.ai
UNINSTALL_COMMAND='curl -fsSL https://olympusplugin.ai/uninstall.sh | sh'
LAUNCHER_MARK='Written by the Olympus installer'
PATH_MARK='# Added by the Olympus installer'

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }
die() {
  printf '\nOlympus was not installed: %s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >&2; fi
  exit 1
}
# The same, for failures after the new version is in place.
fail() {
  printf '\n%s\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" >&2; fi
  exit 1
}

# megabytes <bytes>: "23 MB".
megabytes() { awk -v b="$1" 'BEGIN { printf "%d MB", (b / 1000000) + 0.5 }'; }
sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
bytes_of() { wc -c < "$1" | tr -d ' '; }

# fetch <url> <file>: HTTPS only, TLS 1.2 or later, fail on HTTP errors.
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1"; }

check_mac() {
  [ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS."
  [ "$(id -u)" != "0" ] \
    || die "it was run as root (for example with sudo)." "Run it again as yourself, without sudo: Olympus installs for your user only."
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then die "your home folder (\$HOME) was not found."; fi

  arch=$(uname -m)
  if [ "$arch" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    # An Apple-silicon Mac running this Terminal under Rosetta.
    arch=arm64
  fi
  case "$arch" in
    arm64) ;;
    x86_64) die "this Mac has an Intel processor." "Olympus needs a Mac with Apple silicon (M1 or later). Nothing was changed on this Mac." ;;
    *) die "this Mac's processor ($arch) is not supported." "Olympus needs a Mac with Apple silicon (M1 or later). Nothing was changed on this Mac." ;;
  esac

  macos=$(sw_vers -productVersion 2>/dev/null || echo 0)
  major=${macos%%.*}
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  [ "$major" -ge "$MACOS_MIN_MAJOR" ] \
    || die "this Mac runs macOS $macos." "Olympus needs macOS $MACOS_MIN_MAJOR (Ventura) or later. Update macOS in System Settings, then run this again."

  for tool in curl shasum tar unzip awk; do
    command -v "$tool" >/dev/null 2>&1 || die "the $tool command is missing from this Mac."
  done
}

main() {
  case "$OLYMPUS_VERSION$OLYMPUS_SHA256$OLYMPUS_BYTES" in
    *@*) die "this is the installer template, not a release." "Use the published installer: curl -fsSL https://olympusplugin.ai/install.sh | sh" ;;
  esac
  printf '%s' "$OLYMPUS_SHA256" | grep -Eq '^[0-9a-f]{64}$' || die "the installer's release checksum is malformed."
  case "$OLYMPUS_BYTES" in ''|*[!0-9]*) die "the installer's release size is malformed." ;; esac

  say "Installing Olympus $OLYMPUS_VERSION for $(id -un 2>/dev/null || echo you) on this Mac."
  say "It needs no administrator password and changes nothing outside your home folder."
  say ""
  check_mac
  step "This Mac is supported (Apple silicon, macOS $macos)."

  SUPPORT="$HOME/Library/Application Support/Olympus"
  APP="$SUPPORT/app"
  RUNTIME="$SUPPORT/runtime"
  BUN="$RUNTIME/bun"
  LOGDIR="$HOME/Library/Logs/Olympus"
  LOG="$LOGDIR/install.log"
  RECEIPT_NAME=.olympus-release-sha256
  ARTIFACT="olympus-$OLYMPUS_VERSION.tgz"
  ARTIFACT_URL="$RELEASE_BASE/$OLYMPUS_VERSION/$ARTIFACT"

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/olympus-install.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  trap 'rm -rf "$WORK"; exit 130' INT TERM

  # 1. Download and verify everything before changing anything.
  NEED_BUN=1
  if [ -x "$BUN" ] && [ "$("$BUN" --version 2>/dev/null </dev/null || true)" = "$BUN_VERSION" ]; then
    NEED_BUN=0
  fi
  if [ "$NEED_BUN" = 1 ]; then
    step "Downloading Bun $BUN_VERSION, the runtime Olympus uses ($(megabytes "$BUN_BYTES_DARWIN_AARCH64"))..."
    fetch "$BUN_BASE/bun-v$BUN_VERSION/bun-darwin-aarch64.zip" "$WORK/bun.zip" \
      || die "Bun could not be downloaded." "Check the internet connection and run this again. Nothing was changed on this Mac."
    [ "$(sha256_of "$WORK/bun.zip")" = "$BUN_SHA256_DARWIN_AARCH64" ] \
      || die "the Bun download did not match its checksum, so it was not used." "Nothing was changed on this Mac. Run this again; if it happens again, email $SUPPORT_EMAIL."
    (cd "$WORK" && unzip -q bun.zip) || die "the Bun download could not be unpacked."
    [ -f "$WORK/bun-darwin-aarch64/bun" ] || die "the Bun download has no bun program in it."
  fi

  step "Downloading Olympus $OLYMPUS_VERSION ($(megabytes "$OLYMPUS_BYTES"))..."
  fetch "$ARTIFACT_URL" "$WORK/$ARTIFACT" \
    || die "Olympus could not be downloaded from $ARTIFACT_URL." "Check the internet connection and run this again. Nothing was changed on this Mac."
  if [ "$(sha256_of "$WORK/$ARTIFACT")" != "$OLYMPUS_SHA256" ] || [ "$(bytes_of "$WORK/$ARTIFACT")" != "$OLYMPUS_BYTES" ]; then
    die "the Olympus download did not match its checksum, so it was not used." "Nothing was changed on this Mac. Run this again; if it happens again, email $SUPPORT_EMAIL."
  fi
  mkdir "$WORK/unpacked"
  tar -xzf "$WORK/$ARTIFACT" -C "$WORK/unpacked" || die "the Olympus download could not be unpacked."
  [ -f "$WORK/unpacked/package/dist/cli.js" ] || die "the Olympus download has no dist/cli.js."
  printf '%s\n' "$OLYMPUS_SHA256" > "$WORK/unpacked/package/$RECEIPT_NAME"
  step "Both downloads match their published checksums."

  # 2. Put the runtime in place. A running engine keeps the Bun it started
  #    with: the file is replaced by rename, never rewritten in place.
  mkdir -p "$SUPPORT" "$LOGDIR"
  chmod 700 "$SUPPORT" "$LOGDIR"
  printf '\n== Olympus installer %s, %s\n' "$OLYMPUS_VERSION" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG"
  if [ "$NEED_BUN" = 1 ]; then
    mkdir -p "$RUNTIME"
    mv "$WORK/bun-darwin-aarch64/bun" "$RUNTIME/bun.next"
    chmod 755 "$RUNTIME/bun.next"
    mv "$RUNTIME/bun.next" "$BUN"
  fi

  # 3. The same release again: check the engine, and repair it if needed.
  if [ -f "$APP/$RECEIPT_NAME" ] && [ "$(cat "$APP/$RECEIPT_NAME")" = "$OLYMPUS_SHA256" ]; then
    step "Olympus $OLYMPUS_VERSION is already installed. Checking that it is running..."
    if ! "$BUN" "$APP/dist/cli.js" engine verify >> "$LOG" 2>&1 </dev/null; then
      step "Starting Olympus in the background (this can take up to a minute)..."
      "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" --restart >> "$LOG" 2>&1 </dev/null \
        || fail "Olympus is installed but did not start." "Details are in $LOG. Run this again, or email $SUPPORT_EMAIL with that file."
    fi
    finish
    return 0
  fi

  # 4. Install or upgrade: unpack beside the current version, then swap.
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

  # 5. Register the per-user LaunchAgent and (re)start it on this build. The
  #    plist names the build, so an upgrade reloads the agent; --restart covers
  #    an agent loaded from an identical plist. The command succeeds only once
  #    the engine proves this build healthy.
  step "Starting Olympus in the background (this can take up to a minute)..."
  if ! "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" --restart >> "$LOG" 2>&1 </dev/null; then
    if [ "$UPGRADE" = 1 ] && [ -d "$APP.previous" ]; then
      step "The new version did not start; restoring the previous one..."
      rm -rf "$APP.failed"
      mv "$APP" "$APP.failed"
      mv "$APP.previous" "$APP"
      RESTORED=0
      # A previous version from before --restart reloads anyway: its plist differs.
      if "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" --restart >> "$LOG" 2>&1 </dev/null \
        || "$BUN" "$APP/dist/cli.js" engine install --bun "$BUN" >> "$LOG" 2>&1 </dev/null; then
        # Proof, not launchd's word: the previous package's own `engine verify`,
        # or, when it predates that command, the new package's.
        if "$BUN" "$APP/dist/cli.js" engine verify >> "$LOG" 2>&1 </dev/null \
          || "$BUN" "$APP.failed/dist/cli.js" engine verify >> "$LOG" 2>&1 </dev/null; then
          RESTORED=1
        fi
      fi
      rm -rf "$APP.failed"
      if [ "$RESTORED" = 1 ]; then
        fail "Olympus $OLYMPUS_VERSION could not be started, so the previous version was restored and is running." "Details are in $LOG. Email $SUPPORT_EMAIL with that file."
      fi
      fail "Olympus $OLYMPUS_VERSION could not be started, and the restored previous version did not come back healthy either." "Details are in $LOG. Email $SUPPORT_EMAIL with that file."
    fi
    fail "Olympus is installed but did not start." "Details are in $LOG. Run this again, or email $SUPPORT_EMAIL with that file."
  fi
  finish
}

# The `olympus` command, and PATH so that a new Terminal window finds it.
install_command() {
  BIN_DIR="$HOME/.local/bin"
  LAUNCHER="$BIN_DIR/olympus"
  COMMAND_READY=0
  if [ -e "$LAUNCHER" ] && ! grep -qF "$LAUNCHER_MARK" "$LAUNCHER" 2>/dev/null; then
    step "Left $LAUNCHER alone: this installer did not write it."
    return 0
  fi
  mkdir -p "$BIN_DIR"
  # $HOME expands when the command runs, so the file needs no path quoting.
  cat > "$LAUNCHER.next" <<'LAUNCHER'
#!/bin/sh
# Written by the Olympus installer (https://olympusplugin.ai/install.sh).
# The uninstaller (https://olympusplugin.ai/uninstall.sh) removes it.
exec "$HOME/Library/Application Support/Olympus/runtime/bun" "$HOME/Library/Application Support/Olympus/app/dist/cli.js" "$@"
LAUNCHER
  chmod 755 "$LAUNCHER.next"
  mv "$LAUNCHER.next" "$LAUNCHER"
  COMMAND_READY=1
  case ":${PATH:-}:" in *":$BIN_DIR:"*) return 0 ;; esac
  if [ "${OLYMPUS_NO_MODIFY_PATH:-}" = 1 ]; then COMMAND_READY=0; return 0; fi
  case "${SHELL:-/bin/zsh}" in
    */zsh) PROFILE="$HOME/.zprofile" ;;
    */bash) PROFILE="$HOME/.bash_profile" ;;
    *) COMMAND_READY=0; return 0 ;;
  esac
  if ! grep -qF "$PATH_MARK" "$PROFILE" 2>/dev/null; then
    # shellcheck disable=SC2016 # $HOME and $PATH expand when the profile runs.
    printf '\nexport PATH="$HOME/.local/bin:$PATH" %s\n' "$PATH_MARK" >> "$PROFILE"
    step "Added ~/.local/bin to your PATH in $PROFILE."
  fi
}

finish() {
  install_command
  say ""
  say "Olympus is installed and running in the background on this Mac."
  say ""
  say "Next, in ChatGPT:"
  say "  In ChatGPT desktop, add the Olympus plugin and ask: Connect Olympus"
  say "  A page opens in your browser on this Mac. Click Approve."
  say ""
  say "Olympus now downloads its built-in models in the background (about"
  say "225 MB, then 1.3 to 2.7 GB for its private answer model)."
  if [ "$COMMAND_READY" = 1 ]; then
    say "To check on it later, open a new Terminal window and run: olympus engine status"
  else
    say "To check on it later, run: \"$BUN\" \"$APP/dist/cli.js\" engine status"
  fi
  say "To uninstall: $UNINSTALL_COMMAND"
}

main "$@"
