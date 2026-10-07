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
  posture: Olympus is a knowledge engine, not a connector). Not delivered in
  1.0: no local files or notes source exists yet, so the listing, skills and
  site name Dropbox, Gmail and Google Drive, plus the sources set up on the
  Mac (review 2026-10-02 #12).

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
  domain-separated as v2 and bound to the relay host), and keeps the socket
  open with pings. The relay
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
  engine refuses consent for marked requests, whatever the marker's value. A
  direct request must also come from a loopback peer address (not only a
  loopback Host), and the approve POST must be the browser's own navigation
  from the page (`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate`).
  Possession of the Mac plus a click is the proof of ownership: no pairing
  code, no account. See "Open decision: an owner-held approval" below.
- **The ChatGPT surface is chosen by a verified marker and a pinned grant.**
  The relay child writes its per-boot secret 0600 to the remote-access
  directory (`connect-relay/relay-secret`, removed when it stops); the worker
  compares the marker to it in constant time. The ChatGPT surface (setup
  tools, the private answer panel) and `/private/<job>` are served only when
  the marker carries that secret AND the request's credential is an OAuth
  grant to a pinned ChatGPT client. A bearer connection or a tunnel-token
  holder that adds the header gets the remote operation surface. A demo
  sign-in grant (named "ChatGPT (demo sign-in)") gets only the read-only
  tools. The engine
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
  Hardened after the 2026-10-02 review (`connect-relay/server/limits.ts`,
  `server/response-policy.ts`):
  - **Install answers are untrusted content on the relay origin.** Every one
    gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
    and a relay Content-Security-Policy beside the install's own:
    `sandbox; default-src 'none'` (opaque origin, no script) everywhere but
    the operator's demo sign-in, which keeps its origin and may submit its
    form but runs no script. API routes serve JSON, event streams or text
    and never redirect; browser routes (`/go/…`, `/oauth/callback/…`) serve
    HTML, text or JSON and redirect only to Google's and Dropbox's sign-in,
    the engine's loopback port, or the relay. Anything else, and any header
    the platform would refuse, is a 502 and the install is told to stop. A
    `Service-Worker: script` request is refused on every route.
  - **Uploads** are charged as bytes arrive (a declared length reserves at
    most a 16 KiB first block), with a per-address byte cap of at most a
    sixteenth of the relay-wide one, and a 64 KiB cap for the relay's own
    credential-less `/mcp` answers. A body stays charged, trimmed to its
    size, for as long as the relay holds it: while it waits for an admission
    slot, is forwarded, and until the install's stream is over (Codex review
    2026-10-02); a body that does not fit is a 503. `admin status` shows the
    bytes held.
  - **Sessions.** Unauthenticated sockets have their own pool (1,024); when
    it is full the oldest is closed, so stalled sockets cannot keep a real
    install out, and they never count against session capacity. Connect
    attempts and registrations are keyed by IPv6 /48.
  - **Registrations** of an install id the relay has never registered
    need a proof of work bound to the session nonce (16 bits, about 0.1-0.3
    s on a Mac); a registered or returning install (registered here before,
    since expired) re-registers without one, and returning installs draw on
    a budget of their own; an install answers one challenge per session and
    its solver stops when the handshake times out, closes, or the client
    stops; a
    registration never confirmed by a later `hello` (and not online) expires
    after a day; an exhausted relay-wide budget logs `budget_exhausted` once.
  - **Signatures** bind the relay host the install dialed, so a challenge
    from one relay cannot be answered through another (signature scheme 3;
    see "Relay protocol compatibility" for the migration from scheme 2).
  - **Egress.** Response bytes are budgeted per caller address (generous:
    ChatGPT calls from shared addresses) and relay-wide, in every lane: the
    owner lane rests on a marker the install sets itself.
  - **Accepted: install presence is observable.** Anyone holding an install
    id (it is in every token and hand-off link the install issues) can tell
    whether it is unknown, registered but offline, or online, from which of
    the relay's or the engine's answers comes back. Ids are 160-bit and not
    enumerable, the answers name nothing about the owner, and hiding presence
    would cost the offline fallback ChatGPT relies on, so this stays.
- **Issuer.** `https://mcp.olympusplugin.ai` for every install; resource
  `https://mcp.olympusplugin.ai/mcp`. Configured on the engine by
  `remote.relayHost`; never derived from request headers.

### Relay protocol compatibility (added 2026-10-02)

The relay and the Mac's relay client ship separately (the relay by
`connect-relay/deploy/deploy.sh`, the client inside each Olympus release), so
any pairing of a current and a previous release must connect, whichever is
deployed first. Both still speak wire protocol `v: 2`; what changed on
2026-10-02 is the session signature, and that is negotiated on its own:

| Signature scheme | Signed payload | Who speaks it |
|---|---|---|
| 2 (legacy) | domain, kind, nonce, install id | relays and installs from before 2026-10-02 |
| 3 (bound) | the same plus the relay host the install dialed | current relays and installs |

- **The relay advertises; the install names.** A current relay's
  `challenge` carries `auth: 3`; a current install's `hello`/`register`
  carries `auth: 3`. A relay from before negotiation advertises nothing.
- **Current install, old relay.** The install always answers with scheme 3
  first. If a relay that advertised no scheme rejects it (`bad_signature`),
  the install retries at once with the scheme-2 form (no `auth`, no proof of
  work: byte for byte what an old install sends), and keeps using it for
  that relay until a challenge advertises a scheme. A rejected scheme-2
  answer clears the fallback, so it is never a loop. A relay that advertises
  scheme 3 never gets a scheme-2 answer.
- **Old install, current relay.** The relay accepts scheme 3 always (also
  without the `auth` field, from installs released between the binding and
  negotiation). It accepts scheme 2 only from an install id it already knows
  (registered, or registered before and expired) and only while the legacy
  window is open (`acceptLegacyAuth`, default on; `RELAY_LEGACY_AUTH=off`
  closes it). A scheme-2 session logs `session_ready` with
  `legacy_auth: true`.
- **Proof of work is for new ids only.** A `register` of an id the relay has
  never registered needs the proof of work and scheme 3. A registered or
  returning id re-registers without it (the id is derived from the key, so
  only its holder can claim it; returning ids keep their own budget). An old
  install can therefore re-register a known id, but cannot register a
  brand-new one: new installs run current releases.
- **What the window costs.** While it is open, the attack the host binding
  exists to stop is still possible against an install the relay knows: a
  hostile relay that an install dials (one it is configured for) can pass
  the real relay's challenge through and replay the unbound answer. An old
  install answers unbound anyway; a current one does so only after the
  relay it dialed advertised nothing and rejected scheme 3, which a hostile
  relay can fake. Closing the window on the real relay ends this for every
  install, which is why it has a sunset.

