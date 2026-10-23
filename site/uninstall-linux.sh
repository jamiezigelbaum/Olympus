#!/bin/sh
# Receipt-bound Linux removal using only operating-system tools. It remains
# usable when the installed Bun or application is missing or corrupt.
# shellcheck disable=SC2015
set -eu

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "Olympus removal is incomplete: $*" >&2; exit 1; }
usage() {
  say 'Usage: uninstall-linux.sh [--purge --yes] [--restore-linger]'
  say 'Without --purge, personal data, settings, secrets, models and logs are kept.'
}
parse_args() {
  PURGE=0 YES=0 RESTORE_LINGER=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --purge) PURGE=1 ;;
      --yes) YES=1 ;;
      --restore-linger) RESTORE_LINGER=1 ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done
  [ "$PURGE" = "$YES" ] || die '--purge and --yes must be supplied together for full removal.'
}
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

main() {
  parse_args "$@"
  missing=''
  for tool in uname id stat find dirname flock systemctl python3 mktemp mkdir rm chmod grep; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ "$RESTORE_LINGER" = 0 ] || command -v loginctl >/dev/null 2>&1 || missing="$missing loginctl"
  if [ -n "$missing" ]; then
    say "Missing required tools:$missing" >&2
    say 'Arch / Omarchy: sudo pacman -S --needed coreutils findutils util-linux systemd python' >&2
    say 'Ubuntu: sudo apt install coreutils findutils util-linux systemd python3' >&2
    die 'Install the missing packages and retry; nothing was removed.'
  fi
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die 'This uninstaller supports Linux x64 only.'
  USER_ID=$(id -u)
  [ "$USER_ID" != 0 ] || die 'Run as yourself, without sudo.'
  flock --version | grep -q util-linux || die 'util-linux flock is required.'
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die 'Your home directory was not found.'
  [ -n "${XDG_RUNTIME_DIR:-}" ] || die 'A live user session with XDG_RUNTIME_DIR is required to prove lifecycle custody.'

  requested_config=${XDG_CONFIG_HOME:-$HOME/.config}
  default_receipt=$HOME/.config/olympus/install-receipt.json
  requested_receipt=$requested_config/olympus/install-receipt.json
  RECEIPT=''
  [ ! -e "$default_receipt" ] || RECEIPT=$default_receipt
  if [ "$requested_receipt" != "$default_receipt" ] && [ -e "$requested_receipt" ]; then
    [ -z "$RECEIPT" ] || die "Multiple install receipts found: $default_receipt and $requested_receipt."
    RECEIPT=$requested_receipt
  fi
  if [ -z "$RECEIPT" ]; then
    [ "$PURGE" = 0 ] && [ "$RESTORE_LINGER" = 0 ] || die 'No install receipt exists, so purge or linger restoration cannot be authorized.'
    say 'No Olympus Linux install receipt exists; there is no receipt-owned machinery to remove.'
    return 0
  fi
  check_path "$RECEIPT"
  [ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] && [ "$(stat -c %u "$RECEIPT")" = "$USER_ID" ] && [ "$(stat -c %a "$RECEIPT")" = 600 ] \
    || die "$RECEIPT must be a private (0600), owner-owned regular file."

  runtime_dir=$XDG_RUNTIME_DIR/olympus
  check_path "$XDG_RUNTIME_DIR"
  [ -d "$XDG_RUNTIME_DIR" ] && [ "$(stat -c %u "$XDG_RUNTIME_DIR")" = "$USER_ID" ] && [ "$(stat -c %a "$XDG_RUNTIME_DIR")" = 700 ] \
    || die "$XDG_RUNTIME_DIR must be a private (0700), owner-owned directory."
  check_path "$runtime_dir"
  if [ ! -e "$runtime_dir" ]; then
    mkdir -m 700 "$runtime_dir" 2>/dev/null || [ -d "$runtime_dir" ] || die "Could not recreate private runtime directory $runtime_dir."
  fi
  [ -d "$runtime_dir" ] && [ "$(stat -c %u "$runtime_dir")" = "$USER_ID" ] && [ "$(stat -c %a "$runtime_dir")" = 700 ] \
    || die "$runtime_dir must be a private (0700), owner-owned directory."
  LOCK=$runtime_dir/lifecycle.lock
  check_path "$LOCK"
  if [ -e "$LOCK" ]; then
    [ -f "$LOCK" ] && [ ! -L "$LOCK" ] && [ "$(stat -c %u "$LOCK")" = "$USER_ID" ] && [ "$(stat -c %a "$LOCK")" = 600 ] \
      || die 'The lifecycle lock is unsafe; nothing was removed.'
  fi
  umask 077
  WORK=$(mktemp -d "$runtime_dir/uninstall.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  : > "$LOCK"
  chmod 600 "$LOCK"
  exec 9>"$LOCK"
  flock --nonblock 9 || die 'Another Olympus lifecycle operation is active; nothing was removed.'
  trap '' HUP INT TERM
  result=0
  # Python inherits fd 9, so killing this supervisor cannot release custody
  # while removal is still running. subprocess.run closes it in system tools.
  python3 - "$RECEIPT" "$PURGE" "$RESTORE_LINGER" "$USER_ID" <<'PY' || result=$?
import errno, hashlib, json, os, shutil, socket, stat, subprocess, sys

receipt_path, purge_raw, restore_raw, uid_raw = sys.argv[1:]
purge, restore_linger, uid = purge_raw == "1", restore_raw == "1", int(uid_raw)

def fail(message): raise SystemExit(f"Olympus removal is incomplete: {message}")
def duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result: fail(f"duplicate receipt key {key!r}; nothing was removed.")
        result[key] = value
    return result
def absolute(path, name):
    if not isinstance(path, str) or not os.path.isabs(path) or any(ord(c) < 32 or ord(c) == 127 for c in path): fail(f"{name} is unsafe.")
    if os.path.normpath(path) != path: fail(f"{name} is not canonical.")
    return path
def lstat(path):
    try: return os.lstat(path)
    except FileNotFoundError: return None
def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(fd)
    finally: os.close(fd)
def check_ancestry(path, leaf_owner=False, leaf_symlink=False):
    current = path
    while True:
        info = lstat(current)
        if info is not None:
            if stat.S_ISLNK(info.st_mode) and not (current == path and leaf_symlink): fail(f"symbolic-link path component was retained: {current}")
            if info.st_uid not in {uid, 0}: fail(f"foreign-owned path component was retained: {current}")
            unsafe = stat.S_IMODE(info.st_mode) & 0o022
            sticky_root = info.st_uid == 0 and stat.S_ISDIR(info.st_mode) and bool(info.st_mode & stat.S_ISVTX)
            if unsafe and not sticky_root and not (current == path and leaf_symlink): fail(f"unsafe writable path component was retained: {current}")
            if current == path and leaf_owner and info.st_uid != uid: fail(f"foreign-owned artifact was retained: {path}")
        parent = os.path.dirname(current)
        if parent == current: break
        current = parent
def hash_file(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk: break
            digest.update(chunk)
    return digest.hexdigest()
def hash_link(path): return hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
def hash_tree(path):
    """Canonical generation digest shared with linux-engine-layout.ts."""
    digest = hashlib.sha256()
    def walk(current):
        for name in sorted(os.listdir(current)):
            full = os.path.join(current, name)
            relative, info, payload = os.path.relpath(full, path).replace(os.sep, "/"), os.lstat(full), b""
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISDIR(info.st_mode): kind = b"directory"
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1: fail(f"hardlink in installed generation: {full}; it was retained.")
                kind = b"file"
                with open(full, "rb") as handle: payload = handle.read()
            elif stat.S_ISLNK(info.st_mode): kind, payload = b"symlink", os.fsencode(os.readlink(full))
            else: fail(f"special file in installed generation: {full}; it was retained.")
            digest.update(kind + b"\0" + relative.encode() + b"\0" + format(mode, "o").encode() + b"\0")
            if kind == b"directory": walk(full)
            else: digest.update(str(len(payload)).encode() + b"\0" + payload)
    walk(path)
    return digest.hexdigest()
def artifact_digest(path, kind):
    info = lstat(path)
    if info is None: return None
    if info.st_uid != uid: fail(f"foreign-owned artifact was retained: {path}")
    if kind == "file" and stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_nlink == 1: return hash_file(path)
    if kind == "symlink" and stat.S_ISLNK(info.st_mode): return hash_link(path)
    if kind == "tree" and stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode): return hash_tree(path)
    fail(f"artifact changed type and was retained: {path}")

try:
    info = os.lstat(receipt_path)
    if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o600 or not stat.S_ISREG(info.st_mode): fail("the install receipt is no longer private and owner-owned.")
    with open(receipt_path, encoding="utf-8") as handle: receipt = json.load(handle, object_pairs_hook=duplicates)
except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"the install receipt is unreadable: {error}")
if receipt.get("schema") != "olympus.engine.install.v1" or receipt.get("uid") != uid: fail("foreign or unsupported install receipt.")
layout, artifacts = receipt.get("layout"), receipt.get("machineArtifacts")
installation_state = receipt.get("installationState")
if not isinstance(layout, dict) or not isinstance(artifacts, list): fail("the receipt has no machine-artifact inventory.")
artifacts = list(artifacts)
if installation_state not in {"installed","recovery_pending","data_retained"}: fail("the receipt has no valid installation state.")
if installation_state == "installed" and not artifacts: fail("the installed receipt has no machine-artifact inventory.")
if installation_state in {"recovery_pending","data_retained"} and (artifacts or receipt.get("ownedUnitLinks")): fail("the non-installed receipt still claims machine artifacts.")
owned_links = receipt.get("ownedUnitLinks")
if not isinstance(owned_links, list) or any(not isinstance(path, str) for path in owned_links): fail("the receipt has an invalid systemd-link inventory.")
open_handler_pending = receipt.get("openHandlerPending", False)
if not isinstance(open_handler_pending, bool): fail("the receipt has invalid open-handler recovery state.")
if installation_state in {"recovery_pending","data_retained"} and open_handler_pending: fail("the non-installed receipt still has pending open-handler intent.")
mime_ownership = receipt.get("mimeOwnership")
if mime_ownership is not None:
    if mime_ownership != {"path": layout.get("mimeappsPath"), "scheme":"x-scheme-handler/olympus", "desktopId":"ai.olympusplugin.open.desktop"}: fail("the receipt has invalid MIME ownership.")
