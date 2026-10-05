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

## E. Revision 5 submitted, awaiting adversarial review (2026-10-05)

Revision 5 is not yet reviewed. It rewrites track A around the ChatGPT private answer panel after owner decisions of 2026-10-05: automatic consults once a route is set up (approval only in opt-in strict mode); the outbound gate as the only pre-send check; the baseline answer exactly as fast as today; no default spending cap with costs stated up front; vocabulary packs per configured language with Brazilian Portuguese shipped; zkAPI labelled "route not verified" on macOS until the owner decides on the recommended daemon fork (prototype done); consult records as ordinary Private items.

How it answers section D: blocker 1 is met on the panel path, where the Private result stays sealed to the panel, and is carried as a precondition of the later OpenClaw stage. Blocker 2 is unchanged in substance (throwaway Tor per consult, shipped in Z1) and the strong label stays unproduced until route verification (§Z.6). Blocker 3: the strong label still requires all three layers.

Questions a reviewer should press:

1. Whether the follow-up poll design (fixed schedule, fixed-size fresh seals) really makes relay-visible traffic independent of the gate verdict and the consult outcome, and what the 30-minute job lifetime and the stored question add to exposure.
2. Whether the writer seeing only the question, baseline answer and gaps, while the gate compares against the full evidence snapshot, is sound.
3. Whether the rewrite as a panel-only composer, outside `Analyst.analyze`, honestly leaves the `Analyst` contract unchanged in meaning as well as in type.
4. Whether preemption of consult work can delay a fresh baseline in practice (the abort-to-free latency is unmeasured).
5. Whether releasing the zkAPI reply before settlement, and warming the route during the writer, are free of privacy cost as claimed.
6. Whether a consult reply stored as a searchable Private item opens an injection path into later answers.
7. Whether every eligibility-guard site (G1–G7) is placed immediately before the submission or release it protects.
8. Whether the recommended daemon fork (§Z.6; prototype in `~/Code/Claude/zkapi-fork/`, awaiting owner decision) proves what the proposed label "confined to this session's Tor listener" says, given one sandbox profile over the whole process tree, the `localhost`-only host filter, the deprecated `sandbox-exec`, and the pre-existing bridge-token exposure on the wallet API port.

Unmeasured, and stated as such in the proposal: writer and rewrite durations, gate speed on real packs, abort-to-free latency, every zkAPI stage time.

## F. Third round: revision 5 reviewed, revision 6 written (2026-10-05)

Reviewer: Codex (gpt-6-astra), read-only, revision 5 at `0378dfe7`, against `main` at `bb1755fb`, the gate branch at `47c5acd6`, and the fork prototype in `~/Code/Claude/zkapi-fork/`. No inference, funded request or prototype run. **Verdict: needs redesign.** The author re-checked every cited file and line before writing revision 6. All 19 findings hold. Two citations were slightly off, and neither changes a finding:
- finding 7 cites `built-in-reasoning/server.ts:124`; the `--parallel 1` flag is at `src/workers/source-index/built-in-reasoning/server.ts:131`;
- line numbers elsewhere are within a few lines.

The owner then made simplifying decisions on 2026-10-05:
- no rewrite pass in version one, append a labelled outside block instead;
- no searchable consult records;
- one route;
- a uniform, fixed-size collection protocol;
- measurement before feature code;
- fence recovery as a button;
- enable only from the Mac;
- consult only on insufficient answers;
- ship all ten packs.

