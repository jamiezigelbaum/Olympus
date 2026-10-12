# Standalone Olympus engine on Linux (W5)

Status: lifecycle design, 2026-10-12. Not implemented or host-qualified.
Code baseline: `12ccfcae62a695d0a3db8021e6c79b409cb52c77`. All repository
`file:line` references below refer to that revision. Statements under
“Current contract” describe inspected code; subsequent sections specify work
still to be built and tested.

## Outcome and boundaries

A user can install Olympus without OpenClaw, connect ChatGPT, approve from a
second computer, ask Personal and Private questions, open eligible sources,
and keep the engine serving through logout and reboot. Install, repair,
upgrade, rollback and removal have observable outcomes rather than relying
on a service manager's successful exit code.

This implements W5 of `docs/design/linux-parity.md:213`. Owner direction on
2026-10-12 supersedes that plan's Ubuntu acceptance requirement for W5:
**Omarchy first; Ubuntu proof is explicitly skipped.** Ubuntu must pass the
same capability checks or refuse with a remedy; no Ubuntu qualification claim
follows from a container test. The intended architectures remain Linux x86_64
and arm64, glibc, systemd user manager. Musl, other init systems and root
installs are refused. Each architecture needs its own pinned runtime proof
before being advertised as supported.

W1–W4 retain ownership of OCR, model defaults, photo preparation and zkAPI
confinement. W5 consumes their capability results; it does not bypass them.
In particular, inability to enforce W4 confinement refuses the zkAPI lane,
never selects a weaker mode. No speed floor is added to the owner's W2
choice. Apple Messages remains outside Linux scope.

The demo stays frozen at `de0b32e2`. Listing claims, public copy and demo
configuration remain untouched until OpenAI review closes. This document
and its documentation inventory registration are the only changes in this
work order; implementation, release publication and live installation are
separate work.

## Current contract, verified against code

| Surface | Current behavior and evidence |
|---|---|
| Entry and paths | Lifecycle commands call `assertDarwin`, which rejects Linux and suggests OpenClaw or the worker (`src/core/engine-service.ts:377`, `:1426`). Paths include a LaunchAgent, Library app/runtime/log folders, `~/.olympus/engine.json` and `~/.config/olympus/worker.env`; path construction deliberately drops XDG overrides for the Mac agent (`src/core/engine-service.ts:89`). Inspection returns unknown on other platforms (`:1199`). |
| Host | The standalone host reads engine config, starts enabled services, records children and stops services on SIGTERM/SIGINT; it is not an OpenClaw invocation (`src/core/engine-host.ts:91`, `:129`, `:192`, `:198`). The existing Linux worker unit is `olympus-worker.service`, a different service (`src/core/worker-service.ts:520`). |
| Configuration | New config enables worker/scheduler and relay; reconciliation fills absent fields and preserves an owner-written remote block (`src/core/engine-service.ts:228`, `:257`). Install seeds sovereignty only when allowed and creates the managed worker environment (`:388`, `:428`, `:437`). |
| Start and stop | Mac stop waits for a quiet engine, unloads and disables the agent so it stays stopped after login; start enables it again (`src/core/engine-service.ts:979`, `:999`). The quiet guard waits up to 180 seconds for a zkAPI question, then refuses unless `--now` was explicit (`:301`, `:310`). |
| Health | Build identity hashes bundled entrypoints with package version (`src/core/engine-service.ts:130`). Health requires a valid running status, expected build, live PID and ready worker HTTP health; an explicitly disabled worker is a distinct accepted state (`:545`). A service-manager start alone is insufficient. |
| Installer | Mac installer refuses root, unsupported hardware/OS and missing tools (`scripts/install-macos.sh:122`); uses HTTPS and archive size/hash plus cached executable hash (`:120`, `:321`, `:326`, `:407`); checks managed paths before and under a kernel lock (`:185`, `:214`, `:420`). Same-release repair preserves the rollback copy; failed upgrade restores and verifies the earlier build (`:443`, `:469`, `:490`). Recovery is transaction-owned (`:275`, `:294`, `:302`). These are code mechanisms, not a new power-loss proof. |
| Rollback | CLI exchanges app/current and previous, reinstalls and verifies; failure attempts to restore and verify the original build (`src/core/engine-service.ts:1045`). |
| Cleanup and uninstall | Child cleanup verifies leader PID, start time and argv before each signal (`src/core/engine-children.ts:179`, `:189`, `:204`). CLI uninstall removes the agent but reports retained app/runtime/settings/models/keys (`src/core/engine-service.ts:899`, `:927`). Shell uninstall uses system tools, verifies the agent has stopped, removes app/runtime/owned launcher and PATH lines, retains data/settings/logs, and warns that helpers may remain (`site/uninstall.sh:110`, `:147`, `:155`, `:162`, `:183`). “Leaves nothing” is **not** the current default Mac data contract. |
| Secrets | Auto selects libsecret if `secret-tool --version` succeeds, otherwise encrypted files; Mac auto already uses files (`src/core/secret-store.ts:63`, `:354`). Every failed libsecret lookup becomes undefined (`:283`). Files use AES-256-GCM, lease-serialized writes and atomic publication, with a local random key or scrypt passphrase (`:125`, `:173`, `:206`, `:223`). Default paths ignore XDG_CONFIG_HOME (`:34`). |
| Source opening | Private citations and unreadable sources inject a local opener only on Darwin (`src/workers/email-source/server.ts:3444`, `:4627`). Dropbox resolution and local dispatch enforce provider roots, regular files, no symlink at dispatch, and an extension allowlist; other types are revealed with Mac `-R` (`src/workers/dropbox-files/open-target.ts:99`, `:126`, `:144`). |
| Authorization to open | Private open capabilities are job/install-bound and recheck evidence eligibility before dispatch (`src/workers/chatgpt/private-answer-jobs.ts:642`); they are not consumed by that method. Unreadable capabilities are opener-bound, consumed before dispatch, and recheck the current unreadable verdict (`src/workers/file-extraction/unreadable-files.ts:413`). Preserve these distinct semantics. |
| Desktop and remote handoff | Linux URL-handler registration already uses XDG paths and xdg-mime; removal edits only its MIME association (`src/core/open-handler.ts:89`, `:250`, `:272`, `:291`). Remote detection uses declared server mode or DISPLAY/WAYLAND_DISPLAY; manual instructions establish an SSH forward and mint a dashboard link on the engine host (`src/core/remote-open.ts:70`, `:125`). Opening-ticket minting refuses redirects and uses the worker bearer internally (`src/core/dashboard-opening.ts:108`). |
| Approval | Relay bridge keeps the OAuth query and sends the browser to the engine's loopback authorize endpoint (`connect-relay/server/authorize-bridge.ts:47`). Real relay-mode GET and POST require a non-relayed loopback Host and peer; POST additionally requires browser navigation and matching CSRF cookie/form (`src/workers/remote-oauth/handler.ts:278`, `:448`). A dashboard opening ticket is not OAuth consent. |
| Doctor | Host probing currently skips standalone engine inspection outside Darwin (`src/core/doctor.ts:135`); missing-host guidance recommends engine install only on Mac (`:481`). |

