# Design: frontier consult on the private answer panel, over zkAPI

Status: **proposal, revision 6 (2026-10-05).** Rewritten after the adversarial review of revision 5 ("needs redesign", 19 findings; dispositions in [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md), section F). Awaits the next review. Nothing here changes shipped behavior or the release plan until the owner rules on §10.
Risk class: **Critical** (egress of Private-derived text; money). The architecture decision in §A.11 needs explicit review sign-off.

## Changes since revision 5

1. **No on-device rewrite in version one.** The first answer and its citations never change. If the consult returns, the panel appends a separate, labelled block of outside text (§A.6). The only extra model call is the writer.
2. **No searchable consult records.** Only content-free operational receipts are kept. The reply lives as long as the job (§A.12).
3. **One route, zkAPI,** behind a small interface. Venice end-to-end encryption is a later track, one paragraph (Track B).
4. **Collection protocol redesigned:** one uniform response after the claim, on every install, with every state (pending, appended, withdrawn) inside one fixed-size sealed envelope; explicit byte budgets; a fixed panel height during the follow-up period; an honest list of what the relay and ChatGPT can still see (§A.5).
5. **Gate guarantee stated as it really is** (§A.4).
6. **An immutable snapshot** of exactly what the first answer read is handed from the model to the jobs engine (§A.3).
7. **Dispatch order:** warm up first, then recheck everything, run the gate, and send with no further long wait (§A.7).
8. **One supervised transport session** with separate "reply" and "finished" outcomes, cancellation rules, and separate deadlines (§A.8).
9. **Measurement first:** stage M0 measures whether the writer can share the model without slowing a fresh answer; stage M1 times a real zkAPI consult. Feature code waits for M0 (§A.14).
10. **Fork claims narrowed** to what the prototype recorded; F2 prerequisites added (§Z.4). The fork still awaits owner decision.
11. **Build plan reordered and split;** milestone wording aligned with the Olympus 1.0 release plan (§2, §A.14).

## Terms (defined once)

- **Private** = tier S4 = trust domain `secure_local`.
- **Panel** = the private answer panel in ChatGPT. It collects an answer from the owner's Mac through the relay, encrypted to a key only the panel holds.
- **Seal** = encrypt to the panel's key. The relay and ChatGPT see only ciphertext.
- **Envelope** = one sealed response body.
- **First answer** = the answer the on-device model writes from the owner's Private items, exactly as today.
- **Consult** = one outbound request with up to three short general sub-questions, written on-device.
- **Writer** = the on-device model call that proposes the consult.
- **Gate** = the outbound check: a pure function that refuses defined kinds of copying and identifiers.
- **Outside block** = the bounded reply, shown under the first answer, labelled as not from the owner's documents.
- **Fence** = the zkAPI ledger mark that a paid request has not yet been seen to settle; while held, no consult starts.
- **Slot** = the single on-device analysis slot; the model server runs one request at a time (`--parallel 1`).

---

## 1. Owner direction (settled)

- **The ChatGPT private answer panel is the product path.**
- **Consults are automatic** once the user has set up a route. Approval prompts exist only in an opt-in strict mode.
- **Exactly one pre-send check:** the mechanical gate. A refusal means no consult, silently.
- **Fast and secure together.** The first answer appears exactly as fast as today.
- **No spending cap by default;** costs stated up front.
- **Vocabulary packs per configured language;** Brazilian Portuguese ships.
- **zkAPI is experimental,** labelled "route not verified" on macOS until route verification passes. The upstream issue is not being posted for now.
- **Version one (2026-10-05):** no rewrite pass (append instead); no searchable consult records; one route; fence recovery is a button, never automatic; enable only from the Mac; consult only when the first answer is marked insufficient or has gaps; ship all ten packs.
- Standing: tiers are the product; the relay is an accepted central point; when a user chooses zkAPI, the result must meet the standard of the people who designed the practice.

## 2. Position against the release plan

- The active plan is **Olympus 1.0 (ChatGPT)** (`docs/V0_4_RELEASE.md`). This feature is **not in 1.0.** It is a candidate for the release after 1.0. Its first build pull request adds it to "Deferred to after 1.0" with a dated owner decision.
- No 1.0 checklist row changes. No versioned contract changes (§A.11).
- Wording that changes when it ships: "Private content never reaches an ordinary cloud model" becomes "…the evidence never does; with outside help on, the on-device model may send a short general question it wrote" (§10).

## 3. Current state (verified on `main` at `bb1755fb`)

- **Panel path:** a ChatGPT search matching Private items creates a one-time job; the model answers in the background; the panel collects the sealed answer. One sealed outcome per job; the panel stops polling once it shows the answer; jobs live 10 minutes and are never persisted.
- **zkAPI transport,** dormant: one consult at a time; returns only after settlement and teardown; refuses if a daemon is already running.
- **Gate,** on branch `claude/consult-outbound-gate`, uncalled, with ten shipped vocabulary packs and `eval/consult-leak`.
- **No consult settings** on the ChatGPT product.

---

## Track A — consult on the panel

### A.1 Outcome

