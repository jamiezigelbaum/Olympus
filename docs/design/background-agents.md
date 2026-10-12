# Olympus for background agents (dots, Grok Bot, Muse)

Status: proposal, revision 2 (2026-10-12), after a Codex (gpt-6-astra)
review and the owner's decisions below. Builds on
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

### A. Waiting private questions (ChatGPT surface, including dots)

When a ChatGPT-surface search or answer has a Private match, Olympus records a
**waiting private question** on the computer at that moment, whether or not a
panel job is created:

- Stored: the question, the connection, the time, the requested detail level.
  Not stored: evidence, answers, match counts, job ids, citation tokens.
- **Seen:** when a panel successfully delivers the sealed answer, the record
  is marked seen and leaves the list. A failed, unclaimed, evicted or
  restarted job leaves it waiting.
- **Answered on demand:** pressing Answer re-runs the search with today's
  tiers and answers locally with the built-in model. If nothing Private
  matches any more, it says so.
- **Bounds:** deduplicated by connection plus normalized question; 20 per
  connection and 50 in all (oldest dropped, with a visible "older questions
  were removed" line); 7 days; Dismiss and Dismiss all. A dismissed question
  asked again comes back.
- **Protection:** kept in the worker's private state with the same file
  permissions as Private stores, excluded from indexing, telemetry and
  support bundles, and readable only through a local control session (not
  `dash_` read-only viewers, not the ChatGPT widget, not the Gateway's read
  scope). Questions from the private question panel are never recorded.
- Revoking a connection deletes its waiting questions.

The model's note becomes host-neutral (one bit, as today): "Some matching
items are Private in Olympus. Their contents stay on the user's computer and
are never shown to you. Olympus answers from them privately: in a panel below
this reply if the app shows one, and always under Private answers in Olympus
on the user's computer. Say that briefly; don't guess at the private part."

Agents on the summary rule do not need this: they already get the summary.
They create a waiting question only when policy gave them no private route
for a matching question.

### B. Ask privately on the computer

A box on the Private answers page: the question is answered from Private and
Personal items **entirely on this computer**: query planning, embeddings,
retrieval and the built-in model. Nothing leaves. Anonymous outside help
(zkAPI) stays a separate, clearly labeled action below it, never mixed into
this answer.

### C. Remote result hardening (summary rule)

Keeping summaries for non-ChatGPT agents makes the summary path's output the
boundary, so:

- Serve remote callers an explicit **field allowlist** (answer, released
  citations, status, plain errors) instead of the whole operation result, on
  `source_answer`, `source_answer_result`, status and errors alike, for every
  remote connection, including manual tunnels.
- **Drop `secret_locations` for remote callers** (recommended). Today a remote
  agent can learn the title and kind of an item that contains a secret. On the
  computer that is useful; in a cloud agent it is a list of where secrets live.

### D. Each connection knows its host

Persist a `provider` per connection (`openai`, `xai`, `meta`, `anthropic`,
`other`): pinned for ChatGPT (and xAI once pinned), chosen by the owner in
one tap on Connect an agent for tokens; existing connections migrate from
their name, else `other`. Split "is ChatGPT" from "is pinned" in code.
Anonymous answers check the **final resolved** model's provider just before
sending, defaults included; an `other` host is told honestly that
same-provider exclusion can't be applied.

### E. Background-agent behavior

- **Computer offline:** offline discovery currently advertises ChatGPT tools
  to everyone (`connect-relay/server/relay-mcp.ts:112-115`). Serve each
  surface its own offline tool list, and say "Olympus is off; last seen …;
  try again later" in the tool result, so an always-on agent retries.
- **Load:** remote answers share one admission limit with the owner's own
  questions, over a model that may run one lane (`source-answer-jobs.ts:45-54`).
  Give interactive owner work priority, and cap each background connection
  at one running answer.

## Dashboard changes (all of them)

1. **Needs you:** one line, only when something waits: "2 private questions
   are waiting on this computer". On the computer it opens the page; in
   ChatGPT it uses open-on-computer with a new fixed target (no question text
   or capability in the link).
2. **One page, "Private answers"**, which absorbs the Anonymous answers page:
   - Ask privately (B) at the top;
   - the waiting list: question, "ChatGPT · 2 h ago", **Answer**, Dismiss; the
     answer appears in place, with citations opened through local
     authenticated handling;
   - Anonymous answers (zkAPI setup, balance, ask) collapsed beneath, labeled
     as outside help.
   Net page count is unchanged.
3. **Agents page, Connect an agent:** ChatGPT, Grok, Muse, Other, each with
   its own short steps; the choice sets the provider (D).

Not added: per-agent question history (the ledger is content-free by design,
and storing questions per agent is new exposure), notifications, a phone view.

## Sign-in per host

| Host | How it connects | Sign-in | Status |
|---|---|---|---|
| ChatGPT chats and dots | ChatGPT plugin (`/openai/mcp`) | Pinned ChatGPT clients, unchanged | Directory review pending; dots with an unlisted plugin unknown |
| Grok Bot | Custom MCP, `https://mcp.olympusplugin.ai/mcp` | A connection token from the Agents page, if Grok accepts a header token; otherwise pin xAI's client document and redirect once verified, with a matching registration adapter if Grok insists on registration. No per-install URL unless a real host proves it necessary | Verify on a real Grok Bot first |
| Muse | Meta's catalog (consumer) or custom MCP (Muse Code) | Per Meta's catalog rules; token for Muse Code | Check submission requirements |
| Any other MCP agent | URL and token | Token | Works today |

## Build sequence

Each slice is one pull request; exact-head CI and the repository's review
rules apply.

1. **Grok sign-in probe.** One real Grok Bot connection with a token; record
   what it accepts (header token, OAuth, registration). Decides slice 5.
2. **Remote result hardening (C).** Critical class: independent review;
   tests for every serialized field, delayed results and reclassification.
3. **Waiting private questions and the Private answers page (A, B), the Needs
   you line, the open target, offline discovery per surface (E).** Critical
   class (stores private-adjacent records). Includes restart, revoke and
   migration tests, and a run of the real dashboard.
4. **Provider per connection and anonymous-answer check (D), owner priority
   (E).** Critical class (credentials, routing).
5. **Host onboarding:** Grok per slice 1; Muse catalog submission; dots once
   the ChatGPT listing is live. Each needs an account.

## Still open

1. Phone access for waiting questions: deferred from v1 (recommended).
2. Drop `secret_locations` for remote agents (recommended) or keep it?
3. Should local agents (OpenClaw, stdio MCP) keep the summary rule? Local
   transport does not mean a local model; no change proposed here.

## Review (Codex gpt-6-astra, 2026-10-12)

Verdict on revision 1: rework. Adopted: the full-result serialization and
`secret_locations` findings (C); one bit, not a count; waiting records
persisted at match time with seen, restart and revoke rules (A); D4 local
throughout (B); no question history (the ledger is content-free); provider
pinned or owner-chosen and checked on the resolved model (D); no per-install
OAuth path; offline discovery per surface; one page instead of two. Superseded
by the owner's decision to keep summaries for non-ChatGPT agents: the
proposal to remove them.

## Sources (checked 2026-10-12)

- dots: [flaviocopes deep dive](https://flaviocopes.com/openai-dots/),
  [SF Standard](https://sfstandard.com/2026/09/29/openai-launches-dots/),
  [eesel explainer](https://www.eesel.ai/blog/openai-dots)
- Grok: [Grok connectors](https://docs.x.ai/grok/connectors),
  [Grok Bot breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown),
  [Grok MCP](https://www.usecarly.com/blog/tags/xai/)
- Muse: [MCP servers for Muse](https://parallel.ai/articles/best-mcp-servers-for-meta-muse),
  [Zapier connector in Muse](https://zapier.com/blog/zapier-connector-in-muse/)
