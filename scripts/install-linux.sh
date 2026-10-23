#!/bin/sh
# Linux x64 bootstrap. The engine lifecycle owns durable generation exchange,
# rollback and interrupted-install recovery under the shared kernel lock.
# Every action is below main: a truncated curl response executes no install.
# Guard chains intentionally refuse when ANY prerequisite is false.
# shellcheck disable=SC2015
set -eu

OLYMPUS_VERSION=@OLYMPUS_VERSION@
OLYMPUS_SHA256=@OLYMPUS_SHA256@
OLYMPUS_BYTES=@OLYMPUS_BYTES@
RELEASE_BASE=https://olympusplugin.ai/releases
BUN_VERSION=@BUN_VERSION@
BUN_URL=@BUN_URL@
BUN_ENTRY=@BUN_ENTRY@
BUN_BYTES=@BUN_BYTES@
BUN_SHA256=@BUN_SHA256@
BUN_EXE_SHA256=@BUN_EXE_SHA256@
BUN_GLIBC_MIN=@BUN_GLIBC_MIN@

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "Olympus was not installed or upgraded: $*" >&2; exit 1; }
sha256_of() { sha256sum "$1" | awk '{print $1}'; }
check_digest() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(wc -c < "$1" | tr -d ' ')" = "$2" ] && [ "$(sha256_of "$1")" = "$3" ]
}
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1"; }

usage() {
  say 'Usage: install-linux.sh [--tarball PATH] [--bun-archive PATH]'
  say 'Both local archives are checked against the release pins before extraction or execution.'
}

