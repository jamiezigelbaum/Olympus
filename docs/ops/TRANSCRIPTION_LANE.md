# Transcription lane: gating, cleanup, and the host wrapper

Status: canonical for how local transcription runs on a host. Written after
the 2026-09-08 sparta incident.

## What happened

Sparta (16 cores, no GPU) sat at load 60 with seven `whisper` python
processes between 2.5 and 7 hours old. All were spawned through the file
extraction transcription extractor's `OLYMPUS_TRANSCRIBE_COMMAND`
(`~/bin/olympus-whisper-transcribe {input}`), which the WhatsApp transcribe
drain shares. Three causes, each with its own fix:

| Cause | Disposition |
|---|---|
| `runExtractionCommand` SIGKILLed only the bash wrapper on timeout; the `whisper` grandchild was orphaned and kept its cores. SIGKILL also skipped the wrapper's `trap`, stranding `/tmp/olympus-whisper.*` dirs (one 1.1 GB). | **fix** — the runner spawns detached (own process group) and kills the whole group. `test/file-extraction-command-runner.test.ts` pins it with a real grandchild. |
| No concurrency cap across callers (extraction scheduler, WhatsApp drain, manual `castor-sendfile` runs) sharing one CPU whisper. | **gate** — the wrapper takes one of N `flock` slots before any CPU work; every caller goes through the same wrapper. |
| Inputs were not pre-downmixed; one job was a 126-minute 1.09 GB mp4 on `--model base`. | **fix + gate** — ffmpeg downmix to 16 kHz mono first; inputs over a duration cap are refused. |

## The egress boundary

The wrapper's "remote lane" is the owner's own Delphi appliance, reached from
the worker host through the existing loopback SSH tunnel
(`http://127.0.0.1:28090/v1/audio/transcriptions`, model
`delphi/transcription`, single slot). That is the same trust class as the
local VLM extractor, which already sends secure-local S4 work to
`127.0.0.1:28090` under the declared `local` egress. It is **not** cloud ASR,
and nothing here can make it cloud ASR:

- `OLYMPUS_TRANSCRIBE_URL`, when set, must have host `127.0.0.1` or
  `localhost` (http or https, optional port, no userinfo, no IPv6 literal).
  The wrapper checks this before the sweep, before ffprobe, before anything,
  and exits 78 on any other host with no fallback.
- `resolveTranscribeRemoteLane()` in
  `src/workers/file-extraction/extractors/transcription.ts` applies the same
  allowlist in TypeScript. `createWhisperCommandTranscriberFromEnv()` calls
  it, so neither the extraction scheduler nor the WhatsApp drain can even
  construct a transcriber against a non-loopback URL.
- The WhatsApp drain's receipt keeps `local_only: true` and
  `cloud_asr_allowed: false` and adds `remote_lane: 'none' | 'loopback_only'`.
  There is no third value; a non-loopback URL aborts startup instead.

There is deliberately no typed-egress framework for this: the loopback
constraint is the boundary. `test/transcribe-wrapper-template.test.ts`,
`test/file-extraction-transcription-extractor.test.ts` and
`test/whatsapp-transcribe-drain.test.ts` each pin it with a list of refused
hosts (a public API, a tailnet name, `127.0.0.1.evil.example`, userinfo,
`[::1]`, `ftp:`).

## The wrapper

Template: [`config/systemd/user/olympus-whisper-transcribe.sh`](../../config/systemd/user/olympus-whisper-transcribe.sh).
The host installer copies it to `~/bin/olympus-whisper-transcribe`, the path
`OLYMPUS_TRANSCRIBE_COMMAND` already names. A runtime refresh overwrites
hand edits on the host, so changes land here.

Behavior, in order:

1. Knob validation, the budget arithmetic check, and the loopback check on
   `OLYMPUS_TRANSCRIBE_URL` (exit 64 / 64 / 78).
2. Optional start-of-run sweep of stale temp dirs (see below).
3. Required tools: `ffprobe`, `ffmpeg`, `flock`, and `curl` when the remote
   lane is set. Any missing → exit 69. There is no "proceed without the
   cap" and no "pass the original media through".
