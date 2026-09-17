# OpenClaw system-change contract (Olympus)

Olympus is a tenant plugin inside an OpenClaw Gateway that someone else
operates. This file is the contract Olympus code, skills, and agents follow
toward that Gateway. It is deliberately generic: it names only native OpenClaw
commands and holds for any installation.

It is not an operator runbook. Host-specific procedure — secrets provider,
credential quota, backups, restart proof, upgrade rehearsal, incident history —
belongs to the deployment owner and lives with the deployment, not in this
product repository. On Jamie's hosts the canonical operator protocol is
`docs/OPENCLAW_CHANGE_PROTOCOL.md` in the private `Castor-Maintenance`
repository (checked out at `~/Code/Castor-Maintenance` on each machine); it
governs every live change there and wins on host specifics. Other harnesses'
instruction files carry at most a short digest plus a pointer.

**Owner ruling (Jamie, 2026-09-17): native OpenClaw processes only.** The
custom gates that had grown around restarts and updates — a wrapper-only
restart rule, an install-approval touch marker, the `--no-restart` /
external-repair habit — were retired after they turned a routine core update
into two failed attempts and a rollback. The restart wrapper and its Darwin
proof were deleted from this repository the same day. Do not reintroduce them.

## Contract

Before ANY change to a live OpenClaw system (config, secrets, plugins, skills,
cron, services), in this order:

1. **Contract first:** `openclaw docs <query>` and/or gateway
   `config.schema.lookup` for the exact field. LLM docs index:
   docs.openclaw.ai/llms.txt. Never write a config key or provider from
   memory; match the pattern of existing entries of the same kind.
2. **Blessed pathway only:** `openclaw config set|unset` or gateway
   `config.patch` — NEVER raw edits to `openclaw.json`. Secrets follow the
   SecretRef contract (docs.openclaw.ai/gateway/secrets); exec providers speak
   the protocolVersion-1 stdin/stdout envelope. Secrets changes belong to the
   deployment's secrets owner — coordinate, don't freelance.
3. **Validate before restart:** `openclaw config validate && openclaw doctor
   --lint --severity-min error --non-interactive`. If secrets/providers were
   touched, also run `openclaw secrets audit --check --allow-exec --json` and
   read it: plaintext, shadowing, unresolved refs or store residue mean stop.
   The known native OAuth `LEGACY_RESIDUE`/`info` records are accepted.
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
   after a failed plugin update). One change per restart. On a failed boot:
   `openclaw gateway stability --bundle latest`; a broken-config restart
   poisons `last-good`, so the `config set` `.bak.*` rotation is the real undo,
   not `doctor --fix`.
5. **Tenant boundary.** Olympus never issues a Gateway lifecycle verb. A
   plugin-bundle deploy ends with a "Gateway reload pending" request to the
   platform lane, which restarts natively. Olympus runtime resume only performs
   read-only Gateway proof and refuses to start Olympus units until the
   platform lane has recovered the Gateway. The private refresh/resume scripts
   that implement that boundary, and their hold semantics, are specified in
   the private operations repository next to the scripts.
6. **Test-before-bulk:** one item, review, then batch. Applies to secret
   migrations (one ref → verify its consumer → batch) AND to automated lanes (a
   new lane's timer stays disabled until one real item is processed and
   inspected live).
7. **Every incident gets an explicit disposition** — fix, subtract, observe,
   gate or accept — and a blocking gate only for a deterministic, recurring
   failure that is cheap to detect, with its owner and retirement condition
   recorded (`docs/ENGINEERING_PROCESS.md`).

## Known OpenClaw behaviors (generic)

- **The config `get` subcommand redacts secrets.** Never capture values through
  it; read `openclaw.json` or its `.bak.*` rotation directly.
- **`doctor --fix` can plant a delayed crash.** Its state migration can surface
  a dangling SecretRef in agent/plugin state (not `openclaw.json`, so
  `config validate` stays green) that crash-loops later. After `doctor --fix`:
  restart, check `openclaw gateway status` and run a real turn before walking
  away. Dangling-ref fix: alias the missing provider name to the real one via
  `config set secrets.providers.<name>`.
- **`openclaw config set` value mode runs no schema or resolvability checks.**
  Prefer `--batch-file` / `--batch-json` for changes that matter: it validates
  and lands N keys in one write and one `.bak.*` rotation. Always `--dry-run`
  first.
