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

**Owner ruling (Jamie, 2026-09-17): native OpenClaw processes only.** The
custom gates that grew around restarts and updates on the private host — the
install-approval touch marker, the wrapper-only restart rule, the
`--no-restart` / external-repair-policy habit — were retired after they turned
a routine core update into two failed attempts and a rollback. Do not
reintroduce them. `scripts/ops/openclaw-safe-restart.sh` stays in this repo as
optional tooling for the Darwin Air host (see below); it is required nowhere.

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
   touched, also run `openclaw secrets audit --check --allow-exec --json` and
   read it: plaintext, shadowing, unresolved refs or store residue mean stop.
   The two known native OAuth `LEGACY_RESIDUE`/`info` records are accepted.
4. **Restart and update natively.** Restart with `openclaw gateway restart`,
   then `openclaw gateway status` and one real agent turn. The journal line
   `[gateway] http server listening (N plugins…)` proves the Gateway booted and
   nothing per plugin: it names only HTTP-route plugins, so providers and
   middleware load without appearing there. A claim that a specific plugin
   loaded needs `openclaw plugins inspect <name>` → `Status: loaded`.
   Core updates: copy `state/openclaw.sqlite` first (Doctor changes table
   columns without bumping the schema version, so the previous core refuses the
   newer database), compare `npm view openclaw engines` with the managed Node,
   then run plain `openclaw update`. It stops the Gateway, installs, runs
   Doctor, syncs official plugins, restarts, verifies the reported version and
   rolls back to the previous generation on failure. Do not pass
   `--no-restart` on a running Gateway (Doctor cannot take its lock) and never
   run `openclaw update repair` (documented bug: it strips `plugins.allow`
   after a failed plugin update). One change per restart. Tenants request
   restarts from the platform lane and never issue lifecycle verbs. On a failed
   boot: `openclaw gateway stability --bundle latest`; a broken-config restart
   poisons `last-good`, so the `config set` `.bak.*` rotation is the real undo,
   not `doctor --fix`. The private host's 1Password pool is shared (~1000
   reads/day) and a restart spends about eleven of them: avoid restart storms,
   not restarts.
5. **Olympus runtime resume boundary.** Olympus runtime resume never issues a Gateway lifecycle verb. It only performs the
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
6. **Test-before-bulk** (gbrain rule): one item, review, then batch. Applies
   to secret migrations (one ref → verify its consumer → batch) AND to
   automated lanes (a new lane's timer stays disabled until one real item is
   processed and inspected live — 2026-07-07 VLM incident).
7. **Every incident gets an explicit disposition** — fix, subtract, observe,
   gate or accept — and a blocking gate only for a deterministic, recurring
   failure that is cheap to detect, with its owner and retirement condition
   recorded.

## Darwin controlled activation (Olympus Air host; optional wrapper)

The native Darwin branch of `scripts/ops/openclaw-safe-restart.sh` is scoped to
an existing, active default-profile LaunchAgent
`ai.openclaw.gateway`. It uses `lib/gateway-darwin-proof.mjs`; it never emulates
systemd output or invokes a launchctl lifecycle action directly. Its one
official `openclaw gateway restart --preserve-definition` command keeps the
inspected LaunchAgent definition intact; the qualified CLI otherwise may
rewrite it. This is a one-command guarantee, not a claim of one launchctl
mutation: OpenClaw owns the command's internal lifecycle operations, including
stale-PID cleanup and any service restart retry. The wrapper never issues a
second restart command. Managed startup inputs must remain unchanged across
the command. Release numbers are not compatibility gates: the native status,
service-wrapper, credential, and boot checks determine whether the installed
runtime is supported. Other profiles, unsupported service wrappers, and
incomplete native metadata still refuse before mutation.

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
- A bounded, proxy-free loopback HTTP request returns a 2xx response when
  effective `gateway.tls.enabled` is false. When it is true, the proof uses
  Node's built-in HTTPS client with the configured public `certPath` as its
  trust anchor, normal hostname validation (`rejectUnauthorized: true`), and
  a TLS 1.3 minimum. It never reads `keyPath`, uses `caPath` as an outbound
  trust shortcut, follows redirects, or consults proxy environment variables.
  `OPENCLAW_GATEWAY_URL`, port, and any supported TLS environment overrides
  must resolve to the exact managed `127.0.0.1` endpoint and effective config;
  a mismatch refuses.
- The managed stdout log, held open before restart, contains an exact complete
  timestamped listening line in bytes appended after the captured frontier.
  Its timestamp must be at or after the next whole second beyond the FINAL
  process's captured UTC start and no later than the observation time. Native
  `ps` reports seconds, so this conservative margin rejects ambiguous
  same-birth-second lines as well as older predecessor lines. An untimestamped
  line, a genuine startup that logged within that ambiguous first second, log
  rotation/truncation, oversized append, or missing/partial line fails closed.
- PID, start time, executable, listener ownership, and watched certificate
  inputs remain the same after the HTTP(S)/log checks. The log corroborates
  that identity and function; it does not certify either on its own or identify
  the loaded plugin artifact.

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
extend these metadata/format checks only after independent review and real
qualification of the replacement platform contract. Do not add release-number
allowlists as substitutes for checking the required capabilities. Linux credential and
systemd proof behavior remains unchanged.

## Known sharp edges (dated)

- **`openclaw config get` REDACTS secrets** (2026-07-06 zigelbot-Air
  lockout): never capture values through it — read `openclaw.json` or its
  `.bak.*` rotation directly. Claude-side this is hook-enforced.
- **`doctor --fix` can plant a delayed crash** (2026-07-07): its state
  migration surfaced a dangling SecretRef in agent/plugin state (NOT
  openclaw.json, so `config validate` stayed green) → crash-loop ~90 min
  later. After `doctor --fix`: restart, check `openclaw gateway status` and
  run a real turn before walking away. Dangling-ref fix: alias the missing provider
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
