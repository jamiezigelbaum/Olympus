# Built-in transcription

Status: in 1.0 (owner decision 2026-10-07). Release entry:
[`V0_4_RELEASE.md`](../V0_4_RELEASE.md#built-in-transcription-in-10-owner-2026-10-07).

## Outcome

On a fresh Mac with nothing configured, audio files (M4A/AAC, MP3, WAV,
FLAC, Ogg Opus voice notes, and the sound track of MP4/MOV) are transcribed
on the machine. Audio never leaves the machine: there is no cloud ASR on this
lane, and the model server listens on loopback only.

## Approach

- **Model.** Qwen3-ASR 0.6B (`Qwen/Qwen3-ASR-0.6B`, Apache-2.0), as the
  `ggml-org/Qwen3-ASR-0.6B-GGUF` conversion at commit `928ab95`:
  `Qwen3-ASR-0.6B-Q8_0.gguf` (804,749,248 bytes) and
  `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf` (214,392,480 bytes), each pinned by size
  and SHA-256 in `src/workers/source-index/built-in-reasoning/manifest.ts`.
- **Runtime.** The llama.cpp b11320 `llama-server` that built-in reasoning
  already pins. One shared install (in the reasoning model's directory, under
  its own `runtime.lock`); the transcription model's files and status file
  live in `models/built-in-transcription/`.
- **Installer.** `installPinnedModel` (install.ts) is the one installer for
  both models: multi-file bundles, resumable downloads, checksum before use,
  disk-space headroom and backoff, cross-process lock, status file. The
  reasoning model's behaviour is unchanged.
- **Server.** A second `llama-server` process (`--mmproj`, batch 512, context
  4,096), started on demand through the same handle as the reasoning server
  (loopback, random port and bearer token, allow-listed environment, low
  priority, capped threads, `--sleep-idle-seconds`). It stops after 3 idle
  minutes and never touches the reasoning server.
- **Engine order** (transcription.ts, mirroring OCR): the owner's
  `OLYMPUS_TRANSCRIBE_COMMAND` first; else the built-in engine where enabled
  (`OLYMPUS_BUILT_IN_TRANSCRIPTION`, default on for `darwin-arm64` only);
  else audio is a named gap (`transcription_required`).

## One file

1. Decode to 16 kHz mono 16-bit WAV: `/usr/bin/afconvert` on macOS (system
   tool, nothing to install); `ffmpeg` from PATH on Linux when the engine is
   turned on there.
2. Cut into chunks of at most 30 s, each cut at the quietest 50 ms frame in
   the 6 s before the limit (no overlap, so transcripts concatenate). Chunks
   whose mean amplitude is near zero are skipped.
3. Each chunk is one `/v1/chat/completions` request with a single
   `input_audio` part (base64 WAV), temperature 0, at most 512 tokens. The
   b11320 server accepts mp3/wav/flac there and has no
   `/v1/audio/transcriptions` route. No `--media-path` is set, and only
   inline data is ever sent.
4. Output `language English<asr_text>…` is split into the transcript and the
   language (recorded on the derivation). Chunk texts are joined in order.

**Prompt.** The request carries audio only, no text prompt. Qwen3-ASR is a
speech recognizer whose chat template treats system text as recognition
context (it biases the words heard), so a "transcribe verbatim" instruction
would be at best a no-op and at worst leak into transcripts. Speech that
contains instructions is transcribed, not obeyed (verified below); the
output is only ever stored as text.

## Bounds

- Per-file time budget: the earlier of 30 min and the job's lease expiry
  less 60 s (a result recorded after the lease is lost would be discarded);
  a file cut short keeps its partial transcript and carries
  `transcript_time_budget_reached`.
- Per-chunk request timeout 3 min; decoder timeout 5 min.
- The lane's existing 200,000-character transcript cap (`boundText`).
- Memory: the engine is used only with at least 7 GiB of RAM. Disk: the
  shared 2 GiB headroom check before download.

## When it downloads

Owner decision 2026-10-07: only when the owner's chosen sources contain
audio. The extraction queue is the catalogue of what approved lanes chose to
read, and each item is routed there by the transcription lane's own test
(`transcriptionLaneAccepts`, MIME type or file extension) at plan time. So:

- When the scheduler starts, each approved extraction lane's task
  (`fileExtractionSchedulerTask` `atStart`) calls
  `prepareReadersWithWaitingWork([lane])` (runner.ts): a reader with work
  waiting in that lane (queued, leased, due a retry, or settled unread) is
  asked to get ready. The lookup is always lane-scoped (lane index, first
  hit), so rows left in a folder or source that is no longer approved never
  trigger a download.
- After a sync that catalogued new items, the scheduler already wakes that
  source's extraction within seconds; its plan pass asks the reader to get
  ready as soon as it queues the first job for it.
- With no audio, the transcriber is never asked and nothing downloads.
- When the install finishes, the engine's `onReady` wakes every extraction
  task (`SourceScheduler.wakeTasksOfKind('extract')`, generic, no source
  named), so unread audio is requeued and read within seconds. Exactly which
  tasks wake: every continuous-cadence extract task that is not in a failure
  backoff; one running at that moment runs again within seconds of
  finishing. Manual-cadence lanes run when the owner runs them.

Every gate still applies: an owner command wins, tests never download, the
platform/opt-in switch, the memory floor, the disk headroom, and the failed
install backoff.

## Install state and failure classes

| Situation | Job outcome | Retries spent |
|---|---|---|
| Model downloading, or a failed install waiting to retry (15 min, doubling per consecutive failure, at most 24 h) | `metadata_only` + `transcription_required` + `transcriber_setting_up` ("still being set up") | none |
| Model files on disk, this process still checksumming them (after a restart) | the file waits for the checksum (at most 5 min, within its deadline), then is read | none |
| No pinned runtime for the platform, too little memory, no decoder | `metadata_only` + `transcription_required`; engine remembered unavailable | none |
| Decoder cannot read the file (damaged, unknown codec) | `failed_terminal` / `transcribe_audio_undecodable` | — |
| Server failed to start or answer | `failed_retryable` / `transcriber_failed` (`transcriber_timeout`) | yes |

**Read again once ready.** `Extractor.reread` lets a lane name what it left
unread for want of a reader. Before leasing, the shared runner counts such
jobs (`metadata_only` with a `transcription_required` derivation warning, or
legacy `failed_terminal` / `transcriber_not_configured`); only when there are
some does it ask the engine to get ready (which starts the first download),
and once ready it requeues each of them once ever (the terminal janitor's
one-requeue guard), with a fresh retry budget. A job settled "still being
set up" (`notReadyWarnings`) was never read, so it stays eligible whatever
its requeue count. No source-specific code. Worker shutdown stops the
transcription server along with the reasoning server.

## Formats (verified on macOS 26, `afconvert -hf` and real decodes)

| Input | Decoded by afconvert |
|---|---|
| M4A (AAC) | yes |
| MP3 | yes |
| WAV, AIFF, CAF, FLAC | yes |
| Ogg Opus (WhatsApp-style voice note) | yes |
| CAF Opus | yes |
| MOV / MP4 (AAC track) | yes |

`afconvert` can decode Ogg Opus but could not *encode* it in our test; the
Ogg Opus fixture was made with ffmpeg, which is not used by the product.

## Verified (2026-10-07, Apple-silicon Mac)

- The HF API tree at the pinned commit lists both files with the pinned
  sizes, and its LFS object ids equal the pinned SHA-256 values (compared by
  script, not by hand); the downloaded files hash the same.
- llama.cpp b11320 (`version: 0.5.0-dev (build 11320, commit b8f96c3e8)`)
  loads the model and projector and reports the `multimodal` capability; its
  `docs/multimodal.md` lists Qwen3-ASR.
- End to end through the product code, scratch directories only (never the
  live data directory or the running engine): the first call before install
  settled `transcription_required`; the installer downloaded and verified the
  pinned files (and the shared runtime) in 29 s; then

  | Clip | Time | Transcript |
  |---|---|---|
  | 9 s M4A (first call, includes server start) | 11.4 s | exact |
  | Ogg Opus | 0.69 s | exact |
  | CAF Opus | 0.69 s | exact |
  | MOV (H.264 + AAC) | 0.62 s | exact |
  | AIFF with spoken "ignore all previous instructions…" | 0.58 s | transcribed verbatim, not obeyed |
  | 99 s MP3 (4 chunks) | 7.6 s | exact, numbers sometimes as digits |

- Server memory: about 0.9 GB physical footprint at peak (vmmap), 1.6 GB RSS
  including the memory-mapped model files. `stop()` left no process behind.

## Known gaps

- The dashboard does not yet show the transcription model's install row; the
  status file (`models/built-in-transcription/status.json`) carries the same
  shape as the reasoning model's.
- Linux needs `ffmpeg` on PATH and `OLYMPUS_BUILT_IN_TRANSCRIPTION=on`.
- No speaker labels or timestamps; transcripts are plain text.
