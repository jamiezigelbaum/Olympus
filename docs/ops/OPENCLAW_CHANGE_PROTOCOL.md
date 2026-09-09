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
   touched, the wrapper also runs `openclaw secrets audit --check --allow-exec --json`.
   Its supported audit-v1 classifier accepts clean/exit-0 reports or
   findings/exit-1 reports containing only the exact native OAuth
   `LEGACY_RESIDUE`/`info` records: the upstream OAuth out-of-scope message,
   provider/profile identity, matching `profiles.<profileId>` path, and a
   scanned `openclaw-agent.sqlite` file, or a normalized absolute
   `state/openclaw.sqlite` path with the OpenClaw 2026.9.2 extended v1 summary.
   The only supported summary shapes are the original four counts and those
   same counts plus `storeResidueCount`, which must be zero. Resolution must
   be complete with no skipped exec refs, and every summary count must agree.
   Native OAuth login remains intact. Plaintext, shadowing, unresolved refs,
   shared-store residue, other legacy residue,
   unknown or malformed records/reports, inconsistent status/counts/exits, and
   command failures all refuse restart. The wrapper prints fixed verdicts;
   upstream audit bodies and errors are never copied into restart output.
4. **Restart ONLY via the sanctioned wrapper:**
   `scripts/ops/openclaw-safe-restart.sh` (merged 2026-07-16) — it runs the
   platform-appropriate credential preflight, the validate/lint gates, and
   exactly one official `openclaw gateway restart` command. On Linux it proves the current boot
   with three required facts: **identity** — complete, active `MainPID`, `InvocationID`, and
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
   a specific plugin loaded requires a capability check against the actual
   authenticated Gateway, never the boot line. In OpenClaw 2026.9.2, plain
   `plugins inspect` is a cold registry check and `--runtime` loads the plugin
   in the inspecting CLI process; neither proves the running Gateway adopted
   that artifact. On failed boot: `openclaw gateway
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

## Darwin controlled activation

The native Darwin branch of `scripts/ops/openclaw-safe-restart.sh` is scoped to
OpenClaw 2026.9.2 and its existing, active default-profile LaunchAgent
`ai.openclaw.gateway`. It uses `lib/gateway-darwin-proof.mjs`; it never emulates
systemd output or invokes a launchctl lifecycle action directly. Its one
official `openclaw gateway restart --preserve-definition` command keeps the
inspected LaunchAgent definition intact; the qualified CLI otherwise may
rewrite it. This is a one-command guarantee, not a claim of one launchctl
mutation: OpenClaw owns the command's internal lifecycle operations, including
stale-PID cleanup and any service restart retry. The wrapper never issues a
second restart command. Managed startup inputs must remain unchanged across
the command. Other host
versions, profiles, service wrappers, or incomplete native metadata refuse
until their contracts are independently qualified.

Before installing or replacing plugin code, the platform owner records the
original `gateway.reload` setting and uses the blessed configuration CLI to
set `gateway.reload.mode` to `off`. Verify that authored setting before the
managed plugin install. On 2026.9.2, code/install metadata changes require a
Gateway restart and hybrid reload schedules it automatically; enablement or
ordinary plugin configuration reload does not rescan plugin code. The wrapper
requires `off` so installation cannot delegate an unreviewed extra restart to
the watcher. After the one wrapper restart and boot proof, restore the original
reload setting through the blessed CLI, including `unset` when it was absent.
Changing `gateway.reload` itself is not restart-triggering on the qualified
host. Never use raw config writes or an extra restart to restore the setting.

The Darwin preflight obtains the official `gateway status --no-probe --json`
service descriptor, verifies its default-profile plist, and accepts only the
exact native generated literal environment wrapper (`env_file="$1"`, with
its qualified quoting and whitespace) followed by the declared Node
OpenClaw entry point. It parses the owner-only environment file without
executing shell syntax, does not borrow unrelated operator-shell credentials,
and rechecks managed input bytes before mutation. The CLI must report valid,
matching CLI/daemon config paths. Plaintext environment values and audit
bodies are never printed or placed in a temporary file.

Credential readiness is mandatory on every Darwin restart, including when no
credential edit was requested: native `config validate`, noninteractive error
lint, then `secrets audit --check --json` **without `--allow-exec`**. The audit
must match the supported complete v1 shape, report zero skipped exec refs,
zero plaintext/unresolved/shadowed findings, and only the exact native OAuth
information already permitted by step 3. Local env/file/store SecretRefs are
resolved by the installed native auditor; native OAuth is not falsely treated
as a broken SecretRef. Any exec reference, external broker environment, custom
startup loader, incomplete audit, or unrecognized wrapper refuses before the
restart. It requires a deployment-owned credential readiness procedure; the
absence of a Linux broker client is never a waiver. The qualified Air metadata
has four file refs and no exec provider, so this native audit is the relevant
credential gate. No credential contents are part of that qualification record.

A successful Darwin boot proof requires all of the following together:

- The real launchd job is running and supplies its PID. Native process metadata
  binds that PID to the expected Node executable, user, and process start time
  captured in UTC. The PID/start pair must differ from the captured pre-restart process.
- Native `lsof` reports the exact expected loopback listener owned by that PID,
  with no unexpected process or wildcard listener on the configured port.
- A bounded, proxy-free loopback HTTP request returns a 2xx response.
- The managed stdout log, held open before restart, contains an exact complete
  timestamped listening line in bytes appended after the captured frontier.
  Its timestamp must be at or after the next whole second beyond the FINAL
  process's captured UTC start and no later than the observation time. Native
  `ps` reports seconds, so this conservative margin rejects ambiguous
  same-birth-second lines as well as older predecessor lines. An untimestamped
  line, a genuine startup that logged within that ambiguous first second, log
  rotation/truncation, oversized append, or missing/partial line fails closed.
- PID, start time, executable and listener ownership remain the same after
  the HTTP/log checks. The log corroborates that identity and function; it
  does not certify either on its own or identify the loaded plugin artifact.

`--dry-run` performs no checks. Darwin `--preflight-only` reads the native
service context needed for credential validation but never restarts or claims
a new boot. Failure after the single official command reports an unproven
boot and requires diagnosis; the wrapper does not automatically reissue it.
The final PID/start fence and current-process log-time check apply even if
OpenClaw internally replaced an earlier startup attempt during that command. Root/platform custody
owns live adoption and the authenticated plugin capability check. Fixture tests
qualify the parsers and refusal branches only; they are not a real rehearsal.

Gate owner: platform operations. Failure prevented: a foreign listener, stale
process/log, or unproved credential dependency being accepted as successful
activation. Runtime budget: bounded native preflight commands plus the
configured boot deadline (90 seconds by default, at most 600). Unsupported
metadata or log rotation intentionally refuses rather than guessing. Retire or
extend these version/format bounds only after independent review and real
qualification of the replacement platform contract. Linux credential and
systemd proof behavior remains unchanged.

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
