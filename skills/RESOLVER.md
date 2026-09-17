# Olympus Skill Resolver

This is the dispatcher. Skills are the implementation. If OpenClaw has already
loaded the skill body into context, follow it. If the body is not loaded, use
this resolver plus the tool descriptions; do not read skill files with bash,
shell, OpenClaw exec, local file reads, or session logs in ordinary calling-assistant
sessions.

## Local Model Usage

| Trigger | Skill |
| --- | --- |
| User asks for Argus, the local model lane, local model, local-only reasoning, or private lane reasoning | `skills/ask-argus/SKILL.md` |
| The task involves sensitive content that should not go to ordinary cloud models | `skills/ask-argus/SKILL.md` |
| A cheap local synthesis pass is enough and latency is acceptable | `skills/ask-argus/SKILL.md` |
| User asks Argus to use Venice or names any Venice model for sensitive source reasoning | `skills/ask-argus/SKILL.md` and `skills/ask-sources/SKILL.md` |

## Email And Source Search Usage

| Trigger | Skill |
| --- | --- |
| User asks to search, summarize, inspect, or answer questions about Gmail/email | `skills/ask-sources/SKILL.md` |
| Raw email should stay out of ordinary cloud-model context | `skills/ask-sources/SKILL.md` |
| The calling assistant needs an answer from email rather than raw message bodies | `skills/ask-sources/SKILL.md` |
| User asks to search Telegram, X/Twitter bookmarks, saved/bookmarked tweets/posts, Readwise, Drive/Docs, Dropbox, or another Olympus-indexed source | `skills/ask-sources/SKILL.md` |
| User asks to rank, count, or analyze the top posters/senders in an indexed chat | `skills/ask-sources/SKILL.md` |
| User asks for unified source search or source-index search | `skills/ask-sources/SKILL.md` |
| The calling assistant needs evidence from approved internal or public-safe corpora | `skills/ask-sources/SKILL.md` |
| The calling assistant needs private/personal source evidence across email, Dropbox, or protected Telegram | `skills/ask-sources/SKILL.md` |

Source answers may report automatic local self-heal status when incomplete
Dropbox text is being re-ingested; follow `skills/ask-sources/SKILL.md`.
For private/personal source questions, use one `source_answer` call with
`include_secure_local: true` and omit `corpus_id` unless the user explicitly
named a source or selected a prior result. Do not route legal, financial,
medical, tax, or similar private topics to Dropbox by assumption.

## File Delivery Usage

| Trigger | Skill |
| --- | --- |
| User asks to save, write, create, or deliver a file on Xanthos | `skills/deliver-files/SKILL.md` |
| User asks to save a file in Fleur or another approved Olympus delivery root | `skills/deliver-files/SKILL.md` |

## External Consultant Hiring

| Trigger | Skill |
| --- | --- |
| Owner explicitly asks Castor to hire, pay, or consult an external specialist agent | `skills/hire-expert/SKILL.md` |
| Owner provides an external agent listing or A2A endpoint and asks for a consultation | `skills/hire-expert/SKILL.md` |

Do not load or use the Hire Broker for ordinary sessions. New or drifted
counterparty approval must match the exact confirmation prompt in the current
owner conversation; an assistant-generated confirmation flag is never enough.

## Delegated Workfiles Usage

| Trigger | Skill |
| --- | --- |
| User asks the calling assistant to use, inspect, copy, delete, export, or organize files in delegated workfiles | `skills/castor-workspace/SKILL.md` |
| User says a file or folder has been placed in delegated workfiles for the calling assistant to use freely | `skills/castor-workspace/SKILL.md` |
| User asks to export delegated workfiles contents to Google Cloud Storage or a RAG corpus | `skills/castor-workspace/SKILL.md` |

## PKM Authoring And Onboarding

| Trigger | Skill |
| --- | --- |
| User asks to write, structure, or maintain a project, area, or hub page on an already-writable compatible PKM surface | `skills/pkm-doctrine/SKILL.md` |
| User asks to improve PKM task wording, decide where PKM material belongs, or onboard an empty compatible PKM surface | `skills/pkm-doctrine/SKILL.md` |
| User asks what an email, file, message, or other indexed source says | `skills/ask-sources/SKILL.md`, not `skills/pkm-doctrine/SKILL.md` |
| User asks to create or maintain a wiki page | Out of scope for `pkm-doctrine` version 0.1; do not route to it |

`pkm-doctrine` is a tool-less authoring doctrine. It guides an assistant that
already has an authorized compatible writable PKM surface; it does not provide
a generic write integration or maintenance loop. Resolve the install's
authoritative task surface and restricted-content adapter before authoring.
Never create page-native tasks when an external task system is authoritative,
and never classify content as restricted merely because it came from email,
files, or messages.

## OpenClaw Runtime Updates

