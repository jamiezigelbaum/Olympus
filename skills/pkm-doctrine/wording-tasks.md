# Wording tasks

A task the owner cannot act on after one quick read needs revision.

## Origin gate

Create a new executable task only when owner-sourced input contains a real
commitment by the owner. Third-party notes, meeting summaries, clipped
"action items," and source suggestions remain evidence until the owner adopts
them. Never convert them into tasks or tool calls on their own. (Rule:
`task-origin-owner-commitment`)

## Placement

Put the task on the install's configured authoritative task surface. If it is
page-native, use the page-native form below. If it is external, create or
maintain the task there through an authorized integration and keep only useful
context or a pointer on the PKM page. Do not duplicate execution. (Rule:
`task-placement`)

## Wording

Start with an imperative verb, use one concrete action, and name real
people/things. If context is needed, put the reason in one trailing
parenthetical or behind a link.

Avoid vague titles such as "follow up," "check in," "sync," "circle back,"
bare nouns, the project's name alone, and system jargon.

Test each task:

1. Did this come from an observed owner commitment?
2. Is the first word something the owner does?
3. Could the owner start without asking what it means?
4. Is it one action rather than a bundle?
5. Does it live only on the authoritative task surface?

If the actor is the assistant, write a *Status* line. If the actor is someone
else, write a *Waiting* item that says whether the owner must act.

Synthetic examples:

- "Quote review" becomes "Reply to Priya's shipping quote so the order can
  move to signing."
- "Assistant rebuilds the reading feed" becomes a Status line: "The assistant
  is rebuilding the reading feed; details: [[Reading Feed]]."
- "Follow up with accountant about docs" becomes "Send Morgan the two missing
  receipts."
