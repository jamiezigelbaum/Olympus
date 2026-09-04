# Olympus 0.4 release plan

Status: active

Owner: Olympus product owner
Planning authority: this document defines v0.4 scope, sequence, and completion. It supersedes dated CTO planning handoffs and migration plans. [`CONTRACTS.md`](CONTRACTS.md) remains the architecture authority.

## Outcome

Release Olympus as a testable plugin to the product owner and a fluid cohort of
technically sophisticated OpenClaw beta testers so they can:

`install → connect source → configure scope → ingest/sync → ask through
OpenClaw (native tools) or Hermes Agent (MCP) → receive a correct, cited,
secure answer`

The supported sources are Gmail, Google Drive, Dropbox, Telegram, WhatsApp, X
bookmarks, and Readwise. Olympus ships when the full path works on clean macOS
and Linux installations, every source's actual limits are documented, and beta
testers have exercised the normal product journey without custom engineering.

## Decisions

- **2026-08-26 — Product boundary.** Olympus is the OpenClaw plugin. Private deployment, credentials, incident response, and host maintenance belong in a private ops repository. The supported v0.4 topology is same-host macOS or Linux.
- **2026-08-26 — Shared Google OAuth.** The pilot ships a publisher-owned Google Desktop OAuth client ID for Gmail and Drive. Google documents installed applications as public clients and accepts the authorization-code exchange with client ID plus PKCE; no client secret is required or packaged. Users click Connect, sign in, and consent. The dashboard names the unverified-app warning honestly. User grants and refresh tokens remain local; a client-ID-only BYO path remains an advanced fallback.
- **2026-08-26 — Converge, verify, delete.** Preserve useful existing connector stores. Complete bounded replay/import only where legacy stores contain useful data absent from the canonical store, reuse embeddings only when identity and dimensions prove exact compatibility, re-fetch only missing/corrupt/unverifiable portions, then delete transition machinery. No general migration system ships.
- **2026-08-26 — Security profiles.** Keep `local-first`, `local-only`, `private-cloud-only`, and `no-sensitive`; the pilot default is `private-cloud-only`. Local reasoning uses a loopback OpenAI-compatible endpoint. Requests fail closed when no approved route exists.
- **2026-08-26 — One runtime.** Only `SourceConnector` is source-specific; extraction, storage, retrieval, reasoning, provenance, release, status, and orchestration are shared. Normal runtime never reads a legacy index or executes replay/cutover code.
- **2026-08-26 — Qualification.** All seven sources pass internally on both
  supported operating systems. Beta users may connect any subset.
- **2026-08-27 — Hermes support boundary.** Hermes Agent is supported
  exclusively through the existing MCP surface, installed per a documented
  runbook (`hermes mcp add olympus --command <absolute-olympus-cli> --args serve`, verified
  with `hermes mcp test olympus`). The supported v0.4 Hermes surface is
  exactly `source_answer` and `source_index_status`, enforced by Hermes
  per-server filtering — `tools.include: [source_answer,
  source_index_status]` — and verified by checking that the discovered tool
  set is exactly those two; operations are always addressed by their
  discovered registered names, never hard-coded. The supported Hermes
  analyst route under the pilot-default `private-cloud-only` posture is
  named with its prerequisites in the installation doc and proven in the
  Slice 4 Hermes proof; if no route is proven under that posture, the
  supported Hermes posture is explicitly narrowed in the capability matrix.
  At most one deliberately adapted `ask-sources` skill may ship, constrained
  to the same two-tool allowlist, with an explicit installation method
  (`~/.hermes/skills` or `external_dirs`) and an activation test. v0.4 ships
  no Hermes-native plugin, no `source_watch_*` parity on Hermes, no
  data-directory rename, no Hermes-specific analyst backend, and no skill
  compatibility claim without a body/tools audit and activation test. Host
  deltas appear in the capability matrix, not as code.
- **2026-08-30 — Slice 3 proof boundary.** Slice 3 prepares one exact product
  artifact for release qualification; it does not claim that real-provider,
  clean-install, or pilot qualification has passed. Those proofs remain Slice
  4. Slice 3 is delivered as six independently reviewable tranches (3A–3F)
  that close together against the same exact commit and artifact.
- **2026-08-30 — Private-ops closure.** Private operations consumes only the
  versioned public artifact/lifecycle contract. Exact private-ops main
  `13ae3694953b252b6805ef2c00f08585af78d433` binds all 427 preservation rows to
  current replacement bytes and owns the separately authorized, content-free
  previous -> candidate -> previous deployment proof. The non-packaged
  `config/private-ops-disposition.json` is the itemized deletion authority;
  Slice 3 cannot close while its live receipt remains pending.
- **2026-08-30 — Public distribution.** ClawHub is the v0.4 OpenClaw
  discovery and distribution channel. The release candidate is first proved
  through OpenClaw's managed `npm-pack:` installation path; the byte-identical
  package is then published through ClawHub. Public allowlists, rather than
  recursive directory inclusion or deny-lists, define every shipped tool,
  skill, command, dashboard route, connector, dependency, and document.
