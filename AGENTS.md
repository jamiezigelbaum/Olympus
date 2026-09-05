# Olympus Agent Instructions

Olympus is an OpenClaw plugin.

## Velocity ruling (owner, 2026-07-30) — no calendar scheduling for ready work

A ceremony, deploy, or cutover runs the MOMENT its preconditions are
receipt-verified. "Next quiet window", "tomorrow morning", and post-soak
slots are abolished as defaults. A wait is legitimate only when a named
precondition is genuinely unmet (an artifact unbuilt, a proof missing, a
human-gated step where the human's availability is ASKED, never assumed).
In-flight reviews do not gate ready work unless the owner says so —
findings become follow-ups, and the rollback path being warm is what
makes that safe. When you catch yourself scheduling instead of executing,
that is the tell: name the actual unmet precondition or go.

## Project Identity

- Build a world-class OpenClaw plugin using current OpenClaw conventions.
- Use TypeScript and Bun by default.
- Follow GBrain's "Fat Skills, Thin Harness" ethos: plugin manifest, shared
  operations, CLI/MCP/tool surfaces, and skill-driven agent behavior.
- Keep deterministic mechanics in `src/`; keep judgment, routing, workflow,
  taste, and examples in `skills/` and docs.
- Treat Delphi, OpenShell, Castor maintenance, and host deployment as
  integration dependencies. This repo owns the plugin experience.

## Start Here

This file supplies the standing invariants. Read the smallest relevant source
files and the authorities below when the task reaches their surface; expand
context when dependencies or unresolved questions require it.

| Task surface | Read |
|---|---|
| Product orientation | [README.md](README.md) for the product shape |
| Source-pipeline implementation or architecture review | Relevant sections of [docs/CONTRACTS.md](docs/CONTRACTS.md) and [`src/core/contracts.ts`](src/core/contracts.ts), before writing pipeline code |
| Repository implementation or delivery | [docs/ENGINEERING_PROCESS.md](docs/ENGINEERING_PROCESS.md) and [docs/ops/HARNESS_PROTOCOL.md](docs/ops/HARNESS_PROTOCOL.md), before implementing or merging |
| Release or milestone scope, sequence, decisions, or completion | [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) first; dated CTO handoffs supply historical or runtime evidence and do not define release direction |
| Live OpenClaw/Castor/Argus changes | [docs/ops/OPENCLAW_CHANGE_PROTOCOL.md](docs/ops/OPENCLAW_CHANGE_PROTOCOL.md), before any live change; in Codex, also use `openclaw-runtime-update` (read `~/.codex/skills/openclaw-runtime-update/SKILL.md` if not loaded) |

## OpenClaw system-change protocol (non-negotiable)

Canonical: [docs/ops/OPENCLAW_CHANGE_PROTOCOL.md](docs/ops/OPENCLAW_CHANGE_PROTOCOL.md)
— read it BEFORE any change to a live OpenClaw system.

<!-- OPENCLAW_PROTOCOL_NORMATIVE_SHA256: f678ce4973818b77947a55be0741fcf79f8cf76cd5d678a7be61656858d0d421 -->

Digest: contract first (`openclaw docs <query>` / `config.schema.lookup`,
never from memory) → blessed pathways only (`openclaw config set|unset` or
`config.patch`, never raw openclaw.json) → validate with
`openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive`,
plus `openclaw secrets audit --check --allow-exec` when
needed → restart ONLY via `scripts/ops/openclaw-safe-restart.sh`. Boot proof
requires all three legs: complete active MainPID/InvocationID/
ActiveEnterTimestamp identity, a bounded successful loopback HTTP response,
and an exact `[gateway] http server listening (N plugins…)` line from that
InvocationID; the journal line is corroboration, not the verdict. On failure,
use `openclaw gateway stability --bundle latest` and the `config set` `.bak.*` rotation.
Runtime-hold flock/link custody stays on one local ext4 filesystem.
Refresh crash-durably publishes every systemd hold condition before lifecycle
mutation and daemon-reload, including ancestor-parent fsyncs for a newly
created user-unit path; the durable generation link then blocks new activation
jobs immediately. One shared activity classifier trusts only `active`/0,
`inactive`/3, or `failed`/3; abort cleanup separately requires stop success and
a trusted-inactive result. A completed lifecycle loop records `commit-ready`
before reporting failed units. Its cleanup is never gated by a newer unclaimed
generation, which stays untouched for the next invocation; non-commit-ready
records still refuse. Removal of the empty hold directory is the ordinary
resume commit point, but success also requires the parent-directory fsync.
Test before bulk. Never ask for or store raw secrets; secrets changes are owned
by the 1P workstream. Give every incident an explicit root-cause disposition;
add a blocking gate only when the criteria in `docs/ENGINEERING_PROCESS.md`
are met.

## Architecture (stable and versioned) — read before writing pipeline code

The source pipeline is governed by three stable contracts in
[docs/CONTRACTS.md](docs/CONTRACTS.md) /
[`src/core/contracts.ts`](src/core/contracts.ts): `SourceConnector`,
`EvidencePack`, `Analyst`. They encode one load-bearing rule: **organize by
capability, not by source.** The previous source layer ignored this and rotted
into ~16K lines of duplicated per-source index code plus per-question answer
templates and query regexes. That is the specific failure this architecture
exists to prevent. Rules of the road:

- **Only `SourceConnector` is per-source.** A connector is a thin (~300-line)
  adapter: authenticate, list/fetch raw items, classify trust. Everything
  downstream — extract, index, retrieve, reason, release — is shared and
  source-agnostic. No source-specific branches downstream of the connector.
- **"Small increment" never means extending a per-source monolith or adding a
  per-question template/regex.** When shipped code conflicts with these
  contracts, the increment moves toward the contract, not around it.
- **Architecture target is not migration status.** The shared answer spine is
  complete, but six pre-contract source indexes remain grandfathered while
  their live data planes are cut over one family at a time. The mechanical
  guard prevents a seventh. The current release sequence and deletion exit
  live in [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md); do not
  describe the thin-harness migration as complete until those exits pass and
  the corresponding legacy indexes are deleted.
- **No question-specific logic anywhere in the `Analyst`.** One generic prompt:
  answer from this evidence only, cite each claim, state what you could not
  find. No answer templates, no query regex classifiers, no per-question
  parsing. The pre-contracts template path was DELETED at the Lane F deletion
  milestone (2026-06-10); the Analyst is the only answer path, and the guard
  keeps the old path dead.
- **`coverage`/gaps and `facts` are not the answer.** Coverage is how the system
  says "I could not read these 3 PDFs." Structured facts are a cache that feeds
  the Analyst — never the only answer path.
- **The contracts are versioned, not casually mutable.** Ordinary changes
  implement them and never route around them with parallel types. A semantic
  change follows the version, compatibility/migration, eval, and critical
  review gate in `docs/ENGINEERING_PROCESS.md` and is recorded in the
  `CONTRACTS.md` change log.
- **Done = passes the held-out eval, not a demo.** A known-answer demo is
  gameable by a template; the held-out eval (`eval/`) is not. See
  [eval/README.md](eval/README.md).

Enforcement is mechanical, so this survives any thread or tool:

- Focused local checks are the normal edit loop. `bun run verify` and
  `bun run verify:full` are available when uncertainty or release risk merits
  them; neither is a push prerequisite.
- `test/architecture-guard.test.ts` fails the build if the deleted template
  path reappears or if template/regex answer code appears anywhere in src.
  Do not weaken the guard to make a change pass.
- GitHub Actions runs every test in parallel on every push; branch protection
  requires the substantive static, fast, deploy-shard, Go, and critical-review
  contexts directly, without a billed aggregate runner job.
- Olympus owns no local Git hook. Protected `main` rejects direct pushes and
  GitHub's required full-CI lane checks own merge safety, so clones and
  worktrees do not inherit repository policy through mutable Git configuration.
  User-installed hooks remain user-owned. The private-host runtime refresh continues
  to require exact-SHA green CI until the artifact-provenance receipt path is
  separately proven and adopted.

### Task briefs and completion

Frame implementation work with the outcome, relevant context, scope, and
done-when. Follow the canonical
[delivery path](docs/ENGINEERING_PROCESS.md#one-delivery-path): relevant focused
local proof, required exact-head CI lanes, and the post-merge workflow for the
exact `main` SHA must be green. Source-pipeline structural changes also require
the held-out eval (`eval/`); contract changes follow the
[versioned change gate](docs/ENGINEERING_PROCESS.md#contract-evolution).

## Who may execute (multi-harness)

Canonical: [docs/ops/HARNESS_PROTOCOL.md](docs/ops/HARNESS_PROTOCOL.md) — read
it before implementing, merging, or deploying from any harness.

Digest: a direct instruction from the owner authorizes any harness to implement
and deliver that scoped repository change through a short-lived pull request.
No work order is required. Issues remain an inbox, never authorization. Risk
comes from the changed surface: standard changes need focused local proof and
required CI; install/uninstall, lifecycle, service-manager, managed-path,
upgrade/rollback, and other critical changes also need an independent review
receipt; live changes retain their separate explicit authorization and
protocol. The implementing session owns the exact-main CI result after merge.

## Current Milestone

Use [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) as the source of truth for the
current milestone and next proof. Dated handoffs may supply historical or live
runtime evidence, but they do not override the release plan.

## Repo Ownership

This repo owns:

- OpenClaw plugin metadata and install experience.
- Olympus CLI.
- MCP/tool surfaces.
- Shared operation definitions.
- Skills and agent instructions.
- Plugin docs and tests.

This repo may document assumptions about external systems, but those systems
remain outside the repo's ownership.

## Planning

- Use [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) as the active project plan
  for multi-session or milestone-level work.
- Keep plans outcome-focused: state what the user can do after the work lands
  and how to prove it.
- Update the plan when scope, sequencing, assumptions, or decisions change.
- For narrow, obvious tasks, use a lightweight thread plan instead of adding
  process to the repo.
- When implementing a plan, update progress and decisions as work proceeds
  rather than leaving stale intent behind.

## Git

- Commits carry the owner's authorship only: never add AI co-author trailers
  (`Co-Authored-By: Claude/Codex/...`) or tool attribution to commit messages.
- Deliver implementation through a short-lived topic branch and squash PR.
- Multi-session safety: the main checkout stays on `main` at all times. Do
  ALL branch work in a dedicated `git worktree add` checkout (one worktree
  per branch) and merge from a detached HEAD there — never `git checkout
  <branch>` in the main checkout. Parallel sessions share it: a branch
  switch or sweeping `git add` there captures another session's uncommitted
  edits (2026-07-08 incident: a VLM-probe branch swept two files of another
  session's WIP).
- Stage files intentionally; do not use `git add .`.
- Make small, coherent commits when the user asks for tracked work.
- Preserve user changes. Do not revert unrelated edits.

## GitHub Access

- GitHub control-plane work (PRs, issues, remote inspection) → the GitHub
  plugin/app connector. Workspace coding, tests, commits, fetch/push → local
  Git over SSH. `gh` is an optional convenience, never a blocker.
