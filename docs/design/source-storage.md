# Source storage

Status: approved by the owner 2026-10-24 (decisions 1–5 below); every
delivery step is built (steps 1–3, 4a–4e, 5 and 6; step 6 2026-10-26). What
could not be proven on this Linux host is listed under step 6's "Residual
risk". Replaces the storage half of the Delete work in #455/#467 (#467
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
                                 (made by the first file written, never at start)
    session/                     Telegram's pairing session (telegram.session and its -journal,
                                 and the pairing lock telegram.pairing.lock.db);
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
  themselves with a throwaway HOME. The per-store `OLYMPUS_*_DB_PATH`
  overrides are gone, and a `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON` entry
  for a source with a folder layout names no path (step 6, owner decision 3):
  nothing relocates a store but the data root. What still relocates a `legacy`
  messaging account's files are its capture paths (the env a spawner hands a
  capture child, and the Gateway-run services' plugin-config paths), which
  pin the account to `legacy`; a `folder` account never honors one.
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
  (4b); an existing messaging account moves into its folder in step 4d
  ("Messaging accounts" under Migration).
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

- `state` is `active` or `deleting`. Once a Delete has removed an account's
  files and rows its entry is dropped (step 5), so a reconnect starts a new
  entry, placed afresh, with a new `created_at`. `deleted` stays a valid value
  for readers (the media-cache sweep reads it as gone) but nothing writes it.
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
  layout, nothing pins it (for messaging: a capture path env, native capture
  ownership, a capture grant that names a session path), no file of
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

### One account, live and imported

