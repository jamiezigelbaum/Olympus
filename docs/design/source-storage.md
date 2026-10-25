# Source storage

Status: approved by the owner 2026-10-24 (decisions 1–5 below); delivery in
progress (steps 1–3, 4a and 4b done). Replaces the storage half of the Delete work in #455/#467 (#467
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
                                 (archive imports: stores/<family>.<tier>.sqlite)
    raw/                         spools, watch snapshots, capture cursors,
                                 X's reconcile state (raw/x-reconcile.sqlite),
                                 imported archives' media bindings
                                 (raw/archive-media-bindings.sqlite),
                                 the extraction spool (raw/extraction-spool/):
                                 the raw bytes a file reader is handed while it
                                 reads, under c-<corpus>/a-<account scope>/
    session/                     Telegram's pairing session (telegram.session and its -journal);
                                 WhatsApp's session.db lives with its bridge state in raw/whatsapp/
    settings/                    reserved; unused (see below)
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
- There is no `OLYMPUS_DATA_DIR`: the data root follows the standalone Linux
  receipt, else `XDG_DATA_HOME` (`olympus-layout.ts`), and tests isolate
  themselves with a throwaway HOME. The per-store `OLYMPUS_SOURCE_INDEX_*_DB_PATH`
  overrides and `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON` path fields go
  away (owner decision 3). Until step 6 deletes them, an override or a mount
  that names an account's files pins that account to `legacy`, and a `folder`
  account never honors one.
- **Settings stay in the shared config files** (`file-source-scopes.json`,
  `mail-source-scopes.json`, `this-computer.json`, `source-account-bindings.json`
  and the Dropbox ingestion policy). Several sources share one file, so they
  cannot move by rename; the forget steps already handle them, and
  `settings/` stays unused. Export names them as it does today.
- **The X usage ledger stays shared.** It is the quota ledger, kept when X is
  deleted, so it stays in the data root; only X's reconcile state is
  per-account (`raw/x-reconcile.sqlite`). The request budgets stay shared too.
- **Reflect and Roam stay legacy for now.** They name their paths through
  JSON mounts. Telegram and WhatsApp accounts are folders on a fresh install
  (4b); an existing messaging account keeps its legacy paths until step 4d.
- **Gateway-run capture stays legacy after 4d too.** In OpenClaw-hosted mode
  the Gateway runs the capture services, and the worker can neither stop nor
  coordinate them, so an account whose capture the Gateway owns, or whose
  path a plugin-config setting pins, is never moved. Moving those would need
  a Gateway-level step (run the move before the Gateway starts capture, or
  have the worker ask it to stop), which is not planned.

## Registry

`<data>/registry.json`, written atomically under the existing file lease
(`src/core/file-lease.ts`). One entry per account:

```json
{
  "schema": 2,
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
- **The schema is 1 while every entry is `legacy`, 2 from the first `folder`
  entry, and 3 while any account has a move pending** (the file is written as
  whichever fits its content). A build that only knows schema 1 (step 3) reads
  a schema-2 or -3 file as unreadable and opens nothing, instead of ignoring
  `layout` and creating empty stores at the legacy paths beside the data in the
  folder. A 4a or 4b build knows 1 and 2, so it refuses a schema-3 file the
  same way: while a move is pending nothing else opens the data root, and once
  it is done the file is 2 again and the older build reads the folder accounts
  as it always did. An install with no folder account keeps a schema-1 file,
  records of a skipped or failed move included (they are additive fields on a
  legacy entry, which older readers pass through).
- `layout` is `legacy` (files still at today's paths, as step 2 adopts
  existing accounts) or `folder` (inside `sources/<source_id>/<slot>/`).
  Whether an account exists and where its files are are tracked apart: the
  storage service resolves an account's paths from `layout`, and migration
  selects on it.
- **`migration` (4c)** is the record of the boot migration on an entry:
  `{state, at, reason?, detail?, moves?, checked?}`.
  `state` is `moving` or `reverting` (a plan is pending; the account is
  closed: the storage service opens none of its files, the same refusal as an
  account being deleted, so it does not mount), `done`,
  `skipped` (the account stays legacy, `reason` is a short code and `detail`
  plain words) or `failed` (the move was undone). Each entry of `moves` is
  `{role: store|ledger|secrets|sniffer|raw, from, to, kind: file|dir, db?, dev,
  ino, size}` with `from` and `to` relative to the data root and the identity
  as strings; `checked` is what `PRAGMA quick_check` said before the move. A reader that
  does not know the field passes it through unchanged.
- **Placement of a new account (4a).** An account with no entry is recorded
  `folder` only if nothing says it lives elsewhere: its source has a folder
  layout, no env override or connector-store mount names its files, no file of
  it exists at any legacy location (stores, tier sidecars, `-wal`/`-shm`, raw
  state; lock files do not count), and every legacy location can be looked at
  (an unreadable folder or a dangling link places it `legacy`). The decision is
  a pure function of the registry, the file system and the environment
  (`core/source-placement.ts`), so the worker, the CLI and scripts reach the
  same answer before the entry exists; only the worker, which holds the owner
  lock, records it, before the account's first file is created, whichever file
  that is: a store, a tier sidecar opened ahead of its stores, or raw state
  written with no store open (an archive import request, the X reconcile
  state, the local files watch folder; `recordAccountPlacement`). Recording
  is the worker's alone: the CLI, which holds the owner lock only while the
  worker is down, writes no first file of an account (a tier command opens only
  lanes whose stores exist), so it records nothing and adoption stays off for
  it. A registry that cannot be read resolves to the folder when one is
  on disk, else to the legacy paths: nothing opens until it is repaired.
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
| CLI `data export`, `data delete --source`, `ingestion status`, `tier set`, `tier explain`, `tier migrate`, and the placement step of `connect telegram\|whatsapp --pair` (4b) | takes the lock and runs here when it is free; while Olympus runs, asks the worker over its local API (`POST /v1/cli/*`: worker bearer only, never forwarded by the relay) and prints what it returns; refuses as busy when no worker answers |
| CLI `tier migrate run`, `rollback`, `purge --approve` | take the lock when free; refuse while Olympus runs, because they move items between the stores the worker's lanes write |
| CLI `data delete --all`, `data verify` | `--all` runs under the lock when free; while Olympus runs, custody refuses it (or, if only a script holds the lock, it is refused as busy) and the worker is not asked; `verify` reads only the export folder |
| `connector-store:embed`, `whatsapp-live-sync`, repair and backfill scripts | take the owner lock, so they refuse while Olympus runs |
| Telegram reader, WhatsApp bridge | write only `raw/` and `session/` of their account, at the paths their starter passes them; stopped by Disconnect |

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
| `file-extraction-jobs.sqlite` | `corpus_id`; holds file **names**; Secrets redaction claims keyed by the source's tier-ledger id | `file-extraction-jobs` (names are item data, principle 3): jobs, artifacts, re-reads, and the claims of the source's tier ledgers with each redaction no other ledger claims (the ids are read from the ledger files before they go; an unreadable ledger keeps its claims and is reported); later candidate to move into the account folder. The scratch files the extraction runner writes for a file reader are not shared: each account keeps them in its own `raw/extraction-spool/` (an imported archive's in the archive account's, under its family's corpus), so a Delete takes them with the folder. A `legacy` account's sit in the shared `extraction-spool/` of the data root, and this step removes them there; an archive removed from a corpus its family shares has its account scope's removed from the archive account's spool |
| `source-watches.sqlite` | `corpus_id` | `source-watches` |
| `source-ingestion-doctor-state.json` | `sources[ledger id]` | `ingestion-doctor-state` |
| `tier-migration/reports/*.json` | `topPatterns[].source`; hold the owner's folder paths, senders, chat keys | `tier-migration-reports` (found by the sweep) |
| `tier-migration/state.json` | `plans[].lanes[].sourceId`; `plans[].batches[].selector` holds the owner's raw selectors | `tier-migration-state`: in every plan with the source as a lane, each selector but `source:` becomes `<kind>:<forgotten>`; a stopped batch no longer resumes by it |
| `~/.config/olympus/{file,mail}-source-scopes.json`, `this-computer.json`, `source-account-bindings.json` | `source_id` | `file-source-scopes`, `mail-source-scopes`, `this-computer`, `source-account-bindings` (last); stay in the shared files (they cannot move by rename) |
| `embedding-ledger.jsonl`, `source-answer-latency.jsonl` | corpus ids only, no content | kept (accounting) |
| `classification-ledger.jsonl` | none | kept |
| request budgets, `tier-sniffer-budget.json` | per provider / global counters | kept |
| `remote-connections.sqlite` | none (`provider` is the agent host) | kept |
| `credential-broker-state.json`, `handles.json.unpaired` | handle, source id | kept: credential and Unpair custody, no item data (Disconnect and Unpair own them) |
| `connect-relay/`, `models/`, `local-files/folder-access.json` | none | kept |
| `~/.olympus/{sources/ingestion-exclusions.json, tier-rules.json, privacy.json}` | optional `source` per rule | kept: the owner's own policy. An exclusion is protective (dropping it would let a reconnected account ingest what the owner refused), and a tier rule is the owner's to change |
| `media-cache` | holders per store | holders keyed by registry, `(source_id, slot, store)` and the account's incarnation, not by file path; Delete releases them (below) |

**Media-cache holds name a store, not a file** (`core/store-identity.ts`). A
store the registry places (a folder-layout source, opened through the storage
service at the path its account's layout gives it) holds a cached picture under
its identity, `(source_id, slot, store)` with the store a tier or
`<family>.<tier>`. The marker's name is a digest of the registry's path (its
folder's real path, so every spelling of the data folder names one hold) and the
identity (two data folders can share one media cache and carry the same account
and store names). It records the account's incarnation, the registry entry's
`created_at`, and where the file was last seen, as a hint. The sweep decides
whether the holder is gone from the registry and the layout: gone when the
account is `deleted` or no longer listed in a registry that was read, when the
hold is of an earlier incarnation than the entry (the account was re-created),
or when the store is missing at both layouts' paths (and the hint) with the
folder to look in present. A folder that is not there says nothing, even inside
the data folder: it may be a volume not mounted now, so an account folder gone
while its entry is still `active` keeps its pictures until the entry is
`deleted`. A registry that cannot be read, a hold written for
another data folder, and a hold with no incarnation (written before the field
existed, judged by the store alone) keep everything; a registry that is not
there keeps every hold by identity and every path marker for a path an account
could have, and judges any other path as it always did. The legacy
layout's paths do not depend on the slot, so they belong to the first slot
alone: no other slot's hold takes them as its own. Stores the registry does not
place (Reflect and Roam mounts, operator mounts, in-memory stores, staging
holds) are held by path, as before. Moving a store, 4c's rename, therefore
needs no call into the media cache: nothing in a hold names its path. A path
marker an earlier build wrote is read by the sweep as the identity of the store
the registry puts at that path, and a path in an account folder is judged by
its account (a deleted account releases it even when its folder went with it),
so a store renamed before it has held its pictures again keeps them. The store
replaces the path marker with its identity marker the next time it holds them:
the marker is written durably first, and a retry that finds the same marker
already there flushes it and its folder before the path marker goes. The incarnation
check takes effect once step 5 marks an entry `deleted` and makes a new one on
reconnect (and then needs the lookup to find the current entry). Today's Delete
leaves the entry `active` with the same `created_at` and releases the holds
itself, so until then a reconnect cannot be told from the account it follows,
and a Delete that stops after removing the folder and before releasing leaves
its pictures held (kept, never dropped). Step 5 should give each entry a value
that only ever changes by replacement (an incarnation token): `created_at`
compared as earlier-than leaks, not drops, when the clock moved backwards between
the two entries.

A per-source Delete runs the steps (`forgotten` in its result lists each file
and count; a dry run lists what it would forget) after the account's state is
reset and before any bytes are removed. A failing step fails the delete there.
Disconnect runs none. The worker repeats the steps marked
`repeatBeforeRestart` (`waiting-private-questions`, `source-dashboard`,
`source-watches`) once it has stopped, just before the restart a Delete asks
for, because until then a private question can be answered, a dashboard poll
can record counts and the watch pass can queue matches, all through store
handles still open. No owner-choice step is repeated: the owner can reconnect
in that window, and a repeat would erase the reconnect.

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
  SQLite snapshot code (`data-lifecycle.ts:1391`), copies the shared settings
  files sanitized as it does today (`settings/` stays unused), and records the
  layout version. It never copies `raw/` or
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

One-time, at worker boot, holding the owner lock, after the re-placement of
empty accounts and before adoption is enabled and anything mounts
(`migrateAccountFolders` in `core/source-account-migration.ts`, called from the
worker's `main()`). Step 4c moves every folder-layout source but Telegram and
WhatsApp; those two are step 4d and the pass never touches them. For each
account whose `layout` is `legacy` (the entries step 2 adopted, plus an entry
created now, slot `1`, for any source with legacy files and none yet), in this
order:

1. **Look.** Read the legacy locations through the layout module's legacy
   resolvers (`legacyAccountFiles`, used for this purpose only). The account
   stays legacy, and the registry records why (`migration.state: skipped`, a
   reason code and plain words), when:
   - `pinned`: an env override or a connector-store mount names its files;
   - `unreadable`: a legacy location, or the account folder, cannot be looked at;
   - `unexpected_file`: a legacy path is a link or the wrong kind of file, or a
     folder between the data folder and a destination is a link. The check is
     Delete's: the real path of the destination's folder must be its path under
     the data folder's real path (the data folder itself may be a link);
   - `destination_exists`: a file is at its old place and in the account folder
     (nothing is merged);
   - `other_device`: a file's `st_dev` differs from that of the nearest
     existing folder above the account folder (a hard link that answers
     `EXDEV` later ends the same way, after undoing what it did). Nothing is
     copied;
   - `files_elsewhere`: the registry lists a store that is not at the usual
     place in the data folder, where an override may once have put it. An
     imported archive's corpus `<tier>.archive.<family>` is the store
     `<family>.<tier>` and is checked like any other;
   - `log_large`: the account's `-wal` and `-journal` files total more than
     32 MiB. Folding a log reads it, so the logs the pass carries are bounded.
     They are folded into the stores when Olympus next stops cleanly, and the
     account moves then. Not a Needs you row.
2. **Fold the logs.** Each database's write-ahead log is folded into the
   database (`PRAGMA wal_checkpoint(TRUNCATE)`, `storeFileCheckpoint` in
   `core/source-storage.ts`) before anything is planned, so what moves is whole
   files: the database file holds everything, and a `-wal` or `-shm` that is
   lost in the move costs nothing. The pass runs at boot, before any worker has
   the stores open, but another connection may still hold one (a leftover
   process, a command-line tool): the checkpoint waits at most 2 s for it, and
   no longer than what is left of the boot's deadline (see Time), and the first
   database that is busy ends the fold. The account then stays where it is this
   boot (`busy`) and moves at a later boot, once the other connection is gone;
   not a Needs you row. A database whose frames could not all be checkpointed
   for another reason is `log_not_folded`. A file that is not a database is left alone when
   none of its logs holds bytes (it moves as the opaque file it is and the
   check records it `damaged`); with a log that holds bytes it is
   `log_not_folded` too. The checkpoint is the only write the pass makes to a
   store, a ledger or a sidecar; everything after it is a rename.
3. **Plan.** `PRAGMA quick_check` each database to record how it was, bounded
   before it starts (it cannot be interrupted; see Time): a database whose file,
   `-wal` and `-journal` together exceed 64 MiB, or that would take the boot past
   128 MiB read in total, or whose estimated time at 10 MiB/s does not fit in what
   is left of the 15 s check budget, is recorded `not_checked`; one that does not
   open is `damaged`. This only records and never blocks, with one exception: a
   database another connection has locked (an exclusive writer, say) is not
   worked around. Opening it waits at most 2 s, no longer than what is left of
   the deadline, and is never tried again in another mode; the account stays
   where it is this boot (`busy`), and the other databases are not waited for. Reading a database may
   make its `-shm`, so the account is looked at again, and the plan names what is
   there; a log with bytes in it again (something wrote after the fold, so the
   folded file is no longer the whole database) is `log_not_folded` too. Then
   write the move plan into the entry: `migration: {state: moving, moves,
   checked}` (see Registry), which also turns the file into schema 3. From here
   the account is closed. `moves` lists, per tier store, the store, its
   `-wal`/`-shm`/`-journal`, its tier ledger, secret locations and sniffer, plus
   raw state (the local files watch folder, X's reconcile state, an archive
   import's state and request files), each with `(dev, ino, size)`. An archive's
   stores go to `stores/<family>.<tier>.sqlite`.
4. **Rename** every planned file into the folder. Nothing is copied, so each is
   atomic and instant whatever its size, and none replaces what is there: a file
   is hard-linked to its new name (which fails with `EEXIST` where `rename(2)`
   would replace what another process put there since the look), the folder that
   now holds the new name is fsynced, and only then is the old name unlinked: at
   no moment can a power failure find the file with no name that survives it.
   A kill between the link and the unlink leaves one inode under two names, which
   the next boot finishes the same way (it fsyncs the folder of the name that
   stays before it removes the other); going back is the same, the other way. A
   folder is renamed, which the kernel refuses onto a non-empty folder or a file,
   and both of its parents are fsynced right after. Residual: `rename(2)` of a
   folder replaces an EMPTY folder that appeared in the instant since the look (it
   holds nothing to lose, and the planned folder takes its place). A file system that makes no
   hard links (the link answers `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS` or
   `EMLINK`) keeps the account where it is, `no_hard_links`, with what had moved
   put back and the reason recorded; no other way of moving a file is tried,
   because a plain rename would replace a file another process put at the
   destination. Not a Needs you row. Before each rename the destination's
   folders are checked for links again.
   Before any file moves, every folder from the data folder down to each
   destination folder is fsynced, once per account, the ones that were there
   already included: a run that died after making a folder and before syncing its
   parent left an entry that is not on disk, and a folder being there says nothing
   about that. Going back does the same for the folders the files return to,
   before the first file goes. After the last rename the folders each file left
   (the unlinks) and went to are fsynced again, before the registry records
   anything that depends on the renames.
5. **Verify.** Each destination has the planned `(dev, ino, size)`, then each
   database that opened before opens and its schema reads (read-only; a database
   with no `-wal` beside it, which macOS's SQLite will not open read-only, is
   opened writable but query-only, and only when no write waits outside its file,
   because closing a writable connection merges one). A failure undoes the
   move; a database another program holds at that moment (`busy`, same wait) is
   not a fault of the move: everything goes back as a skip, with no Needs you row.
   A file that is in neither place is a failure, and so is a `-wal` or
   `-journal` that held bytes when the plan was made: that is committed data not
   yet in its database file, so only a `-shm` (rebuilt from the log on the next
   open) and a log that was empty may be missing. (This build plans only empty
   logs, but a plan is read as data.)
6. **Flip** `layout` to `folder` and the plan to `done` in one registry write:
   there is no moment at which an account is a folder with its plan pending, or
   done and legacy.

The move writes nothing but file names: no store, ledger or sidecar is opened
for writing after the fold, the media cache is not touched (a hold names the
store's identity, not its path), and a tiered set's stores find their ledger by
its id. A crash anywhere resumes from the plan at the next boot, switch or no switch
(the account is closed until the plan ends one way or the other). A failed
verify, a file that is in neither place, or any other failure moves everything
back (`reverting`, the same steps in the other direction, then
`migration.state: failed`) and leaves the account legacy: the final write sets
`layout: legacy` whatever the entry said when the undo began. A file in both
places going back (one another process put at the folder's side, which is why
the move stopped) is left where it is, and the planned file is already home. A
file that is in neither place while going back keeps the account closed with its
plan (reported stuck, and a Needs you row), and the plan is cleared only when
every planned file is at its old place, whoever put it there: a copy restored
from a backup lets the undo finish. A plan this build did not write is left
alone and reported stuck. An account that ended in a move back is not started
again in the same boot. A plan is dropped only by the
Delete that took the account's files, which removes the plan from the registry
(under the owner lock, after the files, so a Delete that stops in between leaves a
plan the next boot reports and a second Delete clears). Without a Delete, a plan
whose every file is in neither place is the same loss as any other file lost: the
account stays closed with its plan and a Needs you row, and nothing is made in its
place. The re-placement of empty accounts, which runs first at
boot, skips an entry with a plan pending: a crash after the last rename leaves
an entry that lists no corpus and no file at a legacy place, which is not an
empty account.

The dashboard turns four states into Needs you rows (`sourceStorageNotices`):
a failed move ("its files could not be moved, so they were put back"), a plan
that is part way ("its files are part way through a move") an unreadable
location ("Olympus cannot open the folder its files are in") and
`destination_exists` ("its files are in two places"). The other skips are
logged (`[storage] <id> stays where it is (<reason>)`) and, when the account
has an entry, recorded with their plain words on it, but are not Needs you
rows: nothing is wrong, the source works as before.

**Time.** The worker waits 180 s for a boot (startup timeout), so every operation
of the pass that grows with the data is bounded by a size or a count, and the
worst case is arithmetic. It assumes a disk no slower than 10 MiB/s sequential
and 50 ms per fsync (an old external drive).

- Starting an account, a plan left part way included, stops at 45 s from the
  pass's start; accounts not reached go on at the next boot. That deadline is
  also the boot's wait for other connections: every open and checkpoint waits at
  most 2 s, and no longer than what is left of it. A busy database ends its
  account's pass for this boot, and is never retried in another mode, so an
  account waits once, and an account started at 44.9 s waits almost not at all.
- Folding the logs reads each log once and writes it once into its database:
  the account's logs are capped at 32 MiB (`log_large`), so at most 64 MiB of
  transfer, 6.4 s, and two fsyncs per database (the checkpoint's own), at most
  38 databases (an imported-archive account with three families), 3.8 s. The
  wait for another connection is at most 2 s, once, as above.
- `quick_check` reads at most 64 MiB per database and 128 MiB per boot
  (12.8 s), and only if the estimate fits the 15 s check budget, decided
  before it starts. After the fold the logs are empty, so the opens of the
  checks and of the verify read no log.
- An account has at most 152 files to move (an imported-archive account with
  three families; 52 for any other source): a link, a folder fsync and an
  unlink each, 22.8 s if every metadata operation takes 50 ms, and about 12
  folders to fsync at the end, 0.6 s.

The worst account starts at 44.9 s, folds its logs in 10.2 s (55.1 s), spends
12.8 s on `quick_check` (67.9 s), renames (91.3 s), and verifies with a
handful of opens of empty logs: about 92 s, inside 180 s. A move put back costs
the renames again, 23.4 s more.

**What the move does not defend against.** Two things, on purpose, because they
need a program outside what Olympus controls or one that can already do worse:

- *A program that is not Olympus writing an Olympus store during the move.* Every
  Olympus writer is excluded by the owner lock the migrating worker holds through
  the whole pass: the worker holds it for its life, a command-line command takes
  it or asks the running worker to do the work (`core/cli-via-worker.ts`), and
  every operator script holds it for its run (`withDataOwnerLock`,
  `runUnderDataOwnerLock`). The store-open guard lists the one program that runs
  beside the engine, the release check's machine agent, and it opens read-only.
  A program that is not Olympus and writes an Olympus store at boot, for example
  an SQLite connection that commits into a new `-wal` after the pass has looked
  and stays open, is not excluded by anything: looking once more cannot close
  that window, and the fold, the second look and the check at the end make only
  the usual cases (a leftover process, a log left by a crash) safe.
- *A folder on the way swapped for a link in the instant between its check and
  the rename.* Every folder on the way is checked for being a link when the plan
  is made and again before each file, and each destination's identity is checked
  at the end. Swapping one in that instant takes a process that can already write
  and remove everything the move touches, so it gains no access it did not have.

**What stays put.** Settings stay in the shared config files (see Layout). The
X usage ledger stays shared; only X's reconcile state moves. Legacy pre-1.0
index files (`email-index.sqlite`, `dropbox-files-index.sqlite`,
`google-drive-docs-index.sqlite`, `telegram-messages-index.sqlite`,
`readwise-index.sqlite`; only in `data-lifecycle.ts` today) are left alone and
removed by Delete all (owner decision 5). `runDataMigrations` (never called)
is deleted.

**An older build.** After 4c, a build that knows schemas 1 and 2 (4a, 4b)
refuses a schema-3 file, so it opens nothing while a move is pending, and
reads a finished account as a folder like any other (a test reads the file
with the 4b reader). A step-3 build refuses schema 2 and 3 alike, as designed.
A build from before the registry (step 2) does not read it; that it would make
empty stores at the old places has not been tried.

A store bound to a tiered set finds the set ledger by its identity, so the
move rewrites nothing inside a store. The binding row keeps the ledger's id
and the absolute path it had when the store was bound; the id is what binds
and the path is a hint. The store takes the first of these whose id matches
and refuses the store, as before, when none does: the recorded path; the set
ledger the layout keeps beside the account folder's `secure_local` store
(`stores/secure_local.tier-ledger.sqlite`), where the renamed ledger now sits;
and the recorded file name beside the store, for a set moved as a whole
(`classification/tier-set-binding.ts`). Rows written before this change keep
working before, during and after a move. The migration therefore renames the
stores and the ledger and opens no store to repoint a row, which would write
to a store that may be busy or damaged. A candidate's id is read through a
read-only connection, which never changes the ledger's main file or checkpoints
its `-wal` (SQLite may add an `-shm` or an empty `-wal` beside it); where macOS
refuses that for a ledger with no `-wal`, it is read through a query-only
connection, and only when no `-wal` holds frames. Because the file can be
replaced between that read and the open, the handle a store keeps is checked
against the bound id again, and a different id is refused. `olympus tier set`
and `explain` stop, rather than fall back to the recorded path or the store's
own ledger, when a bound store's ledger cannot be found.

No re-embed and no rescan: stores, cursors (`sync_runs.cursor`), tiers,
embeddings and watch snapshots move as files. Embedding changes stay
owner-gated and this plan makes none.

The pass is behind `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=1` in the worker's
environment. With it off, no move starts and the registry and every file are
byte-identical to 4b's.

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
4. **Account folders.** Four PRs, each with focused proof:
   - **4a, resolution through the registry (done).** Fresh accounts of
     Gmail, Drive, Dropbox, local files, Readwise, X and imported archives
     land in `sources/<source_id>/<slot>/` (placement above); every other
     account, and every account with legacy files, stays `legacy`. Per-kind
     resolvers in `olympus-layout.ts` (`accountFolder`, `accountStorePath`,
     `accountRawPath`) and the placement predicate in `source-placement.ts`; the
     connectors' `default*DbPath` functions are thin wrappers over them
     (step 6 deletes the wrappers). The registry schema becomes 2 with the first
     folder entry. Delete takes the whole folder, Delete all keeps
     `data-owner.lock`, Export names `raw/` and `session/` and never copies
     them. No existing file moves. Delete refuses, with nothing removed, when
     anything it would remove under `sources/` is reached through a link, and
     when another source's resolved path (a retained `OLYMPUS_*_DB_PATH`
     override, say) lies inside the folder it would take.
   - **4b, capture paths (done).** A newly paired Telegram or WhatsApp account
     keeps all its files in `sources/<source_id>/1/`; every existing messaging
     account keeps exactly its legacy paths. In the folder, the stores are
     `stores/<tier>.sqlite`, Telegram's session is `session/telegram.session`
     (and its `-journal`), its gateway state is `raw/telegram-gateway/` and its
     spool `raw/telegram-spool/`; WhatsApp's whole bridge state (`session.db`,
     `spool/`, `media/`, the QR files) is `raw/whatsapp/`, so the Go bridge
     needed no change. The placement predicate is 4a's plus three pins: the
     native capture owner flag (`OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER`,
     `OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER`), any capture path override
     (the plugin-config capture paths reach the services as the same
     `OLYMPUS_*` names), and the account's capture grant when it names a
     session path (a legacy account's) or cannot be read; only a grant
     confirmed absent, or one with no path, pins nothing. Pairing runs in the
     CLI minutes before it saves a grant, and never decides while a worker
     owns the data, since its environment is not the worker's. An account with
     an entry follows it; one with none is decided by the CLI under the owner
     lock when that is free, else by the running worker over its local API
     (`pairing-placement`, `core/pairing-placement.ts`), which records the entry
     from its own environment before the CLI picks a session path. A worker
     that is starting or does not answer makes the pairing refuse, to be
     retried. A `legacy` outcome is claimed at once by making the legacy capture
     folder (the placement decision reads it as files already there) and reading
     the registry again under its lease, so a boot re-placement that ran in
     between is followed and one that runs later leaves the account legacy: the
     pairing and re-placement cannot disagree. No child reads the registry. Whoever starts a child computes its paths and
     passes them: the worker's supervisor sets `OLYMPUS_TELEGRAM_SESSION_PATH`,
     `OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR`, `OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR`
     and `OLYMPUS_WHATSAPP_STATE_DIR` last, after the grant's own environment;
     the Gateway-run native services read the registry read-only once the
     worker owns the data root, from the same environment the Gateway launches
     the worker with (`nativeWorkerEnvironment`), and refuse a plugin-config
     path that contradicts a folder account. A capture grant stores no paths for a
     folder account; a legacy grant keeps its stored `sessionPath`, and an
     account with a grant path but no entry is a legacy account. Unpair and
     Delete accept the real data root next to the legacy roots, and stay strict
     about everything else (absolute, no link, inside a root they know). WhatsApp
     media is read only from the account's `raw/whatsapp/media` (a folder) or
     the legacy audio directory. Delete refuses another source's delete, with
     nothing removed, when a capture grant exists but cannot be read, since
     then it cannot be shown that the session is outside what the delete
     removes. At worker boot, under the owner lock and
     before anything mounts, an `active` `legacy` entry of a folder-layout
     source that lists no corpus (no store was ever opened for it) is
     re-placed to `folder` when the 4a predicate says so again, checked a
     second time under the registry lease. The predicate refuses while any file
     of the account exists at a legacy location, and while an override, a
     mount, native ownership or a capture grant (one that names a session path
     or cannot be read) pins it; "lists no corpus" covers a store that an override once placed
     elsewhere, because a store's path is not recorded. So the re-placement
     cannot hide an account's files. An entry that lists a corpus, an empty
     store opened by a 4a worker on a fresh install among them, stays legacy
     until 4d. No existing file moves; the Go bridge's own session lock moves
     to 4d.
   - **4c, the boot migration of existing non-messaging accounts**, behind
     `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=1` in the worker environment (off by
     default), with the tests in "What must not break". Built on two changes
     that came first, so that moving a store is only renaming files: media-cache
     holds name a store by its identity (not its path), and a tiered set's
     stores find their ledger by the ledger's id. Built: the pass in "Migration
     of existing installs" (fold the logs, plan, rename, verify, flip), the
     `migration` record and schema 3 in the registry, and the four Needs you
     rows. Proof: a kill injected between every pair of steps, each followed by
     a finish and by a put back, with the bytes of every store, ledger and
     sidecar after the fold compared with the bytes after the move; each skip
     reason (including a busy log and a file system with no hard links), a
     failed verify moved back, a lost file, a file another process creates at
     a destination, a media-cache sweep at every step, Delete mid-move and the
     unreadable registry, on isolated homes, plus a real worker booted on a
     legacy home with the switch off and on (and, on Linux, through a real
     install receipt). Retirement: default
     on, then delete the switch, once release testing records, on Mac
     OpenClaw-hosted, Mac engine and standalone Linux with both receipt
     roots: every source migrated with real data; paired WhatsApp and
     Telegram on Mac and Linux; one store over 1 GB migrated within the
     startup timeout; one injected verify failure moved back with its Needs
     you row; one crash mid-move resumed; the downgrade behavior. The owner
     signs this off here.
   - **4d, the messaging migration**, including the Go bridge's session
     lock, which 4b leaves as it is.
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
   serve development, not users). The data-root control that exists is the
   Linux receipt and `XDG_DATA_HOME`; no `OLYMPUS_DATA_DIR` was ever added.
4. **Removal applies when the worker restarts**, before anything opens the
   account, not live. A live in-process removal can come later once the
   scheduler can cancel a running task per source
   (`source-scheduler.ts:516-522` has no cancel today).
5. **Leave pre-1.0 index files** for Delete all to remove, rather than
   deleting them during migration.

## Out of scope

Moving the roots themselves (for example to `~/Library/Application
Support` on macOS), multi-account UI, and changing what is stored.