if installation_state in {"recovery_pending","data_retained"} and mime_ownership is not None: fail("the non-installed receipt still claims MIME ownership.")
required = ["home","configHome","dataHome","stateHome","cacheHome","runtimeHome","configDir","dataDir","stateDir","cacheDir","runtimeDir","packageDir","launcherPath","openHandlerPath","mimeappsPath","unitPath","receiptPath","workerSocketPath"]
for key in required: absolute(layout.get(key), f"layout.{key}")
if layout["home"] != os.environ.get("HOME") or layout["receiptPath"] != receipt_path or layout["runtimeHome"] != os.environ.get("XDG_RUNTIME_DIR"): fail("the receipt layout disagrees with this account/session.")
allowed_data_roots = {os.path.join(layout["dataHome"], "olympus"), os.path.join(layout["dataHome"], "openclaw", "olympus"), os.path.join(layout["home"], ".local", "share", "openclaw", "olympus")}
if layout["dataDir"] not in allowed_data_roots: fail("the receipt contains an inconsistent Linux layout (data root).")
expected = {
    "configDir": os.path.join(layout["configHome"], "olympus"),
    "dataDir": layout["dataDir"],
    "stateDir": os.path.join(layout["stateHome"], "olympus", "engine"),
    "cacheDir": os.path.join(layout["cacheHome"], "olympus", "engine"),
    "runtimeDir": os.path.join(layout["runtimeHome"], "olympus"),
    "packageDir": os.path.join(layout["dataHome"], "olympus-engine") if layout["dataDir"] == os.path.join(layout["dataHome"], "olympus") else os.path.join(layout["dataHome"], "olympus", "engine"),
    "launcherPath": os.path.join(layout["home"], ".local", "bin", "olympus"),
    "openHandlerPath": os.path.join(layout["dataHome"], "applications", "ai.olympusplugin.open.desktop"),
    "mimeappsPath": os.path.join(layout["configHome"], "mimeapps.list"),
    "unitPath": os.path.join(layout["configHome"], "systemd", "user", "olympus-engine.service"),
    "receiptPath": os.path.join(layout["configHome"], "olympus", "install-receipt.json"),
    "workerSocketPath": os.path.join(layout["runtimeHome"], "olympus", "worker.sock"),
}
if any(layout[key] != value for key, value in expected.items()): fail("the receipt contains an inconsistent Linux layout.")
owned_empty_parents = receipt.get("ownedEmptyParents", [])
allowed_empty_parents = {os.path.dirname(layout["stateDir"]), os.path.dirname(layout["cacheDir"])}
if not isinstance(owned_empty_parents, list): fail("invalid empty-directory ownership; nothing was removed.")
seen_parents = set()
for entry in owned_empty_parents:
    if (not isinstance(entry, dict) or entry.get("path") not in allowed_empty_parents
        or entry["path"] in seen_parents or type(entry.get("device")) is not int or entry["device"] < 0
        or type(entry.get("inode")) is not int or entry["inode"] <= 0):
        fail("invalid empty-directory ownership; nothing was removed.")
    seen_parents.add(entry["path"])