- **2026-08-30 — Account cardinality and disconnect.** v0.4 supports one
  connected account per provider. A bounded local Disconnect action stops
  scheduled and manual reads for that source, removes the selected local
  credential/account grant from Olympus-owned state, and refreshes scheduling
  without a service restart. It retains developer-app registration needed to
  reconnect unless the user separately forgets it, retains indexed data, and
  does not revoke the provider-side grant; the confirmation names those facts
  and links the provider revocation surface. Whole-source local deletion
  remains the deliberate CLI-only `olympus data delete --source <id>` flow
  with `--dry-run`; it is never implicit in Disconnect and must prove
  worker/store coordination or require the source to be disconnected first.
  Pause/Resume, multiple accounts, and destructive dashboard deletion are not
  v0.4.
- **2026-08-30 — Dashboard control and custody.** The dashboard uses a
  short-lived local control session with CSRF and origin protection; it never
  exposes the worker bearer token to browser storage. Source setup converges
  on one state machine: preset → dependency check → credential or pairing →
  scope → initial sync → usable/degraded/blocked → cited-answer readiness.
  Web scope editing owns rule authoring and preview; destructive purge/strip
  remains a separate deliberate CLI custody contract.
- **2026-08-30 — Google scale readiness.** A publisher-owned published but
  unverified installed-app client is acceptable for the small beta, with
  an honest warning and BYO fallback. Before expansion toward 50 users, the
  repository must contain the verified-app readiness package: owned domain,
  homepage, privacy policy, terms, exact scopes, consent assets, submission
  evidence, grant monitoring, BYO fallback, and a documented determination on
  whether restricted-scope security assessment applies.
- **2026-08-30 — X ownership and cost.** Olympus does not use a shared
  maintainer-funded X application. v0.4 guides each user through a user-owned/BYO X
  developer application and makes provider pricing and coverage ceilings
  visible. Client-ID-only PKCE is the target only after an end-to-end proof
  against the exact configured flow; otherwise the supported fallback is the
  user's own client ID and secret. No release proof may incur maintainer-funded X
  API usage. The internal X proof uses a consenting tester's or other
  participant's BYO developer plan; if no such account is available, the X
  qualification remains incomplete rather than shifting cost to the
  maintainer.
- **2026-08-31 — Venice posture.** v0.4 does not provide or qualify Venice
  end-to-end encryption out of the box. User-owned custom integrations remain
  outside the release claim. The normal `private-cloud-only` route uses Venice
  through its ordinary API with a model that the live Venice catalog classifies
  as Private or plain TEE. Slice 4 adds no E2EE-specific mechanism. Secure
  corpora remain lexical-only in v0.4; adding a cloud embedding lane is deferred
  and is not a Slice 4 gate. This accepted product limit must be visible in
  setup, status, and the capability matrix.
- **2026-08-31 — Slice 4 beta shape.** The beta cohort is fluid; participant
  count is not a release constraint. Testers use whichever supported Mac or
  Linux machine they already have; Olympus does not assign them an operating
  system, source, or test matrix. Each person installs through the
  public instructions, connects a source they actually use, waits for it to
  become ready, asks a normal question, checks the answer and citations, and
  reports what worked, what was confusing or broken, and whether they would
  use it again. Internal qualification, not the beta roster, owns proving that
  every declared source works on clean macOS and Linux installations.
- **2026-08-31 — Built artifacts.** `dist/` remains source-controlled for v0.4.
  CI rebuilds and checks it, and the release package contains only current,
  allowlisted built output.
- **Standing — Embedding control.** Any model, provider, dimension, epoch, or re-embed change requires the owner's advance approval with cost stated and an embedding-ledger entry. Existing vectors are never discarded merely to simplify a cutover.

## Qualification levels

v0.4 uses three qualification levels. Each slice's exit names its level;
completion at a lower level is never silently substituted for a higher one.

1. **Repository qualification** — implementation, frozen-contract conformance,
   contract tests, green local and required full CI, and a green held-out
   eval. Owned by Slice 1.
2. **Observed runtime qualification** — real provider, scheduler advancement,
   retrieval, coverage, and security behavior proven with content-free
   receipts on a live host. Owned by Slice 2, plus the one Slice 1 carve-out:
   the live messaging exit.
3. **Release qualification** — clean installation, complete dashboard
   onboarding, and the pilot workflow, per the qualification contract in
   `SOURCE_CAPABILITIES.md`. Prepared by Slice 3, owned by Slice 4.

## Delivery sequence

### 0. Preserve what matters and establish the baseline

- Inventory branches and worktrees; preserve unique useful commits, then prune abandoned work. Use `codex/finish-source-migration` only as a deletion inventory, never as a change to merge wholesale.
- Record the actual runtime dependency graph and a seven-source capability matrix: authentication, scope, available history, content and attachment support, exclusions, provider limits, and present spine gaps.
- Keep the durable audit evidence in [`V0_4_BASELINE.md`](V0_4_BASELINE.md) and the source contract in [`SOURCE_CAPABILITIES.md`](SOURCE_CAPABILITIES.md); these are evidence for this plan, not competing plans.
- Snapshot every existing connector and legacy store before transition. Identify irreplaceable capture-only history; WhatsApp downtime can create a permanent gap, so its capture store is preserved before Olympus stops.
- Archive orphaned Reflect and Roam stores privately, then keep those unsupported sources outside the v0.4 registry and package.
- Create the private ops repository and copy deployment-specific material into it. Keep the Olympus copies only until the private replacement has been validated.
- Replace the monolithic verification gate with a sub-minute local gate and parallel full CI. Stop requiring work-order and handoff ceremony for ordinary product changes; retain explicit review only for live-host, security-boundary, destructive-data, and frozen-contract work.
- Prove the unchanged baseline with local verification, the required full-CI check, and the held-out evaluation.

