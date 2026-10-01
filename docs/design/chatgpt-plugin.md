# Olympus for ChatGPT — product spec and build plan

Status: active, 2026-10-01. Supersedes the hosted-relay parts of
`hosted-agent-compatibility.md` and the draft `relay-security.md` (per-install
hostnames, TLS passthrough, DNS-01). Owner direction is recorded in the
"Decisions" section; research with sources lives outside the repo in
`~/Code/Claude/research/openai-plugins-2026-10-01/` (A plugin platform,
B Secure MCP Tunnel, C desktop install).

## Outcome

A person who has only ChatGPT adds Olympus, lets ChatGPT install the engine on
their Mac, connects sources they already have, and asks questions in ChatGPT.
The Olympus dashboard lives in ChatGPT's sidebar. The only new account they may
ever create is Venice, and only if they choose it.

Today's proof: Jamie's ChatGPT (developer mode) connected to a fresh Olympus on
his Mac through `https://mcp.olympusplugin.ai/mcp`, answering a real question
with citations, with the dashboard rendered inside ChatGPT.

## Decisions (owner, 2026-10-01)

- ChatGPT only for now; Claude, Grok and Muse are out of scope.
- The engine runs on the user's Mac. No hosted Olympus.
- No extra installs (no Tailscale) and no new accounts except optional Venice.
- Default embeddings: a small model built into Olympus, zero setup. Other
  embedding providers stay an opt-in choice.
- Hosted relay at ONE fixed host, `mcp.olympusplugin.ai`, on Hetzner
  `olympus-relay-1` (CX23, nbg1). Secure MCP Tunnel is rejected for
  distribution (OpenAI: it "does not support public plugin submission").
- No pre-submission contact with OpenAI.
- Dashboard split: this lane owns the backend and the view-model contract;
  the UX lane owns `src/workers/dashboard/**`, the `ui://` HTML and digest pins.
- Setup lists local files and notes before Gmail and Drive (connector-policy
  posture: Olympus is a knowledge engine, not a connector).

## Platform facts this design depends on

- A public plugin has one MCP server at a stable public HTTPS URL; its host
  never changes. Local endpoints and tunnels are rejected for the directory.
- Auth is OAuth 2.1 + PKCE; ChatGPT identifies itself with a client metadata
  document (CIMD) or uses dynamic registration. Anonymous tools are allowed.
- UI is MCP Apps: `ui://` resources rendered in ChatGPT, calling `tools/call`
  over postMessage, fed by `structuredContent`. A global (sidebar) entrypoint
  opens an app fullscreen. ChatGPT caches resources for about an hour.
- Submissions may not contain `.app.json` or hooks today; developer mode is
  available on Plus, Pro, Business, Enterprise and Edu.
- The ChatGPT desktop app's Work/Codex modes can run shell commands on the Mac
  with user approval; that is the install path.

## Architecture

```
ChatGPT ──HTTPS──> mcp.olympusplugin.ai (Caddy: TLS, Let's Encrypt HTTP-01)
                     │ 127.0.0.1:8787
                     ▼
                   relay (Bun)  <══ WSS /v2/connect ══  engine relay client (Mac)
                                                          │ loopback HTTP
                                                          ▼
                                                        Olympus worker (/mcp, /oauth/*)
```

- **TLS ends on the relay.** One certificate for one name; no wildcard, no DNS
  credential on the server, no per-install certificates. The relay therefore
  sees MCP traffic in transit, as ChatGPT itself does. It stores no content,
  logs no content, bodies, tokens or query strings, and keeps routing state in
  memory except the install registry (install id → public key, revocation).
- **One outbound session per install.** The engine dials
  `wss://mcp.olympusplugin.ai/v2/connect`, proves its Ed25519 install key with
  the existing challenge/hello/register signatures (`connect-relay/shared/protocol.ts`,
  domain-separated as v2), and keeps the socket open with pings. The relay
  multiplexes HTTP requests over it as framed messages
  (`request` → `response-head` → `body-chunk`* → `end`, plus `cancel`), so
  Streamable HTTP and SSE responses stream. No separate data connections.
