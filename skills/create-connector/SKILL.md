---
name: create-connector
version: 0.1.0
status: draft
audience: repo-development
description: Add a new source connector to Olympus (Box, Notion, Linear, ...) without violating the frozen contracts. Walks an implementer through contract implementation, corpus definition, store mount, scheduler tasks, request budget, tests, and host enablement, using the shapes the repo has already stamped for Readwise, X, Drive, Dropbox, Reflect, and Roam.
triggers:
  - a new source/provider must be ingested into Olympus
  - someone is about to write a new local index or a per-source answer path
  - a connector exists but has no store, scheduler task, budget, or host enablement
tools: []
mutating: true
---

# Create a Source Connector

> **DRAFT — pending CTO review.** This distills what the repo does today; it is
> not yet ratified policy. Where the repo is ambiguous, this file says so in
> [Open questions](#open-questions-for-the-cto) instead of inventing a rule.
> If you hit an ambiguity that is not listed, stop and ask — do not decide it
> in-thread.
>
> **CTO note (2026-08-09):** drafted 2026-07-27, before parser tranches
> T2–T7 merged. Known drift: the generic JSON mount now also carries
> per-corpus principal identity (`principalProvider` +
> `principalAccountScope`, all-or-nothing — T3/K1), and a declaration
> whose corpusId a server lane also constructs contributes ONLY its
> principal rather than displacing the lane-built (exclusion-carrying)
> store handle; a declaration that disagrees with the lane's identity is
> skipped whole (T7). Re-verify any mount claim below against
> `src/workers/email-source/server.ts` before relying on it.

## Who this is for

An engineer or AI working **inside an Olympus checkout**, adding a new source.
This is a repo-development skill, not an OpenClaw runtime skill; it is
deliberately not registered in `skills/manifest.json` or `openclaw.plugin.json`
(see open question 1).

## Read first, in this order

1. [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) — the frozen contracts and the
   freeze rule.
2. [`src/core/contracts.ts`](../../src/core/contracts.ts) — the three interfaces.
   139 lines. Read all of them.
3. [`AGENTS.md`](../../AGENTS.md), "Architecture (frozen)".
4. [`test/architecture-guard.test.ts`](../../test/architecture-guard.test.ts) —
   the mechanical half. It is not advisory.

## The one rule

`SourceConnector` is the **only** per-source code. Everything downstream —
extract, chunk, index, retrieve, reason, release — is written once and shared.
A new source is a thin adapter (~300 lines) plus wiring, not a subsystem.

Two mechanical consequences you cannot talk your way past:

- **Do not create `src/workers/<source>/local-index.ts`.** The guard asserts
  *exact set equality* against `ALLOWED_LOCAL_INDEX_PATHS`
  (`test/architecture-guard.test.ts`). Seven paths are grandfathered; an eighth
  fails the build. Your store is `LocalConnectorStore`
  (`src/workers/connector-store/`), which every source shares.
- **Do not name your source in the shared answer spine.** The guard forbids
  concrete source tokens in `src/core/analyst.ts`,
  `src/core/evidence-pack.ts`, `src/core/query-planner.ts`,
  `src/core/source-model-policy.ts`, `src/core/source-index/{retrieval,router,selected-item-safety}.ts`,
  and `src/workers/source-index/{analyst-answer,answer-types}.ts`. Your source
  lives in `src/workers/<source>/` plus the server/scheduler wiring seams, and
  nowhere else.

If your design needs either of those, the design is wrong. Stop and ask.

## Reference stampings

Read the closest one to your source before you write anything:

| Source | Files | Why read it |
| --- | --- | --- |
| Readwise | `src/workers/readwise/{connector,live-control,live-sync,corpus-adapter}.ts` | The most complete chain: connector → dark store → bounded resumable pulls → budget parking → host enablement. This skill's spine. |
| Google Drive | `src/workers/google-connectors/{drive,drive-live-control,drive-live-sync,request-budget}.ts` | The same chain done second, class-shaped, with a watermark cursor and a reusable budget module. |
| X bookmarks | `src/workers/x-bookmarks/{api-connector,connector}.ts` | Provider I/O split from normalization; the scheduler two-task reference. |
| Reflect / Roam | `src/workers/reflect/connector.ts`, `src/workers/roam/connector.ts` | The minimum viable connector: archive import, no broker, no budget, no scheduler. Start here if your source is a file export. |
| Dropbox | `src/workers/dropbox-files/connector.ts` | `file`-family identity and content caps. |

---

## Leg 0 — Decide five identifiers before writing code

Write these down and put them in the work-order summary. Changing them later
means a store migration.

| Identifier | Convention | Examples |
| --- | --- | --- |
| source id | `<provider>.<collection>` | `readwise.library`, `x.bookmarks`, `google_drive.docs` |
| corpus id | `<trust_domain>.<family>.<collection>` | `internal.readwise.library`, `secure_local.dropbox.files`, `internal.drive.docs` |
| provider | lowercase provider token | `readwise`, `google_drive`, `dropbox`, `x` |
| family | a member of `SOURCE_FAMILIES` in `src/core/source-index/types.ts`, or an `x-` extension id | `file`, `note`, `chat`, `readwise` |
| credential handle | `<provider>.<account_role>` in current code; `docs/SOURCE_FAMILIES.md` documents `<provider>.<collection>.<account_role>` | `readwise.personal`, `google_drive.personal`, `x.bookmarks.personal` |

`SOURCE_FAMILIES` is currently
`['email','file','chat','calendar','note','task','readwise','x']`. Adding a
member is a contract-adjacent edit to `src/core/source-index/types.ts`; prefer
an existing structural family (a Box connector is `file`) or the `x-<name>`
extension form. See open question 3 before minting a new one.

Also decide, and state the reasoning:

- **Trust domain and tier** — the floor your `classify()` returns. `internal`
  and `secure_local` never share a store.
- **Identity tuple** — the store's uniqueness key is
  `(provider, account_scope, normalized_conversation, provider_item_id)`
  (`LocalConnectorStore.upsertItem`). Decide what your
  `providerConversationId` groups. Readwise chose document scope
  (`document:<id>`) so a book's highlights cluster; X bookmarks leave it unset.
- **Absence semantics** — can you prove that an item missing from a full
  traversal was deleted? If not, say so now; the default is
  `partial_window` and no tombstones.

---

## Leg 1 — Implement Contract 1

Create `src/workers/<source>/connector.ts` from
[`templates/connector.ts.template`](templates/connector.ts.template).

### Checklist

- [ ] `readonly id` — a stable connector id (`readwise_live`,
      `x_bookmarks_live`, `reflect`). It is not the source id.
- [ ] `readonly family` — from Leg 0.
- [ ] `authenticate()` — obtain a session from the credential broker; never
      read a raw secret yourself.
      ```ts
      const session = requireBearerTokenCredentialSession(await broker.issueSession({
        handle: credentialHandle,
        provider: '<provider>',
        capability: '<provider>.sync',
        trustDomain: 'internal',
        purpose: '...',
      }), credentialHandle);
      ```
      Wrap the fetch you hand the API client so **every** provider request goes
      through `requestBudget.reserve()` first (see Leg 5). Make
      `authenticate()` idempotent — `listItems` calls it.
- [ ] `listItems(options)` — an `AsyncIterable<SourceConnectorListPage>`.
  - [ ] Honors `options.cursor` (resume) and `options.limit` (hard bound).
  - [ ] Emits an **opaque, validated** `nextCursor` (Leg 1 cursor rules below).
  - [ ] `done: true` **only** when the provider has no further page **and**
        the per-run bound did not truncate the page. Drive shipped this wrong
        once: every bounded slice reported `done`, which told the spine a
        partial window was a full traversal. The comment is still in
        `src/workers/google-connectors/drive.ts`.
  - [ ] Guards against a provider that returns the same page token twice
        (`assertNewProviderPage` in both Readwise and Drive) — otherwise a
        provider bug becomes an infinite loop spending the day's budget.
  - [ ] Dedupes within a page on the identity key.
- [ ] `fetchItem(localItemId)` — an **in-run cache lookup**, not a second
      provider round trip. Both Readwise and Drive resolve from a map populated
      during `listItems`. Drive's comment records why: re-deciding the content
      cap in `fetchItem` is what made the cap decorative.
- [ ] `classify(item)` — the single place trust policy may be source-aware
      (`src/core/contracts.ts`, Contract 1 comment). Return
      `buildSourceSensitivity({ trustTier, trustDomain })`. Nothing downstream
      may classify below what you return here.

### RawItem shape

```ts
{ identity, mimeType, content, metadata, fetchedAt }
```

- `content` is `{kind:'text'}`, `{kind:'bytes'}`, or `{kind:'metadata_only'}`.
  Emit `metadata_only` when there is no text — never a fabricated empty string.
- `metadata` should be `Object.freeze`d (Readwise, X, Reflect all do).
- `identity.sourceVersion` is your change signal; set it to the provider's
  updated-at when one exists.

The shared store reads these metadata keys and ignores the rest
(`src/workers/connector-store/local-index.ts`):

| Purpose | Keys, in precedence order |
| --- | --- |
| title | `name`, `title` (`chat` family also falls back to `chat`) |
| locator | `locatorUri`, `pathDisplay`, `url` |
| authored time | `authoredAt`, `sentAt`, `clientModifiedAt` |
| updated time | `updatedAt`, `serverModifiedAt` |
| change detection | `contentHash` (falls back to a hash of text content) |
| sender | `senderId`/`sender_id`, `senderLabel`/`senderDisplayName`/`sender`/`from`, `senderIsOwner`/`fromMe` |
| search text | `searchText` (explicit), else composed from title + `chat`/`sender`/`from` + `identityAliases` + `aliases` |
| deletion | `deleted: true` |
| reactions | `reactions` (validated; omitting the key preserves stored reactions, an empty array clears them) |

### Cursor hygiene

Cursors cross day boundaries, process restarts, and store generations, so they
must be provable before they are spent on provider I/O.

- Prefix + `base64url(JSON)`: `rw1:` (Readwise), `gdrv1:` (Drive).
- Length-capped on decode (`MAX_CURSOR_LENGTH`, 4096 in Readwise).
- Field-validated on decode; anything unexpected throws
  `TypeError('... cursor is invalid.')`.
- Export a cheap predicate — `isReadwiseConnectorCursor` /
  `isGoogleDriveConnectorCursor` — so the sync handler can test a checkpoint
  without a provider call.
- A cursor the decoder **or the provider** rejects must fall back to a fresh
  traversal with a counts-only warning. It must never park the lane.
- The cursor is scheduler-private. It never appears in a receipt, warning, or
  log line (`policy.provider_cursor_exposed: false`).

### Caps with typed refusals

Two distinct behaviors, both present in the repo — pick the right one:

- **Configuration** (env, constructor options): validate and **throw** a
  `TypeError` naming the setting.
  `boundedPageSize`, `readwiseDailyRequestBudgetFromEnv`,
  `requireAccount`, `positiveIntegerEnv` all do this. A misconfigured host
  should fail loudly at construction, not silently run a wrong bound.
- **A request-supplied bound**: clamp down to the policy ceiling.
  `boundedMaxItems` is `Math.min(value, config.storePullMaxItems)` — a caller
  may ask for less than policy, never more.

---

## Leg 2 — Define the corpus

- [ ] Add a row to `SOURCE_CORPUS_REGISTRY` in
      `src/core/source-corpus-registry.ts`: `corpusId`, `sourceId`, `provider`,
      `family`, `trustDomain`, `activationMode`, `capabilities`, `description`.
- [ ] Add a posture row to `OLYMPUS_SOURCE_FAMILY_POSTURES` in
      `src/core/source-family.ts` (status, ingest mode, custodian, packet
      kinds, credential kinds, Castor evidence forms, write posture). This is
      the executable posture registry `docs/SOURCE_FAMILIES.md` points at.
- [ ] Choose the corpus definition helper:
  - `defineConnectorCorpus({corpusId, family, trustDomain, activationMode})`
    from `src/workers/connector-store/` — the generic path, defaults to
    `lexical_only`.
  - A per-source wrapper over `defineSourceIndexCorpus` when you need a storage
    profile or a default sensitivity the generic helper does not express. See
    `src/workers/readwise/corpus-adapter.ts`, which sets
    `storageProfileInput: {cloudEmbeddingApproved: true, cloudQueryApproved: false}`
    and a `defaultSensitivity`. (Open question 5: when is the wrapper required?)
- [ ] Activation mode: `lexical_only` until you have a reason. Readwise and
      Drive-docs are `lexical_only`; X bookmarks is `hybrid_shadow`; Telegram
      is `hybrid_primary`.

---

## Leg 3 — Mount the store

One database per corpus. Trust domains are **never** mixed in one store — an
item your `classify()` puts in a different trust domain is rejected and recorded
as a coverage gap, fail-closed.

```ts
export function create<Source>ConnectorStore(dbPath = default<Source>ConnectorStoreDbPath()) {
  return new LocalConnectorStore({ dbPath, corpusId, family, trustDomain });
}
```

Default path idiom (`XDG_DATA_HOME` or `~/.local/share`):
`.../openclaw/olympus/<source>-connector-store.sqlite`, overridable by
`OLYMPUS_SOURCE_INDEX_<SOURCE>_CONNECTOR_STORE_DB_PATH`.

Two mount idioms exist. Choose:

- **Generic JSON mount** — `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON`, parsed
  in `src/workers/email-source/server.ts` (`parseConnectorStoreMountsFromEnv`),
  host drop-in `66-connector-stores.conf`. Entries carry
  `dbPath`/`corpusId`/`family`/`trustDomain`, plus optionally the
  all-or-nothing principal pair `principalProvider`/`principalAccountScope`
  (T3/K1 — required for any capability keyed on `(family, provider)`).
  Used by Reflect, Roam, WhatsApp, Telegram, and (principal-only, per the
  T7 collision rule) Dropbox.
- **Dedicated runtime factory** — `create<Source>ConnectorStoreRuntime` in
  `src/workers/email-source/server.ts` (see
  `createReadwiseConnectorStoreRuntime`), gated by its own
  `OLYMPUS_SOURCE_INDEX_<SOURCE>_CONNECTOR_STORE_ENABLED` and by the credential
  handle's provider/capability/reauth state. Required when the lane needs a
  request budget, a sync handler, and scheduler tasks. Readwise's store is
  never constructed from the JSON mount.

Two ordering rules the tests pin:

- **Construct the request budget before the store.** An invalid budget env must
  throw *without* creating the sqlite file. `test/readwise-connector.test.ts`
  asserts `existsSync(dbPath) === false` in both the disabled and the
  invalid-env cases.
- **Mounting is not serving.** For a source that shadows a live legacy index,
  read authority stays with the legacy lane until an explicit flip; see
  `readwiseReadAuthorityLane` in `src/workers/email-source/server.ts`. When you
  register the embedding lane for a shadow store, pass `servesReads: false` to
  `registerConnectorStoreEmbeddingLane` so status does not report an empty
  store's embedding state for a corpus the answer path still serves from the
  legacy index.

The generic runner is `syncAndEmbedFromConnector({store, connector, embeddingProvider, sync})`.
Do not write your own ingest loop.

---

## Leg 4 — Scheduler tasks

Create `src/workers/<source>/live-control.ts` (cadence and bounds) and
`live-sync.ts` (the handler), then register a scheduler source in
`src/workers/source-scheduler.ts`. Templates:
[`live-control.ts.template`](templates/live-control.ts.template),
[`live-sync.ts.template`](templates/live-sync.ts.template).

**Two tasks, always.** `reconcileFullSnapshot` only acts when
`cursor === undefined && maxItems === undefined && sawDonePage` — a cursored
bounded slice and a reconcile are mutually exclusive in one run. So:

| Task | Cursor | Bound | Default cadence | Snapshot |
| --- | --- | --- | --- | --- |
| `<source>.<collection>_store_pull` | threaded | `maxItems` | 15 min | no |
| `<source>.<collection>_store_reconcile` | none | none | 24 h | `reconcileFullSnapshot: true` + scope + absence authority |

Checklist:

- [ ] `create<Source>SchedulerSource(input)` returns
      `SourceSchedulerSource | undefined` and **fails closed per lane**: no
      store handler means no store tasks, and one lane may never stand in for
      another (`createReadwiseSchedulerSource`).
- [ ] Both tasks are `kind: 'sync'`, `writer: true`, with their own `intervalMs`
      and `freshnessThresholdMs` from the live config.
- [ ] The pull task threads `context.checkpoint` in and returns the run's cursor
      as `checkpoint`. `null` clears it after a completed traversal; a string
      carries the resume point. Always supply the field.
- [ ] Resume candidate precedence, from the Readwise handler: the store's own
      `store.status().lastSyncRun?.cursor` first (written after every run,
      including one the budget cut short), then the scheduler checkpoint (which
      covers the case where the last run was an uncursored reconcile).
- [ ] The reconcile passes `reconcileFullSnapshotScope: {provider, accountScope}`
      and `reconcileAbsenceAuthority`. Default `'partial_window'` and no
      tombstones until deletion semantics are proven.
- [ ] Share the source-default concurrency key when one provider token means
      serialized access is correct. Use distinct `concurrencyKey`s only when the
      lanes genuinely may run together (X bookmarks does).
- [ ] Receipts are counts-only, with a stable `kind` tag, a `policy` block, and
      a `receipt_sha256` self-digest computed over every field except the digest
      (`readwiseReceiptDigest`). Signals the scheduler would otherwise collapse
      (resumed, rejected-cursor, traversal-complete) are carried as **counts**,
      not free-text warnings.

Registering the source is not the same as scheduling it. The host selects live
lanes through `WORKER_SCHEDULER_SOURCE_IDS` in `config/private-host.env`, which
is manifest-pinned; Drive's store tasks landed deliberately unscheduled for
exactly this reason. Expect your new source to land unscheduled (open question 8).

---

## Leg 5 — Request budget

The failure this prevents: a first `429` turns into an `errorBackoffMs`
fail-loop that spends the lane's whole day retrying.

Copy `src/workers/google-connectors/request-budget.ts` — it is the
provider-parameterized version of the Readwise guard, and its header comment
records the lift. Rules:

- [ ] **Exactly one instance per runtime**, and it is a **required** option at
      every seam (connector *and* sync handler). Optional-with-fallback is the
      defect Readwise T3 removed: two silent day counters in one process.
- [ ] **Day-durable across restart.** JSON state file: versioned, atomic write
      (temp + `rename`), `0700` dir / `0600` file, malformed content **refused**
      with a `TypeError` rather than treated as a fresh day.
- [ ] **Not inside the connector-store sqlite.** That file participates in
      qualification fingerprints; a budget write would invalidate a receipt for
      a reason unrelated to the corpus.
- [ ] Count first, then persist. A failed write is a loud host problem, and the
      in-memory counter it leaves behind is the conservative one.
- [ ] `reserve()` on **every** provider request, inside the guarded fetch.
- [ ] Path is env-overridable
      (`OLYMPUS_SOURCE_INDEX_<SOURCE>_DAILY_API_REQUEST_BUDGET_STATE_PATH`);
      the limit too
      (`OLYMPUS_SOURCE_INDEX_<SOURCE>_DAILY_API_REQUEST_BUDGET`).

### The typed refusal

Exhaustion is a **planned park**, not a failure to retry. Bridge it:

```ts
function <source>SchedulerFailure(error: unknown): SourceSchedulerTaskFailure | unknown {
  if (!(error instanceof <Source>RequestBudgetError)) return error;
  return new SourceSchedulerTaskFailure(error.message, {
    errorKind: <SOURCE>_DAILY_REQUEST_GUARD_REASON,
    retryAt: { at: error.retryAt, degradedReason: <SOURCE>_DAILY_REQUEST_GUARD_REASON },
  });
}
```

- `retryAt.at` = the next UTC day boundary. Maximum future deferral is 48 h.
- `degradedReason` must match `/^[a-z0-9][a-z0-9._:-]{0,127}$/`. The idiom is
  `<provider>_daily_api_request_guard` (`readwise_daily_api_request_guard`,
  `google_drive_daily_api_request_guard`).
- A plain `Error` here is classified `task_failed` and fail-loops at the error
  backoff all day. That is the bug; do not reintroduce it.

---

## Leg 6 — Tests

Mirror `test/readwise-connector.test.ts` and `test/readwise-store-scheduler.test.ts`.
Skeleton: [`connector.test.ts.template`](templates/connector.test.ts.template).

Fixtures: `StaticCredentialBroker`
(`src/workers/credential-broker/`) and `DeterministicSourceEmbeddingProvider`
(`src/workers/source-index/embeddings.ts`). A fake `fetch` that records URLs and
`Authorization` headers. A fixed clock (`now: () => NOW`). Put a distinctive
string such as `PRIVATE_<SOURCE>_MARKER` in every fixture body — it is how the
membrane assertions work.

Required cases:

| # | Case | Asserts |
| --- | --- | --- |
| 1 | Pagination + identity | exact provider URL sequence, `Authorization` on every call, last page `done: true`, full identity tuple, `classify()` result, `fetchItem` returns the listed item, budget status |
| 2 | Budget refusal | throws the typed error, `calls` stopped at the budget, and the env parser rejects a non-integer with the exact message |
| 3 | Store sync idempotence | first run indexes N items/chunks; second run re-sees them and embeds **0**; store counts stable; `expect(JSON.stringify([first, second])).not.toContain('PRIVATE_<SOURCE>_MARKER')` |
| 4 | Runtime factory gating | `enabled: false` → `undefined` **and no db file**; invalid budget env → throws **and no db file**; enabled → store with the right `corpusId`/`family`/`trustDomain` |
| 5 | Read authority (shadow lanes only) | the corpus adapter map still resolves to the legacy adapter while authority is `legacy_index` |
| 6 | Cursor resume round trip | bounded slice → checkpoint persisted → next slice resumes → completed traversal clears the checkpoint |
| 7 | Rejected resume | falls back to a fresh traversal, emits the counts-only warning token, does not throw |
| 8 | Budget parks the lane | scheduler-visible `retryAt` at the next UTC day, no fail-loop |
| 9 | Counter survives restart | a second budget instance over the same state path continues the same day's count |
| 10 | Reconcile is snapshot-only when unbounded | full snapshot runs only with no cursor and no `maxItems` |
| 11 | Receipt shape | stable `kind`, `policy` block, `receipt_sha256` recomputable from the receipt alone |
| 12 | Scheduler registration | both task ids present, in order; fails closed without the store handler |
| 13 | Installer | copy `test/private-host-readwise-connector-store-installer.test.ts` |

Run `bun run verify` (typecheck + `bun test` + `dist:check`). If you touched
`src/`, rebuild dist and commit it — `dist:check` fails on a stale bundle.

---

## Leg 7 — Host enablement

The idiom is a **dedicated numbered systemd drop-in**, not the connector-stores
JSON mount, whenever the lane has its own enable, budget, and cadence.

1. **Writer script** — `scripts/ops/install-private-host-<source>-connector-store.sh`,
   modelled on `install-private-host-readwise-connector-store.sh`. It writes
   `${EMAIL_SOURCE_DROPIN_DIR}/<NN>-<source>-connector-store.conf` and:
   - refuses a non-Linux host and a missing `systemctl`;
   - refuses an enable that is not exactly `true`/`false`;
   - refuses a non-positive-integer cadence/bound and a relative state path;
   - refuses `--remove` while the enable is still `true`;
   - compares before writing and does nothing when the content matches;
   - runs `systemctl --user daemon-reload` and **never** `start` or `restart`;
   - never writes read authority, the legacy index enable, or
     `WORKER_SCHEDULER_SOURCE_IDS`.
2. **Pick a free number.** Grep first — as of this draft, taken:
   `00, 40, 41, 42, 61, 62, 63, 64, 65, 66, 67, 72, 73, 74, 75, 76, 77, 78, 80, 99`
   (77 = Readwise, 78 = Drive; 79 is the next connector-store slot).
3. **Manifest keys** — add each `<SOURCE>_*` key to
   `PRIVATE_HOST_MANIFEST_KEYS` in `scripts/ops/lib/private-host-manifest.sh`,
   **and** add it to the right per-key validator branch (positive-integer group
   for cadences and budgets, absolute-path group for the state path, an
   explicit `true|false` branch for the enable).
4. **Managed state** — a row in `config/private-host-managed-state.tsv`:
   `assert	dropin	${EMAIL_SOURCE_DROPIN_DIR}/<NN>-<source>-connector-store.conf	scripts/ops/install-private-host-<source>-connector-store.sh`
5. **Refresh sequence** — call the installer in
   `scripts/ops/private-host-olympus-runtime-refresh.sh`, next to the Readwise and
   Drive calls.
6. **Re-pin the manifest digest** — `test/private-host-olympus-runtime-refresh.test.ts`
   sha256-pins the whole manifest. Re-pin it **deliberately**, with the reason
   in the commit message and in the comment above the pin. A digest that
   changes without a stated reason is indistinguishable from a silent edit.
7. **Installer test** — copy
   `test/private-host-readwise-connector-store-installer.test.ts`: shellcheck-clean
   when shellcheck exists, exact `Environment=` lines, absence of the forbidden
   keys, idempotence with no systemd write, refusal paths.

Also update **doctor**: add your lane to `src/core/doctor.ts`. A family running
both a legacy index and a connector store reports the store through
`additionalEnvFlags: [{ envFlag: '..._CONNECTOR_STORE_ENABLED', defaultOffWhenAbsent: true }]`
(the Gmail/Drive/Readwise precedent). `test/doctor.test.ts` pins the lane list.

---

## Membrane rules (apply to every leg)

Two tiers, and code must never mix them.

- **Content tier** — chunk text and locators. Reaches the analyst **only**
  through the local content provider lane (`src/core/evidence-pack.ts`,
  `createConnectorStoreContentProvider`). The routed search membrane returns
  identity + provenance + a citation title only: no chunk text, no snippet, no
  locator uri (`src/workers/connector-store/local-index.ts` header).
- **Counts-only tier** — everything a sync surface, receipt, warning, log line,
  scheduler status, or admin route emits. Counts and safe tokens. The Readwise
  result and receipt carry an explicit `policy` block asserting it:
  `counts_only: true`, `raw_source_exposed: false`,
  `source_text_returned: false`, `provider_cursor_exposed: false`.

Practical consequences:

- Warnings are fixed token constants (`readwise_store_resume_cursor_rejected`),
  never interpolated provider strings.
- Errors that cross a boundary are digested or reduced to a kind, not
  forwarded. Drive hashes the unknown local item id in its `fetchItem` error.
- `secure_local` stores never run a vector lane with a non-local embedding
  provider — fail closed to keyword.

---

## Definition of done

- `bun run verify` green (typecheck + tests + `dist:check`), dist committed if
  `src/` changed.
- `test/architecture-guard.test.ts` untouched and green. No new
  `local-index.ts`. No source token in the shared spine.
- The connector is thin: provider I/O and normalization only.
- Receipts are counts-only and self-digested; the cursor never leaves the
  scheduler.
- The budget is single-instance, day-durable, and parks the lane instead of
  fail-looping.
- Host enablement is scripted, validated, manifest-pinned, and tested — and the
  digest re-pin has a stated reason.
- State the identity-mapping choice and the absence-authority choice in the
  summary. They are the two decisions a reviewer cannot recover from the diff.

---

## Open questions for the CTO

These are places the repo does not currently give one answer. This draft
describes both options rather than picking.

1. **Skill registration.** `create-connector` is a repo-development skill, not
   an OpenClaw runtime skill, so it is deliberately absent from
   `skills/manifest.json`, `skills/RESOLVER.md`, and `openclaw.plugin.json`.
   No test enforces either way. Confirm — or say where build-time skills should
   live instead (a `docs/` playbook? a separate tree?).
2. **Budget duplication.** The day-counter now exists twice:
   `ReadwiseDailyRequestBudget` in `src/workers/readwise/connector.ts` and the
   provider-parameterized `GoogleDailyRequestBudget` in
   `src/workers/google-connectors/request-budget.ts`. The Drive header records
   the lift as deliberate. Should a third source copy it again, or is this the
   moment to extract one shared module (and, if so, does Readwise migrate)?
3. **Family taxonomy.** `SOURCE_FAMILIES` mixes structural kinds (`email`,
   `file`, `chat`, `note`) with provider names (`readwise`, `x`). A Box
   connector could be `file`, a new `box`, or the extension form `x-box`. What
   is the rule?
4. **Credential handle shape.** `docs/SOURCE_FAMILIES.md` documents
   `<provider>.<collection>.<account_role>` and gives `x.bookmarks.personal`;
   the Readwise and Drive connectors default to `readwise.personal` and
   `google_drive.personal`. Which is canonical for a new source?
5. **Corpus adapter.** When is a per-source `defineSourceIndexCorpus` wrapper
   (Readwise's `corpus-adapter.ts`) required over the generic
   `defineConnectorCorpus`? Today the difference is that only the wrapper can
   set a storage profile and a default sensitivity — is that the rule, or is
   the wrapper legacy?
6. **Store mount.** The Readwise T3 work order states that store is never built
   from `SOURCE_INDEX_CONNECTOR_STORES_JSON`, but no general rule is written
   down. Proposed rule for this skill: *a lane with a request budget, a sync
   handler, or scheduler tasks needs a dedicated runtime factory; a passive
   archive-import store may use the JSON mount.* Confirm or replace.
7. **Read authority for greenfield sources.** `readwiseReadAuthorityLane` and
   the legacy/store flip exist because Readwise has a live legacy index. A
   greenfield source (Box) has nothing to shadow. May it serve reads as soon as
   it is mounted and embedded, or does every new source land dark behind an
   explicit flip?
8. **Scheduling by default.** `WORKER_SCHEDULER_SOURCE_IDS` is manifest-pinned
   and currently `readwise.library`. Drive's store tasks landed deliberately
   unscheduled pending an operator re-bind. Should this skill instruct
   implementers to always land unscheduled and flag the re-bind, or is
   appending the new source id in scope for the same tranche?
9. **Content provider.** `src/workers/readwise/content-provider.ts` reads the
   **legacy** index. The connector store ships a generic
   `createConnectorStoreContentProvider`. Does a greenfield source need any
   per-source content provider at all, or is the generic one always sufficient?
10. **Eval gate.** `AGENTS.md` defines done as passing the held-out eval, not a
    demo. Does a new dark connector need an `eval/` entry before it may flip to
    serving reads, and should that be a leg in this skill?
11. **Drop-in numbers.** There is no registry of allocated numbers; they are
    discovered by grepping, and at least three numbers are currently reused
    across different drop-in directories. Worth a manifest key or a lint?
