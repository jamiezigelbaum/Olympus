# Linux confinement for the zkAPI private lane (workstream W4)

Status: design and feasibility prototype, revision 3, 2026-10-12. Nothing here
ships. No production code path changes with this document; the prototype lives
in `tools/zkapi-confine-prototype/` and is not wired into the engine. Revision 2
closed the eight findings of the independent design review of revision 1
(commit `3bf77d51`); revision 3 closes the five findings of the review of
revision 2 (commit `0e2e0e1e`), all in section 1.2. Every critical step of the plan in section 9
is reviewed before it lands, and nothing turns the confinement on for users
until the integrated boundary has passed real-route qualification and an
integrated review (`docs/ENGINEERING_PROCESS.md`).

Plan of record: `docs/design/linux-parity.md`, workstream W4. Owner decisions
of 2026-10-12, all recorded as decided in section 10:

- A host that cannot create the namespace is **refused**. There is no weaker
  mode, and nothing in this document reopens that.
- Landlock ABI below 4 (kernels before 6.7) is refused.
- The doctor prints the administrator steps; it never runs `sudo`.
- arm64 is deferred. Omarchy on x86_64 is the only qualified target.
- The Ubuntu positive-path proof is skipped; Omarchy only.
- A new zkapi fork release `clientd-v0.1.6-olympus3` carrying the launcher is
  authorised, to be published by its owner only once the launcher is built and
  reviewed. This document plans for it (section 9) and publishes nothing.

Facts below are checked against `f542f660` and against runs on real hardware
(appendix). Where a claim is not proven by a run it says so under
"Unproven".

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The Linux confinement is a **user, network and PID namespace holding only loopback**, with two session bridges that pass **already-connected descriptors** over a private control channel, hardened by Landlock, seccomp, `no_new_privs`, dropped capabilities and closed inherited descriptors. | The namespace gives the boundary by construction: no route, no resolver, no other loopback listener, no host Unix socket to find. The PID namespace makes the launcher the init of everything the daemon starts, which is the lifetime boundary. The other layers remove ways around the namespace and give a second, independent reason for each denial. |
| D2 | The launcher is a **small static Go program, `zkapi-confine`, built in the zkapi fork and shipped in the same hash-pinned release bundle as `zkapi-clientd`** (`bin/zkapi-confine`). Standard library only. | One pinned artifact, one pin to review, no new system dependency, the toolchain already pinned for the fork. See 4.2 for the alternatives and why each lost. |
| D3 | The Linux confinement reports the existing level `loopback_filtered`, only after a per-session self-test that runs the real launcher. A launcher that cannot be created, a self-test that fails, or an instance the supervisor cannot bind to the launcher's report **refuses the session**. Linux never runs at level `none`. | Same statement, same custody flags, same receipt as the Mac. Owner decision: no weaker mode. |
| D4 | Landlock ABI 4 or higher is required (Linux 6.7). Newer ABIs add layers, never change what is claimed. Below 4 the lane is refused. | Owner decision. |
| D5 | The daemon's API is reached through a **Unix socket the launcher's host-side stage binds**; every connection is authenticated by a mutual HMAC handshake before one byte of HTTP is sent, and the authenticated descriptor, not a pathname, is what crosses into the namespace. The handshake key is delivered only on the launcher's private status descriptor. | Closes review finding 1 for the API: a path the same-uid daemon could re-point leads to a peer that cannot answer, so the request is refused unsent. No host-wide loopback listener exists for the API. |
| D6 | Tor stays an unconfined host process, as on the Mac. The namespace's Tor port is a bridge to **one fixed host port** (`--reach NSPORT=HOSTPORT`): the host-side stage dials it for each accepted connection. No pathname is resolved after the daemon starts, and the supervisor runs no relay. | Closes review finding 1 for Tor: nothing the daemon can create, rename or link is ever consulted. |
| D7 | Ubuntu 23.10+ with `apparmor_restrict_unprivileged_userns=1`: refuse, and **print** one administrator step (section 8). We do not recommend turning the sysctl off. The positive path is not proven here (owner: Omarchy only), and no claim is made for Ubuntu beyond the refusal. | A refusal is the only claim the evidence supports. |
| D8 | The whole session's lifetime is the **PID namespace**: the launcher's middle stage is PID 1 of it and reaps. When it dies the kernel kills every process in the namespace, whatever group or session they joined. | Closes review finding 3: process groups, sessions and parent-death signals are not a containment boundary. |

### 1.1 Why a three-stage launcher

The namespace is created by a process that must go on living in the host
namespace, because only that process can dial the host's Tor port or own the
host-side API socket. So there are three stages, with the control channel an
anonymous `SOCK_SEQPACKET` socketpair that carries small JSON messages and
`SCM_RIGHTS` descriptors (4.1). No pathname resolution happens after the
daemon starts, which is the property review findings 1 and 2 turn on.

### 1.2 Review findings and where each is closed

Review of `3bf77d51` (Codex, read-only): verdict "proceed with changes".