- **Per-request routing, never per-connection.** ChatGPT may reuse one TLS
  connection for many users, so every request is routed on its own:
  - `Authorization: Bearer oly2.<installId>.<secret>` → that install.
  - `POST /oauth/token` → the install named by the `code` or `refresh_token`
    prefix (`oly2c.<installId>.…`, `oly2r.<installId>.…`).
  - Static, install-independent documents are served by the relay itself:
    `/.well-known/oauth-protected-resource[/mcp]`,
    `/.well-known/oauth-authorization-server`, `/healthz`.
  - `GET /oauth/authorize` is the bridge page (below).
  - Anything else without a routable credential → 401 with the
    `WWW-Authenticate` resource-metadata pointer, or the not-linked MCP
    fallback once anonymous tools ship.
  The relay never mints, validates or stores tokens; the engine does. A token
  routed to install A but minted by B fails at A.
- **Authorization happens on the Mac.** The relay's `/oauth/authorize` serves a
  small page that sends the browser to the engine's loopback consent page
  (`http://127.0.0.1:<port>/oauth/authorize?<same query>`), with an "Install
  Olympus" fallback if nothing answers. The engine accepts authorize/consent
  only from DIRECT loopback requests: the relay client marks every relayed
  request with a per-boot secret header and strips any incoming copy, and the
  engine refuses consent for marked requests. Possession of the Mac plus a
  click is the proof of ownership: no pairing code, no account. The engine
  redirects to ChatGPT's `redirect_uri` with `code=oly2c.<installId>.<…>` and
  `iss=https://mcp.olympusplugin.ai`.
- **Clients are pinned.** Only ChatGPT's published client metadata URL(s) (and
  loopback dev clients) are accepted; the engine never fetches an arbitrary
  client's metadata, so a stranger cannot make the owner's Mac reveal its IP.
- **Offline fallback.** When an authorized request names an install with no
  live session, the relay answers MCP itself: `initialize`, `tools/list`,
  `resources/read` for the dashboard resource, and `tools/call` of the
  dashboard tool with `connection.state = "mac_offline"`. Every other tool
  returns a plain "Your Mac is offline" error. The relay ships the same
  `ui://` bundle as the engine for this.
