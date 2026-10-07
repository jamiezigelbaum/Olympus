# M0: does a writer call slow a fresh private answer?

Status: round 1 measured 2026-10-05 and round 2 on 2026-10-07, on `claude/consult-m0`
(base `main` at `bc1cd078`). Round 2 starts at "Round 2" below.
Design: `docs/design/frontier-consult-lane.md` §A.3, §A.7, §A.14 (M0), on the
`frontier-consult-proposal` branch.
Script: `scripts/measure-consult-writer-interference.ts` (measurement only; nothing
in `src/` imports it).

## Verdict

**FAIL.** With the product's current server settings, a fresh private answer
that arrives while a writer call is running starts several seconds late, even
when the writer is aborted the way the jobs engine aborts work. The decision
rule (median added delay ≤ 250 ms, 95th percentile ≤ 1 s, no writer-caused
reset) is missed by a wide margin: median **+5.1 s** to first token, 95th
percentile **+11.3 s**.

The writer never caused a model reset. Aborting the HTTP request does free the
server, but only at the end of the compute step it is in, and the writer also
evicts the cached analyst system prompt.

No fallback tested meets the rule. The best combination (64-token batches,
and the writer sharing the analyst's system prompt) brings the delay down to
about 0.2 s while the writer is generating and about 0.8–1.1 s while it is
reading its prompt. That is still over the rule, and the machine's noise floor
was too high to prove it either way at n = 3.

## Two causes, measured separately

1. **Abort waits for the current compute step.** llama-server checks for a
   closed connection between steps. While generating, a step is one token
   (about 0.1 s here), so the slot was free about 0.2 s after the abort. While
   reading a prompt, a step is a whole batch. With the product's default batch
   (2,048 tokens, which the server splits at its checkpoint near the end), the
   fresh answer waited 0.2–8.0 s. Arriving just after the writer started was
   the worst case: about 7 s.
2. **The writer evicts the analyst prompt from the cache.** Every fresh answer
   shares a 311-token analyst system prompt. After any writer call, completed
   or aborted, the next answer re-reads it: **+3.25 s** median to first token
   on this loaded Mac. That is about the same as a full model reset (+3.26 s).
   It applies even when nothing overlaps: a writer that finished seconds
   earlier still slows the next answer.

## Setup

- **Machine:** Apple M3, 24 GB, macOS 26.5.2.
  - Load average 3–5 throughout. Other sessions were running; the top CPU users
    were Spotlight indexing, a skill-library watcher, other Claude/Codex
    sessions and tests.
  - The owner's live Olympus engine processes were up (engine, relay, worker
    from the `chatgpt-plugin` worktree). No live llama-server ran during any
    paired trial: every trial records a read-only `ps` snapshot.
  - Nothing live was signalled, restarted or written to.
  - Prompt reading ran at 130–300 tokens/s and generation at 7–22 tokens/s,
    depending on load, the same range as the design's "loaded Mac" figures.
- **Model:** Qwen3.5 4B Q4_K_M (`qwen3.5-4b-q4_k_m-e87f176`) on llama.cpp
  `b11320` with Metal. Both are the files already on disk, used read-only.