Exit: useful work and irreplaceable data are accounted for, the baseline is green, and every source gap is named without relying on old planning prose.

### 1. Complete the shared spine before deleting its predecessors

- Reuse the connector store's existing sync-run, cursor, checkpoint, reconciliation, and replay-safe state. Add only shared capabilities that are genuinely missing, including hierarchical crawl/frontier behavior needed by Dropbox.
- Provide one generic sync/extraction/embedding worker driven by connector capabilities. Telegram and WhatsApp may retain thin long-lived capture helpers; everything after capture uses the shared worker and store.
- Make the dashboard's connection, scope, progress, coverage, gaps, and
  attention states derive from one source-neutral capability/status model.
  Slice 1 owns this model and its truthfulness; the interactive onboarding,
  credential, and scope-editing flows built on it are Slice 3.
- Make every source reachable through the same retrieval and `Analyst` path used by `source_answer`, with claim-level provenance and honest missing-coverage reporting.
- Qualify connector-native behavior in this order: Google Drive; Readwise and X; Telegram and WhatsApp; Dropbox; Gmail. Old implementations may remain as inert reference code during this step but cannot serve normal runtime traffic.
- The live messaging exit completes only on all of these content-free
  receipts, and progression follows immediately — no arbitrary soak period:
  the exact deployed commit hash with the three-leg Gateway boot proof; one
  completed generic-scheduler cycle per messaging source after deploy, with
  each product cursor either strictly advanced past its pre-deploy value or
  deterministically tail-equivalent (a completed cycle consuming zero new
  spool lines with no unconsumed backlog reported); zero selected-source
  scheduler gaps; both capture helpers and the WhatsApp transcription helper
  active; the legacy store-writer drains (Telegram sync, Telegram spool,
  WhatsApp live) disabled and inactive; one natural `source_answer` smoke per
  source returning cited canonical-store evidence or an honest gap; one
  content-free denied-route smoke per messaging source proving fail-closed
  behavior; one content-free provider-to-spool receipt per messaging source —
  a new provider event reaching the capture spool after deploy, proving live
  provider flow rather than retained-data replay; and a validated rollback
  path — the exact re-activation sequence for the preserved legacy
  store-writer units, exercised or dry-run-verified.

Exit (repository qualification): all seven sources pass repository
qualification on the shared spine; the clean-install default write and read
path for every source is canonical with no legacy dependency; every remaining
existing-host legacy dependency is an explicit, pinned, non-default rail
recorded in the Slice 1 closure ledger; and the live messaging exit — the one
existing-host ownership flip Slice 1 owns — is complete on its receipts.
Existing-host Gmail and Dropbox convergence, authority cutover, and deletion
are Slice 2. Clean-install onboarding proof is Slice 4.

### 2. Converge once, make the clean cut, and delete the migration era

- Slice 2 owns all one-time existing-host work: Gmail and Dropbox convergence
  and replay, read-authority cutover off the pinned Slice 1 rails, retirement
  of the preserved messaging rollback assets, and deletion of every
  migration-era mechanism.
- Take Olympus offline after the snapshots and capture-only preservation are verified.
- Retain canonical connector stores whose source/account identity, schema, coverage, trust classification, and embedding identity pass validation.
- Run existing bounded replay/import once for useful legacy-only data: complete the required Dropbox convergence and Gmail legacy replay. Import vectors only through an implemented exact-compatibility adapter (currently Dropbox only); Gmail has no legacy embedding importer. Write no general migration framework and do not ship these utilities.
- Re-ingest only missing, corrupt, or unverifiable portions through canonical connectors. Do not rebuild or re-embed already-proven data.
- Remove legacy indexes, per-source downstream workers, old authority switches, migration/replay/drain code, transitional configuration, and tests whose only subject is migration history.
- Add a zero-legacy architecture guard that rejects source-specific branches downstream of connectors and imports or registrations of removed paths. Do not weaken the frozen contract or existing architecture guard.
- Run typecheck, the complete test suite, architecture guards, and held-out evaluation after deletion.

Exit: the repository compiles and tests with one spine only; removing all migration machinery does not reduce any declared v0.4 source capability.

### 3. Prepare the standalone release candidate

Slice 3 changes product surfaces around the frozen contracts; it does not
change `SourceConnector`, `EvidencePack`, or `Analyst`. The six tranches below
are independently reviewable, but Slice 3 closes only when they are proven
together at one exact commit and against one exact package artifact.

#### 3A. Freeze the public surface

- Add positive, machine-checked allowlists for the v0.4 native tools, MCP
  tools, skills, CLI commands, dashboard routes, package files, canonical
  documents, connectors, and source-conditioned dependencies.
