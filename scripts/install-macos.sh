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
# Re-running is safe. The same release again checks that the installed files
# are exactly the verified download (replacing them from it when they are
# not) and that the engine runs this build (restarting it when it does not);
# it does not touch app.previous. A new release is an upgrade: the new package
# is swapped in and the engine restarted on it. If the new version does not
# prove healthy, the previous package is put back, started again, and checked
# with `engine verify` (the previous package's, or the new one's when the
# previous predates it). The installer says which of the two outcomes
# happened; a restore that fails is reported, never ignored.
# `olympus engine rollback` returns to app.previous later.
#
# Safety: every folder the installer manages must be a real folder owned by
# the user running it (never a symbolic link), checked before anything cached
# runs or anything changes. The installed Bun runs only when it matches the
# SHA-256 pinned below (and is made executable when it is not). One installer
# runs at a time: it holds a lock on a file through the system's lockf, which
# the operating system releases when the installer's process ends, however it
# ends, so there is never a stale lock to take over. An upgrade records,
# under its own random transaction id, that it is swapping folders before the
# first rename; if it stops partway (an error, Ctrl-C, a power cut), the
# previous version is put back, then or on the next run. Only the installer
# that holds the lock and wrote that record ever acts on it; a later
# installer finishes an interrupted one only after taking the lock, when the
# installer that wrote it is provably gone.
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
# digest for bun-v1.3.14, which agree), and by the SHA-256 of the bun program
# inside that archive, which an already-installed Bun must match before it
# runs (`bun scripts/publish-release-to-site.ts --pin-bun <zip>` computes it
# from the pinned archive). Bun 1.3.14 needs macOS 13 or later.
BUN_VERSION=1.3.14
BUN_SHA256_DARWIN_AARCH64=d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620
BUN_BYTES_DARWIN_AARCH64=23586433
BUN_EXE_SHA256_DARWIN_AARCH64=e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233
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

  for tool in curl shasum tar unzip awk cmp diff find ps od mkfifo; do
    command -v "$tool" >/dev/null 2>&1 || die "the $tool command is missing from this Mac."
  done
  # The lock: macOS's own lockf. (Only a system without /usr/bin/lockf, such
  # as a test machine, finds one on PATH.)
  if [ -x /usr/bin/lockf ]; then
    LOCKF=/usr/bin/lockf
  else
    LOCKF=$(command -v lockf 2>/dev/null) || die "the lockf command is missing from this Mac."
  fi
}

# --- The folders the installer manages -------------------------------------

# is_mine <path>: the path itself (a link is not followed) belongs to this user.
is_mine() { [ -n "$(find "$1" -prune -user "$USER_ID" 2>/dev/null)" ]; }

refuse_layout() {
  die "$1" "Olympus installs only into real folders (not symbolic links) that belong to you. Move that aside, then run this again."
}

# check_dir <path>: absent, or a real folder owned by this user.
check_dir() {
  if [ -L "$1" ]; then refuse_layout "$1 is a symbolic link."; fi
  [ -e "$1" ] || return 0
  [ -d "$1" ] || refuse_layout "$1 is not a folder."
  is_mine "$1" || refuse_layout "$1 belongs to another user."
}

# check_file <path>: absent, or a regular file owned by this user.
check_file() {
  if [ -L "$1" ]; then refuse_layout "$1 is a symbolic link."; fi
  [ -e "$1" ] || return 0
  [ -f "$1" ] || refuse_layout "$1 is not a regular file."
  is_mine "$1" || refuse_layout "$1 belongs to another user."
}

# Every managed folder and file, from the home folder down. Runs before
# anything cached is executed and before anything changes, and again under
# the lock.
check_layout() {
  for dir in "$HOME/Library" "$HOME/Library/Application Support" "$SUPPORT" \
    "$APP" "$APP.next" "$APP.previous" "$APP.failed" "$RUNTIME" \
    "$HOME/Library/Logs" "$LOGDIR" "$HOME/.local" "$HOME/.local/bin"; do
    check_dir "$dir"
  done
  for file in "$BUN" "$LOG" "$LOCK" "$SWAP_STATE"; do
    check_file "$file"
  done
}

# discard <path>: remove a managed folder by renaming it aside first, so an
# interruption never leaves half of it under its real name.
discard() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  aside="$SUPPORT/.discard.$$"
  rm -rf "$aside"
  mv "$1" "$aside"
  rm -rf "$aside"
}

