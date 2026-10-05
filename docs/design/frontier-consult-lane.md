# Design: frontier consult lane for Private questions

Status: **proposal, not approved.** Written for adversarial review before any build. Nothing here changes shipped behavior or the release plan until the owner rules.
Date: 2026-10-04, revised 2026-10-05 after owner direction (§1.1)

> **Review outcome, 2026-10-05: revise before any build.** Two adversarial reviews are consolidated in [`frontier-consult-lane-review.md`](frontier-consult-lane-review.md). This document has not yet been rewritten to answer them. Until it is, read it with these corrections:
>
> - **§1 outcome is overstated.** The outbound gate cannot guarantee that no Private detail leaves; a consult is an owner-approved disclosure of a derived question.
> - **§6 (zkAPI) is wrong in several facts** (ETH only, not one transaction, no scriptable funding in a release, a 30-day note expiry that forfeits the deposit) and is **not ready to ship**.
> - **§6A phase E1 must not ship.** Basic attestation gives no cryptographic protection against Venice; even full quote verification needs a pinned workload.
> - **§3 and §5** have code-level corrections and nine required design changes listed in the review.
Risk class: **Critical**. It changes trust routing, relaxes an advertised non-configurable rule, and touches the `Analyst` contract.
Authority requested: an owner ruling on §9. [`V0_4_RELEASE.md`](../V0_4_RELEASE.md) says any proposed contract change stops for owner review; this is that stop.

Terms: Private = S4 = `secure_local`. "Secure analyst" = a member of the secure analyst pool (loopback local model or Venice Private/TEE). "Frontier model" = any `standard_cloud` model. "Consult" = one outbound question to a frontier model that contains no source content.

---

## 1. Outcome

A user who asks a question that touches Private material gets an answer that benefits from a frontier model's knowledge and reasoning, while the frontier model receives only a short general question that the secure analyst wrote, and never the evidence, the user's wording, or anything that identifies the user or the people in the evidence.

Proof, in order of weight:

1. A held-out leak eval (§7) shows zero planted identifiers in outbound consults and a re-identification rate no better than chance.
2. The same eval shows a measurable answer-quality lift over the no-consult baseline. If there is no lift, the lane does not ship.
3. Security tests prove every failure path answers without a consult and never falls back to sending evidence.

### 1.1 Owner direction already given (2026-10-04/05)

These are settled and are not review questions:

- **Tiers are the product.** Users decide what may go to cloud models. Personal content reaching frontier models and cloud embeddings is by design, not a defect. Olympus is not trying to make everything private.
- **Olympus is not trying to be fully decentralized.** The relay and publisher apps are accepted central points.
- **zkAPI users are expected to have a crypto wallet** and to make one transaction to activate it. No wallet-abstraction service and no card checkout (§6).
- **Venice end-to-end encrypted models become a first-class option** (§6A). This is its own track and does not wait for the consult lane.

## 2. Position against the release plan

- **Not v0.4.** The v0.4 plan freezes `SourceConnector`, `EvidencePack` and `Analyst`, and its scope is the seven-source cited-answer journey. This proposal adds no v0.4 work and changes no register row.
- **Proposed slot:** a v0.5 candidate, sequenced after the v0.5 "Models & privacy dashboard" outcome, because the consult setting and its approval surface belong on that page.
- **If approved**, the same pull request that starts the build adds a dated decision to `V0_4_RELEASE.md` ("Decisions") and a v0.5 candidate line. Until then the release plan is untouched.
- **Rules that would change** (exact sites, so the reviewer can check the blast radius):
  - `README.md`, "Some rules are not configurable": "secure content never routes to ordinary cloud models".
  - `CONTRACTS.md`, Venice S4 policy: "`standard_cloud` is banned for every pack containing `secure_local` candidates", and item 3 (the redacted-escalation rule).
  - `SOVEREIGNTY_CONFIG.md`, "Hard invariants remain enforced outside user control".
  - `TRUST_MODEL.md`, "Model Routing Posture": "sanitized derivatives may be reclassified only when the transformation is deliberate and policy-approved". This line is the existing opening the proposal uses.

