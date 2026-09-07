# Olympus parallel simplification experiment

Status: implemented and locally verified; independent review in progress.
This is not an adopted release direction.

## Outcome and authority

The owner authorized this separate experiment on 2026-09-07: re-evaluate
Olympus from first principles, prefer deletion over simplification, and
preserve useful complexity when the evidence supports it. This branch is
never merged into `main` as part of this task. Adoption is a later owner
decision. The existing v0.4 release plan and testing continue independently.

Baseline: `911caf3f834433f3547049ca07a7bb8d8d268ee7` from refreshed
`origin/main`. Branch: `codex/first-principles-simplification`.

The product remains: connect personal sources, receive useful and correctly
cited answers, and control where information is processed. Preserve Gmail,
Google Drive, Dropbox, Telegram, WhatsApp, X bookmarks, Readwise; the four
privacy presets; and OpenClaw native tools plus Hermes MCP support.

## Working boundaries

- Keep all source changes, builds, tests, and commits in this worktree.
- Use disposable fixture state for tests. No live systems, production stores,
  provider grants, vector changes, deployment, or release publication.
- Follow the source contracts and retain privacy, provenance, honest coverage,
  cursor/resume, and durable-data guarantees. Public capability cuts require
  a separate product decision.
- Inspect the repository broadly, then deepen only concrete candidates. An
  unused export or green test suite alone does not prove safe deletion.
- Stop work by 2026-09-08 01:50 Europe/Lisbon (00:50 UTC), including delegates.

## Evaluation

For every proposed change, record the product purpose, actual callers,
removal consequence, retained guarantees, and behavioral proof. Prefer fewer
independent mechanisms and fewer sources of truth; line count is secondary.
Independent review should attempt to disprove consequential deletions.

Repository checks and synthetic fixtures establish only repository behavior.
They do not establish real-provider, clean-host, or beta qualification.

## Progress

- [x] Read current release and engineering authorities; inspect shared state.
- [x] Create dedicated worktree from refreshed `origin/main`.
- [x] Establish local baseline and map runtime/product boundaries.
- [x] Decide which mechanisms to delete, simplify, or retain.
- [x] Implement justified changes; commit the independent ledger change.
- [ ] Validate the resulting alternative and independently review it.
- [ ] Record evidence, residual limits, and a reproducible comparison path.

## Findings and decisions

The largest unnecessary assumption was that a public source-answer plugin
needed to retain a second private application inside its source tree. Public
tool allowlists already refused that application's operations. Packaging then
deleted marked source text and private build branches to produce a different
program; an earlier overly broad deletion span had broken OAuth refresh in
the shipped package without breaking source tests.

This experiment deletes that private application before compilation. Normal
builds and release builds now compile the same runtime source. The release
build supplies only the public Google client identity through Bun's ordinary
compile-time constant mechanism and uses Bun's minifier; the textual source
rewriter, private build flavor, and second Terser pass are gone.

| Mechanism | Evidence and disposition |
|---|---|
| Private domain experts, workspace/file delivery, hiring, Resource Wiki, and domain-library ingestion | Excluded from the public surface; callers were private scripts, removed operations, or their own tests. Delete their implementation, private skills, resolver entries, and dedicated tests. |
| Native private overlay loader and extended operation contexts | Served only the removed private product. Delete; retain normal synchronous plugin loading and native watch custody. |
| Hidden CLI/admin and legacy EmailClient APIs | CLI allowlist rejected the commands before dispatch; legacy client endpoints had no server routes. Delete the unreachable definitions and exclusive parsers. |
| Dropbox export/eval-shard routes | Optional handlers were injected by tests but never wired by the shipped worker. Delete them; retain real local data export and the entire held-out evaluation path. |
| Duplicate source packet/posture model | No runtime consumers except two extraction type aliases. Move those aliases unchanged to the shared extraction types and delete the obsolete model; the three versioned pipeline contracts stay unchanged. |
| Credential-health probe/alarm | No production callers in this repository. Delete private operational code; retain the public report reader, strict field/privacy/time validation, and useful degradation reporting. |
| Two persisted ingestion snapshot tables | Scheduler repeatedly wrote them; dashboard, status, doctor, and digest use live snapshot objects, and no runtime SQL reader used either table. Stop creating/writing them; preserve dashboard history and leave pre-existing tables untouched. |
| Legacy dashboard fingerprint | No production caller; rendered-page hashing already owns polling. Delete the unused function and its own tests. |
| Private embedding-ledger page | The public package omitted the page but Background still linked to it. Remove that dead link and private viewer; preserve the actual ledger and its approval/durability tests. |
| Private-name filter in Doctor | Replace the deleted special case with the configured public corpus registry, so unrelated reports remain excluded and status eligibility has one owner. |
| Completed private migration verifier | Pinned historical receipts and required retained private files to exist forever. Retire it and stale scanner exceptions; preserve current inventory, credential, privacy, and architecture checks. |

The following complexity still has a concrete job and is retained:

- The seven connectors and shared extraction/store/retrieval/Analyst/release
  pipeline; privacy presets, bounded citations, and honest coverage.
- Cursor/reconciliation state, trust-separated stores, file leases, and
  transactional data/embedding ownership. Their failure cases are observable
  data loss or privacy errors, not hypothetical extensibility needs.
- Detached OAuth. Moving it into the worker would add a worker-running
  prerequisite to an existing onboarding flow.
- Native-only watch authentication and delivery, MCP transport, positive
  public allowlists, install/upgrade/rollback proofs, and host compatibility.
- Source-controlled `dist/` for this experiment. Once both builds use the same
  runtime source, removing checked bundles is a separate build-policy choice,
  not a prerequisite for deleting the private compiler path.

No retrieval/Analyst optimization or new scheduler automation is introduced.
This is a broad repository inventory followed by focused deletion proofs,
not a claim that every remaining line has been independently audited.

## Validation evidence

Baseline typecheck passed. Baseline fast checks: 3,935 plugin tests passed
(one skipped) and 50 exchange-service tests passed.

`bun run verify:full` passes: 3,878 tests, zero failures, one intentional skip
for a live macOS Keychain write, across 315 files. This includes the Go bridge,
exchange service, lifecycle, architecture, credential, and evaluation-harness
tests. Typecheck, contract fingerprint, and rebuilt-bundle consistency pass.
Packaged-artifact checks also pass with the existing synthetic Google client
fixture. Independent review and disposable-home rehearsal results will be
recorded after completion.

Of nineteen dashboard fixture routes, eighteen produce byte-identical HTML to
the baseline. Background differs only by removal of the dead private-ledger
link and the resulting page fingerprint. The comparison covers clean setup,
partial/full ingestion, source detail, background work, OAuth walkthroughs,
publisher setup, and unlocked controls. The [comparison receipt](reviews/parallel-dashboard-parity.json)
does not replace the existing pending owner acceptance of the dashboard.

## Parallel build and test

Use this branch's dedicated worktree. `bun install --frozen-lockfile`,
`bun run verify:full`, and `bun run test:go` exercise the alternative locally.
Package checks use the same public archive inventory as v0.4.

The simulated clean-home runner accepts `--plan <fixture-plan.json>`, so
artifact identities for this experiment can be supplied without rewriting the
active release plan. Its fake service managers and disposable homes exercise
installation and rollback mechanics only; they are not clean-host or real
provider qualification.

Any artifact built with the synthetic Google client fixture is for tests only.
Real-provider, private-corpus held-out evaluation, clean-host qualification,
dashboard owner acceptance, and adoption remain separate decisions/proofs.
No live state, credentials, vectors, services, or current v0.4 artifacts are
changed by this experiment.