def beneath(path, root):
    try: return os.path.commonpath([path, root]) == root and path != root
    except ValueError: return False
for root in [layout["home"],layout["configHome"],layout["dataHome"],layout["stateHome"],layout["cacheHome"],layout["runtimeHome"]]: check_ancestry(root)
managed_roots = [layout["configDir"],layout["dataDir"],layout["stateDir"],layout["cacheDir"],layout["packageDir"]]
for index, root in enumerate(managed_roots):
    for other in managed_roots[index + 1:]:
        if root == other or beneath(root, other) or beneath(other, root): fail(f"managed Olympus roots overlap: {root} and {other}; nothing was removed.")
install_transaction = os.path.join(layout["stateDir"], "install-transaction.json")
if os.path.lexists(install_transaction):
    check_ancestry(install_transaction, leaf_owner=True)
    fail(f"an unfinished Linux install transaction remains at {install_transaction}. Rerun the same pinned installer or local release tarball to recover it, then retry uninstall; nothing was removed.")
if open_handler_pending:
    if os.path.lexists(layout["openHandlerPath"]):
        check_ancestry(layout["openHandlerPath"], leaf_owner=True)
        handler_info = os.lstat(layout["openHandlerPath"])
        if not stat.S_ISREG(handler_info.st_mode) or stat.S_ISLNK(handler_info.st_mode) or handler_info.st_nlink != 1: fail("pending open handler changed identity and was retained.")
        with open(layout["openHandlerPath"], encoding="utf-8") as handle: handler_text = handle.read()
        if "Written by olympus open-handler install" not in handler_text: fail("pending open handler lacks the Olympus ownership mark and was retained.")
        if not any(entry.get("path") == layout["openHandlerPath"] for entry in artifacts if isinstance(entry, dict)):
            artifacts.append({"path":layout["openHandlerPath"],"kind":"file","sha256":hash_file(layout["openHandlerPath"])})
    else:
        handler_parent = os.path.dirname(layout["openHandlerPath"])
        prefix = f".olympus-remove-{os.path.basename(layout['openHandlerPath'])}-"
        journals = [] if not os.path.isdir(handler_parent) else [os.path.join(handler_parent, name) for name in os.listdir(handler_parent) if name.startswith(prefix) and name.endswith(".journal.json")]
        if len(journals) > 1: fail("multiple pending open-handler removal journals were found.")
        if journals:
            pending_journal = journals[0]
            journal_info = os.lstat(pending_journal)
            if journal_info.st_uid != uid or stat.S_IMODE(journal_info.st_mode) != 0o600 or not stat.S_ISREG(journal_info.st_mode): fail("pending open-handler removal journal is unsafe.")
            try:
                with open(pending_journal, encoding="utf-8") as handle: pending_record = json.load(handle, object_pairs_hook=duplicates)
            except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"pending open-handler removal journal is unreadable: {error}")
            expected_tombstone = pending_journal[:-len(".journal.json")]
            expected_sha = pending_record.get("sha256")
            expected_journal = os.path.join(handler_parent, prefix + expected_sha[:16] + ".journal.json") if isinstance(expected_sha, str) and len(expected_sha) == 64 else ""
            if pending_record.get("schema") != "olympus.engine.remove-artifact.v1" or pending_record.get("path") != layout["openHandlerPath"] or pending_record.get("tombstone") != expected_tombstone or pending_record.get("kind") != "file" or not isinstance(expected_sha, str) or len(expected_sha) != 64 or pending_journal != expected_journal: fail("pending open-handler removal journal is invalid.")
            existing_handlers = [entry for entry in artifacts if isinstance(entry, dict) and entry.get("path") == layout["openHandlerPath"]]
            if len(existing_handlers) > 1: fail("the receipt has duplicate open-handler artifacts.")
            if existing_handlers:
                existing = existing_handlers[0]
                if existing.get("kind") != "file" or existing.get("sha256") != expected_sha: fail("the pending open-handler journal disagrees with its receipt artifact.")
            else:
                artifacts.append({"path":layout["openHandlerPath"],"kind":"file","sha256":expected_sha})
        elif os.path.isdir(handler_parent) and any(name.startswith(prefix) for name in os.listdir(handler_parent)):
            fail("an unowned pending open-handler tombstone was retained.")
    if mime_ownership is None:
        mime_ownership = {"path":layout["mimeappsPath"],"scheme":"x-scheme-handler/olympus","desktopId":"ai.olympusplugin.open.desktop"}