**A user opens a private answer in ChatGPT and sees it as fast as today. If the answer is incomplete and outside help is on, a separate block may appear under it a few minutes later: "Outside background — from an outside model, not from your documents."** The first answer and its sources never change.

What leaves the Mac: only the bounded question that passed the gate (§A.4), through the zkAPI route.

Stated limits:

- The question is derived from Private material. The gate rejects defined kinds of copying and identifiers, but **cannot guarantee that no Private information leaves** (§A.4).
- The outside provider reads the question; zkAPI hides who paid. On macOS the network route is not verified until §Z.4 passes.
- Someone who sees both ChatGPT's traffic and the outside provider's could link them by timing; the consult starts about one to two minutes after ChatGPT saw the question.

### A.2 Flow

```text
search → job → first answer (unchanged) → panel claims → first answer sealed and shown   [as today]
   │
   └ outside help on, route set, first answer marked insufficient or has gaps,
     not a "these items do not answer" result?                         no → done
       │ yes
       ├ start zkAPI warm-up (no request, nothing reserved)  ┐ in parallel
       ├ writer call (on-device, lowest priority)            ┘
       ├ both done → recheck settings, recent panel activity, eligibility, deadlines,
       │             send-once latch → gate                     any no → cancel warm-up; done
       ├ send ONE request (no long wait between gate and send)
       ├ reply arrives → bounded plain text → stored on the job → appears in the next collection
       └ settlement and teardown continue in the background
```

- **Only claimed jobs consult.** A precompute nobody collected spends nothing.
- **The first answer always stands.** Nothing after the seal can change it.
- **Trigger data is explicit:** the model's own `sufficient` verdict and a "no answer" flag are carried internally from the model to the jobs engine. They never enter the sealed plaintext. Today `sufficient` is used only to filter gaps and then dropped (`analyst-built-in.ts:506`).

### A.3 The writer and its snapshot

**Decision: the writer is a second on-device call made after the first answer is sealed. It is the only extra model call.** *Rejected: a question field in the first answer's own output, because it adds output and prompt tokens to every answer.*

**Inputs, bounded in model tokens:** the fixed writer rules; the user's question (≤ 1,000 characters); the first answer (≤ 2,700 characters); its gaps (≤ 5 × 200 characters). The whole prompt must be ≤ 2,048 model tokens, counted with the model server's own tokenizer; over that, no consult. Output: a JSON schema `{"consult": null | [up to 3 strings]}`, `max_tokens` 160. Writer deadline 60 s, abort only, **never a model reset**.

**The writer does not see the evidence again.** The gate still compares against everything the first answer read.

**Snapshot handoff.** When the first answer is computed, the model wrapper returns an immutable snapshot with it:

- the exact evidence text the model was given (after relevance selection, depth reads and fitting), per item;
- the question as answered, the answer, its gaps, `sufficient`, "no answer";
- the identities of the items read.

The snapshot belongs to **the computation that produced the answer**. A reused precompute brings its own snapshot (the search-time text it actually read), not the claim-time refresh. Writer-visible texts are passed to the gate exactly as the writer saw them (question, answer, gaps) through `writerVisibleTexts`; the evidence goes in as the pack. So the gate snapshot covers every writer input and more.

**Retention:** in engine memory on the job, from the seal until the consult decision (send or skip), at most 5 minutes; then dropped. Size is bounded by the prompt budget (≤ 11.5 KB of evidence) plus the answer. Never written to disk.

**One request per answer,** with up to three sub-questions on one topic. Facts whose combination could identify the owner are dropped, not split.

Estimated writer time (arithmetic at the measured 3–6 tokens/s generation and 81–109 tokens/s prompt reading on a loaded Mac; **not measured**): typical 1,000-token prompt and 100-token output ≈ 25–45 s; at the bounds (2,048 in, 160 out) ≈ 45–80 s.

### A.4 The one check: the outbound gate

**Decision: the gate is the only pre-send check, and its guarantee is stated exactly.**

**The real guarantee:**

- Only the bounded, checked question leaves (≤ 3 sub-questions, ≤ 600 bytes, ≤ 80 lexical tokens, ≤ 12 content words each; only words from the configured language and domain packs).
- The gate rejects defined patterns: runs of 4 content tokens shared with the snapshot, reordered copies, names, figures and identifiers from the snapshot, repeats of a recent consult.
- **It cannot guarantee zero Private information.** Known gaps, each pinned by a test on the gate branch: synonym paraphrase and rare combinations of ordinary words; a name that is also a dictionary word written in lower case ("mason reported a breach" lets "Can mason appeal?" pass); figures re-expressed by arithmetic; covert channels in word choice.
- **The user's question is not owner-authored.** It reaches the engine as a ChatGPT tool argument (`mcp-surface.ts:305`), written by ChatGPT. It is in the snapshot, so copying from it is refused, but it could carry pasted Private text or instructions to encode something; the gate catches only the defined patterns.

Other properties:

