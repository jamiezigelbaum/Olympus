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

Use the tier names Public, Personal, Private, and Secrets when explaining
results. Personal maps to `internal` (S1–S3); Private maps to `secure_local`
(S4). Existing IDs and tool flags such as `include_secure_local` keep their
spelling. In the schema-v1 tier keys of owner tier rules, `private` means
Personal and `secure` means Private; never substitute one for the other.

## Contract

Use Olympus tools rather than calling local model endpoints directly.

- `argus_ping` checks whether an Argus lane is reachable.
- `argus_list_models` lists served models for a lane.
- `argus_complete` sends one prompt to a local model and returns the response.

## Lane Choice

Honor an explicit lane request and the deployment's configured default lane
(`fast` in the shipped defaults). By default, `fast` and `deep` use the same
Delphi endpoint and model; selecting `deep` alone adds no reasoning depth or
privacy.

Operators can configure distinct endpoints or models for either lane. Follow
the deployment's approved routing guidance when they differ; do not assume
`deep` is an alias or unavailable. Use `argus_ping` and `argus_list_models`
when availability needs checking.

Sensitive content must follow the Privacy Posture below regardless of lane
name. Include only the evidence needed for the task.

## Privacy Posture

Do not silently send sensitive content elsewhere if Argus fails.

If the user requested local-only reasoning and Argus is unavailable, say so and
ask before using any non-local lane.

Private source answers normally use the active deployment's approved pool:
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
- "I used the deployment's configured Argus lane for this sensitive document task."
- "Argus was unavailable, so I did not process the sensitive content."
