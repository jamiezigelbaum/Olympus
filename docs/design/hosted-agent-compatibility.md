# Hosted-agent compatibility

Status: design, owner-approved to build on 2026-09-24. This is v0.5 scope: v0.4
excludes assistant harnesses beyond OpenClaw and Hermes-via-MCP (see
[V0_4_RELEASE.md](../V0_4_RELEASE.md#not-v04)). Nothing here changes the v0.4
release candidate.

## Outcome

A person installs Olympus once on their own machine. After that, every agent
they use can ask Olympus questions in the background, under the same privacy
rules the OpenClaw agent has today. That includes:

- their OpenClaw agents;
- Claude Code and Codex on the same machine;
- Claude on the web, desktop and phone, including the Free plan;
- xAI's Grok and Grok Bot;
- Meta's Muse;
- any other agent that speaks remote MCP or OpenAPI.

They create no extra accounts, run no tunnel of their own, and never tell
Olympus about each new agent.

Instinct (Spear Street) has no tool, MCP or API surface today. It is out of
scope until it ships one, and the same endpoint will serve it then.

## Privacy rules (unchanged)

Every connected agent gets exactly the policy the OpenClaw agent gets today:

- **Public and Personal (S0–S3):** evidence may reach the calling agent's cloud
  model.
- **Private (S4, `secure_local`):** read only by an approved private analyst
  (Argus, which is Venice or a local model). The calling agent receives only
  that analyst's secret-scanned, derived answer and citation labels, never
  Private source text.
- **Secrets (S5):** always denied.

There is no per-vendor policy. Today the release gate names the calling agent
`destination: 'castor'` (`src/workers/source-index/analyst-answer.ts`), which
is a single-agent name, not a security distinction. This work generalizes that
destination to "the calling agent". It does not change what may cross.

## No per-agent upkeep

Olympus grants access to a **connection**, never to an individual agent. A
connection is one approval by the owner:

- their OpenClaw;
- their Grok account;
- their Muse account;
- their Claude account;
- their Codex.

Every agent behind an approved connection has access by default:

- A new Grok Bot shares the app-wide connector.
- A new OpenClaw agent (an expert agent, for example) runs inside the user's own
  OpenClaw, which the native plugin already serves.
- To opt an OpenClaw agent out, use OpenClaw's own per-agent tool deny list
  (`agents.list[].tools`). Olympus adds no setting for it.
- To remove a whole connection, revoke it in the dashboard or with
  `olympus connections revoke`.

The security boundary is the owner's approval plus a revocable connection
credential. An outsider needs that credential, or the owner's account at the
vendor that holds it. Olympus records the connection on each answer's audit
entry ("Grok asked…"), so the owner can see what each connection asked.

## Surfaces

| Agent | How it reaches Olympus | Owner's one-time step |
|---|---|---|
| OpenClaw agents | Native plugin tools (exists). | None. |
| Claude Code, Codex, Hermes on the same machine | Local stdio MCP, `olympus serve` (exists). | Add the MCP server once. |
| Claude web, desktop chat and mobile; ChatGPT; Cursor | Remote MCP, Streamable HTTP with OAuth. | Paste the connection URL, then approve. |
| Grok and Grok Bot | Remote MCP. It is a custom connector (Business/Enterprise), or through the xAI API, which uses header auth. | Paste the URL and approve, or paste the URL and a token. |
| Muse | OpenAPI plus a static bearer token (Muse has no OAuth or native MCP yet). | Paste the URL and token from `olympus connections add muse`. |

Remote tool list: `source_answer` and `source_index_status`, the same narrowed
list Hermes gets (`V0_4_HERMES_MCP_TOOLS`). Source watches remain native-only
because their delivery depends on OpenClaw's session routing.

Each connection also ships a short skill or instruction that tells the agent
when to ask Olympus, which is what makes it work "in the background".

## Reaching the user's machine: the Olympus relay

Hosted agents run in their vendor's cloud and cannot reach localhost. The
installed plugin makes an **outbound** connection to an Olympus-operated relay,
and gets a stable address such as `https://<install-id>.connect.olympusplugin.ai/mcp`.
The relay routes each incoming connection by hostname down that install's
outbound link. The user never configures it.

- **Pass-through TLS:**
  - The install generates its own key.
  - The relay helps obtain the install's certificate through an ACME DNS-01
    challenge but never holds its private key.
  - The relay routes by SNI and forwards encrypted bytes, so it cannot read
    questions or answers.
- **A small purpose-built relay:** the relay slice evaluated frp, rathole,
  zrok and sish. None met pass-through TLS, install-key registration and
  npm-shippable client together, so the relay is a small TypeScript service
  with no new dependencies. See `docs/design/relay.md` (added with the relay).
- **Identity:** a key pair created at install time. The relay accepts only
  installs that have registered, and there are no user accounts.
- **Availability:** answers work only while the user's machine and Olympus are
  running. Otherwise the relay returns a clear "Olympus is offline" error. Local
  surfaces never depend on the relay.
- **Certificates at scale:** Let's Encrypt allows about 50 new certificates
  per registered domain per week (renewals are exempt). File Let's Encrypt's
  rate-limit override request early, because it takes weeks. Separately, list
  `connect.olympusplugin.ai` on the Public Suffix List for tenant isolation
  (cookies), not for rate limits, because the PSL rejects rate-limit
  motivated entries.
- **Operating cost:**
  - One or two small servers, about €20–40/month total.
  - A wildcard DNS record.
  - Uptime monitoring and patching.
- **Rejected alternative:** Cloudflare Workers with Durable Objects. It is
  cheaper, but Cloudflare terminates TLS there, so the relay would see
  plaintext answers.

For development before the relay exists, a no-account Cloudflare quick tunnel
on the developer's own machine is enough to test Claude, Grok and Muse end to
end.

## Pairing and auth

All of this is served by the local worker. The worker stays bound to loopback,
and the relay client forwards to it.

- **Connection store:** each record holds a display name, the client
  identifier, the hash of the refresh or bearer secret, the creation and
  last-use times, and whether it is revoked. It lives in the worker's state, and
  raw secrets are never stored.
- **Bearer connections**, for Muse, the Grok API and scripted clients:
  `olympus connections add <name>` prints the URL and a long random token once. The
  token is revocable.
- **OAuth 2.1** for Claude, ChatGPT and Grok connectors (MCP spec 2026-07-28):
  - Protected-resource and authorization-server metadata.
  - Client ID Metadata Documents (CIMD), with Dynamic Client Registration as a
    fallback.
  - PKCE.
  - The RFC 9207 issuer parameter.
  - Short-lived access tokens and rotating refresh tokens.
- **Proving the approver is the owner:** the approval page is often opened on a
  phone, away from the machine. It asks for a short one-time pairing code,
  which the owner gets from the dashboard, from `olympus connections add`, or by asking
  their OpenClaw agent. The code expires in minutes and works once.
- **Display names** come from the client metadata ("Claude", "Grok"). The owner
  never types them.

### OAuth as built (slice 4)

- **Switch:** OAuth is on only when the worker has a public base URL (an
  https origin): `OLYMPUS_PUBLIC_BASE_URL` in its environment, or, since the
  relay wiring, the address the remote-access service reports (plugin config
  `remote.*`; see [relay.md](relay.md#plugin-wiring)), followed without a
  restart. The issuer (`<origin>`), the resource (`<origin>/mcp`) and every
  metadata URL come from it, never from `Host` or forwarding headers. Unset,
  the routes answer 404 and bearer connections work as before.
- **Routes:** `/.well-known/oauth-protected-resource[/mcp]`,
  `/.well-known/oauth-authorization-server`, and `/connect/authorize`,
  `/connect/token`, `/connect/register`, `/connect/revoke`. The relay's local
  endpoint forwards exactly these, plus `/mcp`, `/openapi.json` and
  `/api/v1/tools/*`.
- **Clients:** Claude (web, desktop, mobile) and ChatGPT identify themselves
  with Client ID Metadata Documents; Grok registers dynamically. Both paths are
  served. Every client is public (PKCE S256, `token_endpoint_auth_method`
  `none`), and every authorization response carries the RFC 9207 `iss`.
- **Grants are connections:** an approved grant is a `remote_connections` row
  of kind `oauth`, so `olympus connections list|revoke` and audit attribution
  are unchanged. Access tokens are opaque, live one hour and are bound to the
  resource, on `/mcp` and the OpenAPI tool paths alike. Refresh tokens rotate;
  for 45 seconds a just-used one returns the same successor pair (concurrent
  refreshes, a lost response), and after that, or once the successor has
  rotated, replaying it revokes the grant. Only digests are stored.
- **Refresh grace exposure (accepted).** Inside those 45 seconds, anyone who
  holds the old refresh token and the client id gets the successor pair. The
  client id is not a secret: every client is public, and Claude's and
  ChatGPT's are published URLs. So a stolen refresh token that is replayed
  within 45 seconds of the real client's refresh is *not* detected as reuse:
  thief and client share one live pair, and reuse detection fires only on a
  replay after the window or after the successor has itself rotated. (If the
  thief rotates the successor first, the real client's next refresh inside
  the thief's window gets the thief's pair too; outside it, the grant is
  revoked.) The window exists because hosted clients do refresh concurrently
  and do lose responses, and the alternative, revoking on any reuse, would
  disconnect them. The exposure is bounded: it needs the refresh token itself
  (stored only by the client, sent only to the token endpoint over TLS),
  it lasts 45 seconds per rotation, and the grace state lives in the worker's
  memory only. Revocation ends it at once: revoking the grant (dashboard,
  `olympus connections revoke` from another process, or the client revoking
  its successor refresh token at `/connect/revoke`) deletes every token row,
  so the old token, the successor pair and the grace entry all stop working
  inside the window (`test/remote-oauth.test.ts`, "revoking a grant inside
  the refresh grace window kills everything"). Sender-constrained tokens
  (DPoP, RFC 9449) would close it, but only once the hosted clients send
  them; none of the connector documentation checked for this slice mentions
  DPoP.
- **Pairing:** `olympus connections pair` prints `SSSS-XXXX-XXXX`: a public
  selector naming the code plus a secret (about 39 bits), no ambiguous
  characters, valid 10 minutes, single use. Five wrong secrets for one selector
  kill that code only; unknown selectors and malformed input burn nothing.
  Guessing is paced, never locked: each caller's wrong codes double its wait
  (up to a minute), and past 20 wrong codes in 15 minutes every check waits
  two seconds.
- **Waiting approvals** are bounded (256 in all, 128 per client id, 8 per
  caller, where a caller is the address the relay reports, IPv6 grouped by
  /64 as the relay's own limits are), but a new request
  is never refused. It evicts an older one instead: a caller at its cap loses
  its own oldest; a client id at its cap, or a full table, loses the oldest
  request of whichever caller holds the most slots in that scope. A flood from
  many addresses therefore evicts itself, and the owner, holding one request,
  is evicted only once every holder is down to one. That takes more distinct
  addresses than the scope has slots (128 when the flood names the owner's own
  app, whose client id is public). A page whose pairing check the pacer has
  admitted (a well-formed code, with the page's cookie and CSRF token) is
  pinned, but pinning only decides *which* of the heaviest callers' entries
  goes: fair share always runs over the whole scope, so pinned entries can
  never move an eviction onto a caller holding fewer, such as the owner. Each
  pin costs a paced check (about five per caller fit inside the hold limit)
  and five wrong codes end the page. The evicted page says it was replaced.
  Before this, 32 addresses holding 8 each filled the table and every other
  caller got a 429 for ten minutes.
  Callers that arrive without the relay's secret (a tunnel, or loopback) share
  one `direct` caller, so they compete for its eight slots.
- **Schema v2 and rollback:** opening the connection database with this build
  first copies a v1 database to `remote-connections.sqlite.pre-v2.bak`, then
  migrates. An older build refuses v2, so a downgrade restores that copy with
  the worker stopped (`cp …pre-v2.bak remote-connections.sqlite`, remove the
  `-wal`/`-shm` files); connections made since the upgrade are lost and
  connections revoked since then return, so re-check `olympus connections list`.
  This is manual rather than part of `olympus worker upgrade` rollback: that
  rollback covers a failed upgrade, before the lazily opened database has
  migrated.
- **Host and Origin:** the unauthenticated OAuth routes answer only the public
  host or a loopback name, which defeats DNS rebinding. The approval form also
  needs a same-origin browser, a CSRF token and a matching SameSite=Strict
  cookie. `/mcp` keeps no Origin rule, because it is bearer-only, sends no CORS
  headers, and hosted agents call it from their servers.

### MCP 2026-07-28 (assessed 2026-09-25)

**Verdict: no SDK migration for v0.5.** Olympus's `/mcp` serves protocol
2025-11-25 through `@modelcontextprotocol/sdk` 1.29.0, and that is what the
target clients speak or fall back to today. Moving to 2026-07-28 is its own
slice (below), not a v0.5 blocker.

What 2026-07-28 changed for a Streamable HTTP server:
- **Stateless core.** No `initialize` handshake and no `Mcp-Session-Id`;
  every request carries its protocol version, client info and capabilities
  in `_meta`, and servers must implement `server/discover`. Server-to-client
  requests move into results (multi round-trip requests), and the GET stream
  is gone.
- **Mirrored headers.** Every POST carries `MCP-Protocol-Version`,
  `Mcp-Method`, and for `tools/call` `Mcp-Name`. A modern server must reject
  a missing or mismatched header with 400 and `HeaderMismatch` (-32020), and
  an unsupported version with 400 and `UnsupportedProtocolVersionError`
  (-32022).
- **Authorization.** The RFC 9207 `iss` is required (Olympus already sends
  it), credentials are bound to their issuer, and Dynamic Client
  Registration is deprecated in favor of CIMD but still works. Olympus serves
  both, CIMD first.

**Eras and fallback.** The spec calls 2025-11-25 and earlier *legacy*.
A *dual-era* client tries a modern request first, and on a 400 whose body is
not a recognized modern error it falls back to `initialize`. The spec's
matrix: dual-era client with a legacy server works; a modern-only client
with a legacy server fails. The TypeScript, Python, Go and C# SDK 2.x lines
are dual-era.

**What Olympus answers today.** Olympus is stateless already (one server
and transport per request, no session, GET and DELETE answer 405), so it is
compatible in shape. The installed SDK 1.29.0 supports 2025-11-25 down to
2024-10-07 (1.30.1, the newest 1.x, is the same). A modern request gets
400 with `-32000 Bad Request: Unsupported protocol version`, which is not a
modern error code, so a dual-era client falls back and `initialize`
negotiates 2025-11-25. `test/remote-mcp.test.ts` pins that answer, because
a 1.x upgrade that started answering -32022 would make dual-era clients
retry modern forever instead of falling back.

**The clients.**
- **Claude** (web, desktop, mobile): its connector documentation lists auth
  specs 2025-03-26 through 2025-11-25 and Streamable HTTP; Anthropic has
  announced 2026-07-28 support is coming, with no date. A third-party issue
  tracker reported in August 2026 that Claude Desktop and Claude Code still
  sent the legacy handshake. Works with a 2025-11-25 server today.
- **ChatGPT** (developer mode connectors): documents Streamable HTTP and
  SSE, no protocol version. Its CIMD document is served and tested. No
  evidence that it is modern-only; treat it as legacy or dual-era.
- **Grok** (custom connectors, xAI remote MCP tools): documents Streamable
  HTTP, no version; xAI's own MCP server runs in stateless mode. Same
  treatment.
- **Codex** reportedly moved to 2026-07-28 (same third-party report). If its
  client is dual-era, as the SDK 2.x clients are, it falls back; that is
  unverified.
- Unverified until the end-to-end proof (build step 7), which should record
  the protocol version each client negotiates.

**Timeouts, noticed on the way.** Claude.ai and Desktop cut a tool call at
240 seconds. `source_answer` can run about that long at the end of its
timeout chain, so the async submit/poll pair noted for Muse may be needed
for Claude too.

**Follow-up slice: dual-era server.** Move `/mcp` and `olympus serve` to the
split SDK 2.x packages (`@modelcontextprotocol/server` 2.1.0, which needs
zod 4 as a new dependency), serving modern requests statelessly with
`server/discover` and header validation, and `initialize` for legacy
clients. It touches `src/mcp/server.ts` (stdio), `src/workers/remote-mcp.ts`,
the MCP tests that use the 1.x client, and the committed `dist/` bundle, so
it is a slice of its own. It becomes a v0.5 requirement only if a target
client ships modern-only.

## Build sequence

Each slice is its own pull request. Security, auth and install surfaces are
critical-class and need an independent review receipt.

1. **Calling-agent attribution.**
   - Generalize the release destination from the single-agent `castor` name to
     "the calling agent", with identical release semantics.
   - Carry an optional connection identity from every surface (native, stdio
     MCP, remote) into the answer's audit entry.
   - Proof: existing release-gate tests unchanged, plus attribution tests.
2. **Remote MCP endpoint with bearer connections.**
   - Streamable HTTP at `/mcp` on the worker.
   - The connection store, `olympus connections add|list|revoke`,
     and a `remote` operation surface limited to the Hermes tool list.
   - Proof: an MCP SDK client over loopback, plus revocation and bad-token
     tests.
3. **OpenAPI view.**
   - `/openapi.json` and a matching REST call path, generated from the same
     operations table, for Muse.
   - As built: OpenAPI 3.1 at `GET /openapi.json`, served without a token
     (Muse reads the spec from a URL and writes its own client before the
     owner pastes the token; the document is rendered with the neutral
     identity and default corpus registry, so it names nothing about the
     install). Calls are `POST /api/v1/tools/<name>`, one path per remote
     operation, behind the same connection token, exposure filter and
     in-process path as `/mcp`. The server entry is relative until the relay
     supplies a public origin; it never comes from the Host header. The spec
     is identical on every install (fixed API version, full remote list), and
     CORS is intentionally absent: Muse fetches from its VM, server-side, and
     no browser page needs to read either path. Both remote endpoints read
     request bodies through a bounded stream reader (256 KiB).
   - Open: Muse's HTTP timeout is unpublished. `source_answer` can take
     minutes, so an async submit/poll pair (`POST` returns a job id, `GET`
     polls it) is the follow-up if end-to-end proof shows synchronous calls
     cut off.
4. **OAuth 2.1 authorization server** with the pairing code approval page.
5. **Relay client** in the plugin, plus **relay service** code and deployment
   config.
   - Deploying the relay service is a live change with its own authorization.
6. **Onboarding:**
   - A dashboard "Connect an agent" panel and install-guide steps.
   - Per-vendor instruction skills.
   - Let's Encrypt rate-limit override and Public Suffix List requests.
7. **End-to-end proof** with no paid plans:
   - Claude Free on the web and phone.
   - Muse on its free tier, if it allows custom connectors.
   - Grok through a small amount of API credit.

## Not in scope

- Instinct, until it ships a connector surface.
- Source watches on non-OpenClaw agents.
- Per-vendor privacy policies.
- Marketplace or directory listings (Muse directory, xAI marketplace). These
  come after end-to-end proof.
- Expert Agents and Guru, which are tracked in their own repositories.

## Sources (checked 2026-09-24)

- [Grok custom connectors](https://docs.x.ai/grok/connectors),
  [xAI remote MCP](https://docs.x.ai/developers/tools/remote-mcp),
  [Grok Bot for teams](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Muse custom connectors](https://www.meta.com/help/artificial-intelligence/1687253048996149/),
  [third-party Muse connector test](https://github.com/ima-jin/imajin-ai/pull/2254)
- [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
  (Free plan: one custom connector; works on mobile)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- MCP 2026-07-28 [versioning and backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
  and [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
  (checked 2026-09-25)
- [Building Claude custom connectors](https://claude.com/docs/connectors/building),
  [Bringing MCP 2026-07-28 to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
  (checked 2026-09-25)
- [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
  (checked 2026-09-25)
- [plaud-tools issue #220](https://github.com/massive-value/plaud-tools/issues/220)
  (third-party report of which clients sent which handshake, August 2026)
- [OpenClaw `mcp serve`](https://docs.openclaw.ai/cli/mcp) exposes
  conversations only, not plugin tools, which is why Olympus hosts its own
  endpoint.
