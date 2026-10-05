# Design: frontier consult, anonymous cloud transport (zkAPI), and Venice end-to-end encryption

Status: **proposal, revision 3 (2026-10-05). Not approved for build.** Rewritten to answer the adversarial review in [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md). Nothing here changes shipped behavior or the release plan until the owner rules on §10.
Risk class: **Critical** for every track: trust routing, a hard invariant, and (track A) the `Analyst` contract.

Terms: Private = S4 = `secure_local`. "Secure analyst" = a secure-pool member (loopback local model or Venice Private/TEE). "Frontier model" = any `standard_cloud` model. "Consult" = one outbound question, written by the secure analyst, that carries no evidence.

This document now holds three tracks that can ship independently:

| Track | What the user gets | Depends on |
|---|---|---|
| **Z. zkAPI transport (experimental)** | Pay for Olympus's ordinary cloud analysis anonymously | Nothing in A or E |
| **E. Venice end-to-end encryption** | A Private answer lane where Venice cannot read the evidence | Nothing in A or Z |
| **A. Frontier consult** | Frontier help on Private questions through an approved, derived question | P0 fixes; optionally Z as a transport |

---

## 1. Owner direction (settled; not review questions)

- **Tiers are the product.** Users decide what may go to cloud models. Personal content reaching frontier models and cloud embeddings is by design.
- **Olympus is not trying to be fully decentralized.** The relay and publisher apps are accepted central points.
- **zkAPI ships as a usable experiment** even with known upstream issues, with clear guards so users do not lose money unknowingly, and plain disclosure of what they pay for. Users are expected to have a crypto wallet. No wallet-abstraction service, no card checkout.
- **Venice end-to-end encrypted models become a first-class Private option.**
- **The three shipped-code gaps the review found are being fixed now**, as their own pull requests, independent of this proposal (§3).

## 2. Position against the release plan

- **Not v0.4.** v0.4 freezes the contracts and its scope is the seven-source cited-answer journey. No register row changes.
- **Proposed slot:** v0.5 candidates. Track Z is small and can land first as an experimental advanced setting. Track E and track A are larger critical changes.
- **If approved**, the first build pull request of each track adds a dated decision to `V0_4_RELEASE.md` and a v0.5 candidate line.
- **Rules that change, by track:**
  - Z: none. zkAPI is a new `standard_cloud` transport and may never receive Private evidence.
  - E: the `e2ee-*` secure-pool refusal (`src/core/sovereignty.ts:891`, `CONTRACTS.md` Venice S4 policy, `SOVEREIGNTY_CONFIG.md` hard invariants) becomes "refuse unless verified for this request".
  - A: README "secure content never routes to ordinary cloud models"; `CONTRACTS.md` Venice S4 policy item 3; the Analyst note "answer from this evidence only" (`CONTRACTS.md:188`).

## 3. Current state (corrected by the review)

