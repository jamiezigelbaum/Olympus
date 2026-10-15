# Olympus for background agents (dots, Grok Bot, Muse)

Status: approved design, revision 5 (owner decision 2026-10-14), after three Codex
(gpt-6-astra) review rounds (final verdict: approve with changes, made) and the owner's decisions below. Builds on
[hosted-agent-compatibility.md](hosted-agent-compatibility.md) (2026-09-24),
which put Grok and Muse out of scope for 1.0, and on
[chatgpt-plugin.md](chatgpt-plugin.md) and [private-answers.md](private-answers.md).

## Outcome

Someone who uses an always-on agent (OpenAI's dots, xAI's Grok Bot, Meta's
Muse, or any agent that speaks remote MCP) can add Olympus to it and have it
answer from their mail, files and notes in the background. Where an agent
cannot show Olympus's private answer panel, Olympus answers on the computer
automatically and the agent links to that answer in the Private answers inbox. The dashboard grows by one conditional
line and one page, and loses a page.

## Owner decisions (2026-10-12)

1. **Two Private rules, by surface, as today.**
   - *ChatGPT, including dots:* the model learns one bit, that Private items
     matched. No count, no text, no derived answer. This is the promise in the
     directory listing ("Private items are never sent to ChatGPT").
   - *Every other agent* (Grok, Muse, any token or non-ChatGPT OAuth
     connection): keeps today's behavior, a secret-scanned summary answer
     written from Private items by the private analyst, with citation labels,
     never Private source text.
2. **An unopened private answer is not lost.** If no panel shows it, it waits
   on the computer (this is what makes dots work).
3. **Superseded 2026-10-14:** agent questions are answered on arrival and
   retained in a local inbox; the person never asks the same question twice.
   Panel claim/ack remains unchanged.
4. **`secret_locations` is dropped for remote agents** (section C).
5. **Phone access to waiting questions is deferred** past v1.

## Why now

- **dots** (OpenAI, DevDay 2026-09-29): persistent agents inside ChatGPT, on
  Pro and Business Premium. They use the same ChatGPT plugins and
  permissions as chats, so they reach Olympus as ChatGPT. Whether plugin
  panels render for a dot is undocumented; assume not.
- **Grok Bot** (xAI, 2026-08-11): always-on agent; custom MCP servers are
  added in its Plugins settings and shared by every bot on the account. The
  auth contract for custom servers is undocumented.
- **Muse** (Meta, 2026-09-08): the consumer app uses Meta's connector
  catalog (a submission path exists); Muse Code takes any MCP server.

## What exists today (verified on `ee65ec68`, 2026-10-12)

- Only pinned ChatGPT client ids get the ChatGPT surface
  (`src/workers/email-source/server.ts:5155`,
  `src/workers/remote-oauth/pinned-clients.ts`). `isChatGptGrant` treats any
  pinned client as ChatGPT (`pinned-clients.ts:42-43`).
- Every other connection gets the `remote` list: `source_answer`,
  `source_answer_result`, `source_index_status`, `ask_anonymously`
  (`src/core/public-surface.ts:65-75`). Results are the whole operation
  result, serialized (`src/mcp/server.ts:44-49`), including audit fields and,
  when present, `secret_locations` (`analyst-answer.ts:597-610`).
- Private answer jobs (ChatGPT only) are created by `olympus_search` and by
  `source_answer` / its collector (`mcp-surface.ts:478-520`), only when a
  private model is ready; they live 10 minutes in memory, precompute at once,
  and are dropped on expiry, eviction or restart (`private-answer-jobs.ts`).
- The relay serves OAuth registration for ChatGPT's redirects only
  (`connect-relay/server/client-registration.ts:63-85`); the engine refuses
  relayed consent pages (`remote-oauth/handler.ts:274-281`).
- The dashboard has sections Needs you · Sources · What's private for you? ·
  Progress · Models · On this computer, and local pages Keys · Agents ·
  Anonymous answers · Build a connector. The Agents page lists connections
  with Revoke and has Connect an agent (`src/workers/dashboard/agents.ts`).
- The answer ledger is content-free: no questions, answers or citations
  (`answer-latency-log.ts:1-5`).
- Anonymous answers' same-provider rule knows only `openai` and `anthropic`:
  ChatGPT from its pinned client (`remote-mcp.ts:256`), every other
  connection guessed from its display name
  (`src/core/operation-caller.ts:61-66`). It checks only an explicitly
  requested model, not the default it then resolves (`consult-ask.ts:242,410`).
