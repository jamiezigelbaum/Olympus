# Hosted-agent compatibility: Grok Bot, Muse, Instinct

Status: research notes (2026-09-24). Not a plan of record. Nothing here is
implemented, and nothing here changes `docs/V0_4_RELEASE.md`.

Question from the owner: how can Olympus, guru-deva, and Expert Agents work with
three new agents: [Grok Bot](https://x.ai/bot) (xAI),
[Muse](https://ai.meta.com/muse/) (Meta), and [Instinct](https://instinct.com/)?

Caveat: the cloud session that wrote these notes could not fetch x.ai,
docs.x.ai, ai.meta.com, or instinct.com because its network policy blocked
them. The product facts below come from web-search snippets and third-party
write-ups. Verify them against the vendors' own docs before building.

## Summary

- All three are **hosted agents run by other companies**. None of them is an
  OpenClaw agent, and none can run a program on the owner's host.
- **Nothing we own can reach them today.** Olympus's MCP server runs only as a
  local process over stdio (`src/mcp/server.ts:73`). Expert Agents exposes
  `domain_ask` only as an OpenClaw tool, plus an HTTP worker built for Devic
  Agency.
- The way in is a **remote MCP endpoint** (Streamable HTTP plus OAuth) with a
  narrowed tool list and a **hard tier limit enforced in code**.
- Priority: **Grok Bot first** (it supports MCP connectors), **Muse second**
  (MCP is confirmed only for Muse Code and the Meta Model API), and **Instinct
  deferred** (no custom tool or MCP surface is documented).

## How the pieces connect today

| Piece | What it is | How agents reach it |
|---|---|---|
| Olympus (this repo) | An OpenClaw plugin. It is agent-agnostic: `agentId` is read only to route source-watch notices (`src/native-plugin.ts:570`). | OpenClaw native tools, gated per agent by `agents.list[].tools.allow`. Also `olympus serve`, the stdio MCP server used by Hermes (`README.md:315`, `config/hermes/olympus.mcp.yaml`), narrowed to `source_answer` and `source_index_status`. |
| Expert Agents (`jamiezigelbaum/Expert-Agents`) | An independent OpenClaw plugin with the tools `domain_agent`, `domain_ask`, `domain_source`, `rag_corpus`, `domain_doc`, `expert_factory`, and others. It has no dependency on Olympus, and Olympus's `test/architecture-guard.test.ts` forbids reintroducing it here. | OpenClaw tools. There is also the domain-expert worker's HTTP interface, whose consumer is Devic Agency. |
| guru-deva (`jamiezigelbaum/guru-deva`) | One agent's workspace: `agentId: "guru"`, `@guru_tbot` on Telegram, workspace `~/.openclaw/workspace-guru`. | Telegram (owner allowlist). It answers from its library through `domain_ask` with `domain_id: "guru"`. |

Agent-to-agent calls inside OpenClaw are governed by `tools.agentToAgent.allow`,
which is currently `["codex","argus"]` according to `openclaw-ops/STATUS.md`.

## The three agents

### Grok Bot (xAI)

- A no-code agent platform. Named bots share one cloud computer that has a
  browser, a file system, a terminal, and connected tools, and they can use
  that computer the way a person does.
- **MCP connectors are supported.** Enterprise plans include an "MCP allowlist"
  and team auto-review rules. Composio markets an MCP gateway for it, and
  Zapier offers a Grok MCP.
- **Open question, and it decides the plan:** can a user register their own
  remote MCP server URL, and with which authentication (OAuth 2.1, or bearer
  headers)? Check <https://docs.x.ai/grok-bot/teams-and-enterprises>.

### Muse (Meta)

- A personal agent that runs on a dedicated VM in Meta's cloud with a visible
  browser. Free, $20/month, and $100/month tiers. It gained phone calling on
  2026-09-17.
- **MCP is confirmed only for Muse Code** (Meta's coding agent: "generalizes to
  new native tools, MCP servers, and custom skills") and for building on the
  **Meta Model API** (Muse Spark 1.1, public preview).
- **Open question:** does the consumer Muse agent accept custom connectors or
  MCP servers? If it does not, the options are Muse Code or our own app on the
  Meta Model API.

### Instinct (Spear Street Technology)

- An invite-only personal agent that you text (SMS or WhatsApp) or call. It
  uses connected accounts, stored credentials, and a computer of its own.
- Its public site **does not document custom MCP servers, arbitrary
  authenticated API calls, or storage for API credentials.** The PyPI package
  `instinct-mcp` is an unrelated project.
- The only path today is a fragile one: Instinct messaging a Telegram bot such
  as `@guru_tbot` through its own computer. It is not worth building on. Revisit
  when Instinct ships a tool or connector surface.

## Proposed approach

1. **Add a remote MCP transport to Olympus.** Keep the operations that
   `olympus serve` already exposes, and add Streamable HTTP with OAuth. Give
   each client its own tool allowlist, the way Hermes is narrowed. The existing
   `relay/oauth` and `exchange/` pieces may cover part of the OAuth flow, but
   this has not been checked.
2. **Build a separate remote endpoint in Expert-Agents** for `domain_ask`
   (Guru's library). Expert-Agents' boundary rules forbid importing Olympus, so
   the two cannot share one gateway. Each hosted agent gets two connectors.
3. **Enforce a tier limit in code at the remote endpoint.** Per
   `docs/TRUST_MODEL.md`, ordinary cloud models may see at most S0–S3
   (Personal), and Private (S4, `secure_local`) must never leave. The endpoint
   should force `include_secure_local=false` whatever the caller sends, and it
   may be capped at Public only; the owner decides which.
4. **Classify it as a critical change.** A new public, logged-in entry point to
   personal data needs an independent review receipt under
   `docs/ops/HARNESS_PROTOCOL.md`. Exposing it from the host (Tailscale Funnel
   or a Cloudflare tunnel) is a live change under
   `docs/ops/OPENCLAW_CHANGE_PROTOCOL.md`.
5. **Public-surface guard:** the new transport must be reached from the public
   entrypoints. Do not add an entry to `config/public-surface-allowlist.json`
   to get it past the guard.
6. **Roll out in this order:** Grok Bot, then Muse (after its connector support
   is confirmed). Instinct is deferred.

## Owner decisions needed

- The highest tier outside agents may receive: Personal (S0–S3) or Public only.
- Whether an authenticated endpoint for the host may be exposed to the internet,
  and through which route.
- Whether Guru's library should be exposed to these agents at all. Its corpus
  is a view over the shared library, and its licence status is covered in
  `Expert-Agents/LICENSE_STATUS.md`.

## Next steps (local)

1. Allow the vendor hosts, or read their docs directly, and answer the Grok Bot
   and Muse open questions above.
2. If Grok Bot accepts custom remote MCP, prototype Streamable HTTP in
   `src/mcp/server.ts` behind a config flag, with the tier limit and a per-client
   tool allowlist, plus focused tests.
3. Test end to end against a Grok Bot connector using a Public-only corpus
   before any Personal-tier exposure.

## Sources

- [Introducing Grok Bot | SpaceXAI](https://x.ai/news/introducing-grok-bot)
- [Grok Bot for teams and enterprises | SpaceXAI Docs](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [A Guide to Grok Bot | Composio](https://composio.dev/content/guide-to-frok-bot)
- [What Is Grok Bot? | MindStudio](https://www.mindstudio.ai/blog/what-is-grok-bot)
- [Muse Code | Meta for Developers](https://developer.meta.com/ai/products/muse-code/)
- [Introducing Muse Spark 1.1 | AI at Meta](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/)
- [Introducing Muse | Meta Newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [Meta debuts Muse | Axios](https://www.axios.com/2026/09/08/meta-debuts-muse-personal-ai-agent)
- [What Is Instinct AI? | CellCog](https://cellcog.ai/blog/what-is-instinct-ai/)
- [What Is Instinct AI? | Carly](https://www.usecarly.com/blog/what-is-instinct-ai/)
- [Instinct and Muse add calling | TechCrunch](https://techcrunch.com/2026/09/17/rival-ai-agents-instinct-and-metas-muse-both-add-the-ability-to-make-calls/)
- [instinct-mcp | PyPI](https://pypi.org/project/instinct-mcp/)
