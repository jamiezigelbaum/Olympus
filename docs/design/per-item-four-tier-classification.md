# Design: per-item four-tier classification for every Olympus source

Status: proposal, revised 2026-09-23 after owner review (§8). Scope: the plugin only. Work on the owner's own installations is tracked separately, outside this repository.
Date: 2026-09-23
Risk class: **Critical**. It changes source contracts, trust routing and destructive data behavior.
Authority: the owner's ruling of 2026-09-23: every item from every source is judged individually into Public, Personal, Private or Secrets. Private material is still searched; Argus (the private analyst) handles it, and Castor receives only OPSEC-scanned derivatives. No embedding change may throw away existing embeddings, and every embedding/re-embed decision needs advance owner approval plus a ledger entry.

Terms used below. The product tiers map to stored keys like this (TRUST_MODEL.md, "Product tier names"):

| Display | Schema-v1 key | Tier | Trust domain |
|---|---|---|---|
| Public | `public` | S0 | `public_safe` |
| Personal | `private` | S1–S3 | `internal` |
| Private | `secure` | S4 | `secure_local` |
| Secrets | `secrets` | S5 | refused before any model |

---

## 1. Current state (with evidence)

### 1.1 Where the tier is decided today

The contract gives each connector `SourceConnector.classify(item): SourceSensitivity` (`src/core/contracts.ts:67-74`). `SourceSensitivity` holds only `{trustTier, trustDomain, localOnly, cloudEmbeddingEligible}` (`src/core/source-index/types.ts:80-85`). It carries no reasons, so the reason for a decision is lost at the contract boundary.

| Source (v0.4 public list) | How the tier is decided | Evidence |
|---|---|---|
| Gmail | Per item, **raise-only**. Starts at S3/internal and goes up only on a positive sensitive signal. An item the engine cannot decide goes back to **S3 (Personal)**. | `gmail.ts:331-346`; `classification.ts:42-67` |
| Google Drive | The same raise-only path, starting at S3/internal. Drive exposes no folder path, so the title is used as the path. | `drive.ts:445-466` |
| Dropbox | **Fixed S4/secure_local for every file.** A secret scan can raise a file to S5. Nothing can lower it. | `dropbox-files/connector.ts:341-351` |
| Readwise | Fixed S1/internal | `readwise/connector.ts:448-450` |
| X bookmarks | Fixed S1/internal | `x-bookmarks/connector.ts:71-73` |
| Telegram | Per chat, by configuration: S3/internal or S4/secure_local. No per-message judgment. | `capture-spool-connector.ts:178-183` |
| WhatsApp | The whole store is secure_local | `whatsapp/store-sync.ts:116` |

Only Gmail and Drive classify each item, and even they only raise. No source can put an item into Public: the engine's `ItemTier` stops at `S2|S3|S4|S5` (`classification/engine.ts:30`). No `public_safe` corpus exists (`source-corpus-registry.ts:60-154`).

**The shared engine** (`engine.ts:78-153`) checks, in order:

1. S5 secret detector
2. the sensitive-sender list
3. the sensitivity map
4. S4 detectors: financial, health and identity
5. clean rules, which can lower an item to S2/S3
6. an optional scorer
7. `default_secure` (S4) as the fallback

It never calls a model. The model seam, `DelphiItemTierScorer`, only chooses between internal and secure, and it is not wired. **The sensitivity map can only raise** (`sensitivity-map.ts:269-274`).

### 1.2 How corpora map to trust domains

- **Each store holds one trust domain** (`local-index.ts:1757`). A store refuses any item classified into another domain, and demotes a stored copy that no longer belongs there (`:4381-4440`).
- **Twin stores already exist for some sources.** Drive has `internal.drive.docs` and `secure_local.drive.docs` in separate SQLite files, and one traversal feeds both (`drive-live-sync.ts:253-268`). Gmail and Telegram follow the same pattern.
- **Dropbox has only a secure store** (`source-ingestion-policy.ts:129-131`).
- **The router filters by corpus trust domain**, not by row (`router.ts:626`).
- **The EvidencePack refuses any downgrade** below the corpus-routed domain (`evidence-pack.ts:670-676`).

