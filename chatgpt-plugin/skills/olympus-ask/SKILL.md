---
name: olympus-ask
description: Answer questions from the user's own mail, files, notes, chats and saved reading with Olympus, and cite what it returns. Use whenever the user asks about their own information — what someone wrote, what a document says, when something happened, what they decided.
---

# Ask Olympus

Olympus searches the sources the user connected on their Mac and returns
evidence with citations. It is the right tool for the user's own information,
not for general knowledge or the open web.

## When to use it

- Questions about the user's own mail, documents, notes, chats or bookmarks:
  "what did Sam say about the lease", "when is the dentist", "what did we
  decide about the budget".
- Not for general facts, current events, or anything the user has not
  connected. If unsure whether a source is connected, call
  `source_index_status` first.

## How to ask

1. Call `olympus_search` with the user's question in their own words,
   keeping any names, dates and places they gave. Set `detail` to `"full"`
   only when the user asks for all the details, the full results or every
   value; leave it out otherwise.
2. Answer only from the returned evidence, and cite each claim with its
   evidence id in brackets, like [E2], linking the url when there is one. If
   the evidence does not answer the question, say briefly what you could not
   find. Search again with different words if the first results miss.
3. If you use `source_answer` instead (it is offered only when the user set
   up an answer model on their Mac) and it returns `status: "working"` with a
   `job_id`, call `source_answer_result` with that `job_id`, and again while
   it says working. Do not ask the question again.
4. If a call fails, tell the user what the error says. If it says the Mac is
   offline, ask them to wake the Mac or open Olympus.

## Private items

Olympus never gives you the contents of items the user keeps Private. When a
result's notes say some matching items are Private and Olympus is answering
privately in the panel:

- Keep your reply short: Olympus is preparing the answer privately on the
  user's Mac, and it will appear in the panel, visible only to them.
- Do not guess at what those items say, do not report their file names as
  findings, and do not ask the user to upload, attach or paste them: Olympus
  already has them.
- For a follow-up about them, search again with the follow-up as a complete
  question (name the item, its date or subject); the panel answers it the
  same way.

## Anonymous questions

Only when the user asks for a private or anonymous question (for example
"use Olympus to ask a private question"):

- If they have not written the question yet, call `open_private_question`
  at once and tell them to type it in the panel. Never ask them what the
  question is: anything written in this conversation is no longer private.
- If they already wrote the question here and want it sent anonymously, call
  `ask_anonymously` with it. If it returns `needs_choice`, ask once whether
  they want Strict or Standard, then call again with their choice.
- If a result says anonymous questions are not set up or not available, tell
  the user in those words; it is set up in Olympus on their Mac.

## Status and setup

- "Is my Dropbox connected?", "how far is indexing?" → `source_index_status`,
  or `olympus_dashboard` for the full view.
- Mention coverage (unread or not-yet-sorted items) only if the user asks why
  something is missing or the answer depends on it.
- If Olympus is not installed or not linked, follow the `olympus-setup` skill.
