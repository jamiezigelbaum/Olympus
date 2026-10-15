# Standalone Olympus engine on Linux (W5)

Status: W5 tracks integrated locally, 2026-10-12. Integration proof and
Omarchy acceptance are recorded below. Not published or host-qualified.
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
configuration remain untouched until OpenAI review closes. The original
design-only work order is complete; the owner subsequently authorized the
five-track integration and a local acceptance artifact. Publication and live
installation remain separate work.

## Desktop launcher (local branch, 2026-10-13)

Install and upgrade register **Olympus** in the user's XDG applications
folder. The entry runs the absolute `~/.local/bin/olympus` shim with
`dashboard`; the shim preserves the installation's XDG layout. The icon is
`assets/icon.png` (512×512), installed in the user hicolor theme. Both files
are included in install recovery and receipt-based removal. No desktop or
icon files are written to system directories. Optional desktop/icon cache
refresh tools are best effort.

Olympus replaces an existing desktop entry only when its Desktop Entry group
has `X-Olympus-Managed=true`. Remove that key to take ownership; installation
then refuses and leaves the file in place. A changed icon is also retained.
The shell uninstaller retains changed artifacts and reports incomplete removal;
move those files aside before retrying. Unchanged owned files are removed in
both keep-data and purge modes. `engine verify` reports `desktop_entry.present`
and its path separately from engine health.

The dashboard still uses the default browser through the existing private
owner-ticket opener. A Chromium `--app=file://…` launch could carry only the
filename, but retaining the app window through the redirect to the per-session
localhost origin has not been browser-qualified. No browser command selection,
owner proof, origin check, or secret handling changes in this slice.

Omarchy acceptance remains a real-laptop check: install, press Super+Space,
find Olympus with its icon, and open it. Compare with `olympus dashboard`;
confirm the owner dashboard loads and no secret appears in process arguments.
Repeat after upgrade and rollback. Check `engine verify`, then confirm the
entry/icon disappear after keep-data uninstall; use a disposable install for
purge. A custom XDG data directory and an unmarked user-edited entry should
also be checked. Container tests do not establish launcher discovery or browser
behavior on Hyprland.

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
| Doctor | Host probing currently skips standalone engine inspection outside Darwin (`src/core/doctor.ts:135`); missing-host guidance recommends engine install only on Mac (`:495`). |

## One lifecycle, platform-specific service management

Keep config reconciliation, sovereignty rules, health proof, quiet guard and
operation results shared. Introduce narrow launchd/systemd adapters for unit
rendering, installation, inspection, enable/start, disable/stop and removal.
Do not start a second `olympus-worker.service`: the engine owns its worker,
relay and embedding children. Refuse an existing competing host/data custodian
with exact conflicting paths and a stop/fresh-install remedy; do not disable another install silently.

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
| Package generations and pinned runtime generations | Fresh: `$XDG_DATA_HOME/olympus-engine/`; existing receipts keep `$XDG_DATA_HOME/olympus/engine/` |
| Indexes, model files, remote registration and child/status records | Fresh standalone: `$XDG_DATA_HOME/olympus/`; existing standalone receipts keep their recorded legacy data root |
| Install transactions, rollback receipts, engine/install logs | `$XDG_STATE_HOME/olympus/engine/` |
| Disposable downloads | `$XDG_CACHE_HOME/olympus/engine/` |
| Lifecycle lock and private worker socket (owner decision 2026-10-12) | `$XDG_RUNTIME_DIR/olympus/` |
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

Build for fresh-install new users, not migrations. Before any mutation, detect
existing Linux settings, credentials, indexes and competing custodians in both
legacy and selected roots. Refuse with the exact paths and a remedy: keep using
the existing installation, or stop its custodian and explicitly back up and
move the listed Olympus-owned data aside before retrying a fresh install.
Never move, adopt, overwrite or delete that data automatically. A matching W5
receipt permits repair/upgrade of that same installation; ambiguous or foreign
data still refuses. No legacy migration or unlock-and-migrate feature is in W5.

### Unit and commands

Proposed rendered unit (angle-bracket values are renderer substitutions,
not literal systemd environment expansion):

```ini
[Unit]
Description=Olympus standalone engine
StartLimitIntervalSec=0

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
RestartSteps=5
RestartMaxDelaySec=300
RestartPreventExitStatus=78
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
the CLI still waits for application health. The minimum is systemd 254 for
`RestartSteps`/`RestartMaxDelaySec`, subject to directive verification during
preflight. Disable start-rate limiting so transient failures keep retrying with
bounded backoff; exit 78 (`EXIT_CONFIG`, `src/core/engine-host.ts:41`, `:116`)
stays failed until the configuration is repaired. Doctor explains the cause
and offers `systemctl --user reset-failed olympus-engine.service`, followed
by `olympus engine start`; a reboot is not required to recover a failed unit.
See upstream [service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
Logs are private files with size/retention-bounded copytruncate rotation
(the manager holds append descriptors open; renaming alone cannot reclaim
the active file). Record the owned rotation mechanism in the receipt and
prove continued writes reach the truncated file. Copytruncate can lose lines
during its copy/truncate window; logs are not the durable transaction record.
Provide redacted `engine logs` output; do not send application payloads to the shared journal. Manager
metadata may still appear in the journal.

`KillMode=mixed` lets the host handle SIGTERM and stop its children first;
systemd then kills remaining unit-cgroup processes at main-process exit or
stop timeout. Detached process groups do not justify killing by name.
See upstream [kill semantics](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).
No engine service child may escape into another unit/scope. Prove worker,
model, relay and confinement-helper custody with real processes. The explicit
exception is a user-requested desktop viewer launched in its own user scope
(see source opening); engine restart/removal must not kill that viewer. Preserve identity checks for
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
in-flight state rather than claim completion. The host currently calls service
stop methods, waits for them or a 15-second deadline, then exits
(`src/core/engine-host.ts:42`, `:204`, `:221`). Thus finding 10's “no grace”
is too broad: stop is attempted, but children have no guaranteed *additional*
grace after host exit, even with `TimeoutStopSec=30`. PR 1c must test shutdown
during zkAPI settlement, forced child death and restart reconciliation: no
false completion, duplicate settlement or lost pending state. Normal logout
with verified linger must leave the engine running; test that on Omarchy.
Unknown custody blocks deletion.

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

All Linux lifecycle writers, including CLI rollback and shell uninstall,
share one nonblocking util-linux `flock` in the user runtime directory. Bun
has no built-in flock API: the CLI launches a trusted `flock --nonblock
--close <lock-path> <verified-operation-command> ...` supervisor, which holds
the lock descriptor for the entire operation, including recovery. Shell entry
points use the same supervisor/lock; nested operation calls reuse custody
without reacquiring. Service children do not inherit the descriptor. Do not
let cancellation release the supervisor while its mutation child still runs.
Never unlink a live lock inode or steal by PID/age. This is new Linux work:
Mac CLI rollback currently swaps without a lock (`src/core/engine-service.ts:1045`,
`:1066`); do not claim it already shares this mechanism or change Mac behavior. The
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
W5 upgrades and rollback require backward-readable schemas. Refuse an
incompatible version; data migration/snapshot machinery is outside W5.

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

A fresh standalone install durably writes `backend=file` (mapped to
`OLYMPUS_SECRET_STORE_BACKEND=file`) before starting any credential consumer,
including on desktops. Atomically publish and fsync the selection and its
parent directory, share it between CLI/service, and refuse conflicting ambient
overrides. Interrupted selection must not start a consumer in auto mode.
Existing data follows the refusal/remedy above; W5 offers no credential
migration. Desktop login never changes the persisted backend.

Retain libsecret only as an explicit owner selection, never auto-detection or
an automatic fallback. The current executable-presence test and swallowed
lookup failures (`src/core/secret-store.ts:79`, `:285`, `:354`) are inadequate.
For that opt-in, query the Secret Service collection/item D-Bus `Locked`
property before access; do not try an interactive unlock. Bound all D-Bus and
`secret-tool` operations to five seconds, terminate timed-out subprocesses,
and return typed locked/unavailable/permission/timeout errors through sync
and async callers and doctor. The current spawn has no timeout
(`src/core/secret-store.ts:359`). Only a successful absent lookup means missing.
A disposable random read/write/delete probe must be bounded and any failed
cleanup reported. Explicit libsecret failure never selects a file store or
claims unattended readiness. A backend disappearing mid-operation fails
clearly, without split writes, shadow values or resurrection on delete.

Keep the existing authenticated-encryption and lease/atomic-write machinery.
Harden key reads so missing key with existing ciphertext is a corruption/
recovery error, never generation of a replacement key. Reboot qualification
uses the local random key protected by user-directory permissions. This
protects a ciphertext-only copy, not against someone reading both files or
running as the same user/root. The local wrapping key `secrets.key` and the
worker bearer token in `worker.env` are both plaintext secrets at rest,
protected by 0700 directories/0600 files, not by ciphertext encryption
(`src/core/engine-service.ts:442`, `:931`; `src/core/worker-service.ts:622`).
Retention/removal reporting must list both; neither may enter logs or receipts.
Passphrase stores require an explicitly
provisioned unlock mechanism; a locked store is visibly unavailable after
boot. No passphrase in unit text, argv, journal or persistent plaintext env
file, and no unattended-readiness claim without proving unlock.

### PR 2 implementation seam (2026-10-12)

The SECRETS implementation persists `{ "version": 1, "backend": "file" }`
in `$XDG_CONFIG_HOME/olympus/secret-backend.json` before the Linux default
factory returns a credential consumer. Explicit `libsecret` selection is
persisted in the same file; conflicting ambient selections refuse. Existing
ciphertext/key files without that record require recovery or a fresh layout,
never migration. `secrets.enc` and `secrets.key` use the table's config root.

PR 1a integration point: replace `resolveLinuxSecretPaths` in
`src/core/linux-secret-backend.ts` with the shared receipt-bound resolver.
Until then it resolves and validates absolute HOME/XDG paths, and callers can
supply `encryptedFilePath`, `keyFilePath`, and `backendFilePath`. The installer
must resolve selection before starting consumers; CLI and service must receive
the same receipt-bound paths. This local resolver does not discover receipts.

The optional Secret Service backend requires `/usr/bin/python3` with
PyGObject/Gio (`python-gobject` on Arch; `python3-gi` on Debian/Ubuntu) and an
already provisioned, unlocked user Secret Service. It uses D-Bus directly:
`secret-tool`'s password helpers may unlock during access, so they cannot
preserve the no-interactive-unlock rule across a lock race. Every helper has
a five-second SIGKILL deadline; neither Unlock nor Prompt is invoked. Missing
dependencies refuse as unavailable. Its explicit `probe()` exercises disposable
write/read/delete and reports failed cleanup, but proves no reboot unlock.
CI exercises a private fake Secret Service; real Omarchy logout/reboot,
unattended file access, and desktop keyring behavior remain host acceptance.

## Desktop source opening and headless approval

Share target validation with the Mac; platform adapters change dispatch only.
The worker resolves a provider locator, never accepts a raw path or command
from a browser/agent. Repeat realpath, containment and regular-file checks
at dispatch. Keep `OPENABLE_EXTENSIONS` as the single extension allowlist.
For Linux, map each allowed extension to its expected MIME type(s), with
explicit aliases where needed. Require `xdg-mime query filetype` using the
same desktop environment/resolver as xdg-open to agree before file dispatch;
unknown, failed, mismatched or unqualified resolver results open only the
validated parent folder. An extension alone is insufficient: the current
adapter checks only the suffix (`src/workers/dropbox-files/open-target.ts:155`).
Include HTML/script content named `invoice.pdf` as a failing-first fixture;
never dispatch it as a document. Revalidate the target after the bounded MIME
probe. On Linux, spawn a trusted xdg-open executable with one absolute path argument and a
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
At each open, require an active `graphical-session.target` and read current
`WAYLAND_DISPLAY`/`DISPLAY` from `systemctl --user show-environment`; validate
and copy only the required desktop variables, never import the entire shell
environment. Omarchy's uwsm and GNOME session integration are the intended
providers; neither distro name alone proves readiness. Qualify the actual
session/opener. Missing target, absent/stale display or unsupported integration
refuses local opening with a remedy to start a systemd-integrated graphical
session or use the remote panel/provider preview. No bespoke helper, XDG
autostart assumption or edit of the user's Hyprland configuration is needed.

Linux `resolveServerMode` must use this live readiness result rather than the
lingering engine's boot environment (`src/core/remote-open.ts:86`), while
preserving an explicit remote-mode choice. Dispatch via
`systemd-run --user --scope -- <trusted-xdg-open> <validated-path>` with a
sanitized session environment, separate from the engine cgroup. See upstream
[scope semantics](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml).
This user-requested viewer is exempt from engine-child custody and uninstall
cleanup. Bound the launch/probe without treating a long-lived viewer as a
hung engine child; prove engine restart leaves the viewer alive. If dispatch
fails, report failure and offer an authorized provider preview. An unsupported
file type opens its folder, never the file itself.

For headless sources, open the authenticated panel in the second computer's
browser using the existing SSH-forward and one-time launch-ticket route.
Provider web previews open there after the same authorization checks; a
server-local path does not become a client-local path. For local-only files
say that no desktop is available on the engine host. W5 adds no general file
transfer endpoint and exposes no filesystem path in model-visible output.
Private answers remain in the private panel.

### Owner decision: Linux approval boundary (finding 1, decided 2026-10-12)

Loopback is not an owner identity. A different local UNIX account can fetch
the consent page and forge navigation headers, and can occupy the TCP port
while the engine is down. The existing checks establish direct loopback,
CSRF and browser navigation, not UID ownership
(`src/workers/remote-oauth/handler.ts:278`, `:285`, `:746`;
`docs/design/chatgpt-plugin.md:1371`). SSH authentication alone does not remove
that engine-host risk. **Owner decision 2026-10-12: only the owner's account
can reach approval on Linux.**

Decided design: put the Linux approval/worker endpoint on a Unix socket at
`$XDG_RUNTIME_DIR/olympus/worker.sock`, inside an owner-owned 0700 directory
with a 0600 socket. Validate ancestors/ownership and refuse unsafe or occupied
paths; no parallel unauthenticated TCP approval listener. Remote browsers
reach it through an authenticated owner SSH account, for example:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:/run/user/<uid>/olympus/worker.sock <configured-ssh-target>
```

