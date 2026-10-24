# Source storage

Status: approved by the owner 2026-10-24 (decisions 1–5 below); delivery in
progress. Replaces the storage half of the Delete work in #455/#467 (#467
frozen 2026-10-24). This page covers storage only: where each account's
files live, who opens them, and the storage operations that Delete, Export,
uninstall and ingestion call. The Delete feature itself (dashboard states,
restart timing) is a separate workstream. Where this page and the code
differ, the code is current; the inventory below was read at `be4524c5`.

## Outcome

Every connected account's data lives in one folder that the shared engine
owns. One registry says which accounts exist and where their folder is.
Export, Delete, uninstall, status and the dashboard read that registry and
never know a source by name. Deleting one source becomes: mark it, restart
the worker, rename its folder away, run each shared file's "forget" step.

Nothing about what is stored changes: the same `LocalConnectorStore`
format, chunks, embeddings, tiers and answers. Only where the files sit,
and who decides it.

## Why

Ingestion already follows the thin-connector rule: every source writes
through one `LocalConnectorStore`. Storage does not:

- **Each connector picks its own file names and folders.** The data-folder
  expression is copied inline in about 25 files, with small differences:
  Telegram's stores use `HOME` and ignore `XDG_DATA_HOME`
  (`telegram-messages/corpus-adapter.ts:19`); WhatsApp and Telegram capture
  live under `~/.local/share/olympus`, not the data folder; `handles.json`
  ignores the Linux config folder (`credential-broker/connected-handles.ts:90`);
  X's reconcile state has two different defaults depending on the caller
  (`x-bookmarks/reconcile-state.ts:288-290`).
- **One source is many files in several folders.** Up to three tier stores,
  each with three sidecars (`.tier-ledger`, `.tier-sniffer`,
  `.secret-locations`) and SQLite's `-wal`/`-shm`; plus spools, sessions,
  watch snapshots, policy and request-budget files; spread over the data,
  config, state and cache folders.
- **Export and Delete keep a second, hand-written list of every source's
  files** (`lifecycleSourceSpecs`, `src/data-lifecycle.ts:286-497`, about
  100 source-name mentions). It calls some connector resolvers and
  duplicates others. Two more store lists disagree with it
  (`source-ingestion-ledger.ts:1547` omits the Gmail and Drive public
  stores; `tier-migration-lanes.ts:111`). This is per-source code
  downstream of the connector, which `docs/CONTRACTS.md` forbids.
- **Nothing owns the open files.** The worker opens every lane's stores at
  boot and keeps them open whether the source is connected or not
  (`server.ts:2495-2874`, mounts gated by env flags only, `:6129`). The CLI
  (`data`, `ingestion status`, `tier`), the embedding drain's direct mode
  and operator scripts open the same files from other processes. CLI
  `data delete` unlinks files the worker may hold open
  (`data-lifecycle.ts:794`).

Every Astra finding across eight rounds of #467 traced to one of the last
two: Delete could not know every file, and could not know who had them
open. Locks and fences around an unowned, unlisted layout kept adding new
ways to fail.

## Principles

1. **Storage is spine, not connector.** A connector declares what it needs
   (which tiers, which kinds of raw state); the engine decides where it
   goes. No connector or downstream module builds a data path.
2. **One folder per account.** Everything that belongs to one connected
   account (stores, sidecars, raw capture state, per-account settings) is
   inside that folder and nowhere else.
3. **Shared files hold no item data.** A file outside an account folder may
   hold counts, ids, settings and accounting, never item content or names.
   Where a shared file keys rows by source, it registers one forget step.
4. **One owner of the data at a time.** The worker owns the data root while
   it runs; any other process that opens a store either goes through the
   worker or holds the same owner lock, and refuses while the worker runs.
5. **Delete is a rename.** An account folder either exists or has been
   renamed into trash; there is no half-open state to fence.

## Layout

One resolver module, `src/core/olympus-layout.ts`, computes every root
once from the platform and env. Roots stay where they are today (no move of
the roots themselves):

| Root | macOS and OpenClaw-hosted | Standalone Linux |
|---|---|---|
| data | `~/.local/share/openclaw/olympus` (or `$XDG_DATA_HOME/...`) | receipt `dataDir` (`linux-engine-layout.ts:266`) |
| config | `~/.config/olympus` and `~/.olympus` (owner settings) | `$XDG_CONFIG_HOME/olympus` |
| state | `~/.local/state/olympus` | `$XDG_STATE_HOME/olympus` |
| cache | `~/.cache/olympus` | `$XDG_CACHE_HOME/olympus` |

