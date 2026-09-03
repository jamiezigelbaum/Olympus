# OpenClaw system-change protocol (CANONICAL)

This file is the single canonical copy. Everything else — Claude's global
CLAUDE.md, `~/.codex/AGENTS.md`, this repo's AGENTS.md, the private host's workspace
AGENTS.md — carries at most a short digest plus a pointer here. If you are
editing a digest, edit this file first. Newest dated secrets/quota rules live
in the auto-memory ledger (`memory/feedback_openclaw_change_protocol.md`,
maintained by the ops/1P threads); that ledger wins on secrets/quota
specifics.

Applies to every surface: Claude sessions, Codex work orders (put it in the
WO hard rules), and in-OpenClaw agents.

Before ANY change to a live OpenClaw system (config, secrets, plugins,
skills, cron, services), in this order:

1. **Contract first:** `openclaw docs <query>` and/or gateway
   `config.schema.lookup` for the exact field. LLM docs index:
   docs.openclaw.ai/llms.txt. Never write a config key or provider from
   memory/improvisation; match the pattern of existing entries of the same
   kind.
2. **Blessed pathway only:** `openclaw config set|unset` or gateway
   `config.patch` — NEVER raw edits to `openclaw.json`. Secrets follow the
   SecretRef contract (docs.openclaw.ai/gateway/secrets); exec providers must
   speak the protocolVersion-1 stdin/stdout envelope (on the private host, prefer the
   shared `op-cached-read` wrapper). **Secrets changes are owned by the 1P
   workstream — coordinate, don't freelance.**
3. **Validate before restart:** `openclaw config validate && openclaw doctor
   --lint --severity-min error --non-interactive`. If secrets/providers were
   touched, also `openclaw secrets audit --check --allow-exec`.
4. **Restart ONLY via the sanctioned wrapper:**
   `scripts/ops/openclaw-safe-restart.sh` (merged 2026-07-16) — it runs the
   quota preflight, the validate/lint gates, exactly one
   `openclaw gateway restart`, and proves the current boot with three required
   facts: **identity** — complete, active `MainPID`, `InvocationID`, and
   `ActiveEnterTimestamp` from `systemctl show`; **function** — the Gateway HTTP
   port returns a successful status to a bounded request on loopback; and
   **corroboration** — any exact
   `[gateway] http server listening (N plugins…)` line exists in that
   InvocationID's journal. All three are mandatory and failure is closed.
   Journal text is not load-bearing: an in-process plugin can emit an identical
   line before or after the real server, so no earliest/latest selection or
   marker-to-journal timestamp comparison can prove boot. Identity plus the
   answering socket carry the verdict; the journal line corroborates it and is
   quoted verbatim in the operator verdict. `systemctl is-active` alone seconds
   after a restart still proves nothing (2026-07-07: crash-loop began ~90 min
   later while every is-active spot-check passed). The boot line's plugin list
   corroborates the GATEWAY boot, nothing per-plugin: it names only plugins that
   register HTTP routes — providers and tool-result middleware load
   without ever appearing there (2026-07-25: `openai`, the primary model
   provider, absent from the line while serving live turns). A claim that
   a specific plugin loaded requires `openclaw plugins inspect <name>` →
   `Status: loaded`, never the boot line. On failed boot: `openclaw gateway
   stability --bundle latest`; note a broken-config restart poisons
   `last-good`, so the `config set` `.bak.*` rotation is the real undo, not
   `doctor --fix`.
   The OpenClaw Gateway is platform-owned: Olympus runtime resume never invokes
   this wrapper and never issues a Gateway lifecycle verb. It only performs the
   same read-only proof, requires an InvocationID different from the one
   captured in the abort generation, and refuses to start Olympus units until
   the platform lane has recovered the Gateway. Runtime holds are immutable,
   uniquely named generation files. One resume executor owns the transaction
   through a durable no-clobber lock inode plus a kernel-held exclusive lock.
   Before the refresh's first lifecycle mutation, it installs and
   daemon-reloads the hold condition for every static and dynamically
   discovered unit. It crash-durably publishes each drop-in: stage and fsync
   it, but first durably establishes the complete user-unit path by fsyncing
   every directory name in its parent, including on retries. It then renames
   the staged inode over its final name and fsyncs the final inode, its
   `<unit>.d` directory, and the user-unit directory before daemon-reload. The
   negated `ConditionDirectoryNotEmpty` permits normal activation while the
   hold directory is absent or empty. A fully written abort generation is then
   published with a durable no-clobber hard link, before any commit-lock wait;
   that link is the abort linearization point and immediately makes the
   already-loaded, crash-durable systemd conditions refuse new activation
   jobs. Conditions do not stop an already-active unit, so abort cleanup
   retains its stop-and-prove-inactive loop. A stop failure fails closed. One
   shared activity classifier accepts only the exact documented `systemctl
   is-active` pairs `active`/0, `inactive`/3, and `failed`/3; abort cleanup
   separately requires the successful stop and the trusted-inactive result.
   Missing, inconsistent, or query-error results all refuse. The publisher uses
   the commit lock only as a bounded coordination barrier: the default wait is
   one second and the validated configuration hard-caps it at five seconds.
   Timeout is a safe success path for hold custody because the generation
   already landed. Resume takes that lock nonblocking. Its successful `rmdir`
   of the empty hold directory is the resume-commit linearization point when no
   newer generation exists, but a success verdict additionally requires the
   parent-directory fsync; an fsync failure after removal is reported as
   refusal, never success. A
   publisher that linked first leaves a generation and forces cleanup-only exit
   75; if `rmdir` wins first, the publisher's bounded create/link retry
   recreates the directory and lands the hold. Any other `rmdir` failure or
   residue also fails closed. A `commit-ready` resume transaction means the
   recorded unit set was fully processed and every lifecycle call already ran,
   regardless of whether any call failed. The state is written before exit 79
   is reported. Every partial commit-link or removal state is cleanup-only:
   recovery deletes remaining transaction artifacts and never re-enters the
   lifecycle loop. A newer unclaimed generation cannot gate that old cleanup;
   it remains byte-untouched for the next invocation, and removal plus parent
   fsync of the last old transaction artifact is the cleanup-only commit point.
   The current invocation still refuses with exit 75 because the newer hold
   remains active. Cleanup also refuses if its final parent fsync fails.
   Resume durably records and atomically claims exactly one filename, retains
   recoverable commit links until its final late-publication checks pass and
   never removes an unclaimed generation. A non-commit-ready record still
   refuses when another generation exists. The canonical
   `openclaw-gateway.service` is always
   outside resume's manageable set; an override may add another excluded proof
   unit but cannot remove that canonical exclusion. If abort-time Gateway
   identity capture fails, the generation records `unavailable` and resume
   fails closed for platform-lane recovery. Marker wall-clock time is never
   compared with journal time.
   The HTTP leg proves that a successful responder occupies the configured
   loopback URL; binding that responder to the systemd unit is an operational
   assumption corroborated by the stable invocation identity and its journal,
   not a cryptographic socket-to-unit attestation.
   Runtime-hold custody depends on Linux local-filesystem semantics as deployed
   on the private host: the pause directory, resume record, owned marker, owner/commit
   locks, recovery links, and adjacent temporary files must remain on one local
   ext4 filesystem. The protocol relies on kernel `flock`, atomic same-filesystem
   `link(2)`/rename behavior, and directory `fsync`; NFS, FUSE, other network
   filesystems, and cross-filesystem path overrides are unsupported.
