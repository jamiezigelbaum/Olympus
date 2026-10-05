# Design: frontier consult on the private answer panel, over zkAPI

Status: **proposal, revision 7 (2026-10-05).** Revision 6 was reviewed as "ready after listed changes": no further redesign, ten precision problems (P1–P10) and conditions on AD-1. All are applied here; dispositions are in [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md), section G. Nothing here changes shipped behavior or the release plan until the owner rules on §10.
Risk class: **Critical** (egress of Private-derived text; money).

## Changes since revision 6

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
- Timing can link the consult to the ChatGPT request.

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
| Deadline | 60 s, abort only; the writer never causes a model reset |

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

**Phase 2, uniform follow-up**, for capability-2 panels on jobs with outside help on:

- **Every** request from the claiming key gets `200 ready` with a freshly sealed 36 KiB envelope, whatever the consult did.
- Withdrawal is a state inside the envelope.
- The only other responses are infrastructure and identity exceptions, which do not depend on consult outcomes: `400` malformed key; `409` another key; `410` after the job's public expiry or eviction (§A.5.4); `503` Mac offline or relay busy; `429` rate limit. The panel's 30-second cadence stays far below the limits, so `429` appears only under abuse.

**Envelope (plaintext version 1, extended):**

```text
{ v: 1, rev,                                           // rev only increases
  state: "answer" | "withdrawn",
  answer, citations, unanswered,                       // absent when withdrawn
  followSeconds,                                       // computed by the server (§A.5.6)
  outside: { state: "idle" | "pending" | "appended" | "paused",
             text?, cut?, question?, route? } }
```

`idle` covers nothing triggered, refused, skipped and failed alike, so the panel cannot tell them apart and neither can anyone watching it. On failure the panel shows nothing new.

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

#### A.5.4 Expiry, eviction and timing

- **Public expiry and eviction are independent of consult outcomes.** The job's lifetime comes from its policy at creation: 30 minutes with outside help on, 10 minutes off. Eviction at the 200-job cap stays oldest-first, whatever happened.
- **A reply for an evicted or expired job is discarded.** There is no outcome-dependent protection. The money is spent and the loss is stated.
- **Restart:** an engine restart forgets every job, as today. The fence and the spent money remain.
- **Timing claim, narrowed:** responses in phase 2 have the same status and the same size. **Equal response timing is not claimed** until the C4a timing test compares latency distributions for idle, pending, appended, paused and withdrawn jobs. If they differ by more than the test's noise floor, the engine adds a fixed response-time floor, and the result is recorded here. Mac source-open requests stay observable, as today.

#### A.5.5 Fixed reported geometry

**Decision: lock the height the panel reports, not the reporting mechanism.**

**Rule,** for jobs with outside help on:

- `H = min(A + R, 640 px)`.
- `A` is the height of the first-answer card **alone**, measured at the current width. The outside container is excluded, so `A` never depends on a consult.
- `R` = 176 px, the outside container, which is always present and always the same height.
- If `A + R > 640`, the first-answer card scrolls inside `640 − R`.

**Notifications:**

- The existing initialize, resend, load and fallback messages, and the ResizeObserver path, keep firing. They always report `H` from the rule, never a measured total.
- A late `ui/initialize` therefore still gets `H`.
- A width change recomputes `A` from the first-answer card at the new width.
- Hide reports today's fixed hidden height; Show returns to `H`.
- **After follow-up ends, and on reopen, the same rule applies.** The outside container stays at `R` with its final content.
- **Residual:** after a withdrawal, a later width change measures the withdrawn card. The host could see that withdrawal, which plaintext `failed` already shows today.

**Host-transcript test (C4a)** covers these outcomes:

- outside block: idle (not triggered, refused, skipped, failed), pending, appended, paused;
- withdrawal;
- a delayed handshake;
- font loading;
- width change;
- hide and show;
- remount within and after the follow-up window;
- follow-up expiry.

It asserts identical host messages wherever the first answer and width are the same.

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

Each test asserts that the attribution header stays visible, that only text nodes are created, and that geometry is unchanged.

**Accepted residual risk:** a reply can still mislead a reader who ignores the attribution. No second model pass is added. The eval measures reader attribution (§A.13).

### A.7 Scheduling and the M0 rule

**Decision: the writer is the lowest-priority work. Whether and how it may run is set by M0, measured before any feature code.**

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

**Results (filled in by the M0 run):**

