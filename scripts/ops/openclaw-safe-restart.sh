#!/usr/bin/env bash
set -euo pipefail

# Exit codes:
#   0   restart completed and the new Gateway boot was proven
#   64  command usage or invalid numeric configuration
#   75  preflight refusal (missing dependency, unreadable quota/cursor metadata)
#   76  restart command failed; no retry was attempted
#   77  Gateway boot could not be proven after the restart command succeeded
#   78  credential startup is unsafe (quota floor, validate, lint, or audit)

OPENCLAW_BIN="${OPENCLAW_SAFE_RESTART_OPENCLAW_BIN:-openclaw}"
JOURNALCTL_BIN="${OPENCLAW_SAFE_RESTART_JOURNALCTL_BIN:-journalctl}"
NODE_BIN="${OPENCLAW_SAFE_RESTART_NODE_BIN:-${HOME}/.openclaw/tools/node/bin/node}"
SYSTEMCTL_BIN="${OPENCLAW_SAFE_RESTART_SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${OPENCLAW_SAFE_RESTART_CURL_BIN:-curl}"
GATEWAY_UNIT="${OPENCLAW_GATEWAY_UNIT:-openclaw-gateway.service}"
GATEWAY_SYSLOG_IDENTIFIER="${OPENCLAW_GATEWAY_SYSLOG_IDENTIFIER:-node}"
GATEWAY_LOOPBACK_URL="${OPENCLAW_GATEWAY_LOOPBACK_URL:-http://127.0.0.1:18789/}"
ONEPASSWORD_BROKER_READ_BIN="${OPENCLAW_SAFE_RESTART_1PASSWORD_BROKER_READ_BIN:-${HOME}/.openclaw/bin/op-cached-read}"
ONEPASSWORD_MIN_REMAINING="${OPENCLAW_SAFE_RESTART_1PASSWORD_MIN_REMAINING:-25}"
BOOT_TIMEOUT_SECONDS="${OPENCLAW_SAFE_RESTART_BOOT_TIMEOUT_SECONDS:-90}"
BOOT_POLL_SECONDS="${OPENCLAW_SAFE_RESTART_BOOT_POLL_SECONDS:-2}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="${OPENCLAW_SAFE_RESTART_BUN_BIN:-${HOME}/.bun/bin/bun}"
BROKER_CACHE_READINESS_SCRIPT="${OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT:-}"
BROKER_MANIFEST="${OPENCLAW_SAFE_RESTART_BROKER_MANIFEST:-}"
BROKER_CACHE_DIR="${OPENCLAW_SAFE_RESTART_BROKER_CACHE_DIR:-${HOME}/.cache/openclaw-op}"
BROKER_CACHE_MIN_REMAINING_SECONDS="${OPENCLAW_SAFE_RESTART_BROKER_CACHE_MIN_REMAINING_SECONDS:-300}"
GATEWAY_RUNTIME_PROOF_HELPER="${OPENCLAW_SAFE_RESTART_RUNTIME_PROOF_HELPER:-${SCRIPT_DIR}/lib/gateway-runtime-proof.sh}"
SYSTEMD_ACTIVITY_HELPER="${OPENCLAW_SAFE_RESTART_SYSTEMD_ACTIVITY_HELPER:-${SCRIPT_DIR}/lib/systemd-activity-classifier.sh}"
EXIT_PREFLIGHT_REFUSED=75
EXIT_RESTART_FAILED=76
EXIT_BOOT_UNPROVEN=77
EXIT_CREDENTIAL_UNSAFE=78
SECRETS_TOUCHED=0
DRY_RUN=0
PREFLIGHT_ONLY=0

if [[ ! -f "$GATEWAY_RUNTIME_PROOF_HELPER" ]]; then
  echo "Gateway runtime proof helper is missing: ${GATEWAY_RUNTIME_PROOF_HELPER}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if [[ ! -f "$SYSTEMD_ACTIVITY_HELPER" ]]; then
  echo "Systemd activity classifier helper is missing: ${SYSTEMD_ACTIVITY_HELPER}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
