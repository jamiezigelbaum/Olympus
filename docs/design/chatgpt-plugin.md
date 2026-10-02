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
    credential-less `/mcp` answers.
  - **Sessions.** Unauthenticated sockets have their own pool (1,024); when
    it is full the oldest is closed, so stalled sockets cannot keep a real
    install out, and they never count against session capacity. Connect
    attempts and registrations are keyed by IPv6 /48.
  - **Registrations** need a proof of work bound to the session nonce
    (16 bits, about 0.1-0.3 s on a Mac); returning installs (registered
    here before, since expired) draw on a budget of their own; a
    registration never confirmed by a later `hello` (and not online) expires
    after a day; an exhausted relay-wide budget logs `budget_exhausted` once.
  - **Signatures** bind the relay host the install dialed, so a challenge
    from one relay cannot be answered through another.
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
     - *Full.* The items read are re-read whole, when they fit 10,000
       characters together (layout whitespace compacted), else the shorter
       whole and the rest at an equal share of the remainder, for their best
       passages; the prompt ceiling is 14,500 bytes (about 4.5k tokens) and
       the answer about 2,000 characters. Its analysis and claim deadline is
       180 s (`PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS`) instead of 100 s.
       Owner report: "can you give me all the details from that lab please?"
       reached the panel as four thin slices of four items and was answered
       "the provided evidence does not contain the details".
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
     search_to_ready_ms=… queued_ms=… refresh_ms=… matched=… items=…
     evidence_bytes=… model_ms=… main_…`. `wait_at_claim_ms` is what the
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
   190 s for `detail: "full"`). It decrypts the answer and prints it with
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
   private answer slower than 120 s (summary) or 190 s (full) from the
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
2. The Olympus panel says "Install on your Mac"; ChatGPT's desktop agent runs
   the signed installer after the user approves (no admin password; per-user
   LaunchAgent).
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
