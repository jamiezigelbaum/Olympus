# Adversarial review: frontier consult lane proposal

Date: 2026-10-05
Target: [`frontier-consult-lane.md`](frontier-consult-lane.md) at commit `51d5f4c4`.
Reviewers: two independent read-only passes. **Codex** checked the proposal's code claims and design against the repository. **Opus** checked the zkAPI and Venice claims against primary sources (the `ethereum/zkapi` repo at `045b444`, the live mainnet vault, Venice's docs, live model catalog and two live attestation responses, and two independent Venice client implementations).

This file is the consolidated record. "Verified by author" marks the claims the proposal's author re-checked in code after the review.

## Verdicts

| Part | Verdict |
|---|---|
| Consult lane (§5) | **Build with changes.** Not implementation-ready. Do not build P2 as specified. |
| zkAPI transport (§6) | **Do not ship yet.** The activation flow does not match how the daemon works, and user funds are exposed to fee, expiry and operator risk. |
| Venice end-to-end encryption (§6A) | **Ship with changes, and not as phase E1.** "Basic attestation" gives no cryptographic protection against Venice and must not be labelled end-to-end encrypted. |

## A. Consult lane

### Fatal to the stated guarantee

1. **The outbound gate cannot deliver "no Private content leaves".** The outcome promises no evidence-specific or identifying detail; the gate section admits paraphrase and covert-channel leaks. A rare combination described in synonyms and ranges passes every check and still discloses a Private fact. On the default transport the provider already knows the account, so no re-identification is needed.
   *Change:* describe a consult as an owner-approved disclosure of a potentially sensitive derived question, or restrict automatic output to a reviewed, evidence-independent vocabulary. Passing the gate must never be called de-identification.

### Serious

2. **Reply injection can cross the release gate, including in strict mode.** The release gate derives sensitivity from the *cited* candidates only (`factsFromCitations`, `src/workers/source-index/analyst-answer.ts:2166`), and treats an answer as uncited only when there are zero citation facts (`analyst-answer.ts:1866`). The reviewer reproduced it with a model double: a Private fact in the answer, cited only to a Public item, was released as `allow` with every gate fact at S0. *Verified by author: the code reads as described.* **This is a gap in shipped code today, independent of this proposal.**
   *Change:* two separate outputs (evidence-backed answer, outside advice) with separate release treatment; in strict mode an answer produced from a Private context is not releasable merely because its citations omit the Private candidates.
3. **The loopback fix as proposed is a warning, not a boundary, and too narrow.** A profile carrying `forwarder: true` passed validation because the parser drops unknown fields (`src/core/sovereignty.ts:572`). The same address-based trust exists for embeddings (`src/workers/source-index/embeddings.ts:1030`), remote vision extraction (`src/workers/file-extraction/extractors/remote-vlm.ts:184`) and the Delphi analyst (`src/core/analyst-delphi.ts:4`). Chat fetches do not restrict redirects (`src/core/analyst-openai.ts:125`); embeddings do (`embeddings.ts:522`).
   *Change:* positive endpoint custody rules across analyst, embedding, vision and classification; consult endpoints ineligible for every raw-evidence role; redirects disabled on sensitive transports.
4. **"Every failure returns today's answer" is not executable as written.** If pass 1 returns only a consult request there is no baseline to fall back to. Existing dispatch switches analysts on failure (`analyst-answer.ts:1628`) and can rebuild the pack without Private evidence for the ordinary route (`analyst-answer.ts:519`); a consult timeout inside an analyst leg could trip those.
   *Change:* pass 1 always produces a releasable baseline plus an optional consult; freeze the evidence snapshot and the resolved secure member; consult errors get their own domain and never touch member health or route selection.
5. **The gate specification omits model-visible inputs.** The writer also sees cached fact claims, table captions and columns, coverage text and citation metadata (`src/core/analyst.ts:345`). The sensitivity map is a rule schema, not an identity inventory, and can be absent (`src/core/sensitivity-map.ts:36`). The S5 detector misses an unlabeled password.
   *Change:* specify the full comparison corpus, a numeric N, Unicode normalization, byte and token limits, confusables and encoded forms, and failure behaviour.