- Pure function, no state; the caller keeps the recent-question history (≤ 20, in memory).
- **Vocabulary packs per configured language.** Shipped: English, Dutch, French, Spanish, Portuguese (Portugal), **Brazilian Portuguese**; German and Italian are user-installed. Domain packs: units and generic medicines on; countries and brand names off. Packs load when outside help is turned on, never on the answer path.
- **Verdicts stay on the Mac.** Nothing about a refusal reaches the panel, ChatGPT, the relay or panel `_meta`. The local log records only "skipped" and stage times.
- Speed target sub-millisecond; unmeasured on real packs (timing test in C1). It runs after the seal, so it cannot slow the first answer.

### A.5 Collection protocol and what each party can see

**Decision: after the claim, every collection by the claiming key, on every install, gets the same response: 200 `ready` with a freshly sealed envelope of one fixed size. Every state lives inside the envelope.** *Rejected: a `follow` flag on some requests, because replay and reopen would take the other path and expose a difference.*

**The envelope** (plaintext version 1, optional fields added; the panel already ignores unknown fields):

```text
{ v: 1, rev,
  state: "answer" | "withdrawn",
  answer, citations, unanswered,                       // the first answer, never changed
  followSeconds,                                       // remaining follow-up time; 0 when outside help is off
  outside: { state: "none" | "pending" | "appended" | "paused",
             text?, question?, route? } }
```

- **Withdrawal moves inside.** Today a withdrawn answer is a plaintext `failed` body (`private-answer-jobs.ts:553`). After the claim it becomes `state: "withdrawn"` inside a normal envelope, with no answer text.
- **The answer is sent once per envelope, never a second "original" copy.** Each envelope carries the complete current state, so a reopened panel needs nothing special: it collects with its stored key and renders what it gets. (Leaving the answer out of later envelopes would need a relay-visible "I already have it" signal, or would break reopening.)
- **Fresh seal each time:** a new engine key and IV per response.
- **Fixed size:** every envelope is padded to exactly **32 KiB**. It never grows. Before the claim (202 pending, 409, 410, 429), responses are as today.

**Byte budgets** (serialized UTF-8 JSON, escapes included), with a deterministic overflow rule:

| Field | Budget | If over |
|---|---|---|
| `answer` | 12,288 B | cannot happen: the answer is ≤ 2,700 UTF-16 units, ≤ 3 bytes each after escaping (≤ 8.1 KB); a test proves it |
| `citations` | 10,240 B total, ≤ 2,048 B each | drop trailing citations (the panel reads at most 4 items) |
| `unanswered` | 2,048 B total | drop trailing entries |
| `outside.text` | 4,096 B | cut at the last code point that fits, append "…", set `cut: true` |
| `outside.question` | 1,024 B | cannot happen: the gate caps it at 600 B raw |
| `outside.route` and other scalars | 512 B | fixed strings |
| Skeleton | 512 B | — |
| **Total** | **30,720 B ≤ 32,768 B** | proven by a test that fills every field to its budget with multilingual text, quotes, backslashes and maximum URLs |

**Panel behavior:**

- **The panel polls only while `followSeconds` > 0:** every 30 s, up to 20 minutes from the first reveal, whatever it receives. A reopened panel resumes from `followSeconds`.
- **Fixed outer height:** at first reveal, the panel's height becomes the first answer's height plus a reserved strip (proposed 120 px), capped at its current maximum. That height is locked for the follow-up period: no `notifyIntrinsicHeight` or `ui/notifications/size-changed` after the lock (today they fire on every layout change, `private-answer.ts:875–899`). Everything else, including Sources and the outside block, scrolls inside.
- **Outside block:** plain text set with `textContent`. Markdown is shown as literal characters, never rendered. Links are not made clickable. Control and bidirectional-override characters are stripped. Heading: "Outside background — from an outside model, not from your documents." A collapsed "What Olympus asked" shows the question.
- **On failure, nothing.** A pending line ("Looking up general background…") disappears inside the reserved strip. Paused (fence held): "Outside help is paused. Open Olympus on your Mac."

**What is still visible, honestly:**

| Who | Sees |
|---|---|
| Relay | Job id, panel public key, request times and count, status codes, fixed sizes. The follow-up poll schedule tells it **this install has outside help on**; not whether any given consult was refused, sent, failed or appended. Mac source-open requests (time, and that a Mac-file source exists), as today. Existing residual: a compromised relay could swap keys and read envelopes, outside block included (accepted for 1.0, `V0_4_RELEASE.md` "Deferred to after 1.0"). |
| ChatGPT (the host) | As today: the tool result's `_meta` (count, state, job id, detail) and the panel's first-reveal height. It serves the widget sandbox, so it can see the panel's network requests like the relay can, and so can also infer the setting. The fixed height hides per-answer outcomes. **Web sources open through the host** (`openExternal` / `ui/open-link`, `private-answer.ts:596`): the URL goes to ChatGPT and bypasses the engine's eligibility guard. This is an existing exception, now stated. |
| Local network | Tor starting for each triggered answer (warm-up), whatever the verdict; Tor traffic when a consult is sent. |
| zkAPI operator and OpenRouter | The question, its timing, and warm-ups that send nothing. |

