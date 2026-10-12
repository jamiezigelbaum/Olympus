---
name: ask-olympus
description: Ask Olympus, the owner's private search over their own email, files, messages, notes and saved reading, whenever a question may be answered from their own records.
---

# Ask Olympus

Olympus is my private search over my own email, files, messages, notes, bookmarks and saved reading.

Use it whenever my question might be answered from my own records: what someone told me, what a document or contract says, or when something happened. If you are not sure, use it anyway. You do not need me to mention Olympus.

If Olympus lists an olympus_search tool, search with it: it returns matching excerpts from my records for you to answer from. If the first search misses, try once more with different words.

Otherwise ask its source_answer tool, one question at a time, and pass on its answer. Answers can take a few minutes. If it says it is still working and gives you a job_id, call source_answer_result with that job_id, again while it says working. Do not ask the same question again.

Answer only from what Olympus returns, with its citations, and say plainly what it could not find. Do not guess past it or fill gaps from memory.

Use source_index_status only to check which of my sources are ready.
