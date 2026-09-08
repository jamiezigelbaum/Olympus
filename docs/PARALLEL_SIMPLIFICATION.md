# Olympus parallel simplification experiment

Status: implemented, locally verified, and independently reviewed within the
focused public-boundary scope. Adoption remains a separate owner decision.

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
- Original session cutoff: 2026-09-08 01:50 Europe/Lisbon (00:50 UTC), including delegates.

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
- [x] Implement justified changes in separate ledger, product-deletion, and review-follow-up commits.
- [x] Validate the alternative and independently review the changed public boundaries.
- [x] Record evidence, residual limits, and a reproducible comparison path.

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

At runtime commit `03d87c1f47cc99ad73cb7d03487be66c52d7ee89`,
`bun run verify:full` passes: 3,878 tests, zero failures, one intentional skip
for a live macOS Keychain write, across 315 files. This includes the Go bridge,
exchange service, lifecycle, architecture, credential, and evaluation-harness
tests. Typecheck, contract fingerprint, and rebuilt-bundle consistency pass.
Packaged-artifact checks also pass with the existing synthetic Google client
fixture. Follow-up commit `ab38fea7e86d5d9223487b291c99226f5e140694`
passes typecheck and 30 focused tests; its runtime bundles are byte-identical
to the reviewed commit.

The complete fake-service-manager matrix passes all 112 simulated cells,
covering install, lifecycle, dashboard/dependency inventory, upgrade, rollback,
and uninstall for both platform configurations. User-data sentinels survive
upgrade, rollback, and uninstall. These are two local fixture rehearsals,
not two real host installations or seven provider qualifications.

Packaged native tool definitions and CLI schemas are identical to the baseline;
see [public-surface parity](reviews/parallel-public-surface-parity.json).
The [focused independent review](reviews/parallel-focused-review.md) reports
PASS with three minor findings, all addressed in the tested follow-up. The
earlier broad Fable review timed out without a verdict. The reviewer did not
review the later follow-up commit or every retained implementation.

Net source reduction through the follow-up: **22,103 lines (16.13%)** of the
137,011-line baseline. The fixture archive grows from 670,201 to 679,034 bytes
(8,833 bytes, 1.32%) after removing the second minifier. The gain is a smaller
maintenance surface and one runtime source, not a claim of better compression
or faster answers. Full machine-readable results are in the
[validation summary](reviews/parallel-validation.json).

Of nineteen dashboard fixture routes, eighteen produce byte-identical HTML to
the baseline. Background differs only by removal of the dead private-ledger
link and the resulting page fingerprint. The comparison covers clean setup,
partial/full ingestion, source detail, background work, OAuth walkthroughs,
publisher setup, and unlocked controls. The [comparison receipt](reviews/parallel-dashboard-parity.json)
does not replace the existing pending owner acceptance of the dashboard.

## Additional A/B testing (2026-09-08)

Both artifacts passed actual installation, plugin loading, worker health,
Gateway tool calls and independent foreground restarts in isolated disposable
OpenClaw profiles on one macOS host. Both also passed the real SQLite/process
kill/resume comparison: 32 fictional records across seven sources,
32 title queries per arm, and identical ranked results, provenance and content.
A shared pre-existing metadata-only change-counter overcount remains disclosed.

A real Gemini comparison then ran the same 16 frozen questions against identical
read-only data and settings. Retrieval, hydration and complete model request
bodies matched in all 16 pairs. The strict rubric scored main **5/16** and the
alternative **4/16**. The only score difference was one citation omission; three
additional pairs with exact original request bodies passed **2/3 in each build**,
with the pass direction reversing in one pair. This supports model variability,
not a code-caused regression. The raw scores are preserved. Several shared
failures are brittle wording/citation expectations; two metadata questions are
incomplete in the generic fixture and do not establish live-provider behavior.

These results strengthen the case for the simpler maintenance surface, while
leaving real-provider/private-corpus qualification and answer-quality superiority
unproven. Full evidence, test corrections, interpretation and reproduction are
in the [A/B report](reviews/parallel-ab/README.md). No runtime source changed
while testing; no adoption or merge occurred. Current main advanced only in
restart-script/protocol surfaces, with the evaluated runtime inputs unchanged.

## Real Air rehearsal (2026-09-08)