## One lifecycle, platform-specific service management

Keep config reconciliation, sovereignty rules, health proof, quiet guard and
operation results shared. Introduce narrow launchd/systemd adapters for unit
rendering, installation, inspection, enable/start, disable/stop and removal.
Do not start a second `olympus-worker.service`: the engine owns its worker,
relay and embedding children. Refuse an existing competing host/data custodian
with an exact stop/migration remedy; do not disable another install silently.

### Paths and environment

Resolve one install layout for CLI, host, worker, models, secrets, doctor,
opening and deletion. Persist the resolved roots in a private installation
receipt; later commands must discover that receipt rather than accidentally
selecting a new root from a different shell. Reject ambiguous multiple
receipts. Initial receipt discovery checks default and explicitly supplied
XDG config roots; an alternate-root install prints the exact environment
needed to address it. A marked launcher carries that layout, not secrets.

| Purpose | Proposed Linux location |
|---|---|
| Unit | `$XDG_CONFIG_HOME/systemd/user/olympus-engine.service` |
| Config, sovereignty, worker environment, backend selection, install receipt | `$XDG_CONFIG_HOME/olympus/` |
| Encrypted secrets and local wrapping key | `$XDG_CONFIG_HOME/olympus/secrets.enc` and `secrets.key` |
| Package generations and pinned runtime generations | `$XDG_DATA_HOME/olympus/engine/` |
| Existing indexes, model files, remote registration and child/status records | `$XDG_DATA_HOME/openclaw/olympus/` (compatibility namespace, no OpenClaw dependency) |
| Install transactions, rollback receipts, engine/install logs | `$XDG_STATE_HOME/olympus/engine/` |
| Disposable downloads | `$XDG_CACHE_HOME/olympus/engine/` |
| Lifecycle lock and ephemeral desktop-session handoff | `$XDG_RUNTIME_DIR/olympus/` |
| Marked CLI launcher; desktop URL handler | `~/.local/bin/olympus`; `$XDG_DATA_HOME/applications/ai.olympusplugin.open.desktop` |