### 1.3 How Secrets are handled today

- An S5 item is **tombstoned**: its chunks, FTS rows and vectors are deleted, and only an identity row remains (`local-index.ts:4475-4481`, `5125-5190`).
- Model and release paths hard-deny S5 (`source-model-policy.ts:22-32`).
- **Nothing tells the owner where a secret lives.** The only trace is a `secrets_tier_excluded:<hash>` gap string.

### 1.4 How embeddings are tied to tier

**Identities** (`embedding-identity.ts:156-175`):

| Identity | Dimension | Epoch |
|---|---|---|
| Local `secure-local-qwen3-embed` | 2560 | `local:openai-compatible:secure-local-qwen3-embed:2560` |
| Gemini `gemini-embedding-2` | 3072 | `cloud:google-gemini:gemini-embedding-2:provider-reported` |
| Venice `text-embedding-qwen3-8b` | 4096 | `cloud:venice:text-embedding-qwen3-8b:4096` |

**Which model each tier uses, by preset** (`config/sovereignty/presets/*.json`):

| Preset | public_safe | internal (Personal) | secure_local (Private) |
|---|---|---|---|
| local-first | Gemini | Gemini | local Qwen3 2560 |
| local-only | Gemini | Gemini | local Qwen3 2560 |
| private-cloud-only | Gemini | Gemini | Venice Qwen3-8B 4096 |
| no-sensitive | Gemini | Gemini | none (metadata-only gap) |

**Enforcement.** A secure_local store accepts only a local or Venice embedder (`isApprovedSecureSourceEmbeddingProvider`, `embeddings.ts:35-37`).

**Where vectors live.** Vectors are stored per store in `chunk_embeddings(chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)`, one vector per chunk per model. The `content_hash` guard means unchanged text is never re-embedded.

**The whole-corpus risk.** A provider rebind runs `invalidateEmbeddingModelCurrency`, which is `DELETE FROM chunk_embeddings WHERE model_id = ?` for the **whole corpus** (`local-index.ts:6071-6074`). A tier move must never reach that path.

**Ledger.** `embedding-ledger.jsonl` is append-only. Only `approved_by: 'jamie'` counts as approval. It was created after the 2026-08-20 incident, in which about 250k vectors were wiped.

### 1.5 How answers are routed across tiers today

- If **any** candidate in the pack is `secure_local`, the whole pack goes to the private pool (Argus: local model or Venice Private). Otherwise the standard analyst handles it (`analyst-answer.ts:357-368`).
- Castor receives only the release-gated answer. This matches the doctrine that a bundle inherits the highest tier it contains.

### 1.6 Gaps against the owner's ruling

1. No source can produce Public.
2. Dropbox, WhatsApp, Readwise, X and Telegram judge nothing per item.
3. No privacy-safe check looks at items whose names suggest they might be private before they are embedded.
4. Classification reasons are not stored.
5. There are no owner tier overrides.
6. No privacy-safe model judgment is wired.
7. A Secret cannot be located.

---

## 2. Target model

**Invariant.** Every item from every source gets two current tiers at ingestion, decided per item and stored with content-free reasons:

- a **metadata tier** for its title, file or folder name, subject, sender and labels, **Personal by default**; and
- a **content tier** for its text, which is always at least the metadata tier and is raised to Private or Secrets on evidence.

Owner example (2026-09-23): a file named "biopsy results" has Personal metadata, since the fact of a biopsy is not private. Its content ("the results show cancer") is Private. Asked about health, Castor can learn "you had a biopsy" from Personal metadata, and anything about the condition comes only through Argus as a derived answer.

