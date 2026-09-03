#!/usr/bin/env bash

# Shared, read-only proof for the current OpenClaw Gateway invocation.
#
# Load-bearing facts:
#   1. systemd reports a complete, currently-active MainPID / InvocationID /
#      ActiveEnterTimestamp identity;
#   2. the configured loopback HTTP endpoint answers a bounded request; and
#   3. the current invocation's journal contains an exact listening line.
#
# Journal text is corroboration only. A plugin in the Gateway process can emit
# the same message, so no ordering or message-selection rule is used to infer
# which code wrote it. Identity and the answering socket carry the verdict.

# shellcheck disable=SC2034  # result globals are consumed by scripts that source this helper
GATEWAY_PROOF_SYSTEMCTL_BIN="${GATEWAY_PROOF_SYSTEMCTL_BIN:-systemctl}"
GATEWAY_PROOF_JOURNALCTL_BIN="${GATEWAY_PROOF_JOURNALCTL_BIN:-journalctl}"
GATEWAY_PROOF_CURL_BIN="${GATEWAY_PROOF_CURL_BIN:-curl}"
GATEWAY_PROOF_NODE_BIN="${GATEWAY_PROOF_NODE_BIN:-node}"
GATEWAY_PROOF_UNIT="${GATEWAY_PROOF_UNIT:-openclaw-gateway.service}"
GATEWAY_PROOF_SYSLOG_IDENTIFIER="${GATEWAY_PROOF_SYSLOG_IDENTIFIER:-node}"
GATEWAY_PROOF_LOOPBACK_URL="${GATEWAY_PROOF_LOOPBACK_URL:-http://127.0.0.1:18789/}"
GATEWAY_PROOF_CONNECT_TIMEOUT_SECONDS="${GATEWAY_PROOF_CONNECT_TIMEOUT_SECONDS:-1}"
GATEWAY_PROOF_HTTP_TIMEOUT_SECONDS="${GATEWAY_PROOF_HTTP_TIMEOUT_SECONDS:-2}"

GATEWAY_PROOF_MAIN_PID=""
GATEWAY_PROOF_INVOCATION_ID=""
GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP=""
GATEWAY_PROOF_JOURNAL_LINE=""
GATEWAY_PROOF_FAILURE_REASON=""

gateway_proof_read_identity() {
  local output line main_pid="" invocation_id="" active_enter_timestamp=""

  GATEWAY_PROOF_FAILURE_REASON=""
  if ! output="$("$GATEWAY_PROOF_SYSTEMCTL_BIN" --user show "$GATEWAY_PROOF_UNIT" \
    --property MainPID \
    --property InvocationID \
    --property ActiveEnterTimestamp \
    --no-pager 2>&1)"; then
    GATEWAY_PROOF_FAILURE_REASON="systemctl could not read the Gateway invocation identity"
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      MainPID=*) main_pid="${line#MainPID=}" ;;
      InvocationID=*) invocation_id="${line#InvocationID=}" ;;
      ActiveEnterTimestamp=*) active_enter_timestamp="${line#ActiveEnterTimestamp=}" ;;
    esac
  done <<<"$output"
  if [[ ! "$main_pid" =~ ^[1-9][0-9]*$ \
    || ! "$invocation_id" =~ ^[A-Fa-f0-9]{32}$ \
    || -z "$active_enter_timestamp" \
    || "$active_enter_timestamp" == "n/a" ]]; then
    GATEWAY_PROOF_FAILURE_REASON="systemctl returned an incomplete Gateway MainPID, InvocationID, or ActiveEnterTimestamp"
    return 1
  fi

  GATEWAY_PROOF_MAIN_PID="$main_pid"
  GATEWAY_PROOF_INVOCATION_ID="$invocation_id"
  GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP="$active_enter_timestamp"
}

gateway_proof_capture_active_identity() {
  local first_main_pid first_invocation_id first_active_enter_timestamp

  if ! "$GATEWAY_PROOF_SYSTEMCTL_BIN" --user is-active --quiet "$GATEWAY_PROOF_UNIT"; then
    GATEWAY_PROOF_FAILURE_REASON="systemctl does not report the Gateway active"
    return 1
  fi
  gateway_proof_read_identity || return 1
  first_main_pid="$GATEWAY_PROOF_MAIN_PID"
  first_invocation_id="$GATEWAY_PROOF_INVOCATION_ID"
  first_active_enter_timestamp="$GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP"
  if ! "$GATEWAY_PROOF_SYSTEMCTL_BIN" --user is-active --quiet "$GATEWAY_PROOF_UNIT"; then
    GATEWAY_PROOF_FAILURE_REASON="the Gateway stopped while its identity was captured"
    return 1
  fi
  gateway_proof_read_identity || return 1
  if [[ "$GATEWAY_PROOF_MAIN_PID" != "$first_main_pid" \
    || "$GATEWAY_PROOF_INVOCATION_ID" != "$first_invocation_id" \
    || "$GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP" != "$first_active_enter_timestamp" ]]; then
    GATEWAY_PROOF_FAILURE_REASON="the Gateway identity changed while it was captured"
    return 1
  fi
}