Unset config/data/state/cache roots use the standard home-relative
`.config`, `.local/share`, `.local/state`, `.cache` defaults. Explicit relative
roots are refused. Runtime directory must be provided by the real user
session, owned by that UID with private permissions; do not manufacture a
fake systemd bus or fall back to a shared temporary directory. Roots outside
the home may work if their ownership, filesystem and ancestor checks pass;
then wording is “your user directories”, not “nothing outside your home”.
Never chmod a shared XDG parent. Olympus private directories are 0700;
private files are 0600; executables and desktop entries have only their
required modes. Reject symlinked managed ancestors/leaves, foreign ownership,
unsafe writable parents and conflicting files before mutation and again
under the lock. Escape systemd values separately from shell and desktop-entry
values, including spaces, percent signs, dollars and control characters.
The user manager may have a different XDG environment from the invoking
shell: link the absolute unit through the user manager when necessary,
record every resulting owned link, and verify FragmentPath resolves to the
intended unit. Never report installation of a unit the manager cannot find.

This requires real path plumbing, not just changing `enginePaths`:
`src/core/engine-host.ts:96` reads its result; the current data resolver
appends `openclaw/olympus` (`src/core/remote-access.ts:115`); worker paths
and secret defaults are separately hard-coded (`src/core/worker-service.ts:520`,
`src/core/secret-store.ts:34`); sovereignty has a separate legacy default
(`src/core/sovereignty.ts:184`). Audit every consumer, including quiet-guard
state and data-deletion custody. Mac paths remain unchanged.

For existing Linux data, do not create a second empty store or overwrite a
policy. Under stopped-host custody, discover legacy settings and offer an
explicit, receipt-backed migration. Copy, flush, verify, switch references,
and retain the original until rollback is no longer needed. Conflicting
old/new settings cause refusal with paths. No automatic cross-host adoption
or broad recursive deletion of an XDG root.

### Unit and commands

Proposed rendered unit (angle-bracket values are renderer substitutions,
not literal systemd environment expansion):

```ini
[Unit]
Description=Olympus standalone engine
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
ExecStart="<pinned-bun>" --no-env-file "<verified-package>/dist/cli.js" __engine-run
WorkingDirectory=<verified-package>
Environment="HOME=<home>" "PATH=<runtime-bin>:/usr/bin:/bin"
Environment="OLYMPUS_ENGINE_HOST=1" "OLYMPUS_ENGINE_BUILD=<build>"
# Also render the resolved XDG roots and non-secret config-location selectors.
UMask=0077
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
SendSIGKILL=yes
StandardOutput=append:<state>/engine.log
StandardError=append:<state>/engine.err

[Install]
WantedBy=default.target
```

