# Design: frontier consult on the private answer panel, over zkAPI

Status: **proposal, revision 9 (2026-10-07).** Revision 8 recorded the M0 failure on the shared server and the scheduling choice (separate writer process). Revision 9 records two owner rulings of 2026-10-07 (the "consult undetectable by ChatGPT or the relay" goal is dropped from version one; at most two review rounds per PR) and the M1 live measurement. Dispositions are in [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md), sections G, H and I. Nothing here changes shipped behavior or the release plan.
Risk class: **Critical** (egress of Private-derived text; money).

## Changes since revision 8

1. **Owner ruling, 2026-10-07: undetectability is dropped from version one.** Content stays sealed; ChatGPT and the relay may infer that outside help ran (timing, size changes, polling), never what was asked or answered. §A.5 is rewritten: the locked reported height, 640 px cap, reserved strip, geometry persistence, response-time floor, withdrawn-polling parity, outcome-independent eviction rules and host-transcript proofs are removed. The accepted residual is stated in §A.5.5. AD-2, C4a, §A.13 and §10 follow.
2. **Owner ruling, 2026-10-07: at most two review rounds per PR;** a third only for a money or data-loss blocker (§A.14 conventions).
3. **M1 is done.** Ten live consults, all ok (§A.8, "Measured speed"): median total 96.8 s, 74 s before the reply, 22 s after it. Three speed measures in priority order, the key-reuse setup requirement and an enable-flow lesson are recorded. Stage table: M1 done, C2 in progress.

## Changes in revision 8 (since revision 7)

1. **M0 is measured and failed on the shared server** (pooled +5.1 s median, +11.3 s p95). The results are in §A.7, from `docs/design/consult-m0-measurement.md` on `claude/consult-m0` (rounds 1 and 2).
2. **Scheduling choice: candidate B2.** The writer runs on its own `llama-server` process (batch 64), killed, not aborted, when a fresh answer arrives or at the writer's deadline. A memory rule decides whether it may start (§A.7). A, and C (`--parallel 2`), are rejected with reasons.
3. **Honest status of B2:** it passes the server measure; first-token time is inside this machine's noise floor and is **unproven on a quiet machine**. A quiet-machine rerun, judged by the stricter first-token rule, is now a C4b entry condition.
4. **Product prerequisite, independent of consults:** the built-in server moves to `--batch-size 64 --ubatch-size 64`, delivered as its own pull request. It also benefits the tier sniffer (§A.7).
5. **Writer prompt:** 5 of 6 distinct inputs gave usable questions; the sixth named a place only the answer implied. A rule against that, and an eval case, are C4b tasks (§A.7).
6. **Stage table updated** (§A.14): M0 done; C4a entry condition satisfied; C4b entry conditions rewritten.
7. **Owner decisions of 2026-10-07 moved from open to decided** (§10): the fork, AD-1 and AD-2, the 640 px cap, the M0 tolerance, the public privacy sentence, fence recovery as a button.

## Changes in revision 7 (since revision 6)

1. **M0 has an exact decision rule** (§A.7): measured from a fresh request's arrival to first reveal, abort delay included, paired against a control. Results drop into a fixed table.
2. **One authoritative panel payload contract,** enforced before first reveal on every install. A total serializer and an exact-size padder replace the "cannot happen" proof (§A.5.1).
3. **Two collection phases:** today's fast initial acquisition, then a uniform encrypted follow-up from first delivery. A capability handshake is sent by every new panel, and paid dispatch requires it (§A.5.2).
4. **Retained first-answer payload** with terminal withdrawal, race rules and stable source-open tokens (§A.5.3).
5. **Expiry and eviction no longer depend on whether a consult was sent;** the timing claim is narrowed to what a test will show (§A.5.4).
6. **Fixed reported geometry** by a numeric rule, kept after follow-up ends and on reopen (§A.5.5).
7. **The outside text has its own container** outside the "Private answer from your Mac" card, with attribution that stays put, a line policy and hostile-text tests (§A.6).
8. **The transport session is a one-shot state machine** with a cancellable `open` and final authorization inside dispatch (§A.8).
9. **One server-owned follow-up clock;** the enable wording covers the real five-minute dispatch window (§A.5.6, §A.10).
10. **Frozen eval numbers,** and corrected public privacy wording (§2, §A.13).
11. **AD-1 recorded with its four conditions; AD-2 added** for panel-protocol compatibility (§A.11).
12. **Build plan:** C3 is the internal settings mechanism only; the enable path lands in C5; the public CLI enable command comes later; the transport is re-measured after C2; the fork does not block an experimental release (§A.14).

## Terms (defined once)

- **Private** = tier S4 = trust domain `secure_local`.
- **Panel** = the private answer panel in ChatGPT. It collects an answer from the owner's Mac through the relay, encrypted to a key only the panel holds.
- **Seal** = encrypt to the panel's key. **Envelope** = one sealed response body.
- **First answer** = the answer the on-device model writes from Private items, exactly as today.
- **First delivery** = the moment the engine first returns a `ready` response to the claiming key. The server records it.
- **Consult** = one outbound request with up to three short general sub-questions, written on-device.
- **Writer** = the on-device model call that proposes the consult; the only extra model call.
- **Gate** = the outbound check: a pure function that refuses defined kinds of copying and identifiers.
- **Outside block** = the bounded reply, shown in its own container, labelled as not from the owner's documents.
- **Fence** = the zkAPI ledger mark that a paid request has not yet been seen to settle; while it is held, no consult starts.
- **Job policy** = the outside-help setting, lifetime and follow-up window bound to a job when it is created. Later setting changes do not alter it.

---

## 1. Owner direction (settled)

- The ChatGPT private answer panel is the product path.
- Consults are automatic once a route is set up. Approval prompts exist only in an opt-in strict mode.
- Exactly one pre-send check: the mechanical gate. A refusal means no consult, silently.
- Fast and secure together: the first answer appears as fast as today. §A.7 defines how that is measured.
- No spending cap by default; costs stated up front.
- Vocabulary packs per configured language; Brazilian Portuguese ships; all ten packs ship.
- zkAPI is experimental and labelled "route not verified" on macOS until route verification passes. The upstream issue is not being posted for now.
- Version one: no rewrite pass (append a separate block); no searchable consult records; one route; fence recovery is a button, never automatic; enable only from the Mac; consult only when the first answer is marked insufficient or has gaps.
- Standing: tiers are the product; the relay is an accepted central point; the zkAPI path follows the reference practice.

## 2. Position against the release plan

- The active plan is **Olympus 1.0 (ChatGPT)** (`docs/V0_4_RELEASE.md`). This feature is **not in 1.0**; it is a candidate for the release after. Its first build pull request adds it to "Deferred to after 1.0" with a dated owner decision.
- No versioned contract changes (§A.11).
- **Public privacy wording when it ships** (README and the enable flow): "Olympus does not upload the evidence pack. With outside help enabled, it may send a short question derived from your private answer; that question can still reveal private information." This replaces the earlier proposal "the evidence never does", which implied more than the gate guarantees.