export GATEWAY_PROOF_SYSTEMCTL_BIN="$SYSTEMCTL_BIN"
export GATEWAY_PROOF_JOURNALCTL_BIN="$JOURNALCTL_BIN"
export GATEWAY_PROOF_CURL_BIN="$CURL_BIN"
export GATEWAY_PROOF_NODE_BIN="$NODE_BIN"
export GATEWAY_PROOF_UNIT="$GATEWAY_UNIT"
export GATEWAY_PROOF_SYSLOG_IDENTIFIER="$GATEWAY_SYSLOG_IDENTIFIER"
export GATEWAY_PROOF_LOOPBACK_URL="$GATEWAY_LOOPBACK_URL"
# shellcheck source=scripts/ops/lib/gateway-runtime-proof.sh
# shellcheck disable=SC1091  # resolved relative to this installed script
source "$GATEWAY_RUNTIME_PROOF_HELPER"
# shellcheck disable=SC2034  # consumed by the sourced activity helper
SYSTEMD_ACTIVITY_SYSTEMCTL_BIN="$SYSTEMCTL_BIN"
# shellcheck source=scripts/ops/lib/systemd-activity-classifier.sh
# shellcheck disable=SC1091  # resolved relative to this installed script
source "$SYSTEMD_ACTIVITY_HELPER"

usage() {
  cat <<'EOF'
Usage: scripts/ops/openclaw-safe-restart.sh [--secrets-touched] [--preflight-only] [--dry-run]

Validates the OpenClaw runtime, restarts the Gateway exactly once, and proves
the new invocation by systemd identity, a bounded loopback HTTP request, and a
corroborating current-invocation journal line. With --preflight-only, runs every
pre-restart gate and exits before reading runtime proof state or restarting.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --secrets-touched)
      SECRETS_TOUCHED=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

onepassword_broker_quota_summary() {
  # shellcheck disable=SC2016  # single quotes intentional: this is JS source, not shell expansion
  "$NODE_BIN" -e '
const { readFileSync } = require("node:fs");
const status = JSON.parse(readFileSync(0, "utf8"));
if (!status || !status.quota || status.state === "degraded") process.exit(2);
const remaining = Number(status.quota.remaining ?? -1);
const reset = Number(status.quota.resetSeconds ?? -1);
const used = Number(status.quota.used ?? -1);
const limit = Number(status.quota.limit ?? -1);
const brokerUsed = Number(status.brokerLiveReadsInWindow ?? -1);
const brokerLimit = Number(status.maxLiveReadsPerWindow ?? -1);
const reason = typeof status.reason === "string" ? status.reason : "";
if (![remaining, reset, used, limit, brokerUsed, brokerLimit].every(Number.isInteger)) process.exit(2);
process.stdout.write(`${remaining}\t${reset}\t${used}\t${limit}\t${brokerUsed}\t${brokerLimit}\t${status.state}\t${reason}`);
'
}

prove_gateway_stale_cache_readiness() {
  # The readiness implementation and the broker manifest are deployment-owned
  # and live outside this repository, so both default to empty here. An
  # installation that has not configured them still fails closed, but it must
  # be told which overrides to set: this is the only branch that can restart
  # during a rolling-window block, and its refusal used to name neither a
  # variable nor a path.
  if [[ -z "$BROKER_CACHE_READINESS_SCRIPT" || -z "$BROKER_MANIFEST" ]]; then
    echo "Cache-covered Gateway restart is not configured on this installation; refusing Gateway restart." >&2
    echo "Point OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT and OPENCLAW_SAFE_RESTART_BROKER_MANIFEST at this deployment's credential cache readiness implementation and broker manifest, or wait for the broker rolling window to reset." >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if [[ ! -f "$BROKER_CACHE_READINESS_SCRIPT" ]]; then
    echo "Credential cache readiness implementation is missing: ${BROKER_CACHE_READINESS_SCRIPT} (OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT); refusing Gateway restart." >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if [[ ! -f "$BROKER_MANIFEST" ]]; then
    echo "Credential broker manifest is missing: ${BROKER_MANIFEST} (OPENCLAW_SAFE_RESTART_BROKER_MANIFEST); refusing Gateway restart." >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if [[ ! -x "$BUN_BIN" ]]; then
    echo "Bun executable required for credential cache readiness is missing: ${BUN_BIN}" >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if ! "$BUN_BIN" "$BROKER_CACHE_READINESS_SCRIPT" \
    --manifest "$BROKER_MANIFEST" \
    --cache-dir "$BROKER_CACHE_DIR" \
    --caller openclaw-gateway \
    --minimum-remaining-seconds "$BROKER_CACHE_MIN_REMAINING_SECONDS" \
    --freshness-window max-stale \
    --json >/dev/null; then
    echo "Gateway credential caches cannot safely cover a broker-blocked restart." >&2
    return "$EXIT_CREDENTIAL_UNSAFE"
  fi
  echo "Gateway credential cache proof passed for the broker max-stale window."
}