Inside the data root:

```
<data>/
  registry.json                  the account registry (below)
  data-owner.lock                the owner lock (never removed, even by Delete all)
  sources/<source_id>/<slot>/
    stores/<tier>.sqlite         one per trust tier, sidecars beside it
    raw/                         spools, watch snapshots, capture cursors
    session/                     pairing sessions (WhatsApp session.db, Telegram .session)
    settings/                    per-account choices (folder scopes, ingestion policy)
  shared/                        shared files (dashboard, scheduler, jobs, ledgers)
  media-cache/                   content-addressed, holders keyed by account
  models/, engine/, connect-relay/   unchanged
  .trash/                        renamed-away accounts awaiting removal
```

- `<slot>` is a short local id (`1`, `2`, …) recorded in the registry, so
  provider account ids and emails never appear in paths. Today every source
  has one slot.
- Sidecar naming stays as is (`<store>.tier-ledger.sqlite` etc.,
  `classification/tier-ledger-path.ts`); they now sit inside `stores/`. The
  set ledger stays beside the secure store.
- Credentials stay in the secret store (Keychain, libsecret or
  `secrets.enc`); `handles.json` keeps only references. Disconnect already
  removes both.
- One data-root override (`OLYMPUS_DATA_DIR`) remains for tests and
  development. The per-store `OLYMPUS_SOURCE_INDEX_*_DB_PATH` overrides and
  `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON` path fields go away (owner
  decision 3).

## Registry

`<data>/registry.json`, written atomically under the existing file lease
(`src/core/file-lease.ts`). One entry per account:

```json
{
  "schema": 1,
  "accounts": [
    {
      "source_id": "dropbox.files",
      "slot": "1",
      "state": "active",
      "layout": "folder",
      "corpus_ids": ["secure_local.dropbox.files", "internal.dropbox.files", "public_safe.dropbox.files"],
      "provider_account_hash": "…",
      "created_at": "…"
    }
  ]
}
```

- `state` is `active`, `deleting`, or `deleted` (kept briefly so the
  dashboard can say so, then dropped).
- A missing file is an empty registry. A file that cannot be parsed, names
  an unknown schema or lists an account twice is never read as empty: every
  open refuses until it is repaired, since it may hold a delete marker
  (`src/core/source-registry.ts`).
- `layout` is `legacy` (files still at today's paths, as step 2 adopts
  existing accounts) or `folder` (inside `sources/<source_id>/<slot>/`).
  Whether an account exists and where its files are are tracked apart: the
  storage service resolves an account's paths from `layout`, and migration
  selects on it.
- The registry is the only list of accounts. Export, Delete, uninstall,
  `ingestion status`, the tier commands, the dashboard and the scheduler
  read it; `lifecycleSourceSpecs`, `localConnectorStores` and the tier
  migration lane list are deleted.
- Connecting creates the entry and the folder. A different provider account
  for the same source gets a new slot, not the old folder (owner decision 1).
- **Corpus ids are per slot.** Shared files, the scheduler
  (`source-scheduler-state.ts`, key `(source_id, corpus_id, task_id)`) and
  retrieval routing (`source-index/router.ts`, keyed by corpus id) know an
  account only by its corpus ids. Slot `1` keeps today's corpus ids, so
  existing installs migrate with no id change. Slot `2` and later get
  account-scoped ids (`<corpus_id>~<slot>`), recorded in the registry, so two
  accounts of one source schedule, search and forget independently.
  Before slot `2` can exist, every corpus-id consumer must accept those ids
  (a test drives a two-slot source through sync, search, the dashboard and
  Delete). Until then, connecting a different account while the previous
  account's data is kept is refused with "Delete the previous account's
  data first".

## Storage service

One module in the worker, `src/core/source-storage.ts`, is the only code
that opens files inside an account folder:

- `openConnectorStore(account, options)` constructs a `LocalConnectorStore`,
  and `openTierLedger`, `openSecretLocations` and `openTierSniffer` its tier
  sidecars, for `account = { sourceId, slot? }` (slot `1` by default) at the
  caller's path, unchanged until step 4. Callers keep sharing the objects
  they open, as today; the service holds no cache.
