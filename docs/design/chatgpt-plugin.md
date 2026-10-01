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

## Directory distribution (added 2026-10-01)

End users never use developer mode: they add Olympus from ChatGPT's plugin
directory. Developer mode, Plugin Creator, local marketplaces and workspace
sharing are only for testing before approval. Publisher: OCU Inc.
(platform.openai.com organization, verified identity required).

Three things the directory requires that the design above did not cover:

1. **Add before install (mixed auth).** A user adds the plugin before the
   engine exists. The relay serves a no-auth MCP surface for callers without a
   token: `initialize`, `tools/list`, the dashboard resource, and
   `olympus_dashboard` returning `connection.state = "not_installed"` with the
   install action. Tools that need the engine declare an OAuth security scheme
   (`securitySchemes: [{type:"oauth2", scopes:[...]}]`; `olympus_dashboard`
   also declares `noauth`), so ChatGPT starts the OAuth linking only when the
   user connects, after the engine is installed. Unlinked callers never
   reach an engine.
2. **Reviewer path.** OpenAI's reviewers need a test login that works
   immediately with no MFA, magic link or private-network step, and they
   have no Mac. A demo engine runs on the relay host (or its own small host)
   with synthetic sample data only, linked to the relay like any install.
   Its consent page is the one place consent may be granted by a
   username/password form over the relay; the flag that allows it
   (`remote.demoConsent`) is refused unless the install's data directory is
   marked demo-only, and is never on by default. Credentials go in the
   submission form, stored in 1Password.
3. **Submission package.** Domain verification
   (`/.well-known/openai-apps-challenge` served by the relay from config),
   `_meta.ui.domain`, support/privacy/terms pages on olympusplugin.ai, a demo
   video, 5 positive and 3 negative test cases, and the ZIP upload at
   platform.openai.com/plugins under OCU Inc.

## Dashboard view-model contract (v1)

Returned as `structuredContent` by the `olympus_dashboard` tool and rendered by
the `ui://olympus/dashboard` resource. All strings come from
`src/workers/dashboard/vocabulary.ts`; nothing tiered Private or Secret is
ever included, folder names included.

The TypeScript definition in `src/workers/chatgpt/dashboard-contract.ts` is
the contract (v1, agreed with the dashboard lane 2026-10-01). The UI holds
the copy for connection states; all other sentences come from
`vocabulary.ts`. The folder and mail pickers have their own data tools (see
"Setup from ChatGPT").

`installing` covers model download, first index build and no source connected
yet. `relay_unavailable` is never sent by a server: the UI derives it from a
failed `tools/call`.

## Setup from ChatGPT (added 2026-10-01)

Owner direction: a ChatGPT user does everything inside ChatGPT, with no
other dashboard. The UI lane renders it; this lane owns the tools and the
contract (`src/workers/chatgpt/dashboard-contract.ts`).

- **Answers: Olympus retrieves, ChatGPT reasons.** `olympus_search` returns
  the release-gated evidence for Public and Personal items (no Analyst on the
  Mac) and its description carries the generic Analyst instruction.
  Its coverage is counts-only fixed sentences: matches in folders set to
  Names only are said apart ("N matches are in folders set to Names only, so
  Olympus has their names but not their contents. Switch those folders to
  Full in the folder picker to let Olympus read them."), and "could not
  read" is kept for genuine failed reads. No folder name rides a coverage
  sentence.
  `source_answer` is listed only when an answer model is set up on the Mac.
  A fresh install is keyless: `olympus engine install` seeds the
  `no-sensitive` preset (built-in embeddings for every tier, nothing to
  supply) when `~/.olympus/sovereignty.json` is absent.
- **Connect** (`olympus_connect_source`): Gmail, Google Drive and Dropbox
  through Olympus's publisher apps. The engine starts the dashboard's own
  OAuth with the relay hand-back and returns a one-time link
  `https://mcp.olympusplugin.ai/go/oly2g.<installId>.<secret>` (10 minutes,
  single use, in memory). The relay routes it by install; the engine answers
  with a 302 to the provider. The provider returns to
  auth.olympusplugin.ai, whose page bounces to the state's origin, here the
  relay; the relay routes `/oauth/callback/<source>` by the install prefix in
  the signed state's nonce, and the engine verifies signature, nonce, origin
  (fixed at start) and freshness. This works from a phone and from any
  desktop, not only on the Mac; the non-loopback interstitial on the bounce
  page asks for one click. X (owner app) and the paired chats are set up on
  the Mac.
- **Keys:** none through ChatGPT (owner decision). Venice and Readwise are
  configured on the Mac only; `olympus_model_set` switches between models
  already set up there and never takes a key. Models are status only in the
  panel.
- **Folders and mail** (`olympus_scope_list`, `olympus_scope_set`): the Mac
  picker's data and compare-and-swap through the worker's own routes. Names,
  keys and cursors travel only in those results' `_meta` (owner decision:
  names may reach ChatGPT only through the picker); Secrets-tier locations
  (owner tier rules) are left out and their saved choices kept on save.