preflight_1password_rate_limits() {
  local summary remaining reset used limit broker_used broker_limit broker_state broker_reason

  if [[ ! -x "$NODE_BIN" ]]; then
    echo "Node executable required for the 1Password quota preflight is missing: ${NODE_BIN}" >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if [[ ! -x "$ONEPASSWORD_BROKER_READ_BIN" ]]; then
    echo "Credential broker client is missing: ${ONEPASSWORD_BROKER_READ_BIN}; refusing Gateway restart." >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  if ! summary="$("$ONEPASSWORD_BROKER_READ_BIN" --status | onepassword_broker_quota_summary)"; then
    echo "Could not read credential broker quota status; refusing Gateway restart." >&2
    return "$EXIT_PREFLIGHT_REFUSED"
  fi
  IFS=$'\t' read -r remaining reset used limit broker_used broker_limit broker_state broker_reason <<<"$summary"
  echo "1Password broker quota: remaining=${remaining}/${limit} used=${used} reset=${reset}s broker_reads=${broker_used}/${broker_limit} state=${broker_state}"
  if (( remaining < ONEPASSWORD_MIN_REMAINING )); then
    echo "Credential broker or 1Password quota is unsafe; refusing Gateway restart." >&2
    return "$EXIT_CREDENTIAL_UNSAFE"
  fi
  if [[ "$broker_state" == "blocked" ]]; then
    if [[ "$broker_reason" != "broker_window_budget_exhausted" ]]; then
      echo "Credential broker block is not the cache-safe rolling-window case; refusing Gateway restart." >&2
      return "$EXIT_CREDENTIAL_UNSAFE"
    fi
    prove_gateway_stale_cache_readiness || return $?
    echo "Broker live-read window is exhausted; proceeding with a cache-covered Gateway restart."
  elif [[ "$broker_state" != "ok" ]]; then
    echo "Credential broker state is not healthy; refusing Gateway restart." >&2
    return "$EXIT_CREDENTIAL_UNSAFE"
  fi
}

print_plan() {
  echo "OpenClaw safe restart plan:"
  echo "  1. Check 1Password account quota (minimum remaining: ${ONEPASSWORD_MIN_REMAINING})."
  if [[ -n "$BROKER_CACHE_READINESS_SCRIPT" && -n "$BROKER_MANIFEST" ]]; then
    echo "     If only the broker rolling window is exhausted, prove every Gateway cache inside its max-stale window."
  else
    echo "     A broker rolling-window block will refuse here: set OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT and OPENCLAW_SAFE_RESTART_BROKER_MANIFEST to allow a cache-covered restart."
  fi
  echo "  2. Run: ${OPENCLAW_BIN} config validate"
  echo "  3. Run: ${OPENCLAW_BIN} doctor --lint --severity-min error --non-interactive"
  if (( SECRETS_TOUCHED == 1 )); then
    echo "  4. Run: ${OPENCLAW_BIN} secrets audit --check --allow-exec"
  fi
  echo "  5. Run once: ${OPENCLAW_BIN} gateway restart"
  echo "  6. Prove the current systemd invocation identity, bounded loopback HTTP response, and any exact corroborating listening line from that InvocationID."
}

if (( DRY_RUN == 1 )); then
  print_plan
  echo "Dry run only; no checks or restart executed."
  exit 0
fi

if ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  echo "OpenClaw CLI is required but was not found: ${OPENCLAW_BIN}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if ! command -v "$JOURNALCTL_BIN" >/dev/null 2>&1; then
  echo "journalctl is required to prove Gateway boot but was not found: ${JOURNALCTL_BIN}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if ! command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1; then
  echo "systemctl is required to read the Gateway invocation identity but was not found: ${SYSTEMCTL_BIN}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
  echo "curl is required to prove the Gateway loopback function but was not found: ${CURL_BIN}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Node is required to validate the corroborating Gateway journal line but was not found: ${NODE_BIN}" >&2
  exit "$EXIT_PREFLIGHT_REFUSED"
