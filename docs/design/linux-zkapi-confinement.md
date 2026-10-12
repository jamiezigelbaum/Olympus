# Linux confinement for the zkAPI private lane (workstream W4)

Status: design and feasibility prototype, 2026-10-12. Nothing here ships. No
production code path changes with this document; the prototype lives in
`tools/zkapi-confine-prototype/` and is not wired into the engine. A later
build step implements the design after an independent review
(`docs/ENGINEERING_PROCESS.md`).

Plan of record: `docs/design/linux-parity.md`, workstream W4. Owner decision
of 2026-10-12: on a host that cannot create the namespace the lane is
**refused**, with a one-time administrator step offered. There is no weaker
mode. Omarchy is the first target.

Facts below are checked against `f542f660` and against runs on real hardware
(appendix). Where a claim is not proven by a run it says so under
"Unproven".

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The Linux confinement is a **user plus network namespace holding only loopback**, with two session bridges over Unix sockets, hardened by Landlock, seccomp, `no_new_privs`, dropped capabilities and closed inherited descriptors. | The namespace gives the boundary by construction: there is no route, no resolver, no other loopback listener, and no host Unix socket path to find. The other layers remove ways around it and give a second, independent reason for each denial. |
| D2 | The launcher is a **small static Go program, `zkapi-confine`, built in the zkapi fork and shipped in the same hash-pinned release bundle as `zkapi-clientd`** (`bin/zkapi-confine`). Standard library only. | One pinned artifact, one pin to review, no new system dependency, the toolchain already pinned for the fork, `linux/amd64` and `linux/arm64` from the same build. See 4.2 for the alternatives and why each lost. |
| D3 | The Linux confinement reports the existing level `loopback_filtered`, only after a per-session self-test that runs the real launcher. A launcher that cannot be created, or a self-test that fails, **refuses the session**. Linux never runs at level `none`. | Same statement, same custody flags, same receipt as the Mac. The owner decision: no weaker mode. |
| D4 | Landlock ABI 4 or higher is required (Linux 6.7). Newer ABIs add layers, never change what is claimed. Below 4 the lane is refused. | Open question Q1: the namespace and seccomp alone pass every row except the bind-restriction rows (4.7, ablation table); requiring ABI 4 keeps the design target and costs Debian 12 and Ubuntu 22.04 GA kernels. |
| D5 | The daemon's API is reached over a **Unix socket** the namespace-side bridge binds in the session's private directory; the supervisor talks to it with a small `fetch` adapter. No TCP listener for the daemon API exists on the host. | Removes a host-wide loopback listener, makes the endpoint private by directory ownership, and keeps `/proc/net/tcp` out of the identity check on the host. |
| D6 | Tor stays an unconfined host process, as on the Mac. The namespace's Tor port is a bridge to a **supervisor-owned relay** that forwards to the one real Tor SOCKS port. | Parity with the Mac profile (Tor is outside the sandbox there too) and the smallest launcher: it never needs host network access. |
| D7 | Ubuntu 23.10+ with `apparmor_restrict_unprivileged_userns=1`: refuse, and offer one administrator step that installs a root-owned copy of the launcher with a narrow AppArmor profile (section 8). We do not recommend turning the sysctl off. | A path-scoped exception for one hash-verified binary does not weaken the rest of the machine. |

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
| Daemon and every descendant confined | Profile inherited across fork and exec | Namespace, Landlock domain, seccomp filter and `no_new_privs` all inherited across fork and exec; proven for an exec'd child |
| Only the session's loopback ports reachable | Four `tcp4 localhost` outbound rules | Namespace has only loopback; only the two bridged ports lead out; Landlock TCP connect rules name the four ports |
| Other loopback ports | Denied by rule | Nothing else listens in the namespace; the host's listeners do not exist there; Landlock also denies |
| Bind restrictions | Bind only on the three non-Tor ports | Landlock TCP bind rules on the same three ports; bind on any other port, port 0, or the Tor port fails |
| Remote addresses | Denied | No route and no interface: connect fails at once (`ENETUNREACH`) |
| IPv6 and IPv4-mapped IPv6 | Denied by `tcp4` rules | IPv6 disabled in the namespace; `AF_INET6` sockets refused by seccomp; mapped addresses need `AF_INET6` |
| UDP, including loopback UDP | Denied | `AF_INET` datagram and raw sockets refused by seccomp |
| DNS | Resolver socket and UDP denied | UDP and Unix sockets refused; no interface to reach a resolver; lookup fails fast |
| Host Unix sockets (path) | Denied | Landlock `RESOLVE_UNIX` where the kernel has it (ABI 9); seccomp refuses `AF_UNIX` sockets on every kernel |
| Host abstract Unix sockets | Denied | Abstract sockets are per network namespace; also refused by seccomp |
| Descriptors inherited from the supervisor | Not addressed | All descriptors above stderr are closed on exec |
| Capabilities | Not addressed | All five sets empty in the daemon; bounding set emptied |
| New namespaces, ptrace, `io_uring`, mounts, bpf, keyctl | Not addressed | Refused by seccomp |
| Launcher protected from the daemon | n/a | Non-dumpable, own seccomp filter, no capabilities, Landlock signal scope where available |
| Per-session self-test, refusal on failure | Yes | Yes, with real listeners and the real launcher; plus a `check` before the session for the doctor |
| File reads and writes | Unrestricted (`allow default`) | Unrestricted (the same, deliberately: this lane confines the network) |
| Trust root | Deprecated but shipped `sandbox-exec` | Kernel namespaces, Landlock and seccomp (stable interfaces), one launcher we build |
| Where it cannot run | No `sandbox-exec` | Namespace creation refused, Landlock below ABI 4, seccomp absent, launcher missing or unhashed: **refuse** |

Inherent to both: the daemon can ask Tor, through the SOCKS port it is
allowed to use, to open connections to arbitrary destinations. That is the
purpose of the lane; the confinement bounds everything *except* that
channel. Reads of host files are unchanged on both platforms.