parse_args() {
  LOCAL_TARBALL=''
  LOCAL_BUN_ARCHIVE=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tarball|--bun-archive)
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a path."
        case "$1" in --tarball) LOCAL_TARBALL=$2 ;; *) LOCAL_BUN_ARCHIVE=$2 ;; esac
        shift 2
        ;;
      --tarball=*) LOCAL_TARBALL=${1#--tarball=} ; shift ;;
      --bun-archive=*) LOCAL_BUN_ARCHIVE=${1#--bun-archive=} ; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

check_tools() {
  missing=''
  for tool in sha256sum tar unzip stat getconf mktemp mkdir chmod rm wc tr id uname df cp mv cat dirname sed head find awk grep diff cmp ps flock loginctl systemctl systemd-analyze python3; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if { [ -z "$LOCAL_TARBALL" ] || [ -z "$LOCAL_BUN_ARCHIVE" ]; } && ! command -v curl >/dev/null 2>&1; then
    missing="$missing curl"
  fi
  if [ -n "$missing" ]; then
    say "Missing required tools:$missing" >&2
    say 'Arch / Omarchy: sudo pacman -S --needed curl ca-certificates tar unzip coreutils findutils gawk grep diffutils procps-ng util-linux systemd python' >&2
    say 'Ubuntu: sudo apt install curl ca-certificates tar unzip coreutils findutils gawk grep diffutils procps util-linux systemd python3' >&2
    die 'Install these packages, then retry. No packages were installed automatically.'
  fi
  flock --version | grep -q 'util-linux' || die 'util-linux flock is required.'
}

copy_local_archive() {
  source=$1
  destination=$2
  label=$3
  case "$source" in /*) ;; *) die "$label path must be absolute: $source" ;; esac
  check_path "$source"
  [ -f "$source" ] && [ ! -L "$source" ] || die "$label must be a regular, non-symbolic-link file: $source"
  cp "$source" "$destination" || die "$label could not be copied into private bootstrap storage."
}

# Existing ancestors must be real, owned by this account/root and not writable
# by other users. A root-owned sticky /tmp ancestor is safe beneath a private dir.
check_path() {
  case "$1" in /*) ;; *) die "Use an absolute path: $1" ;; esac
  case "$1" in *'
'*|*'	'*|*/../*|*/./*|*/..|*/.|*//*) die "Unsafe path: $1" ;; esac
  path=$1
  while [ "$path" != / ]; do
    [ ! -L "$path" ] || die "Symbolic link refused: $path"
    if [ -e "$path" ]; then
      owner=$(stat -c %u "$path")
      [ "$owner" = "$USER_ID" ] || [ "$owner" = 0 ] || die "Foreign-owned path: $path"
      if [ -n "$(find "$path" -maxdepth 0 -perm /022 -print)" ]; then
        [ "$owner" = 0 ] && [ -d "$path" ] && [ -n "$(find "$path" -maxdepth 0 -perm -1000 -print)" ] || die "Writable by other users: $path"
      fi
    fi
    path=$(dirname "$path")
  done
}

check_session() {
  [ "$(uname -s)" = Linux ] || die 'This installer is for Linux.'
  [ "$(uname -m)" = x86_64 ] || die 'This installer supports Linux x64 only; arm64 is unavailable.'
  USER_ID=$(id -u)
  [ "$USER_ID" != 0 ] || die 'Run as yourself, without sudo.'
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die 'Your home directory was not found.'
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || die 'GNU glibc is required; musl is not supported.'
  printf '%s\n' "$libc" | awk -v min="$BUN_GLIBC_MIN" '
    BEGIN { split(min,m,".") } $1 == "glibc" { split($2,v,"."); if (v[1]>m[1] || (v[1]==m[1] && v[2]>=m[2])) ok=1 } END { exit !ok }' \
    || die "Bun requires glibc $BUN_GLIBC_MIN or newer."
  # The pinned baseline targets Nehalem, not AVX2. Check every reported CPU.
  awk '/^flags[[:space:]]*:/ { seen++; if ($0 !~ /(^|[[:space:]])sse4_2([[:space:]]|$)/) bad=1 } END { exit (!seen || bad) }' /proc/cpuinfo \
    || die 'The Bun baseline requires SSE4.2 on every CPU.'
  systemctl --version | awk 'NR==1 { exit !($1=="systemd" && $2>=254) }' \
    || die 'systemd 254 or newer is required for bounded restart backoff.'
  systemctl --user show-environment >/dev/null 2>&1 \
    || die 'A working systemd user bus/session is required. Log in as your ordinary user and retry.'
  [ -n "${XDG_RUNTIME_DIR:-}" ] || die 'A session-owned XDG_RUNTIME_DIR is required.'
  check_path "$XDG_RUNTIME_DIR"
  [ -d "$XDG_RUNTIME_DIR" ] && [ "$(stat -c %u "$XDG_RUNTIME_DIR")" = "$USER_ID" ] && [ "$(stat -c %a "$XDG_RUNTIME_DIR")" = 700 ] \
    || die 'XDG_RUNTIME_DIR must be a private (0700) directory owned by you.'
  XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
  XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
  XDG_STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
  XDG_CACHE_HOME=${XDG_CACHE_HOME:-$HOME/.cache}
  export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
  for root in "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"; do check_path "$root"; done
  check_path "$XDG_RUNTIME_DIR/olympus"
  if [ -e "$XDG_RUNTIME_DIR/olympus" ]; then
    [ -d "$XDG_RUNTIME_DIR/olympus" ] && [ "$(stat -c %u "$XDG_RUNTIME_DIR/olympus")" = "$USER_ID" ] && [ "$(stat -c %a "$XDG_RUNTIME_DIR/olympus")" = 700 ] \
      || die 'The Olympus runtime directory must be private and owned by you.'
  fi
}


# No archive extraction before digest AND structure validation. Reject links,
# devices and any name outside package/. Tar reads only our private download.
unpack_package() {
  tar -tzf "$WORK/release.tgz" > "$WORK/names" || die 'Unreadable package archive.'
  awk '/^package\/$/ {next} !/^package\// || /(^|\/)\.\.?($|\/)/ || /\/\// || /[[:cntrl:]]/ {bad=1} END {exit bad}' "$WORK/names" \
    || die 'Unsafe package archive path.'
  tar -tvzf "$WORK/release.tgz" > "$WORK/types" || die 'Unreadable package archive metadata.'
  awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' "$WORK/types" \
    || die 'Links and special files are refused in the package archive.'
  mkdir "$WORK/unpacked"
  tar -xzf "$WORK/release.tgz" --no-same-owner --no-same-permissions -C "$WORK/unpacked" || die 'Package extraction failed.'
  [ -f "$WORK/unpacked/package/package.json" ] && [ -f "$WORK/unpacked/package/dist/cli.js" ] \
    || die 'The package is missing package.json or dist/cli.js.'
}

main() {
  parse_args "$@"
  case "$OLYMPUS_VERSION$OLYMPUS_SHA256$OLYMPUS_BYTES$BUN_VERSION$BUN_URL$BUN_ENTRY$BUN_BYTES$BUN_SHA256$BUN_EXE_SHA256$BUN_GLIBC_MIN" in
    *@*) die 'Unfilled installer template; use a published Linux release.' ;;
  esac
  check_tools
  printf '%s\n' "$OLYMPUS_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$' || die 'Malformed release version.'
  for hash in "$OLYMPUS_SHA256" "$BUN_SHA256" "$BUN_EXE_SHA256"; do
    printf '%s\n' "$hash" | grep -Eq '^[0-9a-f]{64}$' || die 'Missing or malformed runtime/release pin.'
  done
  for size in "$OLYMPUS_BYTES" "$BUN_BYTES"; do
    case "$size" in ''|*[!0-9]*|0) die 'Missing or malformed archive size.' ;; esac
  done
  [ "$BUN_URL" = "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64-baseline.zip" ] \
    && [ "$BUN_ENTRY" = bun-linux-x64-baseline/bun ] && [ "$BUN_GLIBC_MIN" = 2.17 ] \
    || die 'Missing or unsupported Linux runtime pin.'
  printf '%s\n' "$BUN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'Missing or malformed Bun version.'
  check_session
  umask 077
  mkdir -p "$XDG_RUNTIME_DIR/olympus"
  LOCK="$XDG_RUNTIME_DIR/olympus/lifecycle.lock"
  check_path "$LOCK"
  if [ -e "$LOCK" ]; then
    [ -f "$LOCK" ] && [ "$(stat -c %u "$LOCK")" = "$USER_ID" ] && [ "$(stat -c %a "$LOCK")" = 600 ] || die 'Unsafe lifecycle lock.'
  fi
  WORK=$(mktemp -d "$XDG_RUNTIME_DIR/olympus/bootstrap.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  # Allow room for the runtime, compressed package and extraction before downloading.
  available=$(df -Pk "$WORK" | awk 'END {print $4}')
  [ "$available" -ge "$(( (BUN_BYTES * 4 + OLYMPUS_BYTES * 6) / 1024 + 65536 ))" ] || die 'Not enough bootstrap disk space.'
  if [ -n "$LOCAL_BUN_ARCHIVE" ]; then
    copy_local_archive "$LOCAL_BUN_ARCHIVE" "$WORK/bun.zip" 'Local Bun archive'
  else
    fetch "$BUN_URL" "$WORK/bun.zip" || die 'Bun download failed; check HTTPS connectivity and CA certificates.'
  fi
  check_digest "$WORK/bun.zip" "$BUN_BYTES" "$BUN_SHA256" || die 'Bun archive checksum/size mismatch; nothing was executed.'
  # Read one entry to a fixed path. ZIP paths/links are never extracted.
  unzip -p "$WORK/bun.zip" "$BUN_ENTRY" > "$WORK/bun" || die 'Bun executable is missing.'
  [ "$(sha256_of "$WORK/bun")" = "$BUN_EXE_SHA256" ] || die 'Bun executable checksum mismatch; nothing was executed.'
  chmod 700 "$WORK/bun"
  if [ -n "$LOCAL_TARBALL" ]; then
    copy_local_archive "$LOCAL_TARBALL" "$WORK/release.tgz" 'Local Olympus tarball'
  else
    fetch "$RELEASE_BASE/$OLYMPUS_VERSION/olympus-$OLYMPUS_VERSION.tgz" "$WORK/release.tgz" || die 'Release download failed.'
  fi
  check_digest "$WORK/release.tgz" "$OLYMPUS_BYTES" "$OLYMPUS_SHA256" || die 'Release checksum/size mismatch; nothing was executed.'
  unpack_package
  [ "$("$WORK/bun" --no-env-file --version)" = "$BUN_VERSION" ] || die 'The verified Bun cannot run on this CPU/glibc, or returned the wrong version.'
  "$WORK/bun" --no-env-file -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(p.name!=="olympus" || p.version!==process.argv[2]) process.exit(1)' "$WORK/unpacked/package/package.json" "$OLYMPUS_VERSION" \
    || die 'The package identity disagrees with the release pins.'
  # Run admission, durable linger provenance and lifecycle mutation under ONE
  # supervisor. The lifecycle CLI alone may observe or change linger.
  # The helper is private source from this fully received template, not a
  # downloaded command. SVC must verify its flock ancestry and reuse custody.
  cat > "$WORK/activate.sh" <<'ACTIVATE'
#!/bin/sh
set -eu
WORK=$1
say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "Olympus was not installed or upgraded: $*" >&2; exit 1; }

  # Read-only lifecycle admission must refuse existing data, unsafe layout and
  # unsupported capabilities before the account-wide linger change.
  "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" \
    engine install --from-checkout "$WORK/unpacked/package" --bun "$WORK/bun" --dry-run \
    || die 'Lifecycle preflight refused; linger and active installation were not changed.'
  say 'Dependencies and user manager are ready. Olympus will verify persistent-service permission inside the lifecycle transaction.'
  result=0
  "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" \
    engine install --from-checkout "$WORK/unpacked/package" --bun "$WORK/bun" --restart || result=$?
  [ "$result" = 0 ] || die "Lifecycle install failed (status $result). The engine CLI's recovery report above is authoritative."
  "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" engine status > "$WORK/status.json" \
    || die 'Lifecycle status failed; do not treat this as a healthy installation.'
  "$WORK/bun" --no-env-file -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(s.ok!==true) process.exit(1)' "$WORK/status.json" \
    || die 'Lifecycle status is unhealthy or unknown; do not treat this as a healthy installation.'
  cat "$WORK/status.json"
  say 'By installing Olympus you agree to its Terms (https://olympusplugin.ai/terms/)'
  say 'and acknowledge its Privacy Policy (https://olympusplugin.ai/privacy/).'
  say 'Olympus is provided as is, without warranty. Keep your own backups.'
  say 'Installed for your user without an administrator password. Run ~/.local/bin/olympus engine status for later checks.'
  say 'Model readiness is reported separately by the engine.'
ACTIVATE
  # Ordinary cancellation cannot release the supervisor while its mutation
  # child is running, nor remove scratch beneath that child.
  trap '' HUP INT TERM
  result=0
  flock --nonblock "$LOCK" /bin/sh "$WORK/activate.sh" "$WORK" || result=$?
  trap - HUP INT TERM
  [ "$result" = 0 ] || die "Lifecycle supervisor failed (status $result); see the recovery report above."

}

main "$@"