Each layer is searchable in **exactly one** tier at any moment. Metadata rows and content chunks may therefore live in different tier stores. This extends today's metadata-only rows, which already exist separately from content chunks.

**Per-install choice.** Setup asks whether names and titles should be Personal (the default) or Private. The Private option costs little at ingest, because private embedding of short titles is cheap (§4.4). It does mean any answer that relies on names goes through Argus. Owner rules and the sensitivity map can still raise specific folders, senders or labels to Private metadata.

### 2.1 Unit of judgment

- **Files, notes, documents, emails, bookmarks and highlights:** the item is the unit. An email attachment inherits the higher of its own tier and its parent message's tier.
- **Chats (Telegram, WhatsApp):** a chat-level rule sets a prior, and each message can still be raised to Private or Secrets. A message is never lowered below its chat rule unless the owner overrides that item.

### 2.2 Classification pipeline (source-agnostic, runs once per item)

The owner's rule (2026-09-23): **the default tier is Personal.** Things are raised to Private or Secrets on evidence. A quick private "sniffer" pass looks at anything whose names or metadata suggest it might be private, **before** full ingestion and embedding. Two passes:

**Pass 1: metadata tier** (names, folder path, sender, labels, chat; runs for every item, including metadata-only ones)

```
  [1] per-item owner override (sticky) .............................. final
  [2] secret detector on title + path ............................... → Secrets
  [3] owner folder / label / sender / chat rules
  [4] source floor (provider facts, e.g. Telegram Secret Chat → Private)
  [5] sensitivity map v2 on names/metadata (owner's own words → categories, all four tiers)
  [6] deterministic public evidence (public share link, published post, …) → Public
  [7] SNIFFER, only for items whose metadata looks possibly private (a map term,
      a sensitive-name pattern such as "medical", "tax", "bank", "therapy", a
      person's name in a family folder, …): a privacy-safe model reads the
      metadata and returns Personal or Private
  [8] default ........................................................ → Personal
```

**Pass 2: content tier** (only for items approved for full ingestion, before chunks are embedded; starts from the metadata tier and can only raise)

```
  [9]  secret detector on the full extracted text ................... → Secrets
  [10] deterministic sensitive detectors on text (financial, health, identity) → Private
  [11] sensitivity map v2 on text
  [12] SNIFFER on a short text excerpt, only when pass 1 flagged the item or [10]/[11] are borderline
```

Content can only **raise** the tier that pass 1 set, never lower it, unless the owner overrides the item. Embedding happens only after pass 2, so each chunk is embedded once, in its final tier's model.

**The sniffer.** It is a small, fast classifier call on the privacy-safe lane: a local model where the preset has one, otherwise Venice Private. It never runs on an ordinary cloud model, because you cannot send possibly-private material to one to find out whether it is private. It sees only metadata in pass 1 and only a short excerpt in pass 2, and never anything the secret detector caught. It returns strict JSON `{tier: personal|private, category, confidence}`, and its verdicts are cached by `(content or metadata hash, model, prompt version, map revision)`, so unchanged items are never re-asked. On failure it fails safe: an item it was asked about goes to Private.

**Precedence rules:**

- **Raises beat lowers.** The most sensitive positive verdict wins; a lowering signal never rescues an item a raising signal has flagged.
- **Secrets outrank everything except an explicit per-item owner override.** "Not a secret" clears the detector verdict for that content and sends the item back through normal classification; it never jumps straight to a tier.
- **Public needs positive evidence** (a public share link, a published post, an owner rule or map category). The sniffer chooses only Personal or Private.
- **Folder and label rules default to `prior` strength.** The rule sets the resting tier, and item-level raises still apply, so a bank statement in a "Personal" folder still becomes Private. `force` strength is opt-in per rule.

A classifier model change is an owner-approved, ledgered event.

**Items waiting for the sniffer** are stored in the source's Private store, so they are **searchable by keyword from the first sync**. They are held back from embedding until their tier is final, and the dashboard shows them as "pending classification".

