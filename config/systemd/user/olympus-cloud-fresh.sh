#!/usr/bin/env bash
set -euo pipefail

# Daily compatibility refresh for Drive and Readwise. X is owned exclusively
# by the canonical worker scheduler after Slice 2.

# Deliberately literal: this credential-bearing request must never be redirected
# by deployment environment to a remote or URL-credential endpoint.
WORKER_BASE_URL="http://127.0.0.1:8010/v1"
AUTH_HEADER_FILE="${OLYMPUS_WORKER_AUTH_HEADER_FILE:-${HOME}/.config/olympus/curl-auth-header}"
LOG_PATH="${OLYMPUS_CLOUD_FRESHNESS_LOG_PATH:-${HOME}/olympus-fresh/cloud-fresh.log}"
RETRY_DELAY_SECONDS="${OLYMPUS_CLOUD_FRESHNESS_RETRY_DELAY_SECONDS:-10}"
CURL_TIMEOUT_SECONDS="${OLYMPUS_CLOUD_FRESHNESS_CURL_TIMEOUT_SECONDS:-600}"
CURL_BIN="${OLYMPUS_CLOUD_FRESHNESS_CURL_BIN:-curl}"

if [[ ! "$CURL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Cloud freshness curl timeout must be a positive integer." >&2
  exit 64
fi

assert_private_regular_file() {
  local path="$1"
  local mode
  if [[ ! -f "$path" || -L "$path" || ! -r "$path" || ! -O "$path" ]]; then
    echo "Worker authorization header must be a readable owner-private regular non-symlink file." >&2
    return 1
  fi
  mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
  if [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 077) != 0 )); then
    echo "Worker authorization header must not be accessible by group or other users." >&2
    return 1
  fi
}

assert_private_regular_file "$AUTH_HEADER_FILE"

mkdir -p "$(dirname -- "$LOG_PATH")"

curl_args=(
  --silent
  --show-error
  --max-time "$CURL_TIMEOUT_SECONDS"
  --request POST
  --header 'Content-Type: application/json'
  --header "@${AUTH_HEADER_FILE}"
)

status_of() {
  local corpus_id="$1"
  python3 -c 'import json, sys
try:
    value = json.load(sys.stdin)
    direct = value.get("status")
    if direct in {"completed", "progress", "idle"}:
        print("accepted")
    elif value.get("kind") == "source_scheduler_status" and value.get("policy", {}).get("counts_only") is True:
        matching = [source for source in value.get("sources", []) if source.get("corpus_id") == sys.argv[1]]
        print("accepted" if len(matching) == 1 else "err")
    else:
        print("err")
except Exception:
    print("noresp")' "$corpus_id" 2>/dev/null
}

sync_corpus() {
  local corpus_id="$1"
  local attempt response status
  status="noresp"
  for attempt in 1 2 3; do
    response=""
    if response="$("$CURL_BIN" "${curl_args[@]}" \
      --data "{\"corpus_id\":\"${corpus_id}\"}" \
      "${WORKER_BASE_URL}/source/index/sync" 2>/dev/null)"; then
      status="$(printf '%s' "$response" | status_of "$corpus_id")"
    else
      status="noresp"
    fi
    # The canonical scheduler owns task outcome and health. This compatibility
    # timer proves only that its bounded operator handoff was accepted.
    if [[ "$status" == "accepted" ]]; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      sleep "$RETRY_DELAY_SECONDS"
    fi
  done
  printf '%s cloud-fresh %s failed after 3 tries (last=%s)\n' \
    "$(date -u +%FT%TZ)" "$corpus_id" "$status" >> "$LOG_PATH"
  return 1
}

failed=0
corpus_ids=(
  "internal.drive.docs"
  "internal.readwise.library"
)
for corpus_id in "${corpus_ids[@]}"
do
  if ! sync_corpus "$corpus_id"; then
    failed=1
  fi
done

exit "$failed"