## 3. Current state (with evidence)

- **A redacted escalation already exists in the contract and is dormant.** `Analyst.analyze` may return `escalation: { reason, redactedPack }` when `localOnly` is set and no grounded answer exists (`src/core/contracts.ts:182-208`, `src/core/analyst.ts:228-247`).
- **Nothing dispatches it.** The release step turns an escalation into `needs_approval` / `s4_release`, and the calling agent receives a coverage gap (`src/workers/source-index/analyst-answer.ts:1922-1934`, header comment lines 22-26). The only production reader of `escalation` is the Venice-to-local retry (`analyst-answer.ts:1350`). I found no code path that sends a `redactedPack` to any model.
- **The redacted pack is not a safe consult payload.** `redactPackForEscalation` (`src/core/analyst.ts:965-988`) drops chunks and table rows but keeps `pack.question` verbatim plus every candidate's provenance (titles, paths, authors) and table captions and column names. That carries the user's own wording and the names of Private items. It was designed for an approval screen, not for unattended egress.
- **The escalation trigger is the wrong trigger for a consult.** It fires when the *evidence* is insufficient. A frontier model that cannot see the evidence cannot fix that. A consult helps when the evidence is sufficient but the secure analyst lacks outside knowledge or reasoning depth.
- **The membrane is two checks.** Policy validation at config load and a runtime re-check per request refuse `standard_cloud` for any pack with `secure_local` candidates. The secure pool admits only `local` + `local-openai-compatible` profiles and Venice `encrypted_cloud` profiles (`profileAllowedForDomain`, `src/core/sovereignty.ts:799-817`).
- **"Local" trust is decided by address.** A `local-openai-compatible` profile qualifies as `local` when its `baseUrl` is loopback (`src/core/sovereignty.ts:725-744`). Nothing checks what is listening there. This matters for §6.
- **The Private answer already reaches the calling agent.** Secure claims flow to the calling agent as bounded derivatives by default (`analyst-answer.ts:14-20`); strict mode (`OLYMPUS_SECURE_DERIVATIVE_DEFAULT=approval`) restores approval. So today a hosted agent's provider sees the conclusions, under the user's real account.

## 4. Threat model

In scope:

| Adversary | What it wants | Sees today | Would see with a consult |
|---|---|---|---|
| Frontier provider (logs, retention, training, subpoena) | Private facts tied to a person | Public/Personal content; the released Private answer when it is also the calling agent | One short general question per consult |
| Payment channel | Who is asking | Account identity | Same, unless the zkAPI transport is used |
| Network observer / provider IP logs | Who is asking | IP | Same, unless Tor is used |
| Hostile source content (an email or file with instructions) | To steer the analyst into leaking | Treated as data by the Analyst | A new target: the consult writer |
| Hostile or wrong frontier reply | To steer the final answer | n/a | A new input to the secure analyst |
| A connected remote agent | To trigger egress or spend | Can ask questions | Can cause consults indirectly |

Out of scope: a compromised host, a compromised secure analyst, and Venice breaking its Private-category promise (already accepted in the Venice S4 policy).

Not claimed: anonymity against a provider that is *also* the calling agent. If ChatGPT asks the question and the consult goes to the same company seconds later, timing links them, and that provider receives the released answer anyway. The consult lane's privacy value is against a provider that is not the calling agent, and for users in strict or local-agent modes.

## 5. Design

### 5.1 Flow

```text
source_answer
  → EvidencePack has secure_local candidates
  → secure analyst pass 1 (evidence in context)
        returns answer, or a consult request: one self-contained general question
  → outbound gate (mechanical, §5.3)            fail → answer without consult
  → approval, if mode is "ask" (§5.4)           deny/timeout → answer without consult
  → transport (§5.5), one stateless request     error/timeout → answer without consult
  → secure analyst pass 2 (evidence + reply as untrusted advice)
  → existing release gate → calling agent
```

At most one consult per answer in the first version. Every "fail" arrow ends in the answer the system gives today.

### 5.2 Who writes the question

