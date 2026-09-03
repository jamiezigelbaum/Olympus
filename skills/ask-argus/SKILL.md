---
name: ask-argus
version: 0.1.0
description: Use Argus for local/private reasoning through Olympus.
triggers:
  - user explicitly asks for Argus, the local model lane, local model, or local-only reasoning
  - sensitive content should stay out of ordinary cloud-model context
  - cheap local synthesis is sufficient
tools:
  - argus_ping
  - argus_list_models
  - argus_complete
mutating: false
---

# Ask Argus

Argus is the local/private reasoning lane for Olympus. In v0.1, Argus means
MLX-served local models exposed through OpenAI-compatible endpoints.

## Contract

Use Olympus tools rather than calling local model endpoints directly.

- `argus_ping` checks whether an Argus lane is reachable.
- `argus_list_models` lists served models for a lane.
- `argus_complete` sends one prompt to a local model and returns the response.

## Lane Choice

Use `fast` by default for interactive work:

- ordinary local reasoning
- quick summaries
- short classification
- low-latency routing checks

Use `deep` for slower or more careful work:

- document analysis
- S4 boundary checks
- sensitive review
- cases where caution matters more than latency

If you are unsure, start with `fast` for low-stakes work and `deep` for
sensitive or consequence-heavy work.

## Privacy Posture

Do not silently send sensitive content elsewhere if Argus fails.

If the user requested local-only reasoning and Argus is unavailable, say so and
ask before using any non-local lane.

Secure source answers normally use the active deployment's approved pool:
equal local/Venice members are selected by recent health/latency unless the
policy configures an order. If the owner asks Argus to constrain the request to
Venice, route the source question through `source_answer` with
`analyst_provider: venice` and set `analyst_model` to the exact requested model
id when one is given. An `e2ee-*` secure-answer id is typed-refused until local
key handling exists. Venice is an equal trusted-private pool member, not an
ordinary cloud fallback.

If the user asks through Argus because they do not want the calling assistant to see
secure-local material, keep the source content and derived answer in the
Argus/local lane. Do not reroute the same evidence through the calling assistant or set
calling-assistant-facing secure-local release flags.

If the owner asks the calling assistant for a specific answer from S4 source material and also
requests Venice, use Venice only to reason over the approved `source_answer`
evidence pack when the active policy permits it; otherwise report that the raw
secure-local answer stayed local. Return the bounded OPSEC-scanned answer
through the calling assistant. Do not export raw secure-local source text to the calling assistant, and ask for confirmation before
bulk/raw release requests such as copying an entire tax return or lab archive
into calling-assistant-visible output.

For S5 material such as passwords, tokens, recovery codes, private keys, and
bank credentials, do not place raw values in ordinary prompt context.

## Prompting Guidance

Keep prompts direct and bounded:

- state the task
- include only the needed evidence
- ask for structured output when downstream handling depends on it
- ask the model to say when evidence is insufficient

Prefer short system prompts over large policy dumps. The skill and Olympus
trust model carry the durable policy; the prompt should carry the immediate
task.

## User Communication

When local routing matters to the user, say that Argus was used and name the
lane if useful.

Examples:

- "I used Argus fast for this quick local pass."
- "I used Argus deep because this touches sensitive document reasoning."
- "Argus was unavailable, so I did not process the sensitive content."
