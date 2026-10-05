# Design: frontier consult, anonymous cloud transport (zkAPI), and Venice end-to-end encryption

Status: **proposal, revision 5 (2026-10-05). Awaiting adversarial review** (see [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md), section E). Owner has directed the build of tracks Z and A; track E awaits its own go-ahead. Nothing here changes shipped behavior or the release plan until the owner rules on §10.
Risk class: **Critical** for tracks A and Z (trust routing and egress of Private-derived text). The panel-first stages change no versioned contract (§A.12).

## Changes since revision 4

1. **The ChatGPT private answer panel is the product path, and is designed first.** The OpenClaw `source_answer` path becomes a later stage that needs a versioned `Analyst` contract change (§A.13). The panel stages use only non-versioned seams, named in §A.12.
2. **Consults are automatic** once the user has set up a consult route. There is no per-question approval. Approval exists only in an opt-in strict mode (§A.9). Revision 4's A.5 (approval only) and A.6 (per-connection permission, approval queues) are replaced.
3. **One pre-send check:** the mechanical outbound gate. No self-check model call. A refusal means no consult and the first answer stands, silently (§A.4).
4. **Speed is a requirement.** The first answer appears exactly as fast as today. The consult happens afterwards, off the single analysis slot, and the panel later shows an improved answer (§A.2, §A.5, §A.6).
5. **The question is written by a second model call after the first answer is sealed**, not by an extra field in the first call (§A.3).
6. **Smallest panel protocol extension:** a second sealed revision on the same job, collected by a slow follow-up poll whose pattern does not depend on what happened (§A.5).
7. **Route-neutral consult interface,** so a fast route (Venice end-to-end encrypted, track E) plugs into the same orchestration (§A.7). zkAPI over Tor is named as the slow route, with a stage breakdown, speed options and one recommendation (§A.8).
8. **No spending cap by default;** costs are stated up front (§A.10). zkAPI reserves $6 per consult.
9. **Vocabulary packs per configured language;** Brazilian Portuguese ships (§A.4, §A.14).
10. **zkAPI stays experimental and is labelled "route not verified" on macOS** until the owner decides on a small, pinned daemon fork. The prototype worked; the fork is recommended but awaiting owner decision (§Z.6). The upstream issue remains unposted.
11. **Consult records are ordinary Private items** in the Private store, embedded and searched like other Private data, with no dashboard view (§A.11). Revision 4's "excluded from indexing" and "shown only in a control session" are removed.
12. **One consult request per answer**, carrying up to three sub-questions, instead of up to three sequential requests (§A.3).

## Terms (defined once)

- **Private** = tier S4 = trust domain `secure_local`.
- **Panel** = the private answer panel in ChatGPT. It fetches an answer from the owner's Mac through the relay, encrypted to a key only the panel holds.
- **Seal** = encrypt an answer to the panel's key. The relay and ChatGPT see only ciphertext.
- **Baseline** = the answer the on-device model writes from the owner's Private items, exactly as today.
- **Consult** = one outbound request with up to three short general sub-questions, written by the on-device model, containing no document content.
- **Writer** = the on-device model call that proposes the consult.
- **Rewrite** = the on-device model call that applies the consult's reply to the Private items and produces the improved answer.
- **Gate** = the outbound check: a pure function that refuses a consult that shares wording, names, figures or identifiers with anything the writer saw.
- **Route** = how a consult travels: zkAPI over Tor (slow, anonymous payment), Venice end-to-end encrypted (fast, track E), or an identified API key.
- **Fence** = the zkAPI ledger mark that a paid request has not yet been seen to settle. While it is held, no zkAPI consult may start.
- **Slot** = the single on-device analysis slot. The built-in model serves one request at a time.

This document holds three tracks that can ship independently:

| Track | What the user gets | Depends on |
|---|---|---|
| **A. Frontier consult** | A private answer that improves with general knowledge from a large outside model, without sending any document content | Gate (built, unmerged); one route from Z or E |
| **Z. zkAPI transport (experimental)** | The anonymous-payment route for consults | Z1 shipped dormant (#144) |
| **E. Venice end-to-end encryption** | A Private answer lane Venice cannot read, and a fast consult route | Nothing in A or Z |

---

## 1. Owner direction (settled; not review questions)

- **Tiers are the product.** Users decide what may go to cloud models. Personal content reaching cloud models is by design.
- **Olympus is not trying to be fully decentralized.** The relay and publisher apps are accepted central points.
- **The ChatGPT private answer panel is the product path.** Design for it first (2026-10-05).
- **Consults are automatic once a route is set up.** Approval prompts exist only in strict mode, which the user opts into (2026-10-05).
- **Exactly one pre-send check: the mechanical gate.** If it refuses, no consult happens and the baseline stands, silently (2026-10-05).
- **Fast and secure together.** "We want the security provisions, we also want them to be fast." The baseline appears exactly as fast as today (2026-10-05).
- **No spending cap by default; costs stated clearly up front** (2026-10-05).
- **Vocabulary packs per configured language; Brazilian Portuguese ships** (2026-10-05).
- **zkAPI ships as a usable experiment,** labelled "route not verified" on macOS until the daemon's ports can be pinned. The upstream issue is not being posted for now. Users are expected to have a crypto wallet. When a user chooses zkAPI, the result must meet the standard of the people who designed the practice (§Z.2).
- **Private items live in the Private store** and are embedded and searched like other Private data; no dashboard treatment (2026-10-05).
- **Venice end-to-end encrypted models become a first-class Private option** (track E).

## 2. Position against the release plan

- **Not v0.4.** v0.4 freezes the contracts and its scope is the seven-source cited-answer journey. No register row changes.
- **Slot:** v0.5 candidates. The panel stages (A) and Z1 can land as experimental, off until the user sets up a route.
- **The first build pull request of each track** adds a dated decision to `V0_4_RELEASE.md` and a v0.5 candidate line.
- **Wording that changes:** README "secure content never routes to ordinary cloud models" becomes "…the evidence never does; with outside help on, the on-device model may send a short general question it wrote" (§10 item 1). The `Analyst` rule "answer from this evidence only" is **not** changed by the panel stages (§A.12); it changes only in the later OpenClaw stage (§A.13).

## 3. Current state (verified against `main` at `bb1755fb`)

- **The panel path exists.** A ChatGPT search that matches Private items creates a one-time job; the on-device model answers in the background; the panel fetches the sealed answer. One job holds one sealed outcome; the panel stops polling once it shows the answer.
- **The zkAPI transport exists, dormant** (`consult-transport-zkapi.ts`, `zkapi-consult-settings.ts`). Nothing calls it except doctor. It runs one consult at a time and refuses a second caller at once (`busy`).
- **The gate exists on branch `claude/consult-outbound-gate`,** uncalled, with ten shipped vocabulary packs and the `eval/consult-leak` eval.
- **No consult setting exists** on the ChatGPT product: no on/off, route, languages or strict mode. The only "strict" switch (`OLYMPUS_SECURE_DERIVATIVE_DEFAULT`) applies to the OpenClaw path.
- **Gaps from the first review** (release gate trusting cited candidates only; address-only local trust; redirect following) are being fixed separately and are not repeated here.

---

## Track A — Frontier consult, panel first

### A.1 Outcome

**A user who opens a private answer in ChatGPT sees it as fast as today. If the answer from their documents is incomplete and outside help is on, the panel later shows an improved answer that also uses general knowledge from a large outside model.** No document text, name, figure or identifier is sent. The question is written by the on-device model and passes the gate.

Honest limits, stated in the product:

- The question is derived from Private material and may still reveal something about it. Passing the gate is never called de-identification.
- The outside provider reads the question. On the zkAPI route it cannot tell who paid; on macOS the network route is not verified until the daemon fork is approved and built (§Z.6).
- Someone who sees both ChatGPT's traffic and the outside provider's traffic could link them by timing. The consult starts one to two minutes after ChatGPT saw the original question.

### A.2 Flow

**Decision: the baseline path is untouched. Everything consult-related starts after the baseline is sealed and handed out.**

```text
ChatGPT search ─> job created ─> baseline precompute (unchanged)
panel claims ──> baseline sealed ─> panel shows it            [as today]
                     │
                     └─ consult on, route set, baseline incomplete?   no ─> done
                          │ yes
                          ├─ zkAPI: start warming the route now (no request, no charge)
                          ├─ writer call (on-device, lowest priority, preemptible)
                          ├─ gate (pure function)          refuse ─> done, silently
                          ├─ route busy or fenced ─────────────────> done (skip, never queue)
                          ├─ panel still open? (follow-up poll seen)  no ─> done, nothing sent
                          ├─ send ONE request (network wait: slot free)
                          │                                fail ──> panel: "did not finish"
                          ├─ rewrite call (on-device, lowest priority, preemptible)
                          └─ seal revision 2 ─> panel replaces the answer on its next follow-up poll
```

- **Trigger (mechanical, no question logic):** outside help is on, a route is ready, and the baseline is incomplete (the model did not mark it sufficient, or it lists something it could not answer). A baseline that says the items do not answer the question at all does not trigger a consult.
- **Only claimed jobs consult.** A precompute nobody opened never spends money.
- **The baseline always stands.** Every failure after the seal leaves the baseline in place. Consult errors never touch the job's first outcome, the model's health, or route selection.

### A.3 Where the question comes from

**Decision: a second on-device call (the writer), made after the baseline is sealed.**
*Rejected: an optional question field in the baseline's own JSON output, because it adds about 25–40 s to every answer (below), which breaks the speed requirement.*

Token arithmetic, at the measured 3–6 tokens/s generation and 81–109 tokens/s prompt reading (4B model, loaded Mac; `private-model-benchmark.md`):

| | Same generation (rejected) | Second call after seal (chosen) |
|---|---|---|
| Extra prompt | ~700 tokens of writer rules added to every baseline prompt: +6–9 s | ~1,000 tokens (rules ~700, question, baseline answer and its gaps ~300): 9–12 s, after the seal |
| Extra output | ~100 tokens (up to 3 sub-questions, 80-token gate cap, JSON envelope) on every baseline: +17–33 s | the same ~100 tokens: 17–33 s, after the seal |
| Effect on baseline | **+23–42 s on every answer**, and summary answers move toward their 100 s deadline | **none** |
| Writer time | — | **about 25–50 s**, off the critical path |

These are arithmetic estimates; nothing here has been measured on a writer prompt.

What the writer sees: the user's question, the sealed baseline answer and its list of gaps. **It does not see the evidence again.** The gate still compares the question against everything the baseline model saw (§A.4), so withholding the evidence from the writer only removes temptation; it does not narrow the check.

What the writer outputs: one JSON object, `{"consult": null}` or `{"consult": ["…", "…"]}` with at most three sub-questions on one topic. Facts whose combination would identify the owner may not share a request; under the one-request rule (below) the writer drops them instead of splitting them. The writer's rules are the approved instructions (`docs/design/consult-writer-instructions.md` on the gate branch), compressed for the small model and kept generic. The sentence there saying "the owner approves every consult" is changed to match automatic mode.

**One request per answer.** *Rejected: up to three sequential requests per answer (revision 4), because on zkAPI that is three times 3–4.5 minutes and three $6 reservations.*

### A.4 The one pre-send check: the outbound gate

**Decision: the gate is the only check. It is a pure function. If it refuses, nothing is sent, the baseline stands, and nothing tells the panel, ChatGPT, the relay, or panel `_meta` that a refusal happened.**

- **Function:** `evaluateConsultRequest(subQuestions, consultWriterContextFromPack(pack, {writerVisibleTexts}), limits, history, {languages, domains})` on the gate branch. It keeps no state; the caller holds the recent-question history (at most 20, in memory).
- **What it compares against (the snapshot):** the claim-time evidence pack the baseline read; the depth-read text of the leading items; the baseline answer and its gaps; the user's question. The jobs engine keeps these in memory, with the job, until the consult ends or the job expires.
- **Limits it enforces:** at most 3 sub-questions, 600 bytes and 80 tokens in total, 12 content words per sub-question, one context sentence each; shared runs of 4 content tokens; reordered copies; identifiers, names and figures from the snapshot; words outside the configured vocabulary packs; repeats of a recent consult.
- **Speed:** the owner's target is sub-millisecond. That is unmeasured on real packs; stage C1 adds a timing test. It runs after the seal, so even a slow gate cannot delay the baseline.
- **Vocabulary packs, per configured language.** The gate admits only words in the packs for the user's configured languages, plus the domain packs that are on. Shipped language packs: English, Dutch, French, Spanish, Portuguese (Portugal) and **Brazilian Portuguese**. German and Italian are user-installed (their word lists are GPL). Domain packs: units and generic medicine names on; countries and medicine brands off. Packs load when outside help is turned on or the worker starts with it on, never on the answer path.
- **Verdicts are private.** `CONSULT_GATE_VERDICT_IS_PRIVATE`: reasons and timing never leave the engine. The local content-free timing log records only "consult: skipped" and stage times.

### A.5 Panel protocol: baseline now, improved answer later

**Decision: a second sealed revision on the same job, collected by a slow follow-up poll on the existing endpoint. The relay is unchanged.** *Rejected: a new job from a new tool call, because ChatGPT would see a second private-match result and learn that something happened.*

The extension, in full:

1. **Plaintext gains optional fields** inside the existing v1 (the panel's parser already ignores unknown fields):
   - `rev`: 1 for the baseline, 2 for the improved answer.
   - `followUp: {everySeconds: 30, forSeconds: 1200}`: present on **every** answer from an install with outside help on, whatever the gate later decides.
   - `outside`: `{state: "looking"}` once a consult has actually been sent; `{state: "used", question, route, original}` on revision 2 (`original` is the baseline, so the panel can show it); `{state: "did_not_finish"}` if a sent consult failed; `{state: "paused"}` while the route is fenced.
2. **Follow-up poll.** After showing the baseline, a panel whose plaintext has `followUp` sends the same `POST /private/<job id>` with the same key and `"follow": true`, every 30 s for 20 minutes, or until the job answers 410 `gone`. It does not stop early when an update arrives.
3. **Engine answer to a follow-up:** always 200 `ready`, carrying the current revision, **freshly sealed** (a new engine key and IV each time) and **padded to one fixed size** (16 KiB). No 202, no Retry-After.
4. **Job lifetime.** On an install with outside help on, a claimed job lives **30 minutes** from creation (today: 10). Unclaimed jobs keep 10 minutes. The consult's in-memory context dies with the job.

Why this shape:

- **Nothing outside the sealed text depends on the gate's verdict or the consult's outcome.** Every answer on a consult-on install gets the same poll schedule, the same response size, and fresh ciphertext each time, so the relay cannot tell refused from sent from improved. What the relay does learn: that this install has outside help on. That is stated.
- **No relay change.** The relay matches the path and forwards the body opaquely (`connect-relay/server/relay.ts` `privateAnswer`; body ≤ 512 bytes). The poll rate (one per 30 s) sits far inside the relay's per-address bucket (30, 1/s) and the engine's per-job bucket (10, 1/s).
- **The baseline is never delayed.** Revision 1 is sealed and handed out exactly as today.

What the panel says:

| Moment | Panel |
|---|---|
| Baseline shown, nothing sent (off, not triggered, refused, busy) | The answer, as today. Nothing else. |
| Consult sent | One quiet line under the answer: "Looking up general background with an outside model. This can take a few minutes. The answer above already stands on its own." |
| Revision 2 arrives | The answer is replaced. A line: "Updated with general background from an outside model." A collapsed "What Olympus asked" shows the exact question and the route label. "Show original answer" restores the baseline. |
| Sent consult failed | "The outside lookup did not finish. The answer above stands." |
| Route fenced | "Outside help is paused until a previous payment settles. Open Olympus on your Mac to resolve it." |

If the user has left:

- **Before the send:** the engine sends only if it saw a follow-up poll in the last 75 s. A closed panel costs nothing.
- **After the send:** the consult finishes and revision 2 is sealed. If the user reopens the conversation while the job lives, the panel collects with its stored key (kept in the browser for a day) and gets revision 2. After 30 minutes the job, and the improved answer, are gone. A consult still running when the job expires is completed by the transport (it cannot be cut short once sent) and its reply is discarded.

### A.6 The analysis slot

**Decision: the network wait never holds the slot. The writer and rewrite run as the lowest-priority work in the same queue and give way to any fresh answer.**

- **Queue order:** claimed baselines, then precomputes (newest first, as today), then consult work (writer, rewrite).
- **Preemption:** when a claim or precompute arrives while consult work holds the slot, the engine aborts that call and puts it back once. The fresh answer then starts. The residual delay is how quickly the local model server stops after its request is aborted; it is expected to be under a second but is **unmeasured**, and stage C4 measures it. If it is slow, the fallback is today's reset (bounded at 30 s), and that cost would be reported, not hidden.
- **During the network wait** the slot is free, and the consult does not count as answer activity, so the background tier sniffer runs normally.
- **Deadlines:** writer 60 s; rewrite uses the job's own analysis deadline (100 s summary, 240 s full). A deadline frees the slot as today.
- **Rewrite cost:** about as long as the baseline took (one model call over the same evidence plus the reply).

Eligibility guard call sites for the consult (the live check that every item is still Private-eligible):

| # | Where | Items checked | On failure |
|---|---|---|---|
| G1 | Immediately before the writer call (guarded model wrapper, as in `private-answer-model.ts` `guarded.complete`) | items the baseline read | drop the consult context; no consult |
| G2 | Immediately before the gate and the send | items the baseline read | no send |
| G3 | Inside the rewrite: before its embedding, its depth re-read and every model call (the existing `answerPrivately` guards, reused) | items the rewrite reads | no revision 2 |
| G4 | Before sealing revision 2 | baseline items ∪ rewrite items | no revision 2 |
| G5 | After sealing, before revision 2 is first handed out | baseline items ∪ rewrite items | no revision 2 |
| G6 | Every hand-out of any revision, including each follow-up (`stillReleasable`) | baseline items ∪ rewrite items once revision 2 exists | the whole job is withdrawn for good, as today |
| G7 | Every source-open request | the same union | 410 `gone`, as today |

Revision 2 reports its `used` items so G4–G7 cover them. The stage label for timing becomes `main | audit | writer | rewrite` (today a second call is mislabelled `audit`).

### A.7 One consult interface for every route

**Decision: a route-neutral interface. The orchestration never names zkAPI.**

```ts
interface ConsultRoute {
  readonly id: string;                       // a consult profile id
  readonly kind: 'zkapi' | 'venice_e2ee' | 'identified';
  readiness(): Promise<ConsultRouteReadiness>; // ready | busy | fenced | blocked, label, worst-case cost, typical seconds
  prepare(control: { signal: AbortSignal }): Promise<ConsultSession | ConsultRouteRefusal>; // warm-up; sends nothing, charges nothing
}
interface ConsultSession {
  send(subQuestions: readonly string[]): Promise<ConsultReply | ConsultFailure>; // one request, never retried
  cancel(): Promise<void>;                     // allowed only before send
}
// ConsultReply: { text, routeLabel, receipt: { stages: Record<string, number>, ... } }
// ConsultFailure: { code, outcome: 'not_sent' | 'sent_failed' | 'unknown' }
```

- **One at a time, never queued.** If the route is busy (another consult or warm-up holds it), the consult is skipped. *Rejected: a queue, because a queued zkAPI consult would start minutes later, often after the user moved on, and reserve another $6.*
- **A held fence skips, it does not block.** Baselines are unaffected. The fence shows as a notice in the Mac dashboard with two actions: **Recover** (one fixed "OK" request, reserves up to $6) and **Abandon** (writes the reservation off). Doctor already reports it. The panel shows the "paused" line once per answer.
- **Routes:**
  - **zkAPI over Tor:** the slow route (§A.8). Payment unlinkable; network route not verified on macOS; reply in minutes.
  - **Venice end-to-end encrypted (track E):** expected to answer in seconds. Content encrypted to a verified enclave; Venice knows the account. Available only after E1–E3. On this route the on-device writer and rewrite (about 1–2.5 minutes together) dominate the wait.
  - **Identified API key:** labelled "identified"; no anonymity claim.

### A.8 zkAPI speed

**Decision: zkAPI over Tor is the slow route, and is labelled so. Recommendation: overlap the warm-up with the writer, and release the reply before settlement. Both have no privacy cost. Measure everything before going further.**

Why it is slow. The reference wrapper (`zkapi-tor-cli.sh`, ethereum/zkapi PR #16) measures **3 to 4.5 minutes per request, end to end**. It publishes no per-stage split. Olympus's transport runs the same sequence, with these bounds:

| Stage | What happens | Bound in code | Likely share (unmeasured) |
|---|---|---|---|
| 1. Lease and checks | One-at-a-time lease, ports free, sandbox self-test | 50 ms lease; seconds | small |
| 2. Tor bootstrap | Throwaway Tor client, empty data directory: new guards, full directory download | 210 s | tens of seconds is common for a cold Tor; unmeasured here |
| 3. Daemon ready | Start `zkapi-clientd serve`, wait for health | 120 s | seconds |
| 4. Policy warm | Poll the model list over Tor until the reviewed policy loads | 180 s (5 s polls) | possibly large: PR #16 raised this call's timeout to 3 minutes for Tor |
| 5. Reserve | Reserve $6, set the fence | — | none |
| 6. Completion | One chat request via Tor → zkAPI → OpenRouter → model | 6 min | the model's own time plus Tor latency |
| 7. Correlate and settle | Wait for the request's key, then for settlement | 300 s, twice | possibly large: the daemon allows settlement up to 4 minutes |
| 8. Teardown | Stop Tor, check the route is gone, stop processes | 190 s probe, 13 s grace | seconds normally |

Today the reply is returned only after stages 7 and 8 (`consult-transport-zkapi.ts`, "runs to completion even if the caller cancelled"). The worst case is well over 15 minutes; there is no overall cap.

Speed options and their privacy cost:

| Option | Saves | Privacy cost | Verdict |
|---|---|---|---|
| **Release the reply at stage 6;** settle and tear down in the background, holding the lease and the fence until done | all of stages 7–8 from the user's wait | **none**: the request was already sent; settlement is bookkeeping | **Recommended** |
| **Warm up during the writer:** start stages 1–4 at the seal, send at stage 5 only if the gate passes, else tear down (nothing reserved, nothing charged) | up to the writer's 25–50 s | **none to positive**: the local network sees Tor start for every triggered answer, whatever the verdict. The zkAPI operator sees some warm-ups with no request | **Recommended** |
| Seed each throwaway Tor with the public directory cache (fresh guards and state, cached consensus) | most of stage 2's download | very low: the consensus is public and signed. Needs proof that Tor accepts it | Try after measurement |
| Keep Tor running between consults, new circuit per consult | all of stage 2 | **real**: one guard sees every consult's timing; something listens on the relay port between consults, losing today's fail-closed property; the daemon refuses SOCKS isolation, so a new circuit depends on a rate-limited new-identity signal | Rejected |
| Keep one daemon running between consults | stages 3–4 | **real**: a long-lived daemon with a network route between consults; today's transport refuses a running daemon (`daemon_already_running`) on purpose | Rejected for now |
| Shorter replies (cap the outside model's output) | seconds | none | Do it; small |

Measurement plan (no live timing exists today):

1. **Stage timers in the receipt.** The transport records milliseconds for each stage above, plus `replyReleasedMs` and `settledMs`. The orchestrator adds `writerMs`, `gateUs`, `routeWaitMs`, `rewriteMs` and `baselineToImprovedMs`. Content-free, in the existing timing log line.
2. **Z1-live run.** Ten real consults through the owner's funded daemon over Tor, synthetic questions, on the owner's Mac. Report median and worst per stage.
3. **Decision rule.** If Tor bootstrap is over a third of the total, try the seeded cache. If policy warm dominates, raise it with the daemon fork (§Z.6) or upstream. Re-measure after each change.

Expected user-visible wait after the baseline, on zkAPI with the recommendation: writer 25–50 s overlapped with warm-up, then completion, then rewrite (30–100 s for a summary). **Unknown until measured;** the reference total of 3–4.5 minutes is the ceiling we expect to beat, not a measured result.

### A.9 Settings, strict mode, and turning it on

**Decision: consult settings live in a new file, `~/.olympus/consult.json`, read at each consult. Changing them never restarts the worker. They are changed only on the Mac: the local dashboard (control session) or the `olympus consult` command. Never from ChatGPT, an agent tool, or the relay.**

- **Contents:** `{v: 1, revision, enabled, route: "<consult profile id>", languages: ["en", "pt-BR"], domains: {…}, strict: false}`. Writes use a revision compare-and-swap, as `privacy.json` does.
- **The route's own settings** (the zkAPI profile: Tor port, acknowledgements, optional daily caps) stay in `sovereignty.json` as today. Creating that profile restarts the worker once, at setup, never while answering.
- *Rejected: adding consult fields to `sovereignty.json`, because every toggle would restart the worker and drop every in-memory answer.*
- *Rejected: a ChatGPT setup tool to turn it on, because it would let a hosted agent switch on egress, and it would tell ChatGPT that this user consults (which helps timing correlation). The ChatGPT dashboard shows nothing about outside help.*

**Strict mode (opt-in, off by default).** Each consult waits for the owner's approval in the Mac dashboard. The approval binds the exact question (by digest), the route, the job, the settings revision and an expiry (the job's expiry), and is rechecked just before sending; any change voids it. The panel's "looking" line reads "Waiting for your approval on your Mac." No warm-up starts until approval. *Rejected: approving in the panel, because the panel runs inside ChatGPT's page.*

**Turning it on, fewest steps (zkAPI):**

1. In a terminal, install and fund `zkapi-clientd` with its own guided tool, and install Tor. (Unavoidable for now: Olympus holds no power to move funds.)
2. In the Olympus dashboard on the Mac, open **Outside help**. Olympus detects the daemon and Tor and creates the route.
3. Read the cost sheet (§A.10), tick the acknowledgements, press **Turn on**. Languages are prefilled from the Mac's language plus English.

On the Venice route (after track E), step 1 disappears: the user's existing Venice key is enough.

### A.10 Costs, stated up front

**Decision: no cap by default. The cost sheet is shown before turning on and in the dashboard card.**

- **Each outside question can cost up to $6** from the zkAPI balance. Olympus counts the full $6 per consult, the worst case across models; the model's actual allowance is $1–$6.
- **At most one consult per private answer you open,** and only when the answer from your documents is incomplete. One consult at a time per Mac.
- **No daily limit unless you set one** (requests per day, or worst-case dollars per day).
- **Your deposit is the hard limit.** Olympus can never spend more than the note holds.
- **Fixed costs dominate:** deposit fee (median about $7 at review), withdrawal fee, and the 30-day expiry after which unspent balance becomes claimable by the operator (§Z.3).

### A.11 The consult record

**Decision: each sent consult becomes one Private item** (the sub-questions, the reply, the route label, the time) in the Private store, **embedded and searched like any other Private item.** No dashboard view of it. Covered by export and delete like other Private data.

- Its provenance names it as "outside model reply", so a later answer that cites it says so.
- A refused or skipped consult stores nothing but a content-free count.
- It is written through a thin `SourceConnector` that publishes each record with a Private classification signal; nothing downstream changes.
- Risk to note: a hostile reply becomes searchable evidence. The provenance label is the mitigation; the eval (§A.15) includes it.

### A.12 Contract impact on the panel path: none

**Decision: the panel stages change no versioned contract.** The fingerprint (`scripts/contract-version.ts`) covers only types reachable from `src/core/contracts.ts` (which imports `source-index/types.ts` and `opsec.ts`); the ledger is at 2.0.0.

Seams used, all non-versioned:

| Seam | File | Change |
|---|---|---|
| `PrivateAnswerPlaintextV1` | `src/workers/chatgpt/private-answer-contract.ts` | optional `rev`, `followUp`, `outside` |
| `PrivateAnswerModel.answerPrivately` options; `PrivateAnswerModelCall.stage` | same file | optional `outsideReply`; stages `writer`, `rewrite` |
| `PrivateAnswerJobs` | `src/workers/chatgpt/private-answer-jobs.ts` | revisions, follow-up, consult work in the queue, TTL |
| `AnswerPrivatelyOptions` | `src/core/analyst-built-in.ts` | `outsideReply` selects the rewrite composer |
| `BuiltInAnalystModel.complete` | same file | direct calls for writer and rewrite, through the guard |
| New: `ConsultRoute`, orchestrator, settings | `src/core/consult-route.ts`, `src/workers/chatgpt/private-answer-consult.ts`, `src/core/consult-settings.ts` | new modules |

**The rewrite is not an `Analyst.analyze` call.** It is a panel-only composer that reuses the Analyst's evidence rendering and citation checks as library functions. So the `Analyst` rule "answer from this evidence only" keeps holding for every `Analyst`. The improved answer cites only evidence; the reply is presented to the model as untrusted outside background, never as evidence, and the panel labels the result.

### A.13 Later stage: OpenClaw `source_answer`

**Decision: after the panel path is measured and evaluated.** It needs:

- A **versioned, semantic `Analyst` contract change** (an optional consult proposal on the result, an optional outside-background input), through the contract-evolution gate with its held-out receipt.
- **Review blocker 1 (section D):** the anonymous route may be offered only where the Private result stays out of the calling agent's view; otherwise it is labelled payment privacy only, and `include_secure_local_content` cannot override that.
- The secure-pool interaction (frozen member, separate error domain) from revision 4 §A.2.

### A.14 Packaging and public surface

| Item | Work | Note |
|---|---|---|
| Vocabulary packs | Add all 20 files (10 `.txt.gz`, 10 `.LICENSE.txt` under `assets/consult/vocabulary/`) to `V0_4_PUBLIC_PACKAGE_FILES` **one by one** | Without them a packaged install refuses every consult (`vocabulary_unavailable`). Adds about 11.2 MB; Brazilian Portuguese alone is 6.6 MB |
| Gate reachability | Land the gate with its first caller (a doctor line reporting pack status, as the transport is reached through `doctor.ts`) | Otherwise `test/public-surface-guard.test.ts` fails; no allowlist entry |
| Pack paths in the bundle | Prove the gate finds `../assets` from `dist/` | Fixture test in `test/release-qualification-plan.test.ts` |
| German and Italian | `scripts/install-consult-language-pack.ts` is needed only for user-installed packs | Ship it only when those languages are offered |
| Writer rules | A constant in `src/` (like the Analyst's own prompt), with the approved text as narrative in `docs/design/consult-writer-instructions.md` | Not a skill: skills are what the calling agent sees |
| Panel changes | **`src/workers/dashboard/chatgpt/private-answer.ts` is inside the dashboard design-receipt guard.** `config/dashboard-design-review.json` lists `src/workers/dashboard` in both `reviewed_visual_paths` and `implementation_guard_paths`, and `test/dashboard-design-review.test.ts` digests every file under it | Any panel change must update `implementation_guard_sha256` and keep the receipt `pending_owner_acceptance` with a reason that says the states "await owner acceptance" |
| Mac dashboard card | Same guard (same directory) | Same receipt update |
| Relay | No change | `connect-relay/` is untouched |

### A.15 Eval

On synthetic Private corpora, with thresholds and sample sizes fixed before the run:

- `eval/consult-leak`: planted identifiers (must be zero), multilingual (including Brazilian Portuguese), encoded and adaptive leakage; false-refusal rate.
- Sensitive-attribute inference by an attacker who already knows the account; sequences of consults over time; timing correlation with the ChatGPT request.
- Hostile replies: injection into the rewrite, and a stored reply later retrieved as evidence.
- **Answer-quality lift on incomplete baselines.** No lift, no default-on.
- Latency per stage (§A.8) and cost per consult.
- The held-out eval (`eval/`) wherever shared answer code changes (`analyst.ts`, `analyst-built-in.ts`).

### A.16 Build plan

Small pull requests in dependency order. "Critical (path)" means `config/change-risk.json` classifies it critical by the files it touches. "Critical (declared)" means it carries egress or trust-routing behavior, so it is declared critical (a declaration may raise risk, never lower it) and gets an independent review receipt.

| # | Delivers | Proof | Risk |
|---|---|---|---|
| **C1** | Gate and packs on `main`; doctor line; 20 package entries; writer-rules text updated for automatic mode | Gate tests; `eval/consult-leak`; public-surface guard; packaged-path fixture; gate timing test | Critical (path: `src/core/public-surface.ts`) |
| **C2** | `ConsultRoute` interface; zkAPI adapter with `prepare`/`send`/`cancel`, reply released before settlement, stage timers | Stand-in daemon tests: cancel before send reserves and sends nothing; fence stays held until settlement; busy refuses at once; timers present | Critical (declared) |
| **C3** | `consult.json` and the `olympus consult` command; no worker restart on change | Settings tests; a test that no MCP tool, setup tool or relay path can change it | Critical (path: `src/cli.ts`) |
| **C4** | Jobs engine: revisions, follow-up answer, fixed-size fresh seals, 30-minute TTL, consult work in the queue with preemption, guards G1–G7; writer and rewrite composer; a fake route only | Tests: no extra model call before the first seal; preemption order; each guard site called and failing closed; withdrawal on guard failure; abort-to-free latency measured; held-out eval | Critical (declared) |
| **C5** | Panel: follow-up poll, states, "Show original answer", "What Olympus asked" | Panel tests; preview of each state; design-receipt update; owner visual acceptance | Standard (path), receipt-guarded |
| **C6** | Mac dashboard **Outside help** card: cost sheet, languages, strict mode, approvals, fence Recover/Abandon | Dashboard tests; design-receipt update; owner visual acceptance | Standard (path), receipt-guarded |
| **C7** | Wire the real route; consult record connector; Z1-live measurement; §A.15 eval | Ten-consult timing report; eval results reviewed by the owner before default-on | Critical (declared) |
| C8 | Speed follow-ups chosen by the measurements (seeded Tor cache) | Before/after stage timers | Critical (declared) |
| **F1** | *Only if the owner approves the fork (§Z.6).* Fork repository and pipeline: pinned upstream tag, patch, tests, pinned Go, two-build hash match, upstream companion checked against its manifest, licence notices and modified-source statement, published hash | Reproducible hash from two clean builds; patch tests; upstream tests pass | Critical (declared; release provenance) |
| **F2** | *After F1.* Transport switches to the fork: download on enable, pinned by hash; start with the four flags; exact-port sandbox profile (API, proxy, wallet API, Tor); compare `/admin/status` `transport` with what was requested and refuse on any difference; label becomes "confined to this session's Tor listener" | Stand-in daemon tests for each mismatch; sandbox self-test denies an unlisted loopback port, a non-loopback address and DNS; label tests | Critical (declared) |
| C9 | Venice end-to-end encrypted route adapter | After E1–E3 | Critical |
| C10 | OpenClaw `source_answer` stage (§A.13) | Contract gate, held-out receipt | Critical (path: `contracts.ts`, `analyst-answer.ts`) |

Any change to `src/core/sovereignty.ts` is critical by path (the term "sovereignty"); this plan avoids one until C9.

---

## Track Z — zkAPI as the experimental anonymous-payment route

### Z.1 What it is

zkAPI (Ethereum Foundation with the Open Anonymity Project, mainnet since 2026-09-30) lets a user deposit ETH into a vault and then make model requests that the payment side cannot tie to the deposit. A local daemon, `zkapi-clientd`, serves an OpenAI-compatible API on loopback.

- **Who reads prompts:** OpenRouter and the upstream model. zkAPI hides who paid, not what was asked.
- **Who sees what else:** the zkAPI server sees per-session spend and, without Tor, the IP address.
- **Linkability:** spending is sequential and the anonymity set was about 70 notes at review, so timing can link consecutive requests.

### Z.2 Use, and the standard it must meet

zkAPI in Olympus has one use: **the transport for a consult**, whose content was written on-device to reveal as little as possible. It is not a way to pay anonymously for ordinary cloud answers (withdrawn in revision 4).

The reference practice (`tor-remote-research.md`, ethereum/zkapi PR #16), adopted as requirements:

| Layer | Reference | Olympus |
|---|---|---|
| Content | A local model writes every prompt; no private content, no user wording, no documents; decompose, generalize, use bands | On-device writer only (§A.3); gate (§A.4) |
| Payment | zkAPI | zkAPI, key reuse verified off |
| Network | Tor, new identity per request | Throwaway Tor per consult; the strong label requires verified confinement (§Z.6) |
| Failure | Never fall back to a direct connection | A failed consult is never resent another way; the baseline stands |
| Pace | Sequential, 3–4.5 minutes, never kill a slow call | One at a time; off the slot; reply released before settlement (§A.8) |

### Z.3 The money, plainly

| Cost or risk | What happens |
|---|---|
| **Deposit fee** | An expensive on-chain transaction (about 6.7M gas; median fee about $7 at review) |
| **Withdrawal fee** | A second expensive transaction, needing more ETH for gas |
| **30-day expiry** | An unwithdrawn note becomes claimable in full by the operator |
| **No top-up** | Each deposit is a new note with its own fee and clock |
| **Operator risk** | One account can pause deposits and withdrawals while the clock runs; single-party proof setup |
| **Local risk** | The balance is controlled by files on this computer |
| **Per consult** | Up to $6 reserved (§A.10) |

A deposit is, in practice, non-refundable prepaid credit.

### Z.4 Guards: shipped in Z1 (#144), and still open

Shipped (dormant): consult-only profile, refused for every evidence-carrying role; risk acknowledgements (version 3, including the $6 per consult and "no default limit"); expiry estimate from the funding date the owner confirms, with notices at 10, 5 and 2 days; optional daily request and spend caps; one-at-a-time lease and the fence; daemon identity and inference-key checks; key reuse verified from the daemon's log; throwaway Tor per consult; macOS sandbox with a self-test; never retried, never downgraded; Olympus holds no management credential and never moves funds.

Still open: no live fee quote, balance or on-chain expiry (no permitted data path without the management credential, so these are "declared", not "verified"); release integrity of the daemon (prerelease, SHA-256 only); measured latency (§A.8); route verification (§Z.6, fork awaiting owner decision).

### Z.5 Phases

| Phase | Delivers | Done when |
|---|---|---|
| **Z1** (shipped, dormant) | Transport, guards, ledger, doctor | Merged (#144) |
| **Z1-live** | Ten real consults over Tor with stage timers (part of C7) | Owner funds a daemon; timing report recorded |
| **Z2** | Dashboard-driven funding and withdrawal | Only after upstream ships scriptable `fund`/`withdraw` and a separate owner ruling |

### Z.6 Route verification: fork vs upstream

**Recommendation: a small, pinned fork of the daemon. RECOMMENDED BUT AWAITING OWNER DECISION (not yet approved).** The upstream issue remains unposted. Until the owner decides, the macOS label stays "route not verified". Prototype files: `~/Code/Claude/zkapi-fork/` (`olympus-supervisor-flags.patch`, `README.md`, `poc/run-poc.sh`, `poc/zkapi-loopback.sb.in`, `poc/run-poc.out`).

**The problem.** The daemon takes its relay endpoint only from its saved configuration, which also holds the bridge token that authorizes withdrawals, so Olympus must not read it. Its companion reaches the network through a CONNECT proxy on a random loopback port. A sandbox profile is written before start, so it cannot name that port, and the only workable macOS rule is "any loopback port", which lets any local proxy act as an escape.

Two corrections to earlier text (including `zkapi-upstream-proposal-draft.md`): the wallet API port is already fixed by the configuration's `client_url` (default `127.0.0.1:8790`); the problem is only that a supervisor cannot learn it without reading the file that holds the token. And the sandbox must also allow the daemon's own API port, because its readiness check connects to itself.

**What the fork is.**

- A Go-only patch against `ethereum/zkapi` at `045b444` (clientd-v0.1.6 is an ancestor). Five production files, +98/−8; three new test files, +146. It applies cleanly to v0.1.5, v0.1.6 and current main. With no flags, `serve` behaves exactly as upstream, and upstream's full test suite passes with the patch.
- Four opt-in `serve` flags, all checked before any socket opens:
  - `--relay-url`: the relay for this run only, in memory, never saved;
  - `--companion-proxy-listen 127.0.0.1:PORT`: bind the CONNECT proxy exactly there, and exit if that fails (no fallback to a random port);
  - `--wallet-api-listen 127.0.0.1:PORT`: the wallet API address, in memory;
  - `--require-managed-companion`: refuse an external companion.
- `/admin/status` gains a `transport` block: kind, relay endpoint, companion (managed or external), wallet API, CONNECT proxy. No credentials or wallet state.
- **Custody is unchanged.** No key, wallet or contract code is touched. The Rust companion (`zkapi-walletd`) and the proving files are upstream's unmodified release, checked against upstream's published hashes.
- **Build:** about 5 s cold with Go 1.27.1, 9.69 MB, byte-for-byte reproducible across three builds (including a different path). No Rust toolchain needed.

**What the prototype showed** (real patched daemon, stand-in companion and Tor, offline, under `sandbox-exec`): the profile denies all network access except loopback ports for the daemon's API, the CONNECT proxy, the wallet API and Tor's SOCKS port. The daemon reached Ready and `/admin/status` reported exactly the requested ports. Every other loopback port (live or unused), every non-loopback address and DNS were refused, for the daemon and its child. Without the sandbox the same probes succeeded. An occupied proxy port made the daemon exit; a profile missing the proxy port made it fail to bind.

**What the label can then say on macOS:** "network confined by the operating system to this session's Tor listener". Precisely:

- **Proved:** for this session, the daemon and its child processes could open network connections only to the four named loopback ports, and the only one of those that leads off the machine is the SOCKS port.
- **Proved because Olympus started it:** that the SOCKS listener is Tor. Olympus launches that Tor itself and checks the port's owner before and during the session; the sandbox alone would not prove what listens there.
- **Not proved:** that Tor's circuits are unlinkable, anything about timing or content correlation, or anything about a different user's processes. The sandbox is one profile over the whole process tree, so the companion can also reach Tor and the daemon's API port; a stricter nested profile is not possible. Seatbelt's host filter accepts only `localhost` or `*`, so "loopback" cannot be narrowed further. `sandbox-exec` is deprecated by Apple and could disappear.
- **Residual, unchanged from upstream:** the daemon sends the bridge token to the wallet API port during readiness, so a process that grabs that port first receives it. The sandbox cannot stop that; Olympus's existing port-ownership checks reduce it. The `api_key` needed to read `/admin/status` also lives in the daemon's configuration; Olympus uses the inference key the owner gives it.

**Licences.** `zkapi-clientd` is MIT (Open Anonymity Team). The Rust crates declare MIT OR Apache-2.0 but ship no licence file. go-ethereum v1.17.5 (LGPL-3.0) is statically linked. A published fork binary must carry upstream's third-party notices, the MIT licence, and a statement that the source was modified, pointing to the patch.

**Maintenance.** Upstream moves fast (67 commits in two weeks; seven client releases between 30 September and 1 October). The patch touches `main.go` and `config.go`, which change often, so expect occasional small hand rebases. Pipeline: pin the upstream tag and commit → apply → run the tests → build with a pinned Go → require the same hash from a second clean build → reuse upstream's companion, checked against its release manifest → publish the hash, the patch, the Go version and the upstream commit. Signing and notarization for a Developer ID app are unchecked.

**Delivery:** downloaded when the user turns zkAPI on, pinned by hash, not in the Olympus package.

**Alternatives rejected:**

- A `DYLD` interposer that fixes the bind: works, but is fragile and stripped by the hardened runtime.
- A local forwarder in front of the random port: does not help, the random port still has to be allowed.
- The "any loopback port" rule: today's state; any local proxy is an escape.
- Running the daemon in a Linux VM: too heavy.
- Waiting for upstream: the issue is not being posted for now; if upstream later ships equivalent flags, the fork retires.

Nothing in track A depends on this decision.

---

## Track E — Venice end-to-end encryption, at full verification only

### E.1 Why

With an end-to-end encrypted model the client encrypts the prompt, Venice relays ciphertext, and a hardware enclave decrypts it. The weak versions protect nothing: checking only a report's fields lets a relay fabricate it, and checking only Intel's signature lets an attacker present a genuine enclave they control. There is one acceptable level.

It matters twice: as a Private answer lane, and as **the fast consult route** (§A.7), seconds instead of minutes.

### E.2 What the adapter must verify before sending

1. The Intel quote's signature chain and platform status, on the client.
2. The fresh nonce and the enclave's key bound in the report; debug off; the model matches.
3. **The workload is one Olympus recognises,** from the attestation's source provenance, against a pin list Olympus maintains. Unknown refuses.
4. **Positive proof that encryption is on.** The same `e2ee-*` ids also serve a plaintext mode. Any plaintext chunk is a hard failure.
5. **The reply is bound to the request,** or its signature verifies (open, §E.4).

A failure refuses with a typed error and never falls back to plaintext Venice.

### E.3 Constraints

Evidence and instructions only in `user` and `system` messages (assistant turns go in the clear). Two verifiers (Phala and NEAR formats). Text models only. Built from Venice's published guide on MIT-licensed primitives; the GPL-3.0 client libraries are protocol references only.

### E.4 Limits and open items

Token-length side channel; metadata (account, model, sizes, timing, IP) visible to Venice; trust moves to Intel, NVIDIA, image builders and Olympus's pin list. Open with Venice: reply-key binding, response signatures, the Phala gateway's downstream hop, JSON output under encryption. A stale pin means refusals, not leaks.

### E.5 Phases

| Phase | Delivers | Done when |
|---|---|---|
| **E1** | Verification library, both formats, pin list, no dispatch | Tampered, debug, replayed, unknown-workload and plaintext cases refuse |
| **E2** | Answers to §E.4 from Venice | Reply binding or signature verification specified |
| **E3** | Analyst adapter as a Private posture and secure-pool member; consult route adapter (C9) | Held-out eval green on that lane; the dashboard states what was verified |

The product may say "end-to-end encrypted" only when E.2 steps 1–5 all hold.

---

## 10. Decisions needed from the owner

1. **Wording.** May "Private content never reaches an ordinary cloud model" become "…the evidence never does; with outside help on, the on-device model may send a short general question it wrote"?
2. **Where outside help is switched on.** This proposal says the Mac only (dashboard or command), never from ChatGPT (§A.9). That costs the user a trip to the Mac once.
3. **Fence recovery.** This proposal makes Recover a button the owner presses, because it spends up to $6. Automatic recovery would remove a step but spend without asking.
4. **Trigger.** This proposal consults only when the baseline is incomplete. Always consulting would cost more and add little.
5. **Daemon fork (§Z.6).** Approve a small, pinned, reproducibly built fork of `zkapi-clientd` (four opt-in flags, custody untouched), downloaded on enable, with the maintenance it implies. Recommended. Without it, macOS stays "route not verified".
6. **Package size.** Ship all ten packs (about 11.2 MB, 6.6 MB of it Brazilian Portuguese), or only English and Brazilian Portuguese.
7. **Windows.** A 30-minute job lifetime and a 20-minute follow-up window when outside help is on.
8. **Track E pin list:** accept that Olympus maintains it, with refusals when it goes stale.

## 11. Not proposed

A local model as the user's main agent; Olympus-managed funding or any key that can move funds (until a Z2 ruling); a consult queue; a self-check model call; approval prompts outside strict mode; sending any `EvidencePack`, raw or redacted, to an outside model; any change to how Secrets are handled; a relay change.

## Appendix: code references (main at `bb1755fb` unless named)

- Jobs engine: `src/workers/chatgpt/private-answer-jobs.ts` — deadlines :322 (100 s), :330 (240 s); dedupe :332; precompute window :334; claim hold :336; `begin` :462; `claim` :514 (one sealed outcome, same bytes each POST :545–555); `stillReleasable` :597; queue `next` :763, `pump` :788; `run` :796 (dispatch guard :834); `startClaim` :893 (claim deadline :926, recompute once :979, `stillReadable` :999–1013, `settle` detaches the analysis :915); reset :1065; HTTP handler :1298–1320 (parses body, `v === 1`).
- Contract: `src/workers/chatgpt/private-answer-contract.ts` — TTL :27; meta :50; plaintext :102; observer stages :131; `PrivateAnswerModel` :146; guard :170; `checkPrivateEvidence` :176.
- Seal: `src/workers/chatgpt/private-answer-crypto.ts` — fresh engine key and IV per seal; pad buckets 1, 4, 16, 64 KiB.
- Panel: `src/workers/dashboard/chatgpt/private-answer.ts` — poll caps :81, :83; request timeout :85; key store one day :87–95; `readAnswer` ignores unknown fields :407; `collect` returns on reveal :545–565.
- Relay: `connect-relay/shared/private-answer.ts` path pattern :27, body cap 512 :31, statuses :87; `connect-relay/server/relay.ts` forwards the body opaquely :697–728; per-address bucket `limits.ts:157` (30, 1/s).
- Panel model: `src/workers/chatgpt/private-answer-model.ts` — limits :165–182; guarded `complete` :300–314.
- Built-in: `src/core/analyst-built-in.ts` — request timeout :60; JSON schema :316–322; `max_tokens` :382; `AnswerPrivatelyOptions` :448; stage type :473; `answerPrivately` :495; `withVerdict` reads a raw field outside `AnalystResult` :554; `timedModel` labels later calls `audit` :646. llama-server `--parallel 1`: `src/workers/source-index/built-in-reasoning/server.ts:131`.
- Contract fingerprint: `scripts/contract-version.ts` (graph from `contracts.ts`, which imports only `source-index/types.ts` and `opsec.ts`); ledger `config/source-pipeline-contract-version.json` at 2.0.0.
- Transport: `src/core/consult-transport-zkapi.ts` — reference port notes :14–40; $6 :94; `daemon_already_running` :1436; session :1570ff; completion, settle and teardown :1822–1880. Settings: `src/core/zkapi-consult-settings.ts` — defaults :38–54; acknowledgements :62–98; bounds :140–147.
- Gate (branch `claude/consult-outbound-gate`): `src/core/consult-gate.ts` — verdict is private :99; limits :115–155; packs :840–851; languages :857–868; domain defaults :884–896.
- Risk: `config/change-risk.json` (exact paths, prefixes, path terms); design receipt: `config/dashboard-design-review.json`, `test/dashboard-design-review.test.ts:143, :184–198`.
- Package list: `src/core/public-surface.ts:248–293`.
- Measured speed: `docs/design/private-model-benchmark.md:96–103`; `docs/design/chatgpt-plugin.md:494–499` (ChatGPT reply 30–50 s, panels queued 44–58 s), :622 (compact prompt about 1,600 tokens), :648–653 (full detail 179.4 s).

## Sources

- Review record: [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md)
- Vitalik Buterin, self-experiment post, 2026-10-04: <https://x.com/VitalikButerin/status/2106537633056969024>
- Self-sovereign LLM setup essay, 2026-04-02: <https://vitalik.eth.limo/general/2026/04/02/secure_llms.html>
- Reference request rules (`tor-remote-research.md`) and Tor wrapper: <https://github.com/ethereum/zkapi/pull/16>
- zkAPI daemon privacy boundaries: <https://github.com/ethereum/zkapi/blob/main/zkapi-clientd/docs/PRIVACY.md>
- zkAPI repository and scriptable funding PR: <https://github.com/ethereum/zkapi>, <https://github.com/ethereum/zkapi/pull/19>
- Introducing zkAPI, 2026-10-01: <https://blog.ethereum.org/2026/10/01/introducing-zkapi>
- Venice privacy modes: <https://docs.venice.ai/overview/privacy>
- Independent Venice E2EE client (protocol reference only, GPL-3.0): <https://github.com/jooray/venice-e2ee>
- Token-length side channel: <https://arxiv.org/abs/2403.09751>