## 4. Design

### 4.1 Process tree and layers

```
watchdog (existing, leads the process group)
 └─ stage0   host namespace. Marks inherited fds close-on-exec, asks for
    │        SIGKILL if the watchdog dies, clones stage1 into a new user+net
    │        namespace, then waits and relays the exit status. Hardens
    │        itself: non-dumpable, no_new_privs, seccomp that refuses every
    │        socket() (it needs none).
    └─ stage1   new user+net namespace, same uid and gid (identity map, no
       │        root mapping, so file ownership is unchanged).
       │        1. brings loopback up and checks it is the only interface
       │        2. turns IPv6 off in the namespace
       │        3. binds every bridge listener (a bind failure refuses)
       │        4. empties every capability set, then hardens itself:
       │           no_new_privs, non-dumpable, Landlock (ABI 8+, all threads),
       │           seccomp (all threads)
       │        5. starts stage2 and serves the bridges until it exits
       └─ stage2   same namespace, one thread:
                   no_new_privs, Landlock (ABI 4+), seccomp, fds closed,
                   report to stage1 over a private pipe, then exec the daemon
```

The daemon, the companion it starts and Tor-facing helpers are descendants
of stage2's exec and inherit everything. Stage1 and stage0 stay alive for
the session and are in the same process group as the watchdog's child, so
the existing group kill reaches them; their parent-death signals make the
tree die with any one of them (proven, appendix A.4).

Layers, each with an independent reason (the ablation table in A.3 shows
which rows each one carries):

1. **Namespaces** (`CLONE_NEWUSER | CLONE_NEWNET`). Stage0 creates them with
   the clone call, not `unshare`, because a multithreaded runtime cannot
   `unshare(CLONE_NEWUSER)` in place. Ambient `CAP_NET_ADMIN` and
   `CAP_SETPCAP` are given to stage1 only, to bring loopback up and empty the
   bounding set; they are gone before any untrusted code runs.
2. **Capabilities**: bounding, ambient, inheritable, permitted and effective
   sets emptied on every thread; stage2 verifies from `/proc/self/status`
   that all five read zero and refuses otherwise.
3. **`no_new_privs`** on every stage.
4. **Landlock**, with the ABI queried at runtime (`landlock_create_ruleset`
   with the version flag):
   - ABI >= 4: handled rights `BIND_TCP | CONNECT_TCP`; rules for exactly the
     session's ports (connect: Tor, daemon, companion proxy, wallet API; bind:
     daemon, companion proxy, wallet API).
   - ABI >= 6: scopes for abstract Unix sockets and signals, so the daemon
     cannot signal the launcher or the watchdog.
   - ABI >= 9: handled right `RESOLVE_UNIX` with no rules for the daemon,
     which denies connecting to any path Unix socket. Stage1 alone keeps a
     rule for the session directory.
   - ABI >= 8: stage1 uses the all-threads flag so its Go runtime threads are
     covered; below 8 stage1 relies on the other layers (non-dumpable, seccomp
     without `ptrace`).
   - ABI < 4 or no Landlock: **refuse** (`landlock_unavailable`).
5. **seccomp**, an architecture-checked deny list with argument checks
   (`x86_64` and `arm64` tables, cross-checked against the Go `x/sys` syscall
   tables, a mismatched architecture kills the process; the x32 ABI is
   refused). Not an allow list: Go, Bun, Node and Rust runtimes differ, and an
   allow list's false refusals would be the common failure. The network
   boundary does not rest on it; it removes the ways around it.
   - `socket()` allows only `AF_INET`, type stream, protocol 0 or TCP; plus
     read-only route-table netlink (`getifaddrs` in Go, Node and Bun needs
     it). Everything else is refused with `EPERM`: `AF_INET6`, UDP, raw,
     packet, vsock, other netlink families, and `AF_UNIX`.
   - `socketpair()` allows only `AF_UNIX` (anonymous; cannot name a path).
   - `unshare`, `setns`, `clone` with any `CLONE_NEW*` flag, `mount`
     family, `pivot_root`, `chroot`, `ptrace`, `process_vm_*`, `pidfd_getfd`,
     `kcmp`, `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`
     family, module loading, `kexec`, `reboot`, `swapon/off`, `acct`:
     `EPERM`. `clone3` returns `ENOSYS`: `clone3` flags live in memory that a
     filter cannot inspect, and libc and Go fall back to `clone`.
6. **Inherited descriptors**: stage0 and each later stage mark every
   descriptor above stderr close-on-exec (`close_range` with the cloexec
   flag, `/proc/self/fd` fallback); stage2 reports on a pipe that closes at
   exec. The daemon starts with stdin, stdout and stderr only.
7. **Events on a private pipe**: with `--status-fd 3` the launcher writes its
   JSON events to a descriptor the daemon never has. The daemon's stdout and
   stderr stay the daemon's. (Without it events share stdout and a daemon
   could print a forged line; the supervisor treats the pid in an event as
   untrusted and checks it, 4.5.)

Stage-by-stage `no_new_privs`, non-dumpable and Landlock/seccomp on the
launcher itself exist because stage1 holds what the daemon is denied (path
Unix sockets): a daemon that took over stage1 would take the host's Unix
sockets with it. The daemon is the same uid in the same user namespace, so
it is denied `ptrace`, `process_vm_*` and `pidfd_getfd` by seccomp, and
`/proc/<stage1>/mem` and the fd directory by the non-dumpable flag (and Yama
where the host has it).

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
`ZKAPI_REQUIRED` for the two Linux platforms and a new bundle hash. At every
session the supervisor resolves the launcher through the existing
`managedToolExecutable` path (pinned version folder, real path inside it) and
runs `zkapi-confine --version`; where an administrator-installed system copy
exists (section 8) it must be root-owned, not writable by others, and match
the pinned SHA-256.

