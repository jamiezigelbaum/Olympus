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
# over a duration cap, prefers a remote transcription lane when one is
# configured, forwards signals to whisper, and cleans up after itself.
#
# This file is a TEMPLATE owned by the repository. The host installer copies
# it to ~/bin/olympus-whisper-transcribe; a refresh overwrites hand edits, so
# fix it here.

log() { printf 'olympus-whisper-transcribe: %s\n' "$*" >&2; }
die() { local code="$1"; shift; log "$@"; exit "$code"; }

# --- knobs --------------------------------------------------------------------
SLOTS="${OLYMPUS_TRANSCRIBE_SLOTS:-1}"
LOCK_WAIT_SECONDS="${OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS:-7200}"
LOCK_DIR="${OLYMPUS_TRANSCRIBE_LOCK_DIR:-${XDG_RUNTIME_DIR:-/tmp}/olympus-transcribe-locks}"
NICE_LEVEL="${OLYMPUS_TRANSCRIBE_NICE:-15}"
THREADS="${OLYMPUS_TRANSCRIBE_THREADS:-4}"
MAX_MINUTES="${OLYMPUS_TRANSCRIBE_MAX_MINUTES:-180}"
# CPU fallback is near real time on `base` with 4 threads; keep it inside the
# extractor's 1800 s timeout so a long file is refused up front, never orphaned.
LOCAL_MAX_MINUTES="${OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES:-25}"
TMP_ROOT="${OLYMPUS_TRANSCRIBE_TMP_ROOT:-/tmp}"
SWEEP_AGE_MINUTES="${OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES:-1440}"
SWEEP_ON_START="${OLYMPUS_TRANSCRIBE_SWEEP_ON_START:-true}"

REMOTE_URL="${OLYMPUS_TRANSCRIBE_URL:-}"
REMOTE_MODEL="${OLYMPUS_TRANSCRIBE_REMOTE_MODEL:-whisper-1}"
REMOTE_TIMEOUT_SECONDS="${OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS:-1800}"
REMOTE_CONNECT_TIMEOUT_SECONDS="${OLYMPUS_TRANSCRIBE_REMOTE_CONNECT_TIMEOUT_SECONDS:-10}"

WHISPER_MODEL="${OLYMPUS_WHISPER_MODEL:-base}"
WHISPER_BIN="${OLYMPUS_WHISPER_BIN:-${HOME}/.local/bin/whisper}"
FFMPEG_BIN="${OLYMPUS_TRANSCRIBE_FFMPEG_BIN:-ffmpeg}"
FFPROBE_BIN="${OLYMPUS_TRANSCRIBE_FFPROBE_BIN:-ffprobe}"
CURL_BIN="${OLYMPUS_TRANSCRIBE_CURL_BIN:-curl}"
FLOCK_BIN="${OLYMPUS_TRANSCRIBE_FLOCK_BIN:-flock}"

is_positive_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
is_nonneg_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

is_positive_int "$SLOTS" || die 64 "OLYMPUS_TRANSCRIBE_SLOTS must be a positive integer (got '$SLOTS')."
is_nonneg_int "$LOCK_WAIT_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS must be a non-negative integer."
is_positive_int "$THREADS" || die 64 "OLYMPUS_TRANSCRIBE_THREADS must be a positive integer."
is_positive_int "$MAX_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_MAX_MINUTES must be a positive integer."
is_positive_int "$LOCAL_MAX_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES must be a positive integer."
is_positive_int "$SWEEP_AGE_MINUTES" || die 64 "OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES must be a positive integer."
is_positive_int "$REMOTE_TIMEOUT_SECONDS" || die 64 "OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS must be a positive integer."
[[ "$NICE_LEVEL" =~ ^-?[0-9]+$ ]] || die 64 "OLYMPUS_TRANSCRIBE_NICE must be an integer."

