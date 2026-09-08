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

## The wrapper

Template: [`config/systemd/user/olympus-whisper-transcribe.sh`](../../config/systemd/user/olympus-whisper-transcribe.sh).
The host installer copies it to `~/bin/olympus-whisper-transcribe`, the path
`OLYMPUS_TRANSCRIBE_COMMAND` already names. A runtime refresh overwrites
hand edits on the host, so changes land here.

Behavior, in order:

1. Optional start-of-run sweep of stale temp dirs (see below).
2. `ffprobe` duration check; over the cap it exits 65 with a clear stderr
   line **before** taking a slot.
3. Semaphore: `OLYMPUS_TRANSCRIBE_SLOTS` lock files under the lock dir,
   polled every 5 s up to `OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS`, then exit
   69. The lock fd is inherited by ffmpeg/curl/whisper, so the slot is held
   for exactly the life of the job.
4. `nice -n 15`, `OMP_NUM_THREADS`/`MKL_NUM_THREADS`/`OPENBLAS_NUM_THREADS`
   capped, ffmpeg downmix into a private `olympus-whisper.XXXXXX` work dir.
5. Remote lane first when `OLYMPUS_TRANSCRIBE_URL` is set: one bounded
   `curl` POST (OpenAI-compatible multipart `file`, `model`,
   `response_format=text`). Any transport failure, non-2xx, or blank body
   logs and falls through.
6. Local CPU whisper (`OLYMPUS_WHISPER_MODEL`), transcript on stdout.

Whisper runs as a child, not via `exec`, because the transcript has to be
read out of the work dir after it exits. TERM/INT are forwarded to the child
and the EXIT trap removes the work dir; a SIGKILL from the runner's group
kill reaches the child directly. The one thing a SIGKILL cannot do is run the
trap, which is what the sweeper is for.

Exit codes: 0 transcript on stdout; 64 bad knob or usage; 65 refused (over
the cap, or ffmpeg could not read it); 66 input unreadable; 69 no slot in
time / missing tool; 70 whisper failed; 143 stopped by signal. Every
non-zero exit is `failed_retryable` to the extractor today, so an over-cap
file is re-checked (cheaply, an ffprobe) on each pass rather than parked;
a terminal `errorKind` for the cap is a follow-up if that noise matters.

### Knobs

Set in `~/.config/olympus/worker.env` (the drop-in every Olympus user unit
loads) or the calling unit's environment.

| Variable | Default | Meaning |
|---|---|---|
| `OLYMPUS_TRANSCRIBE_SLOTS` | `1` | Concurrent transcription jobs across all callers. |
| `OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS` | `7200` | Bounded wait for a slot; then exit 69. |
| `OLYMPUS_TRANSCRIBE_LOCK_DIR` | `$XDG_RUNTIME_DIR/olympus-transcribe-locks` (or `/tmp/...`) | Slot lock files. Must be one local filesystem shared by every caller. |
| `OLYMPUS_TRANSCRIBE_NICE` | `15` | Nice level for ffmpeg and whisper. |
| `OLYMPUS_TRANSCRIBE_THREADS` | `4` | Thread cap (BLAS/OpenMP env + ffmpeg `-threads`). |
| `OLYMPUS_TRANSCRIBE_MAX_MINUTES` | `180` | Refuse longer inputs. Keep it consistent with `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS` (extractor default 1800 s): CPU `base` runs near real time with 4 threads, so a 180-minute file cannot finish inside a 30-minute timeout. Pick one or the other for the host. |
| `OLYMPUS_TRANSCRIBE_URL` | unset | Remote lane, e.g. Delphi through the existing tunnel: `http://127.0.0.1:28090/v1/audio/transcriptions`. |
| `OLYMPUS_TRANSCRIBE_REMOTE_MODEL` | `whisper-1` | `model` field for the remote lane. |
| `OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS` | `1800` | `curl --max-time` for the remote call. |
| `OLYMPUS_TRANSCRIBE_REMOTE_CONNECT_TIMEOUT_SECONDS` | `10` | `curl --connect-timeout`. |
| `OLYMPUS_WHISPER_MODEL` | `base` | Local whisper model. |
| `OLYMPUS_WHISPER_BIN` | `~/.local/bin/whisper` | Local whisper binary. |
| `OLYMPUS_TRANSCRIBE_TMP_ROOT` | `/tmp` | Where work dirs live and what the sweeper scans. |
| `OLYMPUS_TRANSCRIBE_SWEEP_ON_START` | `true` | Run the sweep at the start of every job. |
| `OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES` | `1440` | Age before a temp dir is stale. |
| `OLYMPUS_TRANSCRIBE_{FFMPEG,FFPROBE,CURL,FLOCK}_BIN` | on `PATH` | Tool overrides (tests use them). |

Runner-side, unchanged: `OLYMPUS_TRANSCRIBE_COMMAND` (argv template with
`{input}`) and `OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS`.

## The sweeper

`olympus-whisper-transcribe --sweep` removes `olympus-transcribe-*` (the
extractor's byte spill) and `olympus-whisper.*` (the wrapper's work dir)
under the temp root that are older than the age cap **and** that no live
process names on its command line (`pgrep -f`). It runs at the start of
every job by default, and as a user timer every 6 h:

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
   (at minimum decide the cap/timeout pair above; add
   `OLYMPUS_TRANSCRIBE_URL` when the Delphi lane is up).
5. Restart the callers so they pick up the new runner code:
   `systemctl --user restart olympus-email-source olympus-whatsapp-transcribe-drain`,
   and confirm the email worker's "listening" journal line.
6. Kill any surviving pre-fix whisper processes by hand once
   (`pkill -f '\.local/bin/whisper'`) and run
   `~/bin/olympus-whisper-transcribe --sweep` to clear the 1.1 GB orphan.

Requirements on the host: `flock` (util-linux), `ffmpeg`/`ffprobe`, `curl`,
`pgrep` (procps). All present on sparta.