| # | Finding (short) | Verified | Disposition in revision 6 |
|---|---|---|---|
| 1 | Panel resizing exposes consult presence and timing to ChatGPT | Yes, `private-answer.ts:875–899` | **Accepted.** Fixed outer height from first reveal through the follow-up period, reserved strip, internal scroll; host-message transcript test across all outcomes (§A.5, C4a) |
| 2 | `follow: true` protects only one path; withdrawal is a plaintext `failed` | Yes, jobs `:545–555`, `:553`; relay forwards body opaquely | **Accepted.** One uniform post-claim response on every install; `follow` flag removed; withdrawal moved inside the envelope (§A.5) |
| 3 | 16 KiB is not an established bound | Yes, jobs `:307–316`, crypto pad buckets grow | **Accepted.** 32 KiB fixed envelope; per-field serialized byte budgets totalling 30,720 B; deterministic overflow; fill test (§A.5) |
| 4 | "No document text, name, figure or identifier is sent" overstates the gate | Yes, gate `:42–64`, test review-3 `:88–89`, `mcp-surface.ts:305` | **Accepted.** Real guarantee stated; known gaps listed; the user's question is a hosted tool argument (§A.4) |
| 5 | Eligibility not at the actual submission boundary; sweep residual | Yes, transport warm-up before dispatch; `analyst-answer.ts:2724–2727` | **Accepted.** Warm-up and writer first, then recheck settings, liveness, deadlines, latch and eligibility, then gate, then send at once; residual documented (§A.7) |
| 6 | Citation checks cannot stop an injected reply from fabricating document claims | Yes, `analyst.ts:401–410`, `:728`; audit off | **Accepted; made moot.** No rewrite in version one; reply shown as a labelled plain-text block; no model reads it (§A.6) |
| 7 | Preemption on the shared `--parallel 1` server does not meet "not slower at all" | Yes, jobs `:788`, `:1065` | **Accepted.** M0 measurement gate before feature code with a pass criterion; the writer never resets the model; fallbacks listed for the owner (§A.7, M0) |
| 8 | Ownership checks do not protect the wallet API before the bridge token | Yes, `owned()` at transport `:1726–1735` covers API and Tor only | **Accepted.** Authenticated wallet-listener ownership before the first token-bearing request is an F2 prerequisite; the label stays until F2 (§Z.4) |
| 9 | The snapshot does not cross the model/jobs boundary; precompute reuse | Yes, depth items local to the model wrapper; jobs keep identities only | **Accepted.** Immutable snapshot from the actual computation, including reuse and depth reads; exact writer-visible texts; bounded retention (§A.3) |
| 10 | A recent poll proves neither an open panel nor presence | Yes, the claim needs no proof of key possession; auto-collect on render | **Accepted.** Called "recent panel activity"; close/send race and relay replay disclosed; replay-resistant liveness deferred with reasoning; send-once latch; cost wording names the real trigger; CLI enforces the acknowledgement (§A.5, §A.9, §A.10) |
| 11 | Early reply and warm-up need one session lifecycle; "cannot be cut short" was false | Yes, lease `:1546`, `daemon_already_running` `:1636`, late abort `:1884`, fetch abort `:1975` | **Accepted.** One supervised session with `open`/`cancel`/`send` and `reply`/`finished`; lease through teardown; no caller abort after dispatch; claim corrected (§A.8) |
| 12 | Paid-result retention, deadlines, eviction and restart underspecified | Yes, settings defaults; eviction at 200 jobs | **Accepted.** Separate start, delivery-room and collection deadlines; no paid work without delivery time; eviction-last and restart losses stated; latch (§A.5, §A.8). The rewrite-preemption part is moot |
| 13 | Searchable consult records add durable injection and false-evidence risk | Yes | **Accepted.** Removed from version one; content-free receipts only (§A.12) |
| 14 | An unchanged fingerprint does not establish unchanged semantics | Yes | **Accepted.** "Contract impact: none" replaced by explicit architecture decision AD-1 for review sign-off (§A.11) |
| 15 | Trigger data missing; writer and latency estimates not bounded | Yes, `sufficient` dropped after gap filtering in `analyst-built-in.ts` | **Accepted.** Explicit `sufficient` and no-answer metadata; writer prompt ≤ 2,048 model tokens by the server's tokenizer; labelled estimates; live timing moved first (M1) (§A.2, §A.3) |
| 16 | "Abandon writes the reservation off" hides a privacy consequence | Yes, transport `:703–710` | **Accepted.** Consequence stated in the design and in the confirmation; manual and separate from Recover; cancel-before-dispatch proof in C2 (§A.8) |
| 17 | Sandbox evidence overstated; does not qualify the production bundle | Yes, `run-poc.out` (unused port refused and non-loopback timed out even without the sandbox; fake companion and Tor; `run-poc.sh:23–25` auth off, reuse 60 s) | **Accepted.** Claims narrowed to the recorded probes; real-companion, auth, reuse-0, Unix socket, UDP/DNS, address-family and listener-replacement tests and whole-bundle pinning added as F2 prerequisites (§Z.4) |
| 18 | C4 too large; decisive proofs too late | Yes | **Accepted.** M0 and M1 first; C4 split into protocol-plus-panel (C4a) and scheduling (C4b); the composition stage is gone; the record connector removed; first usable version is C5 (§A.14) |
| 19 | G7 omits web sources through the host; milestone wording stale | Yes, `private-answer.ts:590–600`; `V0_4_RELEASE.md` now leads with Olympus 1.0 | **Accepted.** Web-source exception and the host and relay visibility table stated; positioned as a candidate for after 1.0 (§2, §A.5, §A.7) |