if purge:
    backend_path = os.path.join(layout["configDir"], "secret-backend.json")
    backend = None
    if os.path.lexists(backend_path):
        check_ancestry(backend_path, leaf_owner=True)
        try:
            with open(backend_path, encoding="utf-8") as handle: selected = json.load(handle, object_pairs_hook=duplicates)
        except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"secret backend selection is unreadable: {error}; receipt retained.")
        if selected not in ({"version":1,"backend":"file"},{"version":1,"backend":"libsecret"}): fail("secret backend selection is invalid; receipt retained.")
        backend = selected["backend"]
    elif os.path.lexists(os.path.join(layout["configDir"], "secrets.enc")) or os.path.lexists(os.path.join(layout["configDir"], "secrets.key")):
        fail("file secrets exist without a durable backend selection; receipt retained.")
    if backend == "libsecret":
        fail("full purge cannot prove ownership or deletion of Secret Service items without the installed app. Inspect and delete Olympus items individually in Secret Service (never delete the whole keyring), then remove secret-backend.json and rerun --purge --yes; receipt retained.")
desktop_entry = os.path.join(layout["dataHome"], "applications", "ai.olympusplugin.Olympus.desktop")
desktop_icon = os.path.join(layout["dataHome"], "icons", "hicolor", "512x512", "apps", "ai.olympusplugin.Olympus.png")
state_names = {"service-current.json", "service-previous.json", "install-transaction.json"}
normalized, seen = [], set()
for artifact in artifacts:
    if not isinstance(artifact, dict): fail("malformed machine-artifact inventory.")
    base_keys = {"path","kind","sha256"}
    if not base_keys.issubset(artifact): fail("malformed machine-artifact inventory.")
    path, kind, expected = absolute(artifact["path"], "machine artifact"), artifact["kind"], artifact["sha256"]
    if kind not in {"file","symlink","tree"} or not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected): fail("malformed machine-artifact identity.")
    if kind == "tree":
        if set(artifact) != base_keys | {"rootDevice","rootInode","markerPath","markerSha256"}: fail("malformed generation custody identity.")
        if not isinstance(artifact["rootDevice"], int) or isinstance(artifact["rootDevice"], bool) or artifact["rootDevice"] < 0 or not isinstance(artifact["rootInode"], int) or isinstance(artifact["rootInode"], bool) or artifact["rootInode"] <= 0: fail("malformed generation inode identity.")
        if artifact["markerPath"] != os.path.join(path, ".olympus-generation.json") or not isinstance(artifact["markerSha256"], str) or len(artifact["markerSha256"]) != 64 or any(c not in "0123456789abcdef" for c in artifact["markerSha256"]): fail("malformed generation marker identity.")
    elif set(artifact) != base_keys: fail("malformed non-generation artifact identity.")
    allowed = path == layout["unitPath"] or (kind == "tree" and path == layout["packageDir"])
    allowed = allowed or (path == layout["launcherPath"] and kind == "file")
    allowed = allowed or (path == layout["openHandlerPath"] and kind == "file")
    allowed = allowed or (path in {desktop_entry, desktop_icon} and kind == "file")
    allowed = allowed or (os.path.dirname(path) == layout["stateDir"] and os.path.basename(path) in state_names and kind == "file")
    manager_dirs = [os.path.join(layout["configHome"], "systemd", "user"), os.path.join(layout["home"], ".config", "systemd", "user")]
    allowed = allowed or (kind == "symlink" and path in owned_links and os.path.basename(path) == "olympus-engine.service" and any(beneath(path, root) for root in manager_dirs))
    allowed = allowed or (beneath(path, layout["packageDir"]) and kind in {"file","tree"})
    if not allowed or path == receipt_path: fail(f"artifact is outside the machinery boundary: {path}")
    if path in seen: fail(f"duplicate machine artifact: {path}")
    check_ancestry(path, leaf_owner=True, leaf_symlink=kind == "symlink")
    seen.add(path); normalized.append((path, kind, expected, artifact))