- Reduce the declared v0.4 source roster to Gmail, Google Drive, Dropbox,
  Telegram, WhatsApp, X bookmarks, and Readwise. Omit domain/PKM, private ops,
  migration, maintenance, experimental, and future-release surfaces from the
  public artifact even when source files remain in the repository.
- Fail CI if an undeclared public surface appears, a declared surface is
  missing, or recursive packaging silently expands the artifact.
- Capture connector-owned authentication type, contextual scopes,
  dependencies, provider ceiling, and supported-format metadata behind shared
  dashboard, doctor, and documentation renderers. This metadata cannot add a
  source-specific downstream path or alter a frozen contract.

#### 3B. Establish one lifecycle facade

- Give users and private ops one public lifecycle: install, start, stop,
  restart, status, foreground, upgrade, and uninstall. Private ops consumes
  only this versioned facade and never reaches into Olympus internals.
- Model source-conditioned prerequisites and recovery for interrupted setup,
  OAuth or pairing, capture, partial sync, missing dependencies, upgrade, and
  rollback. A restart is not the normal response to source credential, scope,
  or Disconnect changes.
- Prove lifecycle idempotence, interrupted-operation recovery, truthful status,
  and the absence of private-host assumptions on supported macOS and Linux
  test fixtures.
- Make supported configuration and secret-reference changes atomic and
  validation-gated; normal lifecycle flows never require raw file or
  environment surgery.

#### 3C. Complete dashboard onboarding and custody

- Run the required dialogic UX convergence loop before implementation. The
  resulting dashboard uses the shared source capability/status model and the
  explicit setup state machine recorded in Decisions.
- Implement one-account-per-provider setup for credentials or pairing, scope,
  security preset, initial sync, reconnect/reauthorize, dependency repair,
  coverage, gaps, and cited-answer readiness. Every blocked or degraded state
  names the next supported action.
- Use a short-lived local control session with CSRF and origin protection;
  never place the worker bearer token in browser local storage.
- Ship the bounded Disconnect behavior recorded in Decisions. Keep local data
  deletion CLI-only with dry-run and explicit worker/store custody. Web scope
  edits author and preview rules; destructive purge/strip remains a separate
  CLI flow.
- For Google, make the shared pilot client, unverified warning, and advanced
  BYO fallback truthful, and request Gmail and Drive scopes contextually. For
  X, guide users through their own developer app, prove the supported OAuth
  shape, and expose cost and provider ceilings.

#### 3D. Build the public artifact and distribution path

- Produce current built JavaScript and an exact package that contains only the
  3A allowlists and every runtime helper required by the seven declared
  sources. Resolve the repository `dist/` policy without weakening the rule
  that distributed entrypoints are current built JavaScript.
- Prove installation and runtime inspection through OpenClaw's managed
  `npm-pack:` path, including native plugin loading, CLI/worker lifecycle,
  dashboard assets, source-conditioned dependencies, and clean uninstall.
- Prepare the byte-identical ClawHub publication input only after the managed
  package proof passes. Record package identity, contents, provenance, and the
  exact ClawHub installation instruction; Slice 4 publishes the exact
  release-qualified package rather than a rebuild.
- Add package guards proving that owner/deployment material, credentials,
  migration code, private topology, private protocols, and unrelated skills
  are absent.

#### 3E. Close private ops and canonical documentation

- Define a versioned public consumer contract for private ops, validate every
  replacement, and maintain an itemized disposition ledger for each private
  or deployment-specific file. Delete a public-repository copy only after its
  replacement and consumer proof are green.
- Reduce product documentation to the canonical README, installation,
  architecture/contracts, seven-source capability matrix, security model,
  troubleshooting, contributing guide, and this release plan. Git history is
  the archive; private-ops documentation belongs in private ops.
- Document Hermes as MCP-only with exactly `source_answer` and
  `source_index_status`: install with `hermes mcp add olympus --command <absolute-olympus-cli>
  --args serve`, configure `tools.include: [source_answer,
  source_index_status]`, run `hermes mcp test olympus`, verify the discovered
  registered names are exactly those two tools, and exercise a cited-answer
  round trip through the discovered name. State the supported analyst route
  for the selected security posture or narrow the posture honestly.
- Current Hermes upstream documents custom MCP installation through
  `hermes mcp add` and does not define a `hermes://mcp/install` handler. Keep
  the reviewed CLI fallback canonical and publish no invented deep link. A
  later Nous-approved catalog submission or URI handler needs a separately
  reviewed upstream contract and explicit external-submission authority.
- Ship at most one audited Hermes-adapted `ask-sources` skill, constrained to
  the same allowlist and proven through its documented install and activation
  path. `source_watch_*` remains OpenClaw-native; all host deltas live in the
  capability matrix rather than parallel implementations.

Closure shape: product documentation is the exact 10-document public allowlist;
the source repository retains only two internal process documents, two
non-packaged release/governance receipts, and the two non-product OpenClaw
protocols. The private ledger disposes 395 replacement-proven copies, records
13 already-absent rows, and explicitly retains 19 product-test or governance
files. The guard fails until the exact private-topology deploy/rollback receipt
is present and digest-bound.

