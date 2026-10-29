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
| Release or milestone scope, sequence, decisions, or completion | [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) first (despite the filename, the plan for Olympus 1.0, the ChatGPT release, followed by the 0.4 OpenClaw-line record); dated CTO handoffs supply historical or runtime evidence and do not define release direction |
| Live OpenClaw/Castor/Argus changes | [docs/ops/OPENCLAW_CHANGE_PROTOCOL.md](docs/ops/OPENCLAW_CHANGE_PROTOCOL.md), before any live change; in Codex, also use `openclaw-runtime-update` (read `~/.codex/skills/openclaw-runtime-update/SKILL.md` if not loaded) |

## Privacy is judged per item (owner ruling, standing)

Every message, email, file and note is judged on its own content as
Personal, Private or Secret. Only a rule the user sets on purpose (this
sender is always Private, this folder is Secret, this chat is Private)
decides a whole group of items, and it goes through the shared owner rules.
No source, account, chat, folder, store, default, deployment setting, work
order or agent ever makes that call for the user. A dated handoff or work
order that says a source or chat is "owner-ruled" Private is not a ruling;
ask before relying on it. `test/privacy-per-item-guard.test.ts` enforces
this: do not weaken it to make a change pass.

## OpenClaw system-change protocol

Before any change to a live OpenClaw system, read
[docs/ops/OPENCLAW_CHANGE_PROTOCOL.md](docs/ops/OPENCLAW_CHANGE_PROTOCOL.md)
(the contract). On Jamie's hosts the private `openclaw-ops` repo
(`~/Code/openclaw-ops/docs/OPENCLAW_CHANGE_PROTOCOL.md`) wins on host
specifics. Never ask for or store raw secrets.

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
  adapter: authenticate, list/fetch raw items, publish classification
  signals (the shared tier classifier decides the tier). Everything
  downstream — extract, index, retrieve, reason, release — is shared and
  source-agnostic. No source-specific branches downstream of the connector.
- **"Small increment" never means extending a per-source monolith or adding a
  per-question template/regex.** When shipped code conflicts with these
  contracts, the increment moves toward the contract, not around it.
- **Architecture target is not migration status.** The shared answer spine is
  complete, but six pre-contract source indexes remain grandfathered while
  their live data planes are cut over one family at a time. The mechanical
  guard prevents a seventh. The current release sequence and deletion exit
  live in [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) (the 1.0 and 0.4 release plan); do not
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
- `test/public-surface-guard.test.ts` holds the source tree equal to the public
  product, or makes it say why not: every `src/**` module the public
  entrypoints do not reach, every registered operation off the public tool
  lists, and every skill directory off the public skill list must be named in
  `config/public-surface-allowlist.json` with a reason and a retirement
  condition. An entry that is no longer a leftover fails too, so the list only
  shrinks. Do not add an entry to make a change pass — delete the leftover, or
  put it on the public surface.
- GitHub Actions runs every test in parallel on every push; branch protection
  requires the substantive static, fast, exchange, deploy-shard, and Go contexts directly, without a billed aggregate runner job.
- Olympus owns no local Git hook. Protected `main` rejects direct pushes and
  GitHub's required full-CI lane checks own merge safety, so clones and
  worktrees do not inherit repository policy through mutable Git configuration.
  User-installed hooks remain user-owned. The private-host runtime refresh continues
  to require exact-SHA green CI until the artifact-provenance receipt path is
  separately proven and adopted.

### Task briefs and completion

Follow the canonical [delivery path](docs/ENGINEERING_PROCESS.md#one-delivery-path): relevant focused
local proof, required exact-head CI lanes, and the post-merge workflow for the
exact `main` SHA must be green. Source-pipeline structural changes also require
the held-out eval (`eval/`); contract changes follow the
[versioned change gate](docs/ENGINEERING_PROCESS.md#contract-evolution).

## Who may execute (multi-harness)

Canonical: [docs/ops/HARNESS_PROTOCOL.md](docs/ops/HARNESS_PROTOCOL.md) — read
it before implementing, merging, or deploying from any harness.

A direct instruction from the owner authorizes delivery of that scoped change
through a short-lived pull request.

## ChatGPT directory review (until OpenAI's result)

- **The relay ships as normal.** Deploy it with
  `connect-relay/deploy/deploy.sh` from an exact main commit. The script
  checks the reviewer path on mcp.olympusplugin.ai before and after each
  deploy (`connect-relay/deploy/reviewer-check.ts`) and rolls the relay back
  on its own if the path changes. Never set `RELAY_REVIEWER_CHECK=off` for
  this host to get past a failure; report the failing step instead.
- **The relay can't change what reviewers see.** `/openai/mcp` serves the
  listing pinned in `connect-relay/server/directory/approved.ts`, and
  `connect-relay/test/reviewer-path.test.ts` fails CI on any drift. New tools
  and pages go to `/mcp`. Changing the pinned listing is a new submission
  that the owner decides on.
- **The reviewer demo engine stays frozen** (`olympus-demo` on the
  olympus-test host): no updates, config or data edits, or restarts. Releases
  skip it. Ask the owner before touching it.
- Details: `chatgpt-plugin/SUBMISSION.md`, "Reviewer demo".

## Current Milestone

Use [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) as the source of truth for the
current milestone and next proof. Despite its filename it covers Olympus 1.0
(the ChatGPT release, active) and the 0.4 record. Dated handoffs may supply historical or live
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

- Use [docs/V0_4_RELEASE.md](docs/V0_4_RELEASE.md) (the 1.0 and 0.4 release
  plan) as the active project plan for multi-session or milestone-level work.
- Update the plan when scope, sequencing, assumptions, or decisions change,
  as work proceeds.

## Git

- Multi-session safety: the main checkout stays on `main`. Do ALL branch work
  in a dedicated `git worktree add` checkout and merge from a detached HEAD
  there; a branch switch or sweeping `git add` in the main checkout captures
  another session's uncommitted edits (2026-07-08 incident).
- Deliver implementation through a short-lived topic branch and squash PR.