**Reasons** are stored as content-free codes in a tier ledger (§3.3), for example:

- `owner_rule:folder:/work/published`
- `secret:aws_access_key_id`
- `sensitivity_map:therapy`
- `detector:financial:iban`
- `evidence:public_link`
- `sniffer:local:v1:health:0.83`
- `default:personal`

### 2.3 Secret detection and location-only handling

- **Detection** is deterministic, on full text, title and path, before any model or embedding call.
- **Storage** is a row in a local **secret-locations index** (0600). The row holds the item identity, source, locator, title (only after the title itself passes the secret scan), finding kinds, content hash and detection time. It holds **no text, chunks, FTS content or vectors**.
- **Finding a secret** works by keyword over locator, title and kind ("where is my AWS key"). Results are returned beside the evidence pack; no model ever sees them.
- **Unit:** the whole item is Secrets in beta 4.

### 2.4 Owner overrides (sticky across re-syncs)

- **Rules** live in `~/.olympus/tier-rules.json`: `{source, match: pathPrefix|folderKey|label|sender|chat, tier, strength}`. They are keyed by provider identifiers, so they survive re-syncs and rebuilds.
- **Per-item overrides** live in the tier ledger, keyed by provider item identity, so a moved file keeps its override. They are set with `olympus tier set <locator> <tier>`, and later through a review page.

### 2.5 Email scope picker (owner decision 2026-09-23)

Email gets a connect-time scope picker, the equivalent of the Dropbox folder picker. Today a Gmail connect ingests the whole history with no picker. It pulls 200 messages per pass under a 5,000-request daily budget, and the only filter is a hidden `OLYMPUS_SOURCE_INDEX_GMAIL_QUERY` setting. The picker offers:

- **Time window:** full content for the **last 2 years by default**. Older mail is indexed by metadata only, and can be upgraded later per label or sender.
- **Gmail categories and labels:** include or skip each. Promotions and Social are skipped by default.
- **Sender rules:** "always Private" and "skip" lists, seeded with suggestions from the highest-volume senders.
- **An estimate** of message count, time and embedding cost before anything runs.

Its choices become owner tier rules (§2.4) and the connector's query, so the same rule engine covers email, Telegram and WhatsApp. Owners don't need to clean their mailboxes first.

---

## 3. Storage and corpus shape

### 3.1 Options

**A. One store per source**, with a per-row tier column and a row-level filter at retrieval.

**B. Per-tier stores per source** (recommended). Generalize today's twin stores to one store each for Public, Personal and Private, plus the secret-locations index. One traversal classifies each item once and routes it to exactly one store.

| Criterion | A: one store with a tier column | B: per-tier stores |
|---|---|---|
| TRUST_MODEL "no shared vector pool across trust domains" | Violates | Conforms |
| "Do not mix local and cloud embeddings inside the same corpus epoch" | Violates | Conforms: one model per store |
| Storage profiles (secure must be `local_private`) | A cloud-placed store would hold Private rows | Each store keeps its own profile |
| Router and registry | Needs a new row filter in every adapter; one missed filter leaks | Unchanged: corpus-level filtering |
| Deletion custody | Row surgery | Per-file separation |
| Moving an item between tiers | One-row update | Move across stores (needs §3.3) |
| Existing code | New | Extends the Drive and Gmail twin fan-out |

**Recommendation: B.**

### 3.2 Shape

- Each source gets `public_safe.*`, `internal.*` and `secure_local.*` stores, created lazily when first needed. For Dropbox that means `public_safe.dropbox.files` and `internal.dropbox.files` beside the existing `secure_local.dropbox.files`, which stays unchanged.
- Secrets go to one source-neutral `secret_locations` index, which is outside the router and never embedded.
- A shared `TieredStoreSet` capability replaces the per-source twin fan-out code. It classifies once, upserts into the current tier's store, and tombstones the item in every other store in the set if present.
- **Cursor safety:** a cursor advances only after every store commits.