#### 3F. Prepare release-qualification harnesses

Owner decisions (2026-08-30): the claimed v0.4 host fixtures are Apple Silicon
macOS and x86_64 Ubuntu LTS. Normal installation means the user or their AI
completes setup through documented Olympus onboarding, settings, and recovery
actions. `documented_flow` and `documented_recovery` remain eligible;
`engineering_intervention` (code, scripts, database/config/service edits, or an
undocumented workaround) never qualifies a passing cell. Rollback binds to an
explicit digest of the immediately preceding zero-private public artifact.

- Build simulated clean-home macOS and Linux harnesses for install, lifecycle,
  dashboard setup states, source-conditioned dependencies, package inventory,
  upgrade/rollback, uninstall, and privacy-safe receipt collection.
- Define the exact Slice 4 real-provider scripts, content-free receipt shapes,
  pilot task, success/failure accounting, and rollback evidence before any
  pilot begins. Each attempted setup records source, host, exact artifact,
  start/end state, assistance category, result, and a count-only failure
  reason; no product telemetry is introduced merely to score the pilot.
  Simulated providers may prove control flow but never satisfy a real-provider
  qualification cell. Real-provider and pilot receipts require the runner's
  one-time content-free session proof and keyed custody check; hand-authored
  receipt JSON is not a qualification input. That custody check detects
  mutation but is not an external trust anchor: its verifier reports prepared
  inputs only, and only Slice 4 independent review may conclude real-provider
  or pilot qualification.
- Prepare Google verified-app scale-readiness evidence and the X BYO/no-maintainer-
  spend proof as release inputs. No credential contents enter repository,
  package, logs, screenshots, or receipts.
- The executable owners are `scripts/qualification/simulated-clean-home.ts`,
  `scripts/qualification/real-provider.ts`, and
  `scripts/qualification/release-input-evidence.ts`; the exact matrix and pilot
  task live in `config/release-qualification-plan.json`. A declarative row with
  no executing owner is not a qualification cell. Google/X release-input
  manifests are prepared-only and explicitly report `qualification_complete:
  false`; only Slice 4 independent evidence review may turn those inputs into a
  release conclusion.

Exit (release-qualification readiness): at one exact commit, the managed
`npm-pack:` installation passes against the exact public artifact; all 3A
allowlists and zero-private guards are green; lifecycle, dashboard, source
setup, Disconnect, package, Hermes, upgrade/rollback, and uninstall fixtures
pass; the private-ops disposition ledger has no unproved deletion; and the
Slice 4 real-provider and pilot harnesses are ready. This exit does not claim
that clean-install real-provider or pilot qualification has passed.

### 4. Prove and pilot the release

- Execute the Slice 3 qualification harnesses against the exact package that
  passed the Slice 3 exit; do not substitute a source checkout or rebuilt
  artifact. The upgrade/rollback fixture uses the immediately preceding Slice
  3 artifact as its synthetic prior public version.
- Before ClawHub publication, give testers one access-controlled download of
  that exact `.tgz`, together with its SHA-256 and byte count. They install it
  through the documented managed
  `openclaw plugins install npm-pack:/absolute/path/to/olympus-0.4.0.tgz --force --accept-capabilities`
  command. On OpenClaw 2026.7.1, omit both flags for a clean install; on newer
  hosts `--force` also overwrites an existing plugin, so the install guide's
  existing-install checks still apply. No tester builds a package or installs
  from a source checkout. README, Quickstart, and the agent install guide use
  this same path and require the artifact digest and byte count in the install
  report so feedback can be tied to the qualified candidate.
- Before inviting testers, internally prove the same packaged product on clean
  Apple Silicon macOS and x86_64 Ubuntu LTS installations. On both operating
  systems, every declared source must complete install, onboarding, configured
  scope, automatic sync, extraction accounting, retrieval, citations, honest
  gaps, fail-closed security, and restart/resume. Run the held-out evaluation
  once against the same exact candidate before inviting testers.
- Give the available beta testers the public product documentation. They use
  whatever supported computer they already have and
  connect whichever source is useful to them; they are not assigned platform
  or source coverage. Record only whether the normal journey completed, what
  failed or was confusing, whether documented recovery was needed, any answer
  or security surprise, and whether they would use Olympus again. Clarifying
  the published instructions is allowed and becomes documentation feedback;
  code, database, config-file, service-manager, or undocumented repair work is
  engineering intervention. A fresh Telegram or WhatsApp pairing with little
  history passes when Olympus truthfully reports that limited coverage and
  still completes the supported answer path. Never record source content, the
  question, the answer, or credentials.
- Fix blockers to the core workflow or truthful product behavior. Any product
  fix creates a new candidate: re-enter through the Slice 3 exact-artifact
  gates at the new commit (CI, allowlists, zero-private package guards,
  managed-install proof, and simulated clean-home proof) before repeating the
  affected Slice 4 internal proof on both operating systems and letting an
  affected tester retry the normal journey. Receipts for an older artifact
  remain history and cannot qualify the replacement. Do not turn beta users
  into operators or repair their machines through undocumented steps.