Archive imports and live connectors keep one dataset per account
([archive-live-one-dataset.md](archive-live-one-dataset.md), #524). An archive
of a source that has a live connector is one more input to that source's
connector. Its items land in the account's own stores, corpus ids and tier
ledger, and they converge with the live items rather than sit beside them.
Storage's part (step 4e):

- **Imports for a live source get no stores of their own.** `archive.imports`
  stays the storage source for archive-only formats (Reflect, Roam, Evernote:
  each shown as a source of its own on the dashboard since step 7 of
  archive-live-one-dataset.md, its imports still stored here), for mail
  that matches no Gmail account, and for an archive of another account than the
  connected one. Its `<family>.<tier>` stores, account scopes and per-import
  Remove are unchanged. Archive import never shipped in a release, so nothing
  existing is folded in. Reading `<tier>.archive.<family>` corpora for formats
  that feed a live source ends once ingestion's per-source steps land.
- **An entry names its provider account.** `provider_account_hash` holds the
  id `provider-account-identity.ts` defines, the same one the account binding
  holds: labels joined with `.`, Google's and Telegram's as digests, so no
  address is written to the registry (Dropbox's and X's are their own account
  ids). Whoever first establishes the account writes it
  (`recordProviderAccount`):
  - the worker, once a live source's sync is let through on an account it binds
    in `source-account-bindings.json` (which keeps its own role of stopping a
    sync on a different account);
  - a Telegram pairing, `telegram:<account_ref>` from the pairing proof,
    decided by the worker (`pairing-account`) or under the owner lock, as the
    placement is;
  - an import that carries the id.

  The first value stays. A later one may only add labels
  (`mergeProviderAccountIds`). Delete forgets it, as it forgets the binding;
  Delete-all forgets every entry's, in the registry found before anything was
  removed.
  WhatsApp has no account id, live or archived. An entry from before this step
  names none until its next sync or pairing.
- **An import finds its account through the storage service**
  (`resolveImportAccount`), under the registry lease, by
  `compareProviderAccounts` against the source's entry:
  - `same`: that account;
  - no entry for the source: a new `folder` entry, with the import's id or
    none, which a later connect or pairing joins;
  - `unproven` (one side has no id, or only labels that cannot decide) when the
    source has one account: that account, once the owner confirms in the
    import sheet;
  - `different`: not this account; the import stays under `archive.imports` (a
    second slot once slots exist).
  - An import known by an address alone (an mbox's delivered-to address) is
    never proof: the export's author wrote it, and an address can change
    hands. It is `unproven` against an entry that carries the same address
    or none, so the owner confirms, and `different` against an entry that
    carries another address (step 6 of the archive design).
- **Connect and pairing check the entry.** A different account over a history
  that names its account is refused until the owner deletes that history:
  - A file source's account guard reads the entry's account as the binding's
    when the binding names none (an imported history). A connect of another
    account then holds the sync as any account change does (`purge_required`,
    and the guard's message: reconnect the previous account, or Disconnect,
    delete and connect again). Nothing is deleted on its own.
  - A sync runs only once the entry and the binding name one account. A binding
    moved to another account over stores that hold nothing (which the guard
    allows) moves the entry with it; one that disagrees with an entry over
    stored items is refused the same way. A connect that follows a binding
    known by its Google address alone through a rename the replaced grant's
    own token proves (`followFileSourceRename`) moves an entry known by that
    address with it (`followProviderAccountRename`).
  - An import into an account-bound source (Dropbox, Drive, Gmail, X) resolves
    its account and writes inside the source's exclusive runner
    (`runExclusiveForSource`), so the guard cannot bind another account between
    the two.
  - A Telegram pairing checks the account it proved before anything is
    registered or any credential stored, and refuses with "delete that history
    first". Over a history that names its account, the pairing signs in on a
    copy of its own (`<session>.pairing-<pid>-<tag>`, made from any login
    already there with SQLite `VACUUM INTO`), so another account's login is
    never where capture reads it and the login already there is left exactly
    as it was. The copy becomes the login only once it proves the account: by
    name when there is none, and otherwise by writing its tables into the
    login in one SQLite transaction, never by replacing the file, so a capture
    reader holding it open keeps a consistent database. A pairing that fails
    removes its copy; a copy a killed pairing left is removed by the next
    pairing and by Unpair (beside the registered path and the derived one).
  - One Telegram pairing runs at a time on a login: a kernel lock beside it
    (`<session>.pairing.lock.db`, empty, dropped when its holder dies) refuses
    a second with "Another Telegram pairing is running".
  - `connect telegram --session-path` cannot prove an account, so over a
    history that names one it is refused the same way.

  4b's "an account with an entry follows it" compares the id, not only the
  source.

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
check takes effect from step 5: a Delete drops the entry and a reconnect makes
a new one with a later `created_at`, so a hold of the deleted account is told
apart from the new one's, and a hold a Delete left (it stopped after removing
the files and before releasing them) is dropped by the sweep once the entry is
gone. No separate incarnation token was added: `created_at` compared as
earlier-than leaks a hold, never drops one, if the clock moved backwards
between the two entries.

A per-source Delete runs the steps (`forgotten` in its result lists each file
and count; a dry run lists what it would forget) after the account's state is
reset and before any bytes are removed. A failing step fails the delete there.
Disconnect runs none. The boot that removes a marked account repeats the
steps marked `repeatBeforeRestart` (`waiting-private-questions`,
`source-dashboard`, `source-watches`), because until the restart a private
question can be answered, a dashboard poll can record counts and the watch
pass can queue matches, all through store handles still open. No owner-choice
step is repeated: the owner can reconnect in that window, and a repeat would
erase the reconnect.

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

History imported into a live source is that account's history: an account's
Delete takes it, and it is never removed on its own (owner decision 6).
Imports under `archive.imports` keep their own Remove, by their account scope.

**As built (step 5, #541).** The account comes from the registry, and what
it owns from `core/account-files.ts`: its folder when it lives in one, else
the files the layout module's resolvers name for it (`accountStorePath`,
`accountRawPath`, the pairing module's session paths), which are the paths its
connector uses. `data-lifecycle.ts` names no source
(`test/delete-on-registry.test.ts`). Source-specific behavior that is not a
path became a registered step: X's sync positions in the shared usage ledger
are the forget step `x-bookmarks-sync-state`, and imported archives' approvals
are a delete hold (`core/source-delete-holds.ts`).

- The running worker's Delete (the dashboard's, and the CLI's while Olympus
  runs) checks custody, refuses before anything changes if any target is
  unsafe, runs every forget step, marks the account `deleting` (creating the
  entry, at the layout its files are in, for an account never adopted) and
  restarts. From the mark, the storage service opens none of its files.
- At boot, holding the owner lock and before the empty-account re-placement,
  the migration and anything else (`deleteMarkedAccountsAtBoot` in
  `email-source/server.ts`), each `deleting` account is checked again,
  the forget steps marked `repeatBeforeRestart` run again (the others ran
  at the mark; repeating them could erase a reconnect made since), its folder
  is renamed into `.trash/<uuid>` and emptied in the background, a legacy
  account's files are removed in place (they may be on several volumes, so a
  rename cannot take them at once; each removal is idempotent), its picture
  holds are released and its entry is dropped. A failure leaves the entry
  `deleting` and the account closed; the next boot retries.
