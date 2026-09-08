#!/usr/bin/env bash
set -euo pipefail

# Olympus transcription wrapper: the single local transcription command that
# every caller shares (extraction scheduler via OLYMPUS_TRANSCRIBE_COMMAND, the
# WhatsApp transcribe drain, manual castor-sendfile runs).
#
#   olympus-whisper-transcribe <media-file>   # transcript on stdout
#   olympus-whisper-transcribe --sweep        # remove stale temp dirs only
#
# Why it looks like this (sparta incident, 2026-09-08): the previous wrapper
# ran an unbounded number of CPU whisper jobs in parallel on unconverted
# multi-hour video, and a killed wrapper left its whisper grandchild running.
# This version gates every caller through one flock semaphore, lowers its own
# priority and thread count, downmixes to 16 kHz mono first, refuses inputs
# over a duration cap, prefers the loopback (Delphi tunnel) transcription lane
# when one is configured, fits every sub-budget inside one deadline, forwards
# signals to whatever child is running, and cleans up after itself.
#
# Egress boundary: OLYMPUS_TRANSCRIBE_URL is only ever a loopback address
# (127.0.0.1 or localhost). That is the SSH tunnel to the owner's own Delphi
# appliance, the same trust class as the local VLM extractor. Any other host is
# refused before any work starts (exit 78); no env var can turn this wrapper
# into cloud egress.
#
# This file is a TEMPLATE owned by the repository. The host installer copies
# it to ~/bin/olympus-whisper-transcribe; a refresh overwrites hand edits, so
# fix it here.
#
# Exit codes (the extractor treats 64/65/66/76/78 as terminal, the rest as
# retryable):
#   0   transcript on stdout
#   64  usage / malformed knob
#   65  refused: over a duration cap, ffmpeg could not downmix, or the remote
#       lane failed on a file too long for the local CPU fallback
#   66  input unreadable (missing file, or ffprobe cannot read its duration)
#   69  no slot in time, a required tool is missing, or the deadline is spent
#   70  local whisper failed
#   76  remote lane rejected the request permanently (HTTP 400/401/403/404)
#   78  remote lane misconfigured (OLYMPUS_TRANSCRIBE_URL is not loopback)
#   130 stopped by SIGINT; 143 stopped by SIGTERM

# The caller's stderr, kept on fd 3: a signal trap can fire while a child's
# streams are redirected into the work dir, and its message must still reach
# the operator rather than a file that is about to be removed.
exec 3>&2
log() { printf 'olympus-whisper-transcribe: %s\n' "$*" >&3; }
die() { local code="$1"; shift; log "$@"; exit "$code"; }

START_EPOCH="$(date +%s)"

# --- knobs --------------------------------------------------------------------
# One deadline governs every sub-budget. It defaults to the extractor's own
# DEFAULT_TRANSCRIBE_TIMEOUT_MS (1800 s); the runner kills the whole process
# group at that point, so everything here has to finish first.
DEADLINE_SECONDS="${OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS:-1800}"
SLOTS="${OLYMPUS_TRANSCRIBE_SLOTS:-1}"
LOCK_DIR="${OLYMPUS_TRANSCRIBE_LOCK_DIR:-${XDG_RUNTIME_DIR:-/tmp}/olympus-transcribe-locks}"
NICE_LEVEL="${OLYMPUS_TRANSCRIBE_NICE:-15}"
THREADS="${OLYMPUS_TRANSCRIBE_THREADS:-4}"
MAX_MINUTES="${OLYMPUS_TRANSCRIBE_MAX_MINUTES:-180}"
# CPU fallback is near real time on `base` with 4 threads; keep it inside the
# deadline so a long file is refused up front, never orphaned.
LOCAL_MAX_MINUTES="${OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES:-25}"
TMP_ROOT="${OLYMPUS_TRANSCRIBE_TMP_ROOT:-/tmp}"
SWEEP_AGE_MINUTES="${OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES:-1440}"
SWEEP_ON_START="${OLYMPUS_TRANSCRIBE_SWEEP_ON_START:-true}"
STOP_GRACE_SECONDS="${OLYMPUS_TRANSCRIBE_STOP_GRACE_SECONDS:-10}"

