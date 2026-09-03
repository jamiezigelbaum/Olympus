#!/usr/bin/env bash
set -euo pipefail

base_wrapper="${OLYMPUS_GOG_BASE_WRAPPER:-$HOME/.openclaw/bin/gog-1password-olympus-secure}"

if { [ "${1:-}" != "drive" ] || { [ "${2:-}" != "search" ] && [ "${2:-}" != "ls" ]; }; }; then
  exec "$base_wrapper" "$@"
fi

shim="$(mktemp)"
cleanup() {
  rm -f "$shim"
}
trap cleanup EXIT

cat > "$shim" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
python3 - "$@" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DRIVE_FIELDS = "files(id,name,mimeType,modifiedTime,version,driveId,parents),nextPageToken"
MAX_RESULTS_CAP = 250


def pop_flag_value(args, index):
    if index + 1 >= len(args):
        raise SystemExit(f"missing value for {args[index]}")
    value = args[index + 1]
    del args[index:index + 2]
    return value


def normalize_args(argv):
    args = list(argv)
    account = None
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--account", "-a"):
            account = pop_flag_value(args, index)
            continue
        if arg.startswith("--account="):
            account = arg.split("=", 1)[1]
            del args[index]
            continue
        index += 1
    return args, account


def split_drive_args(args):
    if len(args) < 2 or args[0] != "drive" or args[1] not in ("search", "ls"):
        raise SystemExit("unsupported direct Drive fallback command")

    command = args[1]
    query_parts = []
    max_results = 20
    page_token = None
    fields = DRIVE_FIELDS
    raw_query = False
    drive_id = None
    parent = None
    include_all_drives = True
    list_all = False
    index = 2

    while index < len(args):
        arg = args[index]
        if arg == "--json" or arg == "--no-input" or arg == "--results-only" or arg == "--plain":
            index += 1
            continue
        if arg == "--raw-query":
            raw_query = True
            index += 1
            continue
        if arg == "--all":
            list_all = True
            index += 1
            continue
        if arg == "--all-drives":
            include_all_drives = True
            index += 1
            continue
        if arg == "--no-all-drives":
            include_all_drives = False
            index += 1
            continue
        if arg in ("--max", "--page", "--fields", "--drive", "--parent", "--query"):
            if index + 1 >= len(args):
                raise SystemExit(f"missing value for {arg}")
            value = args[index + 1]
            if arg == "--max":
                try:
                    max_results = int(value)
                except ValueError:
                    max_results = 20
            elif arg == "--page":
                page_token = value
            elif arg == "--fields":
                fields = value
            elif arg == "--drive":
                drive_id = value
            elif arg == "--parent":
                parent = value
            elif arg == "--query":
                query_parts.append(value)
            index += 2
            continue
        if arg.startswith("--"):
            # Unknown read/display flag. Ignore so gog-compatible harmless flags
            # do not prevent the metadata fallback from working.
            index += 1
            continue
        query_parts.append(arg)
        index += 1

    if command == "ls" and not list_all and not parent:
        parent = "root"

    return {
        "command": command,
        "query": " ".join(part for part in query_parts if part).strip(),
        "max_results": max(1, min(max_results, MAX_RESULTS_CAP)),
        "page_token": page_token,
        "fields": fields,
        "raw_query": raw_query,
        "drive_id": drive_id,
        "parent": parent,
        "include_all_drives": include_all_drives,
    }


def q_literal(value):
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def build_query(parsed):
    parts = []
    query = parsed["query"]
    if parsed["raw_query"] and query:
        parts.append(query)
    elif query:
        literal = q_literal(query)
        parts.append(f"(name contains {literal} or fullText contains {literal})")
    if parsed["parent"]:
        parts.append(f"{q_literal(parsed['parent'])} in parents")
    parts.append("trashed = false")
    return " and ".join(parts)


def fetch_drive_files(parsed):
    token = os.environ.get("GOG_ACCESS_TOKEN")
    if not token:
        raise SystemExit("GOG_ACCESS_TOKEN is required for direct Drive metadata fallback")

    params = {
        "pageSize": str(parsed["max_results"]),
        "fields": parsed["fields"],
        "supportsAllDrives": "true",
        "q": build_query(parsed),
    }
    if parsed["page_token"]:
        params["pageToken"] = parsed["page_token"]
    if parsed["drive_id"]:
        params["corpora"] = "drive"
        params["driveId"] = parsed["drive_id"]
        params["includeItemsFromAllDrives"] = "true"
    elif parsed["include_all_drives"]:
        params["corpora"] = "allDrives"
        params["includeItemsFromAllDrives"] = "true"
    else:
        params["corpora"] = "user"

    url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        print(detail[:1000], file=sys.stderr)
        raise SystemExit(1)


args, _account = normalize_args(sys.argv[1:])
parsed = split_drive_args(args)
print(json.dumps(fetch_drive_files(parsed), separators=(",", ":")))
PY
SHIM
chmod +x "$shim"

OLYMPUS_GOG_BIN="$shim" "$base_wrapper" "$@"