Use the validated runtime path, not an assumed UID/path. The TCP end is local
to the second computer, so that computer must also be trusted against other
local users (or use the owner-code factor there too). Same-UID processes and
root remain trusted; socket permissions cannot separate them. PR 4 must adapt
worker health, relay/CLI clients and direct-transport validation for the socket,
without treating a forged HTTP header as proof of socket origin. A desktop browser uses the owner-proven session-origin bridge below. Headless
browsers continue to use the authenticated socket forward.

**Desktop amendment, approved by the owner on 2026-10-12:** a graphical
session may additionally expose an owner-proven browser bridge. The private
socket remains the backend. Each engine instance and each desktop listener
epoch uses a fresh 128-bit base32 label under `.localhost`, on the configured
port. The fixed loopback entry serves only a bodyless 303 to that current
origin, preserving path/query and browser fragment inheritance. It never sets
cookies or runs scripts. Old session Hosts and every Host mismatch refuse.

`olympus dashboard` asks the private socket to open an owner ticket: exclusive
0600 HTML inside the validated 0700 runtime directory. The trusted desktop
opener receives only the absolute filename in its separate systemd scope;
no secret enters argv. The file holds a random challenge and the expected
HMAC-SHA256(ticket, challenge). Before navigating, its script asks the current
session origin's `GET /owner-proof?challenge=…` for that answer. Only an exact
match permits same-window navigation to `/owner-proof#<single-use-ticket>`.
The probe sends the challenge alone, never the ticket. A fake listener's wrong
or missing answer leaves a clear refusal in the private file without sending
the ticket. This is an additional layer, not connection-bound authentication:
a hostile listener able to relay to a real bridge could relay the challenge
answer too. Holding both loopback families, and revoking every ticket before
either is released, is the load-bearing boundary. A restarting worker returns a CORS-readable retry response; both
the probe and redemption wait with “Olympus is restarting…” wording.
Resolution failure stays on a clear refusal with the SSH fallback, never the
fixed origin. Redemption claims the ticket exclusively before asynchronous
session establishment and removes the file. Transport failures and worker 503
responses retry; other session refusals are final. When the worker restarts,
only the same live, unexpired, unreplaced claim can retry; its file is not
recreated and its 60-second expiry is never extended. Success permanently
spends it before publishing the session. CLI/control-socket and browser confirmation each have a ten-second limiter
and one pending ticket; browser requests cannot replace the CLI's pending file
or consume its limiter. The browser lane also permits at most six opens in a
rolling hour per listener epoch; excess requests receive 429 with the existing
refusal wording. CLI opens have no hourly cap. Unauthenticated `POST /owner-open`
ignores the posted target and opens only `/dashboard`. Confirm tells the owner:
“Approve in the Olympus window that just opened. This page continues by itself.”
The original tab watches this origin's storage event and polls once a second
for proof, then fetches its own unchanged path/query and replaces the document.
Waiting is bounded by the ticket's 60-second lifetime. A different browser
profile cannot resume it; timeout says “Open this page again from the Olympus window.”
At most sixteen 12-hour owner sessions are held.

An HttpOnly, SameSite=Lax, host-only cookie is bound to this bridge instance.
**Cookies alone are insufficient:** cookies cross ports, so every content
read and privileged socket dispatch also requires an independent random proof
in this origin's localStorage. A navigation without both proofs receives only
a constant confirmation shell. The shell fetches the actual document with
the storage proof; native consent forms attach that proof separately and
retain the worker's CSRF, Origin and navigation checks. The bridge validates
external Host and Origin before rewriting the proven request for the socket.
It never adds a worker bearer to browser requests. After private-ticket proof, the socket also establishes the existing dashboard
control session so an OAuth-first owner can subsequently open the dashboard.
Dashboard launch tickets and control-session CSRF remain the existing worker
mechanism. No browser request gains an injected bearer.

Browser and socket fetches never follow redirects with the storage proof.
A browser fetch receives an inert destination and performs ordinary navigation;
form responses use 303. Reconstructed documents use the bridge response-header
policy and the worker policy as a meta element, with the bridge bootstrap
additionally authorized. Header-only worker directives (`sandbox`, `report-to`,
`frame-ancestors`) cannot survive `document.write`; this is not an exact copy
of the worker response CSP. All pages
set `worker-src 'none'`, and every `Service-Worker` request is rejected.
`Clear-Site-Data` clears entry cache/storage and proof-response cache; it is
not treated as a way to revoke a hostile running tab. Fresh origin isolation
provides that boundary. All bridge content is no-store.