**Recent panel activity,** not presence. A consult is sent only if the claiming key collected within the last 75 s. Disclosed limits: the panel may close just after a poll, and the relay could replay a captured request (it carries the public key, with no proof of the private key). **Replay-resistant liveness is deferred from version one.** Reasoning: dispatch happens once per job, about a minute after the claim; a replay can matter only if the user closes the panel in that minute, and it can cost at most one consult ($6) for an answer the user already opened. The enable sheet says so plainly. Revisit if dispatch moves later.

**Send-once latch:** an atomic per-job flag set before dispatch. Repeated polls, remounts and replays never send again. Tests cover them.

**Job lifetime:** a claimed job on an install with outside help on lives 30 minutes from creation (today 10). Restart forgets all jobs, as today: a reply in flight is lost; the fence and the money spent remain. Jobs with a sent consult are evicted last at the 200-job cap; if evicted, the reply is discarded.

### A.6 The outside block: not a rewrite

**Decision: version one shows the reply, bounded and labelled, under the unchanged first answer. No model reads the reply.** *Rejected for version one: an on-device rewrite applying the reply to the documents, because existing citation checks confirm only that a cited item exists, not that it supports the claim, so an injected reply could produce false document claims (review finding 6). It also needed a second model call.*

- **Reply bounds:** at most 256 KiB from the transport (its existing cap); normalized to plain text; cut to 4,096 bytes (§A.5).
- **Never stored** beyond the job. Never fed to any model. Never indexed.
- **A hostile reply** can still say false or harmful things to the user. The label and the separation are the mitigation; the eval tests it (§A.13).

### A.7 Scheduling, dispatch order and eligibility

**Decision: the writer is the lowest-priority work in the existing queue. Whether it may run while fresh answers are possible is decided by measurement M0 before feature code is built.**

- **Queue order:** claimed answers, then precomputes (newest first), then the writer.
- **Owner requirement:** no fresh first answer may get slower. Preemption (abort the writer when a fresh answer arrives) meets it only if the server frees itself fast. That is unproven: aborting an HTTP request does not prove `llama-server` freed its slot, and today's fallback (a model reset) would slow the next answer. **M0 measures it** (§A.14). The writer never causes a reset.
- **Fallbacks if M0 fails, in order, for the owner to choose:** (1) run the writer only after the queue has been idle for N seconds; (2) a smaller, tighter writer prompt; (3) a separate lightweight writer process (for example the 2B model in its own server, at a memory cost); (4) change the requirement. None is picked silently.
- **Network waits never hold the slot** and do not count as answer activity.

**Dispatch order:**

1. Warm-up and writer run in parallel (warm-up reserves nothing).
2. When both finish: recheck the settings revision, strict-mode approval if on, recent panel activity, the deadlines (§A.8), and the send-once latch.
3. **Eligibility check** on the items the first answer read.
4. Gate.
5. Send at once. No long wait between steps 2 and 5. The gate is pure; the send is the next call on the already-warm session.

**Eligibility sites:**

| # | Where | Items | On failure |
|---|---|---|---|
| E1 | Immediately before the writer call (guarded model wrapper) | items the first answer read | no consult; snapshot dropped |
| E2 | Dispatch step 3 above | the same | no send; warm-up cancelled (nothing spent) |
| E3 | Every hand-out of every envelope (existing `stillReleasable`) | the same | `state: "withdrawn"` inside the envelope, for good |
| E4 | Every Mac source-open (existing) | the same | 410, as today |

Web sources are outside E4 (§A.5).

**Residual:** the live check does not apply owner tier rules ("always Secret", "always Private") at once; the classification sweep applies them (`analyst-answer.ts:2724–2727`). An item the owner just ruled Secret may still pass E1–E3 until the sweep runs. Stated, not fixed here.

### A.8 The zkAPI session

**Decision: one supervised session owns warm-up and send under one lease, and reports two outcomes, `reply` and `finished`.**

```ts
interface ConsultRoute {              // one implementation in version one: zkAPI
  readiness(): Promise<Readiness>;    // ready | busy | fenced | blocked; label; worst-case cost
  open(): Promise<Session | Refusal>; // takes the lease; starts Tor, daemon, policy warm-up
}
interface Session {
  cancel(): Promise<void>;            // before send only: reserves nothing, spends nothing
  send(question: string[]): {
    reply: Promise<Reply | Failure>;  // as soon as the completion arrives
    finished: Promise<Finished>;      // settlement, teardown, route checks; lease released here
  };
}
```

- **Lease:** held from `open` through teardown. A second consult while it is held is skipped, never queued.
- **Fence:** set at reservation, just before dispatch; cleared only on settlement evidence, as today.
- **After dispatch, the job's interest can end, payment cleanup cannot.** Today a caller's cancel aborts the completion fetch (`consult-transport-zkapi.ts:1975`) and a late abort discards a reply already received (`:1884`). Both change: after dispatch, no caller signal reaches the session.
- **Before dispatch, cancel reserves and spends nothing.** C2 proves it with a test, so an unsent request can never force a paid recovery.
- **The `reply` receipt** says settlement, teardown and the post-stop route check are still pending. `finished` reports them.
- **Deadlines:**
  - Consult start: dispatch within 5 minutes of the first answer's seal, else skip.
  - Delivery room: dispatch only if dispatch time + the completion timeout (6 min) + 2 min ≤ the earlier of job expiry and the panel's follow-up end.
  - Collection: the panel's 20-minute follow-up window.
  - Settlement and teardown: unbounded by the job; they finish in the background.
