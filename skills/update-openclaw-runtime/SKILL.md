---
name: update-openclaw-runtime
version: 0.1.0
description: Update Olympus behavior from inside the OpenClaw installation by patching the docs, skills, installed runtime, and live smoke paths the assistant actually sees.
triggers:
  - user asks to update OpenClaw behavior, Castor routing, a skill, resolver, installed Olympus, or the live OpenClaw runtime
  - a source tool behaves differently in Castor than local tests predict
  - an assistant uses the wrong tool because live workspace docs or installed skills are stale
tools:
  - shell
mutating: true
---

# Update OpenClaw Runtime

Use this skill when changing Olympus behavior that affects Castor, Argus, or
another OpenClaw-facing assistant.

## Contract

Think from inside the OpenClaw installation. The behavior the user sees is
shaped by the checked-in repo, the installed Olympus extension, long-running
source workers, and the workspace docs injected into the agent context.

Do not conclude a behavior fix is complete until the inside-harness surfaces
match the repo change.

## Live-System Change Protocol

Canonical owner: `docs/ops/OPENCLAW_CHANGE_PROTOCOL.md` in the Olympus repo
(packaged at `../../docs/ops/OPENCLAW_CHANGE_PROTOCOL.md` relative to this
skill). Read it before every live change. If it is unavailable, stop: do not
mutate the live system from a remembered digest.

<!-- OPENCLAW_PROTOCOL_NORMATIVE_SHA256: f678ce4973818b77947a55be0741fcf79f8cf76cd5d678a7be61656858d0d421 -->

Before touching live OpenClaw config, secrets, plugins, skills, cron, services,
gateway state, install state, or workspace context, follow this order:

1. Contract first. Look up the exact interface with `openclaw docs <query>`
   and/or gateway `config.schema.lookup`; use `docs.openclaw.ai/llms.txt` when
   needed. Match an existing entry of the same kind. Never invent a key,
   provider, or manifest field from memory.
2. Blessed pathway only. Use `openclaw config set|unset` or gateway
   `config.patch`, never a raw `openclaw.json` edit. Secrets use SecretRef and
   protocolVersion-1 providers. Secrets changes belong to the 1P workstream.
3. Validate before restart with exactly:
   `openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive`.
   If secrets or providers changed, also run
   `openclaw secrets audit --check --allow-exec`.
4. Restart the gateway only through
   `scripts/ops/openclaw-safe-restart.sh`. It owns quota preflight, validation,
   one restart, and post-restart functional proof. If the wrapper is absent, stop
   and ask the operator to run the change from the Olympus source repo; do not
   substitute a direct gateway or systemd restart. Boot proof requires all
   three: complete active `MainPID` / `InvocationID` /
   `ActiveEnterTimestamp` identity from systemd, a bounded successful loopback
   HTTP response, and any exact `[gateway] http server listening (N plugins…)`
   line from that InvocationID's journal. Journal text is corroboration, never
   the load-bearing verdict: in-process code can emit a duplicate, so no
   ordering or timestamp rule distinguishes the real server. The operator
   verdict quotes the matching line. The line proves nothing per-plugin: it
   names only HTTP-route plugins, and providers or middleware load without
   appearing there. To claim a specific plugin
   loaded, use `openclaw plugins inspect <name>` → `Status: loaded`.
   Olympus runtime resume is read-only at this boundary: it never calls the
   wrapper or a Gateway lifecycle verb and refuses Olympus unit starts until
   the platform lane restores a different post-abort InvocationID that passes
   the same functional proof. Resume is single-owner, excludes the canonical
   `openclaw-gateway.service` even when a test override is present, and fails
   closed when the abort generation could not capture Gateway identity. The
   loopback responder-to-unit binding is an operational assumption supported
   by the systemd identity and journal corroboration, not direct socket
   attestation. Abort publication linearizes at its durable no-clobber
   generation link before a commit-barrier wait (one second by default,
   validated maximum five); the refresh crash-durably publishes every systemd
   hold condition before its first lifecycle mutation and daemon-reload,
   including parent fsyncs for every component of a new user-unit path, so the
   link immediately refuses new activation jobs while an absent or empty
   directory remains activation-safe. One shared activity classifier trusts
   only `active`/0, `inactive`/3, or `failed`/3; abort cleanup separately
   requires stop success and a trusted-inactive result. Timeout leaves the hold
   safely published.
   Successful removal of the empty hold directory is resume's commit point when
   no newer generation exists, but a success verdict also requires its
   parent-directory fsync; a removal or fsync failure is cleanup-only refusal.
   Commit-ready means the recorded unit set was fully processed, even when a
   lifecycle call failed and exit 79 must be preserved. Commit-ready crash recovery is
   cleanup-only and never repeats lifecycle calls. A newer unclaimed generation
   cannot gate old cleanup: it stays untouched for the next invocation while
   the current invocation refuses with exit 75. Marker, record, lock,
   recovery-link, and temporary-file custody must remain together on the private host's
   local ext4 filesystem.
5. If boot fails, collect `openclaw gateway stability --bundle latest` and use
   the `config set` `.bak.*` rotation as the recovery source through blessed
   config operations. Automated doctor repair is not a last-known-good undo.
6. Test one real item, inspect it, and only then enable or run the batch. Every
   incident must become a gate, subtraction, or deletion when possible.

## Checklist

1. Identify the OpenClaw-facing behavior that changed.
2. Update the owner source file or operation contract in `src/`.
3. Update the agent-facing skill in `skills/`.
4. Update `skills/RESOLVER.md` when routing or tool choice changes.
5. Update `skills/manifest.json` when skill names, descriptions, or discovery
   cues change.
6. Update `docs/roles/cto.md` when the change teaches a durable SOP or policy.
7. When milestone state, proof state, or next actions changed, record it in
   the newest dated anchor handoff under `docs/roles/cto/` and the owner
   ledger at `~/Code/Claude/STATUS.md` (the retired `PLAN.md` register is
   gone).
8. Build and test the repo path.
9. Update Olympus on the private host before live conclusions:
   - complete the live-system change protocol above before config, secret,
     install, workspace, service, or gateway mutations;
   - refresh the installed Olympus extension;
   - refresh any long-running worker source code touched by the change;
   - restart `olympus-email-source.service` when source-worker code changed;
   - when tool/skill/runtime docs changed, restart the OpenClaw gateway only
     through `scripts/ops/openclaw-safe-restart.sh` and retain its boot proof.
10. Inspect and update the OpenClaw workspace docs that are read into assistant
    context, especially `~/.openclaw/workspace/AGENTS.md` and
    `~/.openclaw/workspace/TOOLS.md`, when they contain stale routing guidance.
11. Run a natural OpenClaw agent smoke test, not only a direct local unit test.
12. Confirm the smoke used the intended tool lane and did not use a forbidden
    fallback such as shell, provider CLIs, OAuth setup, local DB files, or
    browser scraping.

## Source Routing Rule

When a source-search behavior fails in Castor, first check:

- the operation schema and worker implementation;
- the source-index router contract;
- the skill body that tells the assistant when to use the tool;
- `skills/RESOLVER.md`;
- live OpenClaw workspace docs;
- installed extension freshness;
- long-running source-worker freshness.

Only after those match should you diagnose model reasoning quality.