- **Abuse limits.** Per-IP registration and session caps, per-install request
  rate and concurrency caps, request/response size caps, idle and total
  timeouts, a reserved concurrency slot for the owner's own dashboard tool.
  Revocation is durable (fsync'd append-only registry) before it is reported.
- **Issuer.** `https://mcp.olympusplugin.ai` for every install; resource
  `https://mcp.olympusplugin.ai/mcp`. Configured on the engine by
  `remote.relayHost`; never derived from request headers.

### What changes in the repo

| Area | Files | Change |
|---|---|---|
| Relay server | `connect-relay/server/**`, `connect-relay/shared/**`, `connect-relay/deploy/**` | Rewrite as v2: Bun HTTP behind Caddy, WSS sessions, framed request mux, static OAuth metadata, authorize bridge, offline fallback, limits, admin revoke. Delete SNI splice, DNS-01 and ACME paths. |
| Relay client | `connect-relay/client/**`, `src/core/native-relay-service.ts`, `src/core/remote-relay-runtime.ts`, `src/core/remote-access.ts` | WSS session, frame → loopback fetch, relayed-request header, status file. Delete local ACME/TLS. |
| Engine OAuth | `src/workers/remote-oauth/**`, `src/workers/remote-public-url.ts` | Prefixed codes/tokens, loopback-only consent, ChatGPT pin, relay issuer. Pairing codes retire from the relay path. |
| MCP surface | `src/workers/remote-mcp.ts`, new `src/workers/chatgpt/**` | Tool annotations, dashboard tool + `ui://` resource registration, sidebar entrypoint metadata, async answer pattern kept. |
| Dashboard contract | `src/workers/source-dashboard.ts` (contract), UX lane owns rendering | See below. |
| Built-in embeddings | `src/workers/source-index/**`, model profiles | In-process small embedding model as the default profile for new installs. |
| Standalone engine | `bin/olympus`, `src/core/worker-service.ts` | Run and supervise the worker without OpenClaw (launchd LaunchAgent). |
| Plugin package | new `chatgpt-plugin/` | `plugin.json`, `mcp.json` (`https://mcp.olympusplugin.ai/mcp`), skills (setup/install, how to ask), assets. |

## Dashboard view-model contract (v1)

Returned as `structuredContent` by the `olympus_dashboard` tool and rendered by
the `ui://olympus/dashboard` resource. All strings come from
`src/workers/dashboard/vocabulary.ts`; nothing tiered Private or Secret is
ever included, folder names included.

```ts
type ConnectionState =
  | 'not_installed'      // relay: no linked install for this caller
  | 'installing'         // engine: linked, first-run setup not finished
  | 'ready'              // engine: normal
  | 'mac_offline'        // relay: install known, no live session
  | 'relay_unavailable'; // UI only: tool calls to the relay fail

interface DashboardViewModelV1 {
  v: 1;
  connection: {
    state: ConnectionState;
    lastSeenAt?: string;             // ISO; mac_offline only
    action?: { id: 'install' | 'open_olympus' | 'wake_mac' | 'retry'; label: string; href?: string };
  };
  blocker?: { id: string; sentence: string; fix: Fix };   // at most one banner
  needsYou: Array<{ id: string; sentence: string; fix: Fix }>;
  sources: Array<{ id: string; label: string; status: 'ready' | 'working' | 'needs_you' | 'off'; detail?: string }>;
  progress?: { percent: number; itemsLeft: number; etaSeconds?: number; stalled: boolean; details: Array<{ stage: string; done: number; total: number }> };
  models: { embedding: { kind: 'built_in' | 'custom'; ready: boolean }; answers?: { label: string; ready: boolean } };
  generatedAt: string;
}
type Fix = { label: string; tool?: string; args?: Record<string, unknown>; href?: string };
```

`installing` covers model download, first index build and no source connected
yet. `relay_unavailable` is never sent by a server: the UI derives it from a
failed `tools/call`.

## Build sequence (today)

1. **Relay v2 + client v2 + engine OAuth** (critical path, critical-class).
   Deploy to `olympus-relay-1` with Caddy; prove with a local engine.
2. **MCP surface + plugin package**, in parallel with 1.
3. **Built-in embeddings**, in parallel with 1.
4. **Standalone engine on this Mac**: fresh install, LaunchAgent, relay link.
5. **Independent adversarial review** of relay + auth (Codex), fixes, then
   expose to ChatGPT.
6. **End-to-end**: Jamie adds `https://mcp.olympusplugin.ai/mcp` in ChatGPT
   developer mode, approves on the Mac, asks a question, opens the sidebar
   dashboard. Record the negotiated MCP protocol version.

Later: signed .pkg + installer skill (journey below), anonymous not-linked
tools, MCP Events, directory submission.

## Target user journey

1. Find Olympus in ChatGPT, add it.
2. The Olympus panel says "Install on your Mac"; ChatGPT's desktop agent runs
   the signed installer after the user approves (no admin password; per-user
   LaunchAgent).
3. The engine starts, links itself to the relay, and opens the approval page
   on the Mac; one click connects ChatGPT.
4. In the Olympus sidebar: local files and notes first, then Gmail, Drive,
   Dropbox with accounts they already have. Built-in embeddings start indexing.
5. Ask questions in ChatGPT.

## Security posture and residual risk

- A compromised relay can read traffic in transit and replay bearer tokens it
  sees, but cannot mint tokens, approve new clients (consent is loopback-only),
  or reach an engine except through the request API the engine already
  exposes to ChatGPT. Mitigations: minimal surface, no content logging,
  hardened host (key-only SSH from the owner IP, ufw, unattended upgrades),
  scripted deploy that pins the exact build, short access-token lifetime,
  owner-visible connection list with revoke.
- Codex's earlier findings that this design removes: DNS credential on the
  relay, control host inside the install zone, certificate quota exhaustion,
  CT watching. Findings it keeps and fixes: pairing-code phishing (replaced by
  loopback consent), client-metadata IP leak (pinning), per-key limits,
  durable revocation, log minimization, honest consent wording.