- **A redacted escalation exists and is never dispatched.** `Analyst.analyze` may return `escalation: { reason, redactedPack }`. It is emitted today and read in three places (`src/workers/source-index/analyst-answer.ts:1350`, `:1868`, `:1922`); the outcome is a coverage gap or `needs_approval`. No code sends a `redactedPack` to a model. The trigger is structural (citation checks on the model's output), not a judgement that evidence is insufficient.
- **The redacted pack is not a safe consult payload.** It keeps the user's question verbatim, every candidate's provenance, table captions and columns, coverage strings, score and build time (`src/core/analyst.ts:965-988`).
- **Private answers reach the calling agent by default** as bounded derivatives; strict mode (`OLYMPUS_SECURE_DERIVATIVE_DEFAULT=approval`) restores approval, and `include_secure_local_content: true` overrides it.
- **Gaps in shipped code, being fixed separately:**
  1. The release gate takes sensitivity from cited candidates only, so a Private fact cited to a Public item releases even in strict mode (`analyst-answer.ts:1866`, `:2166`).
  2. Local trust is an address check, for analyst, embedding, vision and classification endpoints alike (`src/core/sovereignty.ts:725-744`, `embeddings.ts:1030`, `remote-vlm.ts:184`). Olympus cannot verify what a loopback process forwards; the fix blocks redirects, refuses known cloud-forwarding model ids, and documents that locality is owner-asserted.
  3. Chat requests to model endpoints follow redirects (`src/core/analyst-openai.ts:125`).
- **The `e2ee-*` refusal lives in the secure-pool gate** (`sovereignty.ts:891`); the lower-level Venice category gate accepts E2EE (`src/core/venice-models.ts:157`).

---

## Track Z — zkAPI as an experimental anonymous cloud transport

### Z.1 What it is, from the code and the chain (not the announcement)

zkAPI (Ethereum Foundation with the Open Anonymity Project, mainnet since 2026-09-30) lets a user deposit ETH into a vault and then make model requests that the payment side cannot tie to the deposit. A local daemon, `zkapi-clientd`, serves an OpenAI-compatible API on `127.0.0.1:8787`.

- **Who reads prompts:** OpenRouter and the upstream model it routes to. zkAPI hides who paid, not what was asked.
- **Who sees what else:** the zkAPI server sees per-session spend and, without Tor, the IP.
- **Linkability:** by default requests within a 60-second window share a key and are linkable to each other. Spending is sequential. About 70 notes existed at review time, so the anonymity set is small.

### Z.2 What Olympus uses it for

A new sovereignty provider kind, `zkapi`, with trust fixed at `standard_cloud`. It is a named type, so it can never be registered as a local model and can never be a secure-pool member, whatever address it listens on.

- **First use (ships with track Z):** an optional transport for the ordinary cloud analyst, for Public and Personal questions. The user's cloud analysis is paid for without an account.
- **Later use (track A):** an optional transport for consults.

On timeout or failure Olympus falls back to the user's normal cloud analyst. That fallback carries the same Public/Personal content to the same trust class, so it is not a privacy downgrade; the answer notes that the anonymous transport was not used.

### Z.3 The money, plainly

This is what a user must understand before sending anything. The dashboard shows it as a required acknowledgement, with live numbers.

| Cost or risk | What happens | Observed at review |
|---|---|---|
| **Deposit fee** | Depositing is an expensive on-chain transaction (about 6.7M gas). | Median fee about $7; one launch-day deposit paid far more |
| **Withdrawal fee** | Getting unspent money back is a second expensive transaction (about 7M gas), and needs more ETH sent for gas. | Similar to the deposit fee |
| **30-day expiry** | A note that is not withdrawn within 30 days is forfeited in full to the operator's treasury. | On-chain `noteTtl` = 30 days |
| **No top-up** | Each deposit makes a new note with its own fee and its own 30-day clock. | — |
| **Operator risk** | One ordinary account can pause deposits and withdrawals while the expiry clock keeps running. The proof system's setup was done by one party. Funds could be frozen or lost. | Vault owner is a single key |
| **Local risk** | The balance is controlled by files on this computer. Losing them loses the money. | — |

Put together: **a deposit is prepaid credit that is, in practice, not refundable.** Withdrawing a small remainder costs more than it returns, and an unused balance disappears after 30 days. A sensible deposit is an amount the user expects to spend within a month and is willing to lose. With fees around $7, a deposit under about $20 mostly pays fees.

### Z.4 Guards

1. **Experimental label and acknowledgement.** The setting is under advanced model settings, marked experimental. Turning it on requires ticking a short list that states the six rows above in plain words.
2. **Live fee estimate before funding.** The setup page shows the current estimated deposit fee and warns in red when the fee exceeds 25% of the intended deposit.
3. **Suggested range and a soft ceiling.** A suggested deposit range (proposed $20–50) and a warning above the ceiling (proposed $100). Olympus cannot enforce an amount the user sends from their own wallet; it can refuse to mark the setup "recommended".
4. **Expiry clock.** Olympus records the funding date the user confirms and shows the expiry date and days left wherever the balance or transport status appears. It raises a dashboard notice at 10, 5 and 2 days left, saying either "spend it" or "withdraw now, it will cost about $X".
5. **Olympus never holds the power to move funds.** In the first version Olympus does not use the daemon's management token. Funding and withdrawal happen in the daemon's own interactive tool, run by the user. No agent tool, remote connection, or relay path can reach a wallet action, because Olympus has none.
6. **The funding address never comes from Olympus's screen.** The user reads it in the daemon's own terminal session. This removes the port-squatting attack in which a rogue local process shows a fake address in the dashboard.
7. **Daemon identity check.** Before using the endpoint Olympus checks the listening process and the model list, and refuses if something other than the expected daemon is on the port.
8. **Require a local API key and key-reuse 0.** Olympus configures a daemon API key where supported, so other local processes cannot spend the balance, and checks that the key-reuse window is 0. If reuse is on, the setting shows "requests are linkable" and is not marked anonymous.
9. **Honest status.** Olympus reports what it verified (endpoint up, synthetic request ok, reuse window) and what the user declared (Tor). It never displays "anonymous" or "unlinkable" as a verified property.
10. **Spend limits.** A daily request cap on the transport, so a loop or a remote agent cannot drain the balance.

### Z.5 Phases

| Phase | Delivers | Done when |
|---|---|---|
| **Z1** | `zkapi` provider kind; detect a daemon the user installed and funded themselves; guards 1–10; use as the ordinary cloud analyst transport | A fresh install with a funded daemon answers a Public question through zkAPI; every guard has a test; a non-daemon process on the port is refused; a `zkapi` profile is refused for every Private role |
| **Z2** | Dashboard-driven funding and withdrawal | Only after upstream ships scriptable `fund` / `withdraw` in a release (open as zkapi PR #19) and a separate owner ruling, because this is where Olympus would gain the power to move funds |

Measured before Z1 is called done: real latency through the daemon with reuse 0, with and without Tor. If most answers miss the interactive budget, the setting says so.

Not yet verified, to settle at the start of Z1: whether the daemon exposes the balance, the note's funding time and the reuse setting to a non-privileged local client, and whether it supports an inference API key. Where it does not, guards 4 and 8 fall back to what the user confirms, and the status says "declared", not "verified".

---

## Track E — Venice end-to-end encryption, at full verification only

### E.1 Why, and what the review changed

With an end-to-end encrypted model the client encrypts the prompt, Venice relays ciphertext, and a hardware enclave decrypts it. The review showed that the weak version of this protects nothing:

- **Checking only that the report's fields are consistent** lets a relay fabricate the report and substitute its own key.
- **Verifying the Intel signature chain alone** still lets an attacker present a genuine enclave they control.

So there is one acceptable level, and no "basic" phase.

### E.2 What the adapter must verify before any Private evidence is sent

1. The Intel quote's signature chain and platform status, checked on the client.
2. The fresh nonce and the enclave's key are bound in the report; debug mode is off; the model matches.
3. **The workload is one Olympus recognises.** Live attestations now carry source provenance (a named gateway commit for Phala-hosted models; application id, compose hash, OS image hash and an event log for NEAR-hosted ones). Olympus ships and maintains a pin list. An unknown workload refuses.
4. **Positive proof that encryption is on.** The same `e2ee-*` ids also serve a plaintext enclave mode, so the id prefix proves nothing. Any plaintext chunk in a reply is a hard failure.
5. **The reply is bound to the request**, or the response signature verifies. This is the open item in §E.4.

A failure at any step refuses with a typed error. It never falls back to plaintext Venice; the secure pool moves to its next member exactly as for any other member failure.

### E.3 Constraints on how the adapter talks

- Evidence and instructions go only in `user` and `system` messages. Assistant-role messages are sent in the clear, so the adapter sends none.
- Two verifiers are needed: Phala and NEAR return different attestation formats.
- Text models only. Private search stays keyword or local-embedding.
- Implemented from Venice's published guide on MIT-licensed primitives. The independent client libraries are GPL-3.0 and are used as protocol references only.

### E.4 Stated limits and open items

- **Token-length side channel.** Each streamed chunk is encrypted separately, so the relay sees token lengths. Stated in the product; mitigated only if Venice supports padding.
- **Metadata** (account, model, sizes, timing, IP) remains visible to Venice.
- **Trust moves** to Intel, NVIDIA, the enclave image builders, and Olympus's pin list. GPU attestation is labelled "attested by Venice" unless Olympus verifies it.
- **Open, to resolve with Venice before build:** how the reply key is bound to the request; the response-signature format; whether the Phala gateway's downstream hop is attested; structured (JSON) output under encryption.
- **Maintenance cost:** the pin list must be updated when Venice's operators ship new images. A stale pin means refusals, not leaks.

### E.5 Phases

| Phase | Delivers | Done when |
|---|---|---|
| **E1** | Verification library (E.2 steps 1–4), both formats, pin list, no dispatch | Tampered, debug, replayed, unknown-workload and plaintext cases all refuse in tests against recorded attestations |
| **E2** | Answers to the open items in E.4, from Venice | Reply binding or signature verification specified |
| **E3** | The analyst adapter, as a selectable Private posture and secure-pool member | A fresh install picks an encrypted model from setup; the held-out eval is green on that lane; the dashboard states exactly what was verified |

The product may say "end-to-end encrypted" only when E.2 steps 1–5 all hold.

---

## Track A — Frontier consult

### A.1 Outcome, restated honestly

A user who asks about Private material can get an answer that benefits from a frontier model's knowledge. To get it, **the user approves sending one question that the secure analyst wrote.** The question contains no evidence text, names or identifiers, but it is derived from Private material and may reveal something about it. It is a disclosure the owner chooses, not a de-identified message.

Olympus still never sends an `EvidencePack`, raw or redacted, to a frontier model.

### A.2 Flow

```text
source_answer
  → pack has secure_local candidates; freeze the pack and the chosen secure member
  → secure analyst pass 1 → BASELINE answer (always) + optional consult request
  → no consult requested, or consult is off          → release baseline
  → outbound gate (A.4)                    fail      → release baseline
  → owner approval of a bound envelope (A.5) deny/expire → release baseline
  → transport, one stateless request       fail      → release baseline
  → secure analyst pass 2 (same member, same frozen pack, reply as untrusted advice)
        fail                                         → release baseline
  → release: evidence-backed answer + separately labelled outside advice
```

- **The baseline always exists**, so every failure has something real to fall back to.
- **Consult errors have their own error domain.** They never count against a secure member's health, never trigger route selection, and never cause the pack to be rebuilt.
- One consult per answer.

### A.3 Two outputs, two release decisions

Pass 2 returns the evidence-backed answer with citations, and a separate block of outside advice. The release gate treats them separately. The advice block is labelled as general guidance from an outside model, carries no citations, and is scanned like any other release. An answer produced from a Private context is treated as Private-derived whether or not its citations name a Private item (the fix in §3 item 1 makes this true for all answers).

### A.4 Outbound gate

Runs in a shared policy module in the worker, outside the Analyst. It is generic policy mechanics: no question or domain classifiers, and it is enrolled in the architecture guard.

It refuses when the question:

1. trips the secret detector;
2. shares a run of N or more tokens (N fixed in the spec, after Unicode normalization) with anything the writer saw: chunks, tables including captions and columns, cached fact claims, coverage text, provenance, citation metadata, or the user's question;
3. contains an identifier from the evidence or the connected accounts: email, URL, phone-like or account-like number, exact date, handle, or a provenance value;
4. exceeds byte and token limits, is not plain text, contains control or confusable characters or encoded blobs, or is more than one question;
5. would exceed a persistent quota (A.6).

Oversized inputs are rejected before generation. The spec says what the gate is: a rejector of accidents and crude exfiltration. **Passing it is never described as de-identification.** The real control is the owner's approval.

### A.5 Approval

- **`ask` is the only mode proposed.** An unattended mode is out of scope and would need its own proposal and evidence.
- The owner approves a **single-use envelope**: the exact question (by digest), the resolved destination, model and transport, the originating connection, the policy revision, and an expiry. Dispatch re-checks the envelope against current settings; any change voids it.
- Approval happens only in an authenticated dashboard control session. It is never exposed as an agent tool, never reachable by a remote connection, and never added to the relay's allowed paths.
- The approval screen shows the destination in words ("this goes to <provider> under your account" or "through zkAPI").
- Pending approvals are bounded per connection and globally, and do not hold an analyst lane while waiting.

### A.6 Authority and budgets

- Consult is a separate permission per connection, off by default, including for the owner's own agent.
- Quotas are persistent and reserved atomically: per answer, per day, per connection, and a monetary ceiling. A send whose outcome is unknown counts as sent.
- Revoking a connection or turning consult off cancels its pending envelopes.

### A.7 The consult record

- An approved consult's text is **Private data**: owner-only storage, bounded retention, covered by export and delete, excluded from indexing and diagnostics, shown only in a control session.
- A rejected proposal stores a content-free verdict only. Its text is not kept.
- The calling agent sees counts only.

### A.8 Transport

A consult profile is its own role and can never serve a raw-evidence purpose. The request body is fixed: the approved question and nothing else, no tools, no history, no redirects, bounded response size, safe errors. The OpenClaw command-line transport is not used for consults, since it exposes text on a command line. Options are a direct API profile or the `zkapi` transport from track Z.

Not claimed: anonymity against a provider that is also the calling agent.

### A.9 Contract impact

Letting the Analyst use outside advice changes "answer from this evidence only", so this is a **semantic** contract change whatever the field shapes. The version class, the compatibility note for existing consumers, focused contract tests and the held-out receipt are all produced in the same pull request, under the contract-evolution gate. The proposed shape is an optional `consult` request on the result and an optional `advice` input to the second pass; the dormant `escalation` field is left alone.

### A.10 Eval

On synthetic Private corpora, with thresholds, sample sizes and attacker strength fixed before the run:

- planted-identifier leak (must be zero);
- **sensitive-attribute inference by an attacker who already knows the account**;
- sequences of consults over time;
- multilingual, encoded and adaptive-prompt leakage;
- evidence injection and hostile replies, including the mixed Private/Public citation case;
- false-refusal rate and consult availability;
- answer-quality lift (no lift, no ship);
- latency and cost per surface.

### A.11 Phases

| Phase | Delivers | Done when |
|---|---|---|
| **P0** | The three shipped-code fixes; owner ruling on §10; contract text | Fixes merged; ruling recorded in the release plan |
| **P1** | Writer, gate, envelope, quotas, safe record, two-output release; the **whole state machine** on synthetic corpora with controlled transports; contract change with its receipts | A.10 passes with no real-data egress possible |
| **P2** | Real transport with synthetic questions, then bounded real-data `ask` trials | Leak, inference, false-refusal, quality, latency and cost results reviewed by the owner |

---

## 10. Decisions needed from the owner

1. **Track A wording.** May "Private content never reaches an ordinary cloud model" become "…the evidence never does; with consult on, you may approve sending a question derived from it"?
2. **Track A in `private-cloud-only`:** may Venice be the writer of a question that goes to a second provider?
3. **Track Z numbers:** suggested deposit range ($20–50) and warning ceiling ($100).
4. **Track Z scope:** confirm Z1 as "bring your own funded daemon", with dashboard-driven funding (Z2) waiting for upstream and a separate ruling.
5. **Track E:** accept that Olympus maintains a pin list of recognised enclave workloads, with refusals when it goes stale.
6. **Order:** proposed Z1, then E1–E3, then A.

## 11. Not proposed

A local model as the user's main agent; Olympus-managed Tor; wallet-abstraction services or card checkout; any key or token held by Olympus that can move funds (until a Z2 ruling); an unattended consult mode; sending any `EvidencePack` to a frontier model; any change to how Secrets are handled.

## Sources

- Review record with evidence: [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md)
- Vitalik Buterin, self-experiment post, 2026-10-04: <https://x.com/VitalikButerin/status/2106537633056969024>
- Self-sovereign LLM setup essay, 2026-04-02: <https://vitalik.eth.limo/general/2026/04/02/secure_llms.html>
- zkAPI repository, scriptable funding PR, Tor wrapper PR: <https://github.com/ethereum/zkapi>, <https://github.com/ethereum/zkapi/pull/19>, <https://github.com/ethereum/zkapi/pull/16>
- Introducing zkAPI, 2026-10-01: <https://blog.ethereum.org/2026/10/01/introducing-zkapi>
- Venice privacy modes: <https://docs.venice.ai/overview/privacy>
- Independent Venice E2EE client (protocol reference only, GPL-3.0): <https://github.com/jooray/venice-e2ee>
- Token-length side channel: <https://arxiv.org/abs/2403.09751>