- No user notifications on the dashboard or ChatGPT paths (native source
  watches do deliver through OpenClaw).

## Design

### A. Inbox (owner decision 2026-10-14, 1.1.0)

This supersedes **answered on demand** and **no Private synthesis runs for
nobody** for agent questions whose panel does not claim them. 1.0.1 ships
first; this 1.1.0 branch must not land before it.

**Owner questions.** One box offers This computer, Venice and zkAPI as parallel
destinations. The computer uses the built-in local model. Venice uses the same
approved Private source_answer route agents use, only when the current privacy
settings already permit it, with release checks before dispatch and no Secret
content. zkAPI uses its existing writer and gate. All answers reach Inbox with
destination, who asked, relative time and exact time on hover. zkAPI shows exact
sent text; Venice shows all sent item titles. Setup/disallowed/busy states stay
visible. Copy is in vocabulary.ts; one CSS grid block owns alignment and phone
stacking. Final layout/copy await the separate owner design-probe review.
Migration v5 adds a destination marker while preserving v4 private/anonymous rows.
Venice source withdrawal clears the retained answer but never resends it without
an owner ask. Agent-initiated rules and ChatGPT's no-duplication rule remain.

**Arrival.** A ChatGPT Private match records the question independently of
its panel job. Other agents record when their Private part was withheld,
required approval, excluded by policy or unavailable and a metadata-only
local probe says `match`. That is `source_answer`, which only an install with
an answer model offers. On every other install the one answer tool is
`olympus_search`, which never returns Private items, so it has no outcome to
wait for: each search is probed with the same probe, ticket and record
(surface `remote`, the retrieval mode as its only selector). The probe starts
with the call and runs beside the search, bounded at two seconds, so a search
that takes longer waits for nothing; the connection and the search's tiers are
checked again once the probe has answered. A `match` that was recorded adds
`private_note` to the search result, the same sentence and Open link as a source
answer, for the agent to pass on as written. `no_match`, `unknown`, a refused
record, a connection revoked at any point and a demo sign-in grant tell the
agent nothing about Private; a demo grant records nothing. ChatGPT's
`olympus_search` is unchanged. `unknown` records an unchecked row and re-probes
locally every ten minutes; a later match schedules the same answer path.
Delivered Private summaries and `no_match` record nothing. Stored selectors
are bounded and replayed exactly; malformed/oversized selectors refuse the
record rather than widening the search. The local path in B answers under
today's tiers and policy, with no remote fallback or anonymous consultation.

**ChatGPT without duplication.** A 30-second grace window allows the live
panel's normal claim to arrive, without leaving background tasks waiting
for minutes. A claimed panel job stays hidden from the inbox while it lives.
Its existing sealed acknowledgment (or the pinned directory panel's existing
seen-on-delivery compatibility) deletes only the matching id/generation/
connection. A busy store returns the existing retryable busy response and
keeps the capability unspent: no successful acknowledgment, or pinned sealed
hand-out, until deletion commits (or that generation is already absent). No claim within 30 seconds schedules a local inbox answer;
a claimed job that expires without acknowledgment also falls back. Restart
forgets in-memory panel claims and resumes persisted questions after their
grace window. An acknowledged answer never appears in the inbox.

**Priority and failures.** The inbox runs at background priority, at most
one answer globally (therefore at most one per connection). Interactive
owner work is selected before queued background calls at the worker's
shared model completion boundary, including synthesis and audit. Evidence
authorization is repeated after queueing, before the model call starts, for
both inbox/panel answers and ordinary source answers sharing that model. A running
model call finishes; subsequent background calls yield. Upgrade resumes
bounded existing records. Failures remain row states, with persisted
exponential backoff from 5 seconds up to 30 minutes, no raw exception text.
Rows say Answering…, Trying again…, or Could not check yet.

**Storage.** Migration v2 of the question store retains answer text, citation
labels/locators (no source content copies), an allowlist of corpus/tier/source
item identities for eligibility, answered-at and read/unread. Questions keep
2 KB/4 KB selector bounds, deduplication, 20 per connection, 50 total, 256 KB
and seven-day bounds until answered. Answered rows have no time expiry,
including when invalidated and being re-answered. The storage safety cap is
500 retained answered rows/16 MiB (including invalidated rows and their
questions/selectors) and 128 KiB per answer; oldest beyond the cap are
removed with the visible older answers were removed line. Re-asking a
question refreshes its generation and queues a new answer. Reading marks
read, never deletes. Delete removes one; Delete all has one confirmation.