The real candidate artifact at commit `4c314e959936ab5580d52a959ae129fb94191352`
is installed on the designated macOS Air rehearsal host under OpenClaw 2026.9.2.
Its SHA-256 is
`97e836437b2b5edf074e42789d30a0749148031d722f72f0f77a78e0612f8267`
and its size is 703,157 bytes. Pull request #21's seven required contexts are
green for that head, including an independent critical lifecycle review. The
pull request remains open and must not be merged as part of this experiment.

The first worker activation attempt exposed a real launchd boundary: `bootstrap`
accepted the job before `print` reported it running, and the lifecycle facade
rolled back immediately. The candidate now applies the same bounded readiness
settle already used by start/restart before deciding whether install/upgrade
succeeded. The regression, lifecycle suite, local fast lane, 420-test deploy
lane, package check, independent review, and exact-head CI all pass. The rebuilt
artifact then upgraded the worker successfully from an immutable digest-named
version root; its service is active, loopback health answers, and no lifecycle
transaction remains.

Gateway reload stayed disabled during install and worker recovery. Two later
Gateway restarts used the reviewed Darwin safe-restart path: one loaded the
candidate plugin, and one applied OpenClaw's documented Custom plugin UI Labs
setting. Each established a new stable launchd process, an owned loopback
listener, a successful HTTP response, and a fresh process-bound ready line.
The preflight resolved all six local credential references, accepted only the
one native OAuth informational record, and found no skipped exec references.

Olympus is the only enabled user-installed plugin on this host that declares a
native UI. A real browser session shows Olympus in the OpenClaw navigation and
renders its Setup and Background views. Direct Gateway reads of Home, Setup,
and Background return 200 through the live worker bridge with operator write
authority. No connect, sync, credential, source, or embedding control was
invoked during the rehearsal.

Two focused OpenClaw/Luna turns then called the installed tools successfully.
A narrow `source_index_status` request returned the exact requested fields, and
`source_answer` returned no evidence plus an explicit no-matching-evidence gap
for a question about unavailable email. One all-corpus status turn failed the
interpretation check: OpenClaw truncates the 10,245-character native tool result
at 10,000 characters, and the model mislabeled configured corpus rows as
connected/answer-ready source counts. The dashboard remains authoritative at
zero connected and zero answer-ready sources. This is a disclosed product
usability defect and was not used as passing evidence.

The [content-free rehearsal receipt](reviews/parallel-air-rehearsal.json)
records the exact evidence and limits. This proves candidate install, worker
lifecycle, Gateway loading, native dashboard rendering, and read-only tool
execution on one real host. With no connected source on that host, it does not
prove real-provider ingestion, personal-corpus answer parity, or superiority.

## Parallel build and test

The original A/B build remains backed up as
`origin/codex/first-principles-simplification`; that branch had no pull request
and did not run remote CI. The later real-host rehearsal continues in the
separate `codex/air-real-rehearsal` worktree and pull request #21, which remains
unmerged. Run `bun install --frozen-lockfile` and `bun run verify:full` in the
relevant dedicated worktree for a full local comparison, or the closest
affected tests during further edits. Package checks use the same public archive
inventory as v0.4.

The simulated clean-home runner accepts `--fixture --plan <fixture-plan.json>`, so
artifact identities for this experiment can be supplied without rewriting the
active release plan, and the proof names the exact plan digest and fixture
mode. Its fake service managers and disposable homes exercise
installation and rollback mechanics only; they are not clean-host or real
provider qualification.

The local `release-artifacts/parallel/` directory contains the exact test-only
candidate and baseline archives, fixture plan, and receipts. Rehearse either
platform from this worktree with:

```sh
bun scripts/qualification/simulated-clean-home.ts \
  --fixture --plan release-artifacts/parallel/fixture-plan.json \
  --artifact release-artifacts/parallel/candidate.tgz \
  --previous-artifact release-artifacts/parallel/baseline-911caf3f.tgz \
  --host-os darwin_arm64 --output release-artifacts/parallel/darwin.jsonl
```

Use `linux_x64_ubuntu_lts` and a separate output file for the Linux fixture.
These generated archives are local test assets, not committed release inputs.

Any artifact built with the synthetic Google client fixture is for tests only.
Real-provider, private-corpus held-out evaluation, clean-host qualification,
dashboard owner acceptance, and adoption remain separate decisions/proofs.
The digest-pinned real candidate described above remains installed only on the
designated Air rehearsal host. Credentials, vectors, and source connections
were not changed, and the branch remains unmerged.