6. **Approval is not bound to what is sent or where.** The default transport can resolve to OpenClaw's mutable default model (`src/core/analyst-openclaw-infer.ts:118`), and that transport exposes text on a command line (`:101`), accepted until now only because no Private-derived text used it.
   *Change:* approve a single-use envelope (payload digest, resolved destination, model, transport, connection, policy revision, expiry) and recheck immediately before dispatch.
7. **The audit record is a new sensitive store.** Dry-run logging would persist rejected questions, including a rejected credential. A read-only `dash_` token reads dashboard views without a control session (`src/workers/http.ts:184`).
   *Change:* accepted consult history is Private data; rejected proposals store content-free verdicts only; bounded retention; covered by export and delete; question bodies need a control session.
8. **Remote consult authority and quotas are unspecified.** A remote connection has no consult or spend capability today (`src/core/remote-connections.ts:50`); handed-off jobs survive disconnects and global concurrency is two (`src/core/source-answer-jobs.ts:43`), so approval waits can occupy answer capacity.
   *Change:* a separate per-connection consult permission; persistent, atomic reservations; monetary limits; bounded approval queues; no consult approval or history on the relay allowlist (`docs/design/relay.md:107`).
9. **The dry-run exit gate can certify the wrong thing.** Picking the owner among decoys misses an attacker who already knows the account and learns a sensitive attribute. Dry-run cannot test transport isolation, approval races, reply injection or fallback.
   *Change:* add sensitive-attribute inference, known-account and longitudinal attackers, multilingual and encoded leakage, false-refusal rate; run the full state machine on synthetic corpora with controlled transports before any real-data egress.

### Minor

10. "Additive, so minor version" is premature: letting the Analyst use outside knowledge changes "answer from this evidence only" (`docs/CONTRACTS.md:188`) even with optional fields. P0 claims a green version gate before P1 supplies the eval receipt. The public-surface guard is not addressed. Timing is mis-stated: 60 s is the non-final secure-pool leg budget, 200 s a remote hand-off threshold, 45 s the local stdio hand-off, 20 min the job backstop.

### Corrections to §3 (current state)

- "Dormant" is right only as "never dispatched". The escalation is emitted today and read in three places, not one (`analyst-answer.ts:1350`, `:1868`, `:1922`).
- The redacted pack also keeps coverage strings, score and build time. The code comment explicitly envisages a post-approval cloud model (`src/core/analyst.ts:961`), so "designed for an approval screen" understates it.
- The escalation trigger is structural (citation checks on model output), not a semantic judgement of evidence sufficiency.
- The `e2ee-*` refusal lives in the secure-pool gate (`src/core/sovereignty.ts:891`); the lower-level category gate accepts E2EE (`src/core/venice-models.ts:157`). *Verified by author.*
- Strict mode is overridden by `include_secure_local_content: true`.

## B. zkAPI

### Wrong in the proposal

| Proposal says | Actually |
|---|---|
| Deposit ETH or USDC | Native ETH only (`docs/native-eth-billing.md`; vault `billingToken() == address(0)`). The launch post's USDC wording contradicts the code. |
| One deposit transaction | The user sends ETH to a hot account the daemon creates, then approves the daemon's `deposit()`. Withdrawal needs another ETH payment for gas. Every deposit creates a new note; there is no top-up. |
| Dashboard can drive the flow | No scripted funding exists in a release. Funding is an interactive `zkapi-clientd config` session; `serve` exits while unfunded. PR #19 (`fund` / `withdraw`, `serve --allow-unfunded`) is open. The only programmatic path is a private admin API whose token authorizes withdrawal to any address. |
| Olympus holds no key that can move funds | False if Olympus drives the daemon with that token. |
| Tor client mode is in review | SOCKS5/Tor shipped in clientd 0.1.5. PR #16 only adds wrapper scripts and longer timeouts. |
| Requests are unlinkable from each other | Not by default: a 60-second key-reuse window links everything sent through the same daemon. Spending is strictly sequential, so with few users timing links consecutive requests. |
| "Open note-binding review" as a ship gate | It is a design note, not a review with a closing state. The gate cannot be evaluated. |
| Refund tickets | Belong to the February research design, not the shipped protocol. |