**Current authorization.** Before each stored read and each cited-item open,
every identity read by the answer is checked under today's tiers, scope and
policy. Secret, deleted or disallowed evidence withholds all stored text,
invalidates that generation and schedules re-answering; the panel plainly
shows Answering…. Source links are session-bound local POST tokens, not
public hrefs. They are checked again immediately before desktop dispatch.
Delete, revoke and re-ask fence stale reads/completions and open tokens.

**Protection and lifecycle.** SQLite in worker private state, directory
0700/file 0600, secure_delete and DELETE journaling. No indexing, telemetry,
support bundle, export or shared dashboard JSON. Only a local control
session may list/read/delete/open; dash_ viewers, ChatGPT widgets and Gateway
read scope are refused. Revoking a connection deletes all of its rows and
bumps its recording ticket generation, exactly as before. data delete --all
removes answers and sidecars. --source deletes answers depending on that
source's corpora, unmapped dependencies, and all pending questions, whose dependencies are not known;
this also fences a pending answer completing after deletion. Questions typed into Ask privately also stay in this inbox after the local eligibility check. ChatGPT panel answers are not copied into it. Anonymous dashboard asks and agent tool asks are retained with the exact question sent after the writer, labeled Anonymous and who asked; sealed ChatGPT anonymous panel answers are never duplicated. They share the inbox storage quotas, local control boundary, delete-all and export exclusions. Anonymous agent attempts have a separate five-per-hour budget per connection; human asks do not consume automatic-answer slots. Anonymous reservations keep a fixed placeholder instead of the original wording. The local private box retains multibyte questions within its existing 2,000-character limit. Anonymous asks have no source retrieval or attached source citations; they use the existing writer and outbound gate.

**The model's note**, host-neutral: “Your answer is in Olympus on your
computer.” Followed by **Open answer**, using the existing open-on-computer
handler: `olympus://open/private/<id>`. The only variable is 16 random bytes
encoded as a 22-character base64url id: no question, capability or meaningful
information off the computer. It chooses only a page location, not authority.
The local launch maps it to `/dashboard?private-answers#<id>`. If still being
written, that row says Answering…. Unknown/deleted ids open the inbox with
“That answer was deleted”. ChatGPT's panel acknowledgment protocol and its
model-visible content are unchanged.

### B. Ask privately on the computer (fully local)

A box on the Private answers page, also used by automatic inbox answers in A. It needs its
own retrieval path, because today's routes are not local end to end:
Private search is Private-only (`analyst-answer.ts:2690-2704,2807-2808`),
Personal retrieval may query the cloud (`:2551`), some Personal connector
adapters embed queries remotely (`connector-store/local-index.ts:10535,11289`),
and query planning uses the configured Delphi model
(`email-source/server.ts:3276`).

The local path:

- query planning by the built-in model, or none;
- embeddings by the built-in embedding model only;
- retrieval over Private stores and the Personal stores mounted on this
  computer (their scoped adapters, `email-source/server.ts:3405-3435`), with
  local lexical search where vectors are incompatible
  (`connector-store/local-index.ts:10535-10544`); no remote connector query
  and no cloud fallback;
- synthesis by the built-in model.

If a Personal source can't be searched locally, the answer says which
sources were left out (every problem findable). Anonymous outside help
(zkAPI) stays a separate, clearly labeled action, never mixed into this
answer, and waiting questions never feed `ask_anonymously`. Proof: a test
that denies all outbound requests and still answers, for B and for A's
automatic answers, covering planning, embedding, retrieval, passage ranking and
synthesis.

### C. Remote result hardening (summary rule)

Keeping summaries for non-ChatGPT agents makes the summary path's output the
boundary. Every remote connection, manual tunnels included, gets
**discriminated, per-operation output schemas** instead of the serialized
operation result (`src/mcp/server.ts:44-49`). `source_answer_result`
returns two families (answers and anonymous answers,
`src/core/operations.ts:336-343`), and each keeps its own schema.
`ask_anonymously` keeps every consent and delivery state it needs today
(`needs_choice` and options, reply, network identity, whether the question
was sent; `consult-ask.ts:117-151`) as fixed enums plus scanned text;
`source_index_status` gets its own. For source answers:

- **Answer:** the released answer text. The Secret coverage note ("N
  Secret(s) matched by location only", `analyst-answer.ts:2082-2092`) is
  removed for remote callers, with `secret_locations` itself (owner decision
  2026-10-12).
- **Citations:** a nested schema of label, title and date only. No provider
  identifiers, URIs or spans (`analyst-answer.ts:2292-2303`).
- **Status and pending:** `status`, and `job_id` while working, so
  `source_answer_result` still works (`source-answer-jobs.ts:73-78`).
- **Errors:** fixed plain messages, as the ChatGPT surface has
  (`response-builder.ts:1307`).
- Every retained free-text field is secret-scanned, not only today's five
  (`analyst-answer.ts:2349-2364`).
- A delayed result is rechecked against current tiers and policy when it is
  collected, not returned as stored (`source-answer-jobs.ts:248`).

The Private summary itself is unchanged.

### D. Each connection knows its host

Persist a `provider` per connection (`openai`, `xai`, `meta`, `anthropic`,
`other`). ChatGPT already comes from its pinned client
(`remote-mcp.ts:256`); xAI will too once pinned; tokens get it from a
one-tap choice on Connect an agent; existing token connections migrate from
their name, else `other`. **First split "pinned" from "is ChatGPT"**
(`pinned-clients.ts:42-43`): today any pinned client is served as ChatGPT,
so no xAI pin may land before this. Anonymous answers check the **final
resolved** model's provider just before sending, defaults included
(`consult-ask.ts:242,410`); an `other` host is told honestly that
same-provider exclusion can't be applied.

### E. Background-agent behavior

- **Computer offline.** The relay knows the endpoint (`/openai/mcp` or
  `/mcp`), not the host (`connect-relay/shared/directory-tools.ts:23-24`),
  and `/mcp` serves both ChatGPT developer connections and other agents.
  Tokens carry only kind, install and secret (`connect-relay/shared/tokens.ts`),
  so the surface can't be read from a token. So: `/openai/mcp` keeps the
  ChatGPT directory list; on `/mcp`, the engine confirms, while online, a
  surface mapping keyed by install, endpoint and token fingerprint, with the
  token's expiry; rotation adds the new fingerprint, and revocation or
  expiry removes it. Offline, the relay serves the mapped list, or the
  remote list for an unknown token. Never inferred from token prefixes. Tool
  results say "Olympus is off; last seen …; try again later" with a
  Retry-After, so an always-on agent backs off and retries.
- **Priority** lives at the shared model execution boundary, covering native
  answers, remote answers, panel jobs and the local page
  (`source-answer-jobs.ts:45-48`, `private-answer-jobs.ts:650-666`):
  interactive owner work first, then at most one running answer per
  background connection.

## Dashboard changes (all of them)

1. **On the computer, Needs you:** “N new private answers” only while unread
   answered rows exist, opening Private answers. ChatGPT's dashboard shows
   nothing new and receives no counts or other connections' activity.
2. **One page, Private answers**, keeping the 1.0.0/#391 panels and sections:
   Ask privately at top; inbox rows = question · connection name · when,
   newest first and unread in bold; click opens the full Markdown answer with
   a bold question, sources and left-out beneath. Only Delete and Delete all
   (one confirmation), no Answer or Dismiss. Deep links open and scroll the
   named row. One question box offers the owner-selected privacy ladder: Local model, zkAPI model, then Venice model, above Inbox. A dashed “Leaves this computer” line marks the cloud boundary. At up to 920px wide, every row has its button in one column aligned with its name; rows stack in order on phones. The copy uses the approved Models names and “It searches your files.” Inbox says “Answers from every model, kept on this computer.” Anonymous setup, balance, switch and writer checks live in Models on the Keys settings page. Light/dark and
   390/1280-wide proof includes unread, opened list/bold and Answering… rows.
3. **Agents page, Connect an agent:** ChatGPT, Grok, Muse, Other, each with
   its own short steps; the choice sets the provider (D).

Not added: notifications or a phone view. The timing ledger stays content-free.

## Sign-in per host

| Host | How it connects | Sign-in | Status |
|---|---|---|---|
| ChatGPT chats and dots | ChatGPT plugin (`/openai/mcp`) | Pinned ChatGPT clients, unchanged | Directory review pending; dots with an unlisted plugin unknown |
| Grok Bot | Custom MCP, `https://mcp.olympusplugin.ai/mcp` | A connection token from the Agents page, if Grok accepts a header token; otherwise pin xAI's client document and redirect once verified (after D's split), with a matching registration adapter if Grok insists on registration. No per-install URL unless a real host proves it necessary | Verify on a real Grok Bot first |
| Muse | Meta's catalog (consumer) or custom MCP (Muse Code) | Per Meta's catalog rules; token for Muse Code | Check submission requirements |
| Any other MCP agent | URL and token | Token | Works today |