- The CLI with no worker running holds the owner lock and has nothing open,
  so it marks and removes in one run; a run that stops part way leaves the
  mark, which the next boot finishes. With an unreadable registry it removes
  the files without a mark; the running worker refuses instead, since it
  could not keep the account closed.
- Delete all also removes the registry and `.trash/` when the data folder is
  outside every known root.

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
  As built (step 5, #541): an export takes every account the registry lists
  as `active`, and every source with files on disk but no entry yet; an
  account being deleted is left out. The manifest stays version 2 and adds
  `accounts` (`source_id`, `slot`, `layout`), which the verifier ignores.
- **Uninstall** (`site/uninstall.sh`, `site/uninstall-linux.sh --purge`)
  removes the roots from the layout module's list instead of a hand-kept
  one. Today macOS uninstall does not mention `~/.local/share/olympus`,
  `~/.local/state/olympus` or `~/.cache/olympus`, and a Linux purge leaves
  `~/.local/state/olympus/telegram-*`; after migration those paths are
  either inside a root or gone.
  As built (step 5, #541): `olympusUninstallRoots` in the layout module is
  the list. The scripts run no Olympus code, so each spells it, and
  `test/uninstall-roots.test.ts` holds both to it. The macOS uninstaller now
  names every folder it keeps (the three above, Telegram's legacy store root
  and the home spellings beside the XDG ones). The Linux purge removes the
  install's own folders, which its receipt proves it made, and still nothing
  else: the legacy capture root and the Telegram reader's state in
  `<state home>/olympus` may belong to an OpenClaw-hosted install on the same
  account, so a legacy messaging account's files there are left until its
  migration (4d) moves them into the data folder. A folder account's are in
  the data folder already.

## Migration of existing installs

One-time, at worker boot, holding the owner lock, after the re-placement of
empty accounts and before adoption is enabled and anything mounts
(`migrateAccountFolders` in `core/source-account-migration.ts`, called from the
worker's `main()`). Step 4c built it for every folder-layout source but
Telegram and WhatsApp; step 4d moves those two the same way, with what
"Messaging accounts" below adds. For each
account whose `layout` is `legacy` (the entries step 2 adopted, plus an entry
created now, slot `1`, for any source with legacy files and none yet), in this
order:

1. **Look.** Read the legacy locations through the layout module's legacy
   resolvers (`legacyAccountFiles`, used for this purpose only). The account
   stays legacy, and the registry records why (`migration.state: skipped`, a
   reason code and plain words), when:
   - `pinned`: a capture path env, native capture ownership or a capture grant
     names a messaging account's files (before step 6 also a per-store
     override or a connector-store mount);
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

**Messaging accounts (step 4d).** A Telegram or WhatsApp account goes through
the same look, fold, plan, rename, verify and flip, with these additions
(`core/source-account-migration.ts`, `core/messaging-account-move.ts`):

- *What moves where.* From the default legacy places only (an override pins):
  Telegram's stores (`legacyTelegramStoreRoot`, which ignores
  `XDG_DATA_HOME`) to `stores/<tier>.sqlite`; its login
  `<capture>/telegram/telegram.personal.session` (and `-journal`) to
  `session/telegram.session`; the pairing lease beside it
  (`telegram.personal.pairing.lock.db`) to `session/telegram.pairing.lock.db`;
  any login a killed pairing left aside (`telegram.personal.pairing-<pid>-<tag>.session`)
  to `session/telegram.pairing-<pid>-<tag>.session`, where Unpair and the next
  pairing look for it; the gateway state `<state>/telegram-capture-gateway/`
  to `raw/telegram-gateway/`; the spool `<capture>/telegram-capture/spool/` to
  `raw/telegram-spool/`; and an earlier drain's `<state>/telegram-spool-drain/`
  (read by nothing now) to `raw/telegram-spool-drain/`, so a Delete of the
  folder takes it. WhatsApp's two stores leave `<capture>/whatsapp-live/` for
  `stores/` first, then that folder is renamed whole to `raw/whatsapp/`
  (`session.db` and its logs, `spool/`, `media/`, the QR files), as 4b lays a
  folder account out. `<capture>` is `<XDG data home>/olympus` and `<state>`
  `<XDG state home>/olympus`; folders the move emptied (`telegram/`,
  `telegram-capture/`) are removed after the flip, and at each later boot if a
  boot stopped in between. The session database inside the WhatsApp folder is
  not folded: it moves with its logs in the one folder rename.
- *Paths outside the data folder in the plan.* The capture and state roots
  (and Telegram's store folder, when `XDG_DATA_HOME` moves the data root away
  from it) are outside the data root on macOS and OpenClaw-hosted installs.
  The plan names a path there as `@capture/...`, `@state/...` or
  `@telegram-stores/...`, relative to that root (`migrationPathRoots` in
  `olympus-layout.ts`), so the registry still names no home folder; the
  link checks, the folder fsyncs and the device check work from the root that
  holds each path. A 4c build reads such a plan (it is valid schema 3) and
  reports it stuck, touching nothing, as it does any plan for a source it does
  not move. On a standalone Linux install the capture root is the data root.
- *A running capture keeps the account where it is (`busy`).* The pass takes,
  and holds until the account's pass ends, the lock each capture helper holds
  while it runs, at both places its state folder can be: the Telegram reader's
  `gateway.lock` (it takes it itself, `gateway_process_lock` in
  `scripts/telegram-telethon-reader.py`) and the WhatsApp bridge's
  `bridge.lock` (below). A lock another process holds leaves the account where
  it is this boot; a helper that starts meanwhile finds the lock taken and
  exits, to be started again later. A Telegram pairing that is running holds
  its lease, which the pass opens like any database: busy too. A plan left part
  way waits the same way for a boot at which no helper runs.
- *The bridge's session lock (decided here).* The Go bridge has no lock of its
  own, so two bridges could run on one session and nothing showed the pass that
  one was running. Whoever starts a bridge now takes a `flock` on `bridge.lock`
  in its state folder and hands the bridge that descriptor (the worker's
  capture supervisor, and pairing for `--pair-only`), closing its own copy: the
  bridge holds the lock for its whole life, after its spawner is gone too, and
  the kernel drops it when the bridge exits. A second bridge on the session is
  not started (capture reports `helper_running`, pairing refuses). Chosen over a
  lock taken in the Go program, which would change the bridge's source: the
  worker runs the bridge build named by the source's fingerprint and does not
  build it, so every install would lose WhatsApp capture until it paired again.
  The lock is not behind the switch: it only stops a second bridge on one
  session, which never worked. Residual: a bridge a pre-4d worker started and
  left running when it was killed holds no lock, so it is not seen; nor does
  the Gateway-run WhatsApp service's bridge take it (an account that service
  owns is never moved).
