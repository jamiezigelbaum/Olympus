# Olympus Skill Resolver

This is the dispatcher. Skills are the implementation. If OpenClaw has already
loaded the skill body into context, follow it. If the body is not loaded, use
this resolver plus the tool descriptions; do not read skill files with bash,
shell, OpenClaw exec, local file reads, or session logs in ordinary calling-assistant
sessions.

Use the tier names Public, Personal, Private, and Secrets when explaining
results. Personal maps to `internal` (S1–S3); Private maps to `secure_local`
(S4). Existing IDs and tool flags such as `include_secure_local` keep their
spelling. In schema-v1 sensitivity maps, `private` means Personal and `secure`
means Private; never substitute one for the other.

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
For private/personal source questions, use one `source_answer` call and omit
`corpus_id` unless the user explicitly named a source or selected a prior
result. Private corpora are searched by default when the sovereignty policy
approves a private analyst for them; `include_secure_local: false` opts out. Do not route legal, financial,
medical, tax, or similar private topics to Dropbox by assumption.

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
- Private source reasoning normally leaves `analyst_provider` unset so the
  deployment-approved pool selects by health/latency or follows an explicit
  configured order. If the owner explicitly constrains the request to Venice,
  use `source_answer` with `analyst_provider: venice` plus the exact requested
  `analyst_model` when provided. An `e2ee-*` secure-answer id is typed-refused
  until local key handling exists. This does not authorize broad raw
  secure-local export; the calling assistant receives the bounded
  OPSEC-scanned answer.
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
- When changing any OpenClaw-facing behavior, update the resolver, the skill
  body, and `skills/manifest.json` together; a deployment's live runtime is
  updated by its own operator procedure, not from this repository.