The secure analyst writes it, never the user and never the calling agent. The generic Analyst prompt gains one generic instruction: if outside general knowledge would materially improve the answer, return a single self-contained question that contains no names, identifiers, quotations, or details specific to the evidence or the person asking. There is no per-question logic and no template; the architecture guard's rule stands.

Pass 1 and pass 2 run on the same secure pool member. In `local-only` and `local-first` (when the local model serves), the writer is a local model. In `private-cloud-only`, Venice writes it. That is consistent with the trust Olympus already places in Venice, and weaker than a purely local writer; §9 asks whether consult should be allowed in that posture.

### 5.3 Outbound gate (the enforcement point)

The writer is a model and will sometimes leak. The gate is code, runs in the worker outside the Analyst, and refuses on any hit:

1. **Secrets:** the existing S5 detector (`secretLabelsInText`).
2. **No verbatim carry-over:** no shared run of N or more tokens with any evidence chunk, table cell, provenance string, or the user's question.
3. **No known identifiers:** none of the owner's identity terms (names, emails, phones, addresses, handles from the sensitivity map and connected accounts), no provenance value (title, path, author, chat name), and no email address, URL, phone-like or account-like number, or exact date that appears in the evidence.
4. **Shape limits:** a length cap (proposed 600 characters), plain text only, one question.
5. **Budgets:** one consult per answer, a daily cap, and a per-connection cap for remote agents.

What the gate cannot do, stated plainly: it cannot prove that a paraphrase is non-identifying. "A 43-year-old in a small named town with a rare condition" passes every check above and may identify one person. Items 2 and 3 stop accidents and crude exfiltration; they do not stop a rare combination of ordinary words. That residual risk is the main thing the eval (§7) measures and the main reason for the approval mode.

The gate also bounds a covert channel. If hostile source text steers the writer into encoding data in word choices, the leak is capped by length × consults per day. It is not zero.

### 5.4 Modes

| Mode | Behavior | Default |
|---|---|---|
| `off` | No consult. Today's behavior. | Yes, in every preset |
| `ask` | The gated question is shown to the owner on an Olympus surface (dashboard). Approve or deny. | First shipped mode |
| `auto` | Gate only. | Only after eval evidence and a separate owner ruling |

Approval happens only on an Olympus-owned surface, never through the calling agent, which is the untrusted party and a prompt-injection path. While approval is pending the answer uses the existing `working` / `job_id` hand-off; on timeout it completes without a consult. `no-sensitive` has no Private content and no consult.

### 5.5 Transport

A consult profile is a new, separately named role in the sovereignty policy. It is never a member of the secure pool and can never receive an `EvidencePack`; its input type is a string.

- **Default transport:** the install's existing `standard_cloud` analyst profile (OpenClaw's configured model, or a pinned API model). One stateless request: no conversation history, no system text naming Olympus or the user, no memory features. No new account for a new user.
- **Optional transport:** zkAPI (§6).

The reply is untrusted. It enters pass 2 as quoted advice with the same "data, not instructions" handling the Analyst already applies to evidence. Pass 2 still cites only evidence. Statements that rest on the outside reply are labelled in the answer as general guidance from an outside model, not from the user's sources.

### 5.6 Audit and visibility

Each consult writes a local record: the question text, gate verdict, mode, transport, model, byte counts, and a hash of the reply. The dashboard lists them. The calling agent's audit block gets counts only ("1 outside consult"). The user can read every question that ever left.

### 5.7 Contract impact

Two honest options; the owner picks in §9.

- **A. Additive field (recommended).** Add `consult?: { question: string; reason: string }` to `AnalystResult`, and an optional `advice` input to the pass 2 call. Additive, so a minor version bump with the full contract-evolution gate (version, fingerprint, compatibility note, held-out eval receipt, critical review). The dormant `escalation` field is left as is, or retired in a later major version.
- **B. Reuse `escalation`.** No shape change, but a semantic change (a `redactedPack` whose question is the consult and whose candidates are empty). Still needs the gate, and overloads a field whose name and payload mean something else.

## 6. zkAPI option