- *Records outside the data folder.* Every legacy pairing wrote the session's
  absolute path into the capture grant (`sessionPath`, and
  `OLYMPUS_TELEGRAM_SESSION_PATH` / `OLYMPUS_WHATSAPP_STATE_DIR` in its
  producer env) and into the secret store (`<source>.<role>.session_path`, which
  Unpair treats as the authority). Before the pass (switch on) the worker reads them: a
  grant or stored path that names anything but the default legacy session, a
  grant that starts capture with another path override, or an Unpair that did
  not finish (its record names the files) is `pinned`; one that cannot be read is
  `unreadable`. A grant that names the default session does not pin here (it
  still pins an account with no entry from a folder, as in 4b). After the pass,
  at every boot, each record of an account a move finished that still names its
  old place is rewritten to what a folder pairing writes: the grant without its
  paths, a stored session path as the folder's (`session/telegram`,
  `raw/whatsapp`). The records sit in the config folder, so they are not in the
  plan: the flip is the commit and the rewrite follows it; until it runs, the
  capture child is given the folder's paths last (4b) and nothing reads the old
  ones for a folder account, and Unpair reads a stored path that still names
  the old place as the folder's (`movedSessionValue`), so a rewrite that could
  not be made (a secret store that would not answer at boot) never leaves the
  login behind an Unpair that says it is done. The rewrite changes the grant,
  so its child starts once more.
- *A pairing the move overtakes.* A pairing settles the account's layout, then
  takes its session's lock (the Telegram lease, the bridge's lock); a boot can
  move the account in between. So, holding the lock, and again once its helper
  is done and before it records anything, the pairing checks that the account is still where it
  settled it, with no plan pending, and otherwise stops with nothing paired and the login it made removed (a
  WhatsApp pairing gives back the state folder it had just made).