### 3.3 Tier ledger: one visibility switch across stores

A source-neutral **tier ledger** (local SQLite) records, per item identity:

- `current_tier`, `generation`
- `decided_by`, `reasons[]`
- engine version, map revision, model id
- `previous_tier`, `decided_at`
- `state ∈ {pending, current, moving}`

Retrieval drops any hit whose store tier does not equal the ledger's current tier for that item. A move works like this:

1. Write the destination copy while the source copy remains current.
2. Flip the ledger row. This single write makes the destination copy visible and the source copy invisible.
3. Mark the source copy **superseded**: kept, but never searched, served or counted.

This guarantees **never searchable in two tiers at once**, and makes **rollback a ledger flip, with no re-embed**.

**Exception for raises (more private):** hide first, then copy. The item is briefly unsearchable instead of briefly visible in the lower tier.

### 3.4 Deletion custody

- A provider deletion tombstones the current copy and any superseded copies.
- Superseded copies are never exported and never counted.
- Owner exclusions and dispositions still run before classification.

---

## 4. Embeddings

### 4.1 In plain terms

Each tier has its own search index and its own embedding model, and the model per tier does not change:

- **Public and Personal** use Gemini Embedding 2 in every preset.
- **Private** uses your local model or Venice, depending on the preset.
- **Secrets** are never embedded.

When an item changes tier, it gets vectors from the destination tier's model:

- **Items whose tier does not change keep their vectors untouched. There is no global re-embed.**
- A move between Public and Personal needs no new embedding. Both use the same Gemini model and epoch, so the vectors are copied.

### 4.2 Precisely