## 3. Current state (verified on `main` at `bb1755fb`)

- **Panel path:**
  - A ChatGPT search that matches Private items creates a one-time job, and the model answers in the background.
  - The panel claims and collects the sealed answer, then stops polling.
  - Each job has one sealed outcome, lives 10 minutes, and is never persisted.
  - The jobs boundary accepts up to 65,536 answer characters, 20 citations and 10 gaps, padded into growing buckets.
- **zkAPI transport,** dormant:
  - It runs one consult at a time and returns only after settlement and teardown.
  - It reserves money and sets the fence *before* its last ownership check, so a check failing there leaves an unsent request fenced (`consult-transport-zkapi.ts:1805–1822`).
- **Gate,** on branch `claude/consult-outbound-gate`: uncalled, with ten shipped packs and `eval/consult-leak`.
- **No consult settings** exist on the ChatGPT product.

---

## Track A — consult on the panel

### A.1 Outcome

**A user opens a private answer in ChatGPT and sees it as fast as today.** When the answer is incomplete and outside help is on, a separate box under the answer may fill a few minutes later. The box is headed "Outside background — not from your documents". The first answer and its sources never change.

**What leaves the Mac:** only the bounded question that passed the gate, through zkAPI.

**Limits:**

- The question is derived from Private material and can still reveal private information (§A.4).
- The outside provider reads the question. zkAPI hides who paid. On macOS the network route is not verified (§Z.4).
- ChatGPT and the relay may infer that outside help ran on a question (timing, size changes, polling), never what was asked or answered (§A.5.5).

### A.2 Flow

```text
search → job (policy bound) → first answer (unchanged) → panel claims → first delivery   [as today]
   │
   └ job policy has outside help on, panel declared capability 2, answer marked insufficient
     or has gaps, not "these items do not answer"?                         no → done
       │ yes
       ├ zkAPI session open (cancellable, nothing reserved)  ┐ in parallel
       ├ writer (on-device, scheduled per M0)                ┘
       ├ dispatch: transport's own async checks → final authorization
       │   (settings revision, recent panel activity, deadlines, latch, eligibility, gate)
       │   → reservation and fetch, synchronously                        any no → cancel; nothing paid
       ├ reply → bounded plain text → appended to the job (revision +1)
       └ settlement and teardown in the background
```

- **Only claimed jobs consult.**
- **The trigger uses explicit internal metadata:** the model's `sufficient` verdict and a no-answer flag, carried from the model to the jobs engine. Neither enters the plaintext.

### A.3 The writer and its snapshot

**Decision: one writer call after first delivery; no rewrite.** *Rejected: a question field in the first answer's output, because it lengthens every answer.*

**Inputs and output:**

| | Bound |
|---|---|
| The user's question | ≤ 1,000 characters |
| The first answer | ≤ 2,700 characters |
| Its gaps | ≤ 4 × 300 characters |
| Whole prompt, writer rules included | ≤ 2,048 model tokens, counted with the server's tokenizer; over that, no consult |
| Output | JSON schema `{"consult": null \| [≤ 3 strings]}`, `max_tokens` 160 |
| Deadline | 60 s; the writer's own process is killed (§A.7). The answer server is never aborted, signalled or reset by the writer |

**Snapshot handoff:**

- **What it holds:** the exact evidence text the first answer's model call received (after relevance selection, depth reads and fitting), the question, the answer, its gaps, the verdict, and the identities of the items read.
- **Where it comes from:** the computation that produced the answer. A reused precompute brings its own search-time snapshot.
- **What the gate compares against:** the evidence as the pack, plus the question, answer and gaps exactly as the writer saw them, passed as `writerVisibleTexts`.
- **Retention:** in memory until the dispatch decision (at most 5 minutes after first delivery), then dropped. It is separate from the retained first-answer payload (§A.5.3).

**Speed (estimates, not measured):** at 3–6 tokens/s generation and 81–109 tokens/s prompt reading, about 25–45 s typical and 45–80 s at the bounds.

### A.4 The one check: the outbound gate

**Decision: the gate is the only pre-send check. What it guarantees is stated exactly.**

- **What leaves:** only the bounded, checked question. At most 3 sub-questions, ≤ 600 bytes, ≤ 80 lexical tokens, ≤ 12 content words each, and only words in the configured packs.
- **What it refuses:**
  - runs of 4 content tokens shared with the snapshot;
  - reordered copies;
  - names, figures and identifiers that appear in the snapshot;
  - repeats of a recent consult.
- **What it cannot guarantee: zero Private information.** Known gaps, each pinned by a test:
  - synonym paraphrase;
  - rare combinations of ordinary words;
  - a dictionary-word name in lower-case prose;
  - figures re-expressed by arithmetic;
  - covert channels in word choice.
- **The user's question is not owner-authored.** ChatGPT writes it as a tool argument (`mcp-surface.ts:305`). It is in the snapshot, so copying from it is refused, but it can carry pasted material or instructions.
- **Verdicts stay on the Mac.**
- **Packs load when outside help is turned on.** The gate runs after first delivery.

### A.5 Collection protocol

#### A.5.1 One panel payload contract, enforced before first reveal

**Decision: tighten the jobs boundary to what the model layer produces today, on every install, and prove one envelope size for it.**

The contract, enforced at the jobs boundary before first delivery:

| Field | Limit (after normalization) | Old limit at the jobs boundary | Most the model layer produces today |
|---|---|---|---|
| `answer` | ≤ 2,700 UTF-16 units | 65,536 | 2,700 (full detail; summary 1,000) |
| `citations` | ≤ 4 | 20 | 4 (the panel reads at most 4 items) |
| `title`, `source` | ≤ 300 units each | 300 | — |
| `date` | ≤ 32 units | 32 | — |
| web URL | ≤ 2,048 characters, the normalized `https` form (ASCII) | 2,048 | — |
| Mac open token | 43 characters | 43 | — |
| `unanswered` | ≤ 4 × 300 units | 10 × 300 | 3 model gaps + 1 unreadable note |

**Nothing the product shows today is cut** under the shipped defaults; no production caller overrides the panel limits. A model limit configured above the contract is clamped to it.

**Total serializer** (no "cannot happen" branches):

1. Replace lone surrogates with U+FFFD, strip control and bidirectional-override characters, and normalize each URL through `new URL().href` (non-`https` dropped).
2. Apply the limits above.
3. Serialize with `JSON.stringify`, then measure UTF-8 bytes.
4. If any field still exceeds its byte budget (below), cut text fields at a code-point boundary with "…" included in the budget, and drop trailing list entries.

The outside text follows the same rule and sets `cut: true`.

**Byte budgets (serialized):**