- **Server:** our own instance, started through the product launcher
  (`createBuiltInAnalystModel` → `createLlamaServerHandle`), so it ran the
  product's exact flags: `--ctx-size 12288 --parallel 1 --threads 4
  --threads-batch 4 --n-gpu-layers 999 --prio -1 --reasoning off --no-webui
  --cache-ram 0 --no-slots --log-disable --sleep-idle-seconds 600` on a random
  loopback port with a token file. It ran in a scratch home and data
  directory, and was always torn down.
- **Fresh answer:** the product's own `answerPrivately` with the panel's
  summary limits: compact evidence, 11,000-byte prompt ceiling, 1,000-character
  answer, no audit pass.
  - The request is not streamed: temperature 0, JSON-schema output,
    `max_tokens` 512.
  - Evidence is the fictional demo data in `chatgpt-plugin/demo-data`. There
    are 5 questions with 4 items each, giving about 1,660 prompt tokens
    (median) and 66–208 output tokens.
- **Writer:**
  - **Prompt:** 2,039 model tokens after the chat template, counted with the
    server's own `/apply-template` and `/tokenize`.
  - **Output:** its own small JSON schema, `{"consult": null | [≤ 3
    strings]}`, temperature 0, `max_tokens` 160, giving 78 output tokens.
  - **Distinct prompts:** each writer call has a distinct first line, so
    writer calls never share a cache with each other.
  - **Hung stand-in:** the same prompt with `ignore_eos`, still generating when
    aborted at 20 s. This is a scaled stand-in for the 60 s writer deadline.

## Method

- **Paired and randomized.** Each trial is one (mode, phase, question) pair.
  It is run twice, in random order:
  - CONTROL: a fresh answer with nothing else running;
  - WRITER: a writer in flight, with the fresh answer arriving at the phase's
    point.
- **Identical starting state.** Both halves start after a one-token "primer"
  request. The primer leaves the analyst system prompt in the cache, as a
  previous fresh answer would.
- **What is timed:** everything from the fresh answer's arrival, with any
  abort delay included:
  - **first token** = wall time minus the server's own generation time (the
    product request is not streamed);
  - **completion** = wall time;
  - **server start** = wall time minus prompt and generation time, which shows
    when the server actually took the request.
- **abort mode** does what the jobs engine does (`private-answer-jobs.ts` run
  and cancel): it aborts the writer's `AbortSignal` and immediately issues the
  fresh answer. **queue mode** does not abort; the fresh answer waits.
- **Phases:**

  | Phase | Fresh answer arrives |
  |---|---|
  | just_started | 0.2 s into the writer (the worst case for "run the writer only after N seconds idle") |
  | prefill | halfway through the writer's prompt reading |
  | generation | 40% into the writer's output |
  | near_end | at 85% of the writer's output (in 2 of 5 abort trials the writer had already finished) |
  | hung | at the stand-in's 20 s deadline |

- **Sample sizes:** n = 5 per abort phase and n = 3 per queue phase. With
  n = 5 the 95th percentile is effectively the maximum.
- **Noise floor:** each control against the median control for the same
  question, so the reader can see what "zero" means on this machine.
- **Reset check:** the server pid is tracked across every trial. A model reset
  is a stop plus restart, so it would show as a second pid.

## Results: product configuration

Run: `bun scripts/measure-consult-writer-interference.ts --n 5 --queue-n 3`
(37 pairs). Times are ms: median, 95th percentile, and [range].

| Condition | Added first token | Added completion | Server start after arrival |
|---|---|---|---|
| Control, absolute (n=37) | 9,277 · p95 12,844 | 24,376 · p95 35,557 | — |
| **Noise floor**, \|control − same-question median\| | 473 · p95 3,286 | 891 · p95 7,016 | — |
| abort · just_started | 10,448 · p95 12,823 [10,080..13,331] | 10,514 · p95 14,179 | 7,270 · p95 8,010 |
| abort · prefill | 7,263 · p95 10,803 [6,485..11,454] | 11,359 · p95 20,736 | 2,175 · p95 3,291 [211..3,481] |
| abort · generation | 3,845 · p95 4,872 [2,111..5,115] | 4,790 · p95 7,047 | 173 · p95 216 |
| abort · near_end | 3,244 · p95 5,060 | 4,658 · p95 5,950 | 770 · p95 849 |
| abort · hung (deadline) | 2,644 · p95 5,200 | 5,304 · p95 7,675 | 249 · p95 1,010 |
| **abort, all phases** | **5,115 · p95 11,322** | — | — |
| queue · just_started | 22,993 | 23,449 | 21,138 |
| queue · prefill | 21,731 | 24,125 | 17,536 |
| queue · generation | 5,206 | 4,639 | 3,162 |
| queue · near_end (writer already done) | 303 | 864 | 11 |
| After a **completed** writer, no overlap (n=5) | 3,250 · p95 3,669 | — | — |
| After a model **reset**, for comparison (n=3) | 3,263 · p95 3,790 | — | — |

- **Resets:** one server process for all 37 pairs; no reset or restart. The
  abort path never needs one: the jobs engine resets the model only when an
  analysis passes its own deadline (`resetInBackground`), never on a cancel.
- **Cache:** in every writer-arm trial the fresh answer had 0 cached prompt
  tokens; every control had 311. That gap is cause 2.
- **Outputs:** fresh-answer output length was identical in every pair
  (temperature 0), so the completion deltas are not produced by different
  answers.

## Evidence that the server, not the client, is the bottleneck

- **Clean abort test.** We ran a scratch diagnostic with the server log on:
  a long generation, aborted after 8 s, with nothing else talking to the
  server. Three abort styles were tried: Bun `fetch` with an `AbortSignal`,
  `curl` killed, and a streamed request aborted. In every case the server
  logged `cancel task` about 50 ms after the abort, released the slot within
  60 ms, and started a waiting one-token request within 85–140 ms.
- **Abort while reading a prompt.** With the server log on, `cancel task`
  appears as soon as the connection closes. The slot is released only after
  the batch in progress finishes; the log shows the prompt progressing
  1129 → 1385 → 1641 tokens across the cancel.
- **`/slots` polling is not a valid probe.** A probe pass with `--slots`
  (the only flag changed) polled `/slots` every 10 ms after the abort. While
  that polling ran, a hung writer's disconnect was noticed only about 61 s
  later (3 of 3), against about 0.2 s in the paired trials, which do not poll.
  The server answers `/slots` only between compute steps, and heavy polling
  delayed disconnect detection. The cause inside the server was not
  established. Nothing in the product polls `/slots` today (it runs with
  `--no-slots`), but anything that later does would hit this.

## Fallbacks measured

Both runs are abort mode only. Each fallback is a server-flag change (or a
writer-prompt change), made through `--extra-args`.

### F1: `--cache-ram 256 --batch-size 256 --ubatch-size 256`

`--n 4`, 16 pairs. Noise floor: 125 · p95 627.

| Phase | Added first token | Server start |
|---|---|---|
| just_started | 5,408 · p95 5,993 | 3,280 · p95 3,797 |
| prefill | 4,073 · p95 9,457 | 2,865 · p95 4,350 |
| generation | 659 · p95 829 | 391 · p95 452 |
| hung | 757 · p95 1,049 | 220 · p95 247 |
| After a completed writer | 97 · p95 471 | — |

The RAM prompt cache restores the analyst prompt after a completed writer or
a generation-phase abort (311 cached tokens). It fails after an abort during
prompt reading:

- the server saves the aborted writer's state into the RAM cache (161 MiB,
  1.8 s, logged as `making room for prompt cache entry, removing oldest
  entry`);
- that save evicts the analyst entry.

It also adds up to 256 MiB of memory. Verdict: **FAIL** (median 2.2 s, p95
7.1 s).

### F2: `--batch-size 64 --ubatch-size 64`, writer shares the analyst prefix

The writer request starts with the analyst's system prompt, and its own rules
move into the user turn. `--n 3`, 12 pairs. Noise floor: 427 · p95 1,696.

| Phase | Added first token | Server start |
|---|---|---|
| just_started | 915 [−298..1,093] | 908 · p95 1,146 |
| prefill | 1,369 [−2,261..3,085] | 811 · p95 903 |
| hung | 278 [−793..442] | 193 · p95 206 |

What worked:

- The cache was kept in every trial (311 cached tokens), with no memory cost.
- The small batch bounds an abort during prompt reading to about 0.8–1.1 s.
- Controls showed no visible slowdown from the 64-token batch (first-token
  median 9.1 s, against 9.3 s in the main run). That is within noise, so it is
  not proven.

What is still wrong:

- The prompt-reading phases remain above 250 ms at the server alone.
- With the rules in the user turn, the model answered `{"consult": null}`
  (8 tokens). That is a prompt-quality problem to fix before this layout is
  usable, and it made the generation phase degenerate (the writer had finished
  before the fresh answer arrived).

Verdict: **FAIL**. The added-first-token figures are dominated by noise at
n = 3; server start is the reliable signal.

### Not measured

- `--parallel 2`: a second slot shares the same GPU, so a writer would still
  slow a concurrent answer, and the context is split per slot.
- `--batch-size` below 64.
- A separate small writer process: the design's fallback 3, at a memory cost.
- Slot save/restore (`--slot-save-path`).

## What this does not prove

- **Whole-panel latency.** Only the model call is measured. The larger fixed
  envelope, the new collection path and panel polling of §A.5 are not.
- **Other hardware and models.** Only one Apple M3 with 24 GB, the 4B model,
  under real background load. Not measured: 8 GB Macs with the 2B model, an
  idle machine, or the 9B model. The absolute seconds scale with prompt speed;
  the two causes do not depend on it.
- **The real writer prompt.** The prompt here is a stand-in for the design's
  writer prompt, sized to the 2,048-token bound. A typical writer prompt of
  about 1,000 tokens would shorten the prompt-reading window, not remove it.
- **Real panel traffic.** Fresh answers arrived at controlled points, not on
  a real traffic pattern.

## Round 2: can any configuration isolate the writer? (2026-10-07)

Script: `scripts/measure-consult-writer-isolation.ts` (measurement only; nothing in
`src/` imports it). Round 2 started from an earlier engine's draft; this section
replaces that draft's screening runs, which had defects (below).

### Verdict

**No single-server configuration passes. One does on the server's own
measure and nearly on the rule: a separate writer process with small batches,
killed the moment a fresh answer arrives (B2).**

- **A (same server, shared analyst prefix, small batches): FAIL.** The shared
  prefix fixes the cache (the analyst prompt survived in 28 of 28 pairs). The
  abort is what is left: the server takes the fresh answer 0.9-1.0 s late at
  batch 64 and 0.5-0.6 s late at batch 32 when the writer is just starting or
  reading its prompt. A single-server abort cannot be faster than one batch.
- **B2 (second llama-server for the writer, batch 64, SIGKILL on arrival): the
  server took the fresh answer within 14 ms of the control in every phase**, the analyst prompt
  stayed cached in every pair, and nothing resets. Added first-token time is inside
  this machine's noise floor (see the table) but is not proven below 250 ms.
  Costs: about 0.6 GB more memory and a 1.0-1.3 s start-up when the writer
  server is started on demand.
- **B with the product's default batch (2,048): FAIL in one phase.** After a
  kill during prompt reading the fresh answer was 3.1-8.0 s late in 4 of 4
  pairs although the server took it at once. Giving the writer server small batches
  removed it in 3 of 4 pairs (B2: 0.16 s median at n = 3, then one +7.7 s pair
  while the machine was swapping). The mechanism (GPU work the killed process had
  already queued, or memory pressure) is inferred, not measured.
- **C (`--parallel 2`): FAIL.** The context does fit (12,288 per slot with
  `--ctx-size 24576`), for about 0.5 GB more memory, but an abort still waits for the
  batch, exactly as in A.

What this run does not establish: the rule's 250 ms median cannot be demonstrated
on this machine. The control-versus-control noise floor was 0.2 s to 2.6 s
(median absolute difference; see the tables), which is larger than the tolerance.
The server-side "time until the server took the request" is the clean signal
(control about 12 ms), and the tables report both.

### What changed in the method (the draft's defects, fixed)

| Defect in the draft | Now |
|---|---|
| "Success" of the writer was any string over 10 characters | A reply is usable only if it is JSON with 1-3 questions, each ending in "?", at most 25 words, no digit, and no capitalised word after the first (a name or place, copied or inferred). The rate is reported (below). |
| Another model server below 5% CPU was allowed | The run refuses to start, and stops if one appears, when ANY other `llama-server` executable exists (read-only `ps`; shells that merely mention the name do not count). It happened once: see "Surprises". |
| Swap guard allowed 1 GB of new swap-outs | Run stops after 0.5 GB; a second server is refused unless the kernel's free-memory figure stays at or above 20% after it; critical pressure stops the run. |
| Failures were discarded and kills assumed external | Nothing is discarded. A fresh answer with no first token, or a pair that finds the server gone, is logged and counts as infinite added delay (any such pair makes the phase fail). There were none. |
| Unexplained SIGKILLs | Explained and reproduced: see "The SIGKILLs". |
| "Hung" phase aborted at prefill + 3 s | The writer (a stand-in that ignores end-of-sequence) runs to the real deadline of 60 s, then the fresh answer arrives and the writer is stopped, as the jobs engine would at its deadline. |
| Phases were clock offsets set by a calibration made under unrelated load | For streamed writers each phase is triggered by the writer's own progress: half the prompt read; 40% and 85% of its output tokens. |
| Machine load was uncontrolled | Each pair waits for the 1-minute load average to be at most 9 (up to 12 min) and records it. One earlier screening run overlapped a load average of 59 from another session and was discarded wholesale (not used). |

Also new: control-versus-control (A/A) pairs measure the noise floor directly, and
the fresh answer is the product's exact request, streamed with the server's
prompt-progress events. Those show when the server took the request and how many
prompt tokens were cached.

### The SIGKILLs: cause found, "zero resets" now proven

Both earlier screening runs lost their server to SIGKILL about 12-14 minutes in.
Cause: the product launcher's idle timer (`idleShutdownSeconds`, 600) is armed by
`handle.touch()`, which the product's model wrapper calls after each request. The
draft talked to the server directly after its setup calls, so the timer fired ten
minutes after the last wrapped request and stopped a busy server; stopping a busy
server escalates from SIGTERM to SIGKILL after 5 s.

Reproduced (`--mode idle-test`): a launcher with a 20 s idle timer, armed once,
with a busy server and no further `touch()`, was killed with SIGKILL 25.0 s after
the request began (20 s + 5 s grace). The script now touches the handle on every
request, as the wrapper does. Since then: 0 unexpected exits across all completed runs
(the longest ran 43 minutes; the main server's only exit in every run is code 0 at
the end, from our own stop). The only SIGKILLs are the writer servers we killed
on purpose in B and B2.

### Setup (run vs inferred)

| Item | Value | Run or inferred |
|---|---|---|
| Machine | Apple M3, 24 GB, macOS 26.5.2 | run |
| Load | 1-minute load average at the start of each pair: A64: 6 (3-9); A32: 3; B: 3; B2: 2; C: 3. Other sessions' work caused spikes (one to 59). Memory pressure level 1-2 ("warn"); about 6.7 GB of swap already in use by other processes. | run |
| Model | Qwen3.5 4B Q4_K_M (`qwen3.5-4b-q4_k_m-e87f176`), llama.cpp `b11320`, Metal | run |
| Server flags | The product's, through the product launcher, plus only the flags under test: `--ctx-size 12288 --parallel 1 --threads 4 --threads-batch 4 --n-gpu-layers 999 --prio -1 --reasoning off --no-webui --cache-ram 0 --no-slots --log-disable --sleep-idle-seconds 600` | run |
| Other model servers during runs | None (checked before every pair). The live Olympus engine started one at about 09:30; the harness refused to run and waited until it had gone (about 10 minutes). | run |
| 2B model | Not on disk (only the 4B GGUF is), so not tested | not run |
| Writer prompt | 2,038-2,039 tokens after the chat template; output 38 tokens (shared prefix) or 64 (own prefix); distinct first line per call | run |
| Whole-panel latency, other Macs, 9B, an idle machine | Not measured | not run |
| Cold writer-server start while a fresh answer is loading | Not measured (start-up alone: 1.0-1.3 s with the model file in the page cache) | not run / inferred |

### Writer wording: does it return a usable question?

The writer request begins with the analyst's exact system prompt; the writer rules
go in the user turn. Usable-question rate with the check above (6 distinct
inputs, temperature 0, deterministic): **5 of 6** usable (all 6 valid JSON with
1-3 questions, none declined). The sixth names a country ("Portugal") that the
answer never states but the itinerary implies, which breaks the "no places" rule,
so the prompt needs a stricter instruction or a post-check before this is used.
The timing writer on the first input produced a usable reply in all 15 calibration
calls across the runs. The own-system-prompt writer (B) was checked only on that
input (3 of 3 per run), not on all six.

### Candidate A: same server, shared prefix, small batches

Writer request starts with the analyst's system prompt; streamed with progress events
so the server notices the closed connection every batch; writer aborted on arrival.
Added time to first token, ms, median / p95 (n); and "server took it", the added
delay until the server started on the fresh answer. "Prefix kept" is the analyst
system prompt found cached.

**A, batch/ubatch 64, `--cache-ram 0`** (n = 5-6 per phase; stopped at 28 of 36 planned
pairs by the swap guard after 0.62 GB of swap-outs, caused by other processes):

| Phase | n | Added first token | Server took it | Prefix kept |
|---|---|---|---|---|
| just started | 5 | 1,311 / 4,975 | 930 / 1,393 | 5/5 |
| prefill | 6 | 757 / 5,191 | 1,046 / 1,674 | 6/6 |
| generation | 6 | 862 / 9,264 | 200 / 576 | 6/6 |
| near end | 6 | 714 / 1,299 | 258 / 734 | 6/6 |
| hung (60 s deadline) | 5 | 423 / 1,072 | 188 / 328 | 5/5 |
| **Pooled** | 28 | **763 / 5,439** | 320 / 1,388 | 28/28 |
| Noise floor, \|control - control\| | 6 | 2,559 / 6,378 | | |

**A, batch/ubatch 32** (n = 3 per phase, screening only):

| Phase | n | Added first token | Server took it |
|---|---|---|---|
| just started | 3 | 348 / 829 | 528 / 735 |
| prefill | 3 | 74 / 496 | 614 / 641 |
| generation | 3 | 311 / 946 | 203 / 210 |
| **Pooled** | 9 | **311 / 963** | 528 / 712 |
| Noise floor | 2 | 267 / 377 | |

- **Memory:** none extra (main server footprint 0.76-0.91 GB, as the product's).
- **Effect on ordinary answers (no writer):** none visible at 64 (below).
  Batch 32 costs about +7.5% (earlier run, n = 10: 11.1 s against 10.4 s).
  Batch 16 doubles it, so it is out.
- **`--cache-ram 256` (small RAM cache):** not run in pairs. The shared prefix
  already keeps the cache at no memory cost, so the RAM cache has nothing to add
  for the writer. It does not help aborts (below).
- **Verdict: FAIL, by structure.** An abort lands between batches. At the
  prompt speed measured here (130-250 tokens/s) a batch of 64 takes roughly
  0.25-0.45 s and a batch of 32 half that (inferred from prompt speed, not timed
  directly). The server took the fresh answer 0.9-1.0 s late at batch 64 and
  0.5-0.6 s late at batch 32 in the two phases where the writer is starting or
  reading its prompt, which is a few batch times; why it exceeds one batch was not
  established. The median rule (250 ms) cannot be met without batches so small that
  ordinary answers lose 10% or more. Generation, near end and the 60 s deadline are
  about 0.2-0.3 s (one token step) and are the nearest to passing.

### Candidate B: a separate writer process

Second `llama-server`, same 4B file (mapped, so the weights are shared with the
first), the writer's own system prompt, streamed. On arrival the writer server is
killed with SIGKILL (stopping took 28-72 ms), then restarted, untimed, for the
next trial. The fresh answer's server is the product's unchanged.

**B, writer server at the product's default batch (n = 4 per phase, 20 pairs plus 3 A/A):**

| Phase | n | Added first token | Server took it |
|---|---|---|---|
| just started | 4 | -521 / 511 | 4 / 5 |
| **prefill** | 4 | **5,129 / 7,731** | -1 / 1 |
| generation | 4 | -491 / 602 | 1 / 7 |
| near end | 4 | 959 / 1,018 | 1 / 10 |
| hung (60 s deadline) | 4 | -471 / 800 | 3 / 7 |
| **Pooled** | 20 | 572 / 6,478 | 2 / 8 |
| Noise floor | 3 | 195 / 487 | |

**B2, writer server with `--batch-size 64 --ubatch-size 64`** (n = 3 per phase, 15 pairs plus 2 A/A):

| Phase | n | Added first token | Server took it |
|---|---|---|---|
| just started | 3 | 375 / 1,609 | 3 / 7 |
| prefill | 3 | 160 / 273 | 0 / 3 |
| generation | 3 | -102 / 1,227 | 1 / 4 |
| near end | 3 | 1,227 / 2,336 | 1 / 5 |
| hung (60 s deadline) | 3 | 95 / 481 | 14 / 14 |
| **Pooled** | 15 | **160 / 1,960** | 1 / 14 |
| Noise floor | 2 | 1,104 / 1,911 | |

**B2, first run plus an extension run, pooled** (a second run to reach more pairs stopped
itself after 7 of 38 planned pairs: the swap guard fired at 2.26 GB of swap-outs from
other processes, with the load average at 14):

| Phase | n | Added first token | Server took it |
|---|---|---|---|
| just started | 4 | 429 / 1,556 | 0 / 6 |
| prefill | 4 | 223 / 6,607 | 1 / 3 |
| generation | 5 | -568 / 1,080 | 1 / 6 |
| near end | 5 | 142 / 2,213 | 3 / 12 |
| hung (60 s deadline) | 3 | 95 / 481 | 14 / 14 |
| **Pooled** | 21 | **142 / 2,459** | 1 / 14 |
| Noise floor | 3 | 1,932 / 1,994 | |

One of the four prefill pairs was +7.7 s although the server took the fresh answer in
11 ms, in the window where other processes were pushing the machine into swap. The
other three were -220 to +285 ms. So the small-batch fix for the prefill spike is
promising but not proven (the mechanism may be memory pressure rather than queued GPU
work, in which case B and B2 would both be exposed on a busy machine).


- **Memory (run):** the writer server's physical footprint is 580-590 MB (its resident
  figure of 3.2 GB is the mapped model, shared with the first server). The machine's
  free-memory figure fell about 3-4 points (about 0.8 GB of 24 GB) with both up.
- **Start-up (run):** 1.0-1.3 s to a ready writer server with the model file in
  the page cache. Kept warm, there is no start-up; on demand, the writer waits
  that long before it begins (the fresh answer is not waiting for it).
- **Effect on ordinary answers:** none by construction (the first server is
  unchanged), apart from the memory pressure above.
- **A hung writer:** killing only the writer's process means the model never has to
  be reset (round 1's reset cost +3.3 s); in the 60 s hung phase the fresh answer
  was not delayed beyond noise (B +/-0.5 s, B2 +0.1 s).
- **Verdict: B2 is the only configuration that passes on the server's measure in
  every phase.** On first-token time its pooled median is +142 ms (n = 21) with a p95 near 2.5 s,
  which sits inside this machine's noise floor (0.2-1.1 s median); with
  n = 3 per phase, a 250 ms tolerance cannot be confirmed or refuted from
  these figures alone. The remaining "near end" excess (+1.0 s in B, +1.2 s in B2)
  is the one pattern that repeats in both runs; it may be real (the kill lands as
  the writer finishes its last tokens) and needs the larger sample below.

### Candidate C: `--parallel 2`

`--ctx-size 24576 --parallel 2 --batch-size 64 --ubatch-size 64`, writer with its own
prompt in the second slot, aborted on arrival (n = 3 per phase, screening).

| Phase | n | Added first token | Server took it | Prefix kept |
|---|---|---|---|---|
| just started | 3 | 1,209 / 1,972 | 903 / 932 | 3/3 |
| prefill | 3 | 84 / 510 | 747 / 767 | 3/3 |
| generation | 3 | 1,211 / 7,841 | 140 / 146 | 2/3 |
| **Pooled** | 9 | **801 / 5,970** | 736 / 922 | 8/9 |

- **Context:** 12,288 tokens per slot held (`/props`: 2 slots, 12,288 each) only with
  the total doubled to 24,576.
- **Memory:** the server's footprint rose from about 0.85 GB to 1.32 GB (+0.47 GB).
- **Caveat:** with two slots, a repeated question finds its whole prompt already
  cached in the other slot, so controls were sometimes much faster (one first token of
  0.2 s) and the noise floor (4.6 s, n = 2) is meaningless here. Indicative only.
- **Verdict: FAIL.** The abort still waits for the batch (0.75-0.9 s when the writer
  is starting or reading), so C buys nothing over A except keeping the cache, which A
  already does with the shared prefix.

### Summary by candidate

| Candidate | Pooled added first token (median / p95) | Worst phase (server took it) | Memory | Ordinary answers | Verdict |
|---|---|---|---|---|---|
| Round 1, product config | 5,115 / 11,322 | 7.3 s | 0 | n/a | FAIL |
| A64 shared prefix | 763 / 5,439 (n = 28) | 1.0 s (prefill) | 0 | none visible | FAIL |
| A32 shared prefix | 311 / 963 (n = 9) | 0.6 s (prefill) | 0 | about +7.5% | FAIL (screening) |
| B, writer batch default | 572 / 6,478 (n = 20) | prefill +5.1 s | +0.6 GB | none | FAIL (prefill) |
| **B2, writer batch 64** | **142 / 2,459 (n = 21)** | **14 ms** | **+0.6 GB** | none | **Pass on server measure; first-token unproven (noise, one prefill outlier)** |
| C parallel 2 | 801 / 5,970 (n = 9) | 0.9 s | +0.5 GB | not measured | FAIL (screening) |

### Product observation: what small batches and a small cache do for today's product

Independent of consults. "Abort to next start" is how long after a client abandons a long
call the next request starts on the server (the product's calls are not
streamed). It matters for any aborted job: a job cancelled by a newer search, a
tier-sniffer call yielding to an answer.

Paired, alternating blocks, same machine and day (this run, 1 round, 5 questions each,
no writer; plus an earlier run on the calm machine, 2 rounds, n = 10) :

| Config | First token after a primer (this run / earlier) | After a foreign call (the sniffer) | Abort in prompt reading to next start | Abort in generation |
|---|---|---|---|---|
| product (batch 2,048, `--cache-ram 0`) | 9,856 / 10,354 | 11,163 / 12,976 | **6,176 [1,523..7,951]** / 4,962 | 241 |
| batch 256 | 10,078 / 10,066 | 10,892 / 12,322 | 1,321 / 866 | 217 |
| **batch 64** | **9,077 / 10,070** | **10,524 / 12,337** | **198 [45..726]** / 195 | 137 |
| batch 32 | not run / 11,135 | not run / 13,377 | not run / 91 | |
| batch 64 + `--cache-ram 256` | 9,106 / not run | 11,531 / not run | 628 / not run | 241 |
| `--cache-ram 256` alone | not run / 10,109 | not run / 11,850 | not run / 6,276 | |

- **Confirmed:** batch 64 takes the abort-to-next-start from about 5-6 s to 0.2 s (45-726 ms in 3
  samples; 102-546 ms in 4 earlier), with no visible penalty on an ordinary
  answer (first token 9.1 s against 9.9 s in this run, 10.1 against 10.4 in the
  earlier one: batch 64 was, if anything, marginally faster, inside noise).
  Prompt reading speed is unchanged (148 against 137 tokens/s).
- **Batch 256 is the cautious choice:** an abort in prompt reading still takes 0.9-1.9 s.
- **A small RAM cache does nothing for aborts** (`--cache-ram 256` alone: 6.3 s) and
  does not speed the answer after a sniffer call beyond noise (11.5 s against 11.2 s
  for the product in this run). It costs up to 256 MB. Not recommended.
- **Post-sniffer latency:** a foreign call before an answer costs +0.8 to +2.4 s at
  every setting, because it evicts the analyst prompt. Only keeping that prefix
  (shared system prompt, or a separate process for the foreign work) removes it.
- Sample sizes are small (5 answers and 3-5 aborts per setting per run); the two
  runs agree.

### Recommendation

1. **Adopt batch/ubatch 64 for the built-in server now.** It is the one setting that
   needs no consult feature, costs nothing measurable, and makes cancellation work
   (6 s to 0.2 s). Confirm on a quiet machine and on the 2B model before shipping widely.
2. **For the writer, use B2:** a second `llama-server` for the writer only, with
   `--batch-size 64 --ubatch-size 64`, killed (not aborted) when a fresh answer
   arrives or at the writer's deadline. It leaves the answer server and its cache
   alone, needs no model reset for a hung writer, and the server starts the fresh answer
   within about 14 ms. One prefill pair in four was +7.7 s under memory
   pressure, so re-check that phase on a quiet machine. Costs: about 0.6 GB of memory while up and 1.0-1.3 s to start,
   so start it on demand when memory is tight and keep it warm when it is not.
3. **Keep the owner's tolerance open.** On this machine the first-token figure cannot
   resolve 250 ms; the server-side measure does. The owner should either accept the
   server-side measure for this rule or ask for a quiet-machine re-run (see below).
4. If a second process is unacceptable: A at batch 32 with the shared prefix and a
   streamed writer, which fails the rule by 0.3-0.4 s in the first seconds of a writer
   call. It pairs naturally with the earlier fallback of starting the writer only
   after the queue has been idle for N seconds, which removes the just-started case.

### Surprises

- The live Olympus engine started its own model server about 09:30; the harness
  refused to run, correctly. It was gone about 15 minutes later (the launcher's idle shutdown).
- A separate process is not free to kill: killing the writer at the product's default
  batch left the GPU busy for seconds (B, prefill +3 to +8 s), invisible in the
  server-side "took it" figure. Small batches on the writer server fixed it.
- The shared prefix is a bigger win than any batch size: the cache survived in
  every pair of every configuration that had it.
- Another session's video job pushed the load average to 59 during one screening run;
  the load gate and per-pair load records exist because of it.

### Not done, and what would settle it

- A quiet-machine run (load below 3) of B2 at n >= 20 per phase with 30 A/A pairs.
  The hung phase alone is 20 minutes at n = 20 because it runs to the 60 s deadline.
- The cold-start case (writer server starting while a fresh answer arrives).
- Candidate A with `--cache-ram` in pairs, and B with the 2B model: not run.
- The real writer prompt and the 9B model.

## Reproduce

```sh
bun install
# Main run (about 50 minutes on a loaded M3): paired trials, cache and reset comparison.
bun scripts/measure-consult-writer-interference.ts --n 5 --queue-n 3 --out <dir>/main.json
bun scripts/measure-consult-writer-interference.ts --analyze <dir>/main.json
# Fallbacks:
bun scripts/measure-consult-writer-interference.ts --n 4 --modes abort \
  --only-phases just_started,prefill,generation,hung --no-reset-compare \
  --extra-args "--cache-ram,256,--batch-size,256,--ubatch-size,256" --out <dir>/f1.json
