# Olympus for background agents (dots, Grok Bot, Muse)

Status: approved design, revision 3 (2026-10-12), after two Codex
(gpt-6-astra) review rounds and the owner's decisions below. Builds on
[hosted-agent-compatibility.md](hosted-agent-compatibility.md) (2026-09-24),
which put Grok and Muse out of scope for 1.0, and on
[chatgpt-plugin.md](chatgpt-plugin.md) and [private-answers.md](private-answers.md).

## Outcome

Someone who uses an always-on agent (OpenAI's dots, xAI's Grok Bot, Meta's
Muse, or any agent that speaks remote MCP) can add Olympus to it and have it
answer from their mail, files and notes in the background. Where an agent
cannot show Olympus's private answer panel, the private part waits for the
person in Olympus on their computer. The dashboard grows by one conditional
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
3. **Waiting answers are written only when the person opens them.** Nothing
   Private-derived is computed for nobody or stored.
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
- Anonymous answers' same-provider rule knows only `openai` and `anthropic`,
  guessed from the connection's display name
  (`src/core/operation-caller.ts:61-66`), and checks only an explicitly
  requested model, not the default it then resolves (`consult-ask.ts:242,410`).
- No user notifications on the dashboard or ChatGPT paths (native source
  watches do deliver through OpenClaw).

## Design

### A. Waiting private questions

**When one is recorded.** At the moment of the match, independent of any
panel job:

- *ChatGPT surface (chats and dots):* whenever a search or answer has a
  Private match.
- *Summary-rule agents:* the private part has three typed outcomes:
  **delivered** (the summary included Private evidence: nothing recorded),
  **excluded by policy** or **private route unavailable** (the answer fell
  back to Public and Personal, `analyst-answer.ts:537-556,729-741`). For the
  last two, a bounded local match probe (metadata only, as the ChatGPT
  surface uses) decides whether anything Private matches; if so a waiting
  question is recorded and the agent is told one sentence: "Private items may
  answer this; the person can see that answer in Olympus on their computer."
  Policy is never bypassed: the probe result goes nowhere but the local
  record.

**What is stored.** Question (at most 2 KB), stable connection id, time,
detail level, and the corpus scope the original request named. Not stored:
evidence, answers, match counts, job ids, citation tokens. Total store at
most 256 KB.

**Bounds.** Deduplicated by connection, scope and normalized question; a
duplicate refreshes the time and keeps the fuller detail level. 20 per
connection, 50 in all, oldest dropped, with a visible "older questions were
removed" line. 7 days. Dismiss and Dismiss all; a dismissed question asked
again comes back.

**Answered on demand, everywhere.** No Private synthesis runs for nobody:

- A ChatGPT panel's job starts synthesis when the panel **claims** it, not
  when the tool result is built (`private-answer-jobs.ts:524` today
  precomputes). In a live chat the panel claims within seconds, so latency
  barely changes; for a dot no panel claims, so nothing runs.
- On the computer, pressing **Answer** re-runs the search under today's
  tiers and policy, answers through the local path (B), and rechecks
  eligibility again before showing the answer and before opening any cited
  item (as panels already do, `private-answer-jobs.ts:568,589`).

**Seen.** A record leaves the list only after an authenticated
acknowledgment that the answer was decrypted and rendered: the panel sends
it after rendering, the local page after showing. The acknowledgment names
the record's generation, so a newer duplicate is not cleared by an older
answer. A lost acknowledgment leaves the question waiting; a duplicate is
better than a loss.

**Protection.** In the worker's private state with the same file
permissions as Private stores; excluded from indexing, telemetry and
support bundles; served only to a local control session (not `dash_`
read-only viewers, not the ChatGPT widget, not the Gateway's read scope, not
any shared dashboard JSON). Questions typed into the private question panel
are never recorded. Revoking a connection deletes its records and bumps a
generation in the same transaction, so an in-flight insert for that
connection is refused.

