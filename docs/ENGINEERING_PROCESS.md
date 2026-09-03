# Olympus Engineering Process

Status: canonical

Owner-ratified reset: 2026-08-29

This document is the single process authority for changing Olympus. Product
scope stays in `V0_4_RELEASE.md`, source-pipeline architecture stays in
`CONTRACTS.md`, and live OpenClaw changes stay in
`ops/OPENCLAW_CHANGE_PROTOCOL.md`. Historical work orders and handoffs are
evidence, not instructions.

## Outcome

Optimize for fast, safe integration:

- feedback in seconds while editing;
- one short-lived pull request per coherent change;
- complete CI on every pull request;
- stronger proof only when the changed risk demands it;
- the exact tested result is what may be released; and
- merged branches and worktrees disappear instead of becoming inventory.

No work order, handoff document, clean working tree, or full local suite is a
precondition for ordinary implementation. A direct owner request authorizes
the scoped work in any harness. An issue is an inbox item, not authorization.

## One delivery path

1. **Claim the surface.** Inspect active branches/worktrees before overlapping
   work. The main checkout remains on `main`; implementation uses a dedicated
   short-lived `codex/*` branch and worktree when parallel work is possible.
2. **Make the smallest coherent change.** Keep unrelated cleanup out. Use TDD
   when a behavior is subtle, a regression is being fixed, or the test is the
   clearest executable specification. Do not write low-value tests merely to
   satisfy a universal ritual.
3. **Run focused local proof.** Run the narrowest relevant test, typecheck,
   build, lint, render, or smoke check. `bun test <files>` and
   `bun run test:focus -- <files>` are the normal loop. `bun run verify` and
   `bun run verify:full` remain available for uncertainty and release work;
   neither is a push prerequisite.
4. **Commit and push.** Stage only task files. Olympus owns no local Git hook:
   mutable clone/worktree configuration is not a trustworthy merge boundary,
   and no push should pay for a bypassable duplicate quality gate. Protected
   `main` rejects direct pushes; required CI evaluates the immutable result.
   User-installed hooks remain user-owned and must not be rewritten by repo
   automation.
5. **Let CI decide merge readiness.** GitHub requires every substantive lane
   directly: `static checks`, `fast tests`, all three `deploy tests` shards,
   `Go bridge tests`, and `critical-review`. A local result is useful evidence,
   never a substitute for those exact-head checks.
6. **Review in proportion to risk.** Standard changes may auto-merge after
   required checks. Critical changes require a recorded independent review.
   Live mutations additionally follow the OpenClaw change protocol and remain
   separately authorized.
7. **Squash, prove main, and clean up.** Merge one coherent pull request as one
   commit, then follow the `verify` workflow triggered for that exact `main`
   SHA. The implementing session owns a red post-merge run: inspect the failing
   step, distinguish product failure from runner/capacity failure, and either
   repair it or report the unresolved blocker. A green pull-request head is not
   the final receipt for repository delivery. Remove the branch and worktree
   after exact-main is green. Git history and the pull request are the audit
   trail; do not create a second narrative ledger.

## Risk classes

Risk is derived from changed surfaces and declared behavior, not from who made
the change.

| Class | Examples | Required proof |
|---|---|---|
| Standard | docs, ordinary product behavior, bounded refactors, test-only changes | focused local proof; required CI |
| Critical | source contracts, security/trust routing, credentials, destructive data behavior, install/uninstall, lifecycle and service-manager behavior, managed system paths, upgrade/rollback, CI/governance, release provenance | focused proof; required CI; independent review receipt; relevant eval or migration proof |
| Live | deploy, restart, provider mutation, production data or secrets | all critical proof plus explicit live authorization and the canonical live-change protocol |

The repository's classifier is fail-closed: unclassified sensitive surfaces
are critical. A declaration may raise risk but may not lower a path-derived
classification.

On a critical pull request, a fresh-context reviewer examines the current head
and the relevant invariant, then posts the exact receipt produced by:

```sh
bun scripts/critical-review-receipt.ts <40-character-head-sha>
```

The `critical-review` publisher reads live GitHub API state from the protected
default branch, never checks out or executes pull-request code, and records a
commit status on that exact head. A later commit has a different SHA and starts
pending automatically; it cannot inherit the older receipt. The substantive CI
lane contexts remain separately required, so recording review does not rerun
full CI or wait for CI to finish. The publisher also re-evaluates every open
pull request when `main` advances, keeping policy changes convergent.

