# Design: per-item four-tier classification for every Olympus source

Status: proposal, needs owner decisions (§8)
Date: 2026-09-23
Risk class: **Critical**. It changes source contracts, trust routing and destructive data behavior. The migration on an existing install is **Live**.
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
3. Gmail and Drive send undecided items to Personal, the unsafe side.
4. Classification reasons are not stored.
5. There are no owner tier overrides.
6. No privacy-safe model judgment is wired.
7. A Secret cannot be located.

---

## 2. Target model

**Invariant.** Every item from every source gets exactly one current tier at ingestion: Public, Personal, Private or Secrets. The decision is made per item and stored with content-free reasons. An item is searchable in **exactly one** tier at any moment.

### 2.1 Unit of judgment

- **Files, notes, documents, emails, bookmarks and highlights:** the item is the unit. An email attachment inherits the higher of its own tier and its parent message's tier.
- **Chats (Telegram, WhatsApp):** a chat-level rule sets a prior, and each message can still be raised to Private or Secrets. A message is never lowered below its chat rule unless the owner overrides that item.

### 2.2 Classification pipeline (source-agnostic, runs once per item)

```
RawItem + connector signals
  [0] extraction, in the private lane if the tier is still unknown
  [1] per-item owner override (sticky) .............................. final
  [2] secret detector (deterministic: text + title + path) .......... → Secrets
  [3] owner folder / label / sender / chat rules
  [4] source floor (provider facts, e.g. Telegram Secret Chat → Private)
  [5] sensitivity map v2 (owner's own words → categories, all four tiers)
  [6] deterministic sensitive detectors ............................. → Private
  [7] deterministic public/personal evidence (public share link, published path, …)
  [8] source prior (e.g. Readwise → Personal), if declared
  [9] model judgment, privacy-safe lane only, for anything still undecided
  [10] default: Private, reason `default:undecided`
```

**Precedence rules:**

- **Raises beat lowers.** Among steps [3]–[8], the most sensitive positive verdict wins. A lowering signal never rescues an item that a raising signal has flagged.
- **Secrets outrank everything except an explicit per-item owner override.** Even that override cannot send content straight to Personal: "not a secret" removes the detector verdict for that content hash, and the item then goes back through [3]–[10].
- **Public needs positive evidence.** That means a public share link, a published location, a public post, or an owner rule or map category. The model alone can choose only Personal or Private.
- **Folder and label rules default to `prior` strength.** The rule sets the resting tier, and item-level raises still apply, so a bank statement in a "Personal" folder still becomes Private. `force` strength is opt-in per rule.

**Model judgment [9] must be privacy-safe.** Undecided content cannot go to an ordinary cloud model to find out whether it is private. The classifier:

- runs only on the sovereignty private pool (local model, or Venice Private or above);
- is refused before any dispatch for `standard_cloud`;
- sees only items that already passed the secret detector.

Other properties:

- **Output** is strict JSON: `{tier: personal|private, category, confidence}`.
- **Failures** leave the item at the default.
- **Verdict cache.** Verdicts are cached by `(content_hash, model, prompt version, map revision)`, so an unchanged re-sync never re-asks the model. A classifier model change is an owner-approved, ledgered event.

**Undecided items** are stored in the source's Private store, so they are **searchable by keyword from the first sync**. They are held back from embedding until their tier is final, so nothing is embedded twice, and the dashboard shows them as "pending classification".

**Reasons** are stored as content-free codes in a tier ledger (§3.3), for example:

- `owner_rule:folder:/work/published`
- `secret:aws_access_key_id`
- `sensitivity_map:therapy`
- `detector:financial:iban`
- `evidence:public_link`
- `model:venice/inkling:v1:health:0.83`
- `default:undecided`

### 2.3 Secret detection and location-only handling

- **Detection** is deterministic, on full text, title and path, before any model or embedding call.
- **Storage** is a row in a local **secret-locations index** (0600). The row holds the item identity, source, locator, title (only after the title itself passes the secret scan), finding kinds, content hash and detection time. It holds **no text, chunks, FTS content or vectors**.
- **Finding a secret** works by keyword over locator, title and kind ("where is my AWS key"). Results are returned beside the evidence pack; no model ever sees them.
- **Unit:** the whole item is Secrets in beta 4.

### 2.4 Owner overrides (sticky across re-syncs)