fi
if [[ ! "$ONEPASSWORD_MIN_REMAINING" =~ ^[0-9]+$ ]]; then
  echo "OPENCLAW_SAFE_RESTART_1PASSWORD_MIN_REMAINING must be a non-negative integer." >&2
  exit 64
fi
if [[ ! "$BOOT_TIMEOUT_SECONDS" =~ ^[0-9]+$ || ! "$BOOT_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_SAFE_RESTART_BOOT_TIMEOUT_SECONDS must be a non-negative integer and OPENCLAW_SAFE_RESTART_BOOT_POLL_SECONDS must be a positive integer." >&2
  exit 64
fi
if [[ ! "$BROKER_CACHE_MIN_REMAINING_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "OPENCLAW_SAFE_RESTART_BROKER_CACHE_MIN_REMAINING_SECONDS must be a non-negative integer." >&2
  exit 64
fi
echo "==> 1Password quota preflight"
preflight_1password_rate_limits

echo "==> OpenClaw config validation"
if ! "$OPENCLAW_BIN" config validate; then
  echo "openclaw config validate failed; refusing Gateway restart." >&2
  exit "$EXIT_CREDENTIAL_UNSAFE"
fi

echo "==> OpenClaw doctor lint (error severity)"
# --non-interactive is load-bearing: headless runs (systemd, ssh without a
# TTY) must never block on a doctor prompt (2026-07-15 hung-restart class).
if ! "$OPENCLAW_BIN" doctor --lint --severity-min error --non-interactive; then
  echo "openclaw doctor --lint --severity-min error --non-interactive failed; refusing Gateway restart." >&2
  exit "$EXIT_CREDENTIAL_UNSAFE"
fi

if (( SECRETS_TOUCHED == 1 )); then
  echo "==> OpenClaw secrets audit"
  # The audit resolves exec-provider refs in THIS process's environment.
  # Broker-backed providers (op-cached-read) need the Gateway's OLYMPUS_OP_*
  # variables; a bare CLI shell lacks them, so every broker-backed ref
  # reports REF_UNRESOLVED and the gate cannot tell a real credential
  # failure from its own missing environment (private host 2026-07-30: op_venice
  # live and serving while the audit called it unresolved, refusing every
  # restart). Borrow exactly those variables from the Gateway unit so the
  # audit measures what the Gateway itself will resolve. The operator shell
  # must not fill a variable omitted from the unit, so inherited OLYMPUS_OP_*
  # names are removed before the exact unit snapshot is overlaid.
  if ! gateway_environment="$("$SYSTEMCTL_BIN" --user show "$GATEWAY_UNIT" --property Environment --value 2>&1)"; then
    echo "Could not read the Gateway unit Environment property; refusing Gateway restart." >&2
    echo "$gateway_environment" >&2
    exit "$EXIT_CREDENTIAL_UNSAFE"
  fi
  if ! parsed_environment_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-safe-restart-env.XXXXXX")"; then
    echo "Could not allocate temporary storage for the Gateway unit Environment property." >&2
    exit "$EXIT_PREFLIGHT_REFUSED"
  fi
  if ! printf '%s' "$gateway_environment" | "$NODE_BIN" -e '
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
const words = [];
let word = "";
let started = false;
let quote = "";
let escaped = false;
for (const character of input) {
  if (escaped) {
    word += character;
    started = true;
    escaped = false;
    continue;
  }
  if (character === "\\") {
    escaped = true;
    started = true;
    continue;
  }
  if (quote) {
    if (character === quote) {
      quote = "";
    } else {
      word += character;
    }
    started = true;
    continue;
  }
  if (character === "\"" || character === "'\''") {
    quote = character;
    started = true;
    continue;
  }
  if (/\s/.test(character)) {
    if (started) {
      words.push(word);
      word = "";
      started = false;
    }
    continue;
  }
  word += character;
  started = true;
}
if (escaped || quote) process.exit(2);
if (started) words.push(word);
for (const value of words) process.stdout.write(value + "\0");
' >"$parsed_environment_file"; then
    rm -f -- "$parsed_environment_file"
    echo "Could not parse the Gateway unit Environment property; refusing Gateway restart." >&2
    exit "$EXIT_CREDENTIAL_UNSAFE"
  fi
  gateway_broker_env=()
  invalid_gateway_assignment=0
  while IFS= read -r -d '' assignment; do
    case "$assignment" in
      OLYMPUS_OP_*=*)
        if [[ ! "$assignment" =~ ^OLYMPUS_OP_[A-Za-z0-9_]*= ]]; then
          invalid_gateway_assignment=1
        else
          gateway_broker_env+=("$assignment")
        fi
        ;;
    esac
  done <"$parsed_environment_file"
  rm -f -- "$parsed_environment_file"
  if (( invalid_gateway_assignment == 1 )); then
    echo "Gateway unit Environment contains an invalid OLYMPUS_OP_* assignment; refusing Gateway restart." >&2
    exit "$EXIT_CREDENTIAL_UNSAFE"
  fi
  audit_environment=(env)
  while IFS= read -r inherited_name; do
    if [[ "$inherited_name" == OLYMPUS_OP_* ]]; then
      audit_environment+=(-u "$inherited_name")
    fi
  done < <(compgen -e)
  if (( ${#gateway_broker_env[@]} > 0 )); then
    audit_environment+=("${gateway_broker_env[@]}")
    echo "Auditing under ${#gateway_broker_env[@]} OLYMPUS_OP_* variable(s) borrowed from ${GATEWAY_UNIT}."
  fi
  if ! "${audit_environment[@]}" "$OPENCLAW_BIN" secrets audit --check --allow-exec; then
    echo "openclaw secrets audit --check --allow-exec failed; refusing Gateway restart." >&2
    exit "$EXIT_CREDENTIAL_UNSAFE"
  fi
fi

if (( PREFLIGHT_ONLY == 1 )); then
  echo "OpenClaw safe-restart preflight passed; Gateway restart and runtime proof were not run."
  exit 0
fi

pre_restart_invocation_id=""
systemd_classify_unit_activity "$GATEWAY_UNIT"
case "$SYSTEMD_ACTIVITY_CLASSIFICATION" in
  trusted-active)
    if ! gateway_proof_read_identity; then
      echo "Could not read the active Gateway identity before restart; refusing because a no-op restart could otherwise pass with the old invocation." >&2
      exit "$EXIT_PREFLIGHT_REFUSED"
    fi
    pre_restart_invocation_id="$GATEWAY_PROOF_INVOCATION_ID"
    ;;
  trusted-inactive)
    ;;
  *)
    printf 'Could not determine the Gateway pre-restart active state (state=%q exit=%s); refusing.\n' \
      "${SYSTEMD_ACTIVITY_STATE:-unavailable}" "$SYSTEMD_ACTIVITY_STATUS" >&2
    exit "$EXIT_PREFLIGHT_REFUSED"
    ;;
esac
restart_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
restart_wait_started_seconds="$SECONDS"

echo "==> Restarting OpenClaw Gateway once (started_at=${restart_started_at})"
if ! "$OPENCLAW_BIN" gateway restart; then
  echo "openclaw gateway restart failed; no retry was attempted." >&2
  exit "$EXIT_RESTART_FAILED"
fi

echo "==> Waiting for the new Gateway invocation to answer on loopback (timeout=${BOOT_TIMEOUT_SECONDS}s)"
while true; do
  if gateway_proof_current_invocation "$pre_restart_invocation_id"; then
    echo "Gateway boot proved: MainPID=${GATEWAY_PROOF_MAIN_PID} InvocationID=${GATEWAY_PROOF_INVOCATION_ID} ActiveEnterTimestamp=${GATEWAY_PROOF_ACTIVE_ENTER_TIMESTAMP}; loopback answered at ${GATEWAY_PROOF_LOOPBACK_URL}; corroborating journal line: ${GATEWAY_PROOF_JOURNAL_LINE}"
    exit 0
  fi
  if (( SECONDS - restart_wait_started_seconds >= BOOT_TIMEOUT_SECONDS )); then
    echo "Gateway proof failed after ${BOOT_TIMEOUT_SECONDS}s: ${GATEWAY_PROOF_FAILURE_REASON}." >&2
    echo "Required proof: current systemd identity, bounded loopback HTTP response, and a corroborating current-invocation '[gateway] http server listening' line." >&2
    echo "Run: openclaw gateway stability --bundle latest" >&2
    echo "The real config undo is OpenClaw's .bak.* rotation; do not hand-edit openclaw.json." >&2
    exit "$EXIT_BOOT_UNPROVEN"
  fi
  echo "Gateway runtime proof is not complete yet (${GATEWAY_PROOF_FAILURE_REASON}); waiting..."
  sleep "$BOOT_POLL_SECONDS"
done
