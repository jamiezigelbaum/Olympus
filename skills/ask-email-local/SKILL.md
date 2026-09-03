---
name: ask-email-local
version: 0.3.0
description: Compatibility guidance for private email questions; use the unified ask-sources/source_answer path instead of the legacy email_answer lane.
triggers:
  - user asks the calling assistant to search, inspect, summarize, or answer questions about email
  - task involves Gmail or Google Mail and the user expects private/local handling
  - task needs email evidence but raw messages should stay in the local/private lane
tools:
  - source_answer
  - source_index_search
  - source_index_status
mutating: false
---

# Ask Email Through Sources

This skill is a compatibility shim. For ordinary email, Gmail, mailbox,
sender, thread, or correspondence questions, use `skills/ask-sources/SKILL.md`
and the unified `source_answer` tool.

## Contract

Email is part of the source index:

- `source_answer` is the default answer path.
- Set `include_secure_local: true` when private email may be relevant.
- Omit `corpus_id` on the first private ask so Olympus can search private
  email, Dropbox, and protected Telegram together.
- Pin `corpus_id: secure_local.email.private` only when the user explicitly
  asks for email-only search or when a prior selected item came from email.
- Do not call `email_answer`, `email_index_search`, raw Gmail/browser tools,
  shell, or local databases for ordinary calling-assistant source questions.

## How To Ask

Good private email-capable request shape:

- tool: `source_answer`
- omit `corpus_id` unless the user explicitly says "only email"
- `include_secure_local: true`
- `include_secure_local_content: true` for bounded derivative answers
- `include_internal: true`
- `timeoutMs: 600000` for slow private/local reasoning

Good examples:

- "Did Alex send the revised invoice last week?"
- "What is the latest commitment from the assistant upgrade thread?"
- "Find the most relevant email about the Portugal booking and summarize the next action."

## Failure Behavior

If `source_answer` reports email is unavailable, stale, or skipped, tell the
user what the Olympus audit says. Do not fall back to cloud-visible Gmail reads
unless the user explicitly approves that different handling posture.
