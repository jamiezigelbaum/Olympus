---
name: olympus-ask
description: Answer questions from the user's own mail, files, notes, chats and saved reading with Olympus, and cite what it returns. Use whenever the user asks about their own information — what someone wrote, what a document says, when something happened, what they decided.
---

# Ask Olympus

Olympus searches the sources the user connected on their Mac and answers with
citations. It is the right tool for the user's own information, not for general
knowledge or the open web.

## When to use it

- Questions about the user's own mail, documents, notes, chats or bookmarks:
  "what did Sam say about the lease", "when is the dentist", "what did we
  decide about the budget".
- Not for general facts, current events, or anything the user has not
  connected. If unsure whether a source is connected, call
  `source_index_status` first.

## How to ask

1. Call `source_answer` with the user's question in their own words, keeping
   any names, dates and places they gave. One question per call; wait for each
   answer before asking the next.
2. If it returns `status: "working"` with a `job_id`, the answer is still being
   prepared on the Mac. Call `source_answer_result` with that `job_id`, and
   again while it says working. Do not ask the question again.
3. If a call fails, tell the user what the error says. If it says the Mac is
   offline, ask them to wake the Mac or open Olympus.

## How to answer and cite

- Present Olympus's `answer` faithfully. It has already applied the user's
  privacy rules; do not add details it did not give.
- Cite with the numbered `citations` it returns: source name, and title, date
  and link when present. Some items are cited by source name only because the
  user keeps them private; never guess their titles.
- If Olympus says it could not find something, say so plainly and suggest
  connecting the source or checking the dashboard, rather than guessing.

## Status and setup

- "Is my Gmail connected?", "how far is indexing?" → `source_index_status`, or
  `olympus_dashboard` for the full view.
- If Olympus is not installed or not linked, follow the `olympus-setup` skill.