**Sunset.** The window closes (`RELAY_LEGACY_AUTH=off` in the relay unit,
then the scheme-2 acceptance in the relay and the client's scheme-2
fallback are deleted in a later release) at the first
relay deploy after both hold: no `legacy_auth` session in the relay log for
14 consecutive days, and the oldest supported Olympus release is one that
speaks scheme 3. Target: no later than 2026-12-31; if `legacy_auth` sessions
are still seen then, the owner decides between extending the window and
cutting those installs off (they recover by updating Olympus).

**Rollback policy.** Either side may be rolled back independently, at any
time, with no coordinated step:

- Relay rolled back to a pre-negotiation build: current installs fall back
  to scheme 2 on their next connect (one extra round trip); registrations
  made by the current relay stay valid (the registry format is unchanged).
- Client rolled back (`olympus engine rollback`, or the installer restoring
  `app.previous`): the pre-binding client reconnects with scheme 2, which a
  current relay accepts for its already-registered id while the window is
  open. After the sunset, rolling a Mac back to a pre-binding release is
  not supported; update it instead.
- Re-deploying a current relay after a relay rollback needs nothing: clients
  see the advertisement again and answer with scheme 3.

The mixed-version handshake is proven in
`connect-relay/test/relay-compat-and-budgets.test.ts` (an old install against
the current relay, and a current install against a scheme-2-only relay).

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
   `olympus_dashboard` returning `connection.state = "not_connected"` with the
   `connect` action and an `installHref` (a caller without a token cannot be
   told apart from an owner who installed Olympus but has not linked ChatGPT
   yet), plus the same `_meta["mcp/www_authenticate"]` challenge the protected
   tools send, so ChatGPT offers Connect. Tools that need the engine declare an OAuth security scheme
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
  the release-gated evidence for Personal items, and Public items on a
  policy that still has a Public tier (no Analyst on the
  Mac) and its description carries the generic Analyst instruction.
  Its coverage is counts in `structuredContent.coverage` (unreadable,
  partly read, Names only, not yet sorted into privacy tiers) with a
  model-facing `instruction`: "Mention coverage only if the user asks why
  something is missing or the answer depends on it." (owner report
  2026-10-02: ChatGPT recited "3 unreadable, 8 names-only, 6 await privacy
  classification" as if they were errors). The tool text carries no coverage
  line while the private answer panel is answering, and one terse line
  otherwise. The Names-only sentence ("N matches are in folders set to Names
  only, so Olympus has their names but not their contents. Switch those
  folders to Full in the folder picker to let Olympus read them.") appears
  only when Names-only matches are why nothing was answered (no released
  item had readable text). No folder name rides a coverage line.
  "Not yet sorted into privacy tiers" counts only items with an open tier
  question (`tier_copies.embed_hold`); an item decided after such a question
  is never left held (see the tier ledger's `completeMove` hold and its
  settle-at-open of stale holds).
  `source_answer` is listed only when an answer model is set up on the Mac.
  A fresh install is keyless: `olympus engine install` seeds the
  `no-sensitive` preset (built-in embeddings for every tier, nothing to
  supply) when `~/.olympus/sovereignty.json` is absent and nothing else on
  the Mac already chooses a policy (an Olympus entry in openclaw.json, the
  legacy worker LaunchAgent, or policy variables in worker.env); otherwise it
  skips the seed and says why, since every worker on the Mac reads that file.
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
- **Privacy is the owner's** (review P-1, 2026-10-02): `olympus_privacy_set`
  is hidden from the model (`openai/visibility: private`, `ui.visibility:
  ["app"]`, widget-accessible) and marked destructive. The engine also
  refuses any save that removes a saved rule or changes the owner's
  description unless it carries the confirmation `olympus_privacy_get` hands
  the widget in `_meta` (30 minutes, single use; `_meta` never reaches the
  model). Adding rules needs no confirmation. The model reads the settings
  with `olympus_privacy_get` and sends the owner to the panel's Set up
  privacy to change them.
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
every result. ChatGPT's model gets Personal (and, where the policy keeps it,
Public) evidence as before and
**one bit** about a private match: a fixed note that some matching items are
Private and that Olympus answers from them only to the user, in the panel
(owner decision, Jamie, 2026-10-02, superseding the 2026-10-01 "nothing"
rule). The note also tells the model not to ask the user to upload, attach
or paste those files, and that a follow-up is answered privately in the
panel the same way, from a search with the follow-up as a complete question,
with `detail: "full"` when the user asks for every detail (the panel sees
only the search's question, not the conversation; owner
report 2026-10-02: ChatGPT asked the user to "attach the June report or
paste its text"). Without it, the model saw only Personal titles and coverage gaps for
those items, told the user Olympus "returned only its title", and sent them
to switch folders to Full, while the answer sat in the panel. The note has
no count, no title and no content (review 2026-10-01 still holds: a
model-visible count is an oracle for testing queries against Private
holdings; one bit per question is the accepted cost). Its text is fixed per
panel state (`response-builder.ts` `privateMatchNote`): answering in the
panel (`ready`), the panel explains setup (`no_model`, `model_downloading`),
or no panel came back in time but released coverage shows matches whose
contents are tiered Private. Matches whose name is Personal and whose
contents are Private are counted apart from Names-only and unreadable items,
so no coverage note tells the user to change folder settings for them.

**Names Personal, contents Private.** Owner ruling (2026-10-02): a Private
item's *name* may remain Personal, and that name may appear in ChatGPT
elsewhere (for example in a Personal listing, or as a Personal match for
another question). What is left out is narrower: `olympus_search` and
`source_answer` do not list a name-only copy as *evidence* when that item's
contents are held Private (`EvidencePackBuildDetail.contentPrivateCandidateIndexes`,
the `contentPrivate` content block). Such an entry has nothing behind it but
a file name, and ChatGPT reported it as a finding ("found the file but
returned only its filename"); its contents are answered in the panel
instead. It is still counted (`coverage.content_private_items`), which is
what lets the no-panel note say Private items matched. This is a
presentation rule for evidence, not a change to what tier a name has.

**What counts as a match** (2026-10-02). A Private match is a Private item
the shared retrieval would hand an Analyst as evidence, under the same
relevance floor as every other search: query words that carry no topic
("what do I have about", "files", "show") are not search terms; a keyword
match must contain every concept of the question (three of a longer one),
or concepts that carry most of its weight (rare words count more than
common ones); and a vector match must clear its model's calibrated bar (the
built-in model's is 0.40 best-cosine, calibrated on the owner's corpus
copies: off-topic questions peak at 0.39). Before this, the built-in
model's nearest neighbours and words like "do" and "about" made every
non-empty Private corpus match every question (live smoke: every question
reported 12 Private matches and the panel answered "these private items do
not answer this question"). With no item above the floor there is no panel
and no note. Within the floor, an item matching the whole question ranks
before one matching part of it, and a readable item before a name only
among equals (a Personal "integral theory" search had seven diet guides,
matched on "do", "have" and "about", above every file named for the
topic). A probe that times out (20 s) or fails leaves one counts-only line
(`[chatgpt] private match probe timed_out stage=search timeout_ms=20000`),
and the built-in embedding model is loaded and warmed at start and runs a
question's forward pass before any waiting indexing pass, so a search no
longer waits behind indexing after a restart.

With the panel `ready`, the note steers ChatGPT to a short reply along the
lines of "Olympus is preparing your answer privately on your Mac; it'll
appear in the panel above, visible only to you (it can take up to a
minute)", with no commentary on other search results unless they actually
answer the question and no coverage counts, unread items or file names. A
`detail: "full"` request says a full read can take a few minutes instead.
The search text's leading instruction becomes "use this evidence only where
it actually answers the question", and the held-back and Names-only
sentences are left out: the reply is "see the panel". The
count and state travel only in the widget-only `_meta`; with no match the
panel renders nothing (zero height). With one, the panel is a compact card,
**"Private answer from your Mac"**, that collects the answer itself, from
the relay, as soon as a `ready` result renders (no Show button,
since 2026-10-01), and shows it as text under the badge
**"Not sent to ChatGPT"**. **Hide** folds it to "Private answer hidden";
**Show** re-opens the in-memory answer without a refetch. The panel keeps
its key pair per job id in its own IndexedDB (non-extractable), so ChatGPT's
re-mounts of the widget claim with the same key.

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
   - **Precompute (2026-10-02).** The job's private analysis starts as the
     job is created, from the search-time Private evidence, while ChatGPT
     is still writing its own reply (often 30-50 s), so the panel's answer
     is usually ready before the panel renders. Owner report: the user
     waited for ChatGPT and then about 30 s more for the panel, and earlier
     logs showed panels queued 44-58 s behind each other. The plaintext
     answer stays in the engine's memory only; it is sealed to a key only at
     claim, after the claim-time check (step 4). ChatGPT often calls
     `olympus_search` several times in one turn: a newer job from the same
     connection supersedes that connection's older precomputes (a queued
     one never runs, a running one is aborted; a superseded job whose panel
     is claimed anyway is computed then), an identical question (case and
     spacing aside) within 3 minutes shares one analysis, and an unclaimed
     precompute that has not started within 2 minutes of its search is
     abandoned. Claimed work runs before precomputes, the newest precompute
     first. An unclaimed precompute's answer is freed when its job expires.
     While an analysis runs it counts as answer activity, so the tier
     sniffer yields the shared model to it.
3. **Tool result.** The answer tool's result `_meta["olympus/privateAnswer"]`
   is `{v:1, count, state, jobId?, percent?, detail?}` and nothing else (the response
   builder copies exactly these fields). `_meta` is widget-only: ChatGPT does
   not put it in the model's context. The job id never appears in the text
   content or `structuredContent`; the only match signal there is the fixed
   Private note above. There is no key and no fetch token in
   `_meta`, or anywhere in any tool output.
4. **Claim.** When a `ready` result renders, the panel generates an ephemeral
   **ECDH P-256** key pair with WebCrypto (private key non-extractable; kept
   per job id in the frame's IndexedDB for re-mounts) and POSTs only its
   public key, directly to `https://mcp.olympusplugin.ai/private/<job id>`
   (`fetch`, allowed by the resource's `_meta.ui.csp.connectDomains`), not
   through `tools/call`. The first public key to arrive claims the job;
   another key gets **409 `claimed`**, the panel says "This private answer was
   already opened elsewhere", and the Mac writes a content-free local audit
   line. Claiming seals the precomputed answer once it is ready and still
   valid (below); without one (no precompute, superseded, abandoned or
   discarded), claiming starts the private model for this job, ahead of any
   precompute (one analysis at a time).
   - **Evidence at claim time.** The Private search runs again when the job
     is claimed, so every item is judged at its current tier; anything not
     Private-eligible now (re-tiered to Secret, or out of the Private tier)
     is dropped, and the search-time hits are not trusted. A precomputed
     answer is sealed only when every item it read (the model reports which
     of the hits it read; matched by source item identity) is still among
     the Private-eligible items; otherwise it is discarded and the answer is
     computed again from the current evidence. No eligible item left means
     `failed`.
   - **Live eligibility at every model input (2026-10-05).** Searches only
     propose evidence; whether an item may be read is decided by one live
     guard (`checkPrivateEvidenceItems` in
     `src/workers/source-index/analyst-answer.ts`), asked per item from live
     state with no search and no cache: the item's corpus is still a
     registered Private corpus, and its store would serve its content now
     under the owner's current read scope (`contentServable` in
     `connector-store/local-index.ts`: the scope filters, then one item row
     and one tier-ledger read, no chunk text loaded): the item exists and is
     not tombstoned, its stored tier is a known tier below S5, no
     metadata-only owner rule covers its path (evaluated at read time, so
     the rule applies before any strip has run), it still has stored text,
     and the store's copy is current WITH the content layer, so a move to
     Secrets, or a copy that serves only the names, refuses it. Anything it cannot vouch for (an error, a missing
     corpus or provider, an item without its store identity) is not eligible.
     It is asked immediately before every model submission, with only promise
     continuations (no I/O, no timer) between its answer and the submission:
     when an analysis is dispatched (a refused item's cached text then leaves
     the job), before the panel's document embeddings (after the question's
     embedding), before the depth re-read and before the answer (which also
     re-counts matched items with no readable text), and inside every
     answer-model call (main call, any retry or audit; one refusal stops the
     answer). It is asked again before an answer is sealed, after sealing,
     and on **every** later hand-out of the sealed answer and every source
     open: an answer that read an item no longer eligible is withdrawn for
     good (its sealed bytes, item identities and open tokens are dropped, the
     job answers `failed`; a precompute discarded before sealing is computed
     again once from the claim's evidence). Kept answers and sealed jobs hold
     the items' identities only, not their text. A depth re-read that the
     store refuses, or denies by policy, drops the item; one that fails
     otherwise or comes back empty keeps the item's earlier passages only if
     the guard confirms it after the read. A dropped item is not counted as
     read, as unreadable, or as a source.
   - **What the guard does not do (residual).** It cannot recall text
     already handed to the on-device model when a tier change lands after
     that hand-off (or in the continuations between the guard's answer and
     the hand-off), including while the request waits in the embedding or
     model server's own queue. A running analysis is not cancelled on
     revocation; its answer is discarded at sealing. An answer the panel has
     already decrypted and shown cannot be recalled. Owner rules are not
     evaluated here: an always-Secret or always-Private owner rule takes
     effect when the background rules sweep re-classifies the item (once
     per sniffer tick, every 60 s, up to 1,000 items per pass, so a large
     backlog takes several minutes; an item never routed through the tier
     ledger waits for its next listing); search has the same window.
     Metadata-only owner rules, by contrast, apply at read time here: an
     item they cover is refused at once, even before its text is stripped.
     The guarantee is that no hand-off starts with an item the guard has
     just refused, and no answer derived from a now-ineligible item is
     released after the guard refuses it. Cost: one batched per-item lookup
     (a row and a ledger read) at dispatch, embeddings, depth read, answer,
     each model call, before and after sealing, and each later hand-out or
     open. Reviewer findings (2026-10-05): a precompute dispatched after its
     item became Secret sent the cached text to the model; a single re-check
     at dispatch also missed a claim's retry, revocation during hydration or
     the question embedding, a stale claim-time set at sealing, policy-denied
     depth reads, partial re-checks, and later hand-outs of a sealed answer.
   - **Hard deadline.** Every claim settles `ready` or `failed` within a
     deadline counted from the claim (100 s, inside the panel's two-minute
     wait), and each analysis has the same bound from its start, both
     enforced outside the model call: the engine marks the analysis failed
     and frees the slot first, then runs the model's `reset()` in the
     background with its own timeout to kill or reset its runtime. The next
     analysis waits for that reset (bounded by its timeout), so two
     inferences never overlap and the reset cannot kill the next job.
     Inference never starts for a claim after its deadline, even when the
     evidence refresh returns late.
   - **What the model reads.** The panel's model reads at most 4 readable
     items: the hits ranked by relevance to the question (the cosine
     similarity of the question to each item's name, weighted 0.7, and to
     its name plus the first 400 characters of its passages, computed by the
     Private corpora's embedding model and only when it runs on this
     computer; retrieval order otherwise), cut 0.04 below the best item (on
     a real store, items about the asked subject scored within 0.035 of each
     other, the nearest other item 0.041 or more below). They are rendered
     compactly for the small model: per item its number and name, one line
     of date, source and folder, then its passages as quoted `source_data`,
     under the same Analyst instruction worded for that list (answer from
     this evidence only, cite, say what is missing). Measured 2026-10-02 on
     a real Private store: a ChatGPT-rewritten query ranked two dated
     reports from other months first by retrieval, and the small model
     answered from them; by name similarity the right files led with a clear
     margin, and the prompt shrank from about 3,700 to about 1,600 tokens.
   - **Detail: summary or full (2026-10-02).** `olympus_search` and
     `source_answer` take an optional `detail` argument, `"summary"`
     (default) or `"full"`, which ChatGPT's model sets: its schema says to
     use `"full"` when the user asks for all the details, the full results,
     every value or similar, including a follow-up asking for more. Olympus
     never parses the question for it. The job keeps it, the dedupe key
     includes it, and a full job's `_meta` carries
     `olympus/privateAnswer.detail: "full"` (absent for summary) so the
     panel can wait longer.
     - *Leading items (both modes).* When the top one or two items clearly
       lead (the drop from the k-th to the next item is at least 0.01 and at
       least the spread among the k; or only one item is readable), only
       they are read; an item merely within the 0.04 floor of them is left
       out (live: an April report listed as a source of a June answer).
     - *Summary.* The leading items are re-read for their best passages
       within 5,000 characters (results pages rather than page headers;
       otherwise the search-time passages), under the 11,000-byte prompt and
       1,000-character answer budget. Fast, like the panel before.
     - *Full.* The items read are re-read whole, when they fit 7,000
       characters together (layout whitespace compacted), else the shorter
       whole and the rest at an equal share of the remainder, for their best
       passages; the prompt ceiling is 11,500 bytes and the answer about
       1,500 characters. Its analysis and claim deadline is 240 s
       (`PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS`) instead of 100 s; the
       panel must wait a little longer (250 s,
       `CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS`, owned by the panel). Owner report: "can you
       give me all the details from that lab please?" reached the panel as
       four thin slices of four items and was answered "the provided evidence
       does not contain the details". Live 2026-10-02: 10,000 characters and
       a 2,000-character answer took 179.4 s of the then 180 s deadline on a
       loaded Mac (prefill 64 s for 3,920 tokens, 2.8 tokens/s).
     The Analyst instruction allows a longer answer only when the question
     asks for details, all results or a full list (one generic sentence).
   - **Sources.** Only the items the answer cites are its sources. Each
     carries its title and, when it can, where it opens
     (`citations[].open`): `{kind:"mac", token}` when the file is synced to
     this Mac (a Dropbox file found under the Dropbox folder recorded in
     `~/.dropbox/info.json`, `~/Library/CloudStorage/Dropbox*` or
     `~/Dropbox`), else `{kind:"web", url}` (for Dropbox,
     `https://www.dropbox.com/home<folder>?preview=<name>`). The panel lists
     them under a collapsed "Sources" toggle, not in every reply.
   - **Gaps.** The `unanswered` lines are whole sentences: the schema bounds
     the list (3 entries) with room for a sentence each, an entry the
     grammar cut at its bound is dropped, an entry whose specific words
     (names, numbers, dates) all appear in the answer is dropped as a
     restatement, and there are none when the model calls its answer
     complete. Owner report: "Specific arsenic value for June 2026 is" (cut
     at the old 40-character bound) beside an answer that gave it.
   - **Timing log.** Each settled claim logs one content-free line:
     `[private-answer] outcome=… precomputed=yes|no wait_at_claim_ms=…
     search_to_ready_ms=… queued_ms=… refresh_ms=… recheck_ms=… dropped=…
     matched=… items=… evidence_bytes=… model_ms=… main_…` (`recheck_ms`
     is the dispatch-time eligibility check, `dropped` the items it dropped). `wait_at_claim_ms` is what the
     panel waited after its claim; `search_to_ready_ms` is from the search to
     the answer being ready.
   - **Claim budget.** An unknown, expired or wrong-install id answers 410
     without spending the install-wide claim budget, so made-up ids cannot
     lock out a real panel. The claim-time search on a pinned Private corpus
     passes the tier ledger's visibility gate too, so an item re-tiered
     since the search is never read.
5. **Poll.** The claiming POST holds up to 1.5 s for the answer (the
   claim-time search and the seal), so a precomputed answer reaches the
   panel in its first response. While the model still works, the same key
   gets **202 `pending`** with `Retry-After: 2`; the panel polls with the
   same key.
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
7. **Open a source on the Mac.** A source with `open: {kind:"mac", token}`
   opens with `POST https://mcp.olympusplugin.ai/private/<job id>/open` and
   body `{"v":1,"open":"<token>"}`; the engine runs macOS `open` on the file
   it mapped that token to and answers **204**. The token is 32 random bytes
   minted for this job when its answer is sealed (a shared analysis gives
   each job its own tokens), mapped to a path that stays in the engine's
   memory, and dropped with the job. No path is ever read from a request:
   an unknown token, another job's token, an expired job or another install
   all answer **410 `gone`**; a malformed body **400**; opens are rate
   limited per job (4 burst, one per 5 s) and across jobs (10 burst, one
   per 5 s), **429**. A file removed since is `gone`; a failed `open`
   answers `200 failed`. Security: the tokens exist only inside the
   panel-encrypted plaintext, so OpenAI (which sees the job id) and the
   relay (which sees only ciphertext) cannot trigger an open; the relay
   learns a token only when the panel uses it, and could at most repeat an
   open the owner just asked for, within the rate limit and the job's life,
   never open anything else. Opening a file on the Mac shows it to whoever
   is at the Mac, which is the owner's own action.
8. **Expiry.** Ten minutes after creation the job is deleted; then, as for
   unknown and wrong-install ids, every request gets **410 `gone`** (one
   answer for all, so the endpoint is no oracle). Pending polls by the
   claiming key are rate limited per job (429 with Retry-After) and never
   delete the job: expiry alone ends it.

Wire statuses (`connect-relay/shared/private-answer.ts`): `ready`, `failed`,
`pending` (202), `claimed` (409), `gone` (410), `invalid` (400/405/413),
`forbidden` (403), `rate_limited` (429), `mac_offline` (503, from the
relay), `busy` (503), and `opened` (204, no body, `/open` only).

### Follow-up collection (added 2026-10-07, stage C4a; AD-2)

The panel protocol's compatibility record, AD-2 of the design
`docs/design/frontier-consult-lane.md` §A.11 (revision 8, on its proposal
branch until the lane ships; owner-accepted 2026-10-07). The authoritative text is the header of
`src/workers/chatgpt/private-answer-contract.ts`; this is the narrative.
This stage landed the protocol the consult rides on, and the limits it
needs; stage C4b (below, "Consult scheduling") added the writer, the gate
call and the dispatch that use it. No user-facing path enables outside help
yet (the Mac dashboard card is C5, the public CLI command C8).

- **One payload contract, every install** (`private-answer-payload.ts`,
  design §A.5.1). The jobs boundary now enforces, before first delivery:
  answer ≤ 2,700 UTF-16 units (was 65,536), ≤ 4 citations (was 20),
  ≤ 4 gaps of 300 units (was 10), title/source ≤ 300, date ≤ 32, a
  normalized https URL ≤ 2,048 characters, a 43-character Mac token.
  Nothing shown today is cut: the production model is built without a
  limits override and writes at most 2,700 units, cites at most 4 items
  and lists at most 3 gaps plus one unreadable note. A total serializer
  replaces lone surrogates with U+FFFD, strips control and bidirectional
  characters, normalizes URLs, and cuts any field over its serialized byte
  budget (answer 8,192 B; 4 × 4,096 B citations; 4 × 1,024 B gaps; 6,144 B
  outside block; 512 B scalars; 35,328 B in all) at a code-point boundary
  with "…" inside the budget.
- **Capability handshake.** Every request body is
  `{"v":1,"publicKey":…,"cap":2}`, unconditionally; the engine records the
  capability at the claim. A body without `cap` is capability 1.
- **Phase 1, initial acquisition: unchanged** (steps 4–6 above): `202
  pending` with `Retry-After: 2`, `429`, plaintext `200 failed`, `409`,
  `410`, the 2-second poll. The first answer is never slowed.
- **The transition is first delivery:** the first `ready` to the claiming
  key; the engine records `firstDeliveredAt` and fixes
  `followUntil = min(firstDeliveredAt + 20 min, expiry)`. A remount never
  extends it.
- **Phase 2, follow-up,** for a job whose policy had outside help
  on when it was created (`~/.olympus/consult.json`, bound at creation;
  later changes never alter it) and whose claiming panel declared `cap: 2`:
  every request from the claiming key gets `200 ready` with a freshly sealed
  envelope of exactly **36,864 padded plaintext bytes** (36 KiB; 36,880
  bytes of ciphertext, about 49 KB on the wire; the fixed size is a simple
  bound, not a hiding measure). The plaintext is version 1, extended:
  `{v:1, rev, state: "answer"|"withdrawn", answer?, citations?, unanswered?,
  followSeconds, outside: {state: "idle"|"pending"|"appended"|"paused",
  text?, cut?, question?, route?}}`. `rev` only increases; `idle` covers
  nothing triggered, refused, skipped and failed alike; a withdrawal (an
  item the answer read is no longer eligible, checked on every hand-out and
  every source open) is terminal and lives inside the envelope, never as a
  plaintext `failed`. The other responses are `400`, `409`, `410` after
  expiry or eviction, `429` and `503`. The job keeps its bounded
  first-answer plaintext and its open tokens in memory for its lifetime
  (at most about 7 MB across the 200-job cap); the tokens are minted once
  and identical in every envelope.
- **Lifetimes are policy-bound:** 30 minutes with outside help on, 10 off;
  eviction at the cap is oldest-first. A reply for an expired or evicted
  job is discarded.
- **Mixed versions.** Old panel (no `cap`) on a new engine: today's
  behavior exactly, bucket padding and plaintext `failed` included; no
  consult can be dispatched for it. New panel on an old engine: the old
  engine reads only `v` and `publicKey`; its plaintext has no `outside`
  and no `followSeconds`, which the panel treats as today's answer: no
  follow-up polling, no reserved strip, no error.
- **The relay is unchanged:** it forwards both bodies unread (512-byte
  request cap; 8 MiB response cap).
- **Panel:** after first reveal of a follow-up envelope it polls the same
  request every 30 s until `followSeconds` runs out, the job is gone
  (`410`) or the answer is withdrawn. The first answer and its sources
  never change. The outside block has its own container under the
  "Private answer from your Mac" card, shown while a reply is pending,
  paused or appended (nothing while idle), with the application-owned
  attribution "Outside background — not from your documents. General
  information from an outside model. It did not read your documents and
  has not been checked." pinned while the body scrolls, a collapsed "What
  Olympus asked", and "Shortened by Olympus." when cut; the text is set
  with `textContent` only (markdown literal, links not clickable), control
  and bidirectional characters stripped, blank runs collapsed, at most 40
  lines of 240 characters and 4,096 bytes. A withdrawal clears the answer,
  its sources, gaps and outside text at once and ends the polling; hidden
  stays hidden, and Show then says the answer was withdrawn. The frame is
  as tall as its content, as today.
- **What is and is not hidden (owner ruling 2026-10-07, version one).** The
  content is sealed to the panel's key: under the assumptions already
  stated below ("Who can read the answer": an uncompromised relay that does
  not swap keys, and the panel's HTML served unaltered), ChatGPT and the
  relay do not see the first answer, what was asked outside or what came
  back. They may infer
  that outside help ran on a question, from response timing, from the
  panel's size changes and from how long it keeps polling, never what was
  asked or answered. This is accepted for version one; no response-time
  floor, reserved geometry or polling parity is attempted.
- **C4b seams** on `PrivateAnswerJobs`: `outsideSeam(jobId)` (clocks and
  states, no text), `markOutside(jobId, rev, state)` and
  `appendOutsideBlock(jobId, rev, block)`. Both share one condition: a
  delivered follow-up job in state `answer`, inside its follow-up window,
  not yet appended, at the expected revision (compare-and-set); append at
  most once. The block is normalized and budgeted before it is retained
  (fitted fields and `cut` only), as is the retained first answer, so a job
  holds at most the envelope's bytes whatever it was given. Delivery
  clocks (`firstDeliveredAt`, `followUntil`, `lastCollectedAt`) are
  published only with a `ready` actually returned: a seal that fails
  leaves no window and no writable state.

### Consult scheduling (added 2026-10-07, stage C4b)

Design `docs/design/frontier-consult-lane.md` §A.2, §A.3, §A.7 (candidate
B2), §A.8 and §A.5.6. The code is `src/core/consult-writer.ts` (the writer
and its own server) and `src/workers/chatgpt/consult-orchestrator.ts` (the
trigger, gate, transport session and panel seams), wired in the worker beside
the jobs engine. Inert unless a valid, enabled `~/.olympus/consult.json`
exists (every job then binds outside help off and the model is not even asked
for the snapshot metadata); no product path writes that file until C5.

- **Verdict metadata.** `answerPrivately` (analyst-built-in.ts) returns,
  beside the answer, the model's own `sufficient` verdict, a no-answer flag
  and the fitted pack its main call received; the panel model passes it
  through as `PrivateAnswerModelResult.consult`. None of it enters the
  plaintext.
- **Snapshot handoff.** At the claim's seal, a follow-up job keeps a
  deep-frozen consult snapshot: that pack, the question, the answer and gaps
  exactly as retained, the verdict and the identities of the items read. A
  reused precompute brings its search-time pack. Its retention clock starts
  at first delivery and ends after five minutes, at the dispatch decision,
  at withdrawal or when the job ends.
- **Trigger** (`onFirstDelivered`): policy on, capability 2, state `answer`,
  block idle, verdict insufficient or gaps (never "these items do not
  answer"), a collection within 75 s, and a dispatch window with delivery
  room for the writer, the configured completion timeout and a two-minute
  margin. `markOutside('pending')` is the schedule mark. Before any writer
  work: a route must exist (zkAPI profile and inference key) and no private
  answer may be in flight; the fresh-answer generation is captured before
  the E1 eligibility check, and an answer that starts during it supersedes
  the consult.
- **Writer** (B2): its own `llama-server` on the answer model's files,
  `--parallel 1`, batch and ubatch 64, a distinct random port, started on
  demand and SIGKILLed after the call, on a fresh private answer
  (`onAnswerActivity`) or at its 60 s deadline. The answer server is never
  touched; the SIGKILL handler is installed the moment the process starts,
  so a cancellation during the tokenizer calls kills it too. Memory rule
  before every start (owner decision, C4b review round 1): at least 20% free
  after the 0.6 GB footprint and kernel pressure not `critical`. `warn` is
  allowed because the owner's 24 GB Mac idles at `warn` with other
  processes' swap in use and that is where M0's B2 pairs were measured;
  `critical` means the machine is already compressing and swapping hard.
  Residual: at `warn` the writer can add paging while it runs (M0 saw one
  +7.7 s prefill pair in four while the machine swapped). Prompt: the rules
  plus ONE bounded input (question ≤ 1,000, answer ≤ 2,700, ≤ 4 gaps × 300),
  which is also the gate's `writerVisibleTexts`; at most 2,048 tokens by the
  server's tokenizer, and when the server cannot count, the consult is
  skipped (no estimate stands in); reply schema `{"questions": null | [1–3]}`.
  The rule against naming what the answer only implies (M0 round 2:
  "Portugal" from a Lisbon itinerary) is in the prompt; mechanically, the
  gate refuses a country name under the default options (countries pack
  off, `unknown_word`).
- **Gate, session, dispatch.** The session opens (lease, Tor, daemon, policy
  warm) while the writer runs. The gate compares the questions against the
  snapshot pack plus the question, answer and gaps; a refusal is silent.
  `send` runs final authorization immediately before the reservation: the
  E2 eligibility check is awaited first, then, synchronously after it, the
  settings revision (`recheckConsultJobPolicy`), state, panel activity,
  window and delivery room, and the send-once latch (`takeConsultLatch`);
  the questions enter the repeat history at that instant (dispatched or
  possibly dispatched). The reply is appended at completion, before
  settlement (`appendOutsideBlock`, fitted, with the question and route
  label); `finished` runs on. `busy` or any failure skips; nothing is queued.
  Every end that is not an appended block is `markOutside('failed')`: the
  block reads idle and the panel shows nothing more. The orchestrator
  re-reads the snapshot at every use (a withdrawal or the retention clock
  ends the consult) and holds only item identities past the dispatch
  decision.
- **M0 harness against the real scheduler.** `scripts/measure-consult-writer-isolation.ts`
  (M0 round 2, now on `main`) has a `--real-writer` mode: the WRITER arm is
  the shipped `runConsultWriter` on a `createConsultWriterServer` process,
  over the real prompt, token bound and memory rule, killed on arrival by the
  orchestrator's fresh-answer signal. Phases are clock offsets (the real
  writer is not streamed); the `hung` and `loading` phases are skipped and
  recorded. The quiet-machine B2 rerun (load below 3, n ≥ 20 per phase, 30
  control pairs), judged by the first-token rule, is the merge gate of the
  C4b pull request and is still owed.

### Outside help enable flow (added 2026-10-07, stage C5)

Design `docs/design/frontier-consult-lane.md` §A.9, §A.10, §A.14 and the
owner rulings of §10: automatic by default (no approval step; strict mode is
C6), enabled only from the Mac, fence recovery a button and never automatic,
the eight risk acknowledgements, one "send" in total including the fee
buffer. The code is `src/core/consult-settings-writer.ts` (the writer),
`src/workers/email-source/dashboard-consult.ts` (the Mac dashboard adapter,
the writer's one caller), `src/workers/dashboard/outside-help.ts` and
`pages/outside-help.ts` (the card), and the five routes in
`src/workers/email-source/index.ts`.

- **Where.** The standalone Mac dashboard, `/dashboard?outside-help`,
  reached from Setup's Outside help row. The native OpenClaw Control UI and
  the ChatGPT dashboard never build that URL and render one sentence for it
  (`controlMode: 'native'`): a hosted agent cannot see or touch the
  controls. A locked browser or the read-only `dash_` link is pointed at
  Setup's gate.
- **Who.** The five routes (`POST /dashboard/consult`, `/route`,
  `/route/add`, `/recover`, `/abandon`) are accepted only from an
  authenticated local control session: cookie, same origin and CSRF token
  proven at the HTTP boundary, which then injects the control-session
  context header it strips from every incoming request
  (`DASHBOARD_CONSULT_CONTROL_PATHS` in `src/workers/http.ts`). The Gateway
  bearer, which every other control route also takes, is refused there
  (403 `mac_dashboard_only`), the worker handler refuses without the
  header, and no `/dashboard` path is ever on the relay's forward list. An
  import-graph test holds that no MCP, setup-tool, ChatGPT, relay or remote
  module reaches the writer or the adapter.
- **The settings writer.** `~/.olympus/consult.json`, compare-and-swap on
  `revision` under the cross-process file lease, written as an atomic
  owner-only replace (0600) inside an owner-only `~/.olympus` (0700, a real
  directory, not a symlink; created when missing, refused when wrong). No
  HOME, no write, with no fallback to the operating system's home. A file
  that does not parse is never overwritten unless the owner chooses
  "Replace the damaged settings file", which keeps outside help off.
  `strict` is kept as saved (C6 adds its approval step); domains keep the
  gate defaults.
- **Turning on** requires a configured zkAPI route whose profile records
  every one of the eight acknowledgements at version 3, and languages whose
  vocabulary packs are installed (shipped packs verified by hash; German and
  Italian are optional user packs). Turning off never requires anything.
  The page carries the revision it was built from; a stale one is a 409
  and nothing is written.
- **The route.** The one `zkapi` sovereignty profile. "Add the zkAPI route"
  writes a consult-only profile (`trust: standard_cloud`, `purpose:
  consult`, the daemon's default loopback base URL, model
  `openai/gpt-5-mini`, `secretRef: env:OLYMPUS_ZKAPI_API_KEY`) through the
  same validator `olympus sovereignty init` uses. The acknowledgements, the
  owner-confirmed funding date and the optional daily caps are recorded in
  that profile's `zkapi` block. The sovereignty policy is read at boot, so
  each of these writes asks the worker to restart (`requestReload`, the
  Models card's own path); when the worker cannot restart itself the card
  says so and the change waits for a managed restart. The settings file
  itself needs no restart (read at every use).
- **Readiness** is `zkapiConsultReadiness` with the key's presence only
  (never the key): blockers are shown in plain words (program not installed,
  Tor missing, API key not configured, acknowledgements, funding date,
  expiry estimate, held request, ports, caps). The probe runs only for the
  card's own render inside a control session.
- **Setup steps shown, in the order that worked live
  (`docs/design/consult-m1-measurement.md`):** install `zkapi-clientd`
  (0.1.5 or 0.1.6) and Tor → `zkapi-clientd config --usd N` (ONE transfer in
  total: the deposit plus the fee buffer the tool shows; gas prices move,
  so a shortfall means another transfer) → wait for "Private inference
  balance activated" → `--relay-url socks5://127.0.0.1:19050` →
  `--require-api-key` → `--api-key <key>`, stored where the profile's key
  reference points (for `env:NAME`, a `NAME=<key>` line in
  `~/.config/olympus/worker.env`, owner-only, then a worker restart) →
  `--key-reuse-window-seconds 0` (Olympus refuses to send while the window
  is on, `key_reuse_on`).
- **Disclosure, up front** (§A.10, §Z.2): the public privacy sentence; one
  outside question per incomplete private answer within about five minutes,
  up to $6 each counted in full; sent only on recent panel activity but not
  guaranteed off by closing the panel; no daily limit unless set, the
  deposit is the hard limit; deposit and withdrawal fees, the 30-day expiry
  and no top-up; the outside provider reads the question; the route is
  experimental and not verified on macOS; no approval step.
- **Held request (fence).** Recover runs `recoverZkapiSession` (one fixed,
  content-free request; reserves up to $6) behind a confirm, only for a
  fence of this wallet; Abandon marks the named fence abandoned behind a
  confirm that states the privacy consequence (an unsettled request may
  later settle under another session's network identity). Neither is ever
  automatic.
- **Content-free.** The card and its status carry codes, counts, dates and
  the key reference; never a question, a reply, a key or the daemon's
  configuration (`config.json` is never read).
- **Release gate.** The quiet-machine B2 first-token rerun (§A.7: load
  below 3, n ≥ 20 per phase, 30 control pairs) must pass before the enable
  path ships; it is owed, and is the C5 release gate rather than a merge
  gate. Acceptance with fakes: `test/consult-enable-acceptance.test.ts`.

### Relay

- `/private/<id>` and `/private/<id>/open` are routed by the install prefix
  of the job id, like `/mcp` by its token; exactly those path shapes, POST
  only, no query string,
  a 512-byte body cap, and a per-address rate limit (`privateFetchesPerIp`,
  30 burst, 1/s) on top of the per-install admission lanes.
- CORS is answered by the relay, for ChatGPT widget origins only:
  `https://web-sandbox.oaiusercontent.com` and one DNS label under it. The
  plugin's dedicated `_meta.ui.domain` is the relay origin, but ChatGPT
  serves the panel from its own sandbox domain, never from a domain it does
  not host, so the relay origin is not accepted by default (review
  2026-10-02: a page on the relay origin is the relay's own or a sandboxed
  install answer; `panelOrigins` can add an origin if a live panel ever
  shows one). OpenAI documents the sandbox default; the exact per-app origin
  must be confirmed against a live panel before directory submission
  (`panel_origin_refused` logs the origins it refuses). CORS keeps other web pages out; it
  does not stop a non-browser caller, and nothing below relies on it to.
- Logs carry only the install's hashed tag, never the job id.
- Mac offline: the relay answers `503 mac_offline` (with CORS) and the panel
  says the Mac is offline. The relay's offline MCP fallback serves the panel
  resource too, from the generated relay assets.
- The install's relay client forwards exactly `POST /private/oly2p.…` and
  `POST /private/oly2p.…/open`; the engine serves them only to relayed
  requests from an allowed Origin. CORS and preflight for `/open` are the
  same as for the collection.

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

## Live smoke (added 2026-10-02)

`scripts/chatgpt-live-smoke.ts` checks what ChatGPT sees, end to end, on a
live install, so an operator can verify ChatGPT-visible behavior without
screenshots from the owner. It is read-only: it calls tools and collects
panel answers; it restarts nothing and changes no settings.

```sh
bun scripts/chatgpt-live-smoke.ts --question "What ayurveda files do I have?"
bun scripts/chatgpt-live-smoke.ts --quiet --expect-private \
  --question "What did my June 2026 blood work show? Use Olympus." \
  --follow-up "Give me all the details from the June 2026 blood work lab." \
  --follow-up-detail full
```

What it does, in order:

1. **Token, the local operator's way.** No new auth path. In relay mode the
   engine already lets a local development client register (loopback
   redirect URIs only) and be approved only by a direct loopback visit
   (`remote-oauth/handler.ts`: a relayed request carries `x-olympus-relay`
   and is refused; being at the Mac is the proof of ownership). The script
   registers one public client, "Olympus live smoke", once (its id, not a
   secret, is kept in `~/.olympus/live-smoke-client.json`, mode 0600),
   approves it at `http://127.0.0.1:8010/connect/authorize`, and exchanges
   the code with PKCE at the relay's public token endpoint, as ChatGPT
   does. It revokes the grant when the run ends (the access token would
   expire in an hour anyway); `olympus connections list` shows each run as
   a revoked "Olympus live smoke" row. Tokens are never printed or stored.
   `--engine` must be a loopback address. It cannot run from another
   machine, and nothing about remote approval changes.
2. **Tools as ChatGPT calls them.** Over `https://mcp.olympusplugin.ai/mcp`
   (the relay marks the request, so the engine serves the ChatGPT
   surface): `tools/list`, `olympus_dashboard` (skip with
   `--no-dashboard`) and `olympus_search {question, detail?}`. For each
   result it prints the model-visible text verbatim, which fixed Private
   note it carries, the `structuredContent` and `_meta` keys, and the
   panel `_meta` with the job id redacted to its install part. `--quiet`
   prints the text's length instead of the text.
3. **The panel.** When `_meta["olympus/privateAnswer"]` is `ready`, the
   script does what the panel does: a CORS preflight and then
   `POST /private/<job id>` with `Origin` set to a ChatGPT desktop sandbox
   origin (`codex-sandbox://mcp-app-<hex>.web-sandbox.oaiusercontent.com`;
   `--origin` overrides), one ECDH P-256 key for every poll, `Retry-After`
   honored (2 s default, 30 s at most), and the panel's caps (2 min, or
   its full-detail cap for `detail: "full"`, both read from the panel's
   module). It decrypts the answer and prints it with
   its cited titles, gaps and timing (search time, claim to settled, and
   search to ready). `--quiet` prints only the answer's length and the
   cited titles, for runs where medical or other private content should
   not scroll by.
4. **Checks; exit 1 on any failure.** Every tool result is checked
   against every private answer the run decrypted: no run of six
   consecutive words of a private answer (not also in the question), no
   open token from inside the sealed plaintext, no key material field
   (`publicKey`, `macPublicKey`, `ciphertext`, `iv`), no job id in the text
   or `structuredContent`, and no panel `_meta` field outside
   `v, count, state, jobId, percent, detail`. A decimal value shared with a
   private answer is a warning only. It also fails on a panel failure
   (claimed, failed, gone, offline, CORS refusal, poll cap) and on a
   private answer slower than the panel waits (120 s summary, the panel's
   full-detail cap for full) from the
   search. `--expect-private` also fails when a question gets no ready
   panel job. Exit 2 means the run could not start (token, relay or
   arguments).

`test/chatgpt-live-smoke.test.ts` covers the offline parts: the panel's
claim, poll and decrypt loop against a fake relay, and the leak checks.

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

Steps 1-6 are done. What remains for 1.0 (logo, install command, integration
merge, `1.0.0-rc.1`, submission) and what is deferred after it are tracked in
the release plan: [Olympus 1.0 (ChatGPT)](../V0_4_RELEASE.md#olympus-10-chatgpt).

## Target user journey

1. Find Olympus in ChatGPT, add it.
2. The Olympus panel says "Install on your Mac"; the user runs the one-line
   installer in Terminal (`curl -fsSL https://olympusplugin.ai/install.sh | sh`,
   the 1.0 decision of 2026-10-03; no admin password; per-user LaunchAgent).
   Later, a signed installer that ChatGPT's desktop agent runs after the user
   approves.
3. The engine starts, links itself to the relay, and opens the approval page
   on the Mac; one click connects ChatGPT.
4. In the Olympus sidebar: local files and notes first (target; not in 1.0), then Gmail, Drive,
   Dropbox with accounts they already have. Built-in embeddings start indexing.
5. Ask questions in ChatGPT.

## Security posture and residual risk

### Open decision: an owner-held approval (for Jamie)

Relay-mode approval today proves "a browser on this Mac clicked Connect":
the request must come from a loopback peer with a loopback Host, carry no
relay marker, and be a same-origin navigation POST with the page's CSRF
token and cookie. That stops a page on the web, the LAN, and naive scripts.
It does not stop a process on this Mac that can reach `127.0.0.1:<port>`:
it can fetch the page, read the CSRF token and cookie, and POST with forged
`Sec-Fetch-*` headers. That includes a process running as a different macOS
user, which can reach loopback but cannot read the owner's files.

Proposed owner-held factor: the engine shows a native macOS dialog, "Allow
ChatGPT to connect to Olympus?", on the owner's console session when an
approval is posted, and issues the code only on Allow. A process without the
owner's session cannot click it. Cost: one more click for the owner, and a
dialog path to build for the standalone engine and the Gateway. Not built;
no new confirmation step was added on 2026-10-02.

### Accepted and proposed residual risks (2026-10-02)

- **`/go` hand-off can link the wrong account.** A one-time connect link
  (`/go/oly2g.…`) is a bearer capability for 10 minutes: whoever opens it
  first signs in with their own Google or Dropbox account, and the engine
  stores that account's grant. If the link leaks (shared screen, chat log),
  an attacker can link their own account so the owner's Olympus indexes the
  attacker's data, which could carry injected text. Proposed: before the
  first sync, show the linked account's address in the panel and on the Mac
  dashboard and ask the owner to confirm it. Not built.
- **Consent phishing with an attacker-made authorize URL (accepted).** An
  attacker can start a connect flow in their own ChatGPT account and send
  the owner the authorize link it produced. If the owner opens it on their
  Mac and clicks Connect, the code returns to ChatGPT's registered redirect,
  where the attacker's ChatGPT session holds the PKCE verifier, so the
  attacker's ChatGPT gets a grant to the owner's Olympus. The consent page
  says to connect only if the owner just chose to connect Olympus in ChatGPT
  themselves, signed in to their own account, and the connection appears in
  the owner's list with revoke. Accepted as residual risk for 1.0.

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
