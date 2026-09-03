# Olympus 0.4 Slice 0 baseline evidence

This is evidence for Slice 0 of [`V0_4_RELEASE.md`](V0_4_RELEASE.md), not a
second plan. It records what was found at baseline commit `32f0cefa`, what can
be proved without private-data access, and the content-free receipts from the
approved private preservation and evaluation run.

## Baseline verdict

The intended shared spine is real, but Olympus still ships three intertwined
systems:

```text
OpenClaw plugin product
├── shared seven-source spine plus dashboard
├── legacy indexes, replay, authority switches, and cutover machinery
└── owner/private-host deployment, credentials, incident, model, host operations
```

Six sources still default to legacy reads. The release artifact recursively
ships unrelated skills and compiles adjacent/private capabilities into
`dist`. The existing data export safely snapshots ordinary SQLite WAL state,
but before this slice it neither bound snapshots with hashes nor named all
Telegram capture/session state, and it cannot copy the raw capture/session
state that must be preserved separately.

The detailed source truth is in [`SOURCE_CAPABILITIES.md`](SOURCE_CAPABILITIES.md).

## Repository and worktree inventory

| Checkout or branch | Finding | Disposition |
|---|---|---|
| `main` | Baseline `32f0cefa`; untracked `.claude/perf/` belongs to another/user session | Preserve untouched |
| `codex/v0-4-slice-0` | Isolated integration worktree for this slice | Integration owner only |
| `codex/v0-4-plan-reset` | Clean, merged, no unique commit | Worktree removed 2026-08-26; branch retained |
| `wo/dashboard-readiness-input` | Clean, no unique commit | Worktree removed 2026-08-26; branch retained |
| detached `integration-go-train` | Clean, merged, no unique commit | Worktree removed 2026-08-26 |
| `claude/verify-lane-split` | Clean, merged, no unique commit | Worktree removed 2026-08-26; branch retained |
| `.claude` agent worktree at `29f83d7` | No unique commit; contains untracked `logs-denominator/` | Preserve until its owner disposes it |
| detached `e3bff6a` | Unique private-ops preflight hardening | Preserve and review for private ops; do not merge wholesale |
| detached `b0b611b` | Unique removal of a dead private deployment flag | Preserve and review for private ops; do not merge wholesale |
| `codex/finish-source-migration` at `d99ae1d` | One unique 55-file deletion sweep, roughly 59,779 removed lines; does not typecheck and contradicts converge-first preservation | Use only as deletion inventory; never merge wholesale |

The repository audit also found unmerged historical local/remote branches.
Those are not v0.4 inputs merely because they are unmerged; only a unique
commit with a named product or private-ops disposition is retained.

| Unmerged ref | Unique work | Disposition |
|---|---|---|
| `claude/brave-chandrasekhar-28c0f3` | One private runtime preflight fix (`e3bff6a`) | Copy/review in private ops |
| `claude/festive-lalande-1c558f` | Two genuine dashboard-truth fixes (`ed2e5081`, `ed91d602`) | Selectively port in the dashboard slice before pruning; do not merge the stale branch |
| `claude/modest-hodgkin-62a4f4` | Private/migration read-authority and acquisition-policy change (`d377fb8`) | Historical/private-ops evidence; conflicts with current v0.4 rulings |
| `claude/zen-benz-a55595` | One private deployment cleanup (`b0b611b`) | Copy/review in private ops |
| `dropbox-evidence-pack-wip` | Pre-contract Dropbox-specific answer/facts implementation (`d207c4c`) | Historical quarantine; the shared Analyst supersedes it |
| `origin/hire-broker` | Fourteen commits for an explicitly non-v0.4 feature | Preserve outside the v0.4 product path |
| `origin/km/worklog` | Thirty-six PKM/doctrine commits | Preserve outside the v0.4 product path |
| `origin/store/v1` | Three marketplace/store commits | Preserve outside the v0.4 product path |
| `origin/wip/x-rollout-continuation-2026-07-18` | One large migration/cutover checkpoint (`79f48fe`) | Historical migration evidence only |

No unique ref in this table was deleted in Slice 0. The four zero-unique clean
worktrees were rechecked immediately before removal; their named branches
remain available.

## Runtime and installation dependencies

```text
OpenClaw >= 2026.5.2
├── native plugin: dist/index.js
└── Olympus worker/CLI: Bun >= 1.2 → dist/cli.js
    ├── shared store, scheduler, extraction, dashboard, and source_answer
    ├── source authentication and capture helpers
    └── currently bundled migration, MCP, and adjacent/private operations
```