4. `ffprobe` duration. Unreadable → exit 66. Over
   `OLYMPUS_TRANSCRIBE_MAX_MINUTES` → exit 65. With **no** remote lane, over
   `OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES` → exit 65, and audio longer than
   the remaining deadline → exit 69. All of this happens **before** the
   semaphore: a refused file never holds a slot.
5. Semaphore: `OLYMPUS_TRANSCRIBE_SLOTS` lock files under the lock dir,
   polled every 5 s up to `OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS`, then exit
   69. The lock fd is inherited by ffmpeg/curl/whisper, so the slot is held
   for exactly the life of the job.
6. `nice -n 15`, `OMP_NUM_THREADS`/`MKL_NUM_THREADS`/`OPENBLAS_NUM_THREADS`
   capped, ffmpeg downmix into a private `olympus-whisper.XXXXXX` work dir.
   ffmpeg failure or empty output → exit 65.
7. Remote lane first when `OLYMPUS_TRANSCRIBE_URL` is set: one `curl` POST
   (OpenAI-compatible multipart `file`, `model`, `response_format=text`),
   `--max-time` = the remote budget clipped to whatever deadline is left.
   The response is accepted only when curl exits 0 **and** the status is
   2xx **and** the body is non-blank; a partial body from a curl that died
   mid-transfer is never emitted. HTTP 400/401/403/404 is a configuration
   failure: exit 76 naming the URL and model, no local fallback (a fallback
   would hide a wrong URL or model indefinitely). 5xx, connection failures
   and timeouts log and fall through — unless the file is over the local
   cap, in which case exit 65 with a message saying the remote lane failed.
8. Local CPU whisper (`OLYMPUS_WHISPER_MODEL`), only if the remaining
   deadline is at least the audio's duration (CPU `base` runs near real
   time); otherwise exit 69. Transcript on stdout.

Every child (ffmpeg, curl, whisper) runs through the same `run_child`
tracking. On TERM or INT the wrapper sends TERM to the child's descendants
(`pkill -P`) and then the child, waits up to
`OLYMPUS_TRANSCRIBE_STOP_GRACE_SECONDS` (10), then SIGKILLs, removes the work
dir, and exits 143 (TERM) or 130 (INT). The child always gets TERM because
bash starts background children with SIGINT ignored. There is no `set -m`:
the children stay in the wrapper's process group so the runner's group kill
still reaches them when the wrapper itself is SIGKILLed — the one case that
skips the trap, which is what the sweeper is for.

### Exit codes and what the callers do with them

| Exit | Meaning | Extractor `errorKind` | Disposition |
|---|---|---|---|
| 0 | transcript on stdout | — | indexed |
| 64 | usage / malformed knob / budgets that cannot fit the deadline | `transcribe_command_usage` | **terminal** |
| 65 | refused: over a cap, ffmpeg could not downmix, or remote failed on a file over the local cap | `transcribe_input_refused` | **terminal** |
| 66 | input unreadable (missing file, ffprobe cannot read duration) | `transcribe_input_unreadable` | **terminal** |
| 69 | no slot in time, required tool missing, deadline spent | `transcribe_command_failed` | retryable |
| 70 | local whisper failed | `transcribe_command_failed` | retryable |
| 76 | remote lane rejected the request (HTTP 400/401/403/404) | `transcribe_remote_lane_rejected` | **terminal** |
| 78 | `OLYMPUS_TRANSCRIBE_URL` is not loopback | `transcribe_remote_lane_misconfigured` | **terminal** |
| 130 / 143 | stopped by INT / TERM | `transcribe_command_failed` | retryable |
| (runner timeout) | outer `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS` fired | `transcribe_command_timeout`, or `transcribe_command_timeout_kill_failed` when the group kill hit EPERM | retryable |