- Run one Hermes clean-install proof on one supported OS under the
  pilot-default `private-cloud-only` posture (or the explicitly narrowed
  supported posture): install per the runbook with `tools.include` →
  `hermes mcp test olympus` green → verify the discovered tool set is
  exactly the two supported tools → connect source → ingest → a correct
  cited answer through the discovered `source_answer` tool name (currently
  registered as `mcp_olympus_source_answer`; never hard-code it) → the
  discovered `source_index_status` name reporting truthfully → the
  fail-closed security check. This is release qualification for the Hermes
  lane; it does not add work for beta testers.
- After the exact package passes the release checks and the beta is complete,
  publish those byte-identical bytes through ClawHub and record the public
  package identity and install proof.

Exit: all seven sources work through the normal product journey on clean macOS
and Linux installations; beta testing has produced enough normal-journey
feedback to identify and fix product blockers; the capability matrix matches
observed behavior; and the released repository contains neither migration
runtime nor private deployment machinery.

## Interfaces and non-negotiable behavior

- `SourceConnector`, `EvidencePack`, and `Analyst` remain frozen. Any proposed contract change stops for owner review.
- The dashboard is the normal interface for connection, credentials, scope, progress, gaps, and required action.
- The OpenClaw assistant continues to use Olympus tools such as `source_answer`; it does not receive unrestricted raw private-source access.
- Every eligible item is either available to retrieval or represented by a specific, user-visible coverage reason.
- Background sync starts and resumes automatically after initial configuration. Manual ingestion commands are diagnostic/operator tools, not part of the user journey.
- The private source worker lane is on by default (`email.enabled`). Every preset installs the worker, so an install with no worker running reports it as unreachable rather than as deliberately disabled. Set `OLYMPUS_EMAIL_ENABLED=false` to opt out.

## Release checks

- The sub-minute local gate and required parallel full-CI check are green
  after every structural slice and for the release commit. The held-out eval
  runs after every source-pipeline structural tranche and must be green
  before that tranche is complete; a red result keeps the tranche and its
  owning slice in progress and maps to a named register item. Every completed
  source-pipeline structural slice and the release commit therefore have a
  green held-out eval. Slice 0's preservation baseline is the explicit
  non-pipeline exception.
- Contract-conformance tests cover all seven connectors with empty, partial, resumed, duplicate, deleted, changed-scope, expired-credential, rate-limited, unsupported-content, and extraction-failure cases.
- Security tests prove each preset's allowed routes, absence of raw-content leakage, provenance retention, and fail-closed behavior.
- An architecture test proves there is no registered legacy index, migration runtime, downstream source branch, or second answer path.
- Clean-install tests cover supported macOS and Linux environments using
  only dashboard setup and documented prerequisites, plus the Hermes-via-MCP
  lane on at least one supported OS per its documented runbook.

## Not v0.4

No additional sources, assistant harnesses beyond OpenClaw and
Hermes-via-MCP, an MCP requirement for OpenClaw users (MCP remains optional
there; it is the Hermes lane), domain or marketplace agents, broader PKM
automation, generalized write/send/move/delete operations, production-scale
multi-user operation, multiple accounts per provider, Pause/Resume, roster
customization, destructive dashboard deletion, nontechnical onboarding,
perfect media extraction, or cleanup unrelated to the core workflow. v0.5
candidates include a Python shim plugin or `source_watch_*` delivery on
Hermes, Hermes availability of any skill beyond the optional audited
`ask-sources` skill, any
`$XDG_DATA_HOME/openclaw/olympus/` rename or data migration, a Hermes analyst
backend, and Hermes-specific ops tooling.

## Current register

| Slice | State | Completion proof |
|---|---|---|
| 0. Preserve and baseline | complete | Local gate, inventory, verified preservation receipts, capability matrix, private-ops copy, worktree cleanup, honest red held-out baseline, green exact-head CI run `32990841255`, and merged PR #40 recorded in `V0_4_BASELINE.md` |
| 1. Complete shared spine | complete | All seven rows are repository-qualified on the shared spine; the messaging live exit is receipt-green; PR #71 CI `33171581700` and the exact-head 7/7 held-out receipt are recorded below. |
| 2. Delete migration era | complete | The approved manifest accepts bounded Gmail metadata-only/clamped rows and eight damaged Dropbox entries as honest coverage debt. PR #80 removed the legacy supervisor; PR #87 removed all 154 reviewed migration-era paths; and PR #91 installed the 678 exact-compatible Dropbox vectors, proved none remained importable and the current set was complete, then deleted the embedding importer and import-only authority seam. Later corrective PRs completed managed-state cleanup and fail-closed refresh/resume recovery. Exact-head repository, CI, installed-artifact, and live-cutover receipts passed; deployment-specific receipt details remain in private operations records rather than the public package. |
| 3. Standalone release candidate | complete | One exact commit/artifact passes 3A public-surface allowlists, 3B lifecycle, 3C dashboard/custody, 3D managed package and ClawHub path, 3E's 427-row private-ops disposition plus canonical-doc closure, and 3F release-harness readiness. `config/private-ops-disposition.json` mechanically binds the separately authorized private-topology rollback receipt before this row can merge. |
| 4. Pilot and release | pending | Review corrections cover applied setup-policy activation, managed-worker credential readiness, multi-query corpus-budget coverage, exchange-service CI/review coverage, and consistent exact-artifact pilot instructions. These repository fixes require a newly qualified candidate; real-provider and pilot receipts are still pending. Every source must pass clean-install proof on macOS and Linux, fluid beta testing, and exact-artifact publication/install proof. |