Source-conditioned dependencies are not yet represented truthfully by setup:

| Capability | Dependency |
|---|---|
| Telegram | Python 3 and Telethon, plus the packaged reader/capture helper |
| WhatsApp | A reproducibly built Go/whatsmeow bridge |
| Dropbox/Drive documents | Selected text/Office/PDF extraction support |
| OCR/vision | `ocrmypdf`, Tesseract, and Poppler commands where enabled |
| Audio | A configured local transcription command |
| Secure local reasoning/embedding | Approved loopback OpenAI-compatible endpoints |

Current package blockers:

- `scripts/release-artifact.ts` omits the Telegram helpers and WhatsApp bridge
  required by two declared sources.
- It recursively packages every skill, including Castor Workspace, file
  delivery, Hire Broker, domain/PKM, and runtime-maintenance skills outside
  v0.4.
- `openclaw.plugin.json`, `src/native-plugin.ts`, `src/core/operations.ts`, and
  `src/cli.ts` expose non-v0.4 and private surfaces.
- the native bundle retains `Bun.Glob` in an OAuth/doctor path despite the
  documented Node-hosted plugin contract.
- setup calls source-specific prerequisites globally optional rather than
  required when that source/capability is selected.
- the release artifact still includes Castor topology and an owner-specific
  Dropbox policy, while its tests require unrelated PKM and private protocol
  files.

These are Slice 1–3 implementation inputs; Slice 0 records them so deletion or
packaging work cannot rely on stale prose.

## Preservation inventory

| Source | Canonical state | Legacy or capture state that must be accounted |
|---|---|---|
| Gmail | Internal and secure connector stores | `email-index.sqlite`; bounded legacy replay exists; no Gmail legacy embedding importer exists |
| Drive | Internal and secure connector stores | `google-drive-docs-index.sqlite`; bounded replay exists; no legacy embedding importer |
| Dropbox | Secure connector store | `dropbox-files-index.sqlite`; bounded replay and the only implemented exact-compatible embedding import |
| Telegram | Internal and protected connector stores | Legacy index, capture spool, spool cursor, gateway state, and Telethon session; replay/repair tools exist |
| WhatsApp | Secure connector store | Append-only capture spool, media, session database, QR state, and any bridge-offline gap; provider history cannot repair missed capture |
| X bookmarks | Internal connector store | Reconciliation state and preservation floor; old X legacy index has already been retired |
| Readwise | Internal connector store | `readwise-index.sqlite`; no legacy replay/import adapter exists |
| Reflect/Roam | Unsupported connector stores | Stores are privately archived; no original export file was found on the private host or by local filename search, so that absence remains explicit |

The v2 lifecycle manifest added in this slice records each exported artifact's
relative path, byte count, SHA-256, SQLite integrity result, foreign-key count,
expected store id, and observed schema version. `olympus data verify --input`
rechecks the artifact boundary, size, hash, and SQLite integrity. Declared
SQLite files now fail closed instead of being reported as successful opaque
byte copies. Telegram capture/session/control paths are named as manual
preservation requirements without silently widening `data delete`.

The generic export still deliberately excludes raw spools, media, and session
secrets. A complete private receipt therefore requires, for every artifact:

- a verified snapshot or an explicit protected manual-preservation receipt;
- source/corpus/trust/provider/account identity consistency;
- current schema and connector-store integrity;
- legacy-versus-canonical coverage accounting;
- exact embedding provider/model/backend/dimension/epoch compatibility, or an
  honest `reembed_required` disposition; and
- an isolated reopen/restore check before any source is removed.

Retain a canonical store when those gates pass. Import only an opaque proven
legacy-only identity set through a bounded idempotent adapter. Re-fetch only
proven missing/corrupt/provider-recoverable items. Reflect and Roam are
`archive_only`. No store or vector is discarded to simplify the cutover.

### Content-free preservation receipt

Receipt `v0.4-slice-0-20260826T160151Z` was created without stopping capture:

- 18 primary artifacts across the seven supported sources plus Reflect/Roam
  stores and sanitized policy, totaling 18,936,449,553 bytes; every SQLite
  snapshot passed integrity and foreign-key verification. Manifest SHA-256:
  `936b4ebd78208c37c1dc71391b5e9e31f0f77f0e42dc87fa8a9b648e8648868d`.
