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
| Muse | OpenAPI plus a static bearer token (Muse has no OAuth or native MCP yet). | Paste the URL and token from `olympus connect muse`. |

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
- **Built on an existing tunnel, not a new protocol:** frp, rathole, zrok or
  sish, chosen during the relay slice.
- **Identity:** a key pair created at install time. The relay accepts only
  installs that have registered, and there are no user accounts.
- **Availability:** answers work only while the user's machine and Olympus are
  running. Otherwise the relay returns a clear "Olympus is offline" error. Local
  surfaces never depend on the relay.
- **Certificates at scale:** put `connect.olympusplugin.ai` on the Public
  Suffix List, so per-install certificates don't hit Let's Encrypt's
  per-domain weekly limit. Request this early, because approval takes weeks.
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
  `olympus connect <name>` prints the URL and a long random token once. The
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
  which the owner gets from the dashboard, from `olympus connect`, or by asking
  their OpenClaw agent. The code expires in minutes and works once.
- **Display names** come from the client metadata ("Claude", "Grok"). The owner
  never types them.

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
   - The connection store, `olympus connect|connections list|connections revoke`,
     and a `remote` operation surface limited to the Hermes tool list.
   - Proof: an MCP SDK client over loopback, plus revocation and bad-token
     tests.
3. **OpenAPI view.**
   - `/openapi.json` and a matching REST call path, generated from the same
     operations table, for Muse.
4. **OAuth 2.1 authorization server** with the pairing code approval page.
5. **Relay client** in the plugin, plus **relay service** code and deployment
   config.
   - Deploying the relay service is a live change with its own authorization.
6. **Onboarding:**
   - A dashboard "Connect an agent" panel and install-guide steps.
   - Per-vendor instruction skills.
   - Public Suffix List request.
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
- [OpenClaw `mcp serve`](https://docs.openclaw.ai/cli/mcp) exposes
  conversations only, not plugin tools, which is why Olympus hosts its own
  endpoint.