Slice 1 runtime-safety proof is merged in PR #48 (CI `33023155341`): product
and migration capture identities are distinct, degraded retrieval is honest,
and Telegram/WhatsApp lifecycle and ledger boundaries fail safely.

The exit-rail tranche makes the clean-install Dropbox default canonical while
pinning the existing deployment to its legacy reader, collapses the obsolete
protected Telegram corpus id into a compatibility input alias, and derives
embedding readiness from retrieval mode so lexical-only corpora do not fail on
optional vector parity. Live qualification and any existing-host cutover remain
separate receipt-gated work.

### Slice 1 closure ledger

Slice 1 closes only when every cell is a receipt, an explicit pinned-rail
entry, or an explicit later-slice owner (a terminal state for this ledger),
and every item in the "Open Slice 1 residuals" list below has been replaced by
a receipt or removed as completed. Update cells and residuals in place as
evidence lands; this ledger is the only completion-status record for Slice 1.
The WO proof record is durable evidence cited here, not a second status ledger.

| Source | Canonical write path | Canonical retrieval/Analyst | Scheduler resume + cursor advance | Honest coverage/status | Security routing | Observed provider proof | Remaining legacy dependency (pinned rail) | CI / held-out receipt |
|---|---|---|---|---|---|---|---|---|
| Google Drive | PR #43 (`google-drive-connector`, `google-connector-ingest`) | PR #42/#43 (`drive-content-provider`) | PR #43 (`google-drive-head-resume-precedence`, `google-drive-reconcile-content-budget`) | shared `connector-store-coverage-gaps` plus Drive store/ingest status tests | shared EvidencePack/Analyst sovereignty tests plus per-item Drive sensitivity in `google-connector-ingest` | Slice 2 convergence and Slice 4 clean-install proof — terminal here | legacy replay = explicit convergence-only | CI `32996481141` and final aggregate `33171581700`; exact-head held-out receipt below |
| Readwise | PR #44 (`readwise-connector`) | PR #42/#44 (`readwise-content-provider`) | PR #44 (`readwise-store-scheduler`, `readwise-traversal-complete`) | shared coverage tests plus Readwise store/scheduler status tests | shared EvidencePack/Analyst sovereignty tests plus per-item Readwise sensitivity | Slice 2 observed and Slice 4 clean-install proof — terminal here | legacy index = explicit convergence-only | CI `32997916392` and final aggregate `33171581700`; exact-head held-out receipt below |
| X bookmarks | PR #44; local-OAuth ownership PR #54 | PR #42/#44 (`x-bookmarks-content-provider`) | PR #44/#52/#54 (`x-bookmarks-live-sync`, reconcile/resume tests; both live tasks admitted) | shared coverage tests plus X qualification/status emitters | shared EvidencePack/Analyst sovereignty tests and credential-capability fences | scheduler-composition receipt in PR #55; live-provider ceiling is Slice 2 — terminal here | legacy replay = explicit convergence-only | CI `32997916392`, `33059444953`, `33064516393`, merge-head `33064843617`, and final `33171581700`; exact-head held-out receipt below |
| Telegram | PR #46 (`telegram-canonical-runtime`) | PR #46 (`telegram-content-provider`) | PR #48/#50/#51/#52; product cursor distinct from replay; completed post-deploy cycle/tail-equivalence receipt | shared coverage tests plus canonical runtime/status tests | shared EvidencePack/Analyst sovereignty tests; trust-separated connector stores | live messaging exit: canonical scheduler/store, provider-to-spool, cited answer, typed denied route, and rollback receipts accepted | legacy index convergence-only; inactive store-writer definitions remain Slice 2 rollback assets | CI `33001966163`, `33023155341`, `33025592649`, `33056141860`, `33059444953`, and final `33171581700`; exact-head held-out receipt below |
| WhatsApp | PR #45 (`whatsapp-source-connector`, `whatsapp-canonical-runtime`); shared transcription PR #56 | PR #45 (`whatsapp-canonical-runtime`) | PR #48/#50/#51/#52; restart-safe spool cursor; completed post-deploy cycle/tail-equivalence receipt | shared coverage tests plus canonical runtime/transcription gap tests | shared EvidencePack/Analyst sovereignty tests; secure-local connector store | live messaging exit: canonical scheduler/store, provider-to-spool, cited answer, typed denied route, and rollback receipts accepted | inactive live-store drain remains a Slice 2 rollback asset; shared transcription owns transcript ingestion | CI `32999560095`, `33023155341`, `33025592649`, `33056141860`, `33059444953`, PR #56, and final `33171581700`; exact-head held-out receipt below |
| Dropbox | PR #47 (`dropbox-source-connector`, `dropbox-provider-store-sync`) | PR #47 plus PRs #57–#64 (`dropbox-content-provider`, source-neutral Analyst) | PRs #47/#65–#67; schema-v11 locator projection, bounded continuation, cursor compatibility, cooperative yielding, digest-change replay | shared coverage tests plus extraction, locator-readiness, and source-status suites | shared sovereignty tests; shared OCR/VLM/transcription and fetched S4/S5 reclassification gates | Slice 2 convergence and Slice 4 clean-install proof — terminal here | The existing-host read-authority rail remains until Slice 2 convergence; clean installs use the canonical store | CI `33021179620`, `33025592649`, PRs #57–#67, and final `33171581700`; exact-head held-out receipt below |
| Gmail | PR #49 (`google-gmail-connector`, `gmail-store-lane`) | PR #49 (`gmail-content-provider`) | PR #49 (`gmail-head-cursor-rejection-scope`, store-lane scheduler tests) | shared coverage tests plus Gmail store/status tests | shared EvidencePack/Analyst sovereignty tests and trust-separated store routing | Slice 2 convergence and Slice 4 clean-install proof — terminal here | legacy replay and existing-host read-authority rails remain until Slice 2 convergence | CI `33023803544` and final aggregate `33171581700`; exact-head held-out receipt below |