- *Paths in data.* The bridge writes each saved file's absolute path into its
  spool lines (`media_path`) and the store keeps it as the item's locator. They
  are not rewritten (the move writes nothing but file names): for an account
  whose move is done, a path under the old state folder is read as the same
  path under `raw/whatsapp/` (`whatsappMovedPathMapper`), by the Secrets
  redaction of the spool (so a Secret line's audio is still found and deleted)
  and by media extraction. A citation that shows an old item's locator still
  names the old place.
- *Second WhatsApp state folder.* The Gateway service's default and the cron
  sync's ignore `XDG_DATA_HOME`; when one of them is not the folder that would
  move and holds anything, the account stays where it is (`files_elsewhere`).
- *Nothing starts on an account part way.* While a plan is pending, the
  worker's capture supervisor starts no helper (`account_moving`), a pairing
  refuses, and the Gateway-run services refuse to start.
- *An empty claim folder.* A pairing that settled on the legacy paths claims
  them by making the legacy capture folder (4b); one that failed before its
  helper wrote anything left that folder, and it kept the account `legacy` for
  good. At boot, before the re-placement and whatever the switch says, such a
  folder is removed when the entry is `active`, `legacy`, lists no corpus and has
  no plan, nothing pins the account, the folder holds only the pairing lease's
  or the bridge's lock files, no pairing holds them, and it has not changed for
  an hour (`reclaimEmptyCaptureClaims` in `core/source-storage.ts`); the
  re-placement then decides as if no pairing had happened.
- *What stays legacy.* An account whose capture the Gateway owns, or whose
  paths an override, a plugin-config setting, a grant, a stored session path or
  an unfinished Unpair pins (see Layout, "Gateway-run capture stays legacy").

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
     connectors' `default*DbPath` functions were thin wrappers over them
     (step 6 deleted the wrappers). The registry schema becomes 2 with the first
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
   - **4c, the boot migration of existing non-messaging accounts (done,
     #508)**, behind
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
   - **4d, the messaging migration (done, #542)**, including the Go bridge's
     session lock, which 4b leaves as it is. An archive-only Telegram or WhatsApp
     account (history, no session) is a `folder` account from the start. Built:
     "Messaging accounts (step 4d)" under Migration, behind the same switch: the
     two sources in the pass (plan paths outside the data root tagged by
     root), the capture helpers' locks held through it, the bridge's session
     lock handed to it by its spawner, the grant and stored session paths
     weighed before and rewritten after, media paths read at their new place,
     no capture or pairing on an account part way, and empty claim folders of a
     failed pairing taken back. Proof: `test/source-account-migration-messaging.test.ts`
     on isolated homes (default, relocated XDG and standalone Linux roots; each
     skip reason, a live reader, pairing and bridge; a kill at each step resumed
     and a failed check put back). Paired devices on Mac and Linux are on 4c's
     retirement list.
   - **4e, account identity** (done, #530), before archive ingestion's
     Telegram and mail steps (#524). The registry's `provider_account_hash` is
     written by connect (from the account binding) and by Telegram pairing. The
     storage service resolves an import's account as "One account, live and
     imported" says. Connect and pairing refuse an entry that holds a different
     account. Proof:
     an import joins its live account, creates one when there is none and is
     joined by the next connect, waits for the owner when unproven, and stays
     under `archive.imports` when different. A pairing onto another account's
     history is refused, and so is a session given by its path.
5. **Delete, export, uninstall on the registry (done, #541).** Replace
   `lifecycleSourceSpecs` with the registry: a per-source delete marks the
   account `deleting` and the boot pass removes it; export and uninstall
   read the registry and the layout module. Built as "Delete" and "Export and
   uninstall" say. Not proven on this step's Linux host: the macOS
   uninstaller's run on a Mac (its list is checked by expanding it under
   `/bin/sh`), and a Delete through the OpenClaw-hosted Gateway's worker
   restart.
6. **Connectors stop naming paths (done, 2026-10-26).** Built:
   - **The layout module names every data file.** The generic composer
     (`olympusDataPath`) is private to `src/core/olympus-layout.ts`. A shared
     file is asked for by what it is (`SHARED_DATA_FILES`, `sharedDataPath`:
     the registry, the owner lock, the dashboard, scheduler, watch, job and
     remote-connection databases, the ledgers, request budgets, models); an
     account's files by account (`accountStorePath`, `accountRawPath`,
     `accountTrashEntry`, `accountFolderEntry`); the loose legacy files that
     only Delete still needs (pre-1.0 indexes, the Reflect and Roam mount
     defaults, the Telegram drain cursor, the WhatsApp live-sync script's
     paths) are named there too.
   - **The wrappers and the overrides are gone.** The connectors'
     `default*DbPath` and the X reconcile wrapper are deleted; callers ask
     `resolvedStorePath(sourceId, tier)` / `resolvedRawPath` (the storage
     service's placement, `core/source-placement.ts`). Every per-store
     `OLYMPUS_*_DB_PATH` is gone, and with them
     `OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH`,
     `OLYMPUS_SOURCE_INDEX_X_RECONCILE_STATE_DB_PATH`,
     `OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH`, `OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH`,
     `OLYMPUS_REMOTE_CONNECTIONS_DB_PATH`, the embedding drain's
     `OLYMPUS_SOURCE_EMBEDDING_DRAIN_*_DB_PATH` and the pre-1.0 index
     overrides. None of them pins an account any more.
   - **Mounts.** A connector-store mount of a source with a folder layout
     names no path: its `dbPath` is ignored, it only adds a principal to the
     store the source's lane opened, and it is skipped, and reported, when
     that lane is not open. The ingestion ledger skips such entries and lists
     every account's stores from the corpus roster (`placedRosterStores`), the
     Gmail and Drive public stores included. Reflect and Roam keep their JSON
     mounts and their paths, and Gateway-run messaging capture stays legacy
     (both as "Layout" says).
   - **A new source declares only its tiers** (`FOLDER_ONLY_STORES`): it has
     no legacy layout, so every account of it is a `folder` account, even with
     an unreadable registry or data folder, and the boot migration has
     nothing of it to move (`test/folder-only-source.test.ts`).
     `docs/CREATE_CONNECTOR.md` Leg 3 and the connector template say so; the
     playbook's "seven grandfathered indexes" became the one the guard allows.
   - **Guard** (`test/data-path-guard.test.ts`): no `src/` module outside the
     layout module (and the Linux install receipt reader it takes the
     standalone data root from) extends a data root with `join`/`resolve` or
     a template string, spells a file name the layout owns, or spells the data
     root; and no `OLYMPUS_*_DB_PATH` or the archive state override is read
     anywhere in `src/`. A file a capture child or a store keeps inside a
     folder the layout hands out (the bridge's `session.db` in its state
     folder, a store's tier sidecars beside it) is named by that folder's
     owner, as before; the layout names the folder.

   **Upgrading an install that set one.** The repository's installers set
   none of these (they served development, owner decision 3), but a host
   configured by hand may (a systemd drop-in, a mount list). Reading the
   default place instead would open an empty store beside the account's real
   files, so the worker refuses to start while its environment sets any
   `OLYMPUS_*_DB_PATH` or the archive record's path, or mounts a placed
   source's store anywhere but where Olympus keeps it, and names each one
   (`retiredPathSettings`, `core/source-placement.ts`). The fix is to move the
   file to where Olympus keeps it (the message names that place for a mount;
   an env setting's file goes back to its usual name in the data folder, or
   in the WhatsApp state folder for WhatsApp's stores), or to drop the setting
   if it already named that place, and start again; the boot migration then moves it into the account
   folder like any other.

   **Residual risk (what this Linux host could not prove).** Delete on a Mac
   (OpenClaw-hosted and engine) and through the OpenClaw-hosted Gateway's
   worker restart, the macOS uninstaller's run, paired Telegram and WhatsApp
   devices on a Mac, and the Gateway-run native capture services reading the
   registry: each is covered by tests on isolated homes, not by a run on that
   platform. 4c's retirement list (below) still names the release-testing
   runs the owner signs off.

Done when: no `src/` module outside the layout module builds a data path;
no store is opened outside the storage service; `data-lifecycle.ts` names no
source; deleting a source removes exactly its folder plus its shared rows,
proven on Mac, standalone Linux and OpenClaw-hosted.

**Status (2026-10-26): built.** The first three hold mechanically
(`test/data-path-guard.test.ts`, `test/store-open-guard.test.ts`,
`test/delete-on-registry.test.ts`). The fourth is proven on standalone Linux
and on isolated homes in tests for each layout; the Mac and OpenClaw-hosted
runs are the residual risk under step 6.

## Owner decisions

Decisions 1 to 5 approved by the owner on 2026-10-24, and 6 on 2026-10-25.

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
6. **Imported history joins the account.** An import merged into a live
   source becomes part of that account's history. It is deleted only with the
   account's data, never on its own. Imports kept under `archive.imports`
   keep their own Remove.

## Out of scope

Moving the roots themselves (for example to `~/Library/Application
Support` on macOS), multi-account UI, and changing what is stored.
