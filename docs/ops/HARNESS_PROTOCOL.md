# Multi-Harness Entry Point

Status: compatibility entry point

The canonical cross-harness development process is
[`../ENGINEERING_PROCESS.md`](../ENGINEERING_PROCESS.md). Claude Code, Codex,
Castor, and future harnesses use the same delivery path and quality bar.

## Authority and roles

- A direct instruction from the owner authorizes any harness to implement and
  deliver that scoped repository change. No work order or harness-specific
  delegation ceremony is required.
- An issue is an inbox item, not authorization. A harness that merely observes
  an out-of-scope problem reports it without silently expanding its mandate.
- The active implementer owns integration for its scoped pull request: surface
  coordination, focused proof, commit, push, pull-request CI, squash merge,
  exact-main CI follow-through, and cleanup.
- Risk comes from the change. Critical changes need the independent review
  receipt defined by the engineering process regardless of which harness made
  them.

## Shared-repository coordination

Inspect active worktrees before editing. Keep the main checkout on `main` and
make overlapping work in one short-lived branch/worktree per pull request.
Declare owned files when another slice is active, preserve unrelated changes,
and serialize only the genuinely overlapping commit window.

## Live systems

A repository merge is not permission to deploy. OpenClaw, worker, provider,
credential, production-data, and lifecycle changes require the separately
authorized flow in
[`OPENCLAW_CHANGE_PROTOCOL.md`](OPENCLAW_CHANGE_PROTOCOL.md). Never hand-patch
the private host or Delphi; managed repository state and sanctioned refresh paths own
host changes.

The private-host write credential remains a separate repo-scoped key documented in
the private `olympus-ops` repository's
`docs/ops/PRIVATE_HOST_OLYMPUS_WRITE_CREDENTIAL.md`.
It may push topic branches only. Workspace repositories may continue their own
operational backup flow, but accumulated session content, memories, journals,
and ingestion state are never published.