Live graphical readiness and the current server-mode setting gate startup,
every request, and post-await publication. A coalesced asynchronous two-second
observer in the long-lived standalone engine host performs bounded desktop probes (up to three seconds per command);
HTTP requests only read its snapshot, never spawn subprocesses. When the
observer detects logout or server-mode enable it closes the listener and
revokes proofs; requests immediately refuse the unavailable snapshot. Relogin creates a new
origin. The bridge binds `127.0.0.1` and `[::1]` at the configured port as one
listener lifecycle. A collision on either family releases both and reports
`port_in_use`; no partial listener is published. Before taking the configured
port, a real Bun bind to `::1` on port 0, immediately closed, probes IPv6
availability. Bun reports unavailable addresses as `EADDRINUSE` too, so error
codes cannot decide availability. A failed probe permits IPv4 alone, explicitly
reported as `desktop_bridge.ipv6=unavailable`; a successful probe makes ANY
configured-port IPv6 bind failure fatal to both families. While IPv6 is
unavailable every refresh re-probes. If IPv6 appears, the manager revokes the
old epoch's sessions and tickets before releasing IPv4 and trying both families
with a fresh origin. An IPv6 squatter then leaves both families unheld and
status `port_in_use`, never a live IPv4-only origin beside the squatter.
Release of either socket revokes the epoch
and releases both; a subsequent bind gets a new origin. A port collision leaves
the owner socket running, opens no replacement
listener and reports `desktop_bridge.state=port_in_use` plus its remedy through
socket health, engine status and doctor. Headless hosts open no TCP listener.
Mac browser, socket-free transport, and page output are unchanged.

**Invariant: an origin and its owner sessions may be reused only while their
TCP listener has remained continuously bound; every release revokes the epoch.**
The standalone engine host owns the listener, in-memory hashed sessions and
readiness observer. The host probes the real worker's `/v1/health` over its
private socket. Two consecutive health failures mark it restarting; one
success resets the count. Desktop absence still revokes immediately without
waiting for worker health. Status is durably written only on a change.
A worker settings reload, crash or kill releases only its
Unix socket: the host keeps the TCP port bound and returns a constant styled
“Olympus is restarting…” page with automatic retry in the same window, no
bootstrap or proof material. The worker asks an owner-only 0600 Unix control
socket in its validated runtime directory to open tickets and read status.
No desktop session state is saved or restored from disk; old session files
are ignored. Stop, host crash/kill, engine restart, logout and server mode
release TCP and force a fresh random origin, rejecting old cookies/proofs.
Foreground workers own only their own listener and also rotate on exit;
startup signals never revoke another instance's runtime state. The stale
reload-readiness restoration decision is gone: the host continues observing
desktop presence while the worker is absent, and logout closes the listener.
The private ticket file is the opening view of the same Olympus window; after
single-use redemption the bridge renders the requested document there. No
disposable owner-check window is opened or closed, and no proof is sent with
a redirect or exposed in opener arguments.

Rejected alternative (kept for the record): retain loopback but require a short-lived, single-use code
issued only by the owner's CLI, bound to the pending install/client/redirect/
state/PKCE approval transaction. Never expose it through an unauthenticated
HTTP endpoint or logs. Bound attempts and atomically consume it; CSRF, origin
checks and explicit consent still apply. This protects approval but does not
by itself prevent TCP port squatting. A stable port number is insufficient:
the host must hold both loopback families throughout any reused epoch, because
Chromium may resolve the random `.localhost` name to `::1` first. IPv4 custody
alone leaves the same port available to an IPv6 squatter from another account.
Fail on collisions and prove listener identity before submitting an owner code.

Conditional headless connection sequence after the owner's choice:

1. Establish the selected owner-authenticated route with the configured SSH
   target; refuse forward failures/collisions. Browser-only clients receive
   manual commands. No public bind or firewall opening.
2. Start/restart ChatGPT connection while the route is alive. Preserve the
   relay bridge's original OAuth query, client, redirect, state and PKCE.
   A dashboard launch ticket opens the panel only and is never consent.
3. Require the selected owner proof, existing CSRF/navigation checks and an
   explicit consent click; keep relay/public approval rejected. Do not reuse
   the demo password path for real installs.
4. Follow only the validated callback, exchange the code, and make one real
   authenticated tool call. Wrong install, expiry, replay and denied consent
   fail closed. Test Linux-local client callbacks separately from ChatGPT's
   web callback.

Reuse remote-open's bounded tunnel/instruction flow with the selected transport;
do not broaden `OpenTarget` to arbitrary URLs. PR 4's conditional regression
must prove “other local user cannot approve,” including forged browser headers.

## Doctor coverage

Doctor reports independent facts and remedies, without printing credentials:

| Check | Required diagnostic/proof |
|---|---|
| Host and service | Standalone Linux recognized without OpenClaw; user bus accessible; unit owned and valid; enabled/active/build/health distinguished; config-exit/backoff/start-limit diagnosed with repair and reset-failed/start commands; conflicting worker or host refused. |
| Persistence | Linger known and enabled; login-only or unavailable state is unhealthy for this install contract; read-only doctor never enables linger. |
| Paths and recovery | Effective XDG roots match receipt and every child; permissions/ownership safe; no unfinished transaction; previous generation/runtime usable; disk headroom reported. |
| Process custody | Manager MainPID/cgroup agrees with current host; no stale competing listener or escaped recorded child; unknown observation is not healthy. |
| Runtime capabilities | Exact Bun pin, CPU/glibc loadability, model manifests and actual runtime probes; W1–W4 results surfaced separately from engine health. |
| Credentials | Selected backend and reason; locked/unreachable/corrupt versus absent; unattended unlock state; no secret values, refs or probe residue in output. |
| Opening and consent | The host owns the desktop TCP listener across worker reloads and reports listening/restarting, headless, collision or unavailable without credentials; every listener release rotates the origin. Current desktop session plus xdg-open/handler readiness, or explicit remote mode with configured SSH target/instructions; missing target is actionable. Read-only diagnostics never mint consent or approve. |
| End-to-end reachability | Worker readiness and relay connection are distinct; relay offline can coexist with a healthy local engine. Connection smoke proof is a separate authorized action. |

## Independently reviewable landing plan

These are implementation PRs, not changes made by this document. Each keeps
Mac regression coverage and has tests of observable behavior that fail without
its change. Critical PRs require fresh independent review under
`docs/ENGINEERING_PROCESS.md:76`, focused proof, required head CI and exact-main
CI. No deployment follows automatically. No new general-purpose process gate.

Every row below includes a unit-level failing-first test run by the existing
Bun CI lanes; real service-manager proof is additional, never replaced by
command mocks. PR 1b adds the **systemd-as-PID-1 container with linger** CI
harness: a disposable container with its own cgroup namespace/delegation,
logind, a dedicated ordinary account and enabled linger. The driver uses
`systemctl --user -M <test-user>@.host` inside that container to reach the real
user manager. Wire it into CI with prerequisite failures reported as failures,
not skipped success. It uses no host user state or compositor. The current
Ubuntu runner alone is not that harness. Real reboot, Hyprland and logout
checks belong to Omarchy acceptance, not claimed unit coverage.

| PR | Scope and dependency | Unit-level failing-first proof in CI | Additional proof |
|---|---|---|---|
| 1a. Layout and receipt | Shared path plumbing and private receipt; refuse pre-existing unowned data; no systemd adapter or admission changes. | Nondefault XDG fixtures reach each consumer; ambiguous receipts and legacy data refuse before writes with exact paths/remedy. Mac path/output fixtures remain byte-for-byte unchanged. | Audit all CLI/worker/secret/doctor path consumers; symlink/foreign-owner fixtures leave the filesystem unchanged. |
| 1b. Systemd adapter and status | Depends on 1a; rendering, lifecycle commands, custody, backoff, copytruncate and doctor host/status checks. Adds the CI harness above. | Inject inaccessible manager, stale PID/build/HTTP result and config exit 78; status must be unknown/unhealthy, renderer must prevent config restart and use backoff. Rotation fixture writes through an already-open descriptor after truncation. | PID-1 container: real start/stop/crash removes detached engine grandchildren, repeated transient failures continue retrying, exit 78 stays stopped, enabled state and log rotation match the contract. |
| 1c. Maintenance admission fence | Depends on 1b; shared worker admission/drain and lifecycle fence on both platforms. | A deterministic admission/drain race rejects new work; timeout releases the fence without stop. Inject shutdown during zkAPI settlement and replay recovery twice: no false completion, duplicate settlement or lost pending record. | PID-1 container: kill host/children during settlement, then verify reconciliation. Omarchy: logout does not interrupt settlement; real shutdown/reboot recovery. |
| 2. Durable secret backend | Can proceed independently; integrates 1a paths. Fresh file selection, explicit-only libsecret and typed failures; no migration. | Interrupt selection publication: no consumer may start in auto mode. A present `secret-tool` cannot change fresh `backend=file`; desktop login cannot switch it. Locked D-Bus property, timeout and permission fixtures fail explicitly, never false missing or file fallback. Lost key with ciphertext refuses. | CI private D-Bus fake Secret Service plus hung subprocess proves bounded calls/cleanup; concurrent write/delete/restart and corrupt-store fixtures. Omarchy reboot proves unattended file storage. |
| 3a. Runtime pins and publisher | Verified Linux architecture pins, archive/executable checks and publisher filling; no install transaction. | Missing pin, tampered archive and tampered cached executable refuse before execution; publisher fixture cannot emit an unfilled template or overwrite prior assets. | Each architecture needs real CPU/glibc/loadability proof before publication; x64 does not qualify arm64. |
| 3b. Install/upgrade transaction | Depends on 1a–1c, 2 and 3a; Linux installer, util-linux flock supervisor, durable recovery and lifecycle doctor. | Fault injection at every durable boundary recovers twice; same-release repair retains previous; failed upgrade versus failed rollback health are distinct; missing tools/bus/linger refuses before active mutation. | CI subprocess contention for install/rollback and cancellation keeps the lock through mutation; PID-1 container proves real activation/recovery. Shell syntax/ShellCheck; reboot/power-loss acceptance on Omarchy. |
| 3c. Uninstall and purge | Depends on 3b; receipt-bounded shell removal without Bun/app; optional explicit data purge. | Receipt fixtures preserve unrelated files/replacements, retain data by default, remove only enumerated owned artifacts with consent, and refuse deletion on unknown custody; repeat interrupted removal safely. | PID-1 container: uninstall without Bun/app, install/rollback/uninstall lock contention, cgroup/listener release and purge inventory. Omarchy: final runtime-directory teardown and explicit linger restoration. |
| 4. Desktop opener and headless handoff | Depends on 1a/1b; live graphical readiness, separate viewer scope and bounded tunnel reuse. Approval backend is the owner-only Unix socket; the approved desktop bridge adds per-session browser origin and owner proof. Public capabilities wait for 5. | Shared private/unreadable dispatch rejects symlink swaps/traversal/argv injection/revoked eligibility. HTML/script disguised as `.pdf` and unknown MIME open only the folder. Inactive graphical target/stale display refuses; manager environment can prove desktop readiness when engine env lacks DISPLAY. **Owner-only socket:** other local user cannot approve, including forged headers/replay. | PID-1 container: viewer fixture in its own scope survives engine restart; socket permission boundary tested with a second UID. Omarchy: actual Hyprland viewer, login/logout readiness and second-computer OAuth/tool call. |
| 5. Consumer integration and qualification | Depends on all prior parts and relevant W1–W4 proof; **after OpenAI review closes**. Host-neutral payload/decoder, copy inventory and supported entrypoints. | Old/new payload compatibility, Linux never says “opened on Mac,” unsupported architecture/optional lanes remain unavailable, frozen demo/listing fixtures unchanged until authorized publication. | Omarchy acceptance below; independent review and required exact-head/exact-main CI remain required for each critical implementation PR. |