- **Fixes:** every Fix names a tool (connect, choose folders, disconnect,
  check again); none sends the owner to their Mac.
- `openExternal` domains: `mcp.olympusplugin.ai` and `olympusplugin.ai` only
  (`openai/widgetCSP.redirect_domains`).

## Private answer panel (added 2026-10-01)

Owner decision: a question that matches **Private** items can be answered
from them inside ChatGPT, but only in a panel. There is no option to put a
private answer into the normal chat. Secret items are never answered from.

### What the user sees

ChatGPT calls `olympus_search` (the primary answer tool) or `source_answer`;
both carry the same hook and link the `ui://olympus/private-answer` panel on
every result. ChatGPT's model gets Public and Personal evidence as before and
**nothing** about a private match: no count, no state, no note (review
2026-10-01: a model-visible count is an oracle for testing queries against
Private holdings). The count and state travel only in the widget-only
`_meta`; with no match the panel renders nothing (zero height). With one,
the panel says "N private items match", carries the badge **"Not sent to
ChatGPT"**, and offers **Show private answer**. On click, the panel fetches
the answer itself, from the relay, and shows it as text.

The `_meta` state is `ready` (a private model is ready; a job exists),
`no_model` (no private model set up; counts only, no job) or
`model_downloading` (the built-in private model is downloading, with a
percent when known; counts only, no job).

### Protocol

1. **Match.** The surface searches each Private corpus (`all_tiers: false`,
   up to 10 hits per corpus, so no Secret location and no other tier comes
   back). The count leaves the engine; the hits stay in the engine.
2. **Job.** When a private model reports `ready` and the engine has a relay
   install id, the engine creates a one-time job with id
   `oly2p.<installId>.<32 random bytes>` (routable like tokens:
   `connect-relay/shared/tokens.ts`) as the answered tool result is built,
   so the id is valid only from the moment ChatGPT can see it (a handed-off
   answer creates it at `source_answer_result`, not at `source_answer`). It
   holds the question in memory only, for at most **10 minutes** from
   creation.
3. **Tool result.** The answer tool's result `_meta["olympus/privateAnswer"]`
   is `{v:1, count, state, jobId?, percent?}` and nothing else (the response
   builder copies exactly these fields). `_meta` is widget-only: ChatGPT does
   not put it in the model's context. The job id never appears in the text
   content or `structuredContent`. There is no key and no fetch token in
   `_meta`, or anywhere in any tool output.
4. **Claim.** On click the panel generates an ephemeral **ECDH P-256** key
   pair with WebCrypto (private key non-extractable) and POSTs only its
   public key, directly to `https://mcp.olympusplugin.ai/private/<job id>`
   (`fetch`, allowed by the resource's `_meta.ui.csp.connectDomains`), not
   through `tools/call`. The first public key to arrive claims the job;
   another key gets **409 `claimed`**, the panel says "This private answer was
   already opened elsewhere", and the Mac writes a content-free local audit
   line. Claiming starts the private model (one analysis at a time), so a
   match the user never opens costs no model time.
   - **Evidence at claim time.** The Private search runs again when the job
     is claimed, so every item is judged at its current tier; anything not
     Private-eligible now (re-tiered to Secret, or out of the Private tier)
     is dropped, and the search-time hits are not trusted. No eligible item
     left means `failed`.
   - **Hard deadline.** One analysis (refresh plus model) has a deadline
     enforced outside the model call (default 5 minutes): the engine marks
     the job `failed` and frees the slot first, then runs the model's
     `reset()` in the background with its own timeout to kill or reset its
     runtime. The next analysis waits for that reset (bounded by its
     timeout), so two inferences never overlap and the reset cannot kill the
     next job. Inference never starts after the deadline, even when the
     evidence refresh returns late.
   - **Claim budget.** An unknown, expired or wrong-install id answers 410
     without spending the install-wide claim budget, so made-up ids cannot
     lock out a real panel. The claim-time search on a pinned Private corpus
     passes the tier ledger's visibility gate too, so an item re-tiered
     since the search is never read.
5. **Poll.** While the model works, the same key gets **202 `pending`** with
   `Retry-After: 2`; the panel polls with the same key.
6. **Collect.** When done, the engine generates its own ephemeral P-256 pair,
   derives `HKDF-SHA256(ECDH(mac, panel), salt = empty, info = job id)` as an
   AES-256-GCM key, seals `{v:1, answer, citations, unanswered?}`, padded
   with trailing spaces to 1, 4, 16 or 64 KiB (then multiples of 64 KiB) so
   the ciphertext length tells the relay only the bucket, with a random 12-byte IV
   and the job id as additional data, and answers **200**
   `{status:"ready", v:1, macPublicKey, iv, ciphertext}`. The panel derives
   the same key and decrypts locally. Collection is **idempotent for the
   claiming key until expiry**: a replay of the panel's request (by the
   relay, or anyone who saw it) gets the same sealed bytes, which only the
   panel's private key opens, so a replay cannot consume or destroy the
   answer. A model failure answers `200 failed`, also idempotently.