# --- One installer at a time -----------------------------------------------
#
# lockf takes an exclusive flock(2) lock on $LOCK, or fails at once when
# another process holds it, and keeps it while its command runs. Its command
# reads (and discards) a pipe that only this installer writes to, so it ends,
# and the lock goes, when this installer closes the pipe or its process ends
# in any way. The operating system releases the lock; nothing ever decides
# that a lock is stale, removes it, or takes it over.
acquire_lock() {
  mkfifo "$WORK/lock.hold" "$WORK/lock.ready"
  "$LOCKF" -k -s -t 0 "$LOCK" /bin/sh -c 'echo held; exec cat >/dev/null' \
    <"$WORK/lock.hold" >"$WORK/lock.ready" 2>/dev/null &
  LOCK_HELPER=$!
  # Only this installer holds the pipe open: cli() closes it for the engine
  # commands it runs, so no process outlives the installer holding the lock.
  exec 8>"$WORK/lock.hold"
  held=""
  read -r held <"$WORK/lock.ready" || true
  if [ "$held" != held ]; then
    exec 8>&-
    wait "$LOCK_HELPER" 2>/dev/null || true
    holder=$(awk 'NR == 1 { print $1 }' "$LOCK" 2>/dev/null || true)
    case "$holder" in ''|*[!0-9]*) holder="" ;; esac
    if [ -n "$holder" ]; then
      die "another Olympus installer is running (process $holder)." "Wait for it to finish, then run this again."
    fi
    die "another Olympus installer is running." "Wait for it to finish, then run this again."
  fi
  LOCKED=1
  # For the message another installer shows; the lock is lockf's, not this text.
  printf '%s %s\n' "$$" "$TXID" > "$LOCK"
}

# holds_lock: this installer took the lock and its lockf still holds it.
holds_lock() {
  [ "$LOCKED" = 1 ] || return 1
  helper_state=$(ps -o stat= -p "$LOCK_HELPER" 2>/dev/null || true)
  case "$helper_state" in ''|*Z*) return 1 ;; esac
}

release_lock() {
  [ "$LOCKED" = 1 ] || return 0
  LOCKED=0
  exec 8>&-
  wait "$LOCK_HELPER" 2>/dev/null || true
}

# --- Interrupted upgrades --------------------------------------------------
#
# An upgrade writes $SWAP_STATE ("upgrade <transaction id>") after removing
# the old app.previous and before its first rename, and removes it once the
# new version is proven healthy or the previous one is back. Only an
# installer holding the lock runs this: at its start, for whatever an
# interrupted installer left (that installer is gone, or the lock would not
# have been free), and on its own exit, for its own transaction only. The
# folders an upgrade can leave behind, and what puts the previous version back:
#   app missing, app.previous present        rename app.previous to app
#   app (new) and app.previous (old) present  only with $SWAP_STATE: swap back
#   app.failed present (a restore was cut short) with app present: remove it
recover_swap() {
  kind=$(awk 'NR == 1 { print $1 }' "$SWAP_STATE" 2>/dev/null || true)
  if [ ! -d "$APP" ] && [ -d "$APP.previous" ]; then
    mv "$APP.previous" "$APP" || return 1
    step "Put back the version an interrupted upgrade had moved aside."
  elif [ "$kind" = upgrade ] && [ -d "$APP" ] && [ -d "$APP.previous" ]; then
    rm -rf "$APP.failed"
    mv "$APP" "$APP.failed" || return 1
    if ! mv "$APP.previous" "$APP"; then
      mv "$APP.failed" "$APP" || true
      return 1
    fi
    step "Put back the version that was installed before an interrupted upgrade."
  fi
  rm -rf "$APP.failed" "$APP.next"
  rm -f "$SWAP_STATE"
}

# owns_swap: the swap record is this installer's own transaction.
owns_swap() {
  [ -f "$SWAP_STATE" ] && [ "$(cat "$SWAP_STATE" 2>/dev/null || true)" = "upgrade $TXID" ]
}

# On any exit: this installer's own upgrade that did not reach its outcome
# puts the previous version back, while this installer still holds the lock;
# then the lock and the download folder go. Anything else (an installer that
# never took the lock, a record another installer wrote) is left alone.
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" != 0 ] && [ "${LOCKED:-0}" = 1 ] && owns_swap; then
    if holds_lock && recover_swap; then
      printf '%s\n' "The upgrade stopped before it finished, so the previous version was put back. Run the installer again." >&2
    else
      printf '%s\n' "The upgrade stopped before it finished, and the previous version could not be put back yet. Run the installer again: it finishes putting it back first." >&2
    fi
  fi
  release_lock
  if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

# --- Bun and the Olympus package -------------------------------------------

# The installed Bun, when it is the pinned program (its bytes; its mode is
# set separately).
bun_is_pinned() {
  [ -f "$BUN" ] && [ ! -L "$BUN" ] && [ "$(sha256_of "$BUN")" = "$BUN_EXE_SHA256_DARWIN_AARCH64" ]
}