PRs 1a–4 can land internally without altering the reviewed listing or serving
changed plugin bundles; the owner-only approval route stays disabled
until proven. Publication is a separate explicitly authorized
action after review closure. Runtime pin qualification and schema compatibility
are engineering proof tasks; finding 1 was decided by the owner on 2026-10-12.

### SVC implementation handoff (2026-10-12)

Rows 1a, 1b and 1c have separate local commits. The focused remote run passed
136 tests across nine files, followed by `bun run build` and
`bunx tsc --noEmit -p .`. Failing-first runs preceded the layout, service and
admission implementations. A checked-in pre-change Mac plist fixture preserves
its exact bytes; the retained Mac lifecycle tests pass. Fresh independent
static review found no remaining P1/P2 findings after custody and alternate-root
repairs. This is unit/subprocess proof, not service-manager qualification.

Integration seams for the neighbouring tracks:

- `src/core/linux-engine-layout.ts` exports `resolveLinuxEngineLayout(env)`,
  `linuxEngineEnvironment(layout)`, `preflightLinuxEngineLayout(layout)` and
  `publishLinuxEngineReceipt(layout)`. Consumers discover the receipt from the
  default and explicitly selected config roots. `workerSocketPath` is the
  owner-only socket location; `configDir`, `secretsPath`, `secretsKeyPath` and
  `workerEnvPath` are the secret/backend track's path seam. Runtime is required
  and validated at mutation preflight; read-only resolution does not invent it.
- PR 4 must provide the socket transport at that path, including native worker
  readiness and relay/CLI clients. Only its proven package may declare
  `package.json` → `olympus.linuxApprovalTransport = "owner-unix-socket-v1"`.
  The service installer refuses activation without that declaration; this
  branch does not declare it. Health requests already use the Unix socket.
  This declaration is a package integration seam, not a user override or a
  replacement for PR 4's second-UID proof.
- `lifecycleLockPath` identifies the lifecycle lease target. Core commands use
  the process-instance-aware `file-lease.ts` protocol with no live-owner age
  takeover. PR 3b owns the kernel-flock installer supervisor and must coordinate
  that outer transaction with this lease; flock and the lease are not equivalent
  merely because they name the same path. `service-current.json` and
  `service-previous.json` in `stateDir` retain the program, unit, prior config,
  build identity and matching Bun digest for service rollback. Durable package
  generation exchange and interrupted-install recovery remain PR 3b's scope.
- `src/core/engine-maintenance.ts` exports sync and async maintenance fences,
  plus worker and session admission. Both use the consult state path; worker
  preparation may nest session admission. Lifecycle holds the fence before
  drain through service mutation (and through rollback health/restoration).
  Forced process death preserves the existing durable settlement record;
  recovery replay is covered twice without a duplicate recovery dispatch.

The PID-1 systemd/logind CI harness is deferred: the available isolated test
runner does not supply its own delegated systemd user manager and linger.
No command mock is claimed as that proof. Before rc.7 host qualification,
run the Omarchy acceptance below, especially alternate XDG roots, actual
FragmentPath/enablement, linger/logout/reboot, detached child-cgroup cleanup,
copytruncate under the manager's open descriptors, and shutdown/recovery during
settlement. Ubuntu and arm64 are not qualified by these tests. Linux zkAPI,
listing/demo changes and publication remain outside this activation proof.
### PR 4 implementation handoff (OPENER, 2026-10-12)

The backend implementation is in `src/core/worker-transport.ts` and
`src/core/linux-desktop-opener.ts`. Qualification is still pending; this does
not enable or publish Linux source-open controls under the legacy `kind: mac`
payload. PR 5 must adapt that payload/decoder before wiring
`openLinuxDesktopPath({ path, roots, revalidateEligibility })` into the private
and unreadable controls. Its result distinguishes file from folder opening.
Both existing capability owners now supply an eligibility callback that the
adapter must call after its awaited probes, immediately before dispatch.

The worker binds only the Unix socket on Linux. The CLI, health, relay and
legacy worker readiness probe use that transport; the browser's HTTP origin
stays unchanged for cookies and CSRF. The relay preserves manual redirects
without following them. `workerSocketPath`/`validateWorkerSocket` are the
lifecycle seam: pass the resolved `XDG_RUNTIME_DIR` to every engine child and
CLI invocation. They refuse missing/unsafe runtime directories and occupied
socket paths; they never remove an old socket or start a TCP alternative.
Crash recovery of a retained socket requires custody proof from the lifecycle
track before removal. The standalone clients use Bun's Unix fetch support;
a non-Bun Linux caller refuses rather than falling back to TCP.

The remote model adds optional `socketPath`; existing Mac payloads and command
text keep their old form. CLI and panel print the validated equivalent of:

```text
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:<socket> <target>
```

The frontend transport addition is required to prevent the old instructions
from forwarding to an unrelated Linux TCP process. It changes no listing,
demo configuration or public deployment. Linux private-source controls stay
disabled until the PR 5 host-neutral capability lands. A browser on the Linux
engine host uses the owner-proven desktop bridge when graphical readiness
is confirmed; otherwise it needs the authenticated SSH socket forward.

Real-host qualification remains: second-UID denial (the isolated build runner
cannot change UID), PID-1/cgroup viewer survival across engine restart,
Hyprland login/logout and MIME resolver behavior, and OAuth plus a real tool
call from a second computer. The second-UID regression is executable in a
privileged disposable Linux test environment and skips explicitly otherwise.
Mac regressions here exercise preserved transport/argv contracts in fixtures;
this is not native Mac GUI qualification. zkAPI activation is outside OPENER
and remains disabled for Linux launch.

Focused OPENER validation: remote build and TypeScript check passed, followed
by 158 tests passing with one explicit second-UID skip across
`worker-transport`, `linux-desktop-opener`, `remote-open`,
`chatgpt-private-open`, `unreadable-files`, `local-private-answers`,
`architecture-guard`, `public-surface-guard` and `private-ops-disposition`.
The independent critical review found no remaining actionable P1/P2 after
manual-redirect preservation, browser socket handoff and viewer stdio fixes.
Required hosted CI and real-host qualification remain unrun in this local-only
handoff. The existing Mac open argv and remote handoff fixtures passed. Additional
CLI and native-worker/native-relay regressions exercise Linux socket health
and handoff end to end while retaining explicit TCP lifecycle fixtures.

### Deferred copy inventory (PR 5 only)

| Surface | Change after review closes |
|---|---|
| Private answer payload/panel and source-open feedback | “your computer” when colocated; explicit engine-host kind/location when remote. Update `kind: mac` compatibly, decoder and localized labels (`src/workers/chatgpt/private-answer-jobs.ts:1243`, `src/workers/dashboard/chatgpt/private-answer.ts:138`, `:693`). |
| Dashboard, doctor and setup status | Distinguish Mac, Linux desktop and headless host, including no-desktop/locked-store/persistence limitations. Mac-specific doctor text exists at `src/core/doctor.ts:495`, `:513`. |
| Relay disconnected/offline/errors and approval bridge | Replace “Your Mac” with neutral text unless a verified host kind is available; no new machine identifier needed (`connect-relay/server/relay-mcp.ts:45`, `:174`; `connect-relay/server/authorize-bridge.ts:56`). |
| OAuth consent/refusal | Explain the owner-selected remote approval route while preserving CSRF/client checks (`src/workers/remote-oauth/handler.ts:280`; `src/workers/remote-oauth/consent-page.ts:179`). |
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
   not execute. Also use HTML/script content disguised as a PDF and prove
   only its folder opens. Exercise symlink/revocation refusal and stale desktop
   session; a viewer in its separate scope must survive an engine restart.
3. Use a second computer for the remote-open panel and ChatGPT approval.
   Complete OAuth plus a tool call; one Personal question yields cited
   evidence and one Private question is answered only in its private panel.
   Under the chosen approval boundary, prove a second local UID cannot approve.
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
   unrelated process killed. Interrupt zkAPI settlement during shutdown and
   prove crash reconciliation on reboot without duplicate settlement or false
   completion; ordinary logout must not interrupt it. Stop stays stopped after reboot.
7. Normal uninstall leaves no installed machinery and accurately lists kept
   data. A fresh reinstall refuses retained data with exact paths and a remedy;
   it never adopts it. Explicit full removal in this dedicated account
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

**Decided 2026-10-12 — finding 1:** only the owner's account can reach
approval on Linux: the private Unix worker socket with SSH socket forwarding
for a second computer. PR 4 carries the “other local user cannot approve”
test.