**The model's note** stays one bit and becomes host-neutral: "Some matching
items are Private in Olympus. Their contents stay on the user's computer and
are never shown to you. Olympus answers from them privately: in a panel below
this reply if the app shows one, and always in Olympus on the user's
computer. Say that briefly; don't guess at the private part."

### B. Ask privately on the computer (fully local)

A box on the Private answers page, also used by Answer in A. It needs its
own retrieval path, because today's routes are not local end to end:
Private search is Private-only (`analyst-answer.ts:2690-2704,2807-2808`),
Personal retrieval may query the cloud (`:2551`), some Personal connector
adapters embed queries remotely (`connector-store/local-index.ts:10535,11289`),
and query planning uses the configured Delphi model
(`email-source/server.ts:3276`).

The local path:

- query planning by the built-in model, or none;
- embeddings by the built-in embedding model only;
- retrieval over Private stores and the Personal items indexed on this
  computer; no remote connector query and no cloud fallback;
- synthesis by the built-in model.

If a Personal source can't be searched locally, the answer says which
sources were left out (every problem findable). Anonymous outside help
(zkAPI) stays a separate, clearly labeled action, never mixed into this
answer, and waiting questions never feed `ask_anonymously`. Proof: a test
that denies all outbound requests and still answers, for B and for A's
Answer.

### C. Remote result hardening (summary rule)

Keeping summaries for non-ChatGPT agents makes the summary path's output the
boundary. Every remote connection, manual tunnels included, gets typed
output schemas instead of the serialized operation result
(`src/mcp/server.ts:44-49`):

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
  and `/mcp` serves both ChatGPT developer connections and other agents. So:
  `/openai/mcp` keeps the ChatGPT directory list; on `/mcp`, the engine tells
  the relay, while online, which surface each credential family gets, and
  the relay serves that list offline (default: the remote list). Tool
  results say "Olympus is off; last seen …; try again later" with a
  Retry-After, so an always-on agent backs off and retries.
- **Priority** lives at the shared model execution boundary, covering native
  answers, remote answers, panel jobs and the local page
  (`source-answer-jobs.ts:45-48`, `private-answer-jobs.ts:650-666`):
  interactive owner work first, then at most one running answer per
  background connection.

## Dashboard changes (all of them)

1. **On the computer, Needs you:** one line, only when something waits:
   "2 private questions are waiting". It opens the page. **ChatGPT's
   dashboard shows nothing new:** everything in Needs you is copied into the
   text ChatGPT's model reads (`response-builder.ts:156-160,402`), so a count
   there would leak, as would other connections' activity. The agent's own
   note already tells the person where to look.
2. **One page, "Private answers"**, which absorbs the Anonymous answers page:
   - Ask privately (B) at the top;
   - the waiting list: question, "ChatGPT · 2 h ago", **Answer**, Dismiss; the
     answer appears in place, with citations opened through local
     authenticated handling;
   - Anonymous answers (zkAPI setup, balance, ask) collapsed beneath, labeled
     as outside help.
   A fixed open-on-computer target for the page (no question text or
   capability in the link). Net page count is unchanged.
3. **Agents page, Connect an agent:** ChatGPT, Grok, Muse, Other, each with
   its own short steps; the choice sets the provider (D).

Not added: per-agent question history (the ledger is content-free by design,
and storing questions per agent is new exposure), notifications, a phone view.

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
  match time (A); local-only Ask privately (B); no question history; provider
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

## Sources (checked 2026-10-12)

- dots: [flaviocopes deep dive](https://flaviocopes.com/openai-dots/),
  [SF Standard](https://sfstandard.com/2026/09/29/openai-launches-dots/),
  [eesel explainer](https://www.eesel.ai/blog/openai-dots)
- Grok: [Grok connectors](https://docs.x.ai/grok/connectors),
  [Grok Bot breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown),
  [Grok MCP](https://www.usecarly.com/blog/tags/xai/)
- Muse: [MCP servers for Muse](https://parallel.ai/articles/best-mcp-servers-for-meta-muse),
  [Zapier connector in Muse](https://zapier.com/blog/zapier-connector-in-muse/)
