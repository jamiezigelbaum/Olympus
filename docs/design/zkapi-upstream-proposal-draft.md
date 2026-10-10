# Draft: issue for ethereum/zkapi

Status: **draft for the owner to read. Not posted.** It would be opened as an issue on `ethereum/zkapi` under the owner's GitHub account, followed by a pull request if the maintainers are open to it.

---

**Title:** Let a supervising process pin clientd's transport and local listeners at start, so its network route can be confined by the OS

**Body:**

I am integrating `zkapi-clientd` into a local-first tool that runs the daemon as a supervised child for one short session at a time, behind a Tor client it starts for that session. I would like to be able to tell the user something stronger than "the daemon reported SOCKS5 mode": that the operating system only allowed the daemon and its companion to reach that one Tor listener.

Today I cannot build that confinement without reading the daemon's wallet configuration, which a supervisor should not touch:

- `serve` takes no flags, so the relay endpoint comes only from `config.json` (`cmd/zkapi-clientd/main.go`, `serve`). That file also holds `bridge_token`, which authorizes the companion's withdrawal routes, so a supervisor must not read it.
- The managed companion reaches the network through a CONNECT proxy bound to `127.0.0.1:0` (`internal/relay/connect.go`, `StartConnectProxy`). A sandbox profile has to be written before the process starts, so it cannot name a port chosen at random afterwards. On macOS the only workable rule is "any loopback port", which also admits any other local proxy.
- `external_companion` skips both the managed companion and its proxy (`cmd/zkapi-clientd/main.go`). From outside, the two modes look the same: the startup log reports SOCKS5 mode either way.
- The daemon's own connection to the wallet API is a third loopback endpoint a profile would need to name.

**Proposal** — four small, opt-in additions; defaults unchanged:

1. `serve --relay-url socks5://127.0.0.1:PORT` — apply a relay endpoint for this run only, in memory, without writing the saved configuration.
2. `serve --companion-proxy-listen 127.0.0.1:PORT` — bind the CONNECT proxy to a caller-chosen address instead of port 0. If the bind fails, exit; never fall back to a random port.
3. `serve --require-managed-companion` — refuse to start when `external_companion` is configured, before any network activity.
4. Report the effective, non-secret transport facts in the existing `/admin/status` response (which already sits behind the ordinary API bearer, not the management token): transport kind, relay endpoint, managed or external companion, wallet API endpoint, CONNECT proxy endpoint. No credentials and no wallet state.

With these, a supervisor can choose the ports, write an exact-port sandbox profile (or a network namespace with a single forward), start `serve`, and compare what it asked for with what the daemon reports, without ever reading `config.json`, running `config`, or holding the management or bridge credentials.

**Further, if useful:** accepting a Unix-socket SOCKS relay (`socks5+unix:/path`) would let a supervisor check the peer's identity on the socket instead of trusting a port; accepting inherited listener file descriptors would remove the reserve-then-bind race.

**What this does not claim:** these flags make OS confinement possible; they are not confinement themselves. A status endpoint reports configuration, not history. Content and timing correlation, and same-user malware, are out of scope.

I am happy to send a pull request for 1–4 if the direction is acceptable. Related: #16 (Tor-routed client mode) solves the same need with wrapper scripts that rewrite the saved relay URL and read the companion's bridge token to wait for settlement; the flags above would let that be done without either.