7. **Expiry.** Ten minutes after creation the job is deleted; then, as for
   unknown and wrong-install ids, every request gets **410 `gone`** (one
   answer for all, so the endpoint is no oracle). Pending polls by the
   claiming key are rate limited per job (429 with Retry-After) and never
   delete the job: expiry alone ends it.

Wire statuses (`connect-relay/shared/private-answer.ts`): `ready`, `failed`,
`pending` (202), `claimed` (409), `gone` (410), `invalid` (400/405/413),
`forbidden` (403), `rate_limited` (429), `mac_offline` (503, from the
relay), `busy` (503).

### Relay

- `/private/<id>` is routed by the install prefix of the job id, like
  `/mcp` by its token; exactly that path shape, POST only, no query string,
  a 512-byte body cap, and a per-address rate limit (`privateFetchesPerIp`,
  30 burst, 1/s) on top of the per-install admission lanes.
- CORS is answered by the relay, for ChatGPT widget origins only:
  `https://web-sandbox.oaiusercontent.com`, one DNS label under it, and the
  plugin's dedicated `_meta.ui.domain` (the relay origin). OpenAI documents
  the sandbox default; the exact per-app origin when a dedicated domain is
  set is not documented, so this list must be confirmed against a live
  panel before directory submission. CORS keeps other web pages out; it
  does not stop a non-browser caller, and nothing below relies on it to.
- Logs carry only the install's hashed tag, never the job id.
- Mac offline: the relay answers `503 mac_offline` (with CORS) and the panel
  says the Mac is offline. The relay's offline MCP fallback serves the panel
  resource too, from the generated relay assets.
- The install's relay client forwards exactly `POST /private/oly2p.…`; the
  engine serves it only to relayed requests from an allowed Origin.

### Who can read the answer

- **OpenAI** sees the tool result, `_meta` included, so it knows the job id
  and the count (the model does not: `_meta` stays out of its context). It never sees the panel's private key or the sealed answer
  (the fetch goes from the user's browser to the relay, not through
  ChatGPT's tool channel).
- **The relay** sees the panel's public key, the engine's public key and the
  ciphertext. Neither private key ever reaches it, so it cannot decrypt.

Residual risks, stated plainly:

- **A compromised relay could swap keys** (man in the middle: answer the
  panel with its own key and claim the job from the engine with another).
  Nothing authenticates the engine's key to the panel. This is the same trust
  we already place in the relay for all MCP traffic, which it sees in
  transit.
- **OpenAI serves the panel's HTML** and could alter it (or its sandbox could
  be compromised) to exfiltrate the decrypted answer. A party that both knows
  the job id (`_meta`) and can act first can also claim the job itself; the
  owner's panel then shows "This private answer was already opened
  elsewhere" (409) and the Mac logs a content-free audit line, which is
  tamper-evident but not preventive. Full prevention is impossible while
  OpenAI serves the panel. Speed bumps: the engine and relay accept claims
  only with a ChatGPT widget Origin (a non-browser caller can forge it, so
  this is not a barrier), the id exists only from the moment the tool result
  is built, and it expires after ten minutes.
- A party that sees both the relay's traffic and the panel's memory sees
  everything.
- The panel's browser holds the decrypted answer in memory while it is
  shown.

Because of these, the badge says **"Not sent to ChatGPT"**, never
"end-to-end encrypted". What the design guarantees is narrower and true: the
private answer is never ChatGPT tool output, never enters the model's
context, and never transits OpenAI's servers.

### Ownership and handoff

- This lane: `src/workers/chatgpt/private-answer-{contract,crypto,jobs}.ts`,
  the response-builder fields, the relay route, and the placeholder page in
  `src/workers/chatgpt/private-answer-resource.ts`, the single module the
  dashboard lane replaces (like `dashboard-resource.ts`). The contract is
  `private-answer-contract.ts`.
- The private-model lane's built-in model backs `PrivateAnswerModel`
  (`src/workers/chatgpt/private-answer-model.ts`): `status()` is `ready` once
  the model is downloaded, verified and prepared, `model_downloading` while
  it installs, else `no_model`; `answerPrivately` maps the Private hits to
  `analyst-built-in.ts answerPrivately` and its answer, citations and
  unanswered gaps into the sealed payload; `reset()` stops the model server.
  The worker shares one built-in model instance between the panel, the tier
  sniffer (registered before the sniffer is resolved) and the Private answer
  pool's fallback.
- The panel builds a fetch URL only from a job id of the exact routable
  `oly2p.` shape.

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

7. **Directory submission** under OCU Inc.: no-auth surface, reviewer demo
   engine, domain verification, listing pages, ZIP upload.

Later: signed .pkg + installer skill (journey below), MCP Events.

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