### 4.3 Bridges: ownership, identity, failure

Two bridges, both created by the launcher before untrusted code runs, both
with one fixed destination:

| Bridge | Direction | In the namespace | On the host | Dials |
|---|---|---|---|---|
| `api` (expose) | host to namespace | Unix socket `<session dir>/api.sock`, mode 0600, bound by stage1 | the supervisor connects to the path | `127.0.0.1:<daemon port>` inside the namespace |
| `tor` (reach) | namespace to host | `127.0.0.1:<tor port>`, bound by stage1 | a Unix socket `<session dir>/tor.sock` the **supervisor** listens on | the supervisor relays to the one real Tor SOCKS port `127.0.0.1:<settings.torSocksPort>` |

- **Ownership.** The session directory is created by the supervisor with
  `mkdtemp`, mode 0700, owned by the user; the launcher refuses a directory
  that is not a real directory, mode 0700, owned by the caller. `tor.sock` is
  created by the supervisor before the launcher starts; `api.sock` is created
  by stage1. Both vanish with the directory, which the existing session
  cleanup removes.
- **Endpoint identity.** There is no well-known port to squat: both
  endpoints are paths in a directory only this user can enter and the
  supervisor made a moment ago. The supervisor additionally checks, before
  every key-bearing step: `api.sock` is a socket owned by the user; it
  appears as a listening socket in `/proc/<launcher pid>/net/unix` (the host
  table does not list it; Unix sockets are per network namespace); and the
  daemon fingerprint checks that exist today (`/healthz`, 401 on an
  unauthenticated request, `/admin/status`) still pass. A same-uid process
  that can enter the session directory or the namespace can already read the
  supervisor's memory; the defence is against stale and unrelated processes,
  as today.
- **Fail fast.** A bridge connection to a dead destination is closed at
  once (proven: Tor relay removed, the connection through the bridge closes
  in under a second; daemon killed, `api.sock` is gone and connecting gives
  `ENOENT`). Each bridge allows 64 concurrent connections and closes extras.
  A bridge never retries or buffers across connections, so a failed bridge
  cannot be mistaken for a slow daemon.
- **Crash cleanup.** There is nothing persistent outside the session
  directory: no named namespace, no mount, no iptables state. A network
  namespace dies with its last process (proven: the host's count of distinct
  network namespaces is identical before and after the full run, including
  kill -9 of each stage). Stage0 dies with the watchdog (parent-death
  signal); stage1 dies with stage0; the daemon dies with stage1. The
  existing durable `running.groups` record still names the group, so a
  crashed supervisor's successor kills the group and removes the directory
  exactly as today.
- **Bridge failure is a session failure.** Launcher exit is the watchdog
  child's exit, already handled (`session_process_exited`). A broken Tor
  relay surfaces as the daemon's existing transport errors.

### 4.4 Integration with the transport (what changes in code, later)

The shape is the existing `ZkapiConfinement` seam, extended; the Mac
implementation and every Mac test stay as they are.

- `ZkapiConfinement` gains an optional **session** step:
  `prepare(workDir, ports) -> { wrap(argv), fetch, inspect(port), close() }`.
  The Mac returns the current behaviour (no `fetch`, no `inspect`
  override). The Linux session starts the Tor relay on `tor.sock`, builds the
  launcher argv (`run --dir <workDir> --status-fd 3 --expose api=<daemon port>
  --reach <tor port>=tor --connect-port ... --bind-port ... -- <daemon argv>`),
  provides a `fetch` for the daemon origin that dials `api.sock`, and
  reads listener ownership from the namespace (4.5).
- **Level and refusal.** `defaultZkapiConfinement()` on Linux returns
  `loopback_filtered` when `zkapi-confine check` succeeds, and otherwise an
  explicit unavailable state (`code`, `remedy`), not level `none`. The session
  refuses with a new `confinement_unavailable` code before Tor starts; the
  existing `confinement_self_test_failed` covers a failed per-session test.
  `check` runs the real launcher around a no-op and takes about 10 ms warm
  (appendix A.5), so the doctor can run it synchronously.
- **Ports and flags.** Linux is `loopback_filtered`, so `filtered` is true and
  the companion and wallet ports and the four custody flags are passed
  exactly as on the Mac (`:2447`, `:2482`). There is no other Linux level
  (no weaker mode), so no other flag set exists. Inside the namespace a port
  number cannot collide with a host listener, but we keep the host-probed
  `companionPorts()` so the Mac and Linux paths share the code and the
  receipt; `daemon_already_running` stays a host check (a second daemon on
  the same wallet is still worth refusing).
- **Fetch adapter.** `fetchImpl` is already injectable. The Linux session
  supplies a `fetch` over `node:http` with `socketPath` (the prototype's
  `unix-fetch.cjs`, run under Bun 1.3.14 and Node 26: status, headers,
  request and response bodies, streaming, abort, redirect refusal). `origin`
  stays `http://127.0.0.1:<daemon port>`: the adapter ignores host and port,
  so `facts.listen` still has to equal the configured host (`:2541`) and the
  daemon's own report is unchanged. Bun's `http.request` `signal` option does
  not settle on Unix sockets; the adapter handles abort itself.
- **Doctor/readiness** (`:1860`): a Linux line, `network confinement: ready
  (user and network namespace, Landlock ABI 9, seccomp)` or `unavailable:
  <reason>; <one remedy>`, from `check`. The confinement statement for
  `loopback_filtered` is unchanged.
- **Receipts**: `confinementSelfTest` as today, plus a non-secret
  `confinementBackend: { kind: 'linux_netns', landlockAbi, layers }`.

### 4.5 Listener inspection and the dispatch check under a namespace

The host's `/proc/net/tcp*` does not contain the namespace's listeners (A.2:
`hostProcNetTcpListsApiPort: false`), and a daemon whose API port never
appears there would fail today's `inspectLoopbackListener` with `not_visible`.
Changes:

1. **Which table.** Read `/proc/<pid>/net/tcp*` for a pid *inside* the
   namespace (the daemon pid from the launcher event) instead of the host's
   table. The supervisor can read it (proven), and it shows the namespace's
   own listeners.
2. **Who holds the socket.** Match inodes against `/proc/<pid>/fd` of the
   processes **in the daemon's process group** (not all of `/proc`), as
   today. The daemon, the companion and the wallet API listeners are held by
   the daemon tree and are readable (proven: owner reported with the daemon's
   process group). The stage1 listener (the Tor port) and `api.sock` are held
   by the launcher, which is deliberately non-dumpable, so its descriptors
   are unreadable to everyone but the kernel; those two are accepted by
   construction (4.3) instead of by descriptor.
3. **The namespace itself is checked**, replacing "this port, this group" with
   three facts: the daemon pid is in the daemon's process group; its
   `/proc/<pid>/ns/net` differs from the supervisor's and equals the
   launcher's; and the namespace lists exactly the expected listeners
   (daemon, companion proxy, wallet API, the Tor bridge port) and nothing
   else. A forged pid in a launcher event fails the namespace test, which is
   why the private event pipe is preferred but not relied on alone.
4. **Dispatch.** `owned()`/`guard()` keep their cadence (before the
   unauthenticated probe, before `/admin/status`, throughout policy warm-up,
   and at the last moment before the key). The Tor entry is unchanged (host
   Tor, host table, Tor's group). The process-group comparison for the three
   daemon-tree ports is unchanged; only the table read moved.

### 4.6 Self-test (Linux)

`confinement.selfTest(workDir, env, ports)` on Linux, per session, before Tor
starts. It uses the real launcher and the engine's own runtime (the probe is
JavaScript, as on the Mac), controlled listeners that the test owns, and an
unconfined control run of the same probe:

