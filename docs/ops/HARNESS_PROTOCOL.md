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
- The active implementer owns its change end to end: focused proof, a commit
  straight to `main`, push, and green CI on that `main` commit (fix forward
  when red). No pull request or review wait.
- Risk comes from the change. A second-model review is for credential paths,
  deleting or migrating data, permissions, money or a public release,
  whichever harness made the change.

## Shared-repository coordination

Work on `main`. A cloud thread has its own clone. A Mac session works in the
shared checkout when it is clean and on `main`, and takes a worktree only when
it isn't. Stage only your own files, preserve unrelated changes, pull in
`main` before pushing and retry a rejected push.

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