Settled scope: fresh installs with existing-data refusal (no migrations),
default retention with explicitly chosen full removal, the OpenAI-review
freeze, and Omarchy qualification with Ubuntu proof skipped.

## Review disposition against the code baseline

Findings 1–10 are incorporated above: 1 was decided by the owner (owner-only socket);
2–9 require design changes; 10 requires shutdown/settlement recovery proof.
Two review claims need narrower wording, without dismissing their risks:

- Finding 6's “dead until reboot” means automatic retries can stop; reboot is
  not the only recovery. Repair plus reset-failed/start is the documented
  remedy. Config exits really are 78 (`src/core/engine-host.ts:41`, `:116`).
- Finding 10's “no grace on shutdown or logout” overstates current host
  behavior: service stop methods run before the 15-second deadline and exit
  (`src/core/engine-host.ts:204`, `:206`, `:221`). Remaining children can still
  be cut off immediately at host exit under mixed kill mode. A lingering
  engine should not stop on ordinary logout; that is an acceptance invariant.

Finding 5's existing CI limitation is visible in `.github/workflows/verify.yml`:
it runs Ubuntu jobs without the proposed PID-1/linger harness. The new tests
and harness are implementation obligations, not results claimed by this doc.
The missing-host hint citation is corrected to `src/core/doctor.ts:495`;
`:481` only appends the installed engine to the host list.

## W5 PINS implementation handoff (2026-10-12)

Scope: PR 3a runtime/publisher; PR 3b and 3c **drafts**, for rc.7.
No listing, Mac download route, live deployment or Linux qualification is changed.

### Runtime evidence

The Mac bootstrap (`scripts/install-macos.sh`) pins only Bun 1.3.14.
The Linux bootstrap uses that version's **x64 baseline** build. On 2026-10-12:

- [GitHub release API](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.3.14)
  reports `bun-linux-x64-baseline.zip`, 35,595,658 bytes, SHA-256
  `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7`.
- [Bun SHASUMS256.txt](https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt)
  agrees. An independently downloaded archive matched both size and digest.
- Its sole program, `bun-linux-x64-baseline/bun`, is 91,802,480 bytes, SHA-256
  `a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791`.
- [Versioned upstream requirements](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/installation.mdx)
  specify glibc >=2.17 and Nehalem/SSE4.2 for this baseline. These are upstream
  floors, not a claim that we tested a physical Nehalem or glibc 2.17 host.

A remote-build isolated Linux x86_64 container independently fetched those
bytes, verified both digests, then ran `bun --version` (1.3.14), JavaScript and
an in-memory SQLite query successfully on glibc 2.36. This is actual execution,
not physical-host or minimum-floor qualification.

`config/linux-runtime-pins.json` is the pin authority. It records
`qualified-omarchy` since 1.0.0 (2026-10-14, owner-approved): the owner's
Omarchy x64 laptop (glibc 2.44, SSE4.2) ran the full 1.0.0 release test on this
exact Bun executable. Asset publication refuses while it reads `pending-omarchy`.
arm64 is absent and refused. No Linux Tor/zkAPI capability is enabled here.
Existing model runtime authorities are unchanged: llama.cpp b11320 in
`src/workers/source-index/built-in-reasoning/manifest.ts`, LiteRT-LM 0.18.0
in `src/workers/source-index/built-in-embedding/manifest.ts`. They are not
additional runtimes downloaded or pinned by the Mac bootstrap.

### SVC seams: drafts, not an implemented transaction protocol

The shell does preflight and verified private staging only. It does not swap
active packages, write service units, select a secret backend or implement
another recovery journal. SVC must implement these dependencies before the
drafts become a qualified installer:

1. **Install:** verified scratch Bun invokes
   `engine install --from-checkout <verified-package> --bun <verified-bun> --restart`.
   The same command with `--dry-run` (instead of `--restart`) runs first under
   custody and must reject unsupported capabilities, unsafe/existing data and
   paths without mutation, before linger changes. These flag spellings already exist in `src/core/engine-cli.ts`. On Linux the
   implementation must copy both inputs into durable immutable generations
   before returning; scratch is removed on exit. It must validate package build,
   layout, receipt, existing-data refusal, file-secret selection, zkAPI-off and
   owner-only worker socket. Durable prepare/switch/commit/recovery, exact-build
   health, same-release repair, rollback and cleanup belong to SVC, not these
   shell drafts. Nonzero means failure, including failed health or recovery.
2. **Lock:** `${XDG_RUNTIME_DIR}/olympus/lifecycle.lock`, same owner, mode 0600.
   Installer runs `flock --nonblock --close <lock> /bin/sh <private-helper> ...`;
   the helper runs read-only admission, linger, install and status while locked.
   Uninstaller runs the verified Bun command directly under that supervisor.
   CLI lifecycle operations must recognize actual util-linux supervisor custody
   (verified ancestry/identity, not an environment flag) and avoid reacquiring.
   Direct CLI install/rollback/uninstall must acquire that same lock. Check
   paths and receipt again under custody. Ordinary HUP/INT/TERM is ignored
   until the mutation returns so cleanup cannot overtake it; no claim is made
   that killing the supervisor with SIGKILL is safe. CLI/service descendants
   must not inherit the descriptor. Never unlink the lock.
3. **Linger:** under the same lifecycle lock, bootstrap probes and enables only the current account without
   a password agent, then re-reads the state. `OLYMPUS_LINGER_BEFORE=yes|no`
   conveys the observation for a fresh receipt; an existing receipt's original
   state wins on repair. SVC must persist it before active mutation. Failures
   disclose it; neither draft disables account-wide linger automatically.
4. **Status:** `engine status` emits JSON with a boolean `ok`. The draft checks
   that value; a zero exit by itself is insufficient (current Mac status can
   return `ok:false` with exit zero). Install owns exact-build health proof;
   status adds diagnostics, not a replacement for that proof.
5. **Removal receipt:** SVC atomically writes a 0600, owner-owned non-executable
   projection at `$XDG_CONFIG_HOME/olympus/uninstall-receipt.tsv`. Exactly eleven
   tab-separated key/value lines, unique keys, no control characters:

   ```text
   schema          olympus.linux-uninstall.v1
   uid             <decimal owner uid>
   bun             <absolute immutable engine runtime executable>
   bun_sha256      <executable SHA-256>
   cli             <absolute immutable engine generation>/dist/cli.js
   cli_sha256      <bundled CLI SHA-256>
   config_root     <resolved XDG config root>
   data_root       <resolved XDG data root>
   state_root      <resolved XDG state root>
   cache_root      <resolved XDG cache root>
   linger_before   yes|no
   ```

   The illustration uses spaces for readability; the actual delimiter is one
   tab. This projection is a proposed seam, not the canonical receipt schema.
   The shell validates it, ancestry and executable hashes, then calls
   `engine uninstall` under the same lock. SVC must revalidate its canonical
   receipt, require maintenance/cgroup/listener release, remove only enumerated
   owned machinery, preserve replacements and all personal data by default,
   keep recovery evidence until finished, and return nonzero for incomplete
   removal. The draft does no guessed recursive deletion.

### Explicit remaining work

PR 3b is deferred beyond the tested shell draft: no claim of durable
transaction/recovery proof, fault injection at SVC's durable boundaries,
backoff directive verification, direct-CLI lock interoperability, or PID-1
activation proof. The bootstrap disk check covers scratch only; SVC must
check destination generation headroom before mutation.

PR 3c is deferred beyond the tested receipt/CLI draft: **missing or corrupt
Bun/app refuses and preserves everything**. The design requires system-tools-only
removal in that situation; that implementation, explicit purge inventory and
consent, profile/MIME/link cleanup, resumable removal and optional linger
restoration still need SVC's final receipt/custody contract. The current draft
rejects purge flags instead of claiming full removal. Its fake-CLI tests prove
argument/custody/verification boundaries, not the deletion algorithm.

Before Linux publication, run on the owner's Omarchy laptop: pinned CPU/glibc
loadability; systemd PID-1/user-manager activation; missing-tool and denied-linger
refusal; logout/reboot/unattended startup; real socket ownership; install/rollback/
uninstall contention and SIGKILL/power-loss recovery; same-release repair; exact
build health; Bun-free removal/purge/replacements; runtime-directory teardown
and explicit linger restoration. Ubuntu is not qualified by the container run;
its unsupported capabilities must refuse. Mac scripts remain byte-for-byte
identical; real native Mac regression remains separate from Linux shell mocks.

### PINS validation receipt

The PINS working snapshot passed 89 tests across
`install-linux-script`, `publish-release-to-site`, `architecture-guard`,
`public-surface-guard` and `private-ops-disposition` via remote-build.
One existing rsync deployment simulation was skipped because the isolated
image lacks rsync; publisher asset-preservation fixtures ran and passed.
Both `/bin/sh` and dash ran the new scripts. ShellCheck 0.10.0 checked both
scripts and the generated activation helper. Tests exercise actual util-linux
flock contention across install/uninstall and process-group SIGTERM; lifecycle
commands remain fakes, so they do not qualify SVC or real systemd behavior.
Mac bootstrap/uninstaller SHA-256 fixtures match the original bytes.

`bun run build && bunx tsc --noEmit -p .` passed through remote-build.
No built-in-reasoning installer tests were run. Independent static review
found and closed two P2s before this proof: linger observed outside lifecycle
custody, and the Mac publisher overwriting an archive already pinned by Linux.
The final reviewed implementation had no remaining P1/P2 findings; that is
not a substitute for the deferred host qualification above.

## W5 integration handoff

The local integration retains the SVC, SECRETS, PINS and OPENER handoffs above;
the AGENTS audit and Mac copy fixtures are in `docs/design/linux-agents.md`.
Historical handoff deferrals describe those track revisions, not the completed
integration seams:

- Secrets and worker transport consume `resolveLinuxEngineLayout`; installed
  receipt roots take precedence over shell drift. The service selects the durable
  secret backend before launching consumers. Linux zkAPI remains unavailable.
- The Linux worker backend runs over the private Unix socket. The approved
  desktop bridge is a separate loopback listener requiring the session-origin
  owner proofs above; headless mode retains only the socket.
  The outbound relay child uses that socket for forwarded requests. OAuth grants
  for ChatGPT, Claude, Grok, Grok Bot and Cursor retain their existing pins.
- Linux Grok API keys use the existing routable access-credential envelope,
  store only a digest in the bearer connection table, and stay revocable. They
  are accepted only on the default remote surface for the current install ID,
  never as a ChatGPT directory grant. Existing Mac key generation is unchanged.
- The live agent page receives the opener's resolved SSH socket handoff. A Linux
  desktop uses the approved owner-proven session-origin bridge; the engine never opens an
  unauthenticated TCP approval listener. Missing SSH configuration is shown as
  not ready. The trusted browser computer's loopback port must be free.
- Install, upgrade, rollback and removal use the same runtime kernel lock.
  The installation receipt inventories machine artifacts for removal without
  executing an installed Bun or package. Data retention is the default.
- `--linux-local` in `scripts/publish-release-to-site.ts` prepares a local bundle
  from the ordinary release artifact and the real Linux installer template.
  It does not publish to the site or mark pending runtime pins qualified.

The release version is read from the repository manifests. This integration
is intended for rc.7; constructing a local candidate does not bump the release,
publish it, or imply that the current version has passed laptop acceptance.

## Omarchy acceptance runbook

Use a dedicated ordinary account on an x86_64 Omarchy laptop with a real
systemd user session. Never run Olympus as root. These commands assume the
standard XDG roots; a separate fresh account can repeat them with absolute, non-overlapping
nondefault `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and
`XDG_CACHE_HOME`. Keep the same config selector when addressing that install.
Ubuntu is not qualified by this run: capability checks must succeed or refuse
before activation. No distro packages are installed automatically.

### Prepare and transfer the local candidate

From the source worktree, after committing the rebuilt `dist`, use the build
runner to create the normal public artifact and local bundle. The output
directory must not already exist. Substitute the source worktree path locally;
no remote host name is part of this procedure.

```sh
~/.local/bin/remote-build run --cwd "$PWD" --artifact release-artifacts -- sh -c '
  bun run release:artifact &&
  VERSION=$(bun -p "require(\"./package.json\").version") &&
  bun scripts/publish-release-to-site.ts --linux-local \
    --artifact "release-artifacts/olympus-$VERSION.tgz" \
    --output release-artifacts/omarchy-acceptance
'
```

Copy the complete `release-artifacts/omarchy-acceptance` directory to the
laptop using your normal file transfer. It includes the exact tarball,
`install-linux.sh`, `uninstall-linux.sh`, and `SHA256SUMS`. The delivered acceptance bundle also contains the verified
`bun-linux-x64-baseline.zip`. Add
`--bun-archive "$BUNDLE/bun-linux-x64-baseline.zip"` to use it offline;
archive size/hash and executable hash are still enforced. A bundle prepared
with the command above alone downloads that exact pinned runtime over HTTPS
unless you supply its verified archive yourself.

### Fresh installation and engine proof

In a terminal inside the copied bundle:

```sh
BUNDLE=$PWD
sha256sum -c SHA256SUMS
set -- olympus-*.tgz
test "$#" -eq 1
sh ./install-linux.sh --tarball "$BUNDLE/$1"
export PATH="$HOME/.local/bin:$PATH"
olympus engine status
olympus engine verify
systemctl --user show olympus-engine.service \
  --property=FragmentPath,ActiveState,UnitFileState,MainPID,ControlGroup,Result,ExecMainStatus
loginctl show-user "$(id -u)" --property=Linger --value
stat -c '%a %u %n' "$XDG_RUNTIME_DIR/olympus" "$XDG_RUNTIME_DIR/olympus/worker.sock"
ss -xl
ss -ltn
olympus doctor
```

Expect a private directory/socket (0700/0600, this UID), a healthy exact build,
an enabled unit, verified linger, and an owner Unix worker socket. A live
desktop additionally reports the owner bridge; headless mode has no TCP listener. Relay online is a separate status fact. Model download/warm-up is not
engine health; wait for the model readiness the panel reports before testing
Private answers. The installer refuses missing tools, old systemd, no user
bus, unsupported CPU/glibc or denied linger with a remedy; do not work around
those refusals by inventing an XDG runtime directory or running as root.

### Owner approval and agent access

On the Omarchy desktop, first run:

```sh
olympus server-mode auto
olympus engine status
olympus dashboard
```

Expect `desktop_bridge.state` to be `listening`. The command opens a private
file and then a fresh random `.localhost` origin in Chromium (Omarchy's default)
or Firefox. The URL printed by the command contains no ticket. Confirm the
private dashboard loads; connect one client with its original OAuth query,
then choose Connect on the consent page. In a fresh browser profile with no
owner proof, visit an agent's authorize URL, click Confirm, and open the private
ticket in that same profile. The ticket window must show the dashboard and the
original tab must show the real consent page by itself, without a reload, with
its query and fragment intact. Approve consent and verify the original state
and PKCE exchange. Repeat with storage events suppressed to check the poll
fallback. Prove a ticket in a different profile: the original page must remain
unproven and after 60 seconds say “Open this page again from the Olympus window.”
Space six browser Confirm opens at least ten seconds apart within an hour;
the seventh must return 429 and open nothing. A CLI dashboard open must still
work and its pending ticket must survive browser attempts. Confirm a fresh
browser tab can
reuse the owner session. From a second ordinary account, fixed-entry requests
may redirect, but dashboard reads and consent must refuse without both proofs.
Verify copied/previous-instance cookies and forged browser headers do not help.

Repeat with a benign squatter serving the fixed entry while the engine is
stopped: leave its tab and service worker alive, then stop the squatter and
start Olympus. Open the owner's ticket using `olympus dashboard`. The old tab
must not read owner pages or storage or obtain the new cookie. Restart the
worker by saving a setting: its existing window and owner session must survive,
the host must serve the restarting page during the gap, and a second process
must fail to bind that port on **both** `127.0.0.1` and `[::1]` with
EADDRINUSE. Check `ss -ltnp` shows both. Kill the worker and repeat: the
host still holds both TCP sockets. Restart or kill the host: leave a benign squatter's tab
at the old random origin alive while the port is released, then reopen Olympus
and verify a fresh origin refuses the old cookies and proofs. Confirm `/sw.js` requests with
`Service-Worker: script` refuse and browser registration is blocked by CSP.
Log out and inspect from another owner SSH session: only the Unix socket
remains after the bounded reconciliation interval. Log back in and verify a
new origin. Explicit server mode must likewise remove the listener. Hold the
port on `[::1]` with another ordinary account while IPv4 is free, and repeat
with IPv4 occupied. Confirm doctor/status report `port_in_use` and the other
family is released too. Record `cat /proc/sys/net/ipv6/conf/lo/disable_ipv6`
and `ip -6 addr show lo`. On a host without IPv6 loopback, verify the dashboard
works over IPv4 and status explicitly reports `ipv6=unavailable`. Restore IPv6
loopback: within the refresh interval the origin must rotate, old sessions and
pending tickets must refuse, and both families must be held. Repeat with a
benign IPv6 squatter present as IPv6 returns: expect `port_in_use` and IPv4
released; free the squatter and verify the next refresh takes both families.
After SIGKILL of the host, inspect `ss -ltnp` and
verify neither socket is left held by an orphan.

In headful Chromium and Firefox, confirm native `.localhost` resolution on
real IPv6 loopback. With a benign fake listener answering `/owner-proof`, open
an unconsumed private file and verify it stays there, reports identity refusal,
and sends only the challenge; no request or navigation may carry the ticket.
Restore Olympus, reload the file during worker downtime, and verify the retry
wording and eventual dashboard in the same window without a flash, popup or
close. Exercise the real `xdg-open`/`systemd-run` environment and logout/relogin
against `graphical-session.target`; the engine host now launches the opener.

If browser name resolution fails, the private file must show a refusal with
SSH instructions, never navigate to the fixed origin. For headless/remote
use, configure an SSH alias authenticating as the Olympus owner. The browser
computer must be trusted and have the configured port free. A browser on the
same laptop needs server mode enabled first to release the bridge port. SSH
service setup, if needed, is an explicit owner host-administration action:

```sh
sudo pacman -S --needed openssh
sudo systemctl enable --now sshd
```

Verify normal owner SSH key authentication before continuing.

On the laptop:

```sh
printf 'SSH target as reached from the browser computer: '
IFS= read -r OLYMPUS_ACCEPTANCE_SSH_TARGET
olympus server-mode on --ssh-target "$OLYMPUS_ACCEPTANCE_SSH_TARGET"
olympus dashboard --no-open
```

Run the printed `ssh -N -o ExitOnForwardFailure=yes -L ...` command on the
browser computer and keep it running. Open the printed one-time dashboard
link there. In **Agents**, connect ChatGPT, Claude, Grok, Grok Bot and Cursor
one at a time. Keep the original OAuth query intact; choose Connect only in
the page opened through the forward. Denied consent and a replay of a used
approval must fail. Complete one authenticated tool call from each client.
Create a Grok API key in Agents, configure its shown MCP URL and bearer key
in the API client, and complete a tool call; revoke that key and verify a
subsequent call fails. Never paste keys into the shell runbook or logs.

From a separate ordinary Linux account, try reaching the recorded socket
using `curl --unix-socket "$SOCKET" http://localhost/v1/health` after setting
`SOCKET` to the path printed above. Expect permission denied, including when
browser-like headers are supplied. Do not relax directory/socket permissions.
Complete one Personal and one Private question; Private content stays in the
private panel. Source-open UI under the legacy Mac payload remains deferred
to the post-review consumer work; do not treat absent controls as a failed
install or claim that Linux source opening is fully qualified.