Host side (the supervisor's process): a TCP listener standing in for Tor on a
free host port, relayed from `tor.sock` exactly as the real relay will be;
squatter listeners on the session's own companion and wallet port numbers
(they must never be reached inside); a second loopback port; a `127.0.0.2`
listener; a listener on the machine's non-loopback address when it has one
(the remote-address stand-in) and a TEST-NET-1 connect always; a `::1`
listener; a Unix socket in the session directory and an abstract Unix socket
(host Unix socket stand-ins); two decoy descriptors (a connected Unix socket
and a connected TCP socket) deliberately left inheritable.

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
| Bind: other port, port 0, the Tor port, all interfaces | bound | refused |
| Inherited decoy descriptors | present | absent |
| Capabilities, `no_new_privs`, seccomp mode, own network and user namespaces, only loopback | no / 0 / 0 / same / many | zero / 1 / 2 / different / only `lo` |
| Raw syscalls (exec'd Go child): `AF_INET6`, UDP, raw, `AF_UNIX`, packet, vsock, other netlink; `ptrace` and `process_vm_readv` on the launcher; `io_uring_setup`; `unshare`; `clone3`; clone into a new namespace; `setns`; `mount`; write-open of the launcher's `/proc/<pid>/mem`; signalling the launcher and stage0 | allowed or unrelated | refused (`EPERM`, `EACCES`, or `ENOSYS` for `clone3`); signalling refused where Landlock has the scope |
| Bridge: Tor relay removed | n/a | connection through the bridge closes fast |
| Bridge: a 4 MiB request body echoed host to namespace and back | n/a | byte-identical |

Pass condition: every row, in the parent and in the child, and the control
shows the opposite on every row that is not allowed (so a probe that cannot
detect is caught, as on the Mac). Any mismatch, a launcher refusal, a missing
`ready` event, or a probe that fails to run refuses the session
(`confinement_self_test_failed`). The control run and the confined run happen
concurrently; the dominant cost is the 3 s TEST-NET control timeout the Mac
already pays.

The prototype's `check` command is a separate, cheaper question (can this
host build the confinement at all) for the doctor.

### 4.7 Failure and refusal behaviour

| Condition | Where detected | Result |
|---|---|---|
| Namespace creation refused (AppArmor restriction, `user.max_user_namespaces=0`, Debian's `kernel.unprivileged_userns_clone=0`, container runtime seccomp, nested confinement) | `check`, and the session's launcher | refuse: `namespace_unavailable`; Ubuntu/AppArmor adds the admin step (section 8); other hosts get the exact sysctl or "this environment does not allow it" |
| Namespace created but loopback cannot be brought up or the uid map cannot be written | launcher | same (`namespace_unavailable`, or `loopback_unavailable` in the detail) |
| Landlock ABI below 4, or Landlock disabled | `check`, launcher | refuse: `landlock_unavailable` with "needs Linux 6.7 or newer with Landlock enabled" |
| seccomp unavailable | launcher | refuse: `seccomp_unavailable` |
| Bridge cannot bind, capabilities not empty, restrictions not applied, launcher exits before `ready` | launcher | refuse; no daemon starts |
| Launcher binary missing, not the pinned hash, wrong architecture | supervisor | refuse: `confinement_unavailable` |
| Self-test row differs | supervisor | refuse: `confinement_self_test_failed` |
| Launcher or any stage dies during a session | watchdog/launcher | existing `session_process_exited`; the whole tree is gone |
| Tor relay or API bridge breaks during a session | connection closes fast | existing transport errors; nothing continues unconfined |

Nothing falls back to an unconfined daemon: the daemon is started only by
stage2, only after the restrictions are applied.

## 5. What this does not do (residuals)

- **File reads and writes are not restricted** (the Mac profile is the same).
  A compromised daemon can read the user's files; it cannot send them
  anywhere except through Tor's SOCKS port.
- **Tor's SOCKS port can open connections to anything on the Internet**, by
  design. The confinement bounds the daemon to that channel.
- **The host's `/proc` shows the daemon other same-user processes.** Same on
  the Mac.
- **ABI below 6**: the daemon can signal the launcher (it can end its own
  session; it cannot read or change it). ABI below 9: path Unix sockets are
  hidden by seccomp refusing `AF_UNIX`, not by Landlock; the matrix passes
  either way (A.3).
- **No Yama and a dumpable launcher** would let a same-uid process read the
  launcher's memory; the launcher is non-dumpable, so this is closed. The
  prototype could not turn Yama off to prove the non-dumpable layer alone
  (Unproven).
- **Kernel attack surface** is not zero: namespaces, netlink route sockets
  and the allowed syscalls remain reachable to the daemon. We removed the
  well-known unprivileged-kernel-bug surfaces (`io_uring`, `bpf`,
  `userfaultfd`, nested namespaces, `perf_event_open`, mounts).

## 6. Prototype

`tools/zkapi-confine-prototype/` (Go launcher, about 1,350 lines including the
probe, standard library only; `test/` holds the JavaScript probe, stand-in daemon, host
driver and a Go stand-in). It is labelled prototype in every header, has
ablation and older-ABI switches that the shipped launcher must not have, and
is not built by any repository script.

Build (through the remote-build lane; the Mac has no Linux toolchain use):

```
~/.local/bin/remote-build run --cwd tools/zkapi-confine-prototype \
  --image golang:1.25 --no-install --artifact tools/zkapi-confine-prototype/out -- \
  sh -c 'go vet ./... && mkdir -p out && for a in amd64 arm64; do \
  GOOS=linux GOARCH=$a CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o out/zkapi-confine-$a . ; done'
```

Run (on the Linux host, with any of Bun or Node):

```
bun test/matrix.mjs --launcher ./zkapi-confine [--mode quick|full] \
  [--gostandin ./gostandin] [--abi 4] --out result.json
```

`--abi N` makes the launcher behave as on a kernel with Landlock ABI N (to
exercise the older-kernel code paths on a newer kernel); `--mode full` adds
the one-layer-off ablations.

## 7. Results on real hardware

Omarchy 4.0.1 laptop, x86_64, kernel 7.1.9-arch, Landlock ABI 9, no AppArmor,
Yama on, unprivileged user namespaces allowed. Everything ran as the ordinary
user under one scratch directory; nothing was installed system-wide or
changed. Raw outputs are in appendix A. Summary:

- Confined matrix, parent and exec'd child, Bun 1.3.14: **0 violations**.
  Same under Node 26.7.0. Control run (same probe, no confinement): the
  opposite on every denied row (0 unexpected).
- Go stand-in (an `net/http` server and Go dialers): 0 violations. The real
  `zkapi-clientd` binary built from the fork starts, prints its version,
  shows its supervisor flags and reaches its configuration check under the
  confinement (A.5). The real companion and Tor were not run (Unproven).
- Emulated Landlock ABI 4 (the Ubuntu 24.04 shape; the real kernel has ABI
  9): 0 violations; `check` refuses at emulated ABI 3 and 0.
- Fault injection: Tor relay removed (closed fast); daemon killed (launcher
  exit 137, `api.sock` gone); stage0 killed -9 and stage1 killed -9 (whole
  tree gone); network-namespace count unchanged afterwards.
- Cost: launcher start to ready about 10 ms warm; API bridge round trip
  under 1 ms; 4 MiB through the bridge intact; whole confined session to
  first probe about 0.3 s.
- Refusal path on Ubuntu 24.04, kernel 6.8, restriction on (A.6): the
  namespace is created but unusable: the process is moved into the
  `unprivileged_userns` profile, the `setgroups` write is denied and
  bringing loopback up gets `EPERM`, so the launcher reports
  `namespace_unavailable`. The same refusal code is also shown on the
  laptop by running `check` from inside a confinement (nested namespace
  creation refused, A.3).

### Unproven

- **Ubuntu positive path.** Section 8's profile has not been installed and
  run on a restricted host (that needs an administrator and a change to the
  test host); it follows the shape of profiles Ubuntu ships. The launcher
  re-executes itself through `/proc/self/exe`, whose path-attachment under
  AppArmor needs confirming (fallback: re-exec the resolved path).
- **arm64 runtime.** The arm64 launcher cross-compiles and its syscall table
  is cross-checked, but it has not run on arm64 hardware.
- **Kernels between ABI 4 and 9 on real hardware**, and hosts with Yama off,
  SELinux enforcing, or inside containers.
- **The real companion and Tor** under the filter; the real daemon beyond
  startup (needs a funded wallet).
- **Throughput under sustained streaming** (only a 4 MiB body measured).

## 8. The Ubuntu administrator step

Offered by the doctor and in the refusal message when the host reports
`kernel.apparmor_restrict_unprivileged_userns = 1` (Ubuntu 23.10 and later).
Olympus prints this text and the exact commands; it never runs `sudo`.

> **One step needs an administrator.**
>
> To keep your private questions from leaving through any other route,
> Olympus runs its private-answer helper in an isolated network space.
> Ubuntu blocks that by default. This step lets exactly one program,
> a copy of Olympus's helper that only an administrator can change, create
> that space. Nothing else on the computer is affected.
>
> 
```
> sudo install -D -m 0755 -o root -g root \
>   "$HOME/.local/share/olympus/tools/zkapi-clientd/<version>/bin/zkapi-confine" \
>   /usr/local/libexec/olympus/zkapi-confine
> sudo tee /etc/apparmor.d/olympus-zkapi-confine >/dev/null <<'EOF'
> abi <abi/4.0>,
> include <tunables/global>
>
> profile olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine flags=(unconfined) {
>   userns,
>
>   # Site-specific additions and overrides. See local/README for details.
>   include if exists <local/olympus-zkapi-confine>
> }
> EOF
> sudo apparmor_parser -r /etc/apparmor.d/olympus-zkapi-confine
> 
```
>
> Then ask Olympus again. To undo it:
> `sudo apparmor_parser -R /etc/apparmor.d/olympus-zkapi-confine && sudo rm /etc/apparmor.d/olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine`

Notes: the profile shape (`flags=(unconfined)`, `userns,`, `include if exists
<local/...>`) is the one Ubuntu's own `lxc-unshare` profile uses (read-only
look at the test host's `/etc/apparmor.d`). `<version>` is filled in by
Olympus from the installed pin. The profile attaches to a root-owned copy,
not to the user-writable tools folder, so no user process can gain the
exception by replacing a file. After each Olympus upgrade that changes the
launcher, the doctor shows the one `sudo install` line again (the hash no
longer matches the pin); the profile does not change. We do not recommend the
system-wide alternative `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.

Other hosts: if namespace creation fails and the AppArmor sysctl is absent
or 0, the message names what was observed (`user.max_user_namespaces`,
`kernel.unprivileged_userns_clone`, or "this environment forbids nested
namespaces") and says the private lane is not available on this computer.

## 9. Implementation plan

Each step lands as its own change; the last needs the independent review.

1. **Fork: launcher.** Move the prototype into the zkapi fork as
   `zkapi-clientd/cmd/zkapi-confine`; remove the ablation and ABI switches;
   keep standard library only. Unit tests: argument parser, seccomp program
   builder (golden program per architecture, jump ranges), bridge pump and
   limits, `check` classification with an injected failing clone. Reproducible
   build in `olympus/build.sh` and CI for `linux/amd64` and `linux/arm64`; a CI
   job on `ubuntu-24.04` and on a native arm64 runner runs `check` and the
   matrix, with the AppArmor restriction on (expect refusal) and off.
   *Acceptance:* CI green; two builds identical; `go vet`/gofmt clean; matrix
   0 violations on both architectures.
2. **Pin and install.** Release bundle `clientd-v0.1.6-olympusN` including
   `bin/zkapi-confine`; `managed-tools.ts` pins, required file, platform
   rule; `managed-tools.test.ts` coverage. *Acceptance:* install on Omarchy
   and the Ubuntu host verifies the hash and refuses a tampered launcher; Mac
   install unchanged.
3. **Transport, behind the seam.** `ZkapiConfinement.prepare`, the Linux
   implementation, Tor relay, fetch adapter, namespace-aware inspection (4.5),
   new `confinement_unavailable` code, doctor line, receipt field, Linux
   self-test (4.6). Mac code paths untouched. *Acceptance:* existing Mac and
   fake-confinement tests pass unchanged; new unit tests with injected
   fakes cover every refusal row of 4.7; an integration test runs the real
   launcher with the stand-in daemon on a Linux CI runner and fails if a
   layer is removed (ablation inverted into assertions).
4. **Admin step and copy.** Doctor text and refusal message of section 8 with
   the exact remedy per observed cause; no `sudo` run by Olympus.
   *Acceptance:* string tests; the restricted Ubuntu host shows the refusal
   and the step; after the step, `check` passes.
5. **Real-route qualification (Omarchy, then Ubuntu with the step).** The real
   daemon, managed companion and Tor under the launcher: managed transport
   block matches, custody flags accepted, the session reaches `ready`, one
   private answer end to end. *Acceptance:* companion and Tor run under the
   filter without false refusals; receipt shows `loopback_filtered` with the
   backend detail.
6. **Matrix on every named environment** (plan): Omarchy; Ubuntu 24.04 with
   the restriction on and off; Linux arm64; Mac regression untouched.
   *Acceptance:* the full matrix and the refusal rows on each, raw output
   attached to the change.
7. **Independent review, then merge.** Scope: the launcher's syscall tables
   and Landlock handling, the refusal logic, the inspection change, the
   admin step.

## 10. Questions for the owner

1. **Landlock below ABI 4 (kernels before 6.7: Debian 12, Ubuntu 22.04 GA).**
   Refuse (recommended, matches "no weaker mode") or accept namespace plus
   seccomp alone? The prototype shows the namespace plus seccomp pass every
   row except the bind-restriction rows, so this is a policy call, not a
   technical limit.
2. **Administrator step form.** Root-owned copy of the launcher plus a path
   profile (recommended), printed for the user to run. Is printing the
   commands (never running `sudo`) acceptable, or should the doctor offer a
   `pkexec` helper?
3. **Where to prove the Ubuntu positive path.** It needs the profile installed
   by an administrator. May we do it on the Ubuntu 24.04 test host (one
   profile file and one root-owned binary, both removable), or do you want a
   throwaway VM?
4. **Hardware for arm64 acceptance** (an arm64 Linux machine or runner).
5. **A new fork release** (`clientd-v0.1.6-olympusN`) carrying the launcher,
   and the pin change in `managed-tools.ts`. Tor still has no Linux arm64
   bundle, so the private lane stays unavailable on arm64 until that changes,
   whatever the launcher does.
6. **Hosts we will not try to support**: containers that forbid nested
   namespaces, SELinux-enforcing hosts that deny the clone. They refuse with
   a plain message. Confirm that is the position.

## Appendix A. Raw evidence

Binary under test: `zkapi-confine` for `linux/amd64`, SHA-256
`0f8150676b8848fcb573af13eda2804936f8d6664548b7a0a24f9768683489ae`,
built through the remote-build lane with a Go 1.25 toolchain in an official container.

Bun 1.3.14 is the engine's own runtime and the default driver. Host: Omarchy
4.0.1, kernel 7.1.9-arch, x86_64, Landlock ABI 9, LSMs `capability, landlock,
lockdown, yama, bpf` (no AppArmor), `user.max_user_namespaces=63255`, Yama
`ptrace_scope=1`, ordinary unprivileged user, all work under one scratch
directory. Tools present on the host were bwrap 0.11.2, util-linux unshare,
setpriv, ip, python3, gcc, socat; Go was not installed (the binaries were built
through the remote-build lane and copied over).

### A.1 Full matrix, Bun 1.3.14, `--mode full` (verbatim, paths removed)

```
host: {"kernel":"7.1.9-arch1-2","runtime":"bun 1.3.14","landlockAbi":"{\"landlockAbi\":9,\"layers\":[\"netns\",\"ipv6-off\",\"caps\",\"nnp\",\"launcher-undumpable\",\"launcher-landlock\",\"launcher-seccomp\",\"nnp\",\"landlock-net\",\"landlock-unix\",\"landlock-scope\",\"seccomp\"],\"ok\":true}"}

[control: no confinement] expectation violations: 0

[confined] ready event: {"bridgesExpose":["api"],"bridgesReach":["35949"],"daemonPid":57045,"event":"ready","landlockAbi":9,"launcherPid":57035,"layers":["netns","ipv6-off","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"]}
[confined] self-test rows (parent | exec'd child) and outside control:
  inherited_decoy_fds      outside=2                    parent=0                    child=0
  caps                     outside=nonzero              parent=zero                 child=zero
  no_new_privs             outside=0                    parent=1                    child=1
  seccomp_mode             outside=0                    parent=2                    child=2
  net_ns_differs           outside=no                   parent=yes                  child=yes
  user_ns_differs          outside=no                   parent=yes                  child=yes
  interfaces               outside=lo,enp124s0u2        parent=lo                   child=lo
  tor_bridge_echo          outside=TOR-HOST:probe       parent=TOR-HOST:probe       child=TOR-HOST:probe
  companion_bind_connect   outside=denied:EADDRINUSE    parent=bound_connected_ns   child=bound_connected_ns
  wallet_bind_connect      outside=denied:EADDRINUSE    parent=bound_connected_ns   child=bound_connected_ns
  connect_other_port       outside=connected            parent=failed_fast          child=failed_fast
  connect_loopback_alias   outside=connected            parent=failed_fast          child=failed_fast
  connect_lan              outside=connected            parent=failed_fast          child=failed_fast
  connect_remote_testnet   outside=timeout              parent=failed_fast          child=failed_fast
  ipv6_loopback            outside=connected            parent=failed_fast          child=failed_fast
  ipv4_mapped              outside=connected            parent=failed_fast          child=failed_fast
  udp_remote               outside=sent                 parent=failed               child=failed
  udp_loopback             outside=sent                 parent=failed               child=failed
  udp_bind                 outside=bound                parent=failed               child=failed
  dns_stub_tcp             outside=connected            parent=failed_fast          child=failed_fast
  dns_lookup               outside=resolved             parent=failed_fast          child=failed_fast
  unix_host_path           outside=connected            parent=failed_fast          child=failed_fast
  unix_host_abstract       outside=connected            parent=failed_fast          child=failed_fast
  bind_other_port          outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_tor_port            outside=denied:EADDRINUSE    parent=denied:EACCES        child=denied:EACCES
  bind_ephemeral           outside=bound                parent=denied:EACCES        child=denied:EACCES
  bind_all_interfaces      outside=bound                parent=denied:EACCES        child=denied:EACCES
  -- exec'd Go child (raw syscalls), launcher protection --
  socket_inet_stream           outside=ok       confined=ok
  socket_inet6                 outside=ok       confined=EPERM
  socket_inet_dgram            outside=ok       confined=EPERM
  socket_inet_raw              outside=EPERM    confined=EPERM
  socket_unix                  outside=ok       confined=EPERM
  socket_unix_dgram            outside=ok       confined=EPERM
  socket_netlink_route         outside=ok       confined=ok
  socket_netlink_generic       outside=ok       confined=EPERM
  socket_packet                outside=EPERM    confined=EPERM
  socket_vsock                 outside=ok       confined=EPERM
  socketpair_unix              outside=ok       confined=ok
  ptrace_attach_launcher       outside=EPERM    confined=EPERM
  ptrace_attach_stage0         outside=EPERM    confined=EPERM
  process_vm_readv_launcher    outside=ok       confined=EPERM
  io_uring_setup               outside=EFAULT   confined=EPERM
  unshare_newuser              outside=EINVAL   confined=EPERM
  unshare_newnet               outside=EPERM    confined=EPERM
  clone3                       outside=EINVAL   confined=ENOSYS
  clone_newuser_exec           outside=ok       confined=error
  setns_net                    outside=EPERM    confined=EPERM
  mount_tmpfs                  outside=EPERM    confined=EPERM
  open_launcher_mem_rw         outside=EACCES   confined=EACCES
  open_stage0_mem_rw           outside=EACCES   confined=EACCES
  signal_launcher              outside=ok       confined=EPERM
  signal_stage0                outside=ok       confined=EPERM
  fetch adapter over the bridge: {"healthz":{"status":200,"body":"ns"},"postEcho":1008,"notFound":404,"abort":"aborted"}
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] expectation violations: 0
```

### A.2 Listener inspection under the namespace, timing

```
[inspection/ownership under the namespace]
{
  "processGroup": [
    "zkapi-confine",
    "exe",
    "bun"
  ],
  "hostProcNetTcpListsApiPort": false,
  "nsListeners": [
    41243,
    35949
  ],
  "listenerOwners": {
    "35949": "unreadable:EACCES",
    "41243": "bun(pgid 57028)"
  },
  "expected": {
    "api": 41243,
    "tor": 35949
  },
  "hostProcNetUnixListsApiSock": false,
  "launcherProcNetUnixListsApiSock": true,
  "apiSockOwnerUidIsOurs": true,
  "procOwnerUid": {
    "launcher": 1000,
    "daemon": 1000,
    "us": 1000
  },
  "apiSockMode": "700",
  "launcher": {
    "pid": 57035,
    "pgid": 57028,
    "NoNewPrivs": "1",
    "Seccomp": "2",
    "CapEff": "0000000000000000",
    "procFdReadableBySupervisor": "EACCES",
    "netTcpReadableBySupervisor": true
  },
  "daemon": {
    "pid": 57045,
    "pgid": 57028,
    "NoNewPrivs": "1",
    "Seccomp": "2",
    "CapEff": "0000000000000000",
    "procFdReadableBySupervisor": true,
    "netTcpReadableBySupervisor": true
  }
}

[timing] {"sessionUpToProbeMs":271,"apiBridgeRoundTripMs":0.86,"launcherStartToExitMs":[10,10,10,10,10]}
```

### A.3 Other runtimes, older Landlock ABI, ablations, nested refusal

Node 26.7.0 (`--mode quick`), header and result lines:

```
host: {"kernel":"7.1.9-arch1-2","runtime":"node v26.7.0","landlockAbi":"{\"landlockAbi\":9,\"layers\":[\"netns\",\"ipv6-off\",\"caps\",\"nnp\",\"launcher-undumpable\",\"launcher-landlock\",\"launcher-seccomp\",\"nnp\",\"landlock-net\",\"landlock-unix\",\"landlock-scope\",\"seccomp\"],\"ok\":true}"}
[control: no confinement] expectation violations: 0
[confined] ready event: {"bridgesExpose":["api"],"bridgesReach":["40175"],"daemonPid":57823,"event":"ready","landlockAbi":9,"launcherPid":57816,"layers":["netns","ipv6-off","caps","nnp","launcher-undumpable","launcher-landlock","launcher-seccomp","nnp","landlock-net","landlock-unix","landlock-scope","seccomp"]}
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] expectation violations: 0
  violations: 0
RESULT: confined matrix PASS (0 violations); control (unconfined) behaves as expected
```

Emulated Landlock ABI 4 (`--abi 4`, Bun, `--mode quick`):

```
host: {"kernel":"7.1.9-arch1-2","runtime":"bun 1.3.14","landlockAbi":"{\"landlockAbi\":4,\"layers\":[\"netns\",\"ipv6-off\",\"caps\",\"nnp\",\"launcher-undumpable\",\"launcher-seccomp\",\"nnp\",\"landlock-net\",\"seccomp\"],\"ok\":true}"}
[control: no confinement] expectation violations: 0
[confined] ready event: {"bridgesExpose":["api"],"bridgesReach":["34677"],"daemonPid":58301,"event":"ready","landlockAbi":4,"launcherPid":58292,"layers":["netns","ipv6-off","caps","nnp","launcher-undumpable","launcher-seccomp","nnp","landlock-net","seccomp"]}
  api bridge, 4 MiB POST echoed host->namespace->host: intact
[confined] expectation violations: 0
RESULT: confined matrix PASS (0 violations); control (unconfined) behaves as expected
```

Differences between the ABI 4 and ABI 9 runs (the kernel is ABI 9; the
launcher is told to behave as ABI 4, so the Unix-socket and scope layers are
not applied): the two signal rows (`signal_launcher`, `signal_stage0`) are not
asserted below ABI 6, because only the Landlock signal scope denies them (a
same-user process can otherwise signal the launcher; it can end its own
session but not read or change it). The host Unix-socket rows still pass,
refused by seccomp (`AF_UNIX`), and the bind rows still pass through the
Landlock TCP rules:

```
  unix_host_path           outside=connected            parent=failed_fast          child=failed_fast
  unix_host_abstract       outside=connected            parent=failed_fast          child=failed_fast
  bind_other_port          outside=bound                parent=denied:EACCES        child=denied:EACCES
  socket_unix                  outside=ok       confined=EPERM
  socket_unix_dgram            outside=ok       confined=EPERM
```

Ablation summary (from A.1): each layer is the only reason for some rows.
Namespace off: the launcher cannot even bind the Tor bridge (the host listener
already owns the port) and refuses. Landlock net off: the six bind rows fail.
Landlock scope off: the two signal rows fail. Seccomp off: UDP, DNS lookup,
IPv6 and datagram sockets, `AF_UNIX`, vsock, `io_uring`, `unshare`,
`clone3`, namespace clones and `process_vm_readv` rows fail. Capabilities off:
the capability rows fail. Landlock Unix off and non-dumpable off: no row
fails, because seccomp (`AF_UNIX`) and Yama cover them on this host; they are
kept as independent layers for older kernels and for hosts with Yama off.

Nested refusal: running `check` from inside a confinement (namespace creation
refused by the daemon filter) returns
`{"code":"namespace_unavailable","detail":"fork/exec /proc/self/exe: operation not permitted","ok":false}`,
exit 78. A scratch directory with the wrong mode is refused with exit 64.

### A.4 Fault injection (from A.1) and leftovers

Tor relay removed: connection through the bridge `closed_fast`. Daemon killed
with SIGKILL: launcher exit 137, group members 3 to 0, `api.sock` gives
`ENOENT`. Stage0 killed with SIGKILL: whole group gone, no stragglers. Stage1
killed with SIGKILL: stage0 exit 137, daemon not alive, group empty.

Network namespaces and launcher processes on the host before and after the
whole final run (all three drivers and every fault):

```
net namespaces before: 176; leftover launcher procs: 0
net namespaces after: 176; leftover launcher procs: 0
```

### A.5 Timing and the real daemon binary

From A.1: session start to first probe 271 ms; API bridge round trip 0.86 ms;
`launcherStartToExitMs` for five consecutive `noop` runs: 10, 10, 10, 10, 10.

The real `zkapi-clientd` (built from the fork checkout with a prototype
version suffix; the fork tree was clean afterwards) under the launcher
on the laptop:

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

(The ready events there are from the earlier prototype build that lacked the
IPv6 layer; the layer list in A.1 is current.) Reaching a funded wallet,
the managed companion and Tor was out of scope.

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