- An account whose registry state is not `active` is never opened. Callers
  get `SourceStorageUnavailableError` ("not available"), the same answer as
  a lane that is not mounted today; no stand-in store is ever returned. At
  worker boot, `isSourceAccountOpenable` decides the mount: a lane whose
  account may not be opened is not mounted, with one `[storage]` log line.
  A store declared only by its corpus (a JSON mount, a script's `--db`)
  takes the source the corpus registry names for it, else its corpus id
  without the trust-domain prefix.
- Adoption: the worker turns it on at boot. A writable open of an account
  with no entry records one (slot `1`, `active`, `legacy`, its corpus id);
  an open of a further corpus adds that corpus. Read-only opens, and every
  open from the CLI, scripts and tests, never write the registry.
- The per-request opens of the dispositions page go through the service.
  The extra read-only connection per vector scan stays the store's own
  connection, inside `local-index.ts`, of a store the service opened.
- Search keeps reading disconnected accounts' stores ("Disconnected ·
  indexed data kept"), because they stay `active` until deleted.

**Owner lock.** The worker takes an exclusive kernel lock (`flock(2)` on
`<data>/data-owner.lock`, released by the kernel on death;
`src/core/data-owner-lock.ts`) for its lifetime. The lock sits in the data root
itself, not the state root, so any two processes that resolve the same data
root contend on the same lock even with different `XDG_STATE_HOME` values;
it is outside every directory that Delete or Delete all removes, so its
inode never changes while held. `flock` belongs to the descriptor that took
it, so a walker or file probe that opens and closes the lock file in the
holding process leaves it held (a POSIX `fcntl` lock, file-lease's, would be
dropped); the descriptor is close-on-exec, so a child never keeps it. Walkers
still leave the file alone (`isDataOwnerLockName`). Every other opener of a
store:

| Opener | After this change |
|---|---|
| Embedding drain | `http` mode only; direct mode removed (2b-i) |
| CLI `data export`, `data delete --source`, `ingestion status`, `tier set`, `tier explain`, `tier migrate` | takes the lock and runs here when it is free; while Olympus runs, asks the worker over its local API (`POST /v1/cli/*`: worker bearer only, never forwarded by the relay) and prints what it returns; refuses as busy when no worker answers |
| CLI `tier migrate run`, `rollback`, `purge --approve` | take the lock when free; refuse while Olympus runs, because they move items between the stores the worker's lanes write |
| CLI `data delete --all`, `data verify` | `--all` runs under the lock when free; while Olympus runs, custody refuses it (or, if only a script holds the lock, it is refused as busy) and the worker is not asked; `verify` reads only the export folder |
| `connector-store:embed`, `whatsapp-live-sync`, repair and backfill scripts | take the owner lock, so they refuse while Olympus runs |
| Telegram reader, WhatsApp bridge | write only `raw/` and `session/` of their account; stopped by Disconnect |

A guard test (`test/store-open-guard.test.ts`, salvaged from #467's)
fails on any construction of `LocalConnectorStore`, `TierLedger`,
`SecretLocationsIndex`, `TierSnifferStore` or any `new *Database*(` in
`src/` or `scripts/` outside the storage service and an allowlist that names
a reason for each file: the store and sidecar classes themselves, the lock
database, Apple Messages' `chat.db`, the shared files (step 3), X's
per-account state (step 4), `data-lifecycle.ts` (step 5), generic code that
reopens sidecars beside a store by path, and operator scripts on a `--db`
(the owner lock). An entry that stops matching fails too, so the list only
shrinks.

## Shared files

Each shared file is either listed as holding no per-source data
(`KEPT_SHARED_FILES`, with the reason) or has one forget step in
`src/core/source-forget-registry.ts` (`FORGET_STEPS`). A step is
`forget({ source_id, slot, corpus_ids }, context, { dryRun })`: its logic
lives in the module that owns the file, and the registry lists the steps and
`runForgetSteps` runs them in order, stopping at the first failure with an
error that names the step and the file. Each step is idempotent, runs in its
own transaction (SQLite) or atomic write (JSON), counts without writing on a
dry run, and does nothing for a file that is not there. The account's
`corpus_ids` are the registry entry's joined with the shipped corpus
registry's for the source and its aliases. A test fails when a module opens a
shared SQLite file without owning a step or a kept entry, or when a step or
kept entry names a module that no longer opens one
(`test/store-open-guard.test.ts`).

| File | Per-source key | Step id, or why kept |
|---|---|---|
| `waiting-private-questions.sqlite` | results' `corpusId`, provenance | `waiting-private-questions`, first: answers go before anything they depend on |
| `source-dashboard.sqlite` (with the ingestion ledger's tables) | `source_id`, ledger id, `corpus_id` | `source-dashboard` |
| `source-scheduler.sqlite` | `(source_id, corpus_id, task_id)` | `source-scheduler` |
| `file-extraction-jobs.sqlite` | `corpus_id`; holds file **names**; Secrets redaction claims keyed by the source's tier-ledger id | `file-extraction-jobs` (names are item data, principle 3): jobs, artifacts, re-reads, and the claims of the source's tier ledgers with each redaction no other ledger claims (the ids are read from the ledger files before they go; an unreadable ledger keeps its claims and is reported); later candidate to move into the account folder |
| `source-watches.sqlite` | `corpus_id` | `source-watches` |
| `source-ingestion-doctor-state.json` | `sources[ledger id]` | `ingestion-doctor-state` |
| `tier-migration/reports/*.json` | `topPatterns[].source`; hold the owner's folder paths, senders, chat keys | `tier-migration-reports` (found by the sweep) |
| `tier-migration/state.json` | `plans[].lanes[].sourceId`; `plans[].batches[].selector` holds the owner's raw selectors | `tier-migration-state`: in every plan with the source as a lane, each selector but `source:` becomes `<kind>:<forgotten>`; a stopped batch no longer resumes by it |
| `~/.config/olympus/{file,mail}-source-scopes.json`, `this-computer.json`, `source-account-bindings.json` | `source_id` | `file-source-scopes`, `mail-source-scopes`, `this-computer`, `source-account-bindings` (last); move into the account's `settings/` in step 4 |
| `embedding-ledger.jsonl`, `source-answer-latency.jsonl` | corpus ids only, no content | kept (accounting) |
| `classification-ledger.jsonl` | none | kept |
| request budgets, `tier-sniffer-budget.json` | per provider / global counters | kept |
| `remote-connections.sqlite` | none (`provider` is the agent host) | kept |
| `credential-broker-state.json`, `handles.json.unpaired` | handle, source id | kept: credential and Unpair custody, no item data (Disconnect and Unpair own them) |
| `connect-relay/`, `models/`, `local-files/folder-access.json` | none | kept |
| `~/.olympus/{sources/ingestion-exclusions.json, tier-rules.json, privacy.json}` | optional `source` per rule | kept: the owner's own policy. An exclusion is protective (dropping it would let a reconnected account ingest what the owner refused), and a tier rule is the owner's to change |
| `media-cache` | holders per store | holders keyed by `(source_id, slot)`; Delete releases them |

A per-source Delete runs the steps (`forgotten` in its result lists each file
and count; a dry run lists what it would forget) after the account's state is
reset and before any bytes are removed. A failing step fails the delete there.
Disconnect runs none. The worker repeats the steps marked
`repeatBeforeRestart` (`source-dashboard`, `source-watches`) once it has
stopped, just before the restart a Delete asks for, because until then a
dashboard poll can record counts it read through store handles still open and
the watch pass can queue matches from them. No other step is repeated: the
owner can reconnect in that window, and a repeat would erase the reconnect.

## Delete

Preconditions, unchanged from #455: the source is disconnected (capture
stopped, credentials removed) and the worker can restart itself.

1. The dashboard or CLI sets the account to `deleting` in the registry and
   asks the worker to restart (exit 75, `model-key-reload.ts:36`). The
   Gateway or engine host restarts only the worker.
2. At boot, holding the owner lock and **before anything is mounted or any
   capture starts**, the worker handles each `deleting` account:
   1. rename `sources/<id>/<slot>/` to `.trash/<uuid>/` (one atomic rename
      on the same volume);
   2. release its media-cache holds;
   3. run every forget step (each idempotent, each in its own transaction);
   4. set the entry to `deleted`.
3. Remove `.trash/*` in the background; leftovers are removed at the next
   boot.

An account still on the `legacy` layout (its migration failed verify, or a
file sits on another volume) is deleted the same way, except that step 2.1
renames each of its legacy paths, as the layout module's legacy resolvers
name them, into `.trash/<uuid>/` instead of one folder.

If a step fails, the entry stays `deleting`. The storage service never
opens a `deleting` account, so nothing reads or writes a half-deleted
store, and the registry state is what the Delete feature reports and
retries from (another restart). Other sources are unaffected and the engine
starts normally. A crash at any point resumes at the next boot from the
registry state, because each step is idempotent and the rename is atomic.

What this removes from #467: the custody lock per store, the delete-fence
file and its in-memory stand-in stores, canonical-path intent bindings, and
recursive-target identity checks. The folder is the unit; there is nothing
outside it to find and nobody else to fence.

**Delete all** (`data delete --all`) removes the data root's `sources/`,
`shared/`, `.trash/`, `media-cache/`, the registry and the known legacy
leftovers (below), under the owner lock, with the engine stopped as today.
It never removes `data-owner.lock`; uninstall removes it last, after
everything else.

## Export and uninstall

- **Export** iterates the registry, snapshots each store with the existing
  SQLite snapshot code (`data-lifecycle.ts:1391`), copies `settings/`
  sanitized, and records the layout version. It never copies `raw/` or
  `session/`: the spool is input the store already holds, and the session
  holds pairing keys (WhatsApp, Telegram). Both are named as skipped in the
  manifest, which keeps `secrets_excluded: true`, as export does today
  (`data-lifecycle.ts:651-657`, `test/data-lifecycle-raw-state.test.ts`).
  Verify checks the same shape. Old export archives stay verifiable (keep
  the current verifier for the previous version).
- **Uninstall** (`site/uninstall.sh`, `site/uninstall-linux.sh --purge`)
  removes the roots from the layout module's list instead of a hand-kept
  one. Today macOS uninstall does not mention `~/.local/share/olympus`,
  `~/.local/state/olympus` or `~/.cache/olympus`, and a Linux purge leaves
  `~/.local/state/olympus/telegram-*`; after migration those paths are
  either inside a root or gone.

## Migration of existing installs

One-time, at worker boot, holding the owner lock, before mounting:

1. Read the legacy locations through the layout module's legacy resolvers
   (named in step 1, used for this purpose only).
2. For each account whose `layout` is `legacy` (the entries step 2
   adopted, plus an entry created now, slot `1`, for any source with legacy
   files and none yet), and whose capture process (Telegram reader,
   WhatsApp bridge) is confirmed stopped, not merely not yet started: write
   a move plan into the entry, rename each file (stores, sidecars,
   `-wal`/`-shm` together, spools, sessions, watch snapshots, settings) into
   the account folder, verify (same file set and sizes, `PRAGMA
   quick_check`, store opens), then set `layout` to `folder` and mark the
   plan done. A
   crash mid-move resumes from the plan; a failed verify moves the files
   back and leaves the source on its legacy paths with a Needs you row. A
   source whose capture is still running stays on its legacy paths until
   the next boot; a capture process that reopened its session by the old
   path would start an empty, unpaired session.
3. Renames only. A file on another volume (only possible with a per-store
   env override) is not copied: the source stays on legacy paths and the
   dashboard says why. Public docs must be checked to confirm no user was
   told to set those overrides (unverified).
4. Legacy pre-1.0 index files (`email-index.sqlite`,
   `dropbox-files-index.sqlite`, `google-drive-docs-index.sqlite`,
   `telegram-messages-index.sqlite`, `readwise-index.sqlite`; only in
   `data-lifecycle.ts:292-408` today) are left alone and removed by Delete
   all (owner decision 5).
5. `runDataMigrations` (`data-lifecycle.ts:1015`, never called) is deleted.

No re-embed and no rescan: stores, cursors (`sync_runs.cursor`), tiers,
embeddings and watch snapshots move as files. Embedding changes stay
owner-gated and this plan makes none.

## What must not break

Each needs a test before the migration step ships:

- Search and cited answers across every source, including a disconnected
  source with indexed data kept.
- Private/Personal tiers and secret locations (sidecars move with stores).
- Embeddings: vector counts and a known query's results identical before and
  after the move.
- Sync resumes from the stored cursor without a full resync; local files
  catch up from the watch snapshot without a rescan.
- WhatsApp and Telegram stay paired after the session file moves (real
  device, Mac and Linux).
- Media-cache holds: no picture dropped, none leaked.
- Dashboard history and Needs you rows survive.
- Archive imports keep their state and queued requests.
- Standalone Linux receipt layout, `uninstall-linux.sh` purge, and the
  OpenClaw-hosted mode (Gateway-run capture services wait for worker
  readiness, `native-telegram-service.ts:110`, so they start after the boot
  pass).
- The ChatGPT reviewer listing is untouched (`connect-relay`).

## Delivery steps

Each is its own PR with focused proof; the held-out eval runs for steps that
touch the store path (`eval/`).

1. **Layout module + tests isolation.** `olympus-layout.ts` returns today's
   paths; every inline data-folder expression and private `dataDir()` calls
   it. A reader that disagrees with its writer is fixed to match the writer
   (the X reconcile default, `olympusSharedDataFile` missing the Linux root,
   the ingestion ledger's WhatsApp store, the Telegram readiness probe's
   state directory). A writer that drifts from the layout keeps its files
   where they are until step 4 moves them, named as legacy in the layout
   module: Telegram's stores ignore `XDG_DATA_HOME`; so does the WhatsApp
   capture service's default state folder, while pairing and the worker's
   readers honor it; and the WhatsApp bridge and the Telegram capture spool
   sit in `<XDG data home>/olympus`, outside the data root. `handles.json` ignores `XDG_CONFIG_HOME` in writer and
   reader alike and also waits for step 4. Salvage #467's test isolation
   (refuse the real HOME, isolated HOME in every package test script, spawn
   patches). No behavior change beyond those reader fixes. Two PRs: test
   isolation first, then the layout module.
2. **Registry + storage service + owner lock + guard.** Registry adopted
   from legacy locations without moving files; all store opens through the
   service; drain direct mode removed; CLI and scripts take the owner lock.
   Three PRs: 2a, registry, storage service and guard (done); 2b-i, the
   owner lock held by the worker and taken by scripts and, when free, by the
   CLI, with the drain's direct mode removed; 2b-ii, the CLI through the
   worker's API while Olympus runs (`src/core/cli-via-worker.ts`).
3. **Forget registry.** Forget steps for the shared files above, and the
   guard test (done). A per-source Delete runs them; the worker repeats them
   before its restart.
4. **Migration into account folders.** Behind the boot pass, with the
   tests in "What must not break". Trying it on real installs before it is
   on by default belongs to release testing.
5. **Delete, export, uninstall on the registry.** Replace
   `lifecycleSourceSpecs` with the registry: a per-source delete marks the
   account `deleting` and the boot pass removes it; export and uninstall
   read the registry and the layout module.
6. **Connectors stop naming paths.** Rewrite `docs/CREATE_CONNECTOR.md`
   Leg 3 (it still instructs each connector to define a default path and
   says seven local indexes are grandfathered; the guard allows one), drop
   per-store env overrides, a guard against data paths built outside the
   layout module.

Done when: no `src/` module outside the layout module builds a data path;
no store is opened outside the storage service; `data-lifecycle.ts` names no
source; deleting a source removes exactly its folder plus its shared rows,
proven on Mac, standalone Linux and OpenClaw-hosted.

## Owner decisions

All five approved by the owner, 2026-10-24.

1. **One folder per account, with slots.** Connecting a different account
   for the same source creates a new folder; the old one stays as
   "Disconnected · indexed data kept" until deleted. In two parts: the
   folder shape and per-slot corpus ids now; a second slot only once every
   corpus-id consumer is proven with two (see Registry). Until then a
   different account needs the previous data deleted first.
2. **Delete forgets that account's choices too** (folder picks, ingestion
   policy, scope approvals), so reconnecting starts clean; Disconnect keeps
   them.
3. **Drop per-store path overrides**, keep one data-root override (they
   serve development, not users).
4. **Removal applies when the worker restarts**, before anything opens the
   account, not live. A live in-process removal can come later once the
   scheduler can cancel a running task per source
   (`source-scheduler.ts:516-522` has no cancel today).
5. **Leave pre-1.0 index files** for Delete all to remove, rather than
   deleting them during migration.

## Out of scope

Moving the roots themselves (for example to `~/Library/Application
Support` on macOS), multi-account UI, and changing what is stored.