### Restart, logout, reboot and upgrade

```sh
olympus engine restart
olympus engine verify
olympus engine stop
systemctl --user is-enabled olympus-engine.service
olympus engine start
olympus engine verify
```

After stop, `is-enabled` must report disabled (nonzero is expected). Confirm
the stopped worker cannot be reached. Log out fully and reconnect through the
owner SSH account: the running engine must survive logout with linger. Reboot
normally, then repeat `engine status`, `engine verify` and an authenticated
agent call. Confirm credentials remain usable without a desktop keyring unlock.
Hyprland login/logout and a viewer surviving engine restart require real-host
observation; unit fixtures are not this evidence.

Re-run the same installer/tarball for same-release repair:

```sh
cd "$BUNDLE"
set -- olympus-*.tgz
sh ./install-linux.sh --tarball "$BUNDLE/$1"
olympus engine verify
```

For a real upgrade, prepare a second bundle from a different build with the
same release-artifact procedure; reusing identical bytes tests repair only.
On the laptop select that bundle and install it, then roll back:

```sh
printf 'Absolute path to the second candidate bundle: '
IFS= read -r UPGRADE_BUNDLE
cd "$UPGRADE_BUNDLE"
sha256sum -c SHA256SUMS
set -- olympus-*.tgz
test "$#" -eq 1
sh ./install-linux.sh --tarball "$UPGRADE_BUNDLE/$1"
olympus engine verify
olympus engine rollback
olympus engine verify
```

Check the reported build returns to the prior candidate and its matching Bun.
A failed upgrade must return nonzero and explicitly distinguish a healthy
restoration from a failed restoration. Do not call a successful file exchange
a successful rollback.

### Interrupted installation and contention

In the dedicated test account, start the second-candidate installer. In a
second terminal, inspect the owner-only transaction record under
`${XDG_STATE_HOME:-$HOME/.local/state}/olympus/engine/`. At a recorded prepare
or activation stage, terminate the actual installer CLI process with SIGKILL
(select its exact PID using `ps -u "$(id -u)" -o pid,ppid,args`; never kill by
name). Re-run the same pinned installer twice and verify the result each time.
Repeat at each durable boundary exercised by the automated fault fixtures.
Also interrupt with a normal reboot and retry after login; actual storage
power-loss durability remains a separate test, not implied by SIGKILL.

While an install is in progress, try `olympus engine rollback` and the
uninstaller in a second terminal. They must refuse the busy lock without
mutating active references. Killing the calling shell must not release the
lock while a mutation child survives. Never delete the lock file to retry.

### Uninstall, retained data and full removal

Copy the bundle outside the managed installation so its uninstaller remains
available even if Bun or the app has disappeared. First prove normal removal:

```sh
cd "$BUNDLE"
sh ./uninstall-linux.sh
systemctl --user show olympus-engine.service --property=LoadState,ActiveState
command -v olympus || true
ss -xl
```

Expect no engine service, worker listener, owned launcher or package/runtime
generation, with settings, credentials, indexes, models and logs retained.
A user-requested desktop viewer is not an engine child and may remain. Repeat
the uninstaller: interrupted cleanup must safely resume or report a concrete
retained replacement. In another fresh acceptance cycle, remove only the
recorded installed Bun/app generation as a deliberate corruption test, then
run this same bundle uninstaller; it must not execute either missing artifact.

For the explicit full-removal case in this dedicated account:

```sh
sh ./uninstall-linux.sh --purge --yes
```

If the receipt says Olympus enabled linger, and this account has no other
user services that need it, choose its account-wide restoration explicitly:

```sh
sh ./uninstall-linux.sh --purge --yes --restore-linger
```

Choose the restoration command instead of the preceding purge-only command
when that is the intended acceptance case. The final receipt is removed only
when requested cleanup completes. Locked/unavailable explicitly selected
Secret Service items must be reported as incomplete, never silently retained
under a full-removal success. Original provider files/mail are never removed.
Disconnect Olympus separately in each agent account; local deletion does not
revoke a cloud account connection. OS audit metadata can remain. The held
kernel-lock inode is left until the real runtime directory is torn down at
final logout/reboot; check again after that teardown for full-removal proof.


### Integration proof and remaining qualification

Local remote-build proof: **820 passed, 0 failed, 4 skipped across 37 focused
files**, including architecture, public-surface and private-ops guards. The
canonical documentation inventory is 48 files. Build and
`bunx tsc --noEmit -p .` passed; a subsequent `--artifact dist` rebuild returned
the generated bundles. The four skips are the native Mac zombie-group case,
the native Mac applet case, live Keychain write, and actual second-UID socket
access. Mac plist, rendered agent copy, secret fixture and shell-script bytes
remain covered; no native Mac execution is claimed by the Linux runner.
Built-in-reasoning installer tests were excluded as directed.

The crash matrix kills real subprocesses at **16 install and 10 rollback
boundaries**, then repeats recovery twice. Its service manager is a fixture;
this proves persistent-file transaction behavior, not systemd-as-PID-1 or
physical power-loss behavior. The manager harness remains deferred; laptop
cgroup, linger/logout/reboot, second-UID, desktop and real-vendor checks above
are still required. Independent scoped reviews and their repair rechecks have
no remaining P1/P2 findings. No GitHub CI, publication or live rollout was run.

Implementation details that supersede the earlier track seams:

- Direct CLI operations use Linux kernel `flock` through Bun FFI; the shell
  uses util-linux `flock` on the same inode. Nested CLI mutation proves and
  retains the inherited open-file-description lock, marks it close-on-exec,
  and never trusts an environment marker. The bootstrap must not use
  `flock --close`, which would remove the child's independent lock custody.
- The locked CLI durably records original linger before enabling it. Shell
  bootstrap no longer mutates logind or supplies ambient linger provenance.
- Failed first installs preserve a zero-machinery `recovery_pending` receipt
  for retry/removal. Explicit keep-data uninstall instead writes
  `data_retained`; fresh installation refuses that state until the owner
  purges or backs up and moves the retained data. Overlapping managed roots
  refuse before mutation so purge cannot consume its own recovery receipt.
- Journals carry paths, hashes, modes and custody identities. Config backup
  bytes live in separate private files; worker bearer material is not put in
  transaction JSON. Terminal receipt commits precede irreversible cleanup.
- Generation-directory identity and a private marker permit Bun-free removal
  of missing/corrupt runtime or app constituents while replaced roots and
  markers refuse. Unknown remaining machinery or an unfinished install
  transaction produces incomplete removal, with the receipt retained.
- Explicit libsecret full purge refuses when item ownership cannot be proved;
  it never deletes a whole keyring or claims those secrets were removed.
- CLI/local-agent configuration discovery and desktop launching follow the
  receipt. The desktop entry invokes the managed launcher, which exports the
  recorded roots and enters the trusted package directory. Environment-only
  setup preflight does not initialize an unused credential backend.


The generated relay dashboard resource and its tool resource URI were rebuilt
with the socket handoff branch (the Mac/TCP branch is unchanged). An additional
71 panel/relay-contract tests passed. These files are local repository build
outputs; no hosted relay assets, listing, demo or service were published.


### Local acceptance artifact receipt

The verified archive is `release-artifacts/olympus-omarchy-acceptance.tar.gz`.
It contains `omarchy-baseline`, `omarchy-acceptance`, the verified pinned Bun
archive, `OMARCHY-RUNBOOK.md`, `UPGRADE-REHEARSAL.md`, and
`ACCEPTANCE-BUILDS.json`. The two local builds have different engine identities
so the laptop can exercise an actual generation upgrade and rollback. Both
retain the current rc.6 manifest version; this is acceptance material for the
rc.7 work, not a published release.

Archive SHA-256:

```text
6c963b51f864181a6b399372692454f454d8327087e6b0827d5662bd0315b73d
```

The ordinary release-artifact checks passed, including dist consistency and
public-package checks. The extracted public CLI ran with the exact verified
Linux Bun (`--version` and Linux `engine --help`); that Bun also passed a
JavaScript/SQLite smoke. Local returned archive and constituent checksums match.
No service was installed on a live host by this work.


### First Omarchy install: standalone models and doctor (2026-10-12)

The owner's first laptop run proved passwordless per-user installation,
verified linger, an active/enabled unit, the private 0700/0600 worker socket,
second-UID refusal, online relay, and `desktop_session` with remote false.
The quoted `WorkingDirectory` defect was already fixed at `aa488298`.
The missing desktop browser route is a separate approval-transport defect;
it does not invalidate those observed socket/service results.

Fresh standalone Linux uses the same `no-sensitive` preset and built-in model
capability gates as Mac. EmbeddingGemma 2 warms at worker boot. The private
Qwen model is enabled by W2 wherever the pinned runtime and memory permit it;
its first download starts when private work/classification needs it.
Transcription starts its download only when audio is selected and requires
`ffmpeg` on Linux. No credentials or paid model service are required for these
built-ins. The source privacy policy remains separate: `no-sensitive` does
not silently make metadata-only Private sources answerable.

Pinned Linux x86_64 downloads (decimal bytes, model/runtime manifests; these
are expected payloads, not a claim that this work downloaded model weights):

| Component | Bytes | Start condition |
|---|---:|---|
| EmbeddingGemma 2 | 484,622,336 | First worker boot |
| LiteRT-LM runtime wheel | 47,051,760 | Embedding installation |
| Qwen3.5 4B Q4_K_M, 16 GiB+ memory | 2,740,937,888 | Private model first use |
| Qwen3.5 2B, smaller supported memory | 1,280,835,840 | Alternative memory-selected private model |
| Qwen3-ASR 0.6B plus projector | 1,019,141,728 | Audio first use |
| Shared llama.cpp runtime | 17,544,875 | First reasoning/transcription install, downloaded once |