| Move | New vectors | Old vectors | Privacy note |
|---|---|---|---|
| Public ↔ Personal | **Copied** (same Gemini identity and input hash) | Source copy purged after the flip (same vector) | none |
| Personal/Public → Private (raise) | Destination Private model (local or Venice) | **Kept, hidden** (superseded: never searched or served) | Gemini already saw the text, so deleting its vectors gains little. Owner ruling: keep them. They can be purged later on request. |
| Private → Personal/Public (lower) | Gemini, in the destination store | **Retained as superseded** (hidden, not served) until the owner approves a purge | Gemini now sees text the policy has ruled Personal. This is consistent with policy. |
| Any → Secrets | none | Tombstoned; vectors deleted (today's S5 behavior) | Mandatory |
| Tier unchanged | none | kept, byte-identical | none. This is the core guarantee. |

**Mechanical guarantees, enforced in code and tests:**

1. A tier move never rebinds embedding write authority, and can never reach the whole-corpus `invalidateEmbeddingModelCurrency` path. The first embed into a new store is a first mint.
2. No new embedding model, epoch or dimension is introduced. Each store uses its existing canonical identity.
3. Pending items are embedded only after their tier is final.
4. Every tier move writes a ledger entry with a chunk count.

### 4.3 Epochs and parity

- Epochs stay per store and per model. Parity becomes per tier automatically.
- Superseded and pending chunks leave the parity denominator.
- Status gains `pending_classification_items`, `superseded_chunks` and `tier_move_in_progress` counts.
- During an approved batch, the doctor reports "migration in progress", not a failure.

### 4.4 Cost and time

These are formulas. M0 (§4.6) measures the real counts before anything is approved.

- A chunk is at most 4,000 characters, about 1,000 tokens.
- Venice Qwen3-8B costs $0.0125 per million tokens.
- Gemini Embedding 2: read the live price at approval time. The examples assume $0.15 per million, which is **unverified**.

**Metadata cost:** titles and names are short (about 10–30 tokens each). Classifying names by rule is effectively instant. Sniffing a flagged name costs one batched call per about 100 names. Embedding every name privately, if an install chooses Private metadata, runs about 100k names × 20 tokens ≈ 2M tokens ≈ $0.03 on Venice, in minutes. Metadata is never the slow or expensive part; full content is.

**First install:** classification runs before embedding, so each chunk is embedded once, in the right model. For example, 300k chunks with 70% Personal or Public comes to about $32 (Gemini) plus about $1 (Venice), plus classifier tokens on undecided items only.

**Reclassifying an existing install:** nothing is fetched from the provider again. The metadata pass is CPU-only (minutes). The sniffer runs only on flagged items. Only **moving** chunks are embedded, in the destination tier's model; items whose tier doesn't change cost nothing. The dry run (M0) reports the exact counts, tokens, cost and time before anything is approved.

### 4.5 Approval and ledger

- **Steady state:** new items, and small re-judgments caused by content edits or override changes. A standing owner approval, recorded once, covers tier-move embeds in each tier's existing model up to a cap. The proposed cap is 5,000 chunks and $1 per day per source. Anything over the cap queues as pending until approved.
- **Bulk reclassification:** migration, a map revision above the cap, or a classifier model change. Each always needs a specific advance approval and a ledger entry.

### 4.6 Migration plan for existing installs (nothing is discarded without approval)

| Step | Action | Gate |
|---|---|---|
| M0 | Dry-run classification over every store. Records proposed tiers with reasons, and reports from/to counts, chunks, tokens, cost, time and the top folder and sender patterns. Writes the ledger only. | none |
| M1 | Owner reviews the patterns, writes rules and overrides, then re-runs M0. | owner |
| M2 | **Approval 1:** the distribution plus the cost and time estimate. | **owner** |
| M3 | Batched copies into destination stores, with vectors copied or embedded. The source copy stays current. | approved scope |
| M4 | Per batch: ledger flip. The previous copy of every moved item becomes superseded (hidden, kept). | approved scope |
| M5 | Soak. Rollback of any batch is a ledger flip back, with no re-embed. | owner |
| M6 | **Approval 2 (optional):** purge superseded copies, or keep them. | **owner** |

This tooling ships in the plugin for every existing install. Running it on any live installation is a separate, owner-approved operation.

---

## 5. Search and answers across tiers

- **One query searches every tier of every source.** Private items are always searched: by keyword immediately, and semantically once embedded. Empty stores are skipped cheaply.
- **Secrets** are searched in the secret-locations index by keyword and returned beside the pack. No model ever sees them.
- **Routing in beta 4 is unchanged in shape.** A pack containing any Private evidence goes to Argus, then the release gate (OPSEC scan), and Castor gets the bounded derivative answer. A pack without Private evidence goes to the standard analyst. What changes is that items judged Personal, for example most of Dropbox, now reach the standard route and Gemini semantic search.
- **Later:** split legs. Argus answers the Private sub-pack, and the standard analyst composes its released derivatives with the Personal and Public evidence. This is worth doing only if quality or latency needs it.
- **Coverage notes** ride beside the pack. For example: "searched Public/Personal/Private in Dropbox; 1,240 items pending classification searched by keyword only; 3 Secrets matched (location only)".

---

## 6. Contracts and risk

- **SourceConnector → 2.0.0 (breaking).** `classify(item)` is replaced by `classificationSignals(item)`, which returns source facts only: floor, prior, sharing state, title, path, folder keys, sender, recipients, labels and conversation kind. The tier decision moves wholly into the shared, source-agnostic classifier. The architecture rule "only SourceConnector is per-source" is kept.
- **EvidencePack:** no shape change. Secret locations and classification coverage ride the build detail (the 2026-08-20 precedent).
- **Analyst:** no change.
- **Gate artifacts:**
  - a version entry;
  - a new fingerprint;
  - a migration note (§4.6);
  - held-out eval plus the new classification eval;
  - a critical-review receipt.
- **Also changing:**
  - sensitivity map schemaVersion 2, where categories may target all four tiers (v1 maps still load);
  - INSTALL_FOR_AGENTS.md ("raise-only");
  - TRUST_MODEL.md (the Dropbox-as-S4-vault default, the tier ledger, Secret locations);
  - SOVEREIGNTY_CONFIG.md (classifier lane per preset);
  - corpus registry declarations.
- **Risk:** Critical.

---

## 7. Phased build plan

| Phase | Scope | Size (engineer-days) | Release |
|---|---|---|---|
| P0 | Owner decisions; docs; contract 2.0.0 types, fingerprint and review | 2 | beta 4 |
| P1 | Shared tier classifier (four tiers, reason codes); sensitivity map v2; tier ledger; `TieredStoreSet` with the superseded state and visibility filter; secret-locations index; all 7 public connectors emit signals; new Public and Personal stores | 10–14 | beta 4 |
| P2 | Privacy-safe sniffer (metadata pass + excerpt pass) with verdict cache and classification ledger; `tier-rules.json` plus the `olympus tier set/explain` CLI; embedding drain holds back pending items; Gemini vector copy between Public and Personal | 5–7 | beta 4 |
| P3 | Migration tooling M0–M6 with ledger integration; dashboard tier counts | 4–6 | beta 4 |
| P4 | Owner tier-review page; split-leg answers; redacted-remainder Secrets; non-public sources | 8–12 | later |

**Test and eval plan:**

- **Unit:** the precedence matrix; Public only on positive evidence; the Personal default; content can only raise; the sniffer refused on standard cloud; secret content never reaches the sniffer.
- **Store and embedding:**
  - unchanged items keep byte-identical vectors;
  - a tier move never rebinds or invalidates;
  - Public↔Personal copies vectors with zero provider calls;
  - every move keeps the previous copy's vectors, hidden;
  - rollback works with no embed;
  - an item never appears in two tiers.
- **Classification eval** (new):
  - 100% secret recall on fixtures;
  - 0 hard-category Private items classified below Private;
  - ≤ 1% Private→Personal leakage on the ambiguous set.
- **Held-out eval** passes unchanged.
- **Migration rehearsal** on a synthetic single-tier store.

---

## 8. Owner decisions (revised after owner review, 2026-09-23)

Decided by the owner:

- **Metadata tier defaults to Personal; content tier is judged separately and can be Private.** Names and titles are Personal unless something raises them. Setup offers "Private names" as an option for people who want it.
- **Email scope picker** with a 2-year full-content default; older mail is indexed by metadata only.
- **Sniffer:** a quick private/local model pass on anything whose names or metadata look possibly private, before full ingestion and embedding.
- **Keep cloud vectors** when an item moves up to Private: hidden, not deleted.
- **One query searches all tiers**, with Argus handling Private evidence.

Remaining, each with a recommendation:

1. **Sniffer lane:** local model where the preset has one, otherwise Venice Private; never an ordinary cloud model. **Yes.**
2. **Content can only raise** the tier set from metadata; only an owner override lowers. **Yes.**
3. **Sniffer on content:** read a short excerpt only when metadata flagged the item or the content detectors are borderline. **Yes.**
4. **Folder and label rules** set a default that item-level raises can still override; hard overrides are opt-in per rule. **Yes.**
5. **"Not a secret"** sends the item back through normal classification. **Yes.**
6. **A file containing a secret** is a Secret as a whole, for now. **Yes.**
7. **What Castor sees of a secret:** source, path or title and finding kind; never content. **Yes.**
8. **Standing approval for everyday tier moves:** up to 5,000 chunks and $1 per day per source; more waits for approval. **Yes.**
9. **Superseded copies** are kept until the owner approves a purge. **Yes.**
10. **Retire the `public_safe.readwise.library` alias** so the Public Readwise store can use that id. **Yes.**
11. **In beta 4, any Private evidence** routes the whole answer through Argus; split handling later if needed. **Yes.**