None rejected.

Questions for the next review:
1. Does the uniform 32 KiB envelope make every per-answer outcome invisible to the relay and the host? Check pre-claim responses, timing of guard-dependent withdrawal, and Mac source-open traffic.
2. Is AD-1 (the outside block as panel presentation) acceptable under `CONTRACTS.md`?
3. Is deferring replay-resistant liveness reasonable, given dispatch once per job about a minute after the claim?
4. Does the M0 pass criterion actually capture "the first answer is not slower"?

## G. Fourth round: confirmation pass on revision 6, revision 7 written (2026-10-05)

Reviewer: Codex (gpt-6-astra), read-only, revision 6 at `09edd944`, against `main` at `bb1755fb` and the gate at `47c5acd6`. It ran in-memory byte probes against shipped code. Its concurrency, privacy and UX sequences are code-grounded analysis, not runs. **Verdict: ready after listed changes.** No further redesign was needed, but the reviewer found ten precision problems and set conditions on AD-1. The author re-checked the cited lines. All hold:
- the jobs boundary limits (65,536 / 20 / 10 / 300 / 2,048);
- the growing bucket padder;
- `claimKey` set before the answer is ready, with later `202`, `429` and plaintext `failed`;
- the job keeping only sealed bytes, with the seal discarding its ephemeral key;
- the handshake-dependent height reporting and `max-height:none`;
- the card title "Private answer from your Mac";
- reservation and fence before the last awaited ownership check (`consult-transport-zkapi.ts:1805–1822`);
- the relay's 8 MiB response limit.

None rejected.

### The reviewer's status of the 19 earlier findings

| # | Earlier finding | Status | Evidence (reviewer's) |
|---|---|---|---|
| 1 | Panel resizing exposes consult outcomes | Partly | Lock ended with follow-up; banned sizing messages needed after initialization; reopen and late initialization unspecified. Panel :864–918 |
| 2 | `follow` protects one path; plaintext withdrawal | Partly | "Every collection after claim" conflicted with existing post-claim pending, failed and rate-limited responses; no initial pending or failed state. Jobs :529–555 |
| 3 | Envelope size bound | Not | False for accepted inputs (65,536 units, 20 citations, escaping beyond 3 B per unit); padder turns 30 KiB into 64 KiB. Jobs :307–312, :1253–1258; Crypto :70–82 |
| 4 | Gate guarantee overstated | Resolved | Public wording still needed correction |
| 5 | Eligibility checked too early | Partly | `send()` still needed async ownership checks after reservation; no final authorization boundary. Transport :1729–1745, :1805–1824 |
| 6 | Rewrite turns hostile text into document claims | Resolved | Direct deception of the reader remained (P7) |
| 7 | Shared-server preemption | Partly | Criterion allowed abort latency and "about 1 s" |
| 8 | Wallet listener gets the bridge token | Resolved as an F2 prerequisite | The prototype must not qualify F2 |
| 9 | Snapshot handoff | Resolved | — |
| 10 | Recent polling is not presence | Partly | "About a minute" conflicted with the five-minute dispatch allowance |
| 11 | One session lifecycle | Partly | `open()` not cancellable; send, cancel and reservation races unspecified |
| 12 | Retention, deadlines, eviction | Partly | Paid-job eviction priority leaked an outcome; the original answer could not be freshly sealed once its plaintext was dropped |
| 13 | Searchable records | Resolved | — |
| 14 | Fingerprint is not semantics | Resolved with conditions | See AD-1 |
| 15 | Trigger metadata and writer bounds | Resolved at design level | C4b must implement the handoff |
| 16 | Abandon's consequence | Resolved | — |
| 17 | Prototype overstated | Resolved | — |
| 18 | C4 too large | Partly | Compatibility, serialized bounds and hostile-text acceptance needed to be explicit entry and proof requirements |
| 19 | Web sources; milestone | Resolved | — |

### P1–P10 and AD-1: dispositions in revision 7