REMOTE_URL="${OLYMPUS_TRANSCRIBE_URL:-}"
REMOTE_MODEL="${OLYMPUS_TRANSCRIBE_REMOTE_MODEL:-delphi/transcription}"
REMOTE_CONNECT_TIMEOUT_SECONDS="${OLYMPUS_TRANSCRIBE_REMOTE_CONNECT_TIMEOUT_SECONDS:-10}"

WHISPER_MODEL="${OLYMPUS_WHISPER_MODEL:-base}"
WHISPER_BIN="${OLYMPUS_WHISPER_BIN:-${HOME}/.local/bin/whisper}"
FFMPEG_BIN="${OLYMPUS_TRANSCRIBE_FFMPEG_BIN:-ffmpeg}"
FFPROBE_BIN="${OLYMPUS_TRANSCRIBE_FFPROBE_BIN:-ffprobe}"
CURL_BIN="${OLYMPUS_TRANSCRIBE_CURL_BIN:-curl}"
FLOCK_BIN="${OLYMPUS_TRANSCRIBE_FLOCK_BIN:-flock}"
PGREP_BIN="${OLYMPUS_TRANSCRIBE_PGREP_BIN:-pgrep}"
PKILL_BIN="${OLYMPUS_TRANSCRIBE_PKILL_BIN:-pkill}"
LSOF_BIN="${OLYMPUS_TRANSCRIBE_LSOF_BIN:-lsof}"

is_positive_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
is_nonneg_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

is_positive_int "$DEADLINE_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS must be a positive integer (got '$DEADLINE_SECONDS')."
# Derived defaults: a third of the deadline may go to waiting for a slot and
# half to the remote call, which leaves the remaining sixth for ffprobe,
# ffmpeg and a short local fallback. Explicit values are checked against the
# same arithmetic below.
LOCK_WAIT_SECONDS="${OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS:-$(( DEADLINE_SECONDS / 3 ))}"
REMOTE_TIMEOUT_SECONDS="${OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS:-$(( DEADLINE_SECONDS / 2 ))}"

is_positive_int "$SLOTS" || die 64 "OLYMPUS_TRANSCRIBE_SLOTS must be a positive integer (got '$SLOTS')."
is_nonneg_int "$LOCK_WAIT_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS must be a non-negative integer."
is_positive_int "$THREADS" || die 64 "OLYMPUS_TRANSCRIBE_THREADS must be a positive integer."
is_positive_int "$MAX_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_MAX_MINUTES must be a positive integer."
is_positive_int "$LOCAL_MAX_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES must be a positive integer."
is_positive_int "$SWEEP_AGE_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES must be a positive integer."
is_positive_int "$REMOTE_TIMEOUT_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS must be a positive integer."
is_positive_int "$REMOTE_CONNECT_TIMEOUT_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_REMOTE_CONNECT_TIMEOUT_SECONDS must be a positive integer."
is_positive_int "$STOP_GRACE_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_STOP_GRACE_SECONDS must be a positive integer."
[[ "$NICE_LEVEL" =~ ^-?[0-9]+$ ]] || die 64 "OLYMPUS_TRANSCRIBE_NICE must be an integer."
if (( LOCK_WAIT_SECONDS + REMOTE_TIMEOUT_SECONDS >= DEADLINE_SECONDS )); then
  die 64 "OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS (${LOCK_WAIT_SECONDS}) + OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS (${REMOTE_TIMEOUT_SECONDS}) must be below OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS (${DEADLINE_SECONDS})."
fi