- **Rules** live in `~/.olympus/tier-rules.json`: `{source, match: pathPrefix|folderKey|label|sender|chat, tier, strength}`. They are keyed by provider identifiers, so they survive re-syncs and rebuilds.
- **Per-item overrides** live in the tier ledger, keyed by provider item identity, so a moved file keeps its override. They are set with `olympus tier set <locator> <tier>`, and later through a review page.

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
3. Mark the source copy **superseded**, which means kept but never searched, served or counted, or purge it.

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
| Personal/Public → Private (raise) | Destination Private model (local or Venice) | **Deleted** from the Gemini-backed store at the flip, with a ledger entry | Gemini already saw the text; that cannot be undone. Delete and log it. |
| Private → Personal/Public (lower) | Gemini, in the destination store | **Retained as superseded** (hidden, not served) until the owner approves a purge | Gemini now sees text the policy has ruled Personal. This is consistent with policy. |
| Any → Secrets | none | Tombstoned; vectors deleted (today's S5 behavior) | Mandatory |
| Tier unchanged | none | kept, byte-identical | none. This is the core guarantee. |

**Mechanical guarantees, enforced in code and tests:**

1. A tier move never rebinds embedding write authority, and can never reach the whole-corpus `invalidateEmbeddingModelCurrency` path. The first embed into a new store is a first mint.
2. No new embedding model, epoch or dimension is introduced. Each store uses its existing canonical identity.
3. Pending items are embedded only after their tier is final.
4. Every raise that deletes vectors writes a scoped `invalidation` ledger entry with a chunk count.

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

**First install:** classification runs before embedding, so each chunk is embedded once, in the right model. For example, 300k chunks with 70% Personal or Public comes to about $32 (Gemini) plus about $1 (Venice), plus classifier tokens on undecided items only.

**Reclassifying Sparta** (all of Dropbox is Private and Venice-embedded today):

- Nothing needs fetching from Dropbox again.
- The deterministic pass is CPU only: minutes.
- Model judgment on the remainder takes hours: roughly 3 hours on Venice for 100k items, longer locally.
- Only **moving** chunks are embedded, in Gemini. For example, 250k moving chunks cost about $38 and take about 1–2 hours.
- Moved items' Venice vectors are **kept** (superseded). Items that stay Private cost nothing.

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
| M4 | Per batch: ledger flip. Lowered items' source copies become superseded; raised items' lower copies are deleted with a ledger entry. | approved scope |
| M5 | Soak. Rollback of any batch is a ledger flip back, with no re-embed. | owner |
| M6 | **Approval 2:** purge superseded Private copies, or keep them. | **owner** |

**Transitional rule for Gmail and Drive:** Personal items that are undecided today stay where they are until migration gives their final verdict. Flipping the default to Private first would re-embed items that may come straight back to Personal. Running M3–M6 on Sparta is a Live change under the OpenClaw change protocol.

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
- **Risk:** Critical for the repository change; Live for the Sparta migration.

---

## 7. Phased build plan

| Phase | Scope | Size (engineer-days) | Release |
|---|---|---|---|
| P0 | Owner decisions; docs; contract 2.0.0 types, fingerprint and review | 2 | beta 4 |
| P1 | Shared tier classifier (four tiers, reason codes); sensitivity map v2; tier ledger; `TieredStoreSet` with the superseded state and visibility filter; secret-locations index; all 7 public connectors emit signals; new Public and Personal stores | 10–14 | beta 4 |
| P2 | Privacy-safe model judgment with verdict cache and classification ledger; `tier-rules.json` plus the `olympus tier set/explain` CLI; embedding drain holds back pending items; Gemini vector copy between Public and Personal | 5–7 | beta 4 |
| P3 | Migration tooling M0–M6 with ledger integration; dashboard tier counts | 4–6 | beta 4 (running on Sparta is a separate Live change) |
| P4 | Owner tier-review page; split-leg answers; redacted-remainder Secrets; non-public sources | 8–12 | later |

**Test and eval plan:**

- **Unit:** the precedence matrix; Public only on positive evidence; the undecided default; the classifier refused on standard cloud; secret content never reaches the classifier.
- **Store and embedding:**
  - unchanged items keep byte-identical vectors;
  - a tier move never rebinds or invalidates;
  - Public↔Personal copies vectors with zero provider calls;
  - a raise deletes lower vectors and writes a ledger entry;
  - a lower keeps superseded vectors;
  - rollback works with no embed;
  - an item never appears in two tiers.
- **Classification eval** (new):
  - 100% secret recall on fixtures;
  - 0 hard-category Private items classified below Private;
  - ≤ 1% Private→Personal leakage on the ambiguous set.
- **Held-out eval** passes unchanged.
- **Migration rehearsal** on a synthetic secure-only Dropbox store.

---

## 8. Owner decisions needed (each with a recommendation)

1. **Source priors.** Recommendation: **yes**. Sources of published third-party reading (Readwise, X) may declare a Personal prior; every item still passes the secret detector, map, detectors and model-on-ambiguous.
2. **Default for undecided items.** Recommendation: **Private for all sources**, including Gmail and Drive (today those default to Personal). Existing items stay put until migration gives their final verdict.
3. **Model judgment.** Recommendation: **enabled**, private or local lane only. It may lower an item to Personal only at confidence ≥ 0.9, and it never assigns Public.
4. **Folder and label rule strength.** Recommendation: default `prior` (item-level raises still apply); `force` opt-in per rule.
5. **Secret false positives.** Recommendation: per-item "not a secret" clears the detector verdict for that content, and the item goes back through normal classification; it never jumps straight to a tier.
6. **Secret unit.** Recommendation: the whole item in beta 4; redacted remainders later.
7. **What Castor sees of a Secret location.** Recommendation: source plus path or title (secret-scanned) plus finding kind; no content.
8. **Raised items' cloud vectors.** Recommendation: **delete the Gemini vectors at cutover**, with a ledger entry, under standing approval.
9. **Standing approval for steady-state tier moves.** Recommendation: **yes**, capped at 5,000 chunks and $1 per day per source; above the cap, queue for approval.
10. **Lowered items' Private copies.** Recommendation: **retain until you approve a purge**, with a reminder after 30 days.
11. **Pending items.** Recommendation: keyword-only in Private until decided; embed in the Private model only if still pending after 24 hours.
12. **Retire the `public_safe.readwise.library` alias** so the canonical Public Readwise corpus can use that id. Recommendation: **yes**.
13. **Answer assembly.** Recommendation: keep "highest tier routes the whole pack" in beta 4; split legs later if needed.
14. **Sparta migration.** Recommendation: run M0 (dry run) as soon as P3 ships; M2 (cost) and M6 (purge) are separate approvals.