| # | Problem | Disposition (where) |
|---|---|---|
| P1 | M0 could pass while violating "no slowdown" | **Accepted.** Endpoint is fresh-request arrival to first reveal with abort delay included. Paired randomized writer-versus-control trials on identical workloads, with the real prompt, tokenizer and schema. Phases: prefill, generation, near-deadline, hung writer, plus an A/A noise floor. Rule: median ≤ 250 ms, p95 ≤ 1 s, zero writer-caused resets, failures counted as infinite. This is the owner's default and is flagged for him in §10. Results table ready to fill. Idle-only scheduling is marked a hypothesis (§A.7) |
| P2 | Envelope proof did not fit the accepted payload | **Accepted.** One payload contract enforced at the jobs boundary before first reveal, on every install. It tightens answer 65,536 → 2,700 units, citations 20 → 4 and gaps 10 → 4, each matched to what the model layer produces today (no production limits override; nothing shown today is cut). A total serializer handles lone surrogates, control characters, URL normalization and a marker inside its budget. An exact-size padder pads to 36,864 B of plaintext and rejects overflow. The wire size is stated separately (§A.5.1). The 32 KiB figure could not be proven for this payload; 36 KiB can |
| P3 | "Uniform after claim" incomplete | **Accepted.** Phase 1 is today's fast acquisition (2-second polling, existing plaintext states). Phase 2 is uniform from first delivery, with infrastructure and identity exceptions listed. A `cap: 2` handshake is sent unconditionally, and paid dispatch requires it. Old/new behavior for both mismatches is stated (§A.5.2) |
| P4 | Fresh sealing needs a retained answer and race rules | **Accepted.** The job keeps its first-answer plaintext (≤ 35,328 B; about 7 MB across 200 jobs), only on capability-2 jobs with outside help on, the smaller exposure. Withdrawal is terminal and clears everything. Sealing is checked before and after; revisions are monotonic; a late reply cannot resurrect a job; source-open tokens are stable across seals (§A.5.3) |
| P5 | Fixed sizes do not hide every outcome | **Accepted.** Expiry and eviction no longer depend on outcomes (policy-bound lifetime, oldest-first eviction, no paid-result protection). The timing claim is narrowed; a timing test, and a response-time floor if needed, are in C4a (§A.5.4) |
| P6 | Height lock broke the host handshake and leaked later | **Accepted.** The reported geometry is locked, not the notifications: `H = min(A + R, 640)`, with `A` the first-answer card alone and `R` = 176 px. The same rule applies after follow-up ends and on reopen. The transcript test is expanded. The withdrawal-on-resize residual is stated (§A.5.5) |
| P7 | Plain text does not stop misleading attribution | **Accepted.** A separate container outside the card title, a pinned application-owned attribution, a 40-line / 240-character policy, blank-line collapsing, an application-owned truncation notice, and hostile-text tests. Residual risk accepted; no second model pass (§A.6) |
| P8 | Session API did not enforce the dispatch boundary | **Accepted.** One-shot state machine with a cancellable, deadline-bound `open`. Async transport checks run first, then final authorization (settings, activity, deadlines, latch, eligibility, gate), then synchronous reservation and fetch. Rollback on a proven pre-dispatch failure; the fence is kept when dispatch is uncertain. The test asserts that no paid reservation, count or fence remains, with lifecycle receipts allowed. Caller signals are detached after dispatch (§A.8) |
| P9 | Clocks and liveness need one definition | **Accepted.** Server-owned `firstDeliveredAt`; `followUntil` is fixed and capped by job expiry; remounts never extend it; policy is bound per job; the dispatch window uses the configured `timeoutMs`; the enable wording names the five-minute window and the replay exposure (§A.5.6, §A.10) |
| P10 | Eval and public wording were not acceptance criteria | **Accepted.** Blocking tests B1–B6 with populations and pass marks; known-limit measurements K1–K6 with default-on thresholds; the reviewer's privacy sentence adopted for the README and the enable flow (§2, §A.10, §A.13) |
| AD-1 | Acceptable within a bounded interpretation | **Accepted.** The four conditions are recorded. Any departure enters the contract-change process. The C4a pull request records the interpretation in `CONTRACTS.md`. AD-2 is added for panel-protocol compatibility (§A.11) |

Build plan: the reviewer's suggestions are adopted.
- C3 is the internal settings mechanism only.
- The Mac dashboard enable path lands in C5.
- The public CLI enable command moves to C8.
- The C2-affected stages are re-measured live after C2.
- F1 and F2 do not block the experimental "route not verified" release.
- Every stage now lists its entry conditions (§A.14).
