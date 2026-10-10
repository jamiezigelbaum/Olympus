# macOS zkAPI route confinement

The `anonymous route` claim is per completed session. It requires every existing
`zkapiRouteLabel` condition: isolated request key, authenticated local inference,
fresh Tor, a passed loopback-filtering self-test, no observed Tor bypass and
confirmed settlement (or no lease). This change does not relax those conditions.

## Required daemon

The supervised macOS route requires the Olympus `zkapi-clientd` fork version
`0.1.6-olympus2`, based on `olympus/supervisor-flags` in
`jamiezigelbaum/zkapi`. It adds connection ownership verification for the managed
companion. Original upstream binaries and `0.1.6-olympus1` lack that proof;
Olympus refuses before starting Tor with `daemon_supervisor_unsupported`.
The current upstream managed-tools download is therefore insufficient on macOS.
Use the compatible fork through the route's explicit `daemonExecutable` setting.
This PR does not install binaries, change saved wallet configuration or deploy.

Olympus passes these serve-time overrides, never reading `config.json`:

- `--relay-url socks5://127.0.0.1:<Tor port>`
- `--companion-proxy-listen 127.0.0.1:<allocated port>`
- `--wallet-api-listen 127.0.0.1:<allocated port>`
- `--require-managed-companion --require-companion-custody`

The authenticated `/admin/status` must report these exact endpoints, SOCKS5,
a managed companion and `wallet_custody: connection_owner_verified`. Both
companion listeners must belong to the supervised daemon's process group;
Tor's listener must belong to the supervised Tor group. These ownership checks
run again before catalog/authenticated requests and dispatch. An older daemon,
wrong endpoint, external companion or unowned listener refuses without sending
the question.

## Kernel enforcement and self-test

A single Seatbelt profile is inherited by the daemon and every descendant.
It denies `network*`, then permits TCP/IPv4 outbound to the four session ports
on localhost. Only the three daemon/companion ports may bind or accept inbound
connections; the daemon cannot replace Tor's listener. IPv6, UDP, Unix sockets
(including the resolver), other loopback ports and direct remote connections
remain denied. All ports must be distinct integers in 1–65535.

Before Tor or the daemon starts, the session tests the exact profile and ports.
The unconfined parent creates live listeners for every allowed port, an unrelated
IPv4 port, and an IPv6 listener sharing an allowed numeric port. The identical
probe runs outside the profile, inside it and in an exec descendant:

- All four allowed IPv4 TCP connections must succeed both outside and inside.
- The unrelated IPv4 port, IPv6, IPv4-mapped unrelated address and system resolver
  must connect outside and fail immediately inside.
- Direct and loopback UDP sends must succeed outside and fail inside.
- A TCP attempt to TEST-NET-1 must time out or fail slowly outside and fail
  immediately inside, preserving the existing offline-machine negative control.

No question or credential is involved. Missing controls, occupied ports, errors,
timeouts or a changed platform behavior refuse the session. The Mac integration
test also runs a supervised daemon fixture and verifies actual forbidden egress.
Linux CI exercises the topology/refusal/receipt logic; it cannot prove Seatbelt.

## Boundaries

This proves the enforced route for trusted daemon/companion executables in this
session, not that question content cannot identify someone. It does not protect
against a compromised OS, root, same-user malware modifying trusted executables
or Tor, or timing/content correlation. `sandbox-exec` is deprecated; availability
and a successful live self-test are requirements, not assumptions. Non-macOS
platforms retain their existing unverified route status. Failures do not retry
through an unrestricted route.
