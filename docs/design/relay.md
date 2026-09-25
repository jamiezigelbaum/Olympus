# Olympus connect relay

Status: slice 5 of
[hosted-agent compatibility](hosted-agent-compatibility.md). Code: [`connect-relay/`](../../connect-relay). Nothing here is
deployed yet.

A hosted agent (Claude, Grok, Muse) calls
`https://<install-id>.connect.olympusplugin.ai/mcp`. The relay routes that
connection by TLS SNI, still encrypted, down an outbound link the user's
Olympus keeps open. The install terminates TLS with a key that never leaves
the machine, and forwards the request to the loopback worker
(`http://127.0.0.1:28090`).

## Relay design

**Decision: a small purpose-built TypeScript relay and client, with no new
dependencies.** No existing tunnel met the hard constraints without a fork or
a per-platform binary in the npm package.

| Option | SNI pass-through with a reverse outbound client | Install-key registration | Client in the npm package | Verdict |
|---|---|---|---|---|
| [frp](https://github.com/fatedier/frp) | Yes. The `https` proxy type routes by SNI on `vhostHTTPSPort`, and "frps will not perform TLS termination" ([docs](https://gofrp.org/en/docs/examples/https2http/)). | No. It offers `token` or OIDC only. Per-install keys need a custom [`Login`/`NewProxy` plugin](https://github.com/fatedier/frp/blob/dev/doc/server_plugin.md) service anyway. | No. `frpc` is a Go binary, so four prebuilt platform binaries would ship in the package. | Works, but it still needs custom auth and DNS services, plus binaries. |
| [rathole](https://github.com/rapiz1/rathole) | No. Each service gets its own server bind port, with no hostname routing. | Per-service tokens only. | No. It is a Rust binary. | Does not fit. |
| [zrok](https://docs.zrok.io/docs/concepts/tunnels/) | No. Public frontends terminate TLS, and `tcpTunnel` shares are private only. TLS pass-through is an [open request](https://github.com/openziti/zrok/issues/387). | zrok accounts | No. It is a Go binary, and it needs an OpenZiti controller and router. | Does not fit. |
| [sish](https://docs.ssi.sh/cli) | Yes (`--sni-proxy`). The client is plain `ssh -R`. | SSH public keys via `--authentication-key-request-url`. That is close, but there is [no per-key binding restriction](https://docs.ssi.sh/cli), so any key holder can squat another install's name, which is a denial of service. | Would need an SSH client in Node (`ssh2`), a new dependency. | Closest. Needs a fork for per-key name binding and custom DNS-01 publishing. |
| **Purpose-built TS** | Yes. The ClientHello parser is about 100 lines. | Ed25519 install key. The install id is derived from the key. | Yes. It uses only `node:` built-ins and works on Node and Bun. | **Chosen.** |

The relay and shared protocol are about 1,150 lines of commented TypeScript. The install client adds about 850 more, and tests come on top. Every option
above would still have needed the two pieces that carry the real design
weight: key-bound registration, and relay-published DNS-01 TXT records
constrained to the install's own name. The WhatsApp bridge shows the existing
Go pattern: it ships Go *source* and builds on the user's machine with a local
Go toolchain (`src/core/messaging-pairing.ts`). That is acceptable for an
opt-in pairing step, but it is not acceptable for the default remote path.

### Shape

```
agent ──TLS(SNI=<id>.zone)──▶ relay :443 ──splice──▶ data conn ──▶ install: local TLS endpoint ──HTTP──▶ worker /mcp
                              │  reads ClientHello only        (outer TLS to relay control host,
                              │                                  inner = the agent's TLS, untouched)
install ──TLS(SNI=relay.zone)─┘  control session: hello/register, open, ping, acme-dns-set/clear
```

- **One port.** The relay listens on port 443 and reads only the cleartext
  ClientHello:
  - SNI equal to `relay.<zone>` (sessions) or `data.relay.<zone>` (data
    connections) goes to the relay's own control plane, which serves the
    relay's own certificate for both names.
  - SNI `<install-id>.<zone>` is spliced byte for byte.
  - Anything else gets a TLS alert.
- **Data connections, not a multiplexer.** For each public connection, the
  relay sends `open {connId}` on the install's session. The install then dials
  a fresh connection and sends `attach`, signed over a new nonce and bound to
  that `connId`. TCP handles backpressure, and there is no framing layer to get
  wrong. The cost is one extra round trip per connection. A pre-opened pool is
  a later optimization.
- **TLS inside TLS.** A data connection is TLS from the install to the
  relay's data host, and the relay terminates only that outer layer. Inside it
  are the agent's own TLS records, end to end with the install's certificate.
  The relay decrypts the outer layer and sees inner ciphertext; it never holds
  a key for the inner layer.
- **Separate budgets for sessions and data.** Data connections exist because
  public traffic arrived, so they must not spend the budget an install needs
  for its session.
  - The control host has a per-address *rate* (session setup only; outsiders
    cannot cause it).
  - The data host has a per-address *concurrency* cap. Attaches are further
    bounded by live pending connection ids and the per-install limits.
  - Before the ClientHello, the relay caps connections per address and
    overall, and parses only once a whole TLS record has arrived, so a
    byte-by-byte trickle costs one parse per record.
  - One address can hold at most 16 of an install's 64 slots. The install
    endpoint speaks HTTP/1.1, so an agent needs one connection per in-flight
    request plus one SSE stream per MCP session; the limits leave room for
    that behind a single vendor egress address.
  - The install closes any connection that has not finished TLS and sent a
    request within 10 seconds, and any connection with no request in flight
    for 30 seconds. The idle rule is the client's own, because Bun's HTTP
    server does not close idle keep-alive connections. A response still
    streaming counts as in flight, so SSE streams are not cut. A slot is freed
    as soon as either half of the spliced pair closes.
  - When one side of a spliced connection closes, the other is ended, not
    destroyed, so bytes still queued for a slow reader are delivered.
  - Per-address limits key IPv6 by /64. When an AAAA record is published the
    relay listens dual-stack on `::`, and refuses to start IPv4-only.
- **Identity.**
  - The install key is Ed25519. The install id is `base32(sha256(SPKI))[:32]`,
    so an id cannot be claimed with a different key.
  - `register` proves possession of the key by signing the relay's nonce.
    Registration is rate-limited per source address.
  - `hello` is refused for ids that never registered.
  - Signatures are domain-separated and bound to the nonce, so they cannot be
    replayed.
  - The registry stores only the id, the public key, and registration,
    last-seen, and activation times. It stores no IP address and no account.
  - Registrations are rate-limited per address and relay-wide. A registration
    that never starts certificate issuance expires after 24 hours once it is
    offline; one with no session for 90 days expires. Its address record stays
    counted until the DNS removal (within the DNS budget) succeeds, and failed
    removals are retried on the next sweep. If the install re-registers while
    the removal is in flight, the relay re-creates the record (or marks it
    missing so the next publish does), so the registry never claims a record
    DNS does not have. The store is an
    append-only JSON-lines log, compacted on start, so no request rewrites the
    whole file.
- **Local TLS endpoint.** It forwards only the remote agent surface: `/mcp`,
  `/openapi.json` and the OAuth `/.well-known/*` metadata.
  - The worker's other loopback routes (dashboard, local APIs) assume a local
    caller. Everything outside the allowlist gets a local 404 and never reaches
    the worker.
  - Dot segments and encoded separators are refused rather than normalized.
  - The client opens at most 64 concurrent data connections (configurable),
    and it accepts a `ready` hostname only if it equals
    `<own install id>.<configured zone>`. Key material lives in a dedicated
    `connect-relay/` subdirectory (0700) of the state directory.
  - Forwarding headers from the internet are dropped. The endpoint sets
    `x-olympus-relay: 1`, `x-forwarded-proto`, `x-forwarded-host` and
    `x-forwarded-for`, taking the agent address from the relay's `open`. The
    `Host` header is kept, so it is `<id>.<zone>`.

### What the relay can and cannot see

- **Sees:**
  - the requested hostname (it is cleartext SNI);
  - the agent's IP address;
  - connection timing and byte counts;
  - the install's IP address.
- **Cannot see:** requests and answers. The public path
  (`server/public-path.ts`) handles raw sockets only and never imports
  `node:tls`. The relay's single TLS identity is its own control-plane
  certificate.

`connect-relay/test/structure.test.ts` holds that structure in place, and the
end-to-end test taps every forwarded byte. It asserts that both directions are
TLS records containing none of the request or response plaintext.

**Honest limit:** the relay operator controls DNS for the zone, so an *active*
malicious operator could obtain a certificate for any install hostname and
intercept traffic. Pass-through TLS protects against:

- relay compromise that is passive or read-only;
- logging;
- legal requests for stored data.

It does not protect against the DNS owner itself. Such an issuance would be
publicly visible in Certificate Transparency logs. Watching CT for the
install's own hostname is a listed follow-up. CAA `accounturi` pinning does not
help, because the same operator controls the CAA record.

### Offline and over-limit behavior

TLS pass-through means the relay cannot send an HTTP error without a
certificate for the install name. The relay answers with a **fatal TLS alert
record** before any handshake, sent in the clear, which RFC 8446 section 6
permits:

| Situation | Alert | Typical client message |
|---|---|---|
| Unknown or unregistered install name, a non-zone name, or no SNI | `unrecognized_name` (112) | "tlsv1 unrecognized name" |
| Registered install that is offline, over its connection limits, or did not attach within 10 seconds | `internal_error` (80) | "tlsv1 alert internal error" |

Two alternatives were rejected:

- **A relay-held wildcard certificate** (`*.connect.olympusplugin.ai`) to serve
  an "Olympus is offline" page.
  - It would give the relay a standing, silently usable ability to impersonate
    every install. No new CT-visible issuance would be needed, which removes
    the one detection signal above.
  - It would also train clients to accept relay-terminated connections for
    install names. A clearer error message is not worth that.
- **A bare TCP close.** It looks like network flakiness, so clients retry into
  it. An immediate, distinct alert is deterministic and cannot be confused with
  a hang.

When the install's session ends, agents waiting on it get the alert
immediately. Human-readable status belongs to `olympus connect` and the
dashboard (follow-up).

### Certificates (ACME DNS-01)

The install runs the ACME client (`client/acme.ts`, RFC 8555, ES256). The ACME
account key, the certificate key and the CSR stay local. The relay publishes
one thing: the TXT value `base64url(sha256(keyAuthorization))`, and only at the
name it derives itself, `_acme-challenge.<install-id>.<zone>`. An install
cannot name another record.

- **Limits on DNS requests:** publishes and clears share a per-install
  budget, at most 4 values can be outstanding, and all provider calls share a
  relay-wide budget. A clear is accepted only for a value the same session
  published, so clears cannot drive provider calls on their own. Explicit
  address records have a relay-wide cap.
- **Cleanup:** values are cleared after validation, and again when the session
  ends.
- **Explicit address record per install:** before the first TXT record, the
  relay creates an explicit `A`/`AAAA` record for `<install-id>.<zone>`. A TXT
  record at `_acme-challenge.<id>.<zone>` makes `<id>.<zone>` an empty
  non-terminal, and RFC 4592 wildcard synthesis stops applying to it. A
  wildcard-only zone would therefore break the install's own address during
  every issuance and renewal.
- **Renewal:** the install renews when less than a third of the certificate's
  lifetime remains. The window is proportional, so it survives Let's Encrypt
  moving to shorter lifetimes.
- **Subscriber agreement:** creating the ACME account accepts the CA's
  subscriber agreement, so no order is placed until the owner has accepted
  the CA's *current* agreement (the directory's `meta.termsOfService`) with
  `olympus connections terms --accept`. Until then the relay session stays
  up and `olympus connections status` reports `awaiting_terms` with the
  agreement's URL. A new agreement from the CA needs a new acceptance. A CA
  that publishes no agreement URL is accepted against no URL, so issuance can
  proceed; if it later publishes one, the owner is asked again.

## Plugin wiring

Remote access is opt-in plugin config, off by default. The normal path is the
dashboard: **Turn on remote access** in Setup's Agents section (below). The
equivalent commands:

```sh
openclaw config set plugins.entries.olympus.config.remote.enabled true
# relayHost defaults to connect.olympusplugin.ai; set it only for another relay.
# Advanced, for a tunnel you run yourself instead of the relay:
openclaw config set plugins.entries.olympus.config.remote.publicBaseUrl https://<your-tunnel>
```

`relayHost` defaults to `connect.olympusplugin.ai` (in
`resolveRemoteAccessMode`, not as a manifest schema default, so a
`publicBaseUrl` owner never has a relay host materialized beside it). Before
the relay is deployed, turning remote access on is safe: the relay child stays
up, reconnects with its own backoff (1 s doubling to 60 s, jittered), and
status reads `relay.state: offline` with the reason; `olympus connections
status` and the dashboard say "Olympus relay unavailable". **Upgrade note:** a
config with `remote.enabled: true` and no address used to be a named error
that kept remote access off; it now starts the relay service. Nothing public
happens before the owner accepts the CA's agreement: the install registers its
key with the relay, but no DNS record is published, no ACME account is
created and no certificate is ordered, so no Certificate Transparency entry
names the install (held by `test/native-relay-service.test.ts`). The
CHANGELOG carries the same note. `relayHost` and
`publicBaseUrl` are mutually exclusive, and so is either with an
`OLYMPUS_PUBLIC_BASE_URL` in worker.env; a conflict turns remote access off
(named in Gateway service health and in `olympus connections status`), never
the rest of the plugin.

- **Service.** `olympus-remote-relay` is a native service beside the worker
  (`src/core/native-relay-service.ts`). It runs the client in its own Bun child
  (`olympus __relay-service-run`), because the child terminates internet TLS
  and parses hosted agents' HTTP; it gets no Gateway or worker credentials.
  The shared process kernel owns start, stop, restart backoff and health.
  Readiness proves only that the child started, so backoff resets only after
  60 seconds up (`stableUptimeMs`); a child that crashes soon after start keeps
  backing off instead of reconnecting to the relay every 250 ms. A crash
  withdraws the public URL at once, before the relaunch. `olympus data delete
  --all` refuses while the relay child runs, as it does for a running worker.
- **State.** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/connect-relay/`
  (0700, files 0600) holds the keys and certificate, plus `status.json` (what
  the service and child report), `relay-auth` (below) and `acme-terms.json`.
- **Public base URL.** The child publishes `public_base_url` in status.json
  once the session is up and a certificate is served, and clears it on stop.
  The worker reads it per request (re-read only when the file changes, stat
  at most once a second), so issuer, resource and OpenAPI `servers` follow the
  relay without a worker restart; a restart would cut in-flight answers and
  drop pending OAuth approvals. They still never come from `Host`.
- **Dashboard toggle.** Setup's Agents section offers **Turn on remote
  access** and **Turn off remote access** (`POST /dashboard/agents/remote-access`,
  with the control cookie, CSRF and same-origin checks every dashboard control
  has, plus its own rate limit of 6 per 10 minutes). Turning on first needs the
  owner's acceptance of the CA's current agreement: the route answers 409
  `terms_required` with the agreement URL, the page shows it with a plain
  summary, and the owner's explicit acceptance comes back naming that URL. It
  is recorded exactly as `olympus connections terms --accept` records it
  (`resolveCurrentTermsUrl`, `recordTermsAcceptance`); a URL that changed
  meanwhile is refused as `terms_changed`. The config change never touches
  openclaw.json directly: the worker asks the Gateway over the plugin route
  `/plugins/olympus/remote-access` (worker bearer, body exactly
  `{"enabled": boolean}`), and the Gateway applies it with the plugin runtime's
  `api.runtime.config.mutateConfigFile` and `afterWrite: { mode: 'auto' }`, the
  same locked, validated, backed-up write `config.patch` and `openclaw config
  set` commit through. An OpenClaw without that runtime API gets a plain 501
  naming the `openclaw config set` equivalent. A public address set by
  `OLYMPUS_PUBLIC_BASE_URL` in worker.env is outside plugin config, so the
  panel shows where it comes from and how to remove it instead of Turn off,
  and the route refuses to toggle it (`set_by_worker_env`); a Turn off that
  wrote nothing never reports "off" while an address is still up.
- **Outage.** A relay session that goes offline keeps its public address in
  status.json (the certificate still names it), but the dashboard reads "not
  connected" with the reason and mints no pairing codes until the session is
  back.
- **Forwarding trust.** The local endpoint adds `x-olympus-relay-auth`, a
  per-install secret from `relay-auth`, and strips any inbound copy. The
  worker believes `x-olympus-relay`/`x-forwarded-for` only alongside that
  secret; any other loopback caller is one shared `direct` caller.

### Limits (defaults, `server/public-path.ts`)

| Limit | Default |
|---|---|
| ClientHello deadline / size | 5 s / 16 KiB + record headers |
| Attach deadline after `open` | 10 s |
| Concurrent public connections per install / per install from one address (IPv6 /64) | 64 / 16 |
| Install side: TLS handshake and first request deadline per connection | 10 s |
| Install side: idle connection (no request in flight) | 30 s |
| New public connections per install | burst 30, 5/s |
| Control-host connections (session setup) per address | burst 30, 1 per 2 s |
| Data-host connections per address (concurrent) / handshakes per address | 512 / burst 200, 50/s |
| Pre-ClientHello connections per address / listener total | 32 / 50,000 |
| Registrations per address / relay-wide | 5, then 5/hour / 200, then 200/hour |
| ACME TXT publishes and clears per install | 10, then 10/hour; 4 outstanding |
| DNS provider calls, relay-wide | burst 120, 2/s |
| Explicit address records | 50,000 |
| Registration expiry: no issuance (and offline) / no session | 24 hours / 90 days |
| Client data connections | 64 |
| Session idle (install pings every 30 s) | 90 s |
| Spliced connection idle | 15 min |
| Global pending / sessions / registry | 5,000 / 20,000 / 100,000 |

## Design-doc claims checked against primary sources

Claims from `hosted-agent-compatibility.md` (PR #84), checked against primary
sources:

- **"Put `connect.olympusplugin.ai` on the Public Suffix List, so per-install
  certificates don't hit Let's Encrypt's per-domain weekly limit": wrong as
  stated.**
  - The [PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines)
    say they do not accept entries "whose sole purpose is to circumvent rate
    limits of third parties (such as Let's Encrypt rate limits - use their form
    instead)".
  - They promise no processing time ("NO SERVICE LEVEL AGREEMENTS").
  - The right path for rate limits is the Let's Encrypt
    [override form](https://letsencrypt.org/docs/rate-limits/), which takes
    weeks.
  - A PSL entry *is* justified on security grounds. Each `<id>.connect…` is a
    different user's origin, including the OAuth approval pages served through
    the relay, and without a PSL entry one install's page can set cookies on
    `.connect.olympusplugin.ai` that other installs receive. The request must
    argue that, and the domain must be registered for more than 2 years beyond
    the submission date.
- **Rate-limit detail.**
  - Let's Encrypt allows 50 new certificates per registered domain per 7 days,
    refilling 1 every 202 minutes. The registered domain is determined via the
    PSL.
  - Renewals are exempt from that limit: all renewals from the per-domain
    limit, and ARI renewals from every limit.
  - Account creation is capped at 10 accounts per IP per 3 hours. Each install
    creates its own account from its own IP.
  - Without a PSL entry, the binding constraint is therefore **first
    issuances**: about 50 new installs per week across all of
    `olympusplugin.ai`. So the override request should go in before launch.
- **"frp, rathole, zrok or sish" as interchangeable candidates: partly
  wrong.** rathole has no SNI or hostname routing. zrok's public frontends
  terminate TLS, and its TCP tunnels are private-only. Only frp and sish do SNI
  pass-through (table above).
- **"Cloudflare Workers … Cloudflare terminates TLS": consistent.** Relatedly,
  the Cloudflare DNS provider here always creates records with
  `proxied: false`.
- **"About €20–40/month total": plausible.** It was not re-verified, because no
  server is purchased in this slice.

## Runbook

Nothing below has been executed. It is what deployment needs from Jamie.

### Decisions and accounts (Jamie)

1. **Server.** One small Linux VPS (x64 or arm64, 1–2 vCPU, 2 GB) with a
   static IPv4 address (IPv6 optional). Ports 443/tcp in and 22 for admin.
   Install Bun at `/usr/local/bin/bun`.
2. **DNS.** Serve `olympusplugin.ai` (or a delegated `connect.olympusplugin.ai`
   zone) from Cloudflare.
   - Create a Cloudflare API token scoped to **Zone → DNS → Edit on that zone
     only**. It goes to the host as a root-owned file (1P workstream). It is
     never pasted into chat.
   - Records:
     - `relay.connect.olympusplugin.ai A <ip>` (DNS only, not proxied);
     - `data.relay.connect.olympusplugin.ai A <ip>` (DNS only);
     - `*.connect.olympusplugin.ai A <ip>` (DNS only);
     - optional `CAA 0 issue "letsencrypt.org"` at `connect.olympusplugin.ai`.
   - The relay creates per-install explicit records itself.
3. **PSL.** Open a private-section PR to
   [publicsuffix/list](https://github.com/publicsuffix/list) for
   `connect.olympusplugin.ai`:
   - justify it by tenant isolation, not rate limits;
   - add the `_psl` TXT record;
   - confirm the domain's expiry is more than 2 years out.
4. **Let's Encrypt.** Submit the rate-limit override request for
   `olympusplugin.ai`, covering new certificates per registered domain, sized to
   expected weekly new installs. Do it now, because it takes weeks. This is
   independent of the PSL outcome.

### Deploy

1. **Host setup.**
   - `useradd --system --home /nonexistent --shell /usr/sbin/nologin olympus-relay`
   - Copy `connect-relay/` at the released SHA to
     `/opt/olympus-connect-relay/connect-relay`.
   - It needs no `node_modules`: the service uses only `node:` built-ins.
2. **Relay certificate for `relay.connect.olympusplugin.ai` and
   `data.relay.connect.olympusplugin.ai`.** Any ACME client using Cloudflare
   DNS-01 works, for example
   `certbot certonly --dns-cloudflare -d relay.connect.olympusplugin.ai -d data.relay.connect.olympusplugin.ai`.
   - Point `RELAY_CONTROL_CERT_PATH` at the chain.
   - Copy the key to `/etc/olympus-connect-relay/credentials/control-key.pem`
     (0600, root).
   - **Renewal:** certbot's systemd timer renews the certificate
     automatically, about 30 days before expiry. Its deploy hook
     (`/etc/letsencrypt/renewal-hooks/deploy/olympus-connect-relay`) copies the
     new key into the credentials directory, then runs
     `systemctl restart olympus-connect-relay`. Installs reconnect with backoff
     within about a minute. Check it once with `certbot renew --dry-run`.
3. **Configuration and secrets.**
   - `/etc/olympus-connect-relay/relay.env` from `deploy/relay.env.example`.
   - The Cloudflare token goes in
     `/etc/olympus-connect-relay/credentials/cloudflare-api-token`.
4. **Service.**
   - Install `deploy/olympus-connect-relay.service`, then run
     `systemctl daemon-reload && systemctl enable --now olympus-connect-relay`.
   - Check the logs with `journalctl -u olympus-connect-relay`: the service
     writes one JSON line per event, including `relay_listening`.

### Verify

- `openssl s_client -connect relay.connect.olympusplugin.ai:443 -servername relay.connect.olympusplugin.ai`
  presents the relay certificate.
- `openssl s_client -connect <ip>:443 -servername aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.connect.olympusplugin.ai`
  fails with `unrecognized name`.
- **Real install.** Once the wiring follow-up lands, a real install reports
  `https://<id>.connect.olympusplugin.ai/mcp`. Check three things:
  - `curl https://<id>…/mcp` reaches the worker;
  - `curl https://<id>…/` returns 404 from the install;
  - after stopping Olympus, curl fails with `internal error`.

### Operate

- **State.** The registry is `/var/lib/olympus-connect-relay/registry.jsonl`.
  Back it up. Losing it forces installs to re-register, which they do
  automatically on the `unregistered` error.
- **Removing an install.** Append
  `{"op":"remove","installId":"<id>","at":<ms>}` to the registry, delete its
  DNS records, then restart. An admin revoke command is a follow-up.
- **Incidents.** A spike in `public_rejected_limit` means an abusive agent or
  a misbehaving install. Adjust the limits in `server/public-path.ts` and
  record a disposition.

## Follow-ups

1. **Wiring: done** (see [Plugin wiring](#plugin-wiring)). The client stays
   in `connect-relay/client`, imported by the relay child. The dashboard's
   relay status reads the `olympus connections status` JSON.
2. **Coordinate with the `/mcp` slice.** The worker must accept
   `Host: <id>.<zone>` (DNS-rebinding allowlist), and it must treat
   `x-olympus-relay: 1` as a remote caller. That header is trustworthy only
   because the local endpoint strips any inbound copy, and only while the
   worker stays bound to loopback. OAuth metadata should build URLs from
   `x-forwarded-host`.
3. **Certificate Transparency watch** for the install's hostname: an alert on
   any certificate the install did not request.
4. **ACME Renewal Information (ARI, RFC 9773).** It makes renewals exempt from
   every Let's Encrypt limit.
5. A human-readable relay status endpoint, and an admin revoke command.
6. A pre-opened data-connection pool, if first-byte latency matters.
7. Multi-node relay: a shared registry, plus session routing by install id.
