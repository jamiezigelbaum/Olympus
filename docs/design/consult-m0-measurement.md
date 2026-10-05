# M0: does a writer call slow a fresh private answer?

Status: measured 2026-10-05 on `claude/consult-m0` (base `main` at `bc1cd078`).
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