| Part | Budget | Why it fits |
|---|---|---|
| answer | 8,192 B | 2,700 units × ≤ 3 B + quotes |
| citations | 4 × 4,096 B | 300 + 300 units × 3 B, 32 × 3 B, 2,048 B URL, keys |
| gaps | 4 × 1,024 B | 300 units × 3 B + quotes |
| outside block | 6,144 B | text 4,096 B, question 1,280 B, route label and state |
| scalars and skeleton | 512 B | `v`, `rev`, `state`, `followSeconds` |
| **Total** | **35,328 B** | |

**Exact-size padder:** the plaintext is padded to exactly **36,864 bytes (36 KiB of padded plaintext)**. A plaintext over that is rejected, never grown. The wire body is larger: 36,880 bytes of ciphertext, base64url-encoded in JSON, about 49.4 KB, well inside the relay's 8 MiB response limit.

A rejection after budgeting would be a bug, and fails closed:

- before first delivery: the job fails, as today;
- after first delivery: the outside block is dropped; if the envelope still does not fit, the job is withdrawn.

**Proof:** a fill test sets every field to its budget with multilingual text, quotes, backslashes, lone surrogates and maximum URLs. It asserts the exact plaintext size.

**Where the fixed size applies:** to jobs whose policy has outside help on and whose panel declared capability 2. Other jobs keep today's bucket padding; the tightened limits apply to every job.

#### A.5.2 Two phases and the capability handshake

**Phase 1, initial acquisition: today's behavior, unchanged.**

- The first key claims the job.
- Until first delivery: `202 pending` with `Retry-After: 2`, `429`, plaintext `200 failed`, `409 claimed`, `410 gone`.
- The panel polls every 2 seconds, as today. The first answer is never slowed by follow-up machinery.

**The transition is first delivery.** The engine records `firstDeliveredAt` when it returns the first `ready` to the claiming key.

**Phase 2, sealed follow-up**, for capability-2 panels on jobs with outside help on:

- Requests from the claiming key get `200 ready` with a freshly sealed 36 KiB envelope.
- Withdrawal is a state inside the envelope.
- The other responses are the same infrastructure and identity cases as today: `400` malformed key; `409` another key; `410` after the job's expiry or eviction (§A.5.4); `503` Mac offline or relay busy; `429` rate limit. The panel's 30-second cadence stays far below the limits, so `429` appears only under abuse.

**Envelope (plaintext version 1, extended):**

```text
{ v: 1, rev,                                           // rev only increases
  state: "answer" | "withdrawn",
  answer, citations, unanswered,                       // absent when withdrawn
  followSeconds,                                       // computed by the server (§A.5.6)
  outside: { state: "idle" | "pending" | "appended" | "paused",
             text?, cut?, question?, route? } }
```

`idle` covers nothing triggered, refused, skipped and failed alike, so the panel shows nothing new on failure. The envelope is a fixed size so the size bound is simple; hiding that a consult ran is not a goal (§A.5.5).

**Capability handshake:**

- Every new panel sends `"cap": 2` in **every** request body, unconditionally: in phase 1 and phase 2, whether outside help is on or off, and whatever any consult did.
- The engine records the capability at the claim.
- **Paid dispatch requires `cap: 2`.**

**Mixed versions.** The engine serves the panel's HTML (`private-answer-resource.ts`), so a mismatch arises only when the host caches an older widget.

| Panel | Engine | Behavior |
|---|---|---|
| Old (no `cap`) | New | Exactly today's behavior, including bucket padding and plaintext `failed`. No consult is dispatched, so nothing is spent. |
| New (`cap: 2`) | Old | The old engine ignores `cap` (it reads only `v` and `publicKey`). Its response has no `followSeconds`, which the panel treats as 0: today's behavior. |

#### A.5.3 The retained first-answer payload

**Decision: a capability-2 job with outside help on keeps its first-answer plaintext from first delivery until the job ends.**

- **What is kept:** the serialized payload (≤ 35,328 B) and its source-open token map, in engine memory only. That is at most about 7 MB across the 200-job cap.
- **This is a retention change.** Today only sealed bytes are kept after the claim.
- **It applies only where needed.** Jobs with outside help off keep today's behavior: they hand out stored sealed bytes and keep no plaintext. Those jobs have no consult outcome to hide, so they do not need fresh sealing. That is the smaller exposure.

**State rules:**

- **Revisions only go up.** A reply is appended by a synchronous compare-and-set on `rev`, and only while the job is in state `answer`.
- **Withdrawal is terminal.** It clears the answer payload, outside text and question, the writer snapshot and the source-open tokens. A late reply is discarded. Nothing restores a withdrawn job.
- **Around asynchronous sealing:**
  1. Read `rev` and the state.
  2. Run the eligibility guard (`stillReleasable`).
  3. Seal.
  4. Re-read before handing out. If the job was withdrawn meanwhile, seal and return the withdrawn envelope instead. If `rev` advanced, re-seal once with the newer state.
- **Source-open tokens** are minted once, at the first seal, and are identical in every envelope.

#### A.5.4 Expiry, eviction and restart

- **Lifetime comes from the job's policy at creation:** 30 minutes with outside help on, 10 minutes off. Eviction at the 200-job cap stays oldest-first.
- **A reply for an evicted or expired job is discarded.** The money is spent and the loss is stated.
- **Restart:** an engine restart forgets every job, as today. The fence and the spent money remain.

#### A.5.5 Accepted residual: what ChatGPT and the relay may infer (owner ruling, 2026-10-07)

**Ruling:** making a consult undetectable to ChatGPT and the relay is not a goal of version one. **Content stays sealed:** the question, the outside text, the first answer and the source-open tokens are never visible to either. ChatGPT and the relay may infer that outside help ran on a question, from response timing, envelope-size changes, polling behavior, the panel's own height and layout changes, and the later appearance of the outside container; they may infer an outside-help setting that is on (§A.9). They never learn what was asked or answered. The versioned design's earlier mechanisms for hiding presence are removed: the locked reported height and 640 px cap, the reserved strip, geometry persistence, the response-time floor, withdrawn-polling parity, outcome-independent eviction rules and the host-transcript-equality proofs. The fixed 36 KiB envelope stays as a simple size bound, not as a hiding device. The public wording (§2, §A.10) already says the question can reveal private information; it does not claim the consult is hidden.

#### A.5.6 Clocks and liveness

- **Follow-up clock:** `followUntil = min(firstDeliveredAt + 20 min, job expiry)`. It is fixed at first delivery. `followSeconds` = time left, computed by the server. Remounts never extend it.
- **Dispatch window:** dispatch only if now ≤ `firstDeliveredAt + 5 min` **and** now + the configured completion timeout (`timeoutMs`, default 6 min) + 2 min ≤ `followUntil`.
- **Recent panel activity:** a collection by the claiming key within the last 75 s, checked inside final authorization.
- **Disclosed:** the relay can replay a captured request and keep this fresh for the whole five-minute dispatch window. The send-once latch still allows at most one consult per job. Replay-resistant liveness is deferred: the risk is bounded to one $6 consult for an answer the user's panel collected, and the enable wording says so (§A.10).
- **Send-once latch:** atomic per job, set inside final authorization.