| # | Finding | Resolution | Proof |
|---|---|---|---|
| P1-1 | The Tor bridge re-resolved `tor.sock` per connection; the same-uid daemon could re-point it at a host stream socket (ABI 4-8). API identity by pathname is not proof. | Tor: no pathname at all (D6, 4.3). API: descriptor passing plus mutual HMAC handshake keyed by a secret the daemon never has (D5, 4.3); a path swap yields a refused request with zero bytes sent to the decoy. | Matrix section "Tor bridge ... API path swapped": `apiPathSwapped` verdict `refused`, decoy saw 0 bytes, no HTTP. Wrong-peer and `torHostDown` rows. A.1 |
| P1-2 | `socketpair(AF_UNIX, SOCK_DGRAM)` was allowed; a datagram socket can be re-pointed at `/dev/log` and carries `SCM_RIGHTS`. | `socketpair` is allowed only for `AF_UNIX`, `SOCK_STREAM`, protocol 0, and only in the profile the daemon runs under (4.1). | Rows `socketpair_unix_dgram`, `_seqpacket` EPERM; `pair_dgram_connect_host_path` / `_sendto_host_path` cannot even create the socket (`no_socket`), at ABI 9 and at emulated ABI 4. Stream-pair rows `pair_stream_*` hit EISCONN (ABI 4) or EACCES (ABI 9 Landlock). A host datagram decoy counted: unconfined control landed 1 datagram, confined 0. A.1, A.2 |
| P2-3 | `setsid`/`setpgid` escape the group; parent-death signals are not recursive. Round 2: cleanup does not survive a taken-over stage1, which can clear its own parent-death signal and leave the group. | PID namespace as lifetime boundary, stage1 as reaping init (D8, 4.1). Round 2: seccomp freezes the parent-death signal at SIGKILL in every stage and in everything below them (`prctl(PR_SET_PDEATHSIG, x)` is refused unless x is SIGKILL). `setsid`/`setpgid` stay allowed, deliberately: the daemon inherits stage1's filter and its children may legitimately need them, and with the signal frozen leaving the group gains nothing (4.1). | Escapers (setsid, setpgid, double fork, 4 per run) started in the daemon die on daemon exit, group kill, stage0 SIGKILL, stage1 SIGKILL, daemon SIGKILL and a watchdog stand-in SIGKILL; with the PID namespace ablated they survive a group kill (4 survivors). Round 2, adversarial init stand-in: a stage1 that sets SIGKILL (ok), tries to soften (EPERM) and clear (EPERM) its parent-death signal and calls `setsid` (leaves the group), then stage0 is SIGKILLed: nothing survives; with the seccomp layer ablated the same init clears the signal and survives. A.1 |
| P2-4 | An unbound `listen()` gets an ephemeral port Landlock's bind hook never sees; the wildcard-bind test used a forbidden port. | Accepted residual with detection, not claimed as parity (4.5, 5): the listener exists only inside the namespace, reachable by nothing outside; the supervisor's strict listener-set check (exactly the expected listeners) refuses a session that has an extra one. Wildcard bind of a *permitted* port is probed separately and documented. | Rows `listen_unbound` (listening, ephemeral port), `bind_wildcard_forbidden_port` EACCES, `bind_wildcard_permitted_port` bound; section "unbound listen()": the extra listener is detected by the strict set check and refused from the host with ECONNREFUSED. A.1 |
| P2-5 | The matrix exited 0 despite failed controls, cleanup, refusals and inspection. | Fail-closed harness (6): every control, probe row, identity check, lifecycle result, refusal and ablation is an assertion; a missing probe row is a failure; cleanup asserts the group kill removed every process; the exit code is the failure count. Adversarial probes added for findings 1-4. | Harness reports `RESULT: PASS (0 failures)`; before the last fixes the same harness returned 8 failures and exit 1 on real defects (a stray decoy helper, one wrong expectation), i.e. it fails when it should. |
| P2-6 | Stage0 hardening was neither acknowledged nor fail-closed; descriptor sanitising failed silently. Round 2: the `/proc/self/fd` fallback still used unchecked `CloseOnExec`. | Stage1 waits for a `go` message that stage0 sends only after its own hardening succeeded; failure kills stage1 and refuses `launcher_hardening_failed`; `ready` carries `stage0Layers`. Descriptor sanitising failures refuse `descriptor_sanitize_failed` in every stage, **including the fallback, which now uses `fcntl(F_SETFD)` and checks every call** (4.1). | Fault injection: `harden-stage0`, `cloexec`, `cloexec1` and, round 2, `cloexec-fb-fail` (the fallback's first `fcntl` fails) each exit 78 with the named refusal and no daemon; a forced healthy fallback (`cloexec-fb`) reaches `ready` and exits 0; `ready.stage0Layers` asserted. A.1 |
| P2-7 | The private status descriptor was not plumbed through the supervisor/watchdog spawn boundaries (`consult-transport-zkapi.ts:1109`, `:1152`); PIDs not bound to instances. Round 2: the instance check required stage1's parent to be the watchdog, but it is stage0. | Section 4.4 specifies both spawn boundaries and makes the private channel mandatory. Section 4.5 binds the **whole chain watchdog -> stage0 -> stage1 -> daemon**, every link by pid and start time, by parentage and by PID-namespace depth; the ready event carries `stage0Pid/Start`, `stage1Pid/Start`, `daemonPid/Start`. | The matrix now starts every session through a watchdog stand-in that passes the status pipe as fd 3 and closes its copy, and verifies the full chain; nine negative bindings are each rejected (pid reuse, unrelated pid, stage0 reuse, stage1 reuse, wrong watchdog, watchdog reuse, stage0 replaced by the watchdog, **stage1 reparented** to the real daemon and **stage1 replaced by an unrelated process**; the reparented case is refused for its parentage). Also `noStatusFd` (exit 64), `silentLauncher`, forged stdout events never accepted, fd 3 unreachable from the daemon. A.1 |
| R2-A | (round 2) A malformed daemon response can freeze the supervisor: `Content-Length: nope` becomes `NaN` and the body loop spins. | The client parses Content-Length and chunk sizes strictly (digits only; hex digits only, at most 8; bounded; no sign, exponent or prefix), rejects conflicting or duplicate-inconsistent lengths, Content-Length together with chunked, unsupported transfer-encodings, malformed header lines, an unterminated or over-long chunk-size line and a chunk not ending in CRLF, and marks the exchange failed so later bytes are ignored (4.4). | `framing.cjs`: 24 cases, each in its own subprocess timed from outside (8 s, SIGKILL): 3 valid controls read correctly, 21 malformed cases all rejected. The previous parser run against `cl-nope` hangs and is killed by the external timer, so the test sees the defect. A.1 |
| P2-8 | The landing sequence activated the boundary before review and qualification; a reopened weaker-mode question. | Section 9 reordered: reviews before each critical merge, activation as the last, single change; section 10 has no weaker-mode question. | Section 9, 10 |

## 2. What the Mac does today (the contract to match)

All from `src/core/consult-transport-zkapi.ts`.

- **Profile** (`darwinSandboxProfile`, `:672`): `(deny network*)` for the
  daemon and every descendant; outbound allowed to the session's four
  `tcp4 localhost` ports (Tor, daemon, companion proxy, wallet API); bind and
  inbound allowed on every one of them except Tor's. UDP, IPv6, Unix sockets
  (including the system resolver socket) and DNS stay denied. `tcp4` matters:
  plain `localhost` would also permit an unowned IPv6 listener on the number.
- **Wrap** (`defaultZkapiConfinement`, `:769`): argv prefixed with
  `sandbox-exec -p <profile>`. Only the daemon is confined; Tor is not.
- **Self-test** (`:777-808`, probe script `:700`): a content-free script runs
  outside, inside, and as an exec'd child inside. Listeners live in the parent
  so a denial cannot be a closed port. Required: allowed ports connect in all
  three; other loopback port, `::1`, IPv4-mapped IPv6 and the resolver socket
  connect outside and fail fast inside; UDP to a remote address and to an
  allowed loopback port is sent outside and fails inside; a TCP connection to
  TEST-NET-1 fails fast inside. A failed self-test of a selected confinement
  refuses the session (`confinement_self_test_failed`, `:2448-2453`).
- **Ports and custody flags** (`:2284`, `:2447`, `:2482`): only level
  `loopback_filtered` allocates the companion and wallet ports and passes
  `--companion-proxy-listen`, `--wallet-api-listen`,
  `--require-managed-companion`, `--require-companion-custody`.
- **Listener identity** (`inspectLoopbackListener`, `:1721`;
  `linuxListenerPids`, `:1751`): Linux reads `/proc/net/tcp*` for LISTEN
  rows on the port, maps socket inodes to pids by scanning `/proc/*/fd`, and
  reports the process group. `owned()` (`:2502`) requires the daemon,
  companion and wallet ports to be held by the daemon's process group and
  Tor's by Tor's, immediately before anything carries the key (`guard()`,
  `:2518`).
- **Supervision**: the watchdog (`:1058`) leads a new process group, starts
  its child only after a durable record names the group, and kills the group
  when the supervisor goes away.


## 3. Properties: Mac versus Linux

| Property | Mac (`sandbox-exec`) | Linux (this design) |
|---|---|---|
| Daemon and every descendant confined | Profile inherited across fork and exec | Namespaces, Landlock domain, seccomp filters and `no_new_privs` all inherited across fork and exec; proven for an exec'd child |
| Only the session's loopback ports reachable | Four `tcp4 localhost` outbound rules | Namespace has only loopback; only the Tor bridge leads out, to one fixed host port; Landlock TCP connect rules name the session's ports |
| Other loopback ports | Denied by rule | Nothing else listens in the namespace; the host's listeners do not exist there; Landlock also denies |
| Bind restrictions | Bind only on the three non-Tor ports | Landlock TCP bind rules on the same ports; explicit bind of any other port, port 0 or the Tor port fails. **Not at parity**: an unbound `listen()` and a wildcard bind of a permitted port succeed, harmlessly (4.5, 5) |
| Remote addresses | Denied | No route and no interface: connect fails at once (`ENETUNREACH`) |
| IPv6 and IPv4-mapped IPv6 | Denied by `tcp4` rules | IPv6 disabled in the namespace; `AF_INET6` sockets refused by seccomp |
| UDP, including loopback UDP | Denied | `AF_INET` datagram and raw sockets refused by seccomp |
| DNS | Resolver socket and UDP denied | UDP and Unix sockets refused; no interface to reach a resolver; lookup fails fast |
| Host Unix sockets (path) | Denied | `AF_UNIX` `socket()` refused on every kernel; the only Unix socket a daemon can create is an anonymous stream pair, which cannot be connected elsewhere; Landlock `RESOLVE_UNIX` at ABI 9 |
| Host abstract Unix sockets | Denied | Abstract sockets are per network namespace; also refused by seccomp |
| Descriptors inherited from the supervisor | Not addressed | All descriptors above stderr are closed on exec, in every stage; failure to close refuses the session |
| Capabilities | Not addressed | All five sets empty in the daemon; bounding set emptied |
| New namespaces, ptrace, `io_uring`, mounts, bpf, keyctl | Not addressed | Refused by seccomp |
| Launcher protected from the daemon | n/a | Non-dumpable, own seccomp filter, no capabilities, Landlock; host pids of the launcher are not addressable from the PID namespace |
| Whole tree dies with the session | Process group kill (escapable by `setsid`) | PID namespace: the kernel kills every process in it when the launcher's init dies |
| Per-session self-test, refusal on failure | Yes | Yes, with real listeners and the real launcher; plus a `check` before the session for the doctor |
| File reads and writes | Unrestricted (`allow default`) | Unrestricted (the same, deliberately: this lane confines the network) |
| Trust root | Deprecated but shipped `sandbox-exec` | Kernel namespaces, Landlock and seccomp (stable interfaces), one launcher we build |
| Where it cannot run | No `sandbox-exec` | Namespace creation refused, Landlock below ABI 4, seccomp absent, launcher missing or unhashed, architecture other than x86_64: **refuse** |

Inherent to both: the daemon can ask Tor, through the SOCKS port it is
allowed to use, to open connections to arbitrary destinations. That is the
purpose of the lane; the confinement bounds everything *except* that
channel. Reads of host files are unchanged on both platforms.

## 4. Design

### 4.1 Process tree and layers

```
watchdog (existing, leads the process group; passes the private status pipe on as fd 3)
 └─ stage0   HOST namespace. Marks inherited fds close-on-exec (failure refuses),
    │        asks for SIGKILL if the watchdog dies, binds the API Unix listener,
    │        creates the control socketpair, clones stage1 into a new
    │        user+net+PID namespace, then HARDENS ITSELF (non-dumpable,
    │        no_new_privs, Landlock: connect only to the Tor host port; seccomp:
    │        AF_INET stream only, no AF_UNIX, no socketpair). Only after that
    │        succeeds does it send "go" to stage1. It owns the status fd, the API
    │        listener and handshake, and the Tor host dial.
    └─ stage1   PID 1 of the new namespaces; same uid and gid (identity map).
       │        waits for "go"; loopback up; IPv6 off; binds the Tor-side listener;
       │        empties every capability; hardens itself (no_new_privs,
       │        non-dumpable, Landlock all-threads where ABI >= 8, seccomp);
       │        starts stage2; REAPS (wait4(-1)); forwards SIGTERM/SIGINT;
       │        receives authenticated API descriptors from stage0 and dials the
       │        daemon port; sends accepted Tor connections to stage0 as descriptors.
       └─ stage2   same namespaces, one thread: no_new_privs, Landlock
                   (ABI 4+), seccomp, fds closed, report to stage1 over a
                   private pipe, then exec the daemon
```

Control channel between stage0 and stage1: an anonymous
`SOCK_SEQPACKET|SOCK_CLOEXEC` socketpair created before the clone, with
`SCM_RIGHTS` receive using `MSG_CMSG_CLOEXEC`. Stage2 marks it close-on-exec
with every other descriptor, so the daemon never holds it.

The daemon, the companion it starts and any helper are descendants of stage2's
exec and inherit everything. They are in the PID namespace whose init is
stage1. When stage1 dies, for any reason, the kernel kills every process in
the namespace; when stage0 or the watchdog dies, parent-death signals kill
stage1 (and so the namespace). Process groups and sessions play no part, so
`setsid()`, `setpgid()` and double forks do not escape (A.1, lifecycle).
The parent-death signal is the link in that chain, so it is **frozen**:
seccomp refuses `prctl(PR_SET_PDEATHSIG, x)` in every stage (and so for the
daemon and everything it starts) unless `x` is SIGKILL, because stage1 and
stage2 are created with SIGKILL and a process that could clear or soften it
could outlive stage0. A taken-over stage1 therefore cannot decouple itself;
when stage0 or the watchdog dies it dies, and the kernel takes the namespace
with it. The option is read as an `int`, so the filter compares exactly the
low word the kernel uses; a signal argument with high bits set is invalid to
the kernel. The cost: a descendant of the daemon cannot request a catchable
parent-death signal (it gets `EPERM`); the real companion and Tor are
checked for this in qualification (section 9, step 5). `setsid` and
`setpgid` are **not** denied: the daemon inherits stage1's filter, its
children may legitimately need them, and with the signal frozen they gain
nothing against cleanup. Stage0 and stage1 pin the main goroutine to the
main thread (`runtime.LockOSThread` in `init`), because the kernel ties
the signal to the thread that created the child.
`CLONE_NEWPID` also removes the launcher and the watchdog from the daemon's
view: from inside, their host pids do not resolve (`signal_launcher` and
`signal_stage0` give `ESRCH`, and `ptrace` of stage1, the namespace's init,
gives `EPERM`).

Layers, each with an independent reason (the ablation table in A.1 shows
which rows each one carries):

1. **Namespaces** (`CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID`). Stage0
   creates them with the clone call, not `unshare`, because a multithreaded
   runtime cannot `unshare(CLONE_NEWUSER)` in place. Ambient `CAP_NET_ADMIN`
   and `CAP_SETPCAP` are given to stage1 only, to bring loopback up and empty
   the bounding set; they are gone before any untrusted code runs. Inside the
   PID namespace `/proc` is still the host's; host pids are read from
   `/proc/self/status` (`PPid`, `NSpid`).
2. **Capabilities**: bounding, ambient, inheritable, permitted and effective
   sets emptied on every thread; stage2 verifies from `/proc/self/status`
   that all five read zero and refuses otherwise (`capabilities_not_dropped`).
3. **`no_new_privs`** on every stage.
4. **Landlock**, with the ABI queried at runtime (`landlock_create_ruleset`
   with the version flag). Domains stack: stage1's domain is the parent of the
   daemon's, so stage1's rules must grant everything the daemon is meant to
   keep.
   - ABI >= 4: handled rights `BIND_TCP | CONNECT_TCP`; rules for exactly the
     session's ports. Stage0 may connect only to the Tor host port.
   - ABI >= 6: scopes for abstract Unix sockets and signals.
   - ABI >= 9: handled right `RESOLVE_UNIX` with no rules for the daemon, so
     even a path Unix socket obtained some other way cannot be connected.
   - ABI >= 8: stages 0 and 1 use the all-threads flag (`TSYNC`) so their Go
     runtime threads are covered; below 8 they rely on the other layers.
   - ABI < 4 or no Landlock: **refuse** (`landlock_unavailable`).
5. **seccomp**, an architecture-checked deny list with argument checks
   (`x86_64` table; arm64 table written and cross-checked but not run, see
   Unproven). A mismatched architecture kills the process; the x32 ABI is
   refused. Not an allow list: Go, Bun, Node and Rust runtimes differ, and an
   allow list's false refusals would be the common failure. Filters stack and
   the strictest wins, so the daemon runs under stages 1 and 2 together and
   the rules below are written to agree.
   - `socket()` allows only `AF_INET`, type stream, protocol 0 or TCP; stages
     1 and 2 also allow read-only route-table netlink (`getifaddrs` in Go,
     Node and Bun needs it); stage0 allows `AF_INET` only. Everything else is
     refused with `EPERM`: `AF_INET6`, UDP, raw, packet, vsock, other
     netlink families, and **`AF_UNIX` in every stage**.
   - `socketpair()` is allowed **only** for `AF_UNIX`, `SOCK_STREAM`, protocol
     0, and only in the profiles the daemon runs under (stages 1 and 2);
     stage0 has no `socketpair`. A stream pair is already connected, so
     `connect()` and `sendto()` on it give `EISCONN` (or `EACCES` under
     `RESOLVE_UNIX`); a datagram or seqpacket pair is never created. Pair
     creation is what the runtimes need to spawn child processes (Bun and
     Node's `child_process`), which is why stream pairs stay.
   - `unshare`, `setns`, `clone` with any `CLONE_NEW*` flag, `mount`
     family, `pivot_root`, `chroot`, `ptrace`, `process_vm_*`, `pidfd_getfd`,
     `kcmp`, `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`
     family, module loading, `kexec`, `reboot`, `swapon/off`, `acct`:
     `EPERM`. `clone3` returns `ENOSYS`: `clone3` flags live in memory that a
     filter cannot inspect, and libc and Go fall back to `clone`.
6. **Inherited descriptors**: every stage marks every descriptor above stderr
   close-on-exec (`close_range` with the cloexec flag, else `/proc/self/fd`
   with a checked `fcntl(F_SETFD)` per descriptor, tolerating only the
   already-closed directory descriptor) **and reports failure**: the launcher
   refuses with `descriptor_sanitize_failed`; a failed sanitising pass is
   never ignored, on either path.
   Stage2 reports on a pipe that closes at exec. The daemon starts with
   stdin, stdout and stderr only.
7. **Events on a private descriptor**: `--status-fd 3` is **mandatory**. The
   launcher writes its JSON events to a descriptor the daemon never has, and
   refuses to start (exit 64) without it. The daemon's stdout and stderr stay
   the daemon's. The supervisor treats any event-looking line on stdout as
   data, never as an event (4.4, 4.5).

Stage0's hardening is part of the contract, not a best effort. Stage1 does not
start the daemon until stage0 has hardened and said so; a hardening failure
kills stage1 and refuses with `launcher_hardening_failed` (A.1, fault
injection); the `ready` event carries `stage0Layers` as the acknowledgement.

Stage-by-stage `no_new_privs`, non-dumpable and Landlock/seccomp on the
launcher itself exist because stages 0 and 1 hold what the daemon is denied
(the host-side Tor dial and API listener). The daemon is the same uid in the
same user namespace, so it is denied `ptrace`, `process_vm_*` and
`pidfd_getfd` by seccomp, and `/proc/<stage>/mem` and the fd directories by
the non-dumpable flag (and Yama where the host has it). Landlock additionally
denies `ptrace_may_access` (including `/proc/<pid>/ns/*` reads) from the
daemon's domain to any other domain; for the same reason the *supervisor*,
not stage0, reads the daemon's namespace links when it verifies the instance
(4.5).

### 4.2 Where the launcher lives: alternatives rejected

| Option | Verdict | Reason |
|---|---|---|
| **Go launcher in the zkapi fork, shipped in the pinned bundle** | **Chosen** | Static, stdlib only (no new third-party code or licence notices), reproducible with the fork's pinned toolchain, one hash for the bundle, both architectures. Prototype proves it on Omarchy. |
| Subcommand of `zkapi-clientd` itself | Rejected | The code that must stay trusted while the daemon is attacked would link the daemon's whole wallet and Ethereum dependency tree; any daemon update would change the launcher's behaviour and review surface. |
| Separate managed tool with its own pin | Rejected | A second download, hash and version-skew rule for something that is only useful with a matching daemon. |
| Bun/Node FFI to `unshare` | Rejected | `unshare(CLONE_NEWUSER)` fails in a multithreaded process, and where it succeeds it moves the supervisor itself into the namespace. A fork from a JavaScript runtime is unsafe. |
| `bwrap` (bubblewrap) | Rejected as the mechanism | Not installed by default (Omarchy has it; stock Ubuntu does not); no Landlock; its seccomp needs a compiled filter blob delivered by file descriptor; it still needs a bridging helper; on Ubuntu 24.04 it hits the same AppArmor restriction. Evidence A.6: it does bring loopback up and sets `no_new_privs`, but leaves seccomp and the bridge to us. Remains useful as a manual comparison, never a dependency. |
| util-linux `unshare` plus `ip` | Rejected | `--map-current-user` leaves no capabilities to bring loopback up; `--map-root-user` works but the daemon then runs as uid 0 inside, changing file ownership and what the daemon sees; no Landlock, no seccomp, no `no_new_privs`, no bridge. Needs `iproute2` too. Evidence A.6. |
| `setpriv` for seccomp | Rejected | Filter support depends on the util-linux version; no Landlock; does not replace the bridge. |
| Weaker mode: Landlock ports plus seccomp, no namespace | Rejected by owner | Direct connections to remote addresses on permitted ports stay possible. |
| systemd `IPAddressDeny=` | Rejected (plan) | A user manager cannot enforce it; privileged, it leaves every loopback port and Unix sockets open. |
| nftables/iptables owner rules, eBPF cgroup filters, slirp4netns or pasta | Rejected | Need root, or emulate a network we do not want to exist. |

Build and pin: the fork's `olympus/build.sh` builds `cmd/zkapi-confine` for
`linux/amd64` and `linux/arm64` with `CGO_ENABLED=0 -trimpath` under the
pinned Go toolchain, with the same two-build reproducibility check, and adds
it to the bundle. `managed-tools.ts` gains `bin/zkapi-confine` in
`ZKAPI_REQUIRED` for Linux x64 (arm64 deferred) and the hash of the
`clientd-v0.1.6-olympus3` bundle. At every
session the supervisor resolves the launcher through the existing
`managedToolExecutable` path (pinned version folder, real path inside it) and
runs `zkapi-confine --version`; where an administrator-installed system copy
exists (section 8) it must be root-owned, not writable by others, and match
the pinned SHA-256.


### 4.3 Bridges: descriptor passing, identity, failure

Two bridges, both created by the launcher before untrusted code runs, both
with one fixed destination. **Neither resolves any pathname once the daemon
runs**, and nothing the daemon can create, rename, unlink or symlink is ever
consulted for the Tor bridge or trusted for the API bridge. That is the answer
to review finding 1.

| Bridge | Direction | In the namespace | On the host | Dials |
|---|---|---|---|---|
| `api` (expose) | host to namespace | stage1 receives, over the control channel, an already authenticated connection and dials `127.0.0.1:<daemon port>` | stage0 binds `<session dir>/api.sock` (mode 0600) before cloning and accepts the supervisor's connections | the daemon, inside the namespace |
| `tor` (reach) | namespace to host | stage1 binds `127.0.0.1:<ns tor port>`; each accepted connection is sent to stage0 as a descriptor | stage0 dials `127.0.0.1:<host tor port>` (`--reach NSPORT=HOSTPORT`) and pumps | the one real Tor SOCKS port |

- **API handshake.** Before any HTTP, each connection runs a mutual
  challenge-response keyed by a 32-byte random `apiToken`: the client sends a
  16-byte nonce, the launcher answers with its own nonce and
  `HMAC-SHA256(token, "srv"|name|cn|sn)`, the client verifies and answers
  with `HMAC-SHA256(token, "cli"|name|cn|sn)`. The token is generated by
  stage0, appears only in the `ready` event on the private status descriptor
  and in the supervisor, and is never in any process the daemon can read
  (stage0 is non-dumpable, outside the PID namespace and under its own
  Landlock domain). A peer that cannot prove the token gets nothing: the
  supervisor sends only its nonce before it has verified the server, so the
  daemon API's bearer tokens never go to a swapped socket. Only descriptors
  cross between the stages: ancillary data is never forwarded by the byte
  pumps.
- **Why this holds on ABI 4-8.** The daemon cannot make a Unix socket
  connect at all (no `AF_UNIX` `socket()`, only an unconnectable stream
  pair), and the remaining attack, re-pointing `api.sock` so the *supervisor*
  connects somewhere else, is defeated by the handshake. Re-pointing can at
  worst deny service: a refused session, never a redirected one.
- **No port to squat; no path to trust.** The session directory is created by
  the supervisor with `mkdtemp`, mode 0700, owned by the user; the launcher
  refuses a directory that is not a real directory, mode 0700, owned by the
  caller, and bridges only at `<dir>/api.sock`. Directory permissions are not
  relied on for security: the daemon is the directory owner's uid and could
  edit it. The `api.sock` path is a rendezvous, not an identity.
- **Fail fast.** A bridge connection to a dead destination is closed at
  once (proven: Tor host stand-in removed, the connection through the bridge
  closes in under a second; daemon killed, `api.sock` is gone and connecting
  gives `ENOENT`). Each bridge allows 64 concurrent connections and closes
  extras. A bridge never retries or buffers across connections, so a failed
  bridge cannot be mistaken for a slow daemon.
- **Crash cleanup.** There is nothing persistent outside the session
  directory: no named namespace, no mount, no iptables state. A namespace
  dies with its last process (proven: the host's count of distinct network
  namespaces is identical before and after the full run, including kill -9 of
  each stage). The existing durable `running.groups` record still names the
  group, so a crashed supervisor's successor kills the group and removes the
  directory exactly as today; the PID namespace makes that kill complete.
- **Bridge failure is a session failure.** Launcher exit is the watchdog
  child's exit, already handled (`session_process_exited`). A broken Tor
  host side surfaces as the daemon's existing transport errors.

### 4.4 Integration with the transport (what changes in code, later)

The shape is the existing `ZkapiConfinement` seam, extended; the Mac
implementation and every Mac test stay as they are.

- `ZkapiConfinement` gains an optional **session** step:
  `prepare(workDir, ports) -> { wrap(argv), fetch, verifyInstance(event),
  close() }`. The Mac returns the current behaviour. The Linux session builds
  the launcher argv (`run --dir <workDir> --status-fd 3 --expose api=<daemon
  port> --reach <ns tor port>=<host tor port> --connect-port ... --bind-port
  ... -- <daemon argv>`) and provides a `fetch` for the daemon origin.
- **The private status descriptor crosses two spawn boundaries**, and both
  change (review finding 7). Today both configure only descriptors 0-2.
  - `supervise()` (`consult-transport-zkapi.ts:1152`): for a confined daemon,
    `stdio` becomes `['pipe','pipe','pipe','pipe']`; the supervisor reads
    `child.stdio[3]` with its own newline-delimited JSON parser that accepts
    only the launcher's known event types (`ready`, `refused`,
    `launcher_exited`). Stdout and stderr keep their present meaning and are
    never parsed for events. The Tor role is unchanged (Tor is not
    confined).
  - The watchdog script (`:1109`) spawns the launcher with
    `stdio: ['ignore','inherit','inherit', 3]`, passing its own fd 3 through
    as the child's fd 3, then closes its copy so that the pipe reaches EOF
    when the launcher exits. The watchdog never reads or writes the channel.
  - The channel is **mandatory** on Linux: no `ready` event on it within the
    start deadline refuses the session (`confinement_unavailable`, detail
    `no_status_event`), exactly as a `refused` event does. The launcher itself
    refuses to start without `--status-fd 3` (exit 64).
- **Level and refusal.** `defaultZkapiConfinement()` on Linux returns
  `loopback_filtered` when `zkapi-confine check` succeeds, and otherwise an
  explicit unavailable state (`code`, `remedy`), not level `none`. The session
  refuses with a new `confinement_unavailable` code before Tor starts; the
  existing `confinement_self_test_failed` covers a failed per-session test.
  `check` runs the real launcher around a short no-op and takes about 0.5 s
  (it holds the no-op for 500 ms so the namespace can be inspected; the
  launcher's own overhead is about 14 ms).
- **Ports and flags.** Linux is `loopback_filtered`, so `filtered` is true and
  the companion and wallet ports and the four custody flags are passed
  exactly as on the Mac (`:2447`, `:2482`). There is no other Linux level
  (no weaker mode), so no other flag set exists. Inside the namespace a port
  number cannot collide with a host listener, but we keep the host-probed
  `companionPorts()` so the Mac and Linux paths share the code and the
  receipt; `daemon_already_running` stays a host check.
- **Fetch adapter.** `fetchImpl` is already injectable. Bun's `node:http`
  ignores a caller-supplied connection, so the Linux session supplies a small
  HTTP/1.1 client over `node:net`: connect to `api.sock`, run the handshake,
  write one request per connection (`Connection: close`, fixed or no body
  length), and parse the response (length-delimited, chunked or
  close-delimited, streaming body, abort, no redirect following) with
  **strict framing**: the response comes from the daemon and is hostile
  input. Content-Length is digits only and bounded; a chunk size is 1 to 8 hex
  digits and bounded; conflicting lengths, a length with chunked, unsupported
  transfer-encodings, malformed header lines, an over-long size line and a
  chunk without its CRLF are errors that fail the exchange before any body
  byte is trusted, through the stream's error path (never an unhandled event). The
  prototype's `unix-fetch.cjs` is that client and is proven under Bun 1.3.14
  and Node 26 (A.1: status, headers, request and response bodies, abort,
  4 MiB intact). `origin` stays `http://127.0.0.1:<daemon port>`; the adapter
  ignores host and port, so `facts.listen` still has to equal the configured
  host (`:2541`) and the daemon's own report is unchanged.
- **Doctor/readiness** (`:1860`): a Linux line, `network confinement: ready
  (user, network and PID namespace, Landlock ABI 9, seccomp)` or
  `unavailable: <reason>; <one remedy>`, from `check`. The confinement
  statement for `loopback_filtered` is unchanged.
- **Receipts**: `confinementSelfTest` as today, plus a non-secret
  `confinementBackend: { kind: 'linux_netns', landlockAbi, layers,
  stage0Layers }`.

### 4.5 Instance binding, listener inspection and the dispatch check

The host's `/proc/net/tcp*` does not contain the namespace's listeners (A.1:
`hostProcNetTcpListsApiPort: false`), and a pid in a launcher event is, by
itself, a claim. The supervisor therefore binds every pid it uses to a
**process instance** and checks the namespaces, not just the pid.

1. **Instance identity.** The `ready` event carries `stage0Pid`,
   `stage0Start`, `stage1Pid`, `stage1Start`, `daemonPid`, `daemonStart`
   (the `starttime` field of `/proc/<pid>/stat`). The daemon's host pid is
   computed by stage0 from `/proc` as the process whose `PPid` is stage1 and
   whose `NSpid` ends in the daemon's namespace pid; it is never taken from
   the daemon. The fourth link, the watchdog, is not reported by anything: it
   is the process the supervisor itself spawned, and the supervisor records its
   pid and start time at spawn (`processInstanceIdentity`).
2. **`verifyInstance(event)`** (run by the supervisor on the event and before
   every key-bearing step) binds the chain **watchdog -> stage0 -> stage1 ->
   daemon**, each link by pid and start time and by its parent: the watchdog's
   start time equals the supervisor's record; stage0's start time equals the
   event's and **its parent is the watchdog**; stage1's start time equals the
   event's and **its parent is stage0**; the daemon's start time equals the
   event's and **its parent is stage1**; the four are distinct processes.
   PID-namespace depth is checked on the same chain: stage0 has a single
   `NSpid` entry (host namespace), stage1's `NSpid` is `[host pid, 1]` (init
   of a nested namespace), the daemon's is nested, and the daemon's PID and
   network namespaces differ from the supervisor's own. (Stage1 is non-dumpable,
   so its namespace links are not readable; the daemon's are.) A reused pid
   fails a start-time check; an unrelated pid or a reparented stage1 fails
   parentage and depth. The matrix, which starts every session through the
   watchdog stand-in, runs nine negative cases (A.1) and requires each to be
   rejected.
3. **Which table.** Read `/proc/<daemon pid>/net/tcp*` (the daemon's own
   network namespace) instead of the host's table. The supervisor can read it
   (proven), and it shows the namespace's listeners.
4. **Who holds the socket.** Match inodes against `/proc/<pid>/fd` of the
   processes in the daemon's namespace, as today. The daemon, the companion
   and the wallet API listeners are held by the daemon tree and are readable.
   The stage1 listener (the Tor port) is held by the launcher, which is
   deliberately non-dumpable, so it is accepted by construction (4.3) rather
   than by descriptor.
5. **The namespace is checked as a set, strictly.** The namespace must list
   exactly the expected listeners (daemon, companion proxy, wallet API, the
   Tor bridge port) and **nothing else**. An extra listener, for example
   from an unbound `listen()` (which 4.1 does not stop), fails the check and
   refuses the session before the key moves (A.1: `unbound listen()`). The
   extra listener is in any case reachable only from inside the namespace;
   from the host it gives `ECONNREFUSED`.
6. **Dispatch.** `owned()`/`guard()` keep their cadence (before the
   unauthenticated probe, before `/admin/status`, throughout policy warm-up,
   and at the last moment before the key). The Tor entry is unchanged (host
   Tor, host table, Tor's group). Only the table read moved, and
   `verifyInstance` joins the checks.

A forged event on the daemon's stdout is inert for two reasons: events are
read only from the private descriptor, and a forged pid fails the instance
checks (A.1: `forgedLineSeenOnDaemonOutput: true`, `eventsAfterForge:
["ready"]`).

### 4.6 Self-test (Linux)

`confinement.selfTest(workDir, env, ports)` on Linux, per session, before Tor
starts. It uses the real launcher and the engine's own runtime (the probe is
JavaScript, as on the Mac), controlled listeners that the test owns, and an
unconfined control run of the same probe:

Host side (the supervisor's process): a TCP listener standing in for Tor on a
free host port, reached through `--reach`; squatter listeners on the
session's own companion and wallet port numbers (they must never be reached
inside); a second loopback port; a `127.0.0.2` listener; a listener on the
machine's non-loopback address when it has one and a TEST-NET-1 connect
always; a `::1` listener; a **host Unix stream socket** and a **host Unix
datagram socket** (a `/dev/log` stand-in that logs every datagram), each a
decoy that counts connections and bytes; an abstract Unix socket; two decoy
descriptors (a connected Unix socket and a connected TCP socket) deliberately
left inheritable.

Probe, run in the confined parent (as the daemon stand-in, serving the real
daemon API port), in an exec'd child of the same runtime, and in an exec'd
child that is a different program (the launcher's own `probe` command, raw
syscalls); the unconfined control runs the same script:

| Row | Control (outside) | Confined parent and child |
|---|---|---|
| Tor port reaches the host stand-in and echoes | echoed | echoed through the bridge |
| Bind and connect on the companion and wallet ports | refused (the squatter holds them) | bound, connected, and the answer is the namespace's, not the squatter's |
| Other loopback port; `127.0.0.2`; non-loopback address; TEST-NET-1 | connected / unreachable | failed fast (under 1 s) |
| `::1`, IPv4-mapped IPv6 | connected | failed fast |
| UDP to a remote address, UDP to an allowed loopback port, UDP bind | sent / bound | failed |
| DNS (TCP to a resolver stub, a name lookup) | connected / resolved | failed fast |
| Host path Unix socket, host abstract Unix socket | connected | failed fast |
| Bind: other port, port 0, the Tor port, **wildcard on a forbidden port** | bound | refused |
| **Wildcard bind on a permitted port; unbound `listen()`** | bound / listening | allowed (documented residual); the unbound listener is caught by the strict set check |
| Inherited decoy descriptors | present | absent |
| Capabilities, `no_new_privs`, seccomp mode, own network and user namespaces, only loopback | no / 0 / 0 / same / many | zero / 1 / 2 / different / only `lo` |
| Raw syscalls (exec'd Go child): `AF_INET6`, UDP, raw, `AF_UNIX`, packet, vsock, other netlink | allowed or unrelated | refused |
| **`socketpair`: stream / dgram / seqpacket; connect and sendto on a pair to the host stream and datagram decoys; connect after shutdown** | allowed | stream pair created but `EISCONN`/`EACCES`; dgram and seqpacket `EPERM`; the datagram decoy receives nothing |
| `ptrace` and `process_vm_readv` on the launcher, stage0 and the namespace init; `io_uring_setup`; `unshare` of user, net **and pid**; `clone3`; clone into a new user or **pid** namespace; `setns`; `mount`; write-open of `/proc/<pid>/mem`; signalling the launcher and stage0; **SIGKILL to the namespace init, which must still be alive after** | allowed or unrelated | refused (`EPERM`, `EACCES`, `ESRCH` or `ENOSYS`); the init survives |
| Bridge: Tor host side removed | n/a | connection through the bridge closes fast |
| Bridge: a 4 MiB request body echoed host to namespace and back | n/a | byte-identical |

Pass condition: every row, in the parent and in the child, and the control
shows the opposite on every row that is not allowed (so a probe that cannot
detect is caught, as on the Mac). **A missing row is a failure**, not a pass.
Any mismatch, a launcher refusal, a missing `ready` event, an instance that
does not bind, or a probe that fails to run refuses the session
(`confinement_self_test_failed`). The control run and the confined run happen
concurrently; the dominant cost is the 3 s TEST-NET control timeout the Mac
already pays.

The prototype's `check` command is a separate, cheaper question (can this
host build the confinement at all) for the doctor. The qualification step of
the plan (section 9) additionally runs the matrix, including the lifecycle
and fault-injection scenarios of A.1, against the actual pinned binary.

### 4.7 Failure and refusal behaviour

| Condition | Where detected | Result |
|---|---|---|
| Namespace creation refused (AppArmor restriction, `user.max_user_namespaces=0`, Debian's `kernel.unprivileged_userns_clone=0`, container runtime seccomp, nested confinement) | `check`, and the session's launcher | refuse: `namespace_unavailable`; Ubuntu/AppArmor adds the printed admin step (section 8); other hosts get the exact sysctl or "this environment does not allow it" |
| Namespace created but loopback cannot be brought up or the uid map cannot be written | launcher | same (`namespace_unavailable`, or `loopback_unavailable` in the detail) |
| Landlock ABI below 4, or Landlock disabled | `check`, launcher | refuse: `landlock_unavailable` with "needs Linux 6.7 or newer with Landlock enabled" |
| seccomp unavailable | launcher | refuse: `seccomp_unavailable` |
| Stage0 cannot harden itself | launcher | refuse: `launcher_hardening_failed`; stage1 never starts the daemon |
| A descriptor cannot be made close-on-exec in any stage | launcher | refuse: `descriptor_sanitize_failed` |
| Bridge cannot bind, capabilities not empty, restrictions not applied, launcher exits before `ready` | launcher | refuse; no daemon starts |
| No `--status-fd 3`; no event on the status channel | launcher, supervisor | refuse (exit 64; `confinement_unavailable`) |
| Event does not bind to a process instance, or the namespace lists an unexpected listener | supervisor | refuse before the key moves |
| Launcher binary missing, not the pinned hash, wrong architecture (arm64 until qualified) | supervisor | refuse: `confinement_unavailable` |
| Self-test row differs or is missing | supervisor | refuse: `confinement_self_test_failed` |
| Launcher or any stage dies during a session | watchdog/launcher | existing `session_process_exited`; the PID namespace takes the whole tree with it |
| Tor or API bridge breaks during a session | connection closes fast | existing transport errors; nothing continues unconfined |

Nothing falls back to an unconfined daemon: the daemon is started only by
stage2, only after the restrictions are applied, and only after stage0 has
acknowledged its own.

## 5. What this does not do (residuals)

- **File reads and writes are not restricted** (the Mac profile is the same).
  A compromised daemon can read the user's files; it cannot send them
  anywhere except through Tor's SOCKS port.
- **Tor's SOCKS port can open connections to anything on the Internet**, by
  design. The confinement bounds the daemon to that channel.
- **Listener policy is weaker than the Mac's, and harmless by construction.**
  Landlock's TCP bind rule does not cover `listen()` on an unbound socket
  (the kernel picks an ephemeral port) and does not constrain the address of
  a bind on a permitted port. So a daemon can open a private listener on an
  ephemeral port, or bind `0.0.0.0` on a permitted port. In this namespace
  the only interface is loopback, no one outside can connect, and only the
  daemon's own tree can; the strict listener-set check catches an unexpected
  listener and refuses the session. We do not claim bind parity. Closing it
  fully would need the daemon to accept pre-bound sockets (it does not) or a
  seccomp rule on `listen()`, which a filter cannot scope by bound state.
- **The host's `/proc` shows the daemon other same-user processes.** Same on
  the Mac. The PID namespace does not hide the host's procfs from the daemon
  (no mount is allowed), but it makes host pids unaddressable for signals and
  `ptrace`.
- **ABI below 6**: the abstract-socket and signal scopes are absent; the
  namespace and seccomp still deny both (signalling the launcher gives
  `ESRCH`, abstract sockets are per network namespace). **ABI below 9**: path
  Unix sockets are hidden by seccomp refusing `AF_UNIX` `socket()`, not by
  Landlock; the matrix passes either way (A.2, emulated ABI 4).
- **No Yama and a dumpable launcher** would let a same-uid process read the
  launcher's memory; the launcher is non-dumpable, so this is closed. The
  prototype could not turn Yama off to prove the non-dumpable layer alone
  (Unproven; the `dumpable` ablation shows no failing row on this host).
- **Cleanup assumes stage1 and stage0 are not both compromised.** A
  compromised stage1 cannot clear its parent-death signal (frozen at SIGKILL),
  so stage0 or the watchdog dying still ends the namespace. The signal is also
  frozen for stage0 itself, but stage0 is the process the watchdog's group kill
  reaches directly; a compromise of stage0 is out of scope here (it holds the
  host dial and the API listener, and is non-dumpable, Landlock- and
  seccomp-confined, outside the daemon's PID namespace).
- **Kernel attack surface** is not zero: namespaces, netlink route sockets
  and the allowed syscalls remain reachable to the daemon. We removed the
  well-known unprivileged-kernel-bug surfaces (`io_uring`, `bpf`,
  `userfaultfd`, nested namespaces, `perf_event_open`, mounts).

## 6. Prototype

`tools/zkapi-confine-prototype/` (Go launcher, about 2,000 lines including the
probe and the control channel, standard library only; `test/` holds the
JavaScript probe, stand-in daemon, watchdog stand-in, host driver and a Go
stand-in). It is labelled prototype in every header, has ablation, fault and
older-ABI switches that the shipped launcher must not have, and is not built
by any repository script.

The matrix (`test/matrix.mjs`) is **fail-closed**: it keeps a list of
failures and exits non-zero if the list is not empty. Every control run, probe
row, identity check, lifecycle result, refusal, fault injection and ablation is
an assertion; a missing probe row counts as a failure; the cleanup of every
session asserts that killing the recorded group removed every process (and
fails the run if anything had to be swept up afterwards). Adversarial
operations, not just API-creation checks, cover the review's findings: a
datagram `socketpair` re-pointed at a host datagram socket, a stream pair
`connect`/`sendto`, an `api.sock` swapped for a symlink to a host stream
socket, a Tor host side taken away, an unbound `listen()`, a wildcard bind of
a forbidden and of a permitted port, escapers that `setsid`, `setpgid` and
double-fork, stage0 and stage1 and daemon and watchdog killed with SIGKILL, an
adversarial init that tries to clear its parent-death signal and leave its
group, forged events on stdout, a write to descriptor 3, nine forged
instance bindings against the watchdog -> stage0 -> stage1 -> daemon chain,
injected hardening and cloexec faults (the fallback path included), malformed
HTTP framing from the daemon (one subprocess per case, timed from outside), and
a silent launcher. Every session is started the way the supervisor's watchdog
starts the launcher (`shim.cjs`: the status pipe passed as fd 3 and closed in
the watchdog).

Build (through the remote-build lane; the Mac has no Linux toolchain use):

```
~/.local/bin/remote-build run --cwd tools/zkapi-confine-prototype \
  --image golang:1.25 --no-install --artifact tools/zkapi-confine-prototype/out -- \
  sh -c 'go vet ./... && mkdir -p out && for a in amd64 arm64; do \
  GOOS=linux GOARCH=$a CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o out/zkapi-confine-$a . ; done'
```

Run (on the Linux host, with any of Bun or Node):

```
bun test/matrix.mjs --launcher ./zkapi-confine --gostandin ./gostandin \
  [--mode quick|full] [--abi 4] --out result.json
```

`--abi N` makes the launcher behave as on a kernel with Landlock ABI N (to
exercise the older-kernel code paths on a newer kernel); `--mode full` adds
the one-layer-off ablations. The exit code is the failure count.

## 7. Results on real hardware

Omarchy 4.0.1 laptop, x86_64, kernel 7.1.9-arch, Landlock ABI 9, no AppArmor,
Yama on, unprivileged user namespaces allowed. Everything ran as the ordinary
user under one scratch directory; nothing was installed system-wide or
changed. Raw outputs are in appendix A. Summary:

- Confined matrix, Bun 1.3.14 `--mode full`: **PASS, 0 failures**. Node
  26.7.0 `--mode quick`: PASS, 0 failures. Bun `--mode quick --abi 4`
  (emulated Landlock ABI 4, the Ubuntu 24.04 shape; the real kernel is ABI
  9): PASS, 0 failures. The unconfined control shows the opposite on every
  denied row.
- Review findings: each has adversarial rows that pass confined and are
  shown able to fail (control or ablation), section 1.2.
- Go stand-in (an `net/http` server and Go dialers): 0 violations. The real
  `zkapi-clientd` binary built from the fork started, printed its version,
  showed its supervisor flags and reached its configuration check under the
  revision-1 confinement (A.5). The revised launcher has not yet been run
  with the real daemon (Unproven).
- Fault injection and lifecycle: see A.1. The escapers (`setsid`,
  `setpgid`, double fork) die with the session in all six lifecycle
  scenarios, and survive a group kill when the PID namespace is ablated.
  Network-namespace count unchanged afterwards; no stray launcher processes.
- Cost: session start to first probe about 0.38 s; API bridge round trip
  about 1.1 ms; 4 MiB through the bridge intact; `check` about 0.5 s of
  which 500 ms is the deliberate no-op hold.
- Refusal path on Ubuntu 24.04, kernel 6.8, restriction on (A.6): the
  namespace is created but unusable (`setgroups` write denied, loopback up
  gets `EPERM`), so the launcher reports `namespace_unavailable`. The same
  refusal code is also shown on the laptop by running `check` from inside a
  confinement (nested namespace creation refused, A.1).

### Unproven

- **Ubuntu positive path.** Skipped by owner decision (Omarchy only). The
  printed step of section 8 follows the shape of profiles Ubuntu ships but has
  not been installed or run; the Go launcher has not been run on a restricted
  host (A.6 is a Python surrogate of its first steps). The launcher
  re-executes itself through `/proc/self/exe`, whose path-attachment under
  AppArmor is therefore unconfirmed. We make no claim for Ubuntu beyond the
  refusal. Because every session runs the self-test, a host that passes
  `check` and the self-test is proven at run time; a host that does not
  refuses.
- **arm64.** Deferred by owner decision. The arm64 launcher cross-compiles
  and its syscall table is cross-checked but has never run; the shipped
  launcher refuses on arm64 until it is qualified. Tor has no Linux arm64
  bundle in any case.
- **Kernels between ABI 4 and 9 on real hardware** (ABI 4 is emulated on an
  ABI 9 kernel), and hosts with Yama off, SELinux enforcing, or inside
  containers.
- **The real companion and Tor, and the real daemon beyond startup** (needs a
  funded wallet), under the revised launcher.
- **The real supervisor and watchdog** with the status descriptor plumbing
  of 4.4: the matrix uses a stand-in supervisor (`matrix.mjs`) and a watchdog
  stand-in (`shim.cjs`) that follow the specified boundary; the TypeScript
  integration is later work.
- **Throughput under sustained streaming** (only a 4 MiB body measured).

## 8. The Ubuntu administrator step

Offered by the doctor and in the refusal message when the host reports
`kernel.apparmor_restrict_unprivileged_userns = 1` (Ubuntu 23.10 and later).
**Olympus prints this text and the exact commands; it never runs `sudo`**
(owner decision). The positive path is not proven by this work (owner
decision: Omarchy only), so the step is guidance, offered after the refusal,
and the lane stays refused until `check` and the per-session self-test pass.

> **One step needs an administrator.**
>
> To keep your private questions from leaving through any other route,
> Olympus runs its private-answer helper in an isolated network space.
> Ubuntu blocks that by default. This step lets exactly one program,
> a copy of Olympus's helper that only an administrator can change, create
> that space. Nothing else on the computer is affected.

```
sudo install -D -m 0755 -o root -g root \
  "$HOME/.local/share/olympus/tools/zkapi-clientd/<version>/bin/zkapi-confine" \
  /usr/local/libexec/olympus/zkapi-confine
sudo tee /etc/apparmor.d/olympus-zkapi-confine >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/olympus-zkapi-confine>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/olympus-zkapi-confine
```

Then ask Olympus again. To undo it:
`sudo apparmor_parser -R /etc/apparmor.d/olympus-zkapi-confine && sudo rm /etc/apparmor.d/olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine`

Notes: the profile shape (`flags=(unconfined)`, `userns,`, `include if exists
<local/...>`) is the one Ubuntu's own `lxc-unshare` profile uses (read-only
look at the test host's `/etc/apparmor.d`). `<version>` is filled in by
Olympus from the installed pin. The profile attaches to a root-owned copy,
not to the user-writable tools folder, so no user process can gain the
exception by replacing a file. After each Olympus upgrade that changes the
launcher, the doctor shows the one `sudo install` line again (the hash no
longer matches the pin); the profile does not change. We do not recommend the
system-wide alternative `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
A sysctl value alone cannot identify why namespace creation failed, so the
doctor reports what `check` observed (the launcher's refusal code and detail),
not an inference from the sysctl.

Other hosts: if namespace creation fails and the AppArmor sysctl is absent
or 0, the message names what was observed (`user.max_user_namespaces`,
`kernel.unprivileged_userns_clone`, or "this environment forbids nested
namespaces") and says the private lane is not available on this computer.
Containers that forbid nested namespaces and SELinux-enforcing hosts that deny
the clone take the same refusal.

## 9. Implementation plan

Governing rules (review finding 8):

- **Every critical step is reviewed before it lands.** Critical steps are the
  launcher (step 1), the transport integration (step 4) and the activation
  (step 7); each gets a fresh independent review before merge, by someone
  other than its author, against the properties in section 3 and the matrix
  of 4.6. Review findings are fixed or answered with evidence before merge.
- **Nothing activates the confinement for users before the integrated
  boundary has passed real-route qualification (step 5) and the integrated
  review (step 6).** Steps 1 to 4 are dark: Linux selection in
  `defaultZkapiConfinement()` stays as it is today (the private lane stays
  unavailable on Linux), and the new code is reachable only from tests
  through the injected `ZkapiConfinement` seam. Step 7 is the single change
  that turns it on.
- There is no weaker mode at any step. A step that cannot meet the
  refusal rows of 4.7 does not land.

1. **Fork: launcher.** Move the prototype into the zkapi fork as
   `zkapi-clientd/cmd/zkapi-confine`; remove the ablation, fault and ABI
   switches and the prototype pair knob; keep standard library only; refuse on
   any architecture except `linux/amd64` (arm64 deferred). Unit tests: argument
   parser, seccomp program builder (golden program, jump ranges), control
   channel, handshake, bridge pump and limits, `check` classification with an
   injected failing clone, descriptor-sanitise failure paths. Reproducible
   build in `olympus/build.sh` and CI. *Acceptance:* CI green; two builds
   identical; `go vet`/gofmt clean; the fail-closed matrix at 0 failures on an
   Omarchy-class host. *Review before merge.*
2. **Release `clientd-v0.1.6-olympus3`.** Built from the reviewed fork commit
   with the launcher in the bundle. The owner has authorised publishing it
   (2026-10-12); it is published by its owner, only after step 1 is reviewed
   and merged and the artifacts are built, and nothing in Olympus references
   it until step 3. We do not publish it. *Acceptance:* bundle hash recorded;
   the launcher inside matches a rebuild.
3. **Pin and install.** `managed-tools.ts` pins the new bundle, requires
   `bin/zkapi-confine` for Linux x64, `managed-tools.test.ts` coverage.
   Dark: the lane stays unavailable on Linux. *Acceptance:* install on
   Omarchy verifies the hash and refuses a tampered launcher; Mac install
   unchanged.
4. **Transport, behind the seam.** `ZkapiConfinement.prepare`, the Linux
   implementation, the status-descriptor plumbing through `supervise()` and
   the watchdog (4.4), the HTTP/1.1 fetch adapter with the handshake,
   `verifyInstance` and namespace-aware inspection with the strict listener
   set (4.5), the new `confinement_unavailable` code, doctor line, receipt
   field, the printed admin step, the Linux self-test (4.6), the strict-framing client (4.4).
   Mac code paths untouched; Linux selection stays dark. *Acceptance:* existing Mac and
   fake-confinement tests pass unchanged; new unit tests with injected fakes
   cover every refusal row of 4.7, forged stdout events, a missing status
   channel, the nine forged chain bindings of 4.5 and the malformed framing
   cases of A.1, driven through a real watchdog spawn; an integration test runs the real launcher with a
   stand-in daemon on a Linux runner and fails if a layer is removed
   (ablation inverted into assertions). *Review before merge.*
5. **Real-route qualification (Omarchy).** The real daemon, managed
   companion and Tor under the launcher with the integration of step 4
   injected: managed transport block matches, custody flags accepted, the
   session reaches `ready`, one private answer end to end, and the full
   matrix (lifecycle and fault injection included) against the actual
   pinned binary. *Acceptance:* companion and Tor run under the filter
   without false refusals (in particular that neither needs a parent-death
   signal other than SIGKILL, section 4.1); receipt shows `loopback_filtered` with the backend
   detail; raw output attached to the change. Hosts other than Omarchy are
   not qualified (owner decision) and rely on the per-session self-test.
6. **Integrated independent review.** Scope: the whole boundary as
   integrated, the launcher's syscall tables and Landlock handling, the
   refusal logic, the instance binding and inspection, the status
   descriptor plumbing, the printed admin step, and the step 5 evidence.
   Must be answered before step 7.
7. **Activation.** One change: Linux selection returns
   `loopback_filtered` when `check` passes; docs and the doctor line go
   live. *Acceptance:* steps 5 and 6 complete; Mac regression untouched.
   *Review before merge.*

Deferred by owner decision, each its own later work: Linux arm64 (launcher
run on hardware; Tor has no Linux arm64 bundle), and an Ubuntu positive-path
proof of the admin step.

## 10. Owner decisions (recorded)

These were open questions in revision 1; the owner decided them on
2026-10-12 and they are no longer questions:

1. **Weaker mode.** None. A host that cannot create the namespace is
   refused. Landlock below ABI 4 is refused.
2. **Administrator step.** The doctor prints the `sudo` steps; Olympus never
   runs `sudo` and offers no `pkexec` helper.
3. **Ubuntu positive-path proof.** Skipped; Omarchy only.
4. **arm64.** Deferred; the launcher refuses on arm64 until qualified.
5. **Release.** `clientd-v0.1.6-olympus3` carrying the launcher is
   authorised, to be published by its owner once the launcher is built and
   reviewed (section 9, step 2). Not published by this work.
6. **Unsupported hosts.** Containers that forbid nested namespaces and
   SELinux-enforcing hosts that deny the clone refuse with a plain message.

Residual decisions that this design leaves with the owner or reviewer, none
of which reopens the above: accepting the listener-policy residual of
section 5 (no bind parity; private listeners are harmless and detected), and
the per-session cost of the self-test.


## Appendix A. Raw evidence

Binary under test: `zkapi-confine` for `linux/amd64`, SHA-256
`c5078e3732bb82336de6605b92ff19a3c6382666946801b41f47eb38211806a3` (computed with `sha256sum` on the laptop after the final build),
built through the remote-build lane with a Go 1.25 toolchain in an official
container, run from a scratch directory.

Bun 1.3.14 is the engine's own runtime and the default driver. Host: Omarchy
4.0.1, kernel 7.1.9-arch, x86_64, Landlock ABI 9, LSMs `capability, landlock,
lockdown, yama, bpf` (no AppArmor), `user.max_user_namespaces=63255`, Yama
`ptrace_scope=1`, ordinary unprivileged user, all work under one scratch
directory. Tools present on the host were bwrap 0.11.2, util-linux unshare,
setpriv, ip, python3, gcc, socat; Go was not installed (the binaries were built
through the remote-build lane and copied over). Paths and the API token are
removed or redacted in the outputs below.

### A.1 Full matrix, Bun 1.3.14, `--mode full` (verbatim)

Sections in order: host facts and `check`; unconfined control; the confined
session (every probe row, parent and exec'd child, against the control);
instance binding including the four negative bindings, inspection and the
forged-event and descriptor-3 checks; unbound `listen()`; cost; the Go
stand-in; the Tor host side taken away and the API socket path swapped for a
symlink to a host stream decoy; the six lifecycle scenarios with four escapers
each; refusals and fault injection; ablations (a line per layer showing which
probe rows notice its removal, with the PID-namespace ablation showing the
escapers surviving a group kill); teardown with the namespace and leaked
process counts. The exit code was 0.

```

== host facts
host: {"kernel":"7.1.9-arch1-2","runtime":"bun 1.3.14","check":{"landlockAbi":9,"layers":["netns","pidns","ipv6-off","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"],"ok":true,"stage0Layers":["nnp","launcher-undumpable","launcher-landlock","launcher-seccomp"]}}

== control (no confinement)
[control] unexpected rows: 0; datagrams the probe landed on the host decoy: 1

== confined session: matrix
[confined] ready event: {"apiToken":"(redacted)","bridgesExpose":["api"],"bridgesReach":["34293"],"daemonPid":91658,"daemonStart":"1342335","event":"ready","landlockAbi":9,"layers":["netns","pidns","ipv6-off","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"],"stage0Layers":["nnp","launcher-undumpable","launcher-landlock","launcher-seccomp"],"stage0Pid":91638,"stage0Start":"1342334","stage1Pid":91645,"stage1Start":"1342334"}
[confined] rows (parent | exec'd child) with the unconfined control:
  inherited_decoy_fds            outside=2                    parent=0                    child=0
  caps                           outside=nonzero              parent=zero                 child=zero
  no_new_privs                   outside=0                    parent=1                    child=1
  seccomp_mode                   outside=0                    parent=2                    child=2
  net_ns_differs                 outside=no                   parent=yes                  child=yes
  user_ns_differs                outside=no                   parent=yes                  child=yes
  interfaces                     outside=lo,enp124s0u2        parent=lo                   child=lo
  tor_bridge_echo                outside=TOR-HOST:probe       parent=TOR-HOST:probe       child=TOR-HOST:probe
  companion_bind_connect         outside=denied:EADDRINUSE    parent=bound_connected_ns   child=bound_connected_ns
  wallet_bind_connect            outside=denied:EADDRINUSE    parent=bound_connected_ns   child=bound_connected_ns
  connect_other_port             outside=connected            parent=failed_fast          child=failed_fast
  connect_loopback_alias         outside=connected            parent=failed_fast          child=failed_fast
  connect_lan                    outside=connected            parent=failed_fast          child=failed_fast
  connect_remote_testnet         outside=timeout              parent=failed_fast          child=failed_fast
  ipv6_loopback                  outside=connected            parent=failed_fast          child=failed_fast
  ipv4_mapped                    outside=connected            parent=failed_fast          child=failed_fast
  udp_remote                     outside=sent                 parent=failed               child=failed
  udp_loopback                   outside=sent                 parent=failed               child=failed
  udp_bind                       outside=bound                parent=failed               child=failed
  dns_stub_tcp                   outside=connected            parent=failed_fast          child=failed_fast
  dns_lookup                     outside=resolved             parent=failed_fast          child=failed_fast
  unix_host_path                 outside=connected            parent=failed_fast          child=failed_fast
  unix_host_abstract             outside=connected            parent=failed_fast          child=failed_fast
  bind_other_port                outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_tor_port                  outside=denied:EADDRINUSE    parent=denied:EACCES        child=denied:EACCES
  bind_ephemeral                 outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_wildcard_forbidden_port   outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_wildcard_permitted_port   outside=denied:EADDRINUSE    parent=bound                child=bound
  -- exec'd Go child (raw syscalls), launcher protection --
  socket_inet_stream                   outside=ok                 confined=ok
  socket_inet6                         outside=ok                 confined=EPERM
  socket_inet_dgram                    outside=ok                 confined=EPERM
  socket_inet_raw                      outside=EPERM              confined=EPERM
  socket_unix                          outside=ok                 confined=EPERM
  socket_unix_dgram                    outside=ok                 confined=EPERM
  socket_netlink_route                 outside=ok                 confined=ok
  socket_netlink_generic               outside=ok                 confined=EPERM
  socket_packet                        outside=EPERM              confined=EPERM
  socket_vsock                         outside=ok                 confined=EPERM
  socketpair_unix_stream               outside=ok                 confined=ok
  socketpair_unix_dgram                outside=ok                 confined=EPERM
  socketpair_unix_seqpacket            outside=ok                 confined=EPERM
  pair_stream_connect_host_path        outside=EISCONN            confined=EACCES
  pair_stream_sendto_host_path         outside=EISCONN            confined=EISCONN
  pair_stream_connect_after_shutdown   outside=EISCONN            confined=EACCES
  pair_dgram_connect_host_path         outside=ok                 confined=no_socket
  pair_dgram_sendto_host_path          outside=ok                 confined=no_socket
  inet_connect_unix_addr               outside=EAFNOSUPPORT       confined=EAFNOSUPPORT
  listen_unbound                       outside=listening:48291    confined=listening:34061
  ptrace_attach_launcher               outside=EPERM              confined=EPERM
  ptrace_attach_stage0                 outside=EPERM              confined=EPERM
  ptrace_attach_ns_init                outside=EPERM              confined=EPERM
  process_vm_readv_launcher            outside=ok                 confined=EPERM
  io_uring_setup                       outside=EFAULT             confined=EPERM
  unshare_newuser                      outside=EINVAL             confined=EPERM
  unshare_newnet                       outside=EPERM              confined=EPERM
  unshare_newpid                       outside=EPERM              confined=EPERM
  clone3                               outside=EINVAL             confined=ENOSYS
  clone_newuser_exec                   outside=ok                 confined=error
  clone_newpid_exec                    outside=error              confined=error
  setns_net                            outside=EPERM              confined=EPERM
  mount_tmpfs                          outside=EPERM              confined=EPERM
  open_launcher_mem_rw                 outside=EACCES             confined=EACCES
  open_stage0_mem_rw                   outside=EACCES             confined=EACCES
  signal_launcher                      outside=ok                 confined=ESRCH
  signal_stage0                        outside=ok                 confined=ESRCH
  signal_ns_init_sigkill               outside=EPERM              confined=EPERM
  ns_init_alive_after                  outside=yes                confined=yes
  fetch adapter over the authenticated bridge: {"healthz":{"status":200,"body":"ns"},"postEcho":1008,"notFound":404,"abort":"aborted"}
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] unexpected rows: 0

== instance binding, inspection, private status channel
{
  "instanceProblems": [],
  "chain": {
    "watchdog": 91632,
    "stage0": 91638,
    "stage1": 91645,
    "daemon": 91658
  },
  "negativeBindings": {
    "pidReuse": [
      "daemon start time does not match its pid"
    ],
    "unrelatedPid": [
      "daemon is not a child of stage1",
      "daemon is not in a nested PID namespace",
      "daemon shares our PID namespace",
      "daemon shares our network namespace"
    ],
    "stage0Reuse": [
      "stage0 start time does not match its pid"
    ],
    "stage1Reuse": [
      "stage1 start time does not match its pid"
    ],
    "wrongWatchdog": [
      "stage0 is not a child of the watchdog we started"
    ],
    "watchdogReuse": [
      "watchdog start time does not match the instance we spawned"
    ],
    "stage0IsTheWatchdog": [
      "stage0 is not a child of the watchdog we started",
      "stage1 is not a child of stage0",
      "chain links are not distinct processes"
    ],
    "stage1Reparented": [
      "stage1 is not a child of stage0",
      "daemon is not a child of stage1",
      "chain links are not distinct processes",
      "stage1 is not PID 1 of a nested PID namespace"
    ],
    "stage1Unrelated": [
      "stage1 is not a child of stage0",
      "daemon is not a child of stage1",
      "stage1 is not PID 1 of a nested PID namespace"
    ]
  },
  "processGroup": [
    "bun",
    "zkapi-confine",
    "exe",
    "bun"
  ],
  "nsListeners": [
    34293,
    40625
  ],
  "hostProcNetTcpListsApiPort": false,
  "apiSockOwnerUidIsOurs": true,
  "apiSockMode": "600",
  "procOwnerUid": {
    "launcher": 1000,
    "daemon": 1000,
    "us": 1000
  },
  "launcher": {
    "pid": 91645,
    "NoNewPrivs": "1",
    "Seccomp": "2",
    "CapEff": "0000000000000000"
  },
  "daemon": {
    "pid": 91658,
    "NoNewPrivs": "1",
    "Seccomp": "2",
    "CapEff": "0000000000000000"
  },
  "stage0": {
    "NoNewPrivs": "1",
    "Seccomp": "2"
  },
  "forgedLineSeenOnDaemonOutput": true,
  "eventsAfterForge": [
    "ready"
  ]
}

== unbound listen() (finding: listener policy)
  extra namespace listener 49867 (unbound listen) detected by the strict set check; unreachable from the host: ECONNREFUSED

== cost of the bridge and the launcher
{"sessionUpToProbeMs":429,"apiBridgeRoundTripMs":1.18,"checkWallMs":[514,514,513,514,514]}

== Go stand-in daemon
{"bind_ipv6":"denied","bind_other_port":"denied","connect_other_port":"failed_fast","connect_remote_testnet":"failed_fast","dns_lookup":"failed","ipv6_loopback":"failed_fast","tor_bridge_echo":"TOR-HOST:probe","udp_dial":"failed_fast"}

== Tor bridge: host side down, then API path swapped (finding: bridge redirect)
{
  "torHostDown": "closed_fast",
  "apiPathSwapped": {
    "verdict": "refused",
    "decoyConnections": 1,
    "decoyBytes": 0,
    "decoySawHttp": false
  }
}

== lifecycle: the session ends with every descendant
{
  "daemon-exits": {
    "escapersAlive": 4,
    "outsideGroup": 4,
    "launcherExit": {
      "code": 0,
      "signal": null
    },
    "allGone": true
  },
  "supervisor-group-kill": {
    "escapersAlive": 4,
    "outsideGroup": 4,
    "allGone": true
  },
  "stage0-sigkill": {
    "escapersAlive": 4,
    "outsideGroup": 4,
    "allGone": true
  },
  "stage1-sigkill": {
    "escapersAlive": 4,
    "outsideGroup": 4,
    "stage0Exit": {
      "code": 137,
      "signal": null
    },
    "allGone": true
  },
  "daemon-sigkill": {
    "escapersAlive": 4,
    "outsideGroup": 4,
    "launcherExit": {
      "code": 137,
      "signal": null
    },
    "allGone": true,
    "apiSocketAfter": "ENOENT"
  },
  "shim-sigkill": {
    "aliveBefore": 8,
    "allGone": true
  },
  "init-escape": {
    "esc": {
      "keep": "ok",
      "soften": "EPERM",
      "clear": "EPERM",
      "setsid": "ok"
    },
    "allGone": true
  },
  "init-escape-without-seccomp": {
    "esc": {
      "keep": "ok",
      "soften": "ok",
      "clear": "ok",
      "setsid": "ok"
    },
    "allGone": false
  }
}

== refusals and fail-closed behaviour
{
  "badDirMode": {
    "code": 64,
    "signal": null,
    "stdout": "",
    "stderr": "zkapi-confine: --dir must be a real directory, mode 0700, owned by this user",
    "status": []
  },
  "noStatusFd": {
    "code": 64,
    "signal": null,
    "stdout": "",
    "stderr": "zkapi-confine: the private status descriptor is required: pass --status-fd 3",
    "status": []
  },
  "checkInsideConfinement": {
    "code": 78,
    "out": [
      "{\"code\":\"internal\",\"detail\":\"operation not permitted\",\"ok\":false}"
    ]
  },
  "stage0Hardening": {
    "code": 78,
    "events": [
      "refused:launcher_hardening_failed"
    ]
  },
  "stage0Cloexec": {
    "code": 78,
    "events": [
      "refused:descriptor_sanitize_failed"
    ]
  },
  "stage1Cloexec": {
    "code": 78,
    "events": [
      "refused:descriptor_sanitize_failed"
    ]
  },
  "cloexecFallbackFails": {
    "code": 78,
    "events": [
      "refused:descriptor_sanitize_failed"
    ]
  },
  "cloexecFallbackWorks": {
    "code": 0,
    "events": [
      "ready"
    ]
  },
  "silentLauncher": {
    "readyEvent": false,
    "allGone": true
  }
}

== malformed daemon responses (supervisor client)
{
  "ok-content-length": "ok:OK",
  "ok-chunked": "ok:OK",
  "ok-close-delimited": "ok:hi",
  "cl-nope": "rejected",
  "cl-negative": "rejected",
  "cl-exponent": "rejected",
  "cl-hex-prefix": "rejected",
  "cl-space-inside": "rejected",
  "cl-huge": "rejected",
  "cl-over-bound": "rejected",
  "cl-conflicting": "rejected",
  "cl-and-chunked": "rejected",
  "te-unsupported": "rejected",
  "chunk-nonhex": "rejected",
  "chunk-empty-size": "rejected",
  "chunk-trailing-junk": "rejected",
  "chunk-negative": "rejected",
  "chunk-huge": "rejected",
  "chunk-over-bound": "rejected",
  "chunk-missing-crlf": "rejected",
  "chunk-line-unterminated": "rejected",
  "header-no-colon": "rejected",
  "header-empty-name": "rejected",
  "status-garbage": "rejected"
}
  previous parser, cl-nope: hung_killed_externally

== ablations
  ablate netns: refused ({"code":"bridge_unavailable","detail":"listen tcp4 127.0.0.1:35833: bind: address already in use","event":"refused"})
{
  "netns": {
    "refused": {
      "code": "bridge_unavailable",
      "detail": "listen tcp4 127.0.0.1:35833: bind: address already in use",
      "event": "refused"
    }
  },
  "landlock-net": {
    "failingRows": [
      "bind_other_port",
      "bind_ephemeral",
      "bind_wildcard_forbidden_port",
      "child.bind_other_port",
      "child.bind_ephemeral",
      "child.bind_wildcard_forbidden_port"
    ]
  },
  "landlock-unix": {
    "failingRows": []
  },
  "landlock-scope": {
    "failingRows": []
  },
  "seccomp": {
    "failingRows": [
      "seccomp_mode",
      "udp_loopback",
      "udp_bind",
      "dns_lookup",
      "go.socket_inet6",
      "go.socket_inet_dgram",
      "go.socket_unix",
      "go.socket_unix_dgram",
      "go.socket_netlink_generic",
      "go.socket_vsock",
      "go.socketpair_unix_dgram",
      "go.socketpair_unix_seqpacket",
      "go.pair_dgram_connect_host_path",
      "go.pair_dgram_sendto_host_path",
      "go.ptrace_attach_launcher",
      "go.ptrace_attach_stage0",
      "go.process_vm_readv_launcher",
      "go.io_uring_setup",
      "go.unshare_newuser",
      "go.clone3",
      "go.clone_newuser_exec",
      "child.seccomp_mode",
      "child.udp_loopback",
      "child.udp_bind",
      "child.dns_lookup"
    ]
  },
  "caps": {
    "failingRows": [
      "caps",
      "child.caps"
    ]
  },
  "dumpable": {
    "failingRows": []
  },
  "pidns": {
    "failingRows": [],
    "escapersSurvivingGroupKill": 4
  }
}

== teardown and leaks
{"nsBefore":1,"nsAfter":1,"strayLaunchers":0}

RESULT: PASS (0 failures) on bun 1.3.14, mode full
```

### A.2 Other runtimes and an older Landlock ABI

Node 26.7.0 (`--mode quick`), selected lines:

```
host: {"kernel":"7.1.9-arch1-2","runtime":"node v26.7.0","check":{"landlockAbi":9,"layers":["netns","pidns","ipv6-off","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"],"ok":true,"stage0Layers":["nnp","launcher-undumpable","launcher-landlock","launcher-seccomp"]}}
[control] unexpected rows: 0; datagrams the probe landed on the host decoy: 1
  fetch adapter over the authenticated bridge: {"healthz":{"status":200,"body":"ns"},"postEcho":1008,"notFound":404,"abort":"aborted"}
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] unexpected rows: 0
RESULT: PASS (0 failures) on node v26.7.0, mode quick
```

Emulated Landlock ABI 4 (`--abi 4`, Bun, `--mode quick`; the kernel is ABI 9,
the launcher is told to behave as ABI 4, so the Unix-socket and scope layers
are not applied). Selected lines:

```
host: {"kernel":"7.1.9-arch1-2","runtime":"bun 1.3.14","check":{"landlockAbi":4,"layers":["netns","pidns","ipv6-off","caps","nnp","launcher-undumpable","launcher-seccomp","nnp","landlock-net","seccomp"],"ok":true,"stage0Layers":["nnp","launcher-undumpable","launcher-seccomp"]}}
[control] unexpected rows: 0; datagrams the probe landed on the host decoy: 1
[confined] ready event: {"apiToken":"(redacted)","bridgesExpose":["api"],"bridgesReach":["45561"],"daemonPid":93616,"daemonStart":"1347297","event":"ready","landlockAbi":4,"layers":["netns","pidns","ipv6-off","caps","nnp","launcher-undumpable","launcher-seccomp","nnp","landlock-net","seccomp"],"stage0Layers":["nnp","launcher-undumpable","launcher-seccomp"],"stage0Pid":93599,"stage0Start":"1347297","stage1Pid":93606,"stage1Start":"1347297"}
  unix_host_path                 outside=connected            parent=failed_fast          child=failed_fast
  unix_host_abstract             outside=connected            parent=failed_fast          child=failed_fast
  bind_other_port                outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_wildcard_forbidden_port   outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_wildcard_permitted_port   outside=denied:EADDRINUSE    parent=bound                child=bound
  socketpair_unix_stream               outside=ok                 confined=ok
  socketpair_unix_dgram                outside=ok                 confined=EPERM
  socketpair_unix_seqpacket            outside=ok                 confined=EPERM
  pair_stream_connect_host_path        outside=EISCONN            confined=EISCONN
  pair_stream_sendto_host_path         outside=EISCONN            confined=EISCONN
  pair_stream_connect_after_shutdown   outside=EISCONN            confined=EISCONN
  pair_dgram_connect_host_path         outside=ok                 confined=no_socket
  pair_dgram_sendto_host_path          outside=ok                 confined=no_socket
  listen_unbound                       outside=listening:55107    confined=listening:57291
  signal_launcher                      outside=ok                 confined=ESRCH
  signal_stage0                        outside=ok                 confined=ESRCH
  signal_ns_init_sigkill               outside=EPERM              confined=ok
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] unexpected rows: 0
{"bind_ipv6":"denied","bind_other_port":"denied","connect_other_port":"failed_fast","connect_remote_testnet":"failed_fast","dns_lookup":"failed","ipv6_loopback":"failed_fast","tor_bridge_echo":"TOR-HOST:probe","udp_dial":"failed_fast"}
RESULT: PASS (0 failures) on bun 1.3.14, emulated Landlock ABI 4, mode quick
```

At ABI 4 the host-path Unix and datagram-pair rows are denied by seccomp
alone (`no_socket` for datagram pairs, `EISCONN` for stream pairs), and the
signal rows are `ESRCH` because the PID namespace removes the launcher from
view, not because of a Landlock scope. `signal_ns_init_sigkill` is `ok`
at ABI 4 because the kernel silently drops a SIGKILL sent to its own
namespace's init, and `ns_init_alive_after` is `yes`: the init survived.

### A.3 What the adversarial rows are shown able to detect

The harness would fail on each of these, and the run above shows it
catching them (ablations) or controls behaving the opposite way:

- Namespace off: the launcher cannot bind the Tor-side listener (the host
  listener already owns the port) and refuses (`bridge_unavailable`).
- Landlock net off: the explicit bind rows (other port, port 0, wildcard on a
  forbidden port) fail.
- Seccomp off: UDP, DNS lookup, IPv6, datagram sockets, `AF_UNIX`, vsock,
  `io_uring`, `unshare`, `clone3`, namespace clones, `process_vm_readv`,
  datagram and seqpacket `socketpair`, and the datagram pair rows fail. With
  seccomp off at ABI 9 the datagram pair is created but its `connect` to the
  host datagram decoy is refused by Landlock (`EACCES`), which is the
  independent second layer.
- Capabilities off: the capability rows fail.
- Landlock Unix off, Landlock scope off and non-dumpable off: no row fails,
  because seccomp (`AF_UNIX`), the PID namespace (host pids unaddressable) and
  Yama cover them on this host; the matrix asserts exactly that. They are kept
  as independent layers for older kernels and for hosts with Yama off.
- PID namespace off: the escapers (`setsid`, `setpgid`, double fork) survive a
  group kill (4 survivors), which is what the revision-1 design allowed.
- Seccomp off, adversarial init (`init-escape-without-seccomp`): the stand-in
  init clears its parent-death signal (`clear: ok`), leaves the group, and
  survives the death of stage0 (`allGone: false`); with the filter on the
  same init gets `EPERM` for both softening and clearing and nothing survives.
- Previous HTTP parser (`--old-fetch`, the revision-2 `unix-fetch.cjs`) on the
  `cl-nope` case: `hung_killed_externally`. The current parser rejects all 21
  malformed cases in bounded time.

### A.4 Cleanup and leftovers

The final lines of A.1 report, for the full run: host network namespaces
before and after (`nsBefore`/`nsAfter` count distinct network namespaces
seen from the harness), and zero stray launcher processes. Every session's
cleanup first kills the recorded process group as the supervisor does and
asserts nothing is left; only then does it sweep up, and a sweep that finds
anything is a failure. After the run the scratch directory, the temporary
directories and all test processes were removed from the laptop.

### A.5 The real daemon binary (revision-1 launcher)

The real `zkapi-clientd` (built from the fork checkout with a prototype
version suffix; the fork tree was clean afterwards) under the revision-1
launcher on the laptop. This was not repeated with the revised launcher.

```
--- unconfined version:
zkapi-clientd 0.1.6-olympus2-prototype
--- confined version:
zkapi-confine: {"bridgesExpose":null,"bridgesReach":null,"daemonPid":51700,"event":"ready","landlockAbi":9,"launcherPid":51691,"layers":["netns","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"]}
zkapi-clientd 0.1.6-olympus2-prototype
exit=0
--- confined serve --help (flags present):
  --relay-url URL                   Wisp relay or loopback SOCKS5 proxy (socks5://127.0.0.1:PORT)
  --companion-proxy-listen IP:PORT  fixed loopback address for the companion CONNECT proxy
  --wallet-api-listen IP:PORT       fixed loopback address for the managed companion API
  --require-managed-companion       refuse to start when external_companion is configured
--- confined serve with empty config dir:
zkapi-clientd: configuration missing; run zkapi-clientd config first. [...]
--- confined, status of a long-lived child:
Threads:	1
CapEff:	0000000000000000
NoNewPrivs:	1
Seccomp:	2
Seccomp_filters:	2
```

Reaching a funded wallet, the managed companion and Tor was out of scope.

### A.6 Refusal on the Ubuntu 24.04 host, and the alternative launchers

Read-only probe on a stock Ubuntu 24.04.4 LTS server, kernel
6.8.0-139-generic, LSMs `lockdown, capability, landlock, yama, apparmor`,
`kernel.apparmor_restrict_unprivileged_userns = 1`,
`kernel.unprivileged_userns_clone = 1`, `user.max_user_namespaces = 115288`,
AppArmor parser 4.0.1, an ordinary user. Nothing was written to the host, no
sudo, no setting changed. The probe is a stock `python3` script piped through
SSH that does exactly what the launcher's stage0 and stage1 do (new user and
network namespace, `setgroups deny`, identity uid and gid map, loopback up).
The script is `tools/zkapi-confine-prototype/test/refusal_probe.py`.

```
=== Ubuntu 24.04 host (restriction on):
6.8.0-139-generic
{
  "host_label_before": "unconfined",
  "restrict_sysctl": "1",
  "unshare_newuser_newnet": "ok",
  "label_in_namespace": "unprivileged_userns (enforce)",
  "cap_eff_in_namespace": "000001ffffffffff",
  "write_setgroups": "Permission denied",
  "write_uid_map": "ok",
  "write_gid_map": "ok",
  "loopback_up": "Operation not permitted",
  "verdict": "REFUSE: namespace_unavailable"
}
=== Omarchy laptop for contrast:
{
  "host_label_before": "n/a",
  "restrict_sysctl": "unreadable",
  "unshare_newuser_newnet": "ok",
  "label_in_namespace": "n/a",
  "cap_eff_in_namespace": "000001ffffffffff",
  "write_setgroups": "ok",
  "write_uid_map": "ok",
  "write_gid_map": "ok",
  "loopback_up": "ok",
  "verdict": "namespace usable"
}
```

Command-line tools on the same Ubuntu host:

```
--- unshare --user --net true:                      exit=0   (creates the namespace)
--- unshare -Urn true:                              exit=1
--- unshare --user --net --map-current-user true:
unshare: write failed /proc/self/uid_map: Operation not permitted
```

Inside `unshare --user --net sh -c ...`:

```
CapInh: 0000000000000000   CapPrm: 0000000000000000   CapEff: 0000000000000000
CapBnd: 000001ffffffffff   CapAmb: 0000000000000000
ip link set lo up  ->  RTNETLINK answers: Operation not permitted
/proc/self/attr/current: unprivileged_userns (enforce)
```

The namespace exists but the process has no capabilities in it, so the
launcher cannot bring loopback up, cannot map ids, and cannot do anything
useful: refused with `namespace_unavailable`. `/etc/apparmor.d/unprivileged_userns`
is the stock profile that does this (`audit deny capability`). The shape of
the exception profile in section 8 follows `/etc/apparmor.d/lxc-unshare`
(`flags=(unconfined)`, `userns,`, `include if exists <local/...>`), which
ships on the same host.

Other launchers on the laptop (A.1 host):

```
--- util-linux unshare --user --map-current-user --net:
1000
CapEff: 0000000000000000
RTNETLINK answers: Operation not permitted
--- util-linux unshare --user --map-root-user --net:
0
lo UNKNOWN 127.0.0.1/8 ::1/128
NoNewPrivs: 0   Seccomp: 0   Seccomp_filters: 0
--- bwrap 0.11.2 --unshare-user --unshare-net:
1000
lo UNKNOWN 127.0.0.1/8 ::1/128
NoNewPrivs: 1   Seccomp: 0
CapEff: 0000000000000000
```

Neither tool installs a seccomp filter, restricts ports, closes descriptors
or provides the session bridges. `bwrap` is the only one that keeps the
identity map and brings loopback up, which is why it is the closest
alternative and why we still reject it (section 4.2).