### Missed by the proposal

- **Fatal: 30-day note expiry.** On-chain `noteTtl` is 30 days; an unwithdrawn note's whole deposit goes to the treasury (`claimExpired`). Consults are rare, so this is the likely way a user loses money. The daemon's user docs do not mention it.
- **Serious: operator custody risk.** The vault owner is a single ordinary account. `pause()` blocks deposit, close and escape withdrawal but not `claimExpired`, and the owner can change the treasury. A 30-day pause sends deposits to the treasury. The trusted setup is single-party; whoever kept its secrets could forge proofs.
- **Serious: fees exceed typical deposits.** Deposit costs about 6.74M gas and withdrawal about 7.05M. Observed median deposit about $5; median deposit fee about $7.
- **Serious: tiny anonymity set.** About 70 notes from 53 funding addresses at review time.
- **Serious: withdrawal is public.** `mutualClose` emits note id, final balance and destination; funding is a public chain from wallet to hot account to vault.
- **Serious: loopback port squatting.** If the daemon is not running, any local process can bind its port and show a fake funding address. Inference is keyless, so any local process can spend the balance.
- **Serious: latency.** Lease patience is 330 s and settlement can take minutes. With key reuse off (needed for unlinkability) back-to-back consults can miss our budgets even without Tor.
- **Prompts are seen by** OpenRouter and whichever upstream it routes to. The zkAPI server sees per-session spend and, without Tor, the IP.
- **Release integrity:** every release is a prerelease; installer is curl-pipe-bash with SHA-256 only.
- Licence is MIT / Apache-2.0, not a blocker.

### A checkable ship gate

Scripted funding merged upstream; key reuse forced to 0 and verified; an expiry warning and withdrawal reminder in the dashboard; a pinned daemon identity on the loopback port; a measured latency trial; and an owner decision on the pause and expiry custody risk.

## C. Venice end-to-end encryption

### Fatal

1. **Phase E1 ("basic attestation") protects nothing against Venice.** Without verifying the quote's signature chain, a relay can fabricate the report and substitute its own key. It would only guard against an honest Venice mishandling logs, which is the existing no-retention promise.
2. **Full quote verification alone (E2 as defined) is also not enough.** Without pinning the measured workload, an attacker can front any genuine confidential VM they control and present a real Intel-signed quote.
   *New information:* live attestations now carry source provenance (a named gateway repo commit for Phala-hosted models; `app_id`, `compose_hash`, `os_image_hash` and an event log for NEAR-hosted ones). Olympus could maintain its own pin from those.

### Serious

3. **Reply confidentiality is unproven.** The client's public key travels in a header that nothing binds to the request ciphertext; an active relay could swap in its own key, read the answer and re-encrypt. Inferred from the docs, not tested. Venice's sample client also accepts plaintext chunks.
4. **Only `user` and `system` messages are encrypted.** Assistant-role history goes in the clear, so the adapter must never send evidence or prior answers as assistant turns.
5. **Token-length side channel.** Each streamed chunk is encrypted separately, so the relay sees every token's length (Weiss et al., 2024).
6. **The same `e2ee-*` model ids also serve a plaintext enclave-only mode.** A misconfigured adapter would send plaintext without noticing. The adapter must positively establish encryption, not rely on the id prefix.
7. **Two attestation formats** (Phala and NEAR) need two verifiers. The Phala enclave is an aggregator gateway with a further hop whose attestation was not verified.

### Confirmed

Protocol steps and primitives; text models only (12 `e2ee-*` models in the live catalog, none for embeddings); no server-side features or function calling; enclaves run by Phala and NEAR; GPL-3.0 on the independent client libraries. `@phala/dcap-qvl` (Apache-2.0) is usable for quote verification but pulls in a dependency with an open advisory.

### Minimum for the words "end-to-end encrypted"

Client-side verification of the Intel quote chain and platform status; nonce and key bound in the report; debug off; the workload pinned to values Olympus maintains; reply key bound to the request, or the response signature verified; plaintext chunks rejected; GPU evidence verified or explicitly labelled as Venice-attested. An encryption failure must never fall back to plaintext Venice.

