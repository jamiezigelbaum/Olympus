# Anonymous answers: dashboard placement (1.1.0)

## A.9 — Two ways to ask

The Private answers page offers equal Ask privately and Ask anonymously panels
above the inbox. They sit side by side on wide windows and stack on phones.
Private asks use the built-in model on this computer; nothing leaves. Anonymous
asks send only the prepared question, without the owner's name, to an outside
model through zkAPI. The provider reads that question. The panel stays visible
when anonymous answers are off or not set up, with a Go to Models link.
The old #anonymous fragment lands on this panel.

## A.10 — Settings and disclosure

The existing local model settings page (Keys) holds Anonymous answers at
#anonymous: zkAPI setup, balance, turn-on switch, privacy statements, preparation
choices and writer checks. The status adapter remains content-free: no question
or reply is added to status, logs, telemetry, shared JSON or Needs you text.

## A.14 — Answers in the local inbox

Dashboard anonymous asks and agent tool asks retain the reply locally, labeled
Anonymous and who asked. The question displayed is exactly what the writer sent
outside. Sealed ChatGPT question-panel answers bypass inbox recording because
the panel already presents them. Direct ask_anonymously tool outcomes still
return through their existing result/source_answer_result path.

Anonymous asks retrieve no source items and attach no source citations; the
existing writer, secret gate, Strict privacy gate and final transport
authorization remain unchanged. Retained replies use the private inbox store,
its row/byte limits and deletion generation fences. Anonymous agent calls have
the same five-attempts-per-hour bound as automatic Private answers, with a
separate per-connection budget; human asks do not use an automatic-answer
budget. Reservations contain only a fixed placeholder, never the original
anonymous question. Replies have local-control-only
serving, export exclusion and data delete --all cleanup. Delete during a call or
connection revocation prevents its late reply from restoring the row.