## Build sequence

Each slice is one pull request with exact-head CI, exact-main closeout and
the applicable pipeline evals (`docs/ENGINEERING_PROCESS.md`).

1. **Grok sign-in probe.** Owned by the Grok Bot integration session running
   in parallel (2026-10-12; Jamie has a Grok Bot account). It records what
   Grok accepts (header token, OAuth, registration) and decides slice 5.
   Any xAI pin waits for slice 4's split.
2. **Remote result hardening (C).** Critical: independent review. Proof: a
   schema test over every serialized field, delayed-result recheck after
   reclassification, no Secret count or location in any remote output.
3. **Waiting questions, local Private answers page, Needs you line, open
   target (A, B, dashboard).** Critical: independent review. Proof: zero
   outbound requests on the local path; acknowledgment, crash and restart;
   revoke-versus-insert race; claim-time synthesis; nothing new in ChatGPT's
   dashboard text; a run of the real dashboard.
4. **Provider per connection, pinned-versus-ChatGPT split, resolved-model
   check (D), offline lists and shared priority (E).** Critical: independent
   review. Proof: migration, offline list per credential family, scheduling
   under load.
5. **Host onboarding:** Grok per slice 1 (an OAuth pin is critical class);
   Muse catalog submission; dots once the ChatGPT listing is live. Relay or
   engine deployment is a separately authorized live change.

## Still open

- Should local agents (OpenClaw, stdio MCP) keep the summary rule? Local
  transport does not mean a local model; no change proposed here.

## Review (Codex gpt-6-astra, 2026-10-12)

- **Round 1, revision 1: rework.** Adopted: full-result serialization and
  `secret_locations` (C); one bit, not a count; waiting records persisted at
  match time (A); local-only Ask privately (B); local inbox history until deletion; provider
  pinned or owner-chosen and checked on the resolved model (D); no
  per-install OAuth path; offline lists per surface; one page instead of two.
  Superseded by the owner's decision: removing summaries for non-ChatGPT
  agents.
- **Round 2, revision 2: rework.** Adopted in revision 3: no waiting count
  in ChatGPT's dashboard (it is model-visible); a dedicated local retrieval
  path with a zero-egress proof; typed remote schemas, the Secret count
  removed, all free text scanned, delayed results rechecked, `job_id` kept;
  synthesis on claim and an acknowledged "seen"; typed outcomes for
  summary agents that lost the Private part; scope, byte caps and
  revoke-race rules; offline lists by credential family; priority at the
  shared execution boundary; the pinned-versus-ChatGPT split ordered before
  any xAI pin; fuller acceptance proofs.
- **Round 3, revision 3: approve with changes**, all made in this
  revision: a sealed single-use acknowledgment capability; per-operation
  remote schemas (anonymous answers keep their consent and delivery
  states); full retrieval selectors stored, never widened; a new
  three-state metadata probe (`unknown` kept locally, never a remote match);
  offline surface mapping by install, endpoint and token fingerprint.

## Sources (checked 2026-10-12)

- dots: [flaviocopes deep dive](https://flaviocopes.com/openai-dots/),
  [SF Standard](https://sfstandard.com/2026/09/29/openai-launches-dots/),
  [eesel explainer](https://www.eesel.ai/blog/openai-dots)
- Grok: [Grok connectors](https://docs.x.ai/grok/connectors),
  [Grok Bot breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown),
  [Grok MCP](https://www.usecarly.com/blog/tags/xai/)
- Muse: [MCP servers for Muse](https://parallel.ai/articles/best-mcp-servers-for-meta-muse),
  [Zapier connector in Muse](https://zapier.com/blog/zapier-connector-in-muse/)