Repository-wide closure receipt:

- Frozen contracts and source-neutral architecture remain mechanically guarded
  by `contracts-freeze`, `architecture-guard`, the shared connector-store,
  EvidencePack, Analyst, scheduler-state, file-extraction, and source-dashboard
  suites. The final exact code is PR #71 merge
  `c04c80d70e3f6dc7df8c67b916970a512859af42`; local `verify` was 4,283
  passed/1 skipped/0 failed, local `verify:full` was 5,219 passed/2 skipped/0
  failed, and required CI run `33171581700` completed all nine jobs green.
- Shared WhatsApp transcript extraction is PR #56. Shared OCR/VLM/image
  escalation, post-extraction S4/S5 reclassification, honest coverage, and the
  source-neutral dashboard capability/status model are covered by the final
  full suite; no source-specific downstream or question-template exception was
  added to close the ledger.
- The unchanged seven-case private held-out eval on this exact final worker was
  7/7 for answers, citations, gap honesty, and privacy. The protected mode-0600
  report SHA-256 is
  `f6eddd49f742701fe33dc62f145597655a925562fd493f899acec8473c466942`;
  all seven cases completed, the five answer-bearing cases retrieved every
  expected value at rank 0, and no private values or paths are part of this
  receipt.
- Telegram natural answer run `08a6dcbf-e816-4cfe-9011-07b68fb5353d` and
  WhatsApp natural answer run `c5f5e6b1-f078-48fd-8897-34610abc4b6f`
  each made exactly one `source_answer` call, returned cited canonical-store
  evidence, and exposed no raw source material. Final exact-head denied-route
  session `8cee89ce-6415-4b1a-ae56-934acdc3976e`, run
  `24c9dcfe-4b60-45b6-bdb3-fc4ac3862e73`, made exactly one `source_answer`
  call and returned `source_index_policy_violation` directly, with no fallback,
  retrieval, generic `email_error`, or private-source output. Both messaging
  sources use the same typed fail-closed policy path.
- The accepted live-exit receipts also prove one completed post-deploy generic
  scheduler cycle per messaging source (cursor advance or deterministic
  tail-equivalence), zero selected-source gaps, new provider events reaching
  both capture spools, active capture helpers, shared WhatsApp transcription,
  inactive legacy store writers, and the dry-run-verified rollback sequence.
  The exact PR #71 archive SHA-256 is
  `6272d2ce30456ede81611fe8dcbe3ce9c305fdd6c000c00cd5533f46ffaa0cfe`.
  One canonical Gateway restart produced MainPID `356760`, InvocationID
  `6c99b4df96594be88e40648a3dc5e826`, active since
  `Fri 2026-08-28 14:05:33 WEST`; full health was 21 loaded/0 errors and
  Telegram connected. One worker-only restart after exact checkout alignment
  produced MainPID `358446`, InvocationID
  `3bc4b1315efc4e45a1dad8b0f5998d47`, active since
  `Fri 2026-08-28 14:09:31 WEST`, with 7 constructed/0 skipped/7 selected and
  bounded authenticated health `ok`. Installed and worker `dist/index.js`,
  `dist/cli.js`, and manifest hashes match the exact PR #71 artifacts. Gateway
  identity remained unchanged through worker activation and final acceptance;
  configuration had no semantic delta and no secrets were touched.

Open Slice 1 residuals: none. Observed Gmail/Dropbox convergence and authority
cutover are the first Slice 2 tranche, not deferred Slice 1 defects.

The PR #65–#67 durability tranche completed the source-neutral normalized-
locator projection and bounded backfill, opaque in-page continuation,
checkpoint compatibility, cooperative yielding, and changed-page replay.
Dropbox containment was removed through the reviewed activation ceremony. At
Slice 1 closure, its existing-host read-authority rail and migration-era
deletion remained assigned to Slice 2; Slice 2 has since removed them. No Slice
1 completion claim depends on altering the private eval truth or weakening a
fail-closed gate.

Update only this register and durable capability evidence as work lands; do not create competing milestone plans.