# Download Bun into $WORK and check it: the archive and the program in it.
download_bun() {
  [ ! -f "$WORK/bun-darwin-aarch64/bun" ] || return 0
  step "Downloading Bun $BUN_VERSION, the runtime Olympus uses ($(megabytes "$BUN_BYTES_DARWIN_AARCH64"))..."
  fetch "$BUN_BASE/bun-v$BUN_VERSION/bun-darwin-aarch64.zip" "$WORK/bun.zip" \
    || die "Bun could not be downloaded." "Check the internet connection and run this again. Nothing was changed on this Mac."
  if [ "$(sha256_of "$WORK/bun.zip")" != "$BUN_SHA256_DARWIN_AARCH64" ] || [ "$(bytes_of "$WORK/bun.zip")" != "$BUN_BYTES_DARWIN_AARCH64" ]; then
    die "the Bun download did not match its checksum, so it was not used." "Nothing was changed on this Mac. Run this again; if it happens again, email $SUPPORT_EMAIL."
  fi
  (cd "$WORK" && unzip -q bun.zip) || die "the Bun download could not be unpacked."
  [ -f "$WORK/bun-darwin-aarch64/bun" ] && [ ! -L "$WORK/bun-darwin-aarch64/bun" ] \
    || die "the Bun download has no bun program in it."
  [ "$(sha256_of "$WORK/bun-darwin-aarch64/bun")" = "$BUN_EXE_SHA256_DARWIN_AARCH64" ] \
    || die "the bun program in the Bun download did not match its checksum, so it was not used." "Run this again; if it happens again, email $SUPPORT_EMAIL."
}

# same_package <a> <b>: the same package.json and the same dist/, byte for byte.
same_package() {
  [ -f "$1/package.json" ] && [ -f "$2/package.json" ] && [ -f "$2/dist/cli.js" ] \
    && cmp -s "$1/package.json" "$2/package.json" \
    && diff -rq "$1/dist" "$2/dist" >/dev/null 2>&1
}

# cli <package dir> <args...>: that package's engine CLI on the pinned Bun, into the log.
cli() {
  pkg=$1
  shift
  "$BUN" "$pkg/dist/cli.js" "$@" >> "$LOG" 2>&1 </dev/null 8>&-
}