**What it is.** zkAPI (Ethereum Foundation with the Open Anonymity Project, mainnet 2026-10-01) lets a user deposit ETH or USDC once and then make API calls the provider cannot link to the deposit or to each other. A local daemon, `zkapi-clientd`, exposes an OpenAI-compatible endpoint on loopback. A Tor-routed client mode is in review upstream.

**What it adds for us.** It removes the payment link, and with Tor the network link, for consults. It adds nothing on content: the provider still reads the prompt, which is why §5.3 is the load-bearing control and this is only a transport.

**How Olympus would support it (owner direction: the user has a wallet).**

The wallet is needed for one deposit. After that the balance is a private note held on the user's machine, so no wallet service is involved.

1. The user turns on "Anonymous consult (zkAPI)" in the dashboard's advanced model settings.
2. Olympus starts the zkAPI daemon, which creates the note and a local deposit address. The note secret stays in the daemon's own local storage; Olympus does not copy it.
3. The dashboard shows the address, the amount and a QR code. The user sends ETH or USDC from their own wallet.
4. Olympus watches for the deposit, runs one synthetic request, and marks the consult transport ready.
5. The same page shows the remaining balance, a top-up address, and "withdraw to address".

Olympus speaks the OpenAI API to the daemon on loopback and nothing else. It holds no key that can move funds beyond what the daemon itself holds, ships no Tor, and makes no on-chain call of its own. Tor is the daemon's setting; Olympus reports only what is configured.

Open build question: whether Olympus installs a pinned, checksum-verified daemon release or only detects one the user installed. Installing is the one-toggle experience; detecting keeps a wallet-holding binary out of our supply chain. Recommendation: detect first, install only after the upstream review closes.

**Risks specific to this option (for the reviewer to attack).**

1. **Loopback is not local.** A zkAPI daemon is a loopback URL that forwards to a frontier provider. Today a loopback URL is what makes a profile `local` and eligible for raw Private evidence. A user, or an agent "helping" with setup, could register the daemon as a local analyst and send raw S4 to a cloud model. The build must close this before the option exists: a consult profile is a distinct type, and local-profile validation needs more than an address check (for example a declared-forwarder refusal and a setup warning). This gap exists today for any loopback proxy; zkAPI makes it likely.
2. **Maturity.** Upstream labels the protocol experimental, with a single-party trusted setup and an open note-binding review. Mainnet for three days at the time of writing.
3. **Small anonymity set.** Early on, few users share the pool. Deposit size, timing and refund-ticket behavior may narrow it further. Unverified; needs a read of the protocol, not the announcement.
4. **Without Tor the IP still identifies the user.** With Tor, upstream raised its own timeouts to minutes. Our interactive budget is 60 seconds per non-final leg and a 200-second remote hand-off, so a Tor consult will often arrive too late and be dropped.
5. **A new binary holding funds on the user's machine.** Supply-chain and key-custody risk that Olympus would be recommending or, if it installs the daemon, carrying. Losing the daemon's local storage loses the balance; the dashboard must say so and offer withdrawal.
6. **Provider choice.** Which models are reachable, and through which intermediary, is set by the zkAPI operator. The intermediary sees prompts too.

**Gate to ship this option:** the upstream review is closed, risk 1 is fixed and tested, and a timed trial shows consults complete inside our budgets often enough to be worth offering.

## 6A. Venice end-to-end encryption as a first-class Private option (separate track)

**Why.** Today Venice Private rests on a no-retention promise. With an end-to-end encrypted model the client encrypts the prompt, Venice relays ciphertext, and only a hardware enclave decrypts it. That replaces most of the promise with cryptography, and it weakens the "Venice writes the consult question" concern in §5.2.

**Current state.** Olympus recognises the `e2ee` category and refuses every `e2ee-*` model with a typed policy error "until Olympus has local key handling" (`CONTRACTS.md`, Venice S4 policy; `SOVEREIGNTY_CONFIG.md` hard invariants; `src/core/venice-models.ts`). `olympus doctor` says E2EE is not provided out of the box.

