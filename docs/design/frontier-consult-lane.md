# Anonymous answers: dashboard placement (1.1.0)

## A.9 — One question, three destinations (owner direction 2026-10-14)

Owner decision (2026-10-15): layout C, the privacy ladder, with copy set 3
(Models). One question box sits above Local model, zkAPI model and Venice model,
least shared first. The local detail is “It searches your files.” A dashed
“Leaves this computer” boundary separates local from cloud, with “Least shared
first” beside it. Each row has its own button in one right-hand column, aligned
to its name; the ladder is capped at 920px to keep text and actions together.
Rows stack in the same order on phones. Copy lives in vocabulary.ts; layout
uses the dashboard's tokens and buttons. Setup, off and paused states retain
their Models/settings repair links. This is copy and layout only.
Every destination stays visible in ready, not-set-up, privacy-disallowed and
answering states. Setup replaces Ask in that same row: Venice opens the existing
Models/connect path and zkAPI opens Models #anonymous. A connected Venice key
without Private permission links to the privacy setting explanation.
The old #anonymous fragment lands on the zkAPI option.

This computer uses only the built-in model. Venice uses the existing shared
source_answer handler and the owner's approved secure_local pool, with the same
current-evidence, release and catalog gates as agent Private answers. Its
permission is rechecked at dispatch. A Secret item never enters the model pack.
A local fallback cannot be labeled as Venice. No new inference lane is added.
zkAPI continues through consult-ask's existing writer and outbound gate.

## A.10 — Settings and disclosure

The existing local model settings page (Keys) holds Anonymous answers at
#anonymous: zkAPI setup, balance, turn-on switch, privacy statements, preparation
choices and writer checks. The status adapter remains content-free: no question
or reply is added to status, logs, telemetry, shared JSON or Needs you text.

## A.14 — Answers in the local inbox

Dashboard anonymous asks and agent tool asks retain the reply locally, labeled
zkAPI model and who asked. The question displayed is exactly what the writer sent
outside. Sealed ChatGPT question-panel answers bypass inbox recording because
the panel already presents them. Direct ask_anonymously tool outcomes still
return through their existing result/source_answer_result path.

Anonymous asks retrieve no source items and attach no source citations; the
existing writer, secret gate, Strict privacy gate and final transport
authorization remain unchanged. Retained replies use the private inbox store,
its row/byte limits and deletion generation fences. Anonymous agent calls have
a five-attempts-per-hour bound per connection, because each send spends the
owner's deposit; human asks do not use it. Automatic Private answers have no
such bound (owner ruling, 2026-10-29): every question an agent asks is answered. Reservations contain only a fixed placeholder, never the original
anonymous question. Replies have local-control-only
serving, export exclusion and data delete --all cleanup. Delete during a call or
connection revocation prevents its late reply from restoring the row.

Venice inbox rows show the titles of every item passed to that model, including
uncited items, alongside sources. Those identities are rechecked on read/open.
A withdrawn Venice answer asks the owner to ask again; no automatic cloud retry.
All three destinations retain answers locally with who asked and relative time
(exact time in the title attribute), under the heading Inbox and the line
“Answers from every model, kept on this computer.” Nothing stored enters remote
surfaces, exports, telemetry or shared JSON; delete --all removes all three.