### A.6 The outside block

**Decision: the reply is shown in its own container, below and outside the "Private answer from your Mac" card. No model reads it.**

**The container:**

- It is a separate box with its own heading, outside the first answer's title, Sources and gaps.
- Its attribution header is application-owned and stays pinned while the body scrolls: **"Outside background — not from your documents. General information from an outside model. It did not read your documents and has not been checked."**
- A collapsed "What Olympus asked" shows the question.
- When the reply was shortened, an application-owned footer says "Shortened by Olympus."

**Text policy:**

- The text is set with `textContent`.
- Markdown is shown as literal characters. Links are not clickable.
- Control, bidirectional-override and zero-width characters are stripped. Line endings are normalized.
- Runs of blank lines collapse to one.
- At most 40 lines. Each logical line is cut at 240 characters.
- At most 4,096 bytes, with "…" included.

**Required hostile-text tests (C4a):**

- a forged "Private answer from your Mac" heading;
- forged "Sources" and citation-like text ("[1]", "your documents confirm");
- instructions to copy an address or disclose information;
- long URLs;
- control and bidirectional characters;
- thousands of newlines.

Each test asserts that the attribution header stays visible and that only text nodes are created.

**Accepted residual risk:** a reply can still mislead a reader who ignores the attribution. No second model pass is added. The eval measures reader attribution (§A.13).

### A.7 Scheduling and the M0 rule

**Decision (2026-10-07): the writer is the lowest-priority work and runs on its own process (candidate B2), killed the moment a fresh answer arrives. M0 failed on the shared server; the rule below is unchanged and still the acceptance bar.**

**M0 measurement (frozen):**

- **Endpoint:** the time from a fresh request's arrival (job creation by a search) to its first reveal. In the harness, that is the claim returning `ready` with the panel claiming at once. **Abort delay is included.**
- **Also recorded:** when the server accepts the fresh request, time to first token, and every model reset with its cause.
- **Design:** paired, randomized trials on identical workloads. Each pair runs the same fresh request once with the writer active (treatment) and once without it (control), in random order. The writer uses the real prompt, tokenizer, schema and token bounds.
- **Phases:**
  - the fresh request arrives during writer prefill;
  - during writer generation;
  - near the writer's deadline (55–60 s);
  - while the writer hangs (it keeps the server busy and ignores the HTTP abort).
- **Samples:**
  - 30 pairs per phase on the summary detail;
  - 10 pairs for generation on full detail;
  - 30 control-versus-control pairs to measure the noise floor.
  - All on the owner's Mac with the 4B model.
- **Failures:** a fresh answer that fails or misses its deadline in treatment but not in control counts as infinite added delay.
- **Decision rule (owner default, flagged in §10):** pass if, in every phase,
  - the median added delay is ≤ 250 ms,
  - **and** the 95th percentile is ≤ 1 s,
  - **and** zero resets are caused by the writer.
  "Not slower at all" cannot be measured below run-to-run noise; the noise floor is reported beside the result.
- **What M0 cannot show:** whole-panel latency through the relay and ChatGPT; other Macs, models (2B, 9B) or memory pressure; the larger envelope's first-reveal cost. C4a measures that last one.

**Result: FAIL on the shared server.** Measured on 2026-10-05 (round 1) and 2026-10-07 (round 2); full tables, method and reproduction commands are in `docs/design/consult-m0-measurement.md` and `scripts/measure-consult-writer-isolation.ts` on `claude/consult-m0` (base `main` at `bc1cd078`).

- **Machine:** Apple M3, 24 GB, macOS 26.5.2, Qwen3.5 4B Q4_K_M, llama.cpp `b11320` (Metal), our own server through the product launcher with the product's exact flags. **Load was not quiet:** 1-minute load average 2–9 at pair start (a spike to 59 in one discarded screening run), memory pressure "warn", about 6.7 GB of other processes' swap in use, other sessions running.
- **Noise floor:** control against control, first token: median 0.5 s, p95 3.3 s in round 1 (n = 37); 0.2–2.6 s median across round 2 candidates (A64 2.6 s / 6.4 s, B2 pooled 1.9 s / 2.0 s). This is larger than the 250 ms tolerance, so the tolerance cannot be confirmed or refuted from first-token figures on this machine. "Server took it" (the delay until the server started the fresh request; control about 12 ms) is the clean signal.
- **Not run:** the 2B model (not on disk); the 9B model; an idle machine; the real writer prompt (a 2,039-token stand-in); whole-panel latency; the cold-start case (a writer server starting while a fresh answer arrives); candidate A with `--cache-ram` in pairs; samples of n = 30 (round 1 used n = 5 per abort phase and 3 per queue phase; round 2 n = 3–6 per phase and 21–28 pooled); the full-detail generation phase.

**Causes (round 1, measured separately):**

1. **An abort takes effect only at the end of the current prefill batch** (the product default is 2,048 tokens). During generation a step is one token (about 0.1 s) and the slot frees in about 0.2 s; during prompt reading the fresh answer waited 0.2–8.0 s (about 7 s when it arrived just after the writer started).
2. **Any writer call evicts the cached analyst system prompt** (311 tokens). The next fresh answer re-reads it: +3.25 s median first token, about the same as a full model reset (+3.26 s), even when nothing overlapped.

The writer never caused a model reset.

**Results table (§A.7 rule: median ≤ 250 ms, p95 ≤ 1 s, zero writer-caused resets, in every phase).** Added first token and "server took it" in ms, median / p95. Round 1 is the product configuration with the writer aborted as the jobs engine aborts work:

| Phase (round 1, product config, abort) | n | Added first token | Server took it | Resets | Pass |
|---|---|---|---|---|---|
| Just started (0.2 s in) | 5 | 10,448 / 12,823 | 7,270 / 8,010 | 0 | No |
| Prefill | 5 | 7,263 / 10,803 | 2,175 / 3,291 | 0 | No |
| Generation (summary) | 5 | 3,845 / 4,872 | 173 / 216 | 0 | No |
| Near deadline (85% of output) | 5 | 3,244 / 5,060 | 770 / 849 | 0 | No |
| Hung writer (20 s stand-in) | 5 | 2,644 / 5,200 | 249 / 1,010 | 0 | No |
| **All phases, pooled** | 25 | **5,115 / 11,322** | — | 0 | **No** |
| Noise floor (control vs control) | 37 | 473 / 3,286 | — | — | — |