# --- egress boundary: the remote lane is loopback only ------------------------------
# http(s)://127.0.0.1[:port]/... or http(s)://localhost[:port]/... and nothing
# else. Userinfo, other hosts, IPv6 literals and non-http schemes are refused.
# This is checked before the sweep, before ffprobe, before anything.
if [[ -n "$REMOTE_URL" ]]; then
  if [[ ! "$REMOTE_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[^[:space:]]*)?$ ]]; then
    die 78 "refusing OLYMPUS_TRANSCRIBE_URL='${REMOTE_URL}': the remote lane must be loopback (127.0.0.1 or localhost, the Delphi tunnel); this wrapper never sends audio anywhere else"
  fi
fi

seconds_elapsed() { echo $(( $(date +%s) - START_EPOCH )); }
seconds_remaining() { echo $(( DEADLINE_SECONDS - $(seconds_elapsed) )); }

# --- orphan sweeper -------------------------------------------------------------
# Removes temp dirs older than the age cap that no live process references.
# Both prefixes are swept: the extractor's byte spill (olympus-transcribe-*)
# and this wrapper's own work dir (olympus-whisper.*). Fails closed: without
# pgrep nothing is removed, and a dir is kept when any process names it on
# its command line, has its cwd inside it, or holds a file under it open
# (Linux: /proc/*/cwd and /proc/*/fd; elsewhere: lsof +D when available).
dir_is_referenced() {
  local dir="$1" link target
  if "$PGREP_BIN" -f -- "$dir" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -d /proc/self ]]; then
    for link in /proc/[0-9]*/cwd /proc/[0-9]*/fd/*; do
      target="$(readlink -- "$link" 2>/dev/null)" || continue
      if [[ "$target" == "$dir" || "$target" == "$dir/"* ]]; then
        return 0
      fi
    done
  elif command -v "$LSOF_BIN" >/dev/null 2>&1; then
    if [[ -n "$("$LSOF_BIN" -Fn +D "$dir" 2>/dev/null)" ]]; then
      return 0
    fi
  fi
  return 1
}

sweep_stale_temp_dirs() {
  local dir removed=0 kept=0
  if ! command -v "$PGREP_BIN" >/dev/null 2>&1; then
    log "sweep: pgrep not found; refusing to remove anything (liveness check unavailable)"
    return 0
  fi
  while IFS= read -r -d '' dir; do
    if dir_is_referenced "$dir"; then
      kept=$((kept + 1))
      continue
    fi
    if rm -rf -- "$dir" 2>/dev/null; then
      removed=$((removed + 1))
      log "sweep: removed stale $dir"
    fi
  done < <(find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -type d \
    \( -name 'olympus-transcribe-*' -o -name 'olympus-whisper.*' \) \
    -mmin "+${SWEEP_AGE_MINUTES}" -print0 2>/dev/null)
  if (( removed > 0 || kept > 0 )); then
    log "sweep: removed ${removed}, kept ${kept} still referenced by a live process"
  fi
}

if [[ "${1:-}" == "--sweep" ]]; then
  sweep_stale_temp_dirs
  exit 0
fi

[[ $# -eq 1 ]] || die 64 "usage: olympus-whisper-transcribe <media-file> | --sweep"
input="$1"
[[ -f "$input" && -r "$input" ]] || die 66 "input is not a readable file: $input"

if [[ "$SWEEP_ON_START" == "true" ]]; then
  sweep_stale_temp_dirs || true
fi

# --- required tools (fail closed; never pass raw media through) ---------------------
command -v "$FFPROBE_BIN" >/dev/null 2>&1 || die 69 "ffprobe is required but was not found (OLYMPUS_TRANSCRIBE_FFPROBE_BIN=${FFPROBE_BIN})"
command -v "$FFMPEG_BIN" >/dev/null 2>&1 || die 69 "ffmpeg is required but was not found (OLYMPUS_TRANSCRIBE_FFMPEG_BIN=${FFMPEG_BIN})"
command -v "$FLOCK_BIN" >/dev/null 2>&1 || die 69 "flock is required (util-linux) but was not found."
if [[ -n "$REMOTE_URL" ]]; then
  command -v "$CURL_BIN" >/dev/null 2>&1 || die 69 "curl is required for the remote lane but was not found (OLYMPUS_TRANSCRIBE_CURL_BIN=${CURL_BIN})"
fi

# --- duration caps (before the semaphore: a refusal must never hold a slot) --------
duration_seconds="$("$FFPROBE_BIN" -v error -show_entries format=duration -of csv=p=0 -- "$input" 2>/dev/null || true)"
duration_seconds="${duration_seconds%%.*}"
is_nonneg_int "$duration_seconds" || die 66 "ffprobe could not read the duration of ${input}; refusing to transcribe an unreadable input"
duration_minutes=$(( (duration_seconds + 59) / 60 ))
if (( duration_minutes > MAX_MINUTES )); then
  die 65 "refusing ${input}: duration ${duration_minutes} min exceeds OLYMPUS_TRANSCRIBE_MAX_MINUTES=${MAX_MINUTES}"
fi
# The local CPU lane runs near real time, so it needs roughly the audio's
# duration in wall time, on top of being under its own cap.
local_fallback_allowed=true
local_refusal=""
if (( duration_minutes > LOCAL_MAX_MINUTES )); then
  local_fallback_allowed=false
  local_refusal="duration ${duration_minutes} min exceeds OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES=${LOCAL_MAX_MINUTES}"
fi
if [[ -z "$REMOTE_URL" ]]; then
  if [[ "$local_fallback_allowed" == false ]]; then
    die 65 "refusing ${input} for local CPU whisper: ${local_refusal} (no remote lane configured)"
  fi
  if (( $(seconds_remaining) < duration_seconds )); then
    die 69 "refusing ${input}: $(seconds_remaining)s left of OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS=${DEADLINE_SECONDS} is less than the ${duration_seconds}s of audio the local CPU lane needs"
  fi
fi

# --- semaphore ---------------------------------------------------------------------
# N slot files under LOCK_DIR; a caller holds exactly one for the whole job.
# The lock fd is inherited by every child, so whisper itself keeps the slot
# until it exits, whatever happens to this shell.
mkdir -p -- "$LOCK_DIR"
# Slot i uses fd 200+i (fixed numbers: bash 3.2 has no {fd} allocation).
lock_fd=""
deadline=$(( START_EPOCH + LOCK_WAIT_SECONDS ))
announced=false
while :; do
  for (( slot = 0; slot < SLOTS; slot++ )); do
    fd=$(( 200 + slot ))
    eval "exec ${fd}>\"\${LOCK_DIR}/slot-${slot}.lock\""
    if "$FLOCK_BIN" -n "$fd"; then
      lock_fd="$fd"
      break 2
    fi
    eval "exec ${fd}>&-"
  done
  if [[ "$announced" == false ]]; then
    log "all ${SLOTS} transcription slot(s) busy; waiting up to ${LOCK_WAIT_SECONDS}s"
    announced=true
  fi
  if (( $(date +%s) >= deadline )); then
    die 69 "gave up waiting ${LOCK_WAIT_SECONDS}s for a transcription slot (OLYMPUS_TRANSCRIBE_SLOTS=${SLOTS})"
  fi
  sleep 5
done

# --- work dir + signal handling ----------------------------------------------------
work_dir="$(mktemp -d "${TMP_ROOT}/olympus-whisper.XXXXXX")"
child_pid=""

# Stops the running child (ffmpeg, curl or whisper) and its descendants:
# descendants first via pkill -P (whisper's python may fork), then the child,
# then a bounded grace period, then SIGKILL. The child always gets SIGTERM,
# whatever we received: bash starts background children with SIGINT ignored,
# so forwarding INT would only ever reach the KILL. No `set -m`: the children
# must stay in this shell's process group so the runner's group kill still
# reaches them when this shell itself is SIGKILLed.
stop_child() {
  local tenths
  [[ -n "$child_pid" ]] || return 0
  kill -0 "$child_pid" 2>/dev/null || return 0
  if command -v "$PKILL_BIN" >/dev/null 2>&1; then
    "$PKILL_BIN" -TERM -P "$child_pid" 2>/dev/null || true
  fi
  kill -TERM "$child_pid" 2>/dev/null || true
  for (( tenths = 0; tenths < STOP_GRACE_SECONDS * 10; tenths++ )); do
    kill -0 "$child_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$child_pid" 2>/dev/null; then
    log "child ${child_pid} ignored SIGTERM for ${STOP_GRACE_SECONDS}s; killing"
    if command -v "$PKILL_BIN" >/dev/null 2>&1; then
      "$PKILL_BIN" -KILL -P "$child_pid" 2>/dev/null || true
    fi
    kill -KILL "$child_pid" 2>/dev/null || true
  fi
  wait "$child_pid" 2>/dev/null || true
  child_pid=""
}
cleanup() {
  local code=$?
  trap - EXIT
  stop_child
  rm -rf -- "$work_dir"
  exit "$code"
}
forward_signal() {
  local sig="$1" code="$2"
  trap - TERM INT
  log "received SIG${sig}; stopping"
  stop_child
  exit "$code"
}
trap cleanup EXIT
trap 'forward_signal TERM 143' TERM
trap 'forward_signal INT 130' INT

# Runs a command in the background under nice, tracks it for the signal
# handlers, and returns its exit status. Exec is not an option because the
# transcript has to be read out of the work dir after whisper exits.
run_child() {
  nice -n "$NICE_LEVEL" "$@" &
  child_pid=$!
  local status=0
  wait "$child_pid" || status=$?
  child_pid=""
  return "$status"
}

export OMP_NUM_THREADS="$THREADS" MKL_NUM_THREADS="$THREADS" OPENBLAS_NUM_THREADS="$THREADS"

# --- downmix -----------------------------------------------------------------------
audio="${work_dir}/input.wav"
if ! run_child "$FFMPEG_BIN" -nostdin -hide_banner -loglevel error -y -threads "$THREADS" \
    -i "$input" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$audio"; then
  die 65 "ffmpeg could not downmix ${input}"
fi
[[ -s "$audio" ]] || die 65 "ffmpeg produced no audio for ${input}"

# --- remote lane first ---------------------------------------------------------------
# OpenAI-compatible /v1/audio/transcriptions (multipart: file, model,
# response_format=text). Accepted only when curl exits 0 AND the status is
# 2xx AND the body has non-blank content. A permanent 4xx is a configuration
# failure (exit 76, no fallback: retrying or transcribing on the CPU would
# hide a wrong URL or model). 5xx, connection failures and timeouts fall back
# to local CPU whisper when the file fits that lane.
if [[ -n "$REMOTE_URL" ]]; then
  remote_body="${work_dir}/remote.txt"
  remote_code_file="${work_dir}/remote.code"
  remote_err="${work_dir}/remote.err"
  remaining="$(seconds_remaining)"
  (( remaining > 0 )) || die 69 "deadline of ${DEADLINE_SECONDS}s spent before the remote lane could start"
  curl_max_time="$REMOTE_TIMEOUT_SECONDS"
  (( curl_max_time > remaining )) && curl_max_time="$remaining"
  curl_status=0
  run_child "$CURL_BIN" --silent --show-error \
      --connect-timeout "$REMOTE_CONNECT_TIMEOUT_SECONDS" --max-time "$curl_max_time" \
      --output "$remote_body" --write-out '%{http_code}' \
      --form "file=@${audio}" --form "model=${REMOTE_MODEL}" --form "response_format=text" \
      "$REMOTE_URL" >"$remote_code_file" 2>>"$remote_err" || curl_status=$?
  http_code="$(tr -d '[:space:]' <"$remote_code_file" 2>/dev/null || true)"
  if (( curl_status == 0 )) && [[ "$http_code" =~ ^2[0-9][0-9]$ ]] \
      && [[ -s "$remote_body" ]] && grep -q '[^[:space:]]' "$remote_body"; then
    cat "$remote_body"
    exit 0
  fi
  err_excerpt="$(head -c 200 "$remote_err" 2>/dev/null | tr '\n' ' ')"
  if (( curl_status == 0 )) && [[ "$http_code" =~ ^40[0134]$ ]]; then
    die 76 "remote lane ${REMOTE_URL} rejected model=${REMOTE_MODEL} with http ${http_code} (permanent; check OLYMPUS_TRANSCRIBE_URL / OLYMPUS_TRANSCRIBE_REMOTE_MODEL): ${err_excerpt}"
  fi
  log "remote lane ${REMOTE_URL} failed (curl exit ${curl_status}, http ${http_code:-none}: ${err_excerpt}); falling back to local whisper"
  if [[ "$local_fallback_allowed" == false ]]; then
    die 65 "refusing ${input} for local CPU whisper: ${local_refusal} (remote lane failed)"
  fi
fi

# --- local CPU whisper ---------------------------------------------------------------
[[ -x "$WHISPER_BIN" ]] || command -v "$WHISPER_BIN" >/dev/null 2>&1 || die 69 "whisper not found at ${WHISPER_BIN}"
remaining="$(seconds_remaining)"
if (( remaining < duration_seconds )); then
  die 69 "refusing ${input} for local CPU whisper: ${remaining}s left of OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS=${DEADLINE_SECONDS} is less than the ${duration_seconds}s of audio it needs"
fi
out_dir="${work_dir}/out"
mkdir -p -- "$out_dir"
if ! run_child "$WHISPER_BIN" "$audio" --model "$WHISPER_MODEL" --output_format txt \
    --output_dir "$out_dir" --fp16 False --verbose False >"${work_dir}/whisper.log" 2>&1; then
  die 70 "whisper failed on ${input}: $(tail -n 3 "${work_dir}/whisper.log" 2>/dev/null | tr '\n' ' ')"
fi
stem="$(basename -- "$audio")"
transcript="${out_dir}/${stem%.*}.txt"
[[ -f "$transcript" ]] || die 70 "whisper produced no transcript for ${input}"
cat "$transcript"
