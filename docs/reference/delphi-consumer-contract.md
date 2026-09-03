<!--
OLYMPUS SNAPSHOT of the Delphi-owned consumer contract.
Canonical: the Delphi repo, docs/reference/delphi-consumer-contract.md
(working copy seen at ~/Code/Delphi-wt-model-eval on 2026-08-19).
Delphi owns this document; Olympus codes against it. Re-snapshot when the
Delphi side announces a change — do not edit the contract text here.

Olympus consumer notes (ours, 2026-08-19):
- the private host reaches the router through olympus-delphi-tunnel.service:
  127.0.0.1:28090 -> delphi 127.0.0.1:8090. Every Argus text/vision profile
  targets http://127.0.0.1:28090/v1 with a delphi/* profile id; backing model
  ids never appear in Olympus config (they rotate without notice).
- Embeddings also go through the ROUTER (28090) as of 2026-08-19, with one
  nuance: the wire model id stays `secure-local-qwen3-embed`, because that id
  IS the pinned epoch identity (OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH) and the
  refresh gate requires the two to match. The router accepts the backing id
  for this lane (probed 2026-08-19), and vectors were proven BYTE-IDENTICAL
  across the direct and router paths before the switch. If Delphi ever drops
  backing-id aliasing, the epoch migration to `delphi/embedding` becomes its
  own tranche.
- The tunnel forwards exactly one port: 28090 -> 8090 (the router). The
  direct-backend and retired forwards were trimmed 2026-08-19 after a
  consumer audit found zero users.
- SECTION 7 (safety posture) IS UNDER REVISION per the owner, 2026-08-19 —
  treat its specifics as unsettled. Olympus's posture is unconditional:
  moderation is the consumer's responsibility on every local-model path,
  whatever §7 ends up saying.
-->

# Delphi Consumer Contract — how to call the local model appliance

Status: active interface contract. Delphi owns this document; consumers code
against it.
Audience: Olympus and any other downstream consumer.
Last reviewed: 2026-08-19

Delphi is a private local-model appliance. It serves chat, vision/OCR and
embeddings over one OpenAI-compatible endpoint. This is everything a consumer
needs; you do not need access to the Delphi repo to code against it.

---

## 1. The one rule

**Name a profile. Never name a model.**

```jsonc
{ "model": "delphi/default-chat" }          // correct
{ "model": "qwen3.8:27b-mlx" }              // WRONG — will break
{ "model": "mlx-community/Qwen3.6-35B..." } // WRONG — will break
```

Profile ids are the stable contract. The model behind a profile **changes
without notice** — it changed on 2026-08-17 and again on 2026-08-19. The router
substitutes the current backing model for you.

Every consumer breakage we have had came from ignoring this rule. A client that
hardcoded a model id in July was still asking for it in August, two days after
that model was retired. Had it named a profile, both swaps would have been
invisible to it.

Corollary: **do not display a backing model id in your UI** unless you fetch it
live from `GET /v1/models`. A cached one becomes a lie.

## 2. Connecting

The router listens on **loopback only**, on the appliance:

```
http://127.0.0.1:8090/v1
```

It is not exposed on the LAN, and that is deliberate. Reach it by SSH to the
appliance and talk to `127.0.0.1:8090` from there. Do not pin a LAN IP — those
change; the loopback contract does not.

Ports `:8000`, `:11434` and `:8011` are the individual backends. They are
diagnostic and bypass surfaces. **Do not call them directly** — you lose
profile routing, request defaults, queueing and memory gating, and you couple
yourself to a model id. `:8003` and `:8004` are retired; never use them.

## 3. Profiles

| Profile | Use it for |
|---|---|
| `delphi/default-chat` | General chat and reasoning. The default. |
| `delphi/source-answer` | Long-context answer synthesis over source material. |
| `delphi/vision-quality` | Normal image and document extraction (OCR). |
| `delphi/vision-fast` | Backward-compatible alias for `vision-quality`. |
| `delphi/vision-deep` | Hard documents — scanned, table-heavy, degraded. The OCR escalation tier. |
| `delphi/embedding` | Retrieval vectors. 2560 dimensions. |

Endpoints: `POST /v1/chat/completions` for all chat and vision profiles,
`POST /v1/embeddings` for `delphi/embedding`, `GET /v1/models` to list
profiles with their current backing model.

**Images:** if you send an image without naming a profile you get
`delphi/vision-quality`, the cheap OCR lane. To reach the expensive
vision-capable lane you must ask for `delphi/vision-deep` explicitly. Send
images as `image_url` content parts with `data:` URIs.

## 4. Request shape

Standard OpenAI chat completions. Two rules beyond that:

**Do not send `reasoning_effort`.** As of 2026-08-19 the backing runtime
rejects `reasoning_effort: "none"` with **HTTP 400**. The router already
suppresses thinking on every text profile; you do not need to ask.

**To opt into thinking**, send:

```json
{ "chat_template_kwargs": { "enable_thinking": true } }
```

Thinking costs latency and tokens. Default is off for a reason — turn it on
only for genuinely ambiguous work.