`TRANSCRIBE_TERMINAL_EXIT_KINDS` in `transcription.ts` is the source of the
terminal set. The extractor reports those as `failed_terminal`; the WhatsApp
drain writes `status: failed_terminal` with `next_retry_at: null`, counts it
under `failed_terminal`, and skips the file on every later pass
(`skipped_terminal`) until the status file is removed by hand. 5xx-then-
failed, no-slot, whisper crashes and timeouts keep their backoff and retry.

### Time budgets

The runner kills the whole process group at `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS`
(default `DEFAULT_TRANSCRIBE_TIMEOUT_MS` = 1800 s in `transcription.ts`).
The wrapper reads the same number as `OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS`
(default 1800) and derives its sub-budgets from it:

- slot wait = deadline / 3 (600 s)
- remote `--max-time` = deadline / 2 (900 s), clipped at run time to
  whatever is actually left
- the rest (300 s minus ffprobe and ffmpeg) is what a local fallback can
  use after a full slot wait and a full remote timeout

Explicit `OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS` and
`OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS` are allowed but must sum to
less than the deadline (else exit 64). Because the local CPU lane needs
roughly the audio's duration in wall time, the wrapper checks
`remaining ≥ duration` right before starting whisper and exits 69 instead
of starting a job the runner would have to kill. Worked example with
defaults: a 25-minute file (1500 s) transcribes locally only when the slot
was free almost immediately and there was no remote attempt; a 25-minute
file that waited 600 s for a slot and then saw the remote lane time out is
refused with 69 and retried, rather than orphaned. If you change
`OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS` on a host, set
`OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS` to the same value.

### Knobs

Set in `~/.config/olympus/worker.env` (the drop-in every Olympus user unit
loads) or the calling unit's environment.

| Variable | Default | Meaning |
|---|---|---|
| `OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS` | `1800` | The wrapper's whole budget; keep equal to the runner's `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS`. |
| `OLYMPUS_TRANSCRIBE_SLOTS` | `1` | Concurrent transcription jobs across all callers. |
| `OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS` | deadline / 3 | Bounded wait for a slot; then exit 69. |
| `OLYMPUS_TRANSCRIBE_LOCK_DIR` | `$XDG_RUNTIME_DIR/olympus-transcribe-locks` (or `/tmp/...`) | Slot lock files. Must be one local filesystem shared by every caller. |
| `OLYMPUS_TRANSCRIBE_NICE` | `15` | Nice level for ffmpeg, curl and whisper. |
| `OLYMPUS_TRANSCRIBE_THREADS` | `4` | Thread cap (BLAS/OpenMP env + ffmpeg `-threads`). |
| `OLYMPUS_TRANSCRIBE_MAX_MINUTES` | `180` | Refuse longer inputs outright (applies to the remote lane). |
| `OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES` | `25` | Cap for the local CPU lane. With no remote lane it is applied before the slot; with one, a longer file still gets the remote attempt but no local fallback. Owner decision 2026-09-08. |
| `OLYMPUS_TRANSCRIBE_URL` | unset | Remote lane. **Loopback only**: `http://127.0.0.1:28090/v1/audio/transcriptions` (Delphi through the tunnel). Any other host → exit 78. |
| `OLYMPUS_TRANSCRIBE_REMOTE_MODEL` | `delphi/transcription` | `model` field for the remote lane. |
| `OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS` | deadline / 2 | `curl --max-time` ceiling for the remote call. |
| `OLYMPUS_TRANSCRIBE_REMOTE_CONNECT_TIMEOUT_SECONDS` | `10` | `curl --connect-timeout`. |
| `OLYMPUS_TRANSCRIBE_STOP_GRACE_SECONDS` | `10` | TERM-to-KILL grace when the wrapper is signalled. |
| `OLYMPUS_WHISPER_MODEL` | `base` | Local whisper model. |
| `OLYMPUS_WHISPER_BIN` | `~/.local/bin/whisper` | Local whisper binary. |
| `OLYMPUS_TRANSCRIBE_TMP_ROOT` | `/tmp` | Where work dirs live and what the sweeper scans. |
| `OLYMPUS_TRANSCRIBE_SWEEP_ON_START` | `true` | Run the sweep at the start of every job. |
| `OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES` | `1440` | Age before a temp dir is stale. |
| `OLYMPUS_TRANSCRIBE_{FFMPEG,FFPROBE,CURL,FLOCK,PGREP,PKILL,LSOF}_BIN` | on `PATH` | Tool overrides (tests use them). |