| Trigger | Skill |
| --- | --- |
| User asks to update OpenClaw behavior, Castor routing, installed Olympus, source-tool behavior, a skill, or the resolver | `skills/update-openclaw-runtime/SKILL.md` |
| A live Castor/Argus result differs from local repo expectations | `skills/update-openclaw-runtime/SKILL.md` |
| A source tool chooses the wrong lane because live assistant context may be stale | `skills/update-openclaw-runtime/SKILL.md` |

Before any live runtime config, secret, workspace, service, gateway, or plugin
install mutation, the update skill follows the OpenClaw system-change contract
it carries (source: `docs/ops/OPENCLAW_CHANGE_PROTOCOL.md` in the Olympus repo).
Host-specific procedure belongs to the deployment owner's operator protocol;
when the deployment names one and it cannot be read, do not restart or update.

Digest: contract first (`openclaw docs <query>` / `config.schema.lookup`,
never from memory) → blessed pathways only (`openclaw config set|unset` or
`config.patch`, never raw openclaw.json) → validate with
`openclaw config validate && openclaw doctor --lint --severity-min error --non-interactive`,
plus `openclaw secrets audit --check --allow-exec` when secrets/providers
changed → restart natively with `openclaw gateway restart`, then
`openclaw gateway status` and one real turn; the
`[gateway] http server listening (N plugins…)` journal line proves the Gateway
only, and `openclaw plugins inspect <name>` → `Status: loaded` proves a plugin.
Core updates: copy `state/openclaw.sqlite`, check `npm view openclaw engines`,
then plain `openclaw update` (it owns its restart and verifies the version);
never `openclaw update repair`. On failure use
`openclaw gateway stability --bundle latest` and the `config set` `.bak.*` rotation.
Test before bulk. Never ask for or store raw secrets; secrets changes are owned
by the 1P workstream. Custom gates around these commands were retired by the
owner on 2026-09-17; do not reintroduce them.

## Disambiguation

- Default to ordinary calling-assistant reasoning unless a trigger fires.
- Use the skill to choose `fast` versus `deep`.
- If Argus is unavailable, fail transparently and tell the user what did not
  run locally.
- If private email evidence is unavailable through `source_answer`, do not fall
  back to cloud-visible email access unless the user explicitly approves that
  posture.
- If source-index tools are unavailable, do not fall back to raw shell,
  `sqlite3`, local database files, or provider CLIs in ordinary calling-assistant
  sessions.
- Secure source reasoning normally leaves `analyst_provider` unset so the
  deployment-approved pool selects by health/latency or follows an explicit
  configured order. If the owner explicitly constrains the request to Venice,
  use `source_answer` with `analyst_provider: venice` plus the exact requested
  `analyst_model` when provided. An `e2ee-*` secure-answer id is typed-refused
  until local key handling exists. This does not authorize broad raw
  secure-local export; the calling assistant receives the bounded
  OPSEC-scanned answer.
- Delegated workfiles is a separate delegated filesystem root exposed through
  `castor_workspace`. Anything the owner places inside that approved root is
  intentionally available to the calling assistant without additional S4 approval prompts. Use
  `castor_workspace`, not shell or raw filesystem paths. Outside that root,
  normal Olympus source/security policy still applies.
- For ordinary source questions, do not inspect `skills/ask-sources/SKILL.md`
  with bash or file tools. Route directly to `source_answer`,
  `source_index_search`, and `source_index_status`; those tools are the
  runtime contract.
- For named Telegram groups, pass the human title/name as `chat_scope` (for
  example `ClawRyderz`) so Olympus resolves the indexed conversation metadata.
  Do not infer `conversation_id` from messages that merely mention the group
  name.
- For X/Twitter bookmarks, saved tweets, or saved posts, `xurl` is not the
  search lane. Use `skills/ask-sources/SKILL.md` and
  `internal.x.bookmarks`; the calling assistant may receive bounded bookmark
  passages and metadata because the corpus is `S1`/`internal`, but
  connector-store results currently omit X/Twitter URLs. Reserve `xurl` for public
  post reads/searches or explicit current-account X actions. Do not use
  `xurl read` to enrich bookmark candidates unless the user explicitly asks to
  inspect a specific public X URL or post ID they provide.
- When changing any OpenClaw-facing behavior, update the resolver, skill body,
  manifest, live installed extension, workspace `AGENTS.md`/`TOOLS.md` context,
  and run a natural OpenClaw agent smoke before declaring the live issue fixed.
- If file delivery is unavailable, do not fall back to broad `exec`, shell,
  redirection, `cat`, or raw absolute-path writes.
- External consultant hiring is a separate outbound containment path. Use
  `skills/hire-expert/SKILL.md`, `expert_hire`, and `expert_report`; never
  contact, pay, poll, or recover raw reports through shell/network fallbacks.
