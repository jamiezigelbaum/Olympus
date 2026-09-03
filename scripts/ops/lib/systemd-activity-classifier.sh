#!/usr/bin/env bash

# Exact systemctl is-active classification shared by runtime custody paths.
#
# Consumers must branch only on SYSTEMD_ACTIVITY_CLASSIFICATION:
#   trusted-active   = active/0
#   trusted-inactive = inactive/3 or failed/3
#   untrusted/error  = every missing, inconsistent, or query-error result
#
# The raw state and exit are retained only for a content-free refusal message.

# shellcheck disable=SC2034  # result globals are consumed by scripts that source this helper
SYSTEMD_ACTIVITY_SYSTEMCTL_BIN="${SYSTEMD_ACTIVITY_SYSTEMCTL_BIN:-systemctl}"
SYSTEMD_ACTIVITY_CLASSIFICATION="untrusted/error"
SYSTEMD_ACTIVITY_STATE=""
SYSTEMD_ACTIVITY_STATUS=0

systemd_classify_unit_activity() {
  local unit_name="$1"
  local activity_state
  local activity_status=0

  activity_state="$("$SYSTEMD_ACTIVITY_SYSTEMCTL_BIN" --user is-active "$unit_name" 2>&1)" \
    || activity_status=$?
  SYSTEMD_ACTIVITY_STATE="$activity_state"
  SYSTEMD_ACTIVITY_STATUS="$activity_status"
  case "${activity_state}:${activity_status}" in
    active:0)
      SYSTEMD_ACTIVITY_CLASSIFICATION="trusted-active"
      ;;
    inactive:3|failed:3)
      SYSTEMD_ACTIVITY_CLASSIFICATION="trusted-inactive"
      ;;
    *)
      SYSTEMD_ACTIVITY_CLASSIFICATION="untrusted/error"
      ;;
  esac
}