Use the user manager, never a system unit, sudo, root worker, OpenClaw or a
shell sourcing a login profile. `Type=exec` proves execution, not readiness;
the CLI still waits for application health. The minimum is systemd 240 for
this template, subject to real directive verification during preflight.
See upstream [service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
Logs are private files with bounded rotation and redacted `engine logs`
output; do not send application payloads to the shared journal. Manager
metadata may still appear in the journal.

`KillMode=mixed` lets the host handle SIGTERM and stop its children first;
systemd then kills remaining unit-cgroup processes at main-process exit or
stop timeout. Detached process groups do not justify killing by name.
See upstream [kill semantics](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).
No child may escape into another unit/scope. Prove worker, model, relay and
confinement-helper custody with real processes. Preserve identity checks for
legacy recorded children outside the cgroup; unverifiable leftovers are a
failed cleanup with a remedy, never a successful “nothing running” result.

| Command | Linux contract |
|---|---|
| `engine install [--restart]` | Preflight, lock, reconcile without overwriting owner policy, atomically publish unit, daemon-reload, enable/start or restart as needed, then verify the exact package. Same inputs are idempotent. `--dry-run` is read-only. |
| `engine status` / `verify --expect-package` | Show installed/enabled/active/failed/unknown independently; read machine properties including MainPID, ControlGroup, Result and ExecMainStatus. Confirm expected build, current process identity and worker health. Unreachable user bus is unknown/error, never absent or healthy. |
| `engine stop [--now]` | Quiet guard, disable and stop, wait for empty cgroup and stopped worker listener. Stay stopped across login/reboot. Failure retains files and recovery evidence. |
| `engine start` | Enable/start an installed unit and verify health. Never silently install a missing package. |
| `engine restart [--now]` | Quiet guard, restart installed unit, verify fresh process/build. Preserve enablement; restart is not a way to undo an owner's persistent stop preference. |
| `engine rollback` | Same transaction machinery as upgrade; restore previous package, matching Bun, unit and config compatibility, then prove health. |
| `engine uninstall` | Stop/disable/remove service registration and URL handler; report retained files, as the Mac CLI does. Full shell removal is below. |

Quiet waiting alone does not close a race: acquire a maintenance admission
fence before checking in-flight work, reject new consults, drain, then stop.
Timeout releases the fence and leaves the old engine running. `--now` is an
explicit forced-stop choice, never an installer default. System shutdown
cannot promise the same interactive wait; crash recovery must reconcile
in-flight state rather than claim completion. Unknown custody blocks deletion.

### Linger and honest privilege wording

Linger starts the user's manager at boot and retains it after logout. It is
account-wide, not a property of this unit. Authorization depends on host
policy; neither Arch nor Ubuntu alone establishes permission. Check
`loginctl show-user <uid> --property=Linger --value`; if needed, try
`loginctl --no-ask-password enable-linger <user>` for the current user only,
then read the property again. Never spawn a password agent or retry with sudo.
Upstream documents [linger](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)
and the [polkit authorization](https://github.com/systemd/systemd/blob/main/man/org.freedesktop.login1.xml).

Default install requires persistent service operation on desktop and headless
hosts. Before any active package/unit change, if linger cannot be enabled:

> Olympus needs permission to keep running after you log out and to start
> before you log in. This account cannot enable that permission without an
> administrator. Ask an administrator to run: `sudo loginctl enable-linger <user>`.
> Then run the installer again. Olympus was not installed or upgraded;
> an existing installation was left running.

Substitute a safely quoted current account name; distinguish denial from an
unavailable logind service. On the latter say that systemd-logind and a
working user session are required, not that sudo will necessarily fix it.
There is no silent login-only success mode. Record whether linger predated
Olympus, so failure/removal can offer restoration without disabling someone
else's services. Enabling linger can change shared account behavior and must
be stated before doing it, even when no administrator is needed.

Print “No administrator password is needed” only after dependencies, user
manager access and linger are verified. Otherwise name the failed capability
and exact distro remedy. Do not install distro packages automatically.
A successful install may say “Installed for your user without an
administrator password.” It must not say “no system settings changed” after
logind changed linger.

## Linux installer, upgrades and recovery

Add `scripts/install-linux.sh` as a release template and a published Linux
uninstaller (proposed `site/uninstall-linux.sh`). Preserve the Mac script's
non-root, pinned-download, private-path, idempotence, health-proof and honest
failure contracts. Run the whole shell installer only after its complete
function definition; a truncated download must execute nothing. Release
publisher support must fill every pin and preserve previous release assets;
an unfilled template refuses. Do not change the Mac download or listing route
as a side effect.

Preflight Linux/architecture/glibc/CPU capability, systemd directives, live
user bus, logind, disk space, secure filesystem primitives, required shell
tools and distro packages. Minimum bootstrap tools: POSIX shell, curl, CA
certificates, sha256sum, tar, unzip, coreutils, find, awk, grep, diff, cmp, ps
and util-linux flock, plus systemd loginctl/systemctl. Report all missing
items with reviewed Arch/pacman or Ubuntu/apt instructions; those commands
may need administrator permission. Separate desktop xdg-utils from headless
SSH requirements and W1–W4 optional capability remedies.

Bun starts at the Mac's `1.3.14` pin (`scripts/install-macos.sh:88`), with
**new, independently verified Linux x64 and arm64 archive URL, size, SHA-256
and extracted-executable SHA-256 pins**. No invented digest, `latest`, ambient
Bun/Node trust, version-only cache validation or download-and-execute pipe.
Select a baseline x64 asset or refuse unsupported CPU instructions before
activation. Record and test the actual glibc/CPU floor for each selected
asset; a filename is not proof. Absent pins block release publication for
that architecture, not merely a warning at runtime.

Existing library/runtime pins remain their respective authorities:
llama.cpp `b11320` has Linux x64/arm64 CPU archives
(`src/workers/source-index/built-in-reasoning/manifest.ts:120`); LiteRT-LM
`0.18.0` has both Linux architectures
(`src/workers/source-index/built-in-embedding/manifest.ts:202`);
zkapi-clientd has both but managed Tor lacks Linux arm64
(`src/core/managed-tools.ts:161`, `:173`). No Tor arm64 readiness claim until
that lane has a verified runtime. Missing optional lanes must be explicitly
unavailable; they must not make a false all-capabilities-ready result.

All lifecycle writers, including CLI rollback and shell uninstall, share one
nonblocking kernel flock in the user runtime directory. Never unlink a live
lock inode or steal by PID/age. Child execs close the lock descriptor. The
persistent transaction record lives in state, independent of the runtime
directory's reboot lifetime. Recheck layout while locked. Journal only
identities, paths, hashes, prior enabled state and stages, never secrets.

Transaction sequence:

1. Download to private scratch; verify size/hash before executing anything.
   Reject traversal, absolute archive paths, links escaping the extraction
   root and unexpected package structure. Verify extracted Bun too.
2. Stage immutable package/runtime generations on their destination
   filesystems. Record current and previous identities, unit bytes and
   config schema compatibility; flush files and containing directories.
3. Write and fsync a transaction-owned prepared record before altering active
   references. Enter maintenance, drain, stop and prove custody released.
4. Publish new references/unit atomically, daemon-reload, restore intended
   enablement and start. Verify expected build, fresh manager PID/cgroup and
   worker health within the existing 60-second health budget (`src/core/engine-service.ts:483`). Report model
   download/warm-up separately; it is not engine failure or model readiness.
5. Commit and flush the receipt only after proof. Keep one known-good
   generation with its matching runtime. Remove staging and obsolete owned
   generations only after the commit is durable.
6. On failure, restore the complete old runnable pair and service state,
   verify it, and return nonzero: “Upgrade failed; previous version restored
   and healthy.” If restore fails, say so, retain recovery evidence and give
   the exact repair command. Never report success because files were renamed.

Same-release rerun compares installed content to the verified download,
repairs corruption and verifies the running build without replacing a good
previous generation. Failed first install disables/removes the new active
unit and launcher; report any settings/downloads retained for retry.
Rollback cannot safely undo arbitrary data migrations: each future release
must declare backward-readable schemas or provide a verified reversible
migration/snapshot. Refuse an incompatible rollback rather than corrupt data.

At the next invocation, lock before reading the journal. Reconcile observed
hashes/references with the recorded stage: prepared/no switch discards only
that transaction's staging; switched/uncommitted restores known-good state;
committed repeats health proof before garbage collection. Malformed records,
foreign paths and ambiguous generations stop with a repair diagnostic.
Inject termination after every durable step and every rename; repeat recovery
twice. Include reboot/power-loss simulations, not just shell EXIT traps.

## Removal: no installed machinery left behind

Preserve Mac defaults: normal shell uninstall keeps personal data/settings
and lists them. “Nothing left” means no Olympus service, child process,
listener, package/runtime generation, launcher, desktop handler or managed
PATH entry; it does not mean deleting personal data without a choice.
An explicit **remove data too** mode provides the full-removal acceptance
case. Neither mode deletes original Dropbox files, mail or provider data.

The Linux shell uninstaller must work when Bun and the app are missing or
corrupt, using system tools and a strictly validated receipt. Lock, prevent
new work, stop/disable, prove empty cgroup and listener release, then remove
only owned artifacts. Failure to prove stop leaves binaries and data intact.
No `pkill bun`, guessed PIDs, deletion of the user's systemd directory, or
execution of an unverified installed package. Remove owned unit links,
daemon-reload and clear its failed state. Remove MIME registration and the
marked desktop entry without altering other handlers; atomically remove
only marked profile lines. Preserve user replacements with an explicit
incomplete-removal report. Interrupted uninstall resumes safely.

Full removal additionally enumerates and confirms settings, secret ciphertext
and key, indexes/SQLite sidecars, model/runtime downloads, remote registration
and connections, status/children files, transaction records, logs and caches
across the recorded roots. Reuse data-lifecycle custody and protected-path
rules; do not assume `data delete --all` already covers every install artifact
(its connection deletion is at `src/data-lifecycle.ts:888`; shell retention
is at `site/uninstall.sh:183`). Pre-existing shared Olympus/OpenClaw data
requires separately explicit deletion consent. Secret Service items can be
removed only when available and individually proven owned; locked items mean
incomplete purge, never success. Do not delete a whole desktop keyring.

Local key deletion is not removal of the ChatGPT connection in the user's
account: print the separate disconnect step, as the Mac uninstaller does
(`site/uninstall.sh:194`). Do not promise provider-token revocation while
offline. Record any pending external revocation before claiming it complete.

Linger pre-existing before Olympus is preserved. If Olympus enabled it,
removal presents the account-wide effect and offers restoration; it never
disables linger silently while other user services may depend on it. A
full-removal test in a dedicated account restores the prior linger value.
Shared journal history cannot safely be purged per application; disclose
that OS audit metadata may remain. Do not vacuum the user's journal. The
installation receipt disappears last, after all requested persistent owned
artifacts are gone; otherwise retain a minimal recovery receipt and fail.
Do not unlink the runtime lock while held: that would let a concurrent
installer lock a different inode. Leave that inert runtime lock for the
user-runtime-directory teardown at final logout/reboot, and name it in the
removal result. Full-removal acceptance checks again after that teardown.

## Secrets on a desktop and a headless host

Make backend selection durable per installation, shared by CLI and service.
For a fresh standalone install choose encrypted-file storage directly,
including desktops: a lingering service must work before desktop unlock.
When qualifying an existing or explicitly selected Linux desktop libsecret
backend, probe the actual Secret Service bus, service,
collection unlock state and bounded read/write/delete access with a disposable
random probe item; executable presence is insufficient. No interactive
unlock prompt during engine boot. Remove the probe item and report failed
cleanup. Absent, locked or unreachable service selects encrypted-file for a
new install, visibly, rather than returning “missing”.

Existing credentials need stronger semantics than opportunistic fallback:

- Persist backend provenance. If a credential belongs to a locked/unavailable
  keyring, report `backend_unavailable`/`locked`, not “not configured”. A new
  empty encrypted store cannot recover a key it never held.
- Offer explicit unlock-and-migrate or re-entry into the encrypted store.
  Copy only owned known keys while accessible, verify values internally,
  publish the backend switch atomically, then handle old-key cleanup. Never
  log values or overwrite a divergent existing file-store key.
- Once file storage is selected, continue using it when a desktop logs in;
  do not switch back automatically. A backend disappearing mid-operation
  fails that operation clearly; no split writes, shadow values or stale
  credential resurrection on delete. Explicit `libsecret` configuration
  fails visibly if unavailable, rather than violating that explicit choice.
- Distinguish successful absent lookup from D-Bus/lock/permission/timeout
  errors. Keep this distinction through both synchronous and asynchronous
  callers and doctor; a caught exception must not become a false “missing”.

Keep the existing authenticated-encryption and lease/atomic-write machinery.
Harden key reads so missing key with existing ciphertext is a corruption/
recovery error, never generation of a replacement key. Reboot qualification
uses the local random key protected by user-directory permissions. This
protects a ciphertext-only copy, not against someone reading both files or
running as the same user/root. Passphrase stores require an explicitly
provisioned unlock mechanism; a locked store is visibly unavailable after
boot. No passphrase in unit text, argv, journal or persistent plaintext env
file, and no unattended-readiness claim without proving unlock.

## Desktop source opening and headless approval

Share target validation with the Mac; platform adapters change dispatch only.
The worker resolves a provider locator, never accepts a raw path or command
from a browser/agent. Repeat realpath, containment and regular-file checks
at dispatch. Keep `OPENABLE_EXTENSIONS` as the single allowlist. On Linux,
spawn a trusted xdg-open executable with one absolute path argument and a
bounded timeout, without a shell; do not pass Mac `-R` to xdg-open. A file
outside the allowlist, including `.desktop`, scripts and link launchers, is
never executed: reveal via a qualified file-manager API, or open its validated
parent directory with xdg-open and report “folder opened”. No arbitrary URL
scheme, option injection, symlink escape or widening to all MIME types.

Exercise both private citations and unreadable lists, retaining their current
capability and eligibility checks. The existing private payload says
`kind: 'mac'` (`src/workers/chatgpt/private-answer-jobs.ts:1243` and decoder
`src/workers/dashboard/chatgpt/private-answer.ts:445`); do not silently emit
Linux operations under a Mac claim. Introduce a compatible host-neutral
capability with old-client handling in the post-review surface PR. Earlier
backend PRs stay internal/disabled until that consumer lands.

A lingering engine may boot before Hyprland and keep running after logout.
Do not freeze the installer's DISPLAY/WAYLAND_DISPLAY into the engine unit.
Provide an owned per-session handoff/helper started by the desktop session,
validate its current UID/runtime socket, and remove/invalidate it at session
end. The opener executes in that verified session. Do not import the whole
shell environment or restart a busy engine merely to update DISPLAY.
Probe an actual desktop opener; stale environment alone is not readiness.
With no current desktop, route panel opening through remote open. If
xdg-open is missing or fails, report the failure and offer the permitted
provider web preview. An unsupported file type opens its folder, never the
file itself. Changes to session handoff belong in the owned-artifact receipt.

For headless sources, open the authenticated panel in the second computer's
browser using the existing SSH-forward and one-time launch-ticket route.
Provider web previews open there after the same authorization checks; a
server-local path does not become a client-local path. For local-only files
say that no desktop is available on the engine host. W5 adds no general file
transfer endpoint and exposes no filesystem path in model-visible output.
Private answers remain in the private panel.

Headless ChatGPT approval sequence:

1. Establish the existing remote-open SSH forward from the user's computer
   to the engine worker, bound only to local loopback on the engine's same
   port. Require SSH authentication; refuse port collision/forward failure.
   No public bind, firewall opening or invented hostname. If target is
   unknown, ask the user to configure it through the existing server-mode
   flow. Browser-only clients use the manual commands.
2. Start/restart the ChatGPT connection flow while the forward is alive.
   The existing relay bridge's loopback link reaches the headless engine
   through that forward. Preserve its original OAuth query, client, redirect,
   state and PKCE binding. A dashboard ticket opens the panel only; it does
   not approve the client and is not a generic arbitrary-URL target.
3. The engine receives a direct loopback connection, displays the consent
   page and requires the existing same-origin navigation, CSRF cookie/form
   and explicit user click. Keep relay/public approval rejected. The SSH
   account now holds the same local capability as a desktop user; disclose
   that boundary, do not add the demo password path to real installs.
4. Follow the exact validated callback, exchange the code, and make one real
   authenticated tool call. A consent page or systemd “active” is not proof
   of connection. Expiry, wrong port/install, replay and denied consent must
   fail without weakening any origin or client check.

The headless connection helper should reuse the fixed remote-open tunnel
mechanism and a connection instruction state, not broaden `OpenTarget` to
arbitrary URLs. Linux-local client OAuth callbacks on the second computer
must be tested separately from ChatGPT's web callback.

## Doctor coverage

Doctor reports independent facts and remedies, without printing credentials:

| Check | Required diagnostic/proof |
|---|---|
| Host and service | Standalone Linux recognized without OpenClaw; user bus accessible; unit owned and valid; enabled/active/build/health distinguished; conflicting worker or host refused. |
| Persistence | Linger known and enabled; login-only or unavailable state is unhealthy for this install contract; read-only doctor never enables linger. |
| Paths and recovery | Effective XDG roots match receipt and every child; permissions/ownership safe; no unfinished transaction; previous generation/runtime usable; disk headroom reported. |
| Process custody | Manager MainPID/cgroup agrees with current host; no stale competing listener or escaped recorded child; unknown observation is not healthy. |
| Runtime capabilities | Exact Bun pin, CPU/glibc loadability, model manifests and actual runtime probes; W1–W4 results surfaced separately from engine health. |
| Credentials | Selected backend and reason; locked/unreachable/corrupt versus absent; unattended unlock state; no secret values, refs or probe residue in output. |
| Opening and consent | Current desktop session plus xdg-open/handler readiness, or explicit remote mode with configured SSH target/instructions; missing target is actionable. Read-only diagnostics never mint consent or approve. |
| End-to-end reachability | Worker readiness and relay connection are distinct; relay offline can coexist with a healthy local engine. Connection smoke proof is a separate authorized action. |

## Independently reviewable landing plan

These are implementation PRs, not changes made by this document. Each keeps
Mac regression coverage and has tests of observable behavior that fail without
its change. Critical PRs require fresh independent review under
`docs/ENGINEERING_PROCESS.md:76`, focused proof, required head CI and exact-main
CI. No deployment follows automatically. No new general-purpose process gate.

| PR | Scope and dependency | Regression proof that must fail without it |
|---|---|---|
| 1. Linux layout and systemd lifecycle | Shared layout, narrow adapter, receipt, custody, status/start/stop/restart/verify and doctor host checks; no public installer yet. | Temporary nondefault XDG roots reach every child/CLI; manager access denied is unknown; symlink/foreign paths cause no mutation; real user systemd stop and main-process crash remove detached grandchildren; stale build/PID/HTTP health fails; quiet timeout changes nothing; admission race cannot accept new work while stopping. Mac launchd behavior remains covered. |
| 2. Stable secret backend | Can proceed independently, integrates PR 1 paths. | `secret-tool` present with no bus, locked collection, timeout and permission error select file on fresh auto install or report existing-key unavailability; never false missing. Desktop login cannot switch backend. Concurrent writes, corrupt ciphertext, lost key, migration interruption and delete/restart cannot lose or revive credentials. Real locked-keyring and headless reboot proof. |
| 3. Pinned install, upgrade and removal | Depends on 1–2; shell scripts, release pins/publisher, shared flock, durable transaction, full removal and lifecycle doctor. | Tampered archive/cached Bun never runs; missing pin/CPU/glibc/tool/bus/linger refuses before active mutation; concurrent install/rollback/uninstall serializes; same-release repair preserves previous; injected failure/crash at each durable boundary recovers twice; failed new and failed rollback health are distinct; uninstall works without Bun/app, leaves unrelated files/processes intact, and purge inventory is empty. Shell syntax/ShellCheck plus real systemd integration, not command mocks alone. |
| 4. Desktop opener and headless handoff | Depends on 1; internal adapter/session helper and remote-open tunnel reuse. Public Linux source capabilities wait for PR 5. | Both private/unreadable paths reach the same dispatcher; allowlisted file opens, script/desktop file only reveals folder; symlink swaps, traversal, injected argv and revoked eligibility refuse; Hyprland login/logout updates readiness without restarting engine; headless launches no xdg-open; second-computer approval works and relay/public/cross-origin/replay requests still fail. |
| 5. Consumer integration and qualification | Depends on 1–4 and relevant W1–W4 proof; **after OpenAI review closes**. Host-neutral payload/decoder, copy inventory below and supported install entrypoints. | Old/new payload compatibility; Linux never displays “opened on Mac”; install instructions select proven capability/architecture; missing optional lanes are visibly unavailable; Omarchy acceptance below. Tests preserve the frozen demo configuration and prohibit unsupported listing claims. |

New Linux functionality can land internally in the first four PRs without
altering the reviewed listing or serving changed plugin bundles. Publication
is a separate explicitly authorized action after review closure. Runtime pin
qualification and schema compatibility are engineering proof tasks, not owner
product decisions.

### Deferred copy inventory (PR 5 only)

| Surface | Change after review closes |
|---|---|
| Private answer payload/panel and source-open feedback | “your computer” when colocated; explicit engine-host kind/location when remote. Update `kind: mac` compatibly, decoder and localized labels (`src/workers/chatgpt/private-answer-jobs.ts:1243`, `src/workers/dashboard/chatgpt/private-answer.ts:138`, `:693`). |
| Dashboard, doctor and setup status | Distinguish Mac, Linux desktop and headless host, including no-desktop/locked-store/persistence limitations. Mac-specific doctor text exists at `src/core/doctor.ts:495`, `:513`. |
| Relay disconnected/offline/errors and approval bridge | Replace “Your Mac” with neutral text unless a verified host kind is available; no new machine identifier needed (`connect-relay/server/relay-mcp.ts:45`, `:174`; `connect-relay/server/authorize-bridge.ts:56`). |
| OAuth consent/refusal | Explain remote-open approval while retaining identical authorization (`src/workers/remote-oauth/handler.ts:280`; `src/workers/remote-oauth/consent-page.ts:179`). |
| Plugin skills and manifest | Setup/ask guidance, descriptions and review examples: approved Linux requirements, honest prerequisite/linger wording; no change now (`chatgpt-plugin/skills/olympus-setup/SKILL.md:3`, `:38`; `chatgpt-plugin/plugin.json:5`, `:27`). |
| README, install guide and site | Platform-specific install/uninstall links, awake/online versus persistent-server explanation, tested architecture/capabilities and conditional no-admin wording (`README.md:60`, `:74`, `:154`; `site/install/index.html:6`, `:31`). Audit accompanying screenshots and translations in this PR. |

### Acceptance on Omarchy

Run in a dedicated ordinary account on real Arch/Hyprland/systemd, with no
OpenClaw and no ambient Bun. Record OS/kernel/systemd/CPU architecture,
capability results, package/build hashes and commands, without host names,
addresses, credentials or private source content. This is a future acceptance
run; no such run is claimed by this design.

1. Inventory the account first; use nondefault XDG roots in a second pass.
   Install from a fully pinned release. Show missing-dependency and denied-
   linger refusal separately, then successful non-admin install where policy
   allows it. Verify the unit and exact build, not just the installer message.
2. In Hyprland, open one allowed document and one disallowed script's folder
   from both private-answer and unreadable-source flows. Prove the script did
   not execute. Exercise symlink/revocation refusal and stale desktop session.
3. Use a second computer for the remote-open panel and ChatGPT approval.
   Complete OAuth plus a tool call; one Personal question yields cited
   evidence and one Private question is answered only in its private panel.
   After logout, source web previews still work and no server-local desktop
   action is falsely reported. Include denied, expired and replayed consent.
4. Log out all graphical/SSH sessions and verify from the second computer
   that the engine still serves. Reboot, test before first login, then log
   into Hyprland and retest desktop opening. The secret backend must remain
   usable or report its precise locked state; the acceptance configuration
   uses unattended encrypted-file storage.
5. Upgrade to a known test build; prove exact identity changed. Inject failed
   health and interrupted swaps; prove the previous runtime/package returns
   healthy. Exercise explicit rollback, duplicate installer invocation,
   Ctrl-C/SIGKILL and reboot at durable transaction boundaries.
6. Stop/restart, then crash the main process with real worker/model children.
   Verify unit-cgroup cleanup and restart, no occupied stale listener, no
   unrelated process killed. Stop remains stopped after reboot.
7. Normal uninstall leaves no installed machinery and accurately lists kept
   data. Reinstall adopts it. Explicit full removal in this dedicated account
   removes every owned artifact, secret and pending transaction, restores
   the prior linger setting by explicit choice, and preserves unrelated
   services, source files, MIME entries and profile text. Repeat removal.

Linux arm64 requires a separate real runtime/install/custody run before its
release is enabled; x64 proof does not qualify it. Mac regression runs on a
Mac. **Ubuntu acceptance is skipped by owner decision 2026-10-12**, not marked
passing, silently substituted by CI, or required as a new owner gate. An
Ubuntu invocation still takes identical capability checks and either works
under those verified conditions or exits with an actionable refusal. Unit
fixtures for unsupported kernels, user managers, glibc, secrets and optional
lanes remain required regardless of the skipped distro run.

## Owner decisions

No additional product decision is needed to begin the scoped implementation.
This design preserves default data retention and makes full removal an
explicit choice, preserves the OpenAI-review freeze, and records Omarchy
qualification with Ubuntu proof skipped.