bun scripts/measure-consult-writer-interference.ts --n 3 --modes abort \
  --only-phases just_started,prefill,generation,hung --no-reset-compare \
  --writer-shares-analyst-prefix --extra-args "--batch-size,64,--ubatch-size,64" --out <dir>/f2.json
# Diagnostics: --slots-probe (polls /slots after aborts), --server-log <file> (keeps the server log).
```

The script needs the built-in model and server already installed in the default
data directory, and never downloads. All state goes to `--state` (default
`.measure/consult-m0` in the checkout). Trial order is fixed by `--seed`.

Round 2:

```sh
S=scripts/measure-consult-writer-isolation.ts
# Why a harness that bypasses the model wrapper loses its server: launcher idle timer.
bun $S --mode idle-test --out <dir>/idle.json
# Writer wording: usable-question rate.
bun $S --mode quality --n 1 --writer-prefix shared --main-args --batch-size,64,--ubatch-size,64 --out <dir>/quality.json
# A: same server, shared analyst prefix, small batches, streamed writer, abort on arrival.
bun $S --mode pairs --n 6 --aa-n 6 --main-args --batch-size,64,--ubatch-size,64 \
  --writer-prefix shared --writer-stream true --on-arrival abort --out <dir>/A64.json
# B2: separate writer server with small batches, SIGKILLed on arrival.
bun $S --mode pairs --n 3 --aa-n 2 --writer-server separate --writer-start warm \
  --writer-args --batch-size,64,--ubatch-size,64 --writer-prefix own --writer-stream true \
  --on-arrival sigkill --out <dir>/B2.json
# C: two slots, 12,288 tokens each.
bun $S --mode pairs --n 3 --aa-n 2 --phases just_started,prefill,generation \
  --main-args --ctx-size,24576,--parallel,2,--batch-size,64,--ubatch-size,64 \
  --writer-prefix own --on-arrival abort --out <dir>/C.json
# Ordinary answers and abort responsiveness, per server setting:
bun $S --mode ordinary --rounds 1 --configs "product=;b64=--batch-size,64,--ubatch-size,64" --out <dir>/ordinary.json
bun $S --analyze <dir>/A64.json
```

The script refuses to run if any other `llama-server` process exists, waits for the
machine's 1-minute load to be at most 9 before each pair, stops on heavy swap-out or
critical memory pressure, and logs (never discards) every failure.