- **Fence actions, in the Mac dashboard, never automatic:**
  - **Recover:** sends one fixed "OK" request; reserves up to $6.
  - **Abandon:** stops the fence blocking. **Consequence, shown in its confirmation:** the old request was never settled and may later settle under another session's network identity, linking the two (`consult-transport-zkapi.ts:703`).

**Why zkAPI is slow, and what we will measure.** The reference wrapper reports 3–4.5 minutes per request end to end, with no per-stage split. The stages are: lease and sandbox self-test; throwaway Tor bootstrap; daemon start; policy warm-up over Tor; reserve; completion; settlement; teardown. **Every per-stage figure is unknown until M1.** The configured timeouts (Tor 210 s, daemon 120 s, warm-up 180 s, completion 6 min, settlement 300 s twice) are budgets, not estimates. Two speed changes cost no privacy and are part of C2: warming up during the writer, and releasing the reply before settlement. Anything further (for example seeding Tor with the public directory cache) waits for M1's numbers. Keeping Tor or the daemon alive between consults is rejected: one guard would see every consult's timing, and something would listen between consults.

### A.9 Settings and turning it on

**Decision: `~/.olympus/consult.json`, read at each consult; no worker restart. Changed only on the Mac: the local dashboard or the `olympus consult` command. Never from ChatGPT, an agent tool or the relay.**

- **Contents:** `{v, revision, enabled, languages, domains, strict}`. Writes use a revision compare-and-swap. The zkAPI profile stays in `sovereignty.json` and is created once at setup.
- **Why Mac-only:** a hosted agent must not be able to switch on egress. (It does not hide the setting from the relay or ChatGPT; §A.5 says what they can infer.)
- **Strict mode** (opt-in, after version one, stage C6): each consult waits for approval in the Mac dashboard. The approval binds the question digest, job, settings revision and expiry, and is rechecked at dispatch step 2.
- **Turning it on:** (1) install and fund `zkapi-clientd` with its own tool, and install Tor; (2) in the Olympus dashboard on the Mac, open **Outside help**; Olympus detects both; (3) read the cost sheet, tick the acknowledgements, press **Turn on**. Languages are prefilled from the Mac's language plus English. The `olympus consult on` command shows the same acknowledgements and refuses without them.

### A.10 Costs, stated up front

On the enable sheet and the dashboard card, in these words:

- "Each private answer shown in ChatGPT that Olympus judges incomplete may send one outside question, automatically. Each can cost up to $6 from your zkAPI balance. Olympus counts the full $6."
- "There is no daily limit unless you set one."
- "Your deposit is the hard limit."
- "A question is sent only if the panel was recently active. If you close it within about a minute of the answer appearing, a question may still be sent."
- The fixed costs: deposit and withdrawal fees, the 30-day expiry, operator risk (§Z.2).

### A.11 Architecture decision for review: the outside block is panel presentation

**Decision AD-1 (needs explicit review sign-off):** the `Analyst` answer is untouched. The first answer is produced by `Analyst.analyze` exactly as today, and "answer from this evidence only" holds. The outside block is **panel-level presentation of labelled untrusted text**. It is not an `Analyst` output, not evidence, carries no citations, is never fed to a model, and is never stored.

This avoids the semantic contract change that rewriting the answer would be. It does add a new kind of content to the panel. Reviewers should confirm that is acceptable under `CONTRACTS.md`'s compatibility rule ("no parallel types to evade the contracts"), or require the contract-change process.

The seams touched are all outside the contract fingerprint (`scripts/contract-version.ts` covers types reachable from `contracts.ts`):

- `PrivateAnswerPlaintextV1` and the jobs engine (`src/workers/chatgpt/`);
- the internal result of `answerPrivately` (snapshot, `sufficient`, no-answer);
- new modules for the route, settings and orchestration.

### A.12 Records

**Decision: no consult text is stored anywhere beyond the job's lifetime.** Kept: content-free operational receipts (stage times, outcome codes, dollars reserved, fence state) in the existing ledger and timing log. Searchable consult records are out of version one. They return only with their own provenance and trust design and a multi-turn injection eval.

### A.13 Eval

Fixed thresholds and sample sizes, on synthetic Private corpora:

- `eval/consult-leak`: planted identifiers (zero), multilingual including Brazilian Portuguese, encoded and adaptive leakage, false refusals.
- Attribute inference by an attacker who knows the account; sequences of consults; timing correlation with the ChatGPT request.
- Hostile replies shown in the outside block (false claims about the user's documents, instructions to the user).
- **Usefulness:** on incomplete first answers, does the outside block help? No measurable help, no default-on.
- The held-out eval (`eval/`) wherever shared answer code changes.

### A.14 Build plan

Smallest usable first version: **M0, M1, C1–C5.** Measurement comes first, so the feature is not built around an unproven assumption.

"Critical (path)" = `config/change-risk.json` says so. "Critical (declared)" = egress or trust routing, so declared critical (a declaration may raise risk, never lower it).

| # | Delivers | Proof | Risk |
|---|---|---|---|
| **M0** | **Measurement gate, before feature code.** A harness on the shared `--parallel 1` server: a fresh first answer arriving during writer prefill, writer generation, at the writer's deadline, and during a reset. **Pass:** no measurable added delay to the fresh answer beyond abort latency, abort latency under about 1 s, and no model reset caused by the writer. Results recorded in this doc | Twenty trials per phase on the owner's Mac, 4B model; fresh-answer latency compared with no writer | Standard |
| **M1** | **Live transport timing.** Stage timers added to the transport receipt (small PR), then ten real consults with synthetic questions over Tor. **Owner-gated: needs a funded daemon** | Per-stage median and worst case recorded here | Critical (declared) |
| C1 | Gate and packs on `main`; doctor line (makes the gate reachable); all 20 pack files listed one by one in `V0_4_PUBLIC_PACKAGE_FILES`; writer rules updated for automatic mode | Gate tests; `eval/consult-leak`; public-surface guard; packaged-path fixture; gate timing test | Critical (path: `public-surface.ts`) |
| C2 | Transport session: `open`/`cancel`/`send`, `reply` and `finished`, lease through teardown, no caller abort after dispatch, warm-up during the writer, early reply, Abandon wording | Stand-in daemon tests: cancel before send leaves the ledger untouched; fence held until settlement; a second open is busy; late cancel keeps the reply | Critical (declared) |
| C3 | `consult.json`, the `olympus consult` command with the acknowledgements | Settings tests; no MCP tool, setup tool or relay path can change it | Critical (path: `src/cli.ts`) |
| C4a | **Collection protocol and panel together:** uniform post-claim envelope on every install, withdrawal inside it, 32 KiB fixed size and budgets, `followSeconds`, fixed panel height, outside-block rendering, 30-minute TTL for consult-on installs | Budget-fill test; replay, reopen and withdrawal give identical-size fresh seals; **a host-message transcript test showing identical height notifications across refused, skipped, sent, failed and appended**; design-receipt update; owner visual acceptance | Critical (declared); design-receipt guarded |
| C4b | **Scheduling:** writer queue position per M0, snapshot handoff, `sufficient` and no-answer metadata, token-bounded writer prompt, E1–E2, deadlines, send-once latch | No change to first-answer timing (M0 harness re-run); latch tests; precompute-reuse snapshot test; held-out eval | Critical (declared) |
| C5 | **First usable version:** wiring to the zkAPI route; Mac dashboard **Outside help** card (cost sheet, languages, fence Recover and Abandon); end-to-end acceptance; §A.13 eval | One real consult end to end on the owner's Mac; eval reviewed by the owner before default-on | Critical (declared); design-receipt guarded |
| C6 | Strict mode (approvals in the Mac dashboard) | Approval binding and recheck tests | Critical (declared) |
| C7 | Speed changes chosen by M1 | Before and after stage timers | Critical (declared) |
| F1, F2 | Daemon fork, only if the owner approves (§Z.4) | See §Z.4 | Critical (declared) |
| Later | OpenClaw `source_answer` (versioned `Analyst` change; anonymous route only where the result stays out of the calling agent's view); a rewrite pass; searchable records; Venice route | Each its own proposal | Critical |

The panel (`src/workers/dashboard/chatgpt/private-answer.ts`) and the Mac dashboard card are inside the dashboard design-receipt guard (`config/dashboard-design-review.json` lists `src/workers/dashboard`), so C4a, C5 and C6 update `implementation_guard_sha256` and stay pending owner acceptance. The packs add about 11.2 MB to the package (Brazilian Portuguese is 6.6 MB).

---

## Track Z — zkAPI

### Z.1 What it is

zkAPI lets a user deposit ETH into a vault and make model requests that the payment side cannot tie to the deposit. A local daemon, `zkapi-clientd`, serves an OpenAI-compatible API on loopback.

- OpenRouter and the upstream model read the prompts; zkAPI hides who paid, not what was asked.
- Spending is sequential and the anonymity set was about 70 notes at review, so timing can link consecutive requests.
- zkAPI is used only as the consult transport, held to the reference practice (`tor-remote-research.md`, ethereum/zkapi PR #16):
  - **content:** an on-device writer and the gate;
  - **payment:** key reuse verified off;
  - **network:** throwaway Tor per consult;
  - **failure:** never resent another way;
  - **pace:** one at a time.

### Z.2 The money

| Cost or risk | What happens |
|---|---|
| Deposit fee | An expensive on-chain transaction (median about $7 at review) |
| Withdrawal fee | A second one, needing more ETH for gas |
| 30-day expiry | Unwithdrawn balance becomes claimable by the operator |
| No top-up | Each deposit is a new note with its own fee and clock |
| Operator risk | One account can pause deposits and withdrawals; single-party proof setup |
| Local risk | The balance is controlled by files on this computer |
| Per consult | Up to $6 reserved |

### Z.3 Shipped in Z1 (#144), and open

- **Shipped, dormant:**
  - a consult-only profile, refused for every evidence role;
  - acknowledgements (version 3);
  - an expiry estimate from the funding date;
  - optional daily caps;
  - the one-at-a-time lease and the fence;
  - daemon identity and inference-key checks;
  - key reuse verified from the daemon's log;
  - throwaway Tor and a macOS sandbox self-test;
  - never retried or downgraded;
  - no management credential, no fund movement.
- **Open:**
  - no live fee, balance or on-chain expiry (no permitted data path);
  - daemon release integrity;
  - measured latency (M1);
  - route verification (§Z.4).

### Z.4 Route verification: the daemon fork

**Recommended, AWAITING OWNER DECISION.** Upstream issue unposted. **The macOS label stays "route not verified" until F2 passes.** Prototype: `~/Code/Claude/zkapi-fork/`.

**Problem:** the daemon reads its relay endpoint only from its saved configuration, which also holds the bridge token that authorizes withdrawals, so Olympus must not read it. Its companion reaches the network through a CONNECT proxy on a random loopback port. A sandbox profile is written before start, so it cannot name that port. Corrections to earlier text: the wallet API port is already fixed by the configuration's `client_url` (default `127.0.0.1:8790`), so the problem there is only that a supervisor cannot learn it without reading the token file. And the sandbox must also allow the daemon's own API port, because its readiness check calls itself.

**The fork:**

- A Go-only patch against `ethereum/zkapi` `045b444`: 5 production files +98/−8, 3 test files. With no flags, `serve` behaves as upstream and upstream's tests pass.
- Four opt-in `serve` flags:
  - `--relay-url` (in memory, this run only);
  - `--companion-proxy-listen 127.0.0.1:PORT` (exit if the bind fails);
  - `--wallet-api-listen 127.0.0.1:PORT`;
  - `--require-managed-companion`.
- `/admin/status` gains a `transport` block.
- No wallet or key code changed; the Rust companion and proving files are upstream's release, hash-checked.
- Build: about 5 s, 9.69 MB, byte-identical across three builds.

**What the prototype recorded, and no more** (`poc/run-poc.out`):

- **Setup:** the real patched daemon, with a **fake companion and a fake Tor** that refused the CONNECT and forwarded nothing. Inference authentication was off (`require_api_key: false`) and key reuse was 60 s, both of which the Olympus transport would refuse.
- **Under the profile:** the daemon reached Ready, and `/admin/status` reported the requested ports.
- **Probes from the daemon and its child, with and without the profile:**

  | Probe | Without the profile | Under the profile |
  |---|---|---|
  | Another live loopback port | connected | denied |
  | An unused loopback port | already refused | denied |
  | A non-loopback address | already timed out | denied |
  | DNS | resolved | failed |

- **Failure checks:** an occupied proxy port made the daemon exit; a profile missing the proxy port made the bind fail.

This shows **a working network profile, not a privacy-qualified consult session.**

**What a passing F2 would let the label say:** "network confined by the operating system to this session's Tor listener".

- **Proved:** the daemon's process tree could reach only the four named loopback ports, and only the SOCKS port leads off the machine.
- **Known only because Olympus started it:** that the SOCKS listener is Tor.
- **Not proved:** circuit unlinkability, timing or content correlation, or other users' processes.
- **Profile limits:** one profile covers the whole tree, so the companion can also reach Tor and the API port. Seatbelt hosts are only `localhost` or `*`. `sandbox-exec` is deprecated.
- **The patched Go binary reads the configuration and passes the bridge token.** So it is inside the credential trust boundary, whatever the Rust code does. Reproducible builds show reproducibility, not provenance or safe wallet behavior.

**F2 prerequisites (all required before the label changes):**

1. **Authenticated ownership of the managed wallet listener before the first token-bearing readiness request.** Today the daemon sends the bridge token to the wallet port during readiness, and Olympus's ownership checks cover only the daemon API and Tor ports (`consult-transport-zkapi.ts:1731`). It needs a child startup handshake or a daemon-side equivalent. A "port free" preflight leaves a race.
2. Tests with the **real pinned companion** under required inference authentication and key reuse 0.
3. Probes for Unix sockets, UDP and DNS, both loopback address families, and listener replacement mid-session.
4. **Whole-bundle pin and verification:** daemon, companion and setup files, checked at download and at every start.
5. The licence notices: MIT, upstream's third-party notices, a statement that the source was modified, and the LGPL-3.0 go-ethereum notice.

**F1** builds the pipeline:

- pin the upstream tag and commit;
- apply the patch and run its tests;
- build with a pinned Go;
- check that two clean builds match;
- take the companion unchanged, checked against upstream's release manifest;
- add the notices;
- publish the hash.

Delivery: downloaded when the user turns zkAPI on, pinned by hash, not in the package. Signing and notarization are unchecked. Maintenance: upstream is fast-moving (seven client releases in two days), so expect occasional small rebases.

**Rejected alternatives:**

- a `DYLD` interposer (fragile; stripped by the hardened runtime);
- a local forwarder (the random port still has to be allowed);
- the "any loopback" rule (any local proxy escapes);
- a Linux VM (too heavy).

If upstream ships equivalent flags, the fork retires.

---

## Track B — Venice end-to-end encryption (later)

Venice's end-to-end encrypted models could become both a Private answer lane Venice cannot read and a fast consult route (seconds, not minutes). It is acceptable only at full verification:

- client-side Intel quote verification;
- nonce and key bound; debug off;
- the workload pinned to a list Olympus maintains;
- positive proof that encryption is on (the same ids also serve plaintext);
- the reply bound to the request.

Open questions with Venice (reply binding, response signatures, the gateway's downstream hop, JSON under encryption) must be answered before building. It gets its own proposal; nothing in track A waits for it.

---

## 10. Decisions needed from the owner

1. **Wording** (§2): may "Private content never reaches an ordinary cloud model" become "…the evidence never does; with outside help on, the on-device model may send a short general question it wrote"?
2. **Daemon fork** (§Z.4): approve F1 and F2, with the maintenance they bring? Without it, macOS stays "route not verified".
3. **AD-1** (§A.11): accept the outside block as panel presentation, after review, rather than a contract change.
4. **If M0 fails** (§A.7): which fallback.

Settled by the owner on 2026-10-05 and applied here: enable only from the Mac; fence recovery is a button; consult only when the first answer is insufficient or has gaps; ship all ten packs; no rewrite and no stored records in version one.

## 11. Not proposed

A rewrite pass, searchable consult records or multi-route orchestration in version one; a consult queue; a self-check model call; automatic fence recovery or abandonment; any key that can move funds; sending any `EvidencePack` to an outside model; a relay change.

## Appendix: code references (main at `bb1755fb` unless named)

- **Jobs:** `src/workers/chatgpt/private-answer-jobs.ts`
  - limits :307–316; deadlines :322, :330;
  - `begin` :462 (eviction :486); `claim` :514 (same bytes per POST :545–555; plaintext `failed` on withdrawal :553);
  - `stillReleasable` :597; queue :763–794; `run` :796 (dispatch guard :834); `startClaim` :893; reset :1065; handler :1298–1320.
- **Panel contract:** `src/workers/chatgpt/private-answer-contract.ts` (TTL :27, plaintext :102, guard :170).
- **Seal:** `private-answer-crypto.ts` (fresh engine key and IV per seal; buckets 1–64 KiB, growing).
- **Panel:** `src/workers/dashboard/chatgpt/private-answer.ts`
  - auto-collect on render :226; `readAnswer` :407; `collect` :476–580;
  - web-source open through the host :590–600; height notifications :875–899.
- **Relay:** `connect-relay/server/relay.ts` :690–728 (opaque body, 512 B cap); per-address bucket `connect-relay/server/limits.ts:157`.
- **Model:** `src/workers/chatgpt/private-answer-model.ts`
  - audit off :171; depth items :249–270; observer :282; guarded call :300–314.
- **Built-in:** `src/core/analyst-built-in.ts`
  - `answerPrivately` :495; `createAnalyst` :509; `sufficient` dropped after gap filtering :506–540; `timedModel` :646.
  - Server `--parallel 1`: `src/workers/source-index/built-in-reasoning/server.ts:131`.
- **Eligibility check and its sweep residual:** `src/workers/source-index/analyst-answer.ts:2712–2730`.
- **Transport:** `src/core/consult-transport-zkapi.ts`
  - Abandon :703–710; lease :1546–1556; running-daemon refusal :1636; ownership check :1726–1735;
  - completion and settle :1822–1880; late abort discards a reply :1884; caller abort reaches the fetch :1975.
- **Gate** (branch `claude/consult-outbound-gate`): `src/core/consult-gate.ts:42–64` (known limits); `test/consult-gate-review-3.test.ts:88–89`.
- **Question as a tool argument:** `src/workers/chatgpt/mcp-surface.ts:305`.
- **Release plan:** `docs/V0_4_RELEASE.md` (title and Olympus 1.0 section; "Deferred to after 1.0").
- **Fork:** `~/Code/Claude/zkapi-fork/README.md`, `poc/run-poc.out`, `poc/run-poc.sh:23–25` (auth off, reuse 60 s).

## Sources

- Review record: [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md)
- Reference request rules and Tor wrapper: <https://github.com/ethereum/zkapi/pull/16>
- zkAPI daemon privacy boundaries: <https://github.com/ethereum/zkapi/blob/main/zkapi-clientd/docs/PRIVACY.md>
- Introducing zkAPI, 2026-10-01: <https://blog.ethereum.org/2026/10/01/introducing-zkapi>
- Vitalik Buterin, self-sovereign LLM setup, 2026-04-02: <https://vitalik.eth.limo/general/2026/04/02/secure_llms.html>
- Venice privacy modes: <https://docs.venice.ai/overview/privacy>