for index, (path, _, _, _) in enumerate(normalized):
    for other, _, _, _ in normalized[index + 1:]:
        if beneath(path, other) or beneath(other, path): fail(f"overlapping artifacts: {path} and {other}")
def assert_tree_custody(path, artifact):
    root = lstat(path)
    if root is None: return False
    marker_path, marker = artifact["markerPath"], lstat(artifact["markerPath"])
    if not stat.S_ISDIR(root.st_mode) or stat.S_ISLNK(root.st_mode) or root.st_uid != uid or stat.S_IMODE(root.st_mode) & 0o077 or (root.st_dev,root.st_ino) != (artifact["rootDevice"],artifact["rootInode"]): fail(f"generation root was replaced and retained: {path}")
    if marker is None or not stat.S_ISREG(marker.st_mode) or stat.S_ISLNK(marker.st_mode) or marker.st_uid != uid or stat.S_IMODE(marker.st_mode) & 0o077 or marker.st_nlink != 1 or hash_file(marker_path) != artifact["markerSha256"]: fail(f"generation custody marker changed and was retained: {marker_path}")
    return True
for path, kind, expected, artifact in normalized:
    if kind == "tree": assert_tree_custody(path, artifact)
    else:
        observed = artifact_digest(path, kind)
        if observed is not None and observed != expected: fail(f"replaced machinery was retained: {path}")
        if path == desktop_entry and observed is not None:
            with open(path, encoding="utf-8") as handle: desktop_text = handle.read()
            groups = desktop_text.split("\n[")
            entries = [group for group in groups if group.lstrip("[").startswith("Desktop Entry]")]
            if len(entries) != 1 or [line for line in entries[0].splitlines() if line.startswith("X-Olympus-Managed=")] != ["X-Olympus-Managed=true"]: fail(f"your own launcher was retained: {path}")

def run(args): return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35)
before = run(["systemctl","--user","show","olympus-engine.service","--property=LoadState","--property=ActiveState","--property=SubState","--property=UnitFileState","--property=MainPID","--property=ControlGroup","--property=FragmentPath"])
if before.returncode != 0: fail(f"systemd custody is unknown: {(before.stderr or before.stdout).strip()[:300]}")
before_properties = dict(line.split("=", 1) for line in before.stdout.splitlines() if "=" in line)
control_group = before_properties.get("ControlGroup", "")
if before_properties.get("ActiveState") in {"active","activating","deactivating"} and not control_group: fail("the active engine cgroup is unknown; machinery was retained.")
load_state, fragment = before_properties.get("LoadState"), before_properties.get("FragmentPath", "")
unit_exists = os.path.exists(layout["unitPath"])
if load_state not in {"loaded","not-found"}: fail(f"systemd loaded an unknown engine unit state: {load_state!r}.")
if load_state == "loaded":
    if not fragment or os.path.realpath(fragment) != layout["unitPath"]: fail(f"the loaded engine unit is not receipt-owned: {fragment!r}.")
    if not unit_exists and before_properties.get("ActiveState") != "inactive": fail("the loaded engine unit file disappeared while service custody remained.")