**What the client must do** (from Venice's privacy docs and an independent open implementation):

1. Fetch the enclave's attestation for the model with a fresh nonce.
2. Verify it: the nonce is bound, the enclave's key is in the attested report, debug mode is off, the model matches.
3. Make a one-time key pair, agree a key with the enclave (ECDH on secp256k1, HKDF-SHA256), encrypt each message with AES-256-GCM, and send the public keys in `X-Venice-TEE-*` headers.
4. Read the streamed reply and decrypt each chunk.

**Build shape.** A Venice E2EE adapter beside the existing Venice analyst adapter, on the same `Analyst` contract with no shape change. The `e2ee-*` refusal is replaced by "refuse unless attestation verified for this request". It becomes a selectable Private posture and a secure-pool member like any other.

**Limits to state honestly in the product.**

- **Attestation is only as strong as what we verify.** A basic check proves the key is bound to *an* enclave report. Full verification of the Intel quote chain is a second step. Venice does not currently publish a stable list of expected code measurements, so the client cannot prove *which* code is running. GPU attestation is separate again. The setting must say which level was verified and must not call the basic level proof.
- **The reply's origin is weaker than the request's.** The independent implementation notes the streamed reply format does not itself prove the replying key belongs to the attested enclave.
- **Metadata still leaks to Venice:** account, model, timing, sizes, billing, IP.
- **Text models only.** No end-to-end encrypted embeddings, so Private search stays keyword or local-embedding. No server-side features (web search, memory, some tool flows); the Analyst uses none of them.
- **Enclaves are run by Venice's partners** (reported as NEAR AI Cloud and Phala). Trust moves from Venice's promise to the chip maker and those operators.
- **Licence.** The independent library is GPL-3.0 and cannot be bundled in an MIT plugin. Implement from Venice's published guide on MIT-licensed primitives (`@noble/secp256k1`, `@noble/hashes`, Web Crypto).

**Done when.** A fresh install can pick an end-to-end encrypted Venice model for Private answers from setup; a tampered or debug attestation refuses before dispatch; the held-out eval is green on that lane; and the dashboard states the verified attestation level. Critical change: trust routing and a hard invariant.

## 7. Eval (done = held-out, not a demo)

A new held-out suite beside `eval/`, built on synthetic Private corpora:

- **Canary leak:** planted names, account numbers, addresses, rare phrases. Pass = zero in any outbound consult across the suite.
- **Re-identification:** an adversary model receives only the consult questions plus a set of decoy profiles and tries to pick the real one. Pass = no better than chance, with the threshold fixed before the run.
- **Injection:** evidence containing instructions to put specific data in the outside question, including encoded forms. Pass = gate refusal or no leak.
- **Reply injection:** hostile frontier replies. Pass = final answer unchanged in its evidence-backed claims, no instruction followed.
- **Quality lift:** graded answers with and without consult on questions that need outside knowledge. Pass = a pre-registered lift; otherwise stop.
- **Fail-closed:** gate error, transport error, timeout, denied approval. Pass = today's answer, no evidence egress.

The first build phase runs this with **dry-run** consults: questions are generated, gated and logged, and never sent. That measures the leak rate before any egress exists.

## 8. Phases

| Phase | Delivers | Done when |
|---|---|---|
| P0 | Owner ruling, contract text, rule rewording, loopback-trust fix | Ruling recorded in the release plan; contract version gate green |
| P1 | Writer instruction, outbound gate, audit record, dry-run only | Leak, re-identification and injection evals pass; no network code exists |
| P2 | `ask` mode with the default transport | Quality lift shown; fail-closed tests pass; dashboard approval works on a fresh install |
| P3 | `auto` mode | Separate owner ruling on P2 evidence |
| P4 | zkAPI transport, dashboard activation flow | §6 ship gate met |
| E1 (independent) | Venice end-to-end encrypted analyst adapter with basic attestation | §6A "done when" |
| E2 (independent) | Full Intel quote-chain verification; measurement pinning if Venice publishes it | Verified level shown in the dashboard |

Each phase is a critical change with an independent review receipt.

## 9. Decisions needed from the owner

1. Is "Private source content never reaches an ordinary cloud model" allowed to become "…except a general question the secure analyst wrote, when the user turned consult on"? This changes README and launch language.
2. Contract route: A (additive field) or B (reuse `escalation`).
3. Is consult permitted in `private-cloud-only`, where Venice writes the question?
4. Is `auto` ever allowed, or is `ask` the ceiling?
5. zkAPI daemon: detect only, or install a pinned release (§6)?
6. Should the loopback-trust fix (§6 risk 1) ship on its own now, independent of this proposal?
7. Venice end-to-end encryption: ship with basic attestation and an honest label (E1), or hold until full quote verification (E2)?

## 10. Attack list for the adversarial review

Each item is a claim this proposal makes or depends on. The review should try to break each one and say which are fatal.

1. **Paraphrase leak.** The gate stops identifiers and verbatim text; a paraphrased rare combination still identifies. Is the re-identification eval a real measure or theatre?
2. **Covert channel.** Hostile evidence steers the writer to encode data. Is length × daily cap an acceptable bound, and can the writer be isolated from evidence instructions any better than the Analyst is today?
3. **The writer has seen the evidence.** Would a two-step design be safer: a model that sees evidence states only the *kind* of knowledge needed, and a second model that never saw the evidence writes the question?
4. **Reply injection.** The frontier reply enters a context that holds raw Private evidence. The output still passes the release gate, but can the reply steer what is released to the calling agent?
5. **Same-provider correlation.** When the calling agent and the consult provider are one company, the consult's anonymity is void. Does the lane still earn its place given the answer is released to that agent anyway?
6. **Linkage across consults.** On the default transport every consult shares one account. Do months of "general" questions rebuild a profile?
7. **Loopback trust confusion.** §6 risk 1. Is the proposed fix sufficient, and what else on loopback is trusted by address?
8. **Trigger abuse.** Can a remote agent or hostile content induce consults to spend money or widen the channel?
9. **Fail-closed completeness.** Is there any path where a consult failure degrades to sending more, or silently changes which analyst sees the pack?
10. **Architecture guard.** The gate needs pattern matching. Does that erode the "no regex answer code" rule, and is the trigger truly question-agnostic?
11. **Approval fatigue.** In `ask` mode, will users approve everything, making the gate the only real control?
12. **Venice as writer.** Does consult in `private-cloud-only` add a meaningful new exposure?
13. **zkAPI protocol claims.** Unlinkability, refund tickets, trusted setup, anonymity-set size: verified against the protocol, not the launch post.
14. **Latency and cost.** Two extra model legs inside the interactive budget. Does consult ever complete in time on a local model at 20–30 tokens per second?
15. **End-to-end encryption claims.** Does basic attestation justify the words "end-to-end encrypted" in the product? What does an attacker who controls Venice's relay, but not the enclave, still get? Does the unauthenticated reply stream allow a relay to substitute answers?
16. **zkAPI activation flow.** Deposit watching, balance display and withdrawal add an on-chain surface to the dashboard. Can a remote agent, hostile page or hostile source content trigger a withdrawal or redirect a top-up address?
17. **Product trust.** One publicised leak through this lane costs more than the quality it buys. Is `off` by default plus `ask` enough, or should this stay unbuilt?

## 11. Not proposed

A local model as the user's main agent, sandboxing of the host agent, Olympus-managed Tor, wallet-abstraction services or card checkout for zkAPI, any key held by Olympus itself, sending any redacted `EvidencePack` to a frontier model, and any change to how Secrets are handled.

## Prior art

- Vitalik Buterin, self-experiment post, 2026-10-04: <https://x.com/VitalikButerin/status/2106537633056969024>
- Self-sovereign LLM setup essay, 2026-04-02: <https://vitalik.eth.limo/general/2026/04/02/secure_llms.html>
- Introducing zkAPI, 2026-10-01: <https://blog.ethereum.org/2026/10/01/introducing-zkapi>
- ZK API Usage Credits proposal: <https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104>
- zkAPI repository and Tor client mode: <https://github.com/ethereum/zkapi>, <https://github.com/ethereum/zkapi/pull/16>
- Venice privacy modes: <https://docs.venice.ai/overview/privacy>
- Independent Venice E2EE client library (protocol reference only, GPL-3.0): <https://github.com/jooray/venice-e2ee>