Runner-side, unchanged: `OLYMPUS_TRANSCRIBE_COMMAND` (argv template with
`{input}`) and `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS`.

## The runner's kill

`runExtractionCommand` spawns detached and, on timeout, signals the process
group. `killExtractionProcessGroup` treats ESRCH as benign (already gone)
and still sends the direct child a courtesy signal. Any other failure
(EPERM in practice) also tries the direct kill, and if that fails too the
outcome is reported on the timeout error as `terminationFailed: '<code>'`
with a message saying the command may still be running; the extractor
surfaces it as `transcribe_command_timeout_kill_failed` so the operator can
see it in the job table rather than discover it as load. Both paths are
pinned in `test/file-extraction-command-runner.test.ts` with a stubbed
`kill`.

## The sweeper

`olympus-whisper-transcribe --sweep` removes `olympus-transcribe-*` (the
extractor's byte spill) and `olympus-whisper.*` (the wrapper's work dir)
under the temp root that are older than the age cap **and** that no live
process references. It fails closed:

- without `pgrep` it removes nothing and says so;
- a dir is kept when any process names it on its command line
  (`pgrep -f`), has its cwd inside it, or holds a file under it open —
  on Linux via `/proc/*/cwd` and `/proc/*/fd`, elsewhere via `lsof +D`
  when available.

It runs at the start of every job by default, and as a user timer every
6 h:

- [`config/systemd/user/olympus-transcribe-sweep.service`](../../config/systemd/user/olympus-transcribe-sweep.service)
- [`config/systemd/user/olympus-transcribe-sweep.timer`](../../config/systemd/user/olympus-transcribe-sweep.timer)

## Deploying to sparta

Host-side steps, per the standing deploy path (pull the worker checkout,
install templates, restart). The wrapper and units are new templates in
this repository; the private host installer (`olympus-ops`) needs a step
that copies them, mirroring `install-sparta-email-cloud-freshness-units.sh`:

1. Pull the worker checkout to the merged `main` SHA and confirm it:
   `cd ~/.openclaw/plugin-src/Olympus && git checkout -- dist/cli.js && git pull --ff-only && git log --oneline -1`.
2. Install the wrapper: `install -m 0755 config/systemd/user/olympus-whisper-transcribe.sh ~/bin/olympus-whisper-transcribe`
   (same path `OLYMPUS_TRANSCRIBE_COMMAND` already uses; no unit edits).
3. Install the sweeper: copy both `olympus-transcribe-sweep.*` files to
   `~/.config/systemd/user/`, then
   `systemctl --user daemon-reload && systemctl --user enable --now olympus-transcribe-sweep.timer`.
4. Set knobs in `~/.config/olympus/worker.env` as decided for the host
   (at minimum decide the deadline/cap pair above; set
   `OLYMPUS_TRANSCRIBE_URL=http://127.0.0.1:28090/v1/audio/transcriptions`
   for the Delphi lane — loopback only, anything else exits 78).
5. Restart the callers so they pick up the new runner code:
   `systemctl --user restart olympus-email-source olympus-whatsapp-transcribe-drain`,
   and confirm the email worker's "listening" journal line.
6. Kill any surviving pre-fix whisper processes by hand once
   (`pkill -f '\.local/bin/whisper'`) and run
   `~/bin/olympus-whisper-transcribe --sweep` to clear the 1.1 GB orphan.

Requirements on the host: `flock` (util-linux), `ffmpeg`/`ffprobe`, `curl`,
`pgrep`/`pkill` (procps). All present on sparta. Missing `ffmpeg`/`ffprobe`
now refuses every job (exit 69) rather than degrading; missing `pgrep`
disables the sweep's deletions.