if load_state == "loaded" and unit_exists: run(["systemctl","--user","disable","--now","olympus-engine.service"])
facts = run(["systemctl","--user","show","olympus-engine.service","--property=LoadState","--property=ActiveState","--property=SubState","--property=UnitFileState","--property=MainPID","--property=ControlGroup","--property=FragmentPath"])
if facts.returncode != 0: fail(f"systemd custody is unknown: {(facts.stderr or facts.stdout).strip()[:300]}")
properties = dict(line.split("=", 1) for line in facts.stdout.splitlines() if "=" in line)
if properties.get("ActiveState") != "inactive" or properties.get("MainPID") not in {"0",""} or properties.get("UnitFileState") not in {"disabled","not-found",""}: fail(f"systemd still owns the engine ({properties}).")
if properties.get("LoadState") == "loaded" and os.path.realpath(properties.get("FragmentPath", "")) != layout["unitPath"]: fail("systemd replaced the engine unit during removal.")
if control_group:
    events = os.path.join("/sys/fs/cgroup", control_group.lstrip("/"), "cgroup.events")
    try:
        with open(events, encoding="ascii") as handle:
            event_values = dict(line.split(None, 1) for line in handle.read().splitlines() if len(line.split(None, 1)) == 2)
            if event_values.get("populated") != "0": fail("the engine cgroup or one of its descendants still has processes.")
    except FileNotFoundError: pass
    except OSError as error: fail(f"engine cgroup custody could not be verified: {error}")

children_path = os.path.join(layout["dataDir"], "engine", "children.json")
if os.path.lexists(children_path):
    check_ancestry(children_path, leaf_owner=True)
    try:
        with open(children_path, encoding="utf-8") as handle: children_record = json.load(handle, object_pairs_hook=duplicates)
    except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"recorded child custody is unreadable: {error}")
    if children_record.get("schema") not in {"olympus.engine.children.v1","olympus.engine.children.v2"} or not isinstance(children_record.get("children"), list): fail("recorded child custody is malformed.")
    for child in children_record["children"]:
        pgid = child.get("pgid") if isinstance(child, dict) else None
        if not isinstance(pgid, int) or isinstance(pgid, bool) or pgid <= 1: fail("recorded child custody has an invalid process group.")
        try: os.kill(-pgid, 0)
        except ProcessLookupError: pass
        except PermissionError: fail(f"recorded process group {pgid} still exists or is not inspectable.")
        else: fail(f"recorded process group {pgid} still exists; machinery was retained.")
worker_socket = layout["workerSocketPath"]
if os.path.lexists(worker_socket):
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); probe.settimeout(1.5)
    try: probe.connect(worker_socket)
    except OSError as error:
        if error.errno not in {errno.ENOENT, errno.ECONNREFUSED}: fail(f"worker-socket custody is unknown ({error}).")
    else: fail("the worker socket is still accepting connections.")
    finally: probe.close()

def remove_artifact(path, kind, expected, artifact):
    parent = os.path.dirname(path)
    tombstone = os.path.join(parent, f".olympus-remove-{os.path.basename(path)}-{expected[:16]}")
    journal, pending = tombstone + ".journal.json", tombstone + ".journal.new"
    if os.path.lexists(pending):
        pending_info = os.lstat(pending)
        if pending_info.st_uid != uid or not stat.S_ISREG(pending_info.st_mode): fail(f"unsafe pending removal journal: {pending}")
        os.unlink(pending); fsync_dir(parent)
    record = None
    if os.path.lexists(journal):
        journal_info = os.lstat(journal)
        if journal_info.st_uid != uid or stat.S_IMODE(journal_info.st_mode) != 0o600 or not stat.S_ISREG(journal_info.st_mode): fail(f"unsafe removal journal: {journal}")
        try:
            with open(journal, encoding="utf-8") as handle: record = json.load(handle, object_pairs_hook=duplicates)
        except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"unreadable removal journal {journal}: {error}")
        if record.get("schema") != "olympus.engine.remove-artifact.v1" or record.get("path") != path or record.get("tombstone") != tombstone or record.get("kind") != kind or record.get("sha256") != expected or not isinstance(record.get("dev"), int) or not isinstance(record.get("ino"), int): fail(f"invalid removal journal: {journal}")
    if record is None:
        if os.path.lexists(tombstone): fail(f"unowned removal tombstone was retained: {tombstone}")
        if kind == "tree":
            if not assert_tree_custody(path, artifact): return
        else:
            observed = artifact_digest(path, kind)
            if observed is None: return
            if observed != expected: fail(f"replaced machinery was retained: {path}")
        before = os.lstat(path)
        record = {"schema":"olympus.engine.remove-artifact.v1","path":path,"tombstone":tombstone,"kind":kind,"sha256":expected,"dev":before.st_dev,"ino":before.st_ino}
        encoded = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try: os.write(fd, encoded); os.fsync(fd)
        finally: os.close(fd)
        os.replace(pending, journal); fsync_dir(parent)
    if os.path.lexists(path):
        original = os.lstat(path)
        if (original.st_dev,original.st_ino) != (record["dev"],record["ino"]) or os.path.lexists(tombstone): fail(f"artifact identity changed during removal: {path}")
        os.rename(path, tombstone); fsync_dir(parent)
    if os.path.lexists(tombstone):
        moved = os.lstat(tombstone)
        if (moved.st_dev,moved.st_ino) != (record["dev"],record["ino"]): fail(f"recovery tombstone identity changed: {tombstone}")
        shutil.rmtree(tombstone) if kind == "tree" else os.unlink(tombstone); fsync_dir(parent)
    os.unlink(journal); fsync_dir(parent)