This is a mistake-prevention boundary, not an adversarial authorization system:
a repository administrator can change repository workflows and rules. A
dedicated GitHub App is intentionally deferred unless that threat model changes.

## Contract evolution

`SourceConnector`, `EvidencePack`, and `Analyst` are stable, versioned product
contracts. Compatibility is the default, not permanent immobility. A semantic
contract change must include, in the same pull request:

- a version increment;
- the changed canonical contract fingerprint;
- a compatibility or migration note;
- focused contract tests and the relevant held-out evaluation receipt; and
- critical-change review.

The contract gate rejects shape drift without those artifacts. Architecture
rules remain invariant: only `SourceConnector` is source-specific; downstream
capabilities are shared; the Analyst contains no question-specific path.

## Incidents and gates

Every incident receives one explicit disposition: fix the root cause, subtract
the unsafe mechanism, observe it, add a gate, or accept the residual risk. A
new blocking gate is justified only when the failure is deterministic,
recurring or expensive, and cheap to detect. Each blocking gate records:

- the failure it prevents;
- its owner;
- expected runtime and false-positive budget; and
- a retirement condition.

This keeps incidents from turning into permanent latency by default.

## Focused proof and CI triage

Choose local proof from the changed surface instead of reflexively running the
full suite:

| Changed surface | Normal pre-push proof |
|---|---|
| TypeScript behavior | closest affected test file; add `typecheck` when exported types or cross-module wiring changed |
| CI workflow, risk policy, or process enforcement | the matching workflow/risk test plus syntax or structural inspection |
| Shell or operational script | its focused test and `shellcheck` for the changed script |
| Generated `dist/` output | `bun run dist:check` after the focused source test |
| Source-pipeline contract or architecture | contract/architecture tests and the held-out eval required by the contract gate |

When CI is red, start from the exact job, step, and test rather than rerunning
the whole workflow. Reproduce deterministic failures with the narrowest local
command. One rerun is useful to classify a suspected runner flake or billing
failure; repeated reruns are not proof and do not replace a root-cause
disposition. Rerun only failed jobs when the failed boundary is external, and
cancel obsolete pull-request runs instead of paying for results that can no
longer merge.

## Legacy hook retirement

Clones created before 2026-08-29 may retain an Olympus-owned `core.hooksPath`
even after the tracked hook disappears. Inspect every reported origin with
`git config --show-origin --get-all core.hooksPath`. Remove only a clone- or
worktree-local value equal to `.githooks` or to a registered Olympus
worktree's `.githooks` directory; preserve unknown, global, system, and
user-owned hook paths. The migration is an explicit one-time clone operation,
not repository automation.

## Build and release identity

CI should build release material once and retain a provenance receipt binding
the source commit/tree, dependency lock, workflow, and artifact digest. A
consumer may promote only an exact matching receipt. Until that receipt path is
accepted by the deploy gate, the existing exact-SHA green-main check remains
authoritative; any mismatch falls back to a full main run rather than skipping
proof.

## Budgets and measurement

- Local push gate: zero repository-owned hook time.
- Pull-request CI target after the setup/cache reset: p95 at or below 70
  seconds; investigate sustained regression above 90 seconds.
- The review publisher runs in parallel and must not extend the slowest
  substantive CI lane. Unrelated comments and non-base pull-request edits
  allocate no runner. One `main`-push backfill minute replaces stale-policy
  risk; a critical receipt costs one short publisher minute instead of another
  full-CI run.
- Unknown tests use a conservative measured p95 for shard placement. Timeouts
  are diagnostic ceilings and only a cold-start scheduling fallback.
- Toolchain-specific tests use a co-located, fail-closed lane declaration. The
  Go lane is the sole writer of its versioned build cache; generic shards never
  publish an empty cache on its behalf.
- Re-measure shard balance, setup time, flakes, reruns, and time-to-green after
  each topology change. Optimize wall time first; billed minutes are secondary.

## Exceptions

Emergency bypasses do not redefine the process. Record why a check could not
run, preserve the branch, and restore missing proof before merge or release.
Admin rights are recovery capability, not a routine integration path.
