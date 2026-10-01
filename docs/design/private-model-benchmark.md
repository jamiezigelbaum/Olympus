# Built-in private model: candidates, runtime, benchmark, defaults

Status: implemented on `claude/private-model` (owner approval 2026-10-01).
Code: `src/core/analyst-built-in.ts`,
`src/workers/source-index/built-in-reasoning/{manifest,install,server}.ts`.
Benchmark harness: `eval/private-model-bench.ts`.

## What it is

`built_in` is an `AnalystModel`: a small instruction-tuned LLM that ships
inside Olympus with zero setup and answers Private-tier questions from
Private evidence with citations, using the one generic Analyst prompt (answer
from this evidence only, cite each claim, say what you could not find). The
model and the server that runs it are downloaded on first use, checked against
pinned SHA-256 digests, and run in a loopback-only child process. Nothing it
reads or writes leaves the computer.

## Candidates, verified from primary sources (2026-10-01)

The owner's list came from an X/Grok summary. Every entry was checked against
its Hugging Face model card and license; all named models exist.

| Model | Released | License | Redistribution / commercial | 4-bit GGUF used (pinned) | Download |
|---|---|---|---|---|---|
| Qwen3.5 4B (`Qwen/Qwen3.5-4B`) | 2026-02-27 | Apache-2.0 | Yes, no use restrictions | `unsloth/Qwen3.5-4B-GGUF` Q4_K_M @ `e87f176` | 2.74 GB |
| Qwen3.5 9B (`Qwen/Qwen3.5-9B`) | 2026-02-27 | Apache-2.0 | Yes | `unsloth/Qwen3.5-9B-GGUF` Q4_K_M @ `3885219` | 5.68 GB |
| Qwen3.5 2B (`Qwen/Qwen3.5-2B`) | 2026-02-28 | Apache-2.0 | Yes | `unsloth/Qwen3.5-2B-GGUF` Q4_K_M @ `f6d5376` | 1.28 GB |
| Gemma 4 E4B (`google/gemma-4-E4B-it`) | 2026-03-02 | Apache-2.0 | Yes. Gemma 4 moved to Apache-2.0; the Gemma 1-3 "Gemma Terms of Use" and prohibited-use policy do not apply to it (ai.google.dev/gemma/docs/gemma_4_license) | `google/gemma-4-E4B-it-qat-q4_0-gguf` @ `4b4a2c1` | 5.15 GB |
| Gemma 4 E2B (`google/gemma-4-E2B-it`) | 2026-03-02 | Apache-2.0 | Yes (as above) | `google/gemma-4-E2B-it-qat-q4_0-gguf` @ `675cff4` | 3.35 GB |
| LFM2.5 2.6B (`LiquidAI/LFM2.5-2.6B`) | 2026-07-28 | LFM Open License v1.0 | **Restricted**: commercial use only below USD 10M annual revenue | `LiquidAI/LFM2.5-2.6B-GGUF` Q4_K_M | 1.67 GB |

LFM2.5 is excluded because its license carries a commercial-use revenue
threshold, which does not suit a model Olympus downloads for every install.
Qwen publishes no official GGUF for Qwen3.5. The quantizations come from
unsloth, under the same Apache-2.0 license, and are pinned by commit and
digest. No smaller Qwen3.6 exists: Qwen3.6 ships only as 27B and 35B-A3B.

## Runtime

Olympus runs the official llama.cpp `llama-server` release binary as a child
process. Release `b11320` is MIT-licensed and pinned per platform by SHA-256:
`darwin-arm64` with Metal (11.8 MB), plus `linux-x64` and `linux-arm64`
CPU builds. Olympus does not embed node-llama-cpp. That would put a native
N-API addon and its dependency tree into a plugin that ships as one bundled
JavaScript file, and its Bun compatibility is unproven. A separate process
gives:

- Isolation. A model crash cannot take down the worker, and the model's
  memory comes back when the process exits.
- Control that does not depend on Bun or Node. The server takes
  `--threads` and `--threads-batch` (half the logical cores, at most 4),
  `--prio -1` plus `nice 10`, `--parallel 1`, and a 12k context. It offloads
  fully to Metal on Apple silicon. It exits after 10 minutes idle, and
  `--sleep-idle-seconds` also unloads the model inside the server, so an
  orphaned process holds no model memory.
- Loopback only. The server binds `127.0.0.1` on a random free port. A
  random bearer token reaches it through a 0600 file (`--api-key-file`), never
  argv. The web UI is off, and `/health` is the only unauthenticated route.
- A pinned install. The archive and the GGUF are verified before use, and a
  file that does not match is deleted. A partly downloaded model resumes with
  a Range request. Progress goes to
  `~/.local/share/openclaw/olympus/models/built-in-reasoning/status.json`,
  with the same shape and states as the built-in embedding (`downloading`,
  `verifying`, `loading`, `ready`, `failed` with a reason).

This works without OpenClaw: the analyst needs only the data directory and
the downloaded files.

## Benchmark

**Setup.** Apple M3 with 24 GB, macOS 26.5, llama.cpp b11320 (Metal), and
production settings (low priority, 4 threads, JSON-object grammar, temperature
0, the generic Analyst prompt plus the local audit pass that the source worker
enables for local analysts).