gateway_proof_extract_corroborating_line() {
  local unit="$1"
  local syslog_identifier="$2"
  local main_pid="$3"
  local invocation_id="$4"

  "$GATEWAY_PROOF_NODE_BIN" -e '
const { readFileSync } = require("node:fs");
const [unit, identifier, mainPid, invocationId] = process.argv.slice(1);
const pattern =
  /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?\[gateway\] http server listening \([0-9]+ plugins?(?:: [^)\r\n]*)?\)$/;
let displayLine = "";
for (const line of readFileSync(0, "utf8").split(/\r?\n/)) {
  if (!line) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  const journalUnit = entry._SYSTEMD_USER_UNIT || entry._SYSTEMD_UNIT;
  const message = typeof entry.MESSAGE === "string" ? entry.MESSAGE : "";
  if (
    journalUnit === unit
    && entry.SYSLOG_IDENTIFIER === identifier
    && String(entry._PID ?? "") === mainPid
    && entry._SYSTEMD_INVOCATION_ID === invocationId
    && pattern.test(message)
    && !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)
  ) {
    // Selection is display-only. Existence is the corroboration predicate;
    // identity plus the answering socket carry the proof.
    displayLine = message;
  }
}
if (!displayLine) process.exit(1);
process.stdout.write(displayLine);
' "$unit" "$syslog_identifier" "$main_pid" "$invocation_id"
}

gateway_proof_current_invocation() {
  local forbidden_invocation_id="${1:-}"
  local journal_output corroborating_line
  local proven_main_pid proven_invocation_id proven_active_enter_timestamp

  GATEWAY_PROOF_MAIN_PID=""
  GATEWAY_PROOF_INVOCATION_ID=""
  GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP=""
  GATEWAY_PROOF_JOURNAL_LINE=""
  GATEWAY_PROOF_FAILURE_REASON=""

  gateway_proof_capture_active_identity || return 1
  if [[ -n "$forbidden_invocation_id" \
    && "$GATEWAY_PROOF_INVOCATION_ID" == "$forbidden_invocation_id" ]]; then
    GATEWAY_PROOF_FAILURE_REASON="the active Gateway still has the abort-time InvocationID"
    return 1
  fi
  proven_main_pid="$GATEWAY_PROOF_MAIN_PID"
  proven_invocation_id="$GATEWAY_PROOF_INVOCATION_ID"
  proven_active_enter_timestamp="$GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP"

  if ! "$GATEWAY_PROOF_CURL_BIN" \
    --fail \
    --silent \
    --show-error \
    --output /dev/null \
    --connect-timeout "$GATEWAY_PROOF_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$GATEWAY_PROOF_HTTP_TIMEOUT_SECONDS" \
    --header "Connection: close" \
    "$GATEWAY_PROOF_LOOPBACK_URL"; then
    GATEWAY_PROOF_FAILURE_REASON="the Gateway loopback HTTP port did not answer the bounded request"
    return 1
  fi

  if ! journal_output="$("$GATEWAY_PROOF_JOURNALCTL_BIN" --user \
    --unit "$GATEWAY_PROOF_UNIT" \
    "_SYSTEMD_INVOCATION_ID=${GATEWAY_PROOF_INVOCATION_ID}" \
    "_PID=${GATEWAY_PROOF_MAIN_PID}" \
    --grep '\[gateway\] http server listening' \
    --no-pager \
    --output=json 2>&1)"; then
    GATEWAY_PROOF_FAILURE_REASON="the current Gateway invocation journal could not be read"
    return 1
  fi
  if ! corroborating_line="$(printf '%s\n' "$journal_output" \
    | gateway_proof_extract_corroborating_line \
      "$GATEWAY_PROOF_UNIT" \
      "$GATEWAY_PROOF_SYSLOG_IDENTIFIER" \
      "$GATEWAY_PROOF_MAIN_PID" \
      "$GATEWAY_PROOF_INVOCATION_ID")"; then
    GATEWAY_PROOF_FAILURE_REASON="the current Gateway invocation has no corroborating listening line"
    return 1
  fi

  # Fence a restart during the proof itself. The answering request and
  # corroborating line are accepted only when systemd reports the same active
  # identity on both sides of them.
  if ! "$GATEWAY_PROOF_SYSTEMCTL_BIN" --user is-active --quiet "$GATEWAY_PROOF_UNIT"; then
    GATEWAY_PROOF_FAILURE_REASON="the Gateway stopped during runtime proof"
    return 1
  fi
  gateway_proof_read_identity || return 1
  if [[ "$GATEWAY_PROOF_MAIN_PID" != "$proven_main_pid" \
    || "$GATEWAY_PROOF_INVOCATION_ID" != "$proven_invocation_id" \
    || "$GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP" != "$proven_active_enter_timestamp" ]]; then
    GATEWAY_PROOF_FAILURE_REASON="the Gateway invocation identity changed during runtime proof"
    return 1
  fi
  GATEWAY_PROOF_JOURNAL_LINE="$corroborating_line"
}