With the 4B choice, all model files plus these runtime archives total
4,309,298,587 bytes (4.31 GB); with 2B, 2,849,196,539 bytes (2.85 GB).
Unpacked runtimes, caches and working memory need additional space. The
managed Bun/runtime and Olympus archive are separate installer payloads.
Linux arm64 has model pins but is not qualified by the x86_64 laptop bundle.

`engine status` includes content-free model readiness from the worker health
response. The Linux computer dashboard adds a local built-in-model summary,
including insufficient memory and the missing-ffmpeg remedy, outside the
frozen ChatGPT panel. Its normal model cards retain their existing live
progress. Status reads never start a download. Doctor accepts the running
Bun interpreter when the managed pinned runtime is absent from PATH, names
the owner socket, and avoids the incorrect Linux claim that no private model
runs. The frozen listing and plugin skill bundle are unchanged.

W2 seam: this track consumes its existing model enablement, sizing and status
functions, without replacing policy or model selection. W2's planned
cgroup-aware memory sizing remains with that track; present selection uses
host total memory. Verify native model loading, actual disk use and CPU
latency on the laptop. Do not treat a healthy engine as a ready model.


### Desktop bridge security disposition (2026-10-12)

**Historical fixed-origin rejection; superseded by the approved desktop amendment above.** The real laptop
proved that `olympus dashboard` printed a non-listening TCP URL on a desktop.
The fixed-origin bridge prototype was withheld from the acceptance candidate;
the shipping path remains the existing Unix socket and SSH handoff.

Independent review and a real isolated Chromium reproduction found:

1. A cookie for `127.0.0.1` is shared across ports. A malicious local OAuth
   callback can receive it before consent, including on an OAuth error redirect.
2. An additional origin-bound credential blocks cookie-only replay, but a
   same-port squatter can plant a persistent service worker during downtime.
3. A private file can clear that service worker before navigation, but clearing
   storage does not terminate an already-running hostile same-origin tab.
   The tab retains authority over new browser storage. Chromium reproduced
   that surviving execution context; `Clear-Site-Data: executionContexts` did
   not terminate it. Per-process cookie rotation alone does not fix this.

The owner approved fresh random session origins on 2026-10-12. The bridge
implementation keeps the cookie-independent origin-storage proof, isolates
old execution contexts with origin rotation, and retains the Unix socket and
SSH headless path. The 2026-10-14 launch P1 correction removes persisted epochs:
reusing an origin after releasing its port re-admitted the same-port squatter.
Only the host's continuously bound listener permits reuse across worker
restarts; every release (including host death) loses the in-memory epoch. Disposition: **fix** the browser-origin boundary; no new
release gate or fixed-origin fallback.


### Doctor/model acceptance candidate proof

The shipped follow-up passed **218 focused tests, zero failures**, across
`doctor`, `linux-model-readiness`, `dashboard-computer-host`, `engine-service`,
`architecture-guard`, `public-surface-guard` and `private-ops-disposition`.
Build and `bunx tsc --noEmit -p .` passed, followed by a returned `dist` rebuild.
Three Mac host-page cases (locked, control session, read-only token) were
rendered against the original HEAD and compared byte-for-byte. Existing Mac
engine fixtures also passed. The ChatGPT plugin directory and hosted relay
assets have no changes. All builds and tests ran in the isolated remote lane;
no native Mac, live systemd, model-weight download or laptop proof is implied.
The built-in-reasoning installer tests were not run.

The follow-up local bundle is prepared at
`release-artifacts/omarchy-doctor-models-20261012`. It deliberately retains the
socket/SSH-only approval path and the rc.6 manifest version while rc.7 work
continues. Re-run the installer, `olympus doctor` and `olympus engine status`;
use the existing owner SSH socket forward to inspect the new local model
summary. Compare the reported model states with actual first-use downloads,
install `ffmpeg` when prompted, and confirm native model loading on the laptop.
Those earlier tests and that historical bundle did not qualify the desktop bridge.
The current owner-bridge acceptance bundle is `release-artifacts/omarchy-acceptance`.
Its desktop implementation and browser proof are separate from real Hyprland,
login/logout, default-opener and second-UID acceptance on the laptop.


### Desktop owner bridge acceptance proof (2026-10-12)

Disposition: **fix**. The approved origin decision is implemented in
`src/core/linux-owner-bridge.ts`, integrated only into the Linux socket worker.
The direct implementation tests cover exact Host admission, cookie plus storage
proof, previous-instance refusal, forged headers, CSRF preservation, single-use
and expired tickets, opener argv, service-worker denial, collisions, listener
rotation and post-await revocation. Mac agent/consent fixtures remain exact.

Real headless Chromium and Firefox through Playwright 1.64.0 both resolved fresh
random `.localhost` names to the loopback listener with no resolver override.
Both completed the private-file launch, dashboard fetch, fresh-tab reuse,
native consent POST, callback redirect and PKCE token exchange. A pre-existing
entry-origin service worker and hostile tab remained alive and could not read
owner content, storage or cookies. Old session Hosts refused after rotation;
service-worker registration on the session origin failed. These are isolated
browser proofs, not Omarchy/Hyprland qualification.

For reproduction, `test/linux-owner-bridge.browser.test.ts` accepts
`OLYMPUS_TEST_PLAYWRIGHT` naming an installed Playwright ESM entry. Run it only
through remote-build. The browser package and missing Firefox system libraries
were installed/extracted under disposable container paths; no repository
dependency, host package, hosts file or resolver setting changed.

Re-run the owner approval section above on the actual laptop for xdg-open,
Hyprland/systemd login/logout and scope survival, port-collision diagnostics,
second-UID behavior and real client tool calls. The bundle remains rc.6-labeled
acceptance material for the rc.7 integration; this track does not change the
frozen directory listing, hosted assets or release version.


Final focused validation: 198 tests across the six changed behavior suites and
three required guards passed, then 49 bridge/guard checks passed after the
terminal-close regression fix (48 repeat checks, one additional case). The
Chromium and Firefox cases passed again, including opening a dashboard from
owner proof without a dashboard launch fragment. Build and TypeScript passed;
`dist` was rebuilt and returned by remote-build. The built-in-reasoning
installer suite was excluded as instructed. Independent review identified the
inherited consent form policy, synchronous request-triggered readiness probes,
and the pending-probe shutdown race; all three were fixed, with the final
lifecycle re-review passing. No Mac runtime/page implementation was changed;
Mac consent/agent fixtures passed byte-for-byte, and the CLI regression cases
passed. Proven owner operations retain the worker's unbounded response idle
timeout; unauthenticated TCP traffic keeps Bun's default idle deadline and
request bodies have an independent five-second bound.


### Linux PR preparation (2026-10-13)

Standalone Linux data now uses `$XDG_DATA_HOME/olympus` (default
`~/.local/share/olympus`). Shared store/model/ledger defaults follow the
standalone install receipt, including when a shell changes its XDG variables.
Mac and OpenClaw-hosted data defaults keep their historical layout.

Existing receipts remain authoritative, including after keep-data uninstall
or partial purge. Without a receipt, nonempty legacy data is selected in place
when XDG has no user data; fresh-install preflight still refuses an unowned or
competing installation. There is no automatic migration: avoiding database
moves and duplicate copies avoids crash/recovery data loss. Fresh executable
generations use sibling `olympus-engine`, keeping machinery removal separate
from personal data. Legacy receipts keep both their data and package paths.

The merged branch uses “on your computer” in relay approval and disconnected
copy, and updates the deploy reviewer check accordingly. **Do not deploy the
relay from this branch while OpenAI app review is open without the anchor's go.**
The submitted directory assets and golden fixture remain unchanged; the current
relay test explicitly accounts for only the platform wording changes.

The design guard's implementation digest tracks the merged source. Its owner
approval hashes remain unchanged. The panel and both computer-host wrappers
need re-approval because the Linux remote-help command forwards to the owner
Unix socket and includes `ExitOnForwardFailure=yes`. Mac Agents still matches
its approved render. Exact HTML and candidate hashes are in the owner's
`olympus-wt/tier-review-evidence/design-states/` handoff; the anchor owns approval
and the rendered-state receipt update. This preparation does not authorize
pushing, publishing Linux installers, relay deployment, or a live upgrade.

### 1.0.0 lifecycle follow-up (2026-10-13)

Full purge removes empty state/cache `olympus` parents only when the installer
recorded creating them and the private directory's device/inode still matches.
Older receipts and pre-existing parents confer no cleanup authority. Nonempty
parents and replacements stay. Failed-install recovery preserves this ownership.

Kept-data adoption remains deferred: existing `data_retained` receipts have no
retained inventory, so a deleted optional store or privacy file cannot be told
apart from one never created. Removing the refusal would seed missing settings;
the recovery journal also does not accept that prior receipt state. Retain the
refusal until a completeness contract and migration/recovery proof exist. This
is the builder brief's P0 skip-and-flag disposition, not an adoption implementation.

Systemd registration uses the known default user unit-link location, not the
localized `systemctl link` diagnostic. The install journal records which link
paths were absent before the command. Failed activation removes only those
new links whose owner and target still match, including when the command
creates a link then fails; previous links are journaled and restored after disable, followed by a manager
reload. A changed target
refuses recovery and retains the journal. This also covers HOME paths with
spaces and a custom XDG_CONFIG_HOME.

Validation boundary: directory identity checking and `rmdir` are not one atomic
operation against another process running as the same UID. A concurrent swap
can lose an empty replacement directory, but `rmdir` cannot remove its contents
or follow a final-component symlink. No rename/quarantine step is used, avoiding
new data-orphaning risk. This metadata-only residual is disclosed for anchor review.