**Question set.** The repository's held-out eval keeps its instantiated
private-tier cases out of git, so this run used a synthetic Private set built
from the fictional reviewer demo data (`chatgpt-plugin/demo-data`). It has
12 questions:

- 10 answerable questions: value lookups, an aggregate, a locator, two
  cross-source syntheses, and a summary.
- 2 coverage-negative questions.

Each pack holds all 5 Private items and 3 Personal distractors (about
2.3k prompt tokens). Grading uses the held-out eval's own rules
(`eval/grade.ts`, `answerCorrect` and `evidenceCited`). A negative question
passes when the model reports the gap and invents no value.

**Caveat.** This Mac was shared with several other heavy sessions throughout
(load average 4-90; GPU about 80% busy before any model started). Absolute
speeds are therefore pessimistic. Each row records the 1-minute load average
at the end of its run. The two Qwen3.5-4B runs show the spread: 2.9 versus
6.0 tok/s generation for the same model.

| Model | Pass (of 12) | Gen tok/s | Prompt tok/s | Median TTFT | Median answer (2 calls) | Peak RAM (RSS) | Cold start | Load |
|---|---|---|---|---|---|---|---|---|
| **Qwen3.5 4B Q4_K_M** (run 2) | **11** | 6.0 | 109 | 20.4 s | 62 s | 3.2 GB | 3.1 s | 4.5 |
| Qwen3.5 4B Q4_K_M (run 1) | 11 | 2.9 | 81 | 26.3 s | 116 s | 3.3 GB | 5.3 s | 4.8 to 33 |
| Gemma 4 E4B QAT q4_0 | 9 | 2.3 | 82 | 26.6 s | 189 s | 5.1 GB | 12.3 s | 5 to 92 |
| **Qwen3.5 2B Q4_K_M** | 9 | 8.8 | 255 | 8.7 s | 46 s | 1.6 GB | 1.9 s | 9.5 |
| Gemma 4 E2B QAT q4_0 | 8 | 12.2 | 218 | 10.0 s | 46 s | 3.4 GB | 4.7 s | 4.2 |
| Qwen3.5 9B Q4_K_M (opt-in) | 11 | 2.6 | 53 | 45.4 s | 157 s | 5.9 GB | 11.7 s | 18.5 |

**Misses.**

- Every model missed p08. That question asks why the person saw the doctor,
  which needs the clinic note, and what the tests showed, which needs the
  lab email. The models answered from the lab email alone.
- Gemma E4B timed out once (more than 300 s under load average 90). On two
  questions it returned no grounded answer, so the Analyst proposed an
  escalation.
- Qwen3.5 2B failed both negatives: it answered "Nothing" but cited an
  unrelated item and reported no gap.
- Gemma E2B returned no grounded answer on three answerable questions.

## Defaults (chosen with this evidence)

- **16 GB or more: Qwen3.5 4B** (2.74 GB download). It scored best, 11/12 in
  both runs. Compared with Gemma 4 E4B it was faster under the same load, used
  half the memory (3.2 versus 5.1 GB), and is half the download.
- **8 GB: Qwen3.5 2B** (1.28 GB download). It ties Gemma E2B on speed and
  scores one more question. It needs under half the memory (1.6 versus
  3.4 GB), which is what matters on an 8 GB Mac. Its weak point is reporting
  gaps.
- **Less than 7 GB: no built-in model.** The Private lane keeps its existing
  routes.
- **Opt-in upgrade: Qwen3.5 9B** (5.68 GB), set with
  `OLYMPUS_BUILT_IN_ANALYST_MODEL=large` and needing 16 GB or more. On this
  set it scored the same as the 4B model (11/12, also missing p08) at about
  2.5 times the latency and 1.8 times the memory, so it is not a default. The same
  variable accepts `small`, `standard`, or an exact model id.
- **On or off.** `OLYMPUS_BUILT_IN_ANALYST=on|off`. The default is on for
  Apple silicon and off elsewhere, so a Linux host never starts a download it
  did not ask for.

## How it is wired

- **Private lane (source worker).** When the secure pool has no constructible
  Venice member, each local secure-pool member is wrapped with
  `withBuiltInFallback`. The configured local model service is always tried
  first, and the built-in model answers only when that service is not running
  (`argus_unreachable`, not a timeout). Both run on this computer, so the
  trust boundary does not move.
- **Boot.** At worker boot the worker probes the configured local service. If
  it does not answer, the one-time download starts so the dashboard shows the
  install immediately.
- **Before the download finishes.** A Private question gets a fast
  "still downloading (N%)" local-unavailable error, never a hang.
- **Private-answer panel.** The panel calls
  `answerPrivately(question, evidence)`, which returns
  `{ answer, citations: [{ id, title?, locator?, claim }], unanswered, modelId }`.
  Every evidence item is treated as `secure_local`/S4. The call waits for a
  first install, and it never escalates: an ungrounded answer returns
  "These private items do not answer this question" with the gap.
- **Dashboard.** `builtInPrivateModelStatus()` returns `enabled`,
  `displayName`, `downloadBytes`, and the status-file state and percent. It
  reads files only and never starts a download.

## Follow-ups

- Re-measure speed on a quiet machine. The relative ranking held across both
  load conditions.
- On the 8 GB class, consider disabling the audit pass to halve latency.
  First measure whether the audit catches more misses than it costs.
- Surface `builtInPrivateModelStatus()` on the dashboard's models card. That
  belongs to the dashboard lane.
