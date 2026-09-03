# Olympus Source Pipeline Contracts (VERSIONED)

Status: stable, versioned architecture canon
Owner: CTO
Updated: 2026-08-29

## What this is

Three interfaces define every boundary in the Olympus source pipeline. They
encode the load-bearing decision of the source-layer rebuild: **organize by
capability, not by source.** Each source is a thin adapter; ingest, extract,
index, retrieve, reason, and release are written once and shared.

The canonical, compiler-enforced definitions live in
[`src/core/contracts.ts`](../src/core/contracts.ts). This document is the
rationale and the rules. If code and doc disagree, the code wins. Semantic
shape changes follow the versioned compatibility process below; they are never
an incidental refactor.

## Why (read before proposing a change)

The previous source layer was organized by source: `workers/dropbox-files/`,
`workers/email-source/`, and so on, each a multi-thousand-line monolith that
re-implemented the same machinery (schema, FTS5, vector storage, sync
checkpoints, ranking). Two failures followed directly from that shape:

- **Duplication.** ~16K lines of near-identical index code, because "support
  all sources" was built as "build each source."
- **Per-question answers.** With no shared reasoning capability, the answer
  layer grew source-specific templates and query regexes
  (`synthesizeSafeDropboxAnswer`, `queryRequestsQuantitativeDropboxFacts`). The
  system could only answer question shapes someone hand-coded.

Both are the same bug: source-shaped code cannot express a capability-shaped
product, so it fakes it per-source. These contracts remove the ability to make
that mistake — there is exactly one place for per-source code, and it is small.

## The pipeline

```text
SourceConnector (per source, thin)
  -> Normalize         (shared)
  -> Extract by MIME   (shared: one PDF/OCR/Office/text path, not one per source)
  -> Index             (shared: core/source-index spine)
  -> Retrieve          (shared: core/source-index/router.ts + RRF fusion)
  -> EvidencePack      (the retrieval -> reasoning boundary)
  -> Analyst (LLM)     (shared; local for secure_local, cloud/local otherwise)
  -> Release gate      (shared: core/opsec.ts evaluateReleaseGate)
  -> answer + citations
```

Only `SourceConnector` is per-source. If you are writing source-specific code
anywhere else — and especially question-specific or answer-formatting code —
stop. That is the bug this architecture exists to prevent.

## Contract 1 — SourceConnector

The only per-source code. A connector authenticates, lists/fetches raw items,
and classifies trust. Everything downstream consumes the normalized `RawItem`.
A connector should be ~300 lines, not ~6,000.

```ts
interface SourceConnector {
  readonly id: string;            // "dropbox", "gmail"
  readonly family: SourceFamily;
  authenticate(): Promise<void>;  // via the existing credential broker
  listItems(options?): AsyncIterable<SourceConnectorListPage>;  // live sync OR archive import
  fetchItem(localItemId: string): Promise<RawItem>;
  classify(item: RawItem): SourceSensitivity;  // the ONE place policy is source-aware
}
```

`SourceConnectorListPage` is a union, not a record, and the reason is
load-bearing:

```ts
type SourceConnectorListPage =
  | { items; nextCursor?; done: boolean; truncated?: false }
  | { items; nextCursor?; done: false;   truncated: true };
```

`truncated` means the connector cut the page short of what the provider
returned — a run budget ran out mid-page — so `items` is a prefix and the rest
of that provider page is still unread. `done` means the traversal reached the
end of the provider's data. There is no arm for both, so a connector cannot
construct the state. A connector that truncates yields `done: false` and a
`nextCursor` that resumes INSIDE the same provider page.

Notes:

- Extraction does **not** live here. A scanned PDF from Dropbox and a PDF
  attachment from Gmail go through the same shared MIME-keyed extractor.
- `classify` returns `SourceSensitivity` from
  [`source-index/types.ts`](../src/core/source-index/types.ts), which the
  storage-profile builder already uses to enforce local-only handling.

## Contract 2 — EvidencePack

The boundary between retrieval and reasoning. Source-agnostic. This is the
artifact the old answer layer never had.

```ts
interface EvidencePack {
  question: string;
  candidates: EvidenceCandidate[];   // provenance + trust + chunks + optional tables/facts
  coverage: {
    searchedCorpora: string[];
    skippedCorpora: { corpusId: string; reason: string }[];
    extractionGaps: string[];        // "3 scanned PDFs not OCR'd", "images deferred"
  };
  builtAt: string;
}
```

Notes:

- **`coverage` is first-class.** It is how the assistant says "I checked
  Dropbox and email; I could not read 3 scanned PDFs" instead of silently
  returning partial truth. Completeness is only checkable because coverage is
  explicit.