| Phase | Pairs | Median added | p95 added | Writer-caused resets | Noise floor (median, p95) | Pass |
|---|---|---|---|---|---|---|
| Prefill (summary) | 30 | — | — | — | — | — |
| Generation (summary) | 30 | — | — | — | — | — |
| Generation (full) | 10 | — | — | — | — | — |
| Near deadline | 30 | — | — | — | — | — |
| Hung writer | 30 | — | — | — | — | — |

**If M0 passes:** the writer runs as the lowest-priority queue item and is aborted when a fresh answer arrives.

**If it fails, the owner chooses among:**

1. Run the writer only after the queue has been idle for N seconds. This is a hypothesis to test, not proven isolation: a fresh request can arrive just after the writer starts.
2. A smaller writer prompt.
3. A separate lightweight writer process.
4. A changed requirement.

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

**Measurement:** M1 times today's transport. **After C2, the stages C2 changes are re-measured live:** warm-up overlapping the writer, and the reply released before settlement. Further speed work waits for those numbers.

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
| B3 | Host-transcript identity (§A.5.5) | Every listed outcome × 3 widths | 100% |
| B4 | Hostile-text rendering (§A.6) | 50 crafted replies | 100% (attribution visible, text nodes only, geometry unchanged) |
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

**Smallest usable version: M0, M1, C1–C5.** It ships as experimental with the label "route not verified". "Critical (path)" means `config/change-risk.json` classifies it that way. "Critical (declared)" means egress or trust routing, declared critical.

| # | Delivers | Entry conditions | Proof | Risk |
|---|---|---|---|---|
| **M0** | Writer-contention measurement (§A.7) | The rule in §A.7 (frozen); a draft writer prompt that fits the token bounds | Results table filled; pass or fail by the rule | Standard |
| **M1** | Stage timers in the transport receipt; ten live consults | Timers merged; **owner-funded daemon (owner-gated)** | Per-stage median and worst case recorded | Critical (declared) |
| C1 | Gate and packs on `main`; doctor line; 20 pack files listed one by one in `V0_4_PUBLIC_PACKAGE_FILES`; writer rules updated for automatic mode | None | Gate tests; `eval/consult-leak`; public-surface guard; packaged-path fixture; gate timing | Critical (path: `public-surface.ts`) |
| C2 | Transport session state machine (§A.8) | M1 baseline recorded | B6; then the C2-affected stages re-measured live (owner-gated) | Critical (declared) |
| C3 | Internal settings mechanism (`consult.json`, compare-and-swap, per-job binding). No public enable command | None | Settings tests; nothing reachable from MCP, setup tools or the relay | Critical (declared) |
| C4a | Payload contract, serializer, padder, two phases, capability handshake, retained payload, withdrawal and race rules, outcome-independent expiry, geometry, outside container, AD-1 and AD-2 records | M0 result recorded, and the scheduling choice it authorizes stated in §A.7 | B2, B3, B4; phase-2 timing test (§A.5.4); first-reveal cost of the 36 KiB envelope compared with today; design receipt; owner visual acceptance | Critical (declared); design-receipt guarded |
| C4b | Writer scheduling per M0; snapshot handoff; verdict metadata; token-bounded prompt; E1–E2; clocks and latch | M0 passed, or the owner chose a fallback; C2 and C4a merged | M0 harness re-run against the real scheduler; B5; precompute-reuse snapshot test; held-out eval | Critical (declared) |
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

**Recommended, AWAITING OWNER DECISION.** The upstream issue is unposted. **The macOS label stays "route not verified" until F2 passes.** F1 and F2 do not block the experimental release (C5). Prototype: `~/Code/Claude/zkapi-fork/`.

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

## 10. Decisions needed from the owner

1. **M0 tolerance.** The default recorded in §A.7: in every phase, median added delay ≤ 250 ms, 95th percentile ≤ 1 s, zero writer-caused resets. Your words were "not slower at all", which cannot be measured below run-to-run noise. Confirm this tolerance or set another.
2. **If M0 fails:** which fallback (§A.7).
3. **Public wording** (§2, §A.10): adopt the reviewer's sentence.
4. **Daemon fork** (§Z.4): approve F1 and F2. Without them, macOS stays "route not verified"; the experimental release does not wait.
5. **AD-1 and AD-2** (§A.11): accept the bounded interpretation and the panel-protocol compatibility record.
6. **Capped panel height** (§A.5.5): with outside help on, a first answer taller than 464 px scrolls inside a 640 px panel. It is a visible change for long answers.

Settled and applied:

- enable from the Mac only;
- fence recovery as a button;
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