start_engine() {
  step "Starting Olympus in the background (this can take up to a minute)..."
  cli "$APP" engine install --bun "$BUN" --restart
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

  USER_ID=$(id -u)
  SUPPORT="$HOME/Library/Application Support/Olympus"
  APP="$SUPPORT/app"
  RUNTIME="$SUPPORT/runtime"
  BUN="$RUNTIME/bun"
  LOCK="$SUPPORT/.install-lock"
  SWAP_STATE="$SUPPORT/.install-swap"
  LOGDIR="$HOME/Library/Logs/Olympus"
  LOG="$LOGDIR/install.log"
  RECEIPT_NAME=.olympus-release-sha256
  ARTIFACT="olympus-$OLYMPUS_VERSION.tgz"
  ARTIFACT_URL="$RELEASE_BASE/$OLYMPUS_VERSION/$ARTIFACT"
  LOCKED=0
  LOCK_HELPER=""
  WORK=""
  # This run's transaction id, in the lock and in any swap record it writes.
  TXID=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s' "$TXID" | grep -Eq '^[0-9a-f]{32}$' || die "a random transaction id could not be read from /dev/urandom."

  # Before anything cached runs or anything changes.
  check_layout

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/olympus-install.XXXXXX")

  # 1. Download and verify everything before changing anything.
  if ! bun_is_pinned; then download_bun; fi

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
  RELEASE="$WORK/unpacked/package"
  step "The downloads match their published checksums."

  # 2. One installer at a time; finish what an interrupted one left.
  mkdir -p "$SUPPORT" "$LOGDIR"
  chmod 700 "$SUPPORT" "$LOGDIR"
  acquire_lock
  check_layout
  rm -rf "$SUPPORT"/.discard.*
  printf '\n== Olympus installer %s, %s\n' "$OLYMPUS_VERSION" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG"
  recover_swap || die "an interrupted upgrade left $APP.previous that could not be put back." "Details may be in $LOG. Email $SUPPORT_EMAIL."

  # The runtime. A running engine keeps the Bun it started with: the file is
  # replaced by rename, never rewritten in place.
  if ! bun_is_pinned; then
    download_bun
    mkdir -p "$RUNTIME"
    rm -rf "$RUNTIME/bun.next"
    mv "$WORK/bun-darwin-aarch64/bun" "$RUNTIME/bun.next"
    chmod 755 "$RUNTIME/bun.next"
    mv "$RUNTIME/bun.next" "$BUN"
    bun_is_pinned || die "the Bun put in place does not match its checksum."
  fi
  # The right bytes are not enough: it must be executable (only by its owner
  # to change). chmod keeps the file, so a running engine is unaffected.
  chmod 755 "$BUN" && [ -x "$BUN" ] \
    || die "the Bun runtime at $BUN could not be made executable." "Details may be in $LOG. Email $SUPPORT_EMAIL."

  # 3. The same release again: the installed files must be the verified
  #    download, and the engine must run this build.
  if [ -f "$APP/$RECEIPT_NAME" ] && [ "$(cat "$APP/$RECEIPT_NAME")" = "$OLYMPUS_SHA256" ]; then
    if same_package "$RELEASE" "$APP"; then
      step "Olympus $OLYMPUS_VERSION is already installed. Checking that it is running..."
      # Proof against the build of the verified download, not whatever the
      # installed agent names: an upgrade cut short leaves the old one there.
      if ! cli "$APP" engine verify --expect-package "$RELEASE"; then
        start_engine \
          || fail "Olympus is installed but did not start." "Details are in $LOG. Run this again, or email $SUPPORT_EMAIL with that file."
      fi
      finish
      return 0
    fi
    # Damaged in place: put the verified download there, and keep app.previous.
    step "The installed copy of Olympus $OLYMPUS_VERSION is incomplete or changed; replacing it with the verified download..."
    rm -rf "$APP.next"
    mv "$RELEASE" "$APP.next"
    discard "$APP"
    mv "$APP.next" "$APP"
    start_engine \
      || fail "Olympus is installed but did not start." "Details are in $LOG. Run this again, or email $SUPPORT_EMAIL with that file."
    finish
    return 0
  fi

  # 4. Install or upgrade: unpack beside the current version, then swap.
  rm -rf "$APP.next"
  mv "$RELEASE" "$APP.next"
  UPGRADE=0
  if [ -f "$APP/dist/cli.js" ]; then
    UPGRADE=1
    # The running engine was restarted onto $APP by the last install, so
    # app.previous is not in use and can go.
    discard "$APP.previous"
    printf 'upgrade %s\n' "$TXID" > "$SWAP_STATE"
    mv "$APP" "$APP.previous"
  else
    # Nothing runnable to keep: a folder without the engine CLI is not a version.
    discard "$APP"
  fi
  mv "$APP.next" "$APP"

  # 5. Register the per-user LaunchAgent and (re)start it on this build. The
  #    plist names the build, so an upgrade reloads the agent; --restart covers
  #    an agent loaded from an identical plist. The command succeeds only once
  #    the engine proves this build healthy.
  if ! start_engine; then
    if [ "$UPGRADE" = 1 ] && [ -d "$APP.previous" ]; then
      step "The new version did not start; restoring the previous one..."
      rm -rf "$APP.failed"
      mv "$APP" "$APP.failed"
      mv "$APP.previous" "$APP"
      RESTORED=0
      # A previous version from before --restart reloads anyway: its plist differs.
      if cli "$APP" engine install --bun "$BUN" --restart || cli "$APP" engine install --bun "$BUN"; then
        # Proof, not launchd's word: the previous package's own `engine verify`,
        # or, when it predates that command, the new package's.
        if cli "$APP" engine verify --expect-package "$APP" || cli "$APP.failed" engine verify --expect-package "$APP"; then
          RESTORED=1
        fi
      fi
      rm -rf "$APP.failed"
      rm -f "$SWAP_STATE"
      if [ "$RESTORED" = 1 ]; then
        fail "Olympus $OLYMPUS_VERSION could not be started, so the previous version was restored and is running." "Details are in $LOG. Email $SUPPORT_EMAIL with that file."
      fi
      fail "Olympus $OLYMPUS_VERSION could not be started, and the restored previous version did not come back healthy either." "Details are in $LOG. Email $SUPPORT_EMAIL with that file."
    fi
    fail "Olympus is installed but did not start." "Details are in $LOG. Run this again, or email $SUPPORT_EMAIL with that file."
  fi
  rm -f "$SWAP_STATE"
  finish
}

# The `olympus` command, and PATH so that a new Terminal window finds it.
install_command() {
  BIN_DIR="$HOME/.local/bin"
  LAUNCHER="$BIN_DIR/olympus"
  COMMAND_READY=0
  if [ -L "$LAUNCHER" ] || { [ -e "$LAUNCHER" ] && ! grep -qF "$LAUNCHER_MARK" "$LAUNCHER" 2>/dev/null; }; then
    step "Left $LAUNCHER alone: this installer did not write it."
    return 0
  fi
  mkdir -p "$BIN_DIR"
  rm -f "$LAUNCHER.next"
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