Round 2 candidates (all with the writer's own prompt unless "shared prefix"; n pooled over five phases except where noted):

| Candidate | n | Added first token | Server took it (worst phase) | Memory | Verdict |
|---|---|---|---|---|---|
| A: one server, shared analyst prefix, batch 64 | 28 | 763 / 5,439 | 1.0 s (prefill) | 0 | **Fail.** Cache kept in 28/28; abort waits for a batch |
| A32: same, batch 32 | 9 (3 phases) | 311 / 963 | 0.6 s (prefill) | 0 | **Fail** (screening); about +7.5% on ordinary answers |
| B: second server, default batch, killed | 20 | 572 / 6,478 | 8 ms | +0.6 GB | **Fail in prefill** (+5.1 s median; GPU work already queued by the killed process) |
| **B2: second server, batch 64, killed** | 21 | **142 / 2,459** | **14 ms** (every phase 1–14 ms) | **+0.6 GB** | **Passes the server measure; first-token unproven** (inside noise; one +7.7 s prefill pair while the machine swapped) |
| C: `--parallel 2`, batch 64 | 9 (3 phases) | 801 / 5,970 | 0.9 s | +0.5 GB | **Fail** (screening) |

B2 by phase (first run plus extension, n = 21): just started 429 / 1,556 (n = 4); prefill 223 / 6,607 (4); generation −568 / 1,080 (5); near end 142 / 2,213 (5); hung (60 s deadline) 95 / 481 (3). The "near end" excess (+1.0 s in B, +1.2 s in B2) is the one pattern that repeats and needs the larger sample. Not every B2 phase meets the rule on first token at these sample sizes; the server measure passes in all.

**Scheduling decision (candidate B2):**

- The writer runs on its **own `llama-server` process**: same model file (mapped, so the weights are shared), `--batch-size 64 --ubatch-size 64`, its own system prompt, streamed.
- It is **started on demand** (about 1.0–1.3 s with the file in page cache) or **kept warm when memory allows**.
- It is **killed (SIGKILL), not aborted,** the moment a fresh answer arrives or at the writer's deadline. The answer server is never touched and never reset, so its cached analyst prompt survives and a hung writer needs no model reset.
- **Memory rule:** start the writer server only if free memory stays at or above 20% after its footprint (about 0.6 GB physical; 0.8 GB of the 24 GB was observed) and there is no swap pressure. Otherwise **skip the consult for that answer.** No consult is always acceptable.
- **Status, stated plainly: it passes the server measure; first-token is unproven on a quiet machine.** The quiet-machine rerun (load below 3, n ≥ 20 per phase, 30 control pairs; the hung phase alone takes about 20 minutes at n = 20) is a **C4b entry condition**, and the stricter first-token rule above remains the acceptance bar. If it fails there, §A.7's fallbacks below return to the owner.
- **Rejected:** **A** (one server, shared prefix, batch 32 or 64) misses by 0.3–1.0 s during the writer's first seconds because an abort lands between batches. **C** (`--parallel 2`) has the same abort limit, 0.5 GB of extra context memory and cache cross-talk between slots.

**Prerequisite, independent of consults: the built-in server moves to `--batch-size 64 --ubatch-size 64`.** Measured: abort-to-next-start about 6 s → about 0.2 s, no measured penalty on an ordinary answer on the 4B model (the 2B is unmeasured). It benefits any aborted job, including the tier sniffer yielding to an answer. It ships as its own pull request. `--cache-ram` is rejected: it did nothing for aborts and costs up to 256 MB.

**Writer prompt (C4b task, and an eval case).** With the shared-prefix variant, 5 of 6 distinct inputs gave usable question sets; the sixth named a place ("Portugal") that the answer never states but the itinerary implies. The gate's snapshot includes the first answer's text, but the writer instructions also need a rule against naming places or entities that are only implied by the answer. A planted implied-place case is added to the writer eval (§A.13).

**If B2 fails the quiet-machine rerun, the owner chooses among:**

1. Run the writer only after the queue has been idle for N seconds (a hypothesis to test, not proven isolation: a fresh request can arrive just after the writer starts).
2. A smaller writer prompt.
3. A changed requirement.

**Eligibility sites:**

| # | Where | On failure |
|---|---|---|
| E1 | Immediately before the writer call | no consult; snapshot dropped |
| E2 | Inside final authorization (§A.8) | no dispatch; nothing reserved |
| E3 | Every phase-2 hand-out | terminal withdrawal |
| E4 | Every Mac source-open | 410 |

Web sources open through the host, outside E4.

**Residual:** owner tier rules ("always Secret" and similar) take effect at the classification sweep, not at the live check (`analyst-answer.ts:2724–2727`).

### A.8 The zkAPI session

**Decision: a one-shot session state machine. `open` can be cancelled and has a deadline. Final authorization runs inside dispatch, immediately before a synchronous reservation and fetch.**

```text
open({signal, deadline})          → opening → ready      (lease held; Tor, daemon and policy warm-up)
   cancel / deadline in opening    → cancelled            (processes stopped, lease released)
dispatch(authorize)                → ready → authorizing → dispatched → replied → finished
   1. transport's async checks: listener ownership, policy listed, allowance
   2. authorize(): final settings revision, recent activity, deadlines, latch, eligibility (async), gate
   3. if authorize says no                              → cancelled (nothing reserved)
   4. reserve + set fence + start fetch, synchronously → dispatched
cancel() in ready or authorizing                         → cancelled (nothing reserved)
cancel() after dispatched                                → ignored; session-owned cleanup continues
```

- **One-shot:** `dispatch` may be called once. A second call, or a call after cancellation, is refused.
- **Cancel and send race:** whichever reaches step 4 first wins.
- **After dispatch, the caller's signals are detached.** Only cancellations the session owns remain: a process exiting, or the configured completion timeout.
- **Proven pre-dispatch failure after reservation** (the fetch never left the process): roll back the reservation, the count and the fence, and record a lifecycle receipt.
- **Uncertain dispatch:** the fence is kept.
- **Today's ordering problem** (reserve, then an awaited ownership check) is removed by moving every awaited transport check into step 1.
- **Outcomes:** `reply` arrives as soon as the completion does; its receipt says settlement, teardown and the post-stop route check are pending. `finished` reports them, and the lease is released there.
- **Abandon and Recover:** both are buttons in the Mac dashboard, never automatic.
  - **Recover** sends a fixed "OK" request and reserves up to $6.
  - **Abandon's** confirmation states that the unsettled request may later settle under another session's network identity, linking the two.

**C2 proofs:**

- After cancellation in `opening`, `ready` or `authorizing`, and after a refused authorization, **no paid reservation, request count or fence remains**. Lifecycle receipts of supervised processes are allowed.
- After dispatch, a caller cancel neither aborts the fetch nor discards the reply.
- A second `open` is busy.

**Measured speed (M1, 2026-10-07).** Source: `docs/design/consult-m1-measurement.md` on `main`. Ten real consults through today's transport, one at a time, owner-funded, quiet M3 Mac, zkapi-clientd 0.1.6, Tor 0.4.9.13, `openai/gpt-5-mini`, short questions. All ten succeeded, fence clear after each, $6 reserved each.

- **Total:** median 96.8 s, range 70–179 s (the design's earlier reference was 3–4.5 min).
- **Before the reply: median 74 s** (max 156 s). Tor bootstrap 14 s median (8–104 s; three of ten over 28 s); policy warm 11 s median (p95 66 s, the daemon's own model-list polling); dispatch to first byte 32 s (the outside model's answer over Tor); confinement self-test 3 s.
- **After the reply: 22 s median** (max 42 s) of settlement and teardown.
- **Not measured:** writer time, the approval or panel path before a send, a loaded machine, longer questions, and any C2 change.

**Speed measures, in priority order:**

1. **Hand the reply off at completion, before settlement: about −22 s.** Nothing the reader needs depends on settlement or teardown. This is the `reply` / `finished` split above.
2. **Warm Tor and the daemon while the writer runs: about −30 s.** Self-test, Tor, daemon ready, verification and policy warm (about 28 s median) do not depend on the question. `open` overlaps them with the writer.
3. **A seeded Tor directory cache** to cut bootstrap variance (8–104 s). Not yet tested; to be measured.

Policy warm time is the daemon's own behavior; it is raised upstream, not worked around. **After C2, the stages C2 changes are re-measured live;** further speed work (C7) waits for those numbers.

**Setup requirement.** Run `zkapi-clientd config --key-reuse-window-seconds 0` before any consult. The daemon's default 60 s key-reuse window is linkable, so Olympus refuses to send (`key_reuse_on`); the first M1 attempt was refused for this reason.

**Enable-flow lesson.** Funding must be one "send" in total, including the fee buffer, because every extra transaction is another visible step. The enable flow warns that gas prices move, so the buffer can fall short.

### A.9 Settings

- **Location:** `~/.olympus/consult.json`: `{v, revision, enabled, languages, domains, strict}`.
- **Writes:** compare-and-swap on `revision`.
- **Reads:** each job binds the revision current at its creation. Final authorization re-reads the file and refuses if outside help was turned off.
- **No worker restart** when it changes.
- **Changed only on the Mac.** C3 builds the internal mechanism. The Mac dashboard enable path lands in C5. A public `olympus consult on` command comes later and must show the same acknowledgements.
- **Never from ChatGPT, an agent tool or the relay.** The reason is that a hosted agent must not switch on egress. The relay and ChatGPT can still infer the setting (§A.5).
- **Strict mode** (C6) adds an approval step in the Mac dashboard, checked inside final authorization.

### A.10 Costs and disclosure, up front

On the enable sheet:

- "Olympus does not upload the evidence pack. With outside help enabled, it may send a short question derived from your private answer; that question can still reveal private information."
- "When a private answer shown in ChatGPT is incomplete, Olympus may automatically send one outside question for it, within about five minutes of the answer appearing. Each can cost up to $6 from your zkAPI balance; Olympus counts the full $6."
- "A question is sent only if the panel was recently active, but closing the panel does not guarantee nothing is sent in that window."
- "There is no daily limit unless you set one. Your deposit is the hard limit."
- Deposit and withdrawal fees, the 30-day expiry and operator risk (§Z.2).

### A.11 Architecture decisions for review

**AD-1: the outside block is panel presentation, not an `Analyst` change.** The first answer comes from `Analyst.analyze` exactly as today. The reviewer accepted this within a bounded interpretation. It holds only while all four conditions hold:

1. The outside block never becomes a corrected document answer.
2. It never clears or edits the first answer's gaps.
3. It never gains document citations.
4. It never feeds future reasoning, retrieval or storage.

Any departure enters the contract-change process: version and fingerprint, compatibility note, contract tests, held-out eval, critical review. This interpretation is recorded in `docs/CONTRACTS.md` by the C4a pull request.

**AD-2: the panel protocol changes and needs its own compatibility record.**

- **What changes:**
  - plaintext version 1 gains `rev`, `state`, `followSeconds` and `outside`;
  - phase 2 replaces plaintext `failed` with an encrypted withdrawal for capability-2 panels;
  - requests carry `cap`;
  - the jobs boundary limits tighten.
- **Compatibility:** as in §A.5.2.
- **Ruling, 2026-10-07:** the protocol does not try to hide that a consult ran; content stays sealed (§A.5.5).
- **Where it is recorded:** in `private-answer-contract.ts` and `docs/design/chatgpt-plugin.md`, by C4a.
- **The relay is unchanged:** it forwards bodies unread.

### A.12 Records

No consult text is stored beyond the job's lifetime. Only content-free operational receipts are kept: stage times, outcome codes, dollars reserved, fence state.

### A.13 Eval, frozen

**Required and blocking.** All must pass before C5 ships:

| # | Test | Population | Pass |
|---|---|---|---|
| B1 | Planted identifiers in the classes the gate claims: email addresses, URLs, phone and account numbers, exact dates, capitalized names, digit figures, provenance values | 1,000 writer outputs from the real writer on synthetic corpora with planted identifiers and adversarial user questions (500 English, 500 Brazilian Portuguese) | 0 leaks |
| B2 | Serializer and padder fill tests | Every field at its budget; the multilingual, escape and surrogate cases | 100% exact size |
| B3 | Withdrawal and re-check races (§A.5.3): post-seal re-check, withdrawal wins, late reply discarded | Each race × 10 | 100% |
| B4 | Hostile-text rendering (§A.6) | 50 crafted replies | 100% (attribution visible, text nodes only) |
| B5 | No dispatch for old panels, stale settings, expired windows or a set latch | Each case × 10 | 100% |
| B6 | C2 cancellation proofs (§A.8) | Each state × 10 | 100% |

**Known-limit measurements.** Reported here; thresholds apply only to default-on:

| # | Measure | Population | Threshold for default-on |
|---|---|---|---|
| K1 | Leak rate for the gate's known gaps (dictionary-word names, paraphrase, arithmetic) | 300 targeted cases | reported, none |
| K2 | Inference of a planted sensitive attribute by a model attacker who knows the account | 200 cases | ≤ 10 points above the attacker's no-question baseline |
| K3 | False refusals on benign incomplete answers | 300 | ≤ 30% |
| K4 | Usefulness: blind ratings of helpful / neutral / misleading on incomplete first answers | 100 (60 English, 40 Brazilian Portuguese) | helpful ≥ 40%, misleading ≤ 5% |
| K5 | Reader attribution: is the outside block correctly identified as not from your documents? Does anyone follow a planted instruction? | 5 testers × 10 panels, including forged-heading replies | ≥ 95% correct attribution; no tester follows a planted instruction |
| K6 | End-to-end time from first delivery to an appended block | All C5 acceptance runs | reported, none |

The held-out eval (`eval/`) runs wherever shared answer code changes.

### A.14 Build plan and entry conditions

**Review convention (owner ruling, 2026-10-07): at most two review rounds per PR.** A third round happens only for a money or data-loss blocker; other findings become follow-ups.

**Smallest usable version: M0, M1, C1–C5.** It ships as experimental with the label "route not verified". "Critical (path)" means `config/change-risk.json` classifies it that way. "Critical (declared)" means egress or trust routing, declared critical.

| # | Delivers | Entry conditions | Proof | Risk |
|---|---|---|---|---|
| **M0** | Writer-contention measurement (§A.7) | **Done 2026-10-07.** Failed on the shared server; B2 chosen | Results table filled (§A.7) | Standard |
| **M1** | Stage timers in the transport receipt; ten live consults | **Done 2026-10-07.** Ten live consults, all ok; median total 96.8 s (§A.8) | Per-stage median and worst case recorded | Critical (declared) |
| C1 | Gate and packs on `main`; doctor line; 20 pack files listed one by one in `V0_4_PUBLIC_PACKAGE_FILES`; writer rules updated for automatic mode | None | Gate tests; `eval/consult-leak`; public-surface guard; packaged-path fixture; gate timing | Critical (path: `public-surface.ts`) |
| C2 | Transport session state machine (§A.8) | **Satisfied:** M1 baseline recorded. **In progress** | B6; then the C2-affected stages re-measured live (owner-gated) | Critical (declared) |
| C3 | Internal settings mechanism (`consult.json`, compare-and-swap, per-job binding). No public enable command | None | Settings tests; nothing reachable from MCP, setup tools or the relay | Critical (declared) |
| C4a | Payload contract, serializer, padder, two phases, capability handshake, retained payload, withdrawal and race rules, outside container, AD-1 and AD-2 records | **Satisfied:** M0 result recorded and scheduling choice (B2) stated in §A.7 | B2, B3, B4; first-reveal cost of the 36 KiB envelope compared with today; design receipt; owner visual acceptance | Critical (declared); design-receipt guarded |
| C4b | Writer scheduling per M0 (own server, kill on arrival, memory rule); writer rule against implied places; snapshot handoff; verdict metadata; token-bounded prompt; E1–E2; clocks and latch | C2 and C4a merged; **batch-64 product pull request merged**; **quiet-machine B2 rerun passing the first-token rule** (§A.7); **memory-rule tests** (writer server refused under 20% free memory or swap pressure) | M0 harness re-run against the real scheduler; B5; precompute-reuse snapshot test; held-out eval; implied-place writer eval case | Critical (declared) |
| C5 | First usable version: wiring to zkAPI; the Mac dashboard **Outside help** card (disclosure, cost sheet, languages, Recover and Abandon); end-to-end acceptance | C1–C4b merged; B1–B6 green; owner-funded daemon | One real consult end to end; K1–K6 reported; owner review before default-on | Critical (declared); design-receipt guarded |
| C6 | Strict mode | C5 | Approval binding tests | Critical (declared) |
| C7 | Speed changes chosen from the post-C2 measurements | C2 re-measurement | Stage timers before and after | Critical (declared) |
| C8 | Public `olympus consult` enable command with the acknowledgements | C5 | CLI tests | Critical (path: `src/cli.ts`) |
| F1, F2 | Daemon fork (§Z.4) | Owner decision. **Does not block C5**; required only for the stronger label | §Z.4 prerequisites | Critical (declared) |
| Later | OpenClaw path; rewrite; searchable records; Venice route | Own proposals | — | Critical |

The panel and the Mac dashboard are inside the dashboard design-receipt guard (`config/dashboard-design-review.json`, path `src/workers/dashboard`). The packs add about 11.2 MB to the package.

---

## Track Z — zkAPI

### Z.1 What it is

- zkAPI lets a user deposit ETH and make model requests that the payment side cannot tie to the deposit, through a local daemon, `zkapi-clientd`.
- OpenRouter and the model read the prompts.
- Spending is sequential, and the anonymity set was about 70 notes at review.
- It is used only as the consult transport, under the reference practice (`tor-remote-research.md`, ethereum/zkapi PR #16):
  - an on-device writer and the gate;
  - key reuse verified off;
  - throwaway Tor per consult;
  - never resent another way;
  - one consult at a time.

### Z.2 The money

| Cost or risk | What happens |
|---|---|
| Deposit fee | Expensive on-chain transaction (median about $7 at review) |
| Withdrawal fee | A second one, needing more ETH for gas |
| 30-day expiry | Unwithdrawn balance becomes claimable by the operator |
| No top-up | Each deposit is a new note with its own fee and clock |
| Operator risk | One account can pause deposits and withdrawals; single-party proof setup |
| Local risk | The balance is controlled by files on this computer |
| Per consult | Up to $6 reserved |

### Z.3 Shipped in Z1 (#144), and open

**Shipped, dormant:**

- a consult-only profile;
- acknowledgements (version 3);
- an expiry estimate;
- optional daily caps;
- the lease and the fence;
- daemon identity and inference-key checks;
- key reuse verified from the daemon's log;
- throwaway Tor and a macOS sandbox self-test;
- never retried;
- no fund movement.

**Open:**

- no live fee, balance or on-chain expiry;
- daemon release integrity;
- latency (M1);
- route verification (§Z.4);
- the reserve-before-check ordering (§A.8).

### Z.4 Route verification: the daemon fork

**Decided 2026-10-07: F1 and F2 proceed.** The upstream issue is unposted. **The macOS label stays "route not verified" until F2 passes.** F1 and F2 do not block the experimental release (C5). Prototype: `~/Code/Claude/zkapi-fork/`.

**Problem:**

- The daemon reads its relay endpoint only from a configuration file that also holds the withdrawal-authorizing bridge token.
- Its companion uses a CONNECT proxy on a random loopback port, which a sandbox profile written before start cannot name.
- The wallet API port is fixed by the configuration's `client_url` (default `127.0.0.1:8790`), but a supervisor cannot read it without reading the token file.
- The sandbox must also allow the daemon's own API port, because the daemon's readiness check calls itself.

**The fork:**

- A Go-only patch against `ethereum/zkapi` `045b444`: 5 production files changed (+98/−8) and 3 new test files.
- Four opt-in `serve` flags: `--relay-url` (in memory), `--companion-proxy-listen` (exit if the bind fails), `--wallet-api-listen`, and `--require-managed-companion`.
- A `transport` block in `/admin/status`.
- No wallet or key code changed.
- Reproducible: about 5 s per build, 9.69 MB, identical across three builds.

**What the prototype recorded, no more** (`poc/run-poc.out`):

- It used a fake companion and a fake Tor, which refused the CONNECT. Inference authentication was off and key reuse was 60 s; Olympus refuses both.
- Under the profile, the daemon reached Ready and reported the requested ports.
- Probes:

  | Probe | Without the profile | Under it |
  |---|---|---|
  | Another live loopback port | connected | denied |
  | Unused loopback port | already refused | denied |
  | Non-loopback address | already timed out | denied |
  | DNS | resolved | failed |

- An occupied proxy port made the daemon exit. A profile missing the proxy port made the bind fail.

So the prototype proves a working network profile, not a privacy-qualified session.

**What a passing F2 would let the label say:** "network confined by the operating system to this session's Tor listener".

- **Proved:** only the four named loopback ports are reachable, and only the SOCKS port leads off the machine.
- **Known only because Olympus started it:** that the SOCKS listener is Tor.
- **Not proved:** unlinkability, correlation resistance, or anything about other users.
- **Limits:**
  - one profile covers the whole process tree;
  - Seatbelt names hosts only as `localhost` or `*`;
  - `sandbox-exec` is deprecated;
  - the patched Go binary handles the bridge token, so it sits inside the credential trust boundary;
  - reproducible builds show reproducibility, not provenance.

**F2 prerequisites:**

1. Authenticated ownership of the managed wallet listener before the first token-bearing readiness request, through a child startup handshake or a daemon-side equivalent. A "port free" check is not enough.
2. The real pinned companion, with required inference authentication and key reuse 0.
3. Probes for Unix sockets, UDP and DNS, both loopback address families, and listener replacement.
4. A whole-bundle pin, verified at download and at every start.
5. Licence notices: MIT, upstream's third-party notices, a modified-source statement, and the LGPL-3.0 go-ethereum notice.

**F1 pipeline:**

1. Pin the tag and commit.
2. Apply the patch and run the tests.
3. Build with a pinned Go.
4. Check that two clean builds match.
5. Check the companion against upstream's manifest.
6. Add the notices.
7. Publish the hash.

**Delivery and upkeep:** downloaded on enable and pinned by hash. Signing and notarization are unchecked. Expect small rebases. If upstream ships equivalent flags, the fork retires.

**Rejected:**

- a `DYLD` interposer;
- a local forwarder;
- the "any loopback" rule;
- a Linux VM.

---

## Track B — Venice end-to-end encryption (later)

Venice's end-to-end encrypted models could become a Private lane Venice cannot read, and a fast consult route. It is acceptable only at full verification:

- client-side Intel quote verification;
- nonce and key binding;
- debug off;
- a pinned workload;
- positive proof that encryption is on;
- the reply bound to the request.

Questions are open with Venice. It needs its own proposal, and nothing in track A waits for it.

---

## 10. Owner decisions

**Decided on 2026-10-07 ("all approved"):**

1. **M0 tolerance:** median added delay ≤ 250 ms, 95th percentile ≤ 1 s, zero writer-caused resets (§A.7). The rule stays the acceptance bar for B2.
2. **Daemon fork** (§Z.4): F1 and F2 proceed. macOS stays "route not verified" until F2 passes; the experimental release does not wait.
3. **AD-1 and AD-2** (§A.11): accepted, with the bounded interpretation and the panel-protocol compatibility record.
4. **Capped panel height:** accepted on 2026-10-07, now moot: the cap is removed with the undetectability goal (§A.5.5).
5. **Public privacy sentence** (§2, §A.10): adopted as worded.
6. **Fence recovery** is a button, never automatic.

**Owner rulings, 2026-10-07 (later):** the undetectability goal is dropped from version one, with content kept sealed (§A.5.5); at most two review rounds per PR, a third only for a money or data-loss blocker (§A.14).

**Decided by the project anchor on 2026-10-07 (owner approved the M0 rule as stated):** the scheduling choice B2 and the batch-64 product prerequisite (§A.7).

**Still open:**

- **Quiet-machine rerun** (§A.7): when to run it, and whether a first-token failure there sends the choice back to the owner. Not an approval question until it has a result.
- **Owner-funded daemon** for M1 and C5 (§A.14).
- **Visual acceptance** of the panel and Mac card (C4a, C5).

Settled earlier and applied:

- enable from the Mac only;
- consult only on insufficient answers;
- ship all ten packs;
- no rewrite and no stored records in version one;
- payload limits tightened without cutting anything shown today.

## 11. Not proposed

- In version one: a rewrite pass, searchable consult records, or multiple routes.
- A consult queue.
- A self-check model call.
- Automatic fence recovery or abandonment.
- Any key that can move funds.
- Sending any `EvidencePack` to an outside model.
- A relay change.

## Appendix: code references (main at `bb1755fb` unless named)

**Jobs** — `src/workers/chatgpt/private-answer-jobs.ts`:

- `Job` type :270–295; limits :307–316; deadlines :322, :330;
- `begin` :462, eviction :486; `claim` :514–555; `stillReleasable` :597;
- queue :763–794; `run` :796; `startClaim` :893, seal and settle :1003–1011;
- `preparedAnswer` (the old limits) :1222–1258; `httpsUrl` :1265; handler :1298–1320 (reads only `v` and `publicKey`).

**Crypto** — `private-answer-crypto.ts`: bucket padder :70–82; seal :86–92 (fresh engine key per seal).

**Panel** — `src/workers/dashboard/chatgpt/private-answer.ts`:

- auto-collect :226; `readAnswer` :407–425; `collect` :476–580;
- web-source open :590–607; geometry and handshake :858–918; `max-height:none` :965.

**Copy** — `src/workers/dashboard/vocabulary.ts:1517–1521` (card title).

**Relay** — `connect-relay/server/relay.ts:697–729`; `limits.ts:157–160` (request 512 B; response 8 MiB).

**Model** — `src/workers/chatgpt/private-answer-model.ts`: limits :165–182 (at most 4 items); guarded call :300–314. Production construction: `src/workers/email-source/server.ts:4334` (no limits override).

**Analyst:**

- `src/core/analyst.ts`: schema :229–255 (≤ 6 citations, ≤ 3 gaps), `ANALYST_SCHEMA_MAX_GAPS` :259, `clampAnswer` :1186;
- `src/core/analyst-built-in.ts`: verdict :506–540.

**Eligibility residual** — `src/workers/source-index/analyst-answer.ts:2712–2730`.

**Transport** — `src/core/consult-transport-zkapi.ts`:

- Abandon :703; lease :1546–1559; ownership `owned()` :1729–1737;
- policy warm :1788–1803; reservation, then guard :1805–1822; dispatch :1823;
- late abort :1884; fetch abort :1975.

**Gate** (branch `claude/consult-outbound-gate`): `consult-gate.ts:42–64`; `test/consult-gate-review-3.test.ts:88–89`.

**Question argument** — `src/workers/chatgpt/mcp-surface.ts:305`.

**Contracts** — `docs/CONTRACTS.md:167–195, :306–315`; panel contract `private-answer-contract.ts:101–108`.

**Fork** — `~/Code/Claude/zkapi-fork/` (`README.md`, `poc/run-poc.out`, `poc/run-poc.sh:23–25`).

## Sources

- Review record: [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md)
- Reference request rules and Tor wrapper: <https://github.com/ethereum/zkapi/pull/16>
- zkAPI daemon privacy boundaries: <https://github.com/ethereum/zkapi/blob/main/zkapi-clientd/docs/PRIVACY.md>
- Introducing zkAPI, 2026-10-01: <https://blog.ethereum.org/2026/10/01/introducing-zkapi>
- Vitalik Buterin, self-sovereign LLM setup, 2026-04-02: <https://vitalik.eth.limo/general/2026/04/02/secure_llms.html>
