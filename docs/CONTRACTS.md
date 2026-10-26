# Olympus Source Pipeline Contracts (VERSIONED)

Status: stable, versioned architecture canon
Owner: CTO
Updated: 2026-10-25

## Display terminology

Use Personal, Private, and Secrets in user-facing explanations; Public only
for an install made before 1.0, whose policy keeps a Public tier (owner ruling
2026-10-13: no new install has one).
[TRUST_MODEL.md](TRUST_MODEL.md#product-tier-names) defines their mapping to
unchanged S0–S5 tiers and `public_safe` / `internal` / `secure_local` domains.
In technical names below, `secure_local` and secure-pool symbols refer to the
Private tier. This terminology update changes no contract or routing semantics.

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
and publishes the classification signals it knows as provider facts. Since
2.0.0 it no longer decides a tier: the shared, source-agnostic tier classifier
does. Everything downstream consumes the normalized `RawItem`. A connector
should be ~300 lines, not ~6,000.

```ts
interface SourceConnector {
  readonly id: string;            // "dropbox", "gmail"
  readonly family: SourceFamily;
  authenticate(): Promise<void>;  // via the existing credential broker
  listItems(options?): AsyncIterable<SourceConnectorListPage>;  // live sync OR archive import
  fetchItem(localItemId: string, options?: { deferredBytes?: { locator: string } }): Promise<RawItem>;  // 2.1.0: the locator of a child's deferred bytes
  classificationSignals(item: RawItem): SourceClassificationSignals;  // source facts, never a tier
  forInput?(input: SourceConnectorInput): SourceConnector;  // 2.2.0: the same connector over another input
}

interface SourceConnectorInput<R = unknown> {            // 2.2.0
  readonly inputId: string;                              // the connector id its sync runs and cursor are recorded under
  readonly kind: 'live' | 'archive';
  records(options?: { cursor?: string; limit?: number }): AsyncIterable<SourceRecordPage<R>>;
}

interface SourceClassificationSignals {
  floor?: { tier; basis };                 // provider fact setting a minimum tier
  prior?: { tier; strength: 'prior' | 'force'; basis };  // configured resting tier
  sharing?: 'public_link' | 'published' | 'shared' | 'private' | 'unknown';
  title?; path?; folderKeys?; sender?; recipients?; labels?;
  conversationKind?: 'direct' | 'group' | 'channel' | 'secret_chat';
}
```

Tier keys use the schema-v1 stored names: `public` (Public), `private`
(Personal), `secure` (Private), `secrets` (Secrets).

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
- `classificationSignals` returns source facts only. The shared classifier
  ([`tier-classifier.ts`](../src/workers/classification/tier-classifier.ts))
  turns them, plus the item's text, into a metadata tier and a content tier
  with content-free reasons, and the store records the decision in the tier
  ledger. It reads signal kinds only and never branches on a source name.
- Only `public_link` and `published` are positive evidence for Public. A
  connector that cannot read sharing state publishes none.
- **Children (2.1.0).** An attachment or a piece of media is an item of its
  own: its identity names its `parent`, it is listed `metadata_only` with
  `deferredBytes` (a connector-owned `locator`, whether the source says the
  bytes `available`, and the `sizeBytes` it states), and the shared extraction
  factory reads it later through `fetchItem(localItemId, { deferredBytes })`.
  The connector publishes no tier for it; the classifier judges the child on
  its own. See [child items](design/child-items.md).
- **Inputs (2.2.0).** A source has one connector and it is the only writer of
  the source's items. The live reader is one input; each imported archive is
  another, emitting the live reader's own record shape through the same
  record-to-item code (`SourceConnector.forInput`, `src/core/source-inputs.ts`).
  Each input keeps its own cursor under its own `inputId`, so an archive never
  moves the live cursor, and a crash replays the input from its last committed
  cursor. Before a record's item is built, the connector asks the store lane
  what it holds (`SourceConnectorListOptions.storedItem`, given the source's
  own order of versions and answering with the newest version any row of the
  item holds, whether it holds content, and whether it is incomplete or
  tombstoned) and applies the record only if it is newer in that order, or at
  the same version brings content the stored item lacks or completes an item
  cut off between legs; an older record never applies, whatever the
  completeness or visibility of what is stored (it never restores a deleted
  item or a Secret, nor overwrites an item written to one leg only); on a tie
  the live record is kept. The rule
  keeps no state of its own: the store is the record of what applied. An item
  built from an archive record carries `RawItem.holdContentUntilJudged`, which
  placement honours like the lane option of the same name and which keeps
  applying to the item's later versions, a live replacement included, until
  the private model has judged it. See
  [archives and live connectors](design/archive-live-one-dataset.md).
- Storage placement is the store lane's declaration
  (`ConnectorStoreSyncOptions.placement`), not the connector's. In 2.0.0 each
  lane declares exactly what its connector's `classify()` used to return, so
  no stored item moved (design phase P1a).

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
    matchCounts?: {                  // v1.1.0: breadth beyond the bounded evidence
      corpusId: string; family: SourceFamily;
      matchedItems: number; contentMatchedItems: number;
      atLeast: boolean; inEvidence: number;
    }[];
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
- **Evidence is a bounded selection; `matchCounts` is the breadth.** The pack
  holds the best passages that fit its budget, and `matchCounts` says how many
  items each searched corpus matched (a lower bound when `atLeast`), so the
  Analyst can report "23 emails and 6 files match" instead of mistaking the
  slice for the whole. Counts only: no titles, paths, or identifiers.
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
(the strong reasoning default) and `inkling` (the normal tier); cheaper Private models may serve
low-intelligence work, though the local Qwen normally covers that tier.

`standard_cloud` is banned for every pack containing `secure_local` candidates.
S5 and `blocked_sensitive` content never leaves local and never enters any
cloud analyst, including Venice.

### Secure embeddings

Owner decision, 2026-09-10: when an installation has no local embedding
provider, an explicitly configured Venice embedding profile may embed S4
content and retrieval queries. It must resolve an embedding model from
Venice's `models?type=embedding` catalog at the same Private-or-above floor;
unknown, anonymized, or unsupported E2EE models refuse before content dispatch.
An approved answer model or a Venice API key alone does not authorize an
embedding model. Ordinary cloud embedding providers, including Gemini,
remain forbidden for S4; S5 remains forbidden for every remote provider.

The default Venice embedding model is `text-embedding-qwen3-8b`, with 4096
dimensions. Local secure embedding profiles remain preferred when configured.
An unavailable local endpoint must not silently switch a populated corpus to
another model. Document and query vectors must share the exact provider,
model, dimension, configuration, and epoch identity. Existing installations
retain their selected profiles and vectors until an approved configuration
change; activation and any backfill require advance cost approval and an
embedding-ledger entry. The secure-data `local-only` and `no-sensitive`
boundaries remain unchanged.

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

- 2026-10-26 (v2.3.0, additive): **text the provider supplies**
  (`docs/design/child-items.md`, "Text the provider supplies", decided in #532).
  Optional `RawItem.providerText` (`text`, `form`: `prose` or
  `recognized_words`, `label`, optional `terms`). The shared extractor uses it
  as an item's text only when no reader produced any; the text says whose
  reading it is ("Text recognized by Evernote (approximate words, not an exact
  quote)") and goes through the same sink, judge, hold and store as any
  extracted text. The extraction record names it (`provider_text`). No store
  schema change. First supplier: the Evernote archive connector, from an
  attachment's `<recognition>`. Not yet: a citation field naming the provider
  (the stored text says it), and the provider's words as extra search terms
  when a reader did produce text.
  Version: 2.3.0. Fingerprint: `config/source-pipeline-contract-version.json`.
- 2026-10-25 (v2.2.0, additive): **one pipeline for a source's two ways in**
  (owner direction 2026-10-25; `docs/design/archive-live-one-dataset.md`,
  reviewed in two rounds). Additive and optional, no existing field changes:
  `RawItem.holdContentUntilJudged`, `SourceConnectorListOptions.storedItem`
  (a `StoredItemLookup`, given the connector's own order of versions,
  answering with a `StoredItemState`: the newest version any row of the item
  holds, tombstones and a lone leg included, whether the item holds content,
  and whether it is `incomplete` or `tombstoned`), and `SourceConnector.forInput` (a
  `SourceConnectorInput`: `inputId`, `kind` of `live` or `archive`, and
  `records` as `SourceRecordPage`s, the connector's own record shape). A
  connector that omits them, and a consumer that ignores them, behave as under
  2.1.0. One connector per source, the only writer; the live reader and each
  imported archive are inputs of it, each with its own cursor recorded under
  its own connector id in the set's sync runs, so an archive never moves the
  live cursor. The shared intake rule (`decideIntake`, `inputConnector` in
  `src/core/source-inputs.ts`) decides per record, before the item is built:
  newer in the source's own order applies; older never does, whatever the
  completeness or visibility of what is stored (an old record never restores a
  deleted item or a Secret kept as a location, nor overwrites an item that
  was written to one leg only); at the same version a record applies if it
  brings content the stored item lacks or completes an incomplete item; on a
  tie live wins. Each version of an item an input brings is classified and
  routed on its own. It keeps no state of its own, so a crash replays a
  record and decides again. The hold moves to the item: placement honours
  `holdContentUntilJudged` through first classification and child extraction,
  and a persisted hold keeps applying to later versions, a live replacement
  included, until the private model has judged the item, so a live replacement
  of a held item errs Private; a newer archive record over an item live stored
  as Personal replaces it in one write (the lower copies go first and the new
  body lands in the Private store, so no queued move is left to copy the old
  body over it), and a record no store can take yet (its item is in the middle
  of a move) is not passed: the set keeps its resume point and the import is
  not complete until the record is stored. Items built only from live records
  are unchanged. Beside the contracts, the archive import layer
  (not a versioned contract) resolves which account an export joins
  (`resolveImportAccount`: same or new writes into that account's stores;
  unproven asks the owner in the import sheet; different stays under Archives),
  runs a pass inside the source's own exclusive runner, shows each import in
  its source's card with its own counts ("N items from this archive, of which
  M were already there"), progress, findings and Stop, and removes merged
  imports only with the whole source (a new forget step,
  `archive-imports-of-source`). No stored data is migrated: the connector store
  schema, embedding models and epochs are unchanged. No production source
  adopts inputs in this step; the fixture source in
  `test/support/one-pipeline-harness.ts` proves the machinery.
  Version: 2.2.0. Fingerprint: `config/source-pipeline-contract-version.json`
  (`bun run contracts:check`).
  Migration/compatibility: see the version entry.
  Eval: the fixture held-out harness gains a question whose answer needs items
  from both inputs, each cited, and one whose archive item is not yet judged
  and stays out of what is released (`test/eval-one-pipeline.test.ts`). The
  instantiated private run (`bun run eval:real`) needs the owner-private
  dataset and is pending the owner's decision; no exception is claimed.
  Critical-review gate: a source-contract change; it needs fresh independent
  review of its head before merge, alongside required CI under
  `docs/ENGINEERING_PROCESS.md`.
- 2026-10-25 (v2.1.0, additive): **child items** (owner direction
  2026-10-25; `docs/design/child-items.md`, reviewed by Astra in two rounds).
  An attachment or a piece of media that came inside another item is an item of
  its own, read by the shared extraction factory and judged on its own. Four
  optional additions, no existing field changes:
  `SourceItemIdentity.parent` (`providerItemId`, `localItemId` of the item it
  came inside), `RawItem.deferredBytes` (`locator`, `available`, `sizeBytes`),
  a second optional argument to `SourceConnector.fetchItem`
  (`{ deferredBytes: { locator } }`, the locator the store persisted), and
  `SourceCitationMetadata.parentLabel`. A producer that omits them behaves as
  under 2.0.0, and a one-argument `fetchItem` still satisfies the interface.
  A child has the same family, provider, account scope and conversation as its
  parent and the provider item id `<parent>#child:<key>`, so archive removal,
  account delete, ledger withdrawal and conversation grouping already reach it.
  No tier is inherited: a child is Personal, Private or Secrets by its own
  names and content, and never raises its parent. The judge may see the
  parent's names as screened, separately authorized context that is part of
  the judgment's cache identity; a detector result on that context never
  applies to the child. The connector store gains four nullable columns
  (`parent_local_item_id`, `deferred_locator`, `bytes_available`,
  `size_bytes`) and a parent index as an additive migration; existing rows
  have no parent and do not move. `Extractor` gains a required input
  declaration (bytes with `maxInputBytes`, or a file path), enforced while
  reading. A citation's `parentLabel` is built at pack time only when the
  parent's names may go where the candidate goes, and the parent's names are a
  release dependency of the answer, so a revoked label withholds or
  regenerates it. The Analyst's generic prompt is unchanged; no question logic
  is added. Beside the contracts, the archive import layer (not a versioned
  contract) gives a folder-chosen archive's connector `ArchiveConnectorInput.media`
  to bind and read the media files beside its export: an append-only SQLite
  table next to the archive record (`raw/archive-media-bindings.sqlite`),
  written before the child row and the checkpoint, checked with the manifest
  when the import is called complete, and never hashed into a resume point.
  Version: 2.1.0. Fingerprint: `config/source-pipeline-contract-version.json`
  (`bun run contracts:check`).
  Migration/compatibility: see the version entry. Storage invariance:
  `test/child-items-storage-unchanged.test.ts` (existing items, chunks and
  vectors are byte-identical before and after the migration). No embedding
  model or epoch changes.
  Eval: the fixture held-out harness gains cases whose answer exists only
  inside a child, with the cited child naming its parent
  (`test/eval-child-items.test.ts`). The instantiated private run
  (`bun run eval:real`) needs the owner-private dataset; the owner waived it
  for merge by an exception on 2026-10-25, and it runs once a real install
  with data exists. The fixture held-out cases are the receipt.
  Critical-review gate: a source-contract change; it needs fresh independent
  review of its head before merge, alongside required CI under
  `docs/ENGINEERING_PROCESS.md`.
- 2026-10-23 (no contract type version change; tier classifier stays
  `2026-10-13.p6`): **imported content is held until judged** (owner
  direction 2026-10-23; `docs/design/archive-import.md`, "Privacy while an
  import is judged"). A lane option on the connector store's tier
  classification, `holdContentUntilJudged` (`tier-placement.ts`), reaches the
  classifier as `holdUntilJudged`. Read content without a verdict is then
  held pending in Private exactly as an own-record item is, also when no
  model is configured; `content:personal_first` is never set; and every
  non-Secrets decision records `content:held_until_judged`, which re-judging,
  migration planning, the rules sweep, override settling, the store's late
  content path and the tiered extraction sink read back from the stored
  decision. Names follow the existing names rule. Secrets, structured
  identifiers, owner rules, force rules, source floors and overrides keep
  their precedence; an owner prior rule that settled the names also settles
  the content, as it does today. Held questions queue at priority -1, behind
  live own-record (10) and ordinary (0) questions, and the sniffer store's
  clamp floor moves from 0 to -1 for them; the oldest-question slot every
  queue read reserves keeps an import from starving.
  `test/tier-hold-until-judged-guard.test.ts` lets only modules under
  `src/workers/archive-import/` set the option; none exists yet, so no
  install's behaviour changes until an archive import lane ships.
  Version: kept, by the 2026-10-03 precedent (a change no fresh decision can
  see keeps the version). The hold changes only decisions in a lane that sets
  it and no lane sets it, while a bump would re-judge every routed item on
  every install for no change. Evidence: for all 1,596 synthetic corpus cases
  the recorded decision (before and after the fake sniffer's passes), the
  no-model decision, the late-content decision and every queued question
  with its priority and flags are byte-identical before and after this
  change, and the default `bun run eval:classification` report is unchanged.
  SourceConnector, EvidencePack and Analyst shapes, their versions and the
  canonical fingerprint are unchanged (`bun run contracts:check`).
  Migration: none. The reason is an additive reason code; the sniffer store
  schema is unchanged and only the enqueue clamp widens; existing queued
  questions keep their priorities.
  Eval evidence: `archiveHeldCorpus()` runs the same corpus as an archive
  import would bring it (`bun run eval:classification -- --archive`) with one
  more gate, no held item usable below Private before its own judgment; all
  existing gates pass, and once judged the confusion matrix equals the unheld
  run (`test/classification-eval.test.ts`). `test/tier-held-until-judged.test.ts`
  covers the store paths. Like p6, this is wiring and regression proof with a
  deterministic fake model, not a real-model quality receipt.
  Critical-review gate: a critical classification change; it needs fresh
  independent review of its head before merge, alongside required CI under
  `docs/ENGINEERING_PROCESS.md`.
- 2026-10-13 (no contract type version change): tier classifier
  `2026-10-13.p6`, owner-approved Personal-first (2026-10-04;
  `docs/design/categorization-precision.md` step 2). Content without
  own-record signals can be Personal before its individual privacy-safe model
  judgment; own-record signals hold content, and a later Private verdict hides
  the Personal copy before its move. Independently cleared names remain
  available while content waits. Secrets, owner rules, source floors and image
  restrictions retain precedence. This changes classification semantics, not
  the SourceConnector, EvidencePack or Analyst shapes: their versions and
  canonical fingerprint are unchanged; stored tier keys and existing connector
  callers remain compatible.
  Migration/rejudging: no source-contract schema migration or bulk rewrite of
  stored copies. The sniffer store upgrades additively to schema 3 on writable open.
  The v2 migration gives existing questions priority 0 and adds a dispatch
  counter for aging; v3 adds oldest/pass-specific queue indexes and the
  `sniffer_scan` table for durable bounded-scan cursors and pinned oldest
  candidates. Existing queued questions, cached verdicts and the dispatch
  counter are preserved; cursors start empty. Read-only status readers do not
  migrate or write the store. Older writers that know only schema 1 or 2
  refuse to open a migrated v3 store; this is not a downgrade migration.
  The classifier version invalidates older decisions for the existing bounded
  background rejudge path, subject to its owner-rule, override and pending-state
  exclusions. Existing placements remain while a model question waits;
  lowering requires a receipt matching the full stored text, and nonautomatic moves still await the
  owner-approved migration. Rejudging does not release old held bodies merely
  because p6 is installed.
  Eval evidence: `test/tier-personal-first.test.ts` covers immediate ordinary
  content, held own-records, names/body separation and hide-before-move;
  `test/classification-eval.test.ts` exercises the synthetic classification
  corpus with a deterministic fake sniffer. These are wiring/regression proof,
  not a real-model or owner-labeled held-out quality receipt. The 95-email export
  lacks bodies and cannot establish per-row content outcomes. The plan's
  real-corpus eval remains required before rollout (precision improves and
  Private recall stays at least 99%); a missed own-record signal can expose
  content before the model raises it, which cannot recall an earlier cloud use.
  The steering screen is a heuristic over shared canonical text and bounded
  instruction/schema structure. A successful steer can affect only the
  steering item's own tier, never another item: each model call judges one
  quoted item. The worst case is the email's own content being treated as
  Personal. The screen cannot prove that semantic steering is absent.
  Critical-review gate: PR #330 remains a critical classification change and
  needs fresh independent review of its current head and this release boundary
  before merge, alongside required CI under `docs/ENGINEERING_PROCESS.md`.
- 2026-10-10 (no version change) — **AD-1 retired.** The panel's outside
  block and its envelope were removed with the automatic escalation
  (Anonymous answers redesign, step 3). The panel again carries only the
  first answer from `Analyst.analyze`; nothing beside it.
- 2026-10-07 (no version change) — **AD-1, the outside block is panel
  presentation, not an `Analyst` change** (design
  `docs/design/frontier-consult-lane.md` §A.11, owner-accepted 2026-10-07;
  stage C4a). The ChatGPT private answer panel's first answer comes from
  `Analyst.analyze` exactly as before. A later "outside block" (a bounded
  reply from an outside model to a question written on-device) is carried
  beside that answer, inside the panel's sealed envelope
  (`private-answer-contract.ts` `PrivateAnswerEnvelopeV1.outside`), and
  rendered in its own container under the first-answer card. The reviewer
  accepted this within a bounded interpretation that holds only while all
  four conditions hold:
  1. the outside block never becomes a corrected document answer;
  2. it never clears or edits the first answer's gaps (`unanswered`);
  3. it never gains document citations;
  4. it never feeds future reasoning, retrieval or storage.
  Any departure is a semantic change and enters the contract-change process
  above (version and fingerprint, compatibility note, contract tests,
  held-out eval, critical review). None of the three contract types is
  reachable from the envelope, so the fingerprint is unchanged
  (`bun run contracts:check`); no stored data migrates. The panel protocol's
  own compatibility record (AD-2) lives in `private-answer-contract.ts` and
  `docs/design/chatgpt-plugin.md`, "Follow-up collection".
- 2026-10-03 (no version change): the legacy sensitivity map is retired
  (owner decision). The privacy profile (`olympus_privacy_get` /
  `olympus_privacy_set`, `privacy-profile.ts`, which writes always-Private
  owner tier rules) is the only privacy path. Removed: `core/sensitivity-map.ts`,
  `OLYMPUS_SENSITIVITY_MAP_PATH`, `olympus sensitivity validate`, the
  `sensitivity_map` step in the per-item engine and the four-tier classifier
  (`decidedBy: 'sensitivity_map'`), and every lane's map loading. Decisions
  still record `mapRevision`, now always `none` (`TIER_MAP_REVISION`); the
  ledger and the sniffer cache key on it, and a fresh install never had any
  other value, so the classifier version is unchanged (fresh-install
  decisions cannot change). Rows already decided under a map keep their
  exclusion from background re-judging. No upgrade migration: an existing
  install's `~/.olympus/sensitivity-map.json` is no longer read, and its
  rules should be re-added in the Privacy editor. The dashboard view's
  `sensitivity` block is never produced; the field stays only until the
  frontend change that removes the Sensitivity page lands. None of this is
  reachable from the three contract types, so the fingerprint is unchanged.
- 2026-10-02 (no version change): background re-judging and owner-rule
  sweeps (tier classification review fixes). A re-judge of a stored item
  never hides it pending the sniffer's answer: the item stays where it is
  and only a Private verdict raises it (hidden first); with automatic moves
  off (an embedding other than the built-in local model) a raise is queued
  with the item visible, as the owner-approved migration's proposal. A
  secret a re-judge finds in stored text is hidden at once and handed to the
  one Secrets policy. A newly saved raising owner rule (always Private,
  Secrets) is applied to items already stored, hidden first. Automatic moves
  may replace a superseded copy their own item's earlier move left in the
  destination, and a failing move goes to the back of the queue. Items a
  names-only folder covers that were left pending on unread text before
  classifier p4 are settled on their names without a re-list. The tier
  ledger gains schema 4 (additive: `move_attempts`, `rejudged_key`,
  `rejudge_json`), and the classification ledger's approval vocabulary gains
  `built_in_default` (the built-in model's standing default, never counted
  as an owner approval unless the caller asks for that default). None of
  this is reachable from the three contract types; the fingerprint is
  unchanged (design: per-item four-tier classification §2.2 and §9).
- 2026-10-01 (no version change): tier classifier `2026-10-01.p3`. With a
  privacy-safe model configured, EVERY item whose text was read is judged by
  it, with the item's names, before it may be Personal (held pending
  meanwhile); without one, only items whose names were flagged wait. Routed
  items decided under an older classifier version or sniffer prompt are
  re-judged in the background (`tier-rejudge.ts`). A classification-semantics
  change inside the shared classifier: the three contract types and the
  fingerprint are unchanged; no stored data migrates (design: per-item
  four-tier classification §2.2 step [12]).
- 2026-10-01 (no version change): tier classifier `2026-10-01.p2`.
  Vocabulary-only sensitive detector hits (financial and health words, the
  health origin hint) no longer final-decide Private when a privacy-safe
  sniffer can be asked; they make the family borderline and the model judges
  the item (hard categories stay Private). Structured identifiers and secrets
  are unchanged, and with no sniffer vocabulary still raises to Private. A
  classification-semantics change inside the shared classifier: the three
  contract types and the fingerprint are unchanged; no stored data migrates
  (design: per-item four-tier classification §2.2).
- 2026-10-01 (no version change): a new consumer of the EvidencePack. On
  the ChatGPT path (`olympus_search`, `src/workers/chatgpt/`) the engine runs
  the shared EvidencePack build restricted to Public and Personal tiers,
  passes each candidate through the same release gate an Analyst answer
  passes, and returns the released items (source label, title, an https link
  only where released, date, bounded excerpt) with counts-only coverage to
  ChatGPT, whose own model then does the Analyst's job under the one generic
  instruction: answer from this evidence only, cite each claim, say what you
  could not find. No Analyst is called on that path and no per-question logic
  is added; `source_answer` stays the Analyst path and is listed to ChatGPT
  only when an answer model is set up on the Mac. Private evidence never
  enters that pack. The three contract types are unchanged, so the
  fingerprint is unchanged; no stored data migrates.
- 2026-10-01 (no version change): Names only is reported apart from
  unreadable. An item in a folder the owner set to Names only (or under a
  metadata-only ingestion rule) is returned by its content provider without
  text and marked `LocalContentBlock.namesOnly`; the build detail carries
  `namesOnlyCandidateIndexes` and `unreadCandidates` beside the pack, and
  released coverage gains `names_only_items` next to `unreadable_items`.
  "Could not read" now means a genuine failed read (no provider, nothing
  returned, no text); a deliberately unread match gets its own counts-only
  sentence, and a truncated excerpt is no longer counted as unreadable. The
  per-item gap string still reaches the Analyst. The three contract types are
  unchanged; no stored data migrates.
- 2026-09-23 — **Four-tier classification P2 (no contract shape change).** The
  privacy-safe sniffer answers the classifier's open questions (a local model
  or Venice Private only, owner-approved in the classification ledger, verdicts
  cached per material hash, model, prompt version and map revision); owner tier
  rules load from `~/.olympus/tier-rules.json`; `olympus tier set|explain|rules|classifier`.
  Every lane now records decisions with the owner's map, rules and sniffer.
  Decisions only: no storage, routing or embedding change.

- 2026-09-23 — **SourceConnector 2.0.0 (breaking; owner-approved design
  [per-item four-tier classification](design/per-item-four-tier-classification.md)).**
  `classify(item): SourceSensitivity` is replaced by
  `classificationSignals(item): SourceClassificationSignals`: connectors publish
  source facts (floor, prior, sharing, names, sender, recipients, labels,
  conversation kind) and the shared tier classifier decides a metadata tier
  (Personal by default) and a content tier (only ever raised). Decisions and
  content-free reasons are recorded in a new local tier ledger, one per
  connector store and co-located with it (`<store>.tier-ledger.sqlite`), so data
  export/delete reach it wherever the store lives. A decision made without
  reading the text never replaces or lowers a content tier decided from text;
  text that arrives later (the extraction factory) records its own content
  decision. EvidencePack and Analyst shapes are unchanged.
  **Migration note.** No stored data migrates in this version. Each store lane
  declares the placement its connector's `classify()` returned (Readwise and X
  S1/internal; Dropbox S4/secure_local raised to S5 on a secret in the body;
  Gmail and Drive keep the shared raise-only classification policy; Telegram,
  WhatsApp, Apple Messages, Roam and Reflect keep their store's domain), so
  existing placement is preserved. For declared-placement lanes the stored
  items, chunks and vectors are byte-identical with and without the ledger and
  nothing is re-embedded (`test/tier-p1a-storage-unchanged.test.ts`, with
  per-lane parity against the retired classify() answers in
  `test/tier-p1a-review-fixes.test.ts`). Gmail and Drive keep the shared
  raise-only classification policy unchanged; their re-fetch path no longer
  calls the connector's own classify() and uses that same shared policy, whose
  input differs slightly (the listing text rather than the snippet), so there
  the guarantee is "the existing policy, unchanged", not byte identity. A third-party connector migrates
  by deleting `classify()`, adding `classificationSignals()` with the facts it
  knows, and passing its old answer as the lane's `placement`. Moving items to
  their recorded tier is phase P1b and runs only as owner-approved batches
  (design section 4.6).

- 2026-09-10 — Owner approved a Venice Private embedding fallback when no
  local provider is configured. The embedding catalog owns privacy eligibility;
  explicit routing, exact vector identity, cost approval, and ledger receipts
  govern activation. Existing vectors and the SourceConnector, EvidencePack,
  and Analyst interface shapes are unchanged.

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
previously frozen shapes without a runtime or data migration. `1.1.0`
(2026-09-23) adds the optional EvidencePack `coverage.matchCounts`. `2.0.0`
(2026-09-23) replaces `SourceConnector.classify` with `classificationSignals`;
see both change logs. `2.1.0` (2026-10-25) adds the optional child-item
fields (`parent`, `deferredBytes`, `fetchItem`'s locator argument,
`parentLabel`); see the change log. `2.2.0` (2026-10-25) adds connector inputs
with their own cursors (`forInput`), the intake lookup (`storedItem`) and the
per-item hold (`holdContentUntilJudged`); see the change log. `2.3.0`
(2026-10-26) adds the text a source supplies of its own reading of an item
(`providerText`); see the change log.

## Change log

- 2026-10-13 (no version change): **no Public tier on any new install.** No
  shipped sovereignty preset defines a `public_safe` route or retrieval
  policy, so every new policy runs with Public retired (Public verdicts are
  Personal, reason `tier:public_retired`). User-facing terminology is
  Personal, Private and Secrets. `SourceConnector`, `EvidencePack` and
  `Analyst` shapes are unchanged, and `public_safe` stays a valid domain:
  a policy written before 1.0 keeps its Public tier and routing.
- 2026-09-23 (v2.0.0): `SourceConnector.classify` is replaced by
  `classificationSignals`; the shared tier classifier decides and the tier
  ledger records. EvidencePack and Analyst shapes are unchanged. Full entry and
  migration note under "Compatibility and change rule" above.
- 2026-09-23 (four-tier P1b, no version change): per-tier stores. Items are
  routed by their recorded tiers into `public_safe.*`, `internal.*` and
  `secure_local.*` stores governed by one tier ledger per source, and every
  tier is searched. Two build-detail fields ride BESIDE the pack, by the
  2026-08-20 precedent: `EvidencePackBuildDetail.secretLocations` (where a
  matching Secret lives: source, an opaque ref, finding kinds, and a locator
  and scanned title only when the item's metadata is below Private; confined
  to the corpora, account and approved scope the build searched; never
  content) and `EvidencePackBuildDetail.classificationCoverage` (counts of
  searched items whose tier is not final). Neither enters the pack, so no
  model reads them, and the routing to the private analyst is unchanged in
  shape. The router gains an optional `visibilityGate` over one query's hits.
  None of these is reachable from the three contract types, so the
  fingerprint is unchanged (`bun run contracts:check`); no stored data
  migrates.
- 2026-09-23 (four-tier P1c, no version change): Dropbox, Readwise, X and
  WhatsApp move onto per-tier stores. Dropbox's text arrives after listing,
  so a new file's names are routed at listing and its content where the
  extraction factory's text puts it; Readwise and X items can be raised to
  Private or Secrets; WhatsApp stays Private unless an owner chat rule sets a
  chat Personal. The source ingestion policy no longer pins Dropbox to
  `secure_local` (its `corpusId` names the lane). None of this is reachable
  from the three contract types, so the fingerprint is unchanged; no stored
  data migrates.
- 2026-09-23 (v1.1.0): `EvidenceCoverage` gains optional `matchCounts`, per
  searched corpus: matched items, how many carry readable content, whether the
  count hit its probe ceiling, and how many are in the evidence. Source answers
  now size evidence by a byte budget (24 candidates sharing 40,000 UTF-8 passage
  bytes by default) rather than three slots, so the pack is a larger but
  still bounded selection, and the Analyst needs the breadth to describe it
  honestly. Additive and optional: producers that omit it and consumers that
  ignore it are unchanged; no stored data migrates.
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