Streaming is supported and relayed as a real stream, not buffered.

## 5. Errors and behaviour you must handle

**Unknown profile ids fail. They do not fall back.** This is intentional — a
silent fallback means a typo ships to production and nobody notices. If you get
an error naming an unknown profile, you have a bug; do not add a retry that
papers over it.

**Requests queue.** Each profile runs one request at a time, with a queue
timeout of 3600 s. A slow response may be a queue wait, not a hang. Set client
timeouts accordingly and do not fire concurrent requests at the same profile
expecting parallelism — you will not get it.

**Requests wait for memory.** Dispatch is gated on available RAM (12 GB for
text and deep-vision profiles, 8 GB for OCR, 4 GB for embeddings). Under
pressure a request waits rather than failing.

## 6. Performance envelope — read this before sending large documents

Measured 2026-08-19 on the current backing model. These are not guesses.

| Prompt size | Time to first token | Then generates at |
|---|---:|---:|
| short | under 1 s | ~44 tok/s |
| 8K | ~48 s | ~23 tok/s |
| 32K | ~230 s | ~12 tok/s |
| 128K | **~15 minutes** | **~2.5 tok/s** |

**The practical ceiling is roughly 32–64K, not the 262K the model advertises.**
Above that it works but is rarely worth waiting for.

Two consequences for how you build:

- **Chunk large documents.** Four 32K calls beat one 128K call by a wide margin.
- **Re-sending an identical prompt is nearly free up to ~64K** — a repeated 32K
  prompt drops from 230 s to about 0.5 s because it is cached. Above ~64K that
  cache stops working and you pay full price every time. Structure repeated
  work to stay under it.

## 7. Safety posture — changed 2026-08-19

The default text model is **uncensored**: its refusal behaviour was
deliberately removed, and its publisher measures zero refusals on a standard
harmful-prompt benchmark. It will not decline topics.

For a private appliance that is mostly irrelevant — topic refusal is not a
property this deployment was relying on. Two things are relevant, and they pull
in opposite directions.

### 7.1 Restricted-material handling: measured, and it improved

The concern that matters is whether the model still keeps restricted material
out of general-purpose output. **It does, and better than the model it
replaced.**

On the 20-case behavioural suite it scored 19/20 with **zero false negatives
across all five restricted-material cases**, against the previous model's 18/20.
Specifically:

- an indirect reference to a restricted item routes correctly and exposes only
  safe metadata — this is the exact case that got an earlier model **retired**
  for leaking a restricted codename;
- a contract fragment correctly identifies codename, counterparty, price and
  concession as restricted;
- a lookalike that merely resembles restricted material is correctly **not**
  over-routed.

Refusal removal and handling discipline turned out to be separable
capabilities. Removing the former did not damage the latter.

### 7.2 Prompt injection: plausibly weaker, and untested

This is the real open risk, and it sits squarely in the consumer's remit.

Abliteration works by removing the model's refusal direction. Declining to obey
an instruction embedded in retrieved content is arguably a *form* of refusal —
so the mechanism that ignores "ignore your instructions and do X" when it
appears inside an email or document may have been weakened along with the one
that declines harmful topics.

**We have not tested this. Not once.** It is a mechanism-level hypothesis, not
a measurement. The one piece of adjacent evidence is mildly reassuring: the
publisher reports the distribution shift is concentrated on overtly harmful
prompts (mean divergence 0.562) and is near-zero on ordinary capability prompts
(0.056, median 0.011 overall) — and an injection payload buried in a document
looks more like the latter. That is weak reassurance, not a result.

Practical consequence: **treat any content the model summarises, extracts from,
or reasons over as untrusted input**, and do not let model output alone
authorise an action with side effects. That was already correct practice with
the previous model; it matters more now, and it is worth an explicit test
against this model if any pipeline feeds it third-party content.

## 8. What Delphi guarantees, and what it does not

**Stable:** profile ids, the loopback endpoint, OpenAI-compatible request and
response shapes, fail-closed behaviour on unknown profiles.

**Not stable, will change without notice:** the model behind any profile, its
context window, its exact latency, and its tokeniser. Never persist a backing
model id, never assume a context size, never cache a tokenisation.

**Not guaranteed:** uptime. This is a single box. It has no redundancy and is
sometimes taken down for benchmarking or maintenance. Degrade gracefully;
never let a Delphi outage corrupt consumer state.

## 9. Health checks

```bash
curl http://127.0.0.1:8090/live      # router process alive
curl http://127.0.0.1:8090/health    # backends + model visibility + memory
```

`/health` returns `ok: false` if any backing model is missing or the wrong one
is loaded. Poll `/live` for liveness; use `/health` before a large batch.

## 10. If something breaks

Report to the Delphi side with: the profile id you asked for, the full request
body minus content, the HTTP status, and roughly when. The two failure modes
that have actually happened:

1. **A hardcoded model id** that got retired. Fix: name a profile (§1).
2. **Sending `reasoning_effort`**, which now 400s. Fix: stop sending it (§4).

Check those two before escalating.