5. **Test-before-bulk** (gbrain rule): one item, review, then batch. Applies
   to secret migrations (one ref → verify its consumer → batch) AND to
   automated lanes (a new lane's timer stays disabled until one real item is
   processed and inspected live — 2026-07-07 VLM incident).
6. **Every incident becomes a gate, a subtraction, or a deletion — prose
   only when no gate is possible.**

## Known sharp edges (dated)

- **`openclaw config get` REDACTS secrets** (2026-07-06 zigelbot-Air
  lockout): never capture values through it — read `openclaw.json` or its
  `.bak.*` rotation directly. Claude-side this is hook-enforced.
- **`doctor --fix` can plant a delayed crash** (2026-07-07): its state
  migration surfaced a dangling SecretRef in agent/plugin state (NOT
  openclaw.json, so `config validate` stayed green) → crash-loop ~90 min
  later. After `doctor --fix`: restart via the wrapper and verify the boot
  line before walking away. Dangling-ref fix: alias the missing provider
  name to the real one via `config set secrets.providers.<name>`.
- **`gateway.tailscale.mode=serve` clobbers hand-managed funnels on its
  port** (2026-07-06, private host): every restart re-published `/` on 443 and
  flipped the port tailnet-only (`preserveFunnel:true` preserves routes, NOT
  the public-funnel flag). If a port carries an externally managed funnel,
  keep `mode=off` and publish with plain `tailscale serve --bg`. Current
  private-host topology: no funnel; gateway tailnet-only on 8443, mode=off.
- **1Password quota is one shared ACCOUNT pool (~1000/day)** — restarts,
  retries, and diagnostic probes all SPEND it. Workers read secrets through
  `op-cached-read`, never raw `op read` in anything systemd restarts. One
  deploy = one restart cycle; no exploratory restarts. Newest rules live in
  the memory ledger (2026-07-16 entry); the 1P thread owns remediation.
- **The cache-covered restart needs two deployment-owned overrides**
  (2026-08-31 split): when the broker reports `state=blocked` with
  `reason=broker_window_budget_exhausted`, the wrapper may still restart if
  every Gateway credential cache proves ready inside its max-stale window.
  That proof runs the credential cache readiness implementation and broker
  manifest, which now live in the private ops repository, so
  `scripts/ops/openclaw-safe-restart.sh` reads them from
  `OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT` and
  `OPENCLAW_SAFE_RESTART_BROKER_MANIFEST` and has no in-repo default. Unset on
  this installation means every rolling-window-blocked restart refuses with
  exit 75 until the window resets — set both (they are named in the refusal
  and in `--dry-run`) to keep that lane open.