- Local content providers may upgrade sensitivity, but they must never downgrade
  the trust domain routed by the corpus registry. A `secure_local` hit cannot
  become `internal` just because a provider misclassified the fetched content.
- **`facts` are a cache, not the answer.** Structured extractions are useful
  inputs to the analyst. They must never become the only answer path — that is
  how the previous design slid back into per-question parsers.

## Contract 3 — Analyst

Replaces every `synthesizeSafe*` function and every query regex with one
capability.

```ts
interface Analyst {
  analyze(pack: EvidencePack, options: { localOnly: boolean }): Promise<{
    answer: string;
    citations: { provenance: SourceIndexProvenance; claim: string }[];
    unanswered: string[];          // what the evidence could not support
    escalation?: {                 // only when localOnly AND no grounded answer exists
      reason: string;
      redactedPack: EvidencePack;  // bounded derivatives only
    };
  }>;
}
```

Notes:

- One generic prompt: *answer from this evidence only, cite each claim, state
  what you could not find.* No per-question logic, ever.
- Evidence text is untrusted source data. If a document/email/message contains
  assistant-directed instructions, the Analyst treats them as evidence content,
  not commands. This should preserve useful answers without letting source text
  steer the agent.
- `localOnly` routing semantics are governed by the
  [Venice S4 policy](#venice-s4-policy-normative) below.

## Venice S4 policy (normative)

Venice privacy categories are ordered `anonymized < private < tee < e2ee`.
Any EvidencePack carrying `secure_local` (S4) evidence has a Venice privacy
floor of **Private**. Venice is an `encrypted_cloud` analyst approved for raw
`secure_local` S4 packs whenever the install's sovereignty config routes it and
the resolved Venice model's privacy category is Private or above: `private`,
`tee`, or `e2ee`. The `anonymized` category is not approved for S4.

The Venice-published
[List Models catalog](https://docs.venice.ai/api-reference/endpoint/models/list)
is the category authority; Olympus reads `data[].model_spec.privacy`. Any model
in a Private-and-above category becomes category-eligible the moment Venice
ships it, with no per-model Olympus allowlist; dispatch-readiness gates still
apply. Olympus keeps a durable catalog cache with a 24-hour default TTL. The
pinned snapshot is an offline fallback only: it is consulted when the catalog
is unreachable and the cache is stale or absent. An unsigned fresh cache cannot
by itself upgrade a model that the pinned snapshot classifies as `anonymized`.
A successful live catalog response remains authoritative.

The secure-answer pool currently has one additional dispatch-readiness gate:
normalized `e2ee-*` ids are refused with a typed policy error until Olympus has
local key handling. E2EE still satisfies the Venice category floor; it is set
aside operationally, not reclassified. While this gate stands, Olympus runs
Venice in Private mode. The Venice defaults are the Private models `kimi-k3`
(the strong default for every Venice task except embeddings, which never leave
local) and `inkling` (the normal tier); cheaper Private models may serve
low-intelligence work, though the local Qwen normally covers that tier.

`standard_cloud` is banned for every pack containing `secure_local` candidates.
S5 and `blocked_sensitive` content never leaves local and never enters any
cloud analyst, including Venice.

The two approved flows are deliberately distinct:

1. S4 reasoning follows one two-step decision flow. First: is Delphi's default
   local model intelligent enough for this task? If yes, use Delphi. If not —
   or when it is already known that the task needs more than the Delphi
   default — use Venice `kimi-k3`. The policy deliberately does not name the
   Delphi model: whatever Delphi currently serves as its default is the first
   stop, so a Delphi upgrade changes the answer without changing this text.
   `kimi-k3` is multimodal, so this covers vision work too; Grok models are
   deprecated as defaults but remain approved Private models on explicit
   request. `local-first` encodes this order (Argus before Venice);
   `private-cloud-only` contains only Venice.
2. Before a raw S4 pack reaches Venice, the Venice adapter resolves the model's
   category from a fresh live or cached catalog. Categories Private, TEE, and
   E2EE satisfy the category floor; `anonymized` produces a typed policy
   refusal. While the local-key gate above stands, secure-answer pool
   `e2ee-*` ids receive their own typed refusal before construction. A
   cached-catalog miss triggers one bounded, rate-limited catalog refresh.
   Absence after a successful refresh refuses. If refresh is unavailable and
   the cache is stale or absent, only the pinned offline snapshot may resolve
   the model; absence there also refuses. Every refusal occurs before chat
   dispatch and never falls back to another provider.
   `egress_destination` appears in two kinds of receipt with two meanings.
   Queue-lifecycle receipts (enqueue, lease, lease-recycle, janitor-requeue,
   retire, retarget) declare the static approved floor, `venice_private` —
   nothing is resolved at those points. The extraction batch receipt names the
   category actually resolved at dispatch: `venice_private`, `venice_tee`,
   `venice_e2ee`, or `venice_mixed_approved`. Proof gates assert approved-set
   membership on both and treat the batch value as authoritative; they do not
   demand the two be equal.
3. `standard_cloud` escalation receives only a **redacted** EvidencePack of
   bounded derivatives. A local analyst may propose that redacted pack when it
   cannot produce a grounded answer; the proposal goes through
   `evaluateReleaseGate` (`needs_approval` / `s4_release`) before dispatch.
4. Secret patterns hard-deny, and every allowed S4 release remains subject to
   the shared release gate before Castor-visible output.

The optional Analyst `escalation` field carries the standard-cloud redacted
derivative flow. Raw S4 Venice routing is configuration-driven and does not
change any frozen interface shape.

Owner-ruling lineage: 2026-05-28 chose local-first with approved cloud
escalation; 2026-07-06 clarified that local-first is the owner-shaped default
route order, not a hard invariant; 2026-07-11 confirmed raw-S4 category
eligibility for Venice Private and E2EE categories; and 2026-07-20 stated the
general Private floor and explicitly included TEE. On 2026-07-21, the owner
ruled that Venice's published catalog is the category authority. On 2026-07-23,
the owner made the secure pool the primary abstraction and set E2EE
secure-answer ids aside until local key handling exists. On 2026-07-29, the
owner simplified the operating policy: every Private-or-above Venice model is
approved for all S4 across every source (only `anonymized` is excluded), the
S4 flow is the two-step decision above, the Venice defaults are `kimi-k3`
(strong, including vision) and `inkling` (normal), Grok is deprecated as a
default, and policy text must not pin the Delphi local model by name. This
section consolidates and supersedes all other policy wording.

## Compatibility and change rule

- Ordinary changes **implement** these interfaces. They do not add fields,
  change shapes, or invent parallel types to evade them.
- **No source-specific branches downstream of `SourceConnector`.** No
  question-specific logic anywhere in the `Analyst`.
- A semantic change increments
  [`config/source-pipeline-contract-version.json`](../config/source-pipeline-contract-version.json)
  and records compatibility/migration, held-out eval, and independent-review
  receipts. The change and reason are also recorded below.

### Change log

- 2026-07-30 — `egress_destination` semantics stated precisely: lifecycle
  receipts declare the static approved floor (`venice_private`); only the
  extraction batch receipt names the category resolved at dispatch. The
  extraction proof asserts approved-set membership on both instead of
  demanding equality, which falsely failed correctly configured TEE and
  mixed-approved systems. Live-catalog lookups are now case-tolerant (exact
  key first, then one case-insensitive scan) so a newly shipped Venice id
  with an uppercase character resolves instead of refusing as unknown.
- 2026-07-29 — Extraction batch receipts now use `egress_destination` to name
  the resolved approved category (`venice_private`, `venice_tee`,
  `venice_e2ee`, or `venice_mixed_approved`) rather than treating
  `venice_e2ee` as the only remote lane. Private, TEE, and E2EE remain the
  approved set; anonymized and unknown destinations remain refused. The
  unsigned-cache rule is also explicit: cache alone cannot promote an id that
  the pinned snapshot classifies as anonymized, while a successful live
  catalog response remains authoritative. Frozen SourceConnector,
  EvidencePack, and Analyst shapes are unchanged.
- 2026-07-29 — Owner ruling simplified Venice S4 operations: one two-step flow
  (Delphi's default local model first; Venice `kimi-k3` when more intelligence
  is needed); Venice defaults become `kimi-k3` (strong, including vision —
  Grok deprecated as a default) and `inkling` (normal), both Private; E2EE
  remains set aside; policy text stops pinning the Delphi model by name.
  Category floor, catalog authority, and frozen contract shapes unchanged.
- 2026-07-28 — **Contract 1 shape change (CTO decision).**
  `SourceConnectorListPage` gains an optional `truncated` flag and becomes a
  union with no arm for `done: true` plus `truncated: true`. A connector that
  slices a provider page down to a run's remaining budget was able to report
  the partial page as a completed traversal; the spine keeps a done page's
  cursor as the checkpoint, so that cleared the resume point for items nobody
  had read and restarted the lane from the beginning on every later run. The
  flag is optional and defaults to absent, so every existing connector is
  unchanged. EvidencePack and Analyst shapes unchanged.
- 2026-07-23 — Secure reasoning now routes through a deployment-approved pool
  of equal first-class members unless explicit order is configured. E2EE
  secure-answer model ids are typed-refused until local key handling exists;
  the Venice category floor and frozen contract shapes are unchanged.
- 2026-07-21 — The owner made Venice's published model catalog the category
  authority so new Private, TEE, and E2EE models are approved immediately;
  the pinned table is now offline fallback only. The category floor and frozen
  contract shapes are unchanged.
- 2026-07-20 — The owner ruling made the Venice category floor explicit; it is
  incorporated into the [normative policy](#venice-s4-policy-normative).
  Contract shapes unchanged.
- 2026-07-11 — The owner clarified Venice S4 approval scope; the later ruling
  and complete lineage are incorporated into the
  [normative policy](#venice-s4-policy-normative). Contract shapes unchanged.
- 2026-06-21 — Venice E2EE extraction integration approved (CTO decision); its
  policy effect is incorporated into the
  [normative policy](#venice-s4-policy-normative). Recipe policy may report
  `local_only:false` with `egress_destination` naming the resolved approved
  category for Venice extraction batches; loopback local recipes remain
  `local_only:true`. Frozen SourceConnector/EvidencePack/Analyst shapes
  unchanged.
- 2026-06-13 — Usability-forward secure derivative posture clarified (CTO
  approval); its policy effect is incorporated into the
  [normative policy](#venice-s4-policy-normative). Contract shapes unchanged.
- 2026-06-11 — internal.email corpus registered (CTO approval): per-item
  classified-internal mail serves as internal evidence;
  `secure_local.email.private` retains detectors/pending/unclassified.
- 2026-06-10 — Lane F deletion milestone: the pre-contracts template path
  (`answer.ts`) was deleted; the Analyst is the only `source_answer` path and
  serves all six corpora. Wire types live in
  `src/workers/source-index/answer-types.ts`. Contract shapes unchanged.
- 2026-05-30 — Added Analyst source-instruction handling guidance and the
  EvidencePack trust-domain downgrade rule. Contract shapes unchanged.
- 2026-05-28 — Contracts frozen; the Venice ruling is incorporated into the
  [normative policy](#venice-s4-policy-normative).

### Enforcement

Docs are the weakest form of enforcement, so compatibility is mechanical and
survives any thread or tool:

- **`bun run contracts:check`** fingerprints the canonical declarations and
  rejects shape drift unless the latest version entry has a higher semantic
  version plus compatibility/migration, eval, and review receipts.
- Focused local proof is the normal edit loop. GitHub Actions runs every test
  in parallel on every pull request, and branch protection requires each
  substantive lane directly rather than paying for an aggregate runner job.
- **`test/architecture-guard.test.ts`** fails the build if the deleted
  pre-contracts template path reappears, or if template/regex answer code
  appears anywhere in `src/`. Fix the change; do not weaken the guard.
- **The held-out eval** (`eval/`) is the definition of done for the source
  pipeline — unfakeable by a template, unlike a known-answer demo.

Agents are oriented to this in [`../AGENTS.md`](../AGENTS.md) (Architecture
section + a paste-able kickoff card for non-Claude threads).

## Definition of done

A structural source-pipeline change is done when it **passes the held-out eval** (see
[`eval/README.md`](../eval/README.md)), not when a known-answer demo passes. A
demo proof on a question the code was tuned against is gameable by a template;
the held-out eval is not. This is the metric that keeps implementation honest.

The initial versioned baseline is `1.0.0` (2026-08-29). It preserves the
previously frozen shapes without a runtime or data migration.

## Change log

- 2026-07-28: `SourceChunkIdentity` gains an optional `span` (offset citation
  coordinates). Additive and optional; none of the three frozen interfaces
  changed shape. Recorded here because the member is reachable from
  `SourceIndexProvenance`, and the freeze's spirit is that reachable-shape
  changes are declared, not discovered.
- 2026-08-20: corpus-level readability is reported BESIDE `coverage`, not in it.
  `coverage.extractionGaps` can only ever describe a document the router
  returned, so a document whose unreadable pages hold the answer contributes
  nothing to it — it never becomes a candidate. The counts-only corpus signal
  that closes that hole rides `EvidencePackBuildDetail.corpusReadabilityGaps`
  (`LocalContentProvider.corpusReadability`, optional), and the release layer
  attaches it only when an answer carried no citable evidence. It was kept OUT
  of `extractionGaps` deliberately: every entry there is force-folded into the
  answer's unanswered notes AND read into the Analyst prompt, so a corpus-wide
  count placed there would hedge every answer whose corpus holds one unread
  document. No frozen interface changed shape.