for artifact in sorted(normalized, key=lambda item: item[0].count(os.sep), reverse=True): remove_artifact(*artifact)
if any(path in {desktop_entry, desktop_icon} for path, _, _, _ in normalized):
    for command, args in [("update-desktop-database", [os.path.dirname(desktop_entry)]), ("gtk-update-icon-cache", ["--force", "--ignore-theme-index", os.path.join(layout["dataHome"], "icons", "hicolor")])]:
        executable = shutil.which(command)
        if executable:
            try: subprocess.run([executable, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            except (OSError, subprocess.TimeoutExpired): pass
if mime_ownership is not None and os.path.lexists(layout["mimeappsPath"]):
    mime_path = layout["mimeappsPath"]
    check_ancestry(mime_path, leaf_owner=True)
    mime_info = os.lstat(mime_path)
    if not stat.S_ISREG(mime_info.st_mode) or stat.S_ISLNK(mime_info.st_mode): fail("the MIME association file changed type and was retained.")
    with open(mime_path, encoding="utf-8") as handle: mime_lines = handle.readlines()
    rewritten = []
    for line in mime_lines:
        body, ending = (line[:-1], "\n") if line.endswith("\n") else (line, "")
        if "=" not in body or body.split("=", 1)[0].strip() != mime_ownership["scheme"]:
            rewritten.append(line); continue
        key, values = body.split("=", 1)
        retained = [value for value in values.split(";") if value and value != mime_ownership["desktopId"]]
        if retained: rewritten.append(f"{key}={';'.join(retained)};{ending}")
    new_text = "".join(rewritten)
    temp = mime_path + ".olympus-remove.new"
    if os.path.lexists(temp):
        temp_info = os.lstat(temp)
        if temp_info.st_uid != uid or not stat.S_ISREG(temp_info.st_mode): fail(f"unsafe MIME recovery file: {temp}")
        os.unlink(temp)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(mime_info.st_mode))
    try:
        os.write(fd, new_text.encode()); os.fsync(fd)
    finally: os.close(fd)
    os.replace(temp, mime_path); fsync_dir(os.path.dirname(mime_path))
unknown_machinery = []
generations_dir = os.path.join(layout["packageDir"], "generations")
for empty in [generations_dir, layout["packageDir"]]:
    try:
        os.rmdir(empty); fsync_dir(os.path.dirname(empty))
    except FileNotFoundError: pass
    except OSError as error:
        if error.errno not in {errno.ENOTEMPTY, errno.EEXIST}: fail(f"empty machinery directory cleanup failed: {empty}: {error}")
        check_ancestry(empty, leaf_owner=True)
        for name in sorted(os.listdir(empty)):
            candidate = os.path.join(empty, name)
            if empty == layout["packageDir"] and candidate == generations_dir and unknown_machinery: continue
            unknown_machinery.append(candidate)
if unknown_machinery:
    fail(f"unknown engine machinery was retained: {', '.join(unknown_machinery)}. The install receipt was retained; recover any interrupted pinned install or move only verified unrelated files aside, then retry.")
reload = run(["systemctl","--user","daemon-reload"])
if reload.returncode != 0: fail(f"systemd daemon-reload failed: {(reload.stderr or reload.stdout).strip()[:300]}; receipt retained for retry.")

if restore_linger:
    predates = receipt.get("lingerPredated")
    if not isinstance(predates, bool): fail("receipt does not prove original linger state; linger preserved.")
    if not predates:
        account = run(["id","-un"])
        if account.returncode != 0 or not account.stdout.strip(): fail("account name unresolved; linger preserved.")
        disabled = run(["loginctl","--no-ask-password","disable-linger",account.stdout.strip()])
        checked = run(["loginctl","show-user",str(uid),"--property=Linger","--value"])
        if disabled.returncode != 0 or checked.returncode != 0 or checked.stdout.strip() != "no": fail("linger restoration failed; receipt retained for retry.")

def write_json_atomic(path, value):
    parent, pending = os.path.dirname(path), path + ".new"
    if os.path.lexists(pending):
        pending_info = os.lstat(pending)
        if pending_info.st_uid != uid or not stat.S_ISREG(pending_info.st_mode): fail(f"unsafe pending journal: {pending}")
        os.unlink(pending)
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try: os.write(fd, encoded); os.fsync(fd)
    finally: os.close(fd)
    os.replace(pending, path); fsync_dir(parent)

def purge_root(path):
    parent = os.path.dirname(path)
    tombstone, journal = os.path.join(parent, f".olympus-purge-{os.path.basename(path)}"), os.path.join(parent, f".olympus-purge-{os.path.basename(path)}.journal.json")
    record = None
    if os.path.lexists(journal):
        journal_info = os.lstat(journal)
        if journal_info.st_uid != uid or stat.S_IMODE(journal_info.st_mode) != 0o600 or not stat.S_ISREG(journal_info.st_mode): fail(f"unsafe purge journal: {journal}")
        try:
            with open(journal, encoding="utf-8") as handle: record = json.load(handle, object_pairs_hook=duplicates)
        except (OSError, UnicodeError, json.JSONDecodeError) as error: fail(f"unreadable purge journal {journal}: {error}")
        if record.get("schema") != "olympus.engine.purge-root.v1" or record.get("path") != path or record.get("tombstone") != tombstone or not isinstance(record.get("dev"), int) or not isinstance(record.get("ino"), int): fail(f"invalid purge journal: {journal}")
    if record is None:
        if os.path.lexists(tombstone): fail(f"unowned purge tombstone was retained: {tombstone}")
        if not os.path.lexists(path): return
        check_ancestry(path, leaf_owner=True)
        original = os.lstat(path)
        if not stat.S_ISDIR(original.st_mode) or stat.S_ISLNK(original.st_mode): fail(f"purge root changed identity: {path}")
        record = {"schema":"olympus.engine.purge-root.v1","path":path,"tombstone":tombstone,"dev":original.st_dev,"ino":original.st_ino}
        write_json_atomic(journal, record)
    if os.path.lexists(path):
        original = os.lstat(path)
        if (original.st_dev,original.st_ino) != (record["dev"],record["ino"]) or os.path.lexists(tombstone): fail(f"purge root changed during removal: {path}")
        os.rename(path, tombstone); fsync_dir(parent)
    if os.path.lexists(tombstone):
        moved = os.lstat(tombstone)
        if (moved.st_dev,moved.st_ino) != (record["dev"],record["ino"]): fail(f"purge tombstone identity changed: {tombstone}")
        shutil.rmtree(tombstone); fsync_dir(parent)
    os.unlink(journal); fsync_dir(parent)

if purge:
    roots = sorted(set([layout["dataDir"],layout["packageDir"],layout["stateDir"],layout["cacheDir"]]), key=lambda p: p.count(os.sep), reverse=True)
    purge_boundaries = {layout["dataDir"]:(os.path.join(layout["home"], ".local", "share") if layout["dataDir"] == os.path.join(layout["home"], ".local", "share", "openclaw", "olympus") else layout["dataHome"]),layout["packageDir"]:layout["dataHome"],layout["stateDir"]:layout["stateHome"],layout["cacheDir"]:layout["cacheHome"]}
    for root in roots:
        absolute(root, "purge root")
        if not beneath(root, purge_boundaries[root]) or os.path.basename(root) not in {"olympus","engine","olympus-engine"}: fail(f"purge root is outside the Olympus boundary: {root}")
        purge_root(root)
    # Never infer creation from the name, permissions or user ownership alone.
    for entry in owned_empty_parents:
        parent = entry["path"]
        info = lstat(parent)
        if info is None: continue
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid
            or stat.S_IMODE(info.st_mode) != 0o700 or (info.st_dev, info.st_ino) != (entry["device"], entry["inode"])): continue
        check_ancestry(parent, leaf_owner=True)
        try: os.rmdir(parent); fsync_dir(os.path.dirname(parent))
        except OSError as error:
            if error.errno not in {errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT}: fail(f"empty parent cleanup failed: {parent}: {error}")
    # Keep the receipt reachable until every other requested deletion finishes.
    for name in os.listdir(layout["configDir"]):
        target = os.path.join(layout["configDir"], name)
        if target == receipt_path: continue
        check_ancestry(target, leaf_owner=True, leaf_symlink=stat.S_ISLNK(os.lstat(target).st_mode))
        shutil.rmtree(target) if stat.S_ISDIR(os.lstat(target).st_mode) and not stat.S_ISLNK(os.lstat(target).st_mode) else os.unlink(target)
        fsync_dir(layout["configDir"])
    os.unlink(receipt_path); fsync_dir(layout["configDir"])
    try: os.rmdir(layout["configDir"]); fsync_dir(os.path.dirname(layout["configDir"]))
    except OSError as error:
        if error.errno not in {errno.ENOTEMPTY, errno.EEXIST}: fail(f"empty config directory cleanup failed: {error}")
else:
    retained_receipt = dict(receipt)
    retained_receipt["installationState"] = "data_retained"
    retained_receipt["machineArtifacts"] = []
    retained_receipt["ownedUnitLinks"] = []
    retained_receipt["openHandlerPending"] = False
    retained_receipt.pop("mimeOwnership", None)
    write_json_atomic(receipt_path, retained_receipt)
print("Olympus Linux engine machinery was removed.")
print("Olympus data, settings, secrets, models, logs, caches and recovery state were removed." if purge else "Data, settings, secrets, models and logs were kept.")
print("The receipt-proven pre-install linger state was restored." if restore_linger else "Linger was preserved.")
print("To disconnect ChatGPT, remove Olympus in ChatGPT; provider revocation is not performed here.")
PY
  trap - HUP INT TERM
  [ "$result" = 0 ] || exit "$result"
}

main "$@"