## Not verified by either reviewer

Real zkAPI consult latency (no wallet was funded); OpenRouter and Open Anonymity retention settings; whether the daemon fetches per-note Merkle paths from the operator; Venice's response-signature format; whether the enclave really encrypts replies to the header key; JSON output under end-to-end encryption; whether the Phala gateway's downstream hop is attested.

## D. Second round: revision 4 against the reference zkAPI practice (2026-10-05)

Reviewer: Codex (gpt-6-astra), read-only, against the skill file `tor-remote-research.md` (ethereum/zkapi PR #16), the daemon's docs and source, and revision 4 of the proposal. Standard set by the owner: when a user wants privacy and turns on zkAPI, the result must be something the designer of that practice would approve.

**Verdict: revision 4 does not yet meet the standard.** Three blockers.

### Blockers

1. **Enforce where the conclusion goes.** In the reference setup the remote model never sees the conclusion. On `main`'s OpenClaw path the Private answer is released to the calling agent by default, so an anonymous consult followed by an identified answer defeats the point. In the ChatGPT product the sealed private answer panel keeps the answer out of the hosted model (not reviewed in code by this reviewer). Required: offer the anonymous route only where the Private result stays out of the calling agent's view (the sealed panel, or a local agent with local delivery); otherwise label it payment-privacy only. `include_secure_local_content` must not override this.
2. **"Fresh circuit per consult" is an assertion, not a protocol.** The reference builds a disposable Tor client per request. The daemon rejects SOCKS credentials and negotiates no-auth only (`internal/relay/relay.go:52-68`, `socks5.go:53-59`), so per-request isolation by SOCKS username is not available, and a new-identity signal affects only new streams and may be rate-limited. Olympus needs one of: a user-operated supervisor, a dedicated scoped Tor instance, or upstream per-request isolation. Do not copy the reference wrapper's cleanup, which restores direct mode on exit.
3. **All three layers mandatory for the strong label.** Revision 4 says "no shortcuts" yet permits a no-Tor variant and a declared-only reuse check under the same setting. Keep no-Tor only as a separately named payment-privacy feature; refuse the strong mode when Tor, isolation or reuse 0 is absent or unverifiable.

### High

4. **Writer and dispatcher spec incomplete.** Missing from the adopted rules: technical fingerprints (stack combinations, literal errors, internal hostnames), security and incident abstraction, class-level locations, a runtime check of a new question against recent ones, validation of real completions (non-empty, well-formed), a smoke test of the selected model, and generation bounds. The gate's "more than one question" refusal contradicts the reference's safe batching of sub-questions. Exact figures are promised as refused but are not in the gate list.
5. **Money guards not executable as written.** The expiry clock should be the note's on-chain expiry (computed from the deposit block), not a date the user confirms; "disappears" should read "becomes claimable by the operator". Quote, balance, expiry, Tor route and reuse window are not readable without the management credential (`funding_admin.go:12-55`, `server.go:49-55`), so the promised live fee estimate and several "verified" statuses have no permitted data path. Per-request allowances are $1 to $6 by model (`model_budget.go:13-29`), so "consults cost cents" is not enforceable; reserve a worst-case allowance before sending. Inference authentication is supported today and should be mandatory. Add caveats: deposits are ETH-valued, and activate before finality.
6. **Acceptance tests to add:** three decomposed consults, settlement delays, Tor death mid-request, listener replacement, policy change between approval and send, empty successful responses, timing correlation with the calling agent's request.

### Still open from the first round

Endpoint custody (owner-asserted locality); numeric token-run length and byte bounds; daemon allowance reservation; public-surface guard treatment; verified reuse, pinned daemon identity, latency, withdrawal privacy and release integrity.

### Limits to state, because today's upstream cannot fix them

No guarantee against timing or content correlation; no confidentiality from the inference provider for what is sent; no recovery of what a hosted caller already saw (the original question and its timing); no end-to-end censorship or capture resistance and no guaranteed withdrawal; no trustless proof setup; no attach-only way to get isolation and status through the inference API.

Not verified by this reviewer: the original post (taken from the brief), the vault's current owner and time-to-live, current fees and anonymity-set size, and the private answer panel's code.