# --- orphan sweeper -------------------------------------------------------------
# Removes temp dirs older than the age cap that no live process references.
# Both prefixes are swept: the extractor's byte spill (olympus-transcribe-*)
# and this wrapper's own work dir (olympus-whisper.*).
sweep_stale_temp_dirs() {
  local dir removed=0 kept=0
  while IFS= read -r -d '' dir; do
    if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "$dir" >/dev/null 2>&1; then
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

# --- duration cap (before the semaphore: a refusal must never hold a slot) --------
duration_seconds=""
if command -v "$FFPROBE_BIN" >/dev/null 2>&1; then
  duration_seconds="$("$FFPROBE_BIN" -v error -show_entries format=duration -of csv=p=0 -- "$input" 2>/dev/null || true)"
  duration_seconds="${duration_seconds%%.*}"
fi
if is_nonneg_int "$duration_seconds"; then
  duration_minutes=$(( (duration_seconds + 59) / 60 ))
  if (( duration_minutes > MAX_MINUTES )); then
    die 65 "refusing ${input}: duration ${duration_minutes} min exceeds OLYMPUS_TRANSCRIBE_MAX_MINUTES=${MAX_MINUTES}"
  fi
else
  log "warning: could not read duration of ${input}; proceeding without the cap"
fi

# --- semaphore ---------------------------------------------------------------------
# N slot files under LOCK_DIR; a caller holds exactly one for the whole job.
# The lock fd is inherited by every child, so whisper itself keeps the slot
# until it exits, whatever happens to this shell.
command -v "$FLOCK_BIN" >/dev/null 2>&1 || die 69 "flock is required (util-linux) but was not found."
mkdir -p -- "$LOCK_DIR"
# Slot i uses fd 200+i (fixed numbers: bash 3.2 has no {fd} allocation).
lock_fd=""
deadline=$(( $(date +%s) + LOCK_WAIT_SECONDS ))
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
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work_dir"
  exit "$code"
}
forward_signal() {
  local sig="$1"
  log "received SIG${sig}; stopping"
  if [[ -n "$child_pid" ]]; then
    kill -"$sig" "$child_pid" 2>/dev/null || true
  fi
  exit 143
}
trap cleanup EXIT
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# Runs a command in the background under nice, forwards signals to it, and
# returns its exit status. Exec is not an option because the transcript has
# to be read out of the work dir after whisper exits.
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
if command -v "$FFMPEG_BIN" >/dev/null 2>&1; then
  if ! run_child "$FFMPEG_BIN" -nostdin -hide_banner -loglevel error -y -threads "$THREADS" \
      -i "$input" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$audio"; then
    die 65 "ffmpeg could not downmix ${input}"
  fi
else
  log "warning: ffmpeg not found; passing the original file to the transcriber"
  audio="$input"
fi

# --- remote lane first ---------------------------------------------------------------
# OpenAI-compatible /v1/audio/transcriptions (multipart: file, model,
# response_format=text). Any transport failure, non-2xx, or empty body falls
# back to local CPU whisper; the caller never sees a half-answer.
if [[ -n "$REMOTE_URL" ]]; then
  remote_body="${work_dir}/remote.txt"
  http_code="$("$CURL_BIN" --silent --show-error \
      --connect-timeout "$REMOTE_CONNECT_TIMEOUT_SECONDS" --max-time "$REMOTE_TIMEOUT_SECONDS" \
      --output "$remote_body" --write-out '%{http_code}' \
      --form "file=@${audio}" --form "model=${REMOTE_MODEL}" --form "response_format=text" \
      "$REMOTE_URL" 2>>"${work_dir}/remote.err" || true)"
  if [[ "$http_code" =~ ^2[0-9][0-9]$ ]] && [[ -s "$remote_body" ]] && grep -q '[^[:space:]]' "$remote_body"; then
    cat "$remote_body"
    exit 0
  fi
  log "remote lane ${REMOTE_URL} failed (http ${http_code:-none}: $(head -c 200 "${work_dir}/remote.err" 2>/dev/null | tr '\n' ' ')); falling back to local whisper"
fi

# --- local CPU whisper ---------------------------------------------------------------
if is_nonneg_int "${duration_seconds:-}" && (( (duration_seconds + 59) / 60 > LOCAL_MAX_MINUTES )); then
  die 65 "refusing ${input} for local CPU whisper: $(( (duration_seconds + 59) / 60 )) min exceeds OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES=${LOCAL_MAX_MINUTES} (remote lane unavailable)"
fi
[[ -x "$WHISPER_BIN" ]] || command -v "$WHISPER_BIN" >/dev/null 2>&1 || die 69 "whisper not found at ${WHISPER_BIN}"
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