- 417 continuity artifacts totaling 3,814,558,687 bytes: Telegram and WhatsApp
  append-only spool high-water marks, sessions, media/transcripts, Telegram
  custody/archive inputs, and auxiliary scheduler, budget, reconciliation,
  dashboard, repair, and embedding-ledger state. Manifest SHA-256:
  `18b219e8488d0632443170e936afed67a0875ca57b087437308f55eea44da51c`.
- The published artifacts were independently reopened/rehashed after export.
  No live service was paused, no source or store was mutated, and no data was
  deleted.

## Private-ops boundary

Keep in Olympus: generic connection and local credential custody, worker
lifecycle, scheduler, connector store, extraction, dashboard, health, data
lifecycle, source-answer, and configurable same-host model interfaces.

Move to a private repository additively before deletion:

- `config/private-host-*`, `config/op-credential-broker.json`,
  `config/openclaw-op-refs.txt`, and Castor topology;
- `scripts/ops/**`, private-host/1Password runtime wrappers, private credential
  alarms/broker service, refresh/resume/proof scripts, and their tests;
- `docs/roles/**`, private runtime handoffs/receipts/reviews, and
  private-host/Castor/Xanthos/Delphi operating documentation; and
- the two preserved unique private-ops commits named in the worktree table.

Mixed modules must be split rather than moved wholesale: the credential broker
engine versus the owner's default handle registry; generic health versus
private-host alarms; OpenAI-compatible transports versus Delphi defaults; product lifecycle
inventory versus the private-host manifest; and Telegram/WhatsApp capture
mechanics versus private-host service installers.

Private ops should consume only versioned public product interfaces: release
artifact/version, OpenClaw configuration, `setup`, `connect`, worker lifecycle,
machine-readable `doctor`, dashboard/status, generic sync/supervisor, and
verified data export. It must not import `src/**`, edit SQLite, invoke replay or
family drain internals, own read-authority switches, or duplicate registries.

The private repository `jamiezigelbaum/olympus-ops` now holds an additive,
private copy of 427 hash-bound tracked files. Its first three commits are the
baseline (`d39d21a`) and the preserved unique changes `e3bff6a` (`1fbbb7d`)
and `b0b611b` (`938390f`). The copy was scanned for common raw credential
patterns and contains no runtime database, capture spool, media, or private
eval dataset. It is explicitly not yet an independent deployment replacement;
the Olympus copies remain until the mixed dependencies above are split and a
private deployment proof passes.

## Documentation disposition

Only the v0.4 release plan and frozen contracts are current product truth.
README, quickstart, installation, architecture, source-family, security, and
operations prose contain known legacy, Notion/MCP, Castor/private-host/Delphi, or
tester-owned Google OAuth drift.

The target public set is deliberately small: README, installation,
architecture, contracts, this source capability matrix, security,
troubleshooting, contributing, and the v0.4 release plan. Repository-control
protocols may remain for development but must not ship as user documentation.

## Proof status

| Proof | Result |
|---|---|
| Baseline local `bun run verify` at `32f0cefa` | Green: 4,204 passed, 1 skipped; 46.87 seconds |
| Slice 0 local `bun run verify` at `70892b62` | Green: typecheck, 4,208 passed, 1 skipped, 0 failed; generated bundles clean |
| Required parallel GitHub `verify` | Green for exact PR head `02272d48` in run `32990841255`; all eight jobs passed before merge |
| Real held-out evaluation | Red baseline: 0/7 passed; 4 completed, 3 retrieval misses, then one synchronous retrieval scan overran the 240-second timeout and stopped the remaining 3. Privacy passed for all 3 released answers. Dataset SHA-256 `d4e719f7684fe11e0911aa7fd712374976f976cd6c6d69735ed40a1416e30053`; private report SHA-256 `08fbcdae7170f9c50d180e473ed55bb525236894107a0c70643ad8f4bcfac371` |
| Private store/capture snapshots | Complete and independently verified; 18 primary plus 417 continuity artifacts, with no downtime or mutation |
| Private-ops copy and validation | Complete as an additive private baseline; 427 source files hash-bound, common raw-secret scan clear, preserved unique commits applied |
| Worktree/branch pruning | Four approved clean/merged worktrees removed; all named branches and every unique ref retained |

Slice 0 is complete and delivered in merged PR #40 (`af297d00`). The red
held-out result is the first named Slice 1 retrieval/performance blocker, not a
reason to weaken the baseline.
