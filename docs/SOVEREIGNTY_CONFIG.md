# Sovereignty Configuration

Status: active
Updated: 2026-09-05

## Agent-led model setup for the v0.4 beta

Use this guide with your own agent after the plugin is installed. The
[Quickstart](QUICKSTART.md) covers installation; the
[agent install guide](../INSTALL_FOR_AGENTS.md) owns consent, credential
sourcing, existing-install safety, and restart procedures.

**Shipped model defaults:** the worker uses Olympus's registered dimensions
when no dimension override is supplied: Gemini Embedding 2 uses 3072 and the
registered local `secure-local-qwen3-embed` model uses 2560. A fresh install
using those models needs no dimension flag or generated-file edit. Explicit
settings retain precedence and invalid values still refuse startup.

**Custom-model limit:** an unregistered model still needs its authoritative
dimension, and the CLI does not yet expose a complete custom model-settings
path. Stop and report that limitation instead of inventing flags, relabelling
another model as a registered one, or editing `worker.env`. Older builds that
refuse a missing dimension for a shipped model need the qualified beta fix;
reconnecting the key does not repair them. See the
[release plan](V0_4_RELEASE.md#model-setup-for-testing-and-v05).

### Choose reasoning and search separately

An **answer model** reads retrieved evidence and writes an answer.
An **embedding model** turns permitted material into vectors for semantic
search. Buying a Venice account does not configure embeddings. A provider
approved for secure answers is not automatically approved for secure vectors.

Here, **non-secure** means public data and classified private data that you
permit ordinary cloud models to process. **Secure** includes health, finance,
legal, and similarly sensitive material. Secrets are denied to every model.

| Preset | Non-secure embeddings | Secure search | Secure answers | You supply |
|---|---|---|---|---|
| `private-cloud-only` — beta default when you do not run local models | Gemini Embedding 2 | Local keyword search; no secure vectors | Approved Venice Private/TEE model | Gemini key; Venice account, usable API balance and key |
| `local-only` | Gemini Embedding 2 | Local embedding model | Local answer model | Gemini key; local server and exact registered model IDs, with their matching output dimensions |
| `local-first` | Gemini Embedding 2 | Local embedding model | Local answer model, with approved Venice escalation | All local-only requirements plus Venice account, API balance and key |
| `no-sensitive` | Gemini Embedding 2 | Secure content is unavailable to answering | None | Gemini key |

`local-only` describes the handling of **secure** data; the shipped preset
still uses Gemini for non-secure embeddings. It is not an all-offline preset.
The ordinary answer path uses the host's configured inference route by default.
Neither a Gemini key nor a Venice key creates an OpenClaw subscription/login.

Secure content never goes to Gemini. The private-cloud-only preset does not
require a GPU or a local embedding server: its secure search stays lexical.
Local presets support local secure embeddings; do not describe every v0.4
preset as lexical-only. Venice E2EE integration and cloud secure embeddings
are outside this release.

### Give your agent this prompt

> Help me configure Olympus's models for this beta using the installed
> `docs/SOVEREIGNTY_CONFIG.md` and `INSTALL_FOR_AGENTS.md`. Explain which data
> goes to Gemini, Venice, or local models before asking me to choose a preset.
> First check the installed version and effective model identities. Use the
> registered dimensions for shipped models when no override is configured.
> If a custom model needs unsupported settings, report the limitation instead
> of editing generated files or disguising it as another model.
> Help me create my own provider accounts and set a spending limit; I will
> handle sign-in, terms, purchases, and billing changes. Fetch credentials only
> from exact password-manager items I name and authorize, and pass each key
> directly to the documented stdin connect command. Never ask me to paste a
> key into chat. For local models, confirm my hardware, server, exact model
> IDs, endpoints, and measured vector dimension. Preserve existing vectors
> and settings. Report account/key validity, model readiness, worker health,
> and a cited-answer test separately; do not call setup complete just because
> a key was accepted. Stop at any missing prerequisite and explain the next
> supported action.

### Gemini: create and connect your own key

1. Open [Google AI Studio's API Keys page](https://aistudio.google.com/apikey)
   in your own Google account. Create or select the Cloud project for Olympus;
   an existing project may need to be imported into AI Studio first. Follow
   Google's [API-key instructions](https://ai.google.dev/gemini-api/docs/api-key).
2. Review the current [Gemini pricing and data-use terms](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2).
   Free and paid tiers have different data-use terms. Do not infer a privacy
   guarantee from the label "private" in Olympus, and do not enable billing
   without your own approval. Set appropriate quota/billing alerts; an alert
   alone is not a spending cap.
3. Create a key for this installation, keep it in your password manager, and
   give the agent its exact item/field reference. The agent fetches it once
   and runs `printf '%s' "$KEY" | "$OLYMPUS_BIN" connect gemini --api-key-stdin`,
   using the executable resolved from `openclaw plugins inspect olympus --json`.
   `KEY` represents an in-memory manager read or your silent terminal input,
   never a value pasted into a command, file, chat, or log. Unset it afterward.

The connect command validates the key before storing it in the owner-only
managed worker environment. That confirms authentication, not successful
embedding or sufficient quota. Confirm the dimension prerequisite **before**
this step and follow the managed restart procedure only after it is met.

Gemini Embedding 2's [documented default](https://ai.google.dev/gemini-api/docs/embeddings)
is 3072 dimensions, matching Olympus's registered default. Existing
`OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY` settings take
precedence; no new setting is needed for the shipped model. Record the chosen
model, output size, and expected usage cost. Never change an
existing embedding size merely to make startup pass. An existing corpus needs
an approved migration/re-embedding decision, with vectors preserved.

### Venice: create an account with API access

This step applies to `private-cloud-only` and `local-first`.

1. Create or sign in to your account at [Venice](https://venice.ai), then open
   [API settings](https://venice.ai/settings/api).
2. Check the account's spendable API balance and
   [current API pricing](https://docs.venice.ai/overview/pricing). A chat login
   or subscription by itself does not prove usable API funds. You approve any
   subscription, credit purchase, or billing change; the agent does not buy it
   as part of installation.
3. Follow Venice's [key creation guide](https://docs.venice.ai/guides/getting-started/generating-api-key).
   Create an **Inference Only** key named for this Olympus installation and
   set a consumption limit you accept. Save the one-time key display in your
   password manager. An Admin key is unnecessary.
4. Authorize the named-item read and have your agent run
   `printf '%s' "$KEY" | "$OLYMPUS_BIN" connect venice --api-key-stdin`, then
   unset `KEY`. This writes Olympus's `store:venice.api_key` entry. It does not
   purchase credits or silently change your privacy preset.

Verify both the key and one small, consented model request: a valid key may
still be blocked by an empty balance or a per-key limit. Use only a model the
live Venice catalog and Olympus policy accept for secure answers. Do not
respond to an unavailable route by sending secure data to an ordinary cloud
provider. Keep the preset's existing model choice unless you approve a change.

### Local models: bring a running server

For local presets, the agent should inventory your hardware and existing
model software, then help you run an answer model and a separate embedding
model. A model file, an OpenClaw provider plugin, or a chat-only server is not
enough. The server must expose working OpenAI-compatible chat and embedding
endpoints. [Ollama](https://docs.ollama.com/api/openai-compatibility) and
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat) document compatible
interfaces; check the chosen runtime and model rather than assuming parity.

Read the installed preset and effective policy first. The shipped
`local-first` and `local-only` presets use `http://127.0.0.1:28090/v1` for both
profiles, with model IDs `delphi/source-answer` and `secure-local-qwen3-embed`.
These are expected model IDs, not proof a server exists. Your agent must verify
that the endpoint serves those IDs, or explain the explicitly approved policy
configuration needed for your server. Do not blindly use ports from an older
guide or download a particular model without checking hardware requirements.

Using synthetic text only, verify `/models`, a short `/chat/completions`
request, and an `/embeddings` response. Record the actual model ID and vector
length. Local dimensions come from the model, not the Gemini default. The
registered `secure-local-qwen3-embed` model defaults to 2560; an existing
`OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY` setting takes precedence.
Do not assign that model ID to a different model or vector space. An
unregistered model without an explicit dimension still refuses startup, and
the current custom-settings limitation applies to that case.
Keep secure embedding requests on loopback; local reasoning with optional
Venice escalation does not permit Venice or Gemini to receive secure
embedding inputs.

### Verify readiness, then connect a source

Have the agent check these as separate results: the chosen preset and data
destinations; each required credential, endpoint and dimension; successful
worker activation and `olympus doctor`; then one user-selected source, a
bounded initial sync, and a normal question with checked citations. Report
keyword-only operation honestly. No indexed data means no answer proof yet.

The v0.4 dashboard handles source connections and shows progress/credential
problems, but it has no complete model-account or embedding-configuration
wizard. Full model setup in the dashboard is planned for v0.5. The registered
defaults remove the missing-dimension startup failure for shipped models;
custom model configuration and clean-install qualification still need their
own proof. Do not repair testers' machines through undocumented edits.

## Purpose

Olympus should let each user define what data sovereignty means for them.

The long-term product should not assume that private always means local. A user
may choose local MLX models for secure data, encrypted web models for private
work, ordinary cloud models for public material, or a mix.

## Configuration Concepts

### Data Classes

A data class describes what kind of information is being handled. User-facing
language is public, private, secure, and secrets; internally those map to the
existing granular trust scale (`public_safe`, `internal`, `secure_local`, and
S5).

Examples:

- `public`
- `private`
- `secure`
- `secrets`

### Execution Trust Postures

An execution trust posture describes the minimum acceptable handling posture for
a model or provider. This is separate from the user-facing data categories in
[TRUST_MODEL.md](TRUST_MODEL.md).

Early vocabulary:

- `local`: runs on hardware controlled by the user or organization.
- `encrypted_cloud`: remote model path with explicit privacy or encryption
  commitments accepted by the user.
- `standard_cloud`: ordinary hosted model provider path.
- `never_model`: should not be exposed as ordinary prompt context.

### Model Profiles

A model profile names a usable model path and its trust properties.

Examples:

- local MLX endpoint on a Mac Studio
- OpenAI-compatible endpoint on a home server
- Venice.ai encrypted model
- OpenAI hosted model
- Anthropic Claude CLI model

### Routing Policy

Routing policy maps tasks and data classes to allowed model profiles.

The policy should fail closed. If no approved model is available for a data
class, Olympus should ask for approval or refuse the operation rather than
silently falling back to a less trusted model.

For secure data, the primary abstraction is the **secure analyst pool**: the
deployment-approved set of equal, first-class model profiles that may receive
raw `secure_local` evidence. This deployment approves loopback Delphi/local
profiles plus Venice models whose catalog category is Private or TEE. Another
deployment may approve a different set; membership is configuration, never a
provider fallback hidden in code.

Pool order is optional. With no `order`, the worker chooses from recent
content-free member health and latency and rotates unresolved ties independently
of config list position. An explicit `order` makes the pool a serial preference
for that deployment (the `local-first` preset is one such configured ordering).
Existing `analyst: [...]` route lists remain accepted and are parsed as an
explicit order, preserving deployed behavior during migration.

The secure-answer E2EE gate is temporarily narrower than Venice's category
floor: any normalized `e2ee-*` model id configured as a secure-pool member gets
a typed policy refusal. Those models need local key handling Olympus has not
built. The gate is enforced in code before worker construction; it is not a
documentation warning. The current secure Venice defaults are `kimi-k3`
(strong) and `inkling` (normal tier).

### Retrieval Trust Domains

A retrieval trust domain describes which search spaces a caller may query and
which embedding backends may be used to build those spaces.

Technical route keys:

- `secure_local`: secure corpora. Local retrieval, local embeddings, and
  secure-custodian callers only.
- `internal`: private corpora approved for ordinary assistant reasoning. Cloud
  embeddings are allowed by default once material is classified private.
- `public_safe`: explicitly public corpora. Cloud embeddings are allowed in
  stores that never mix with private or secure material.

Retrieval trust domains govern search, embedding, and model-context routing.
They do not by themselves forbid approved cloud service providers from acting as
vaults, OAuth custodians, evidence stores, or credential brokers for secure or
secrets material.

Retrieval policy must fail closed just like model routing. A query may only hit
the corpus collections allowed for the current caller, session, task, and trust
domain. A unified search result is produced by policy-aware late fusion over
allowed collections, not by searching one mixed-trust global vector pool.

### Embedding Policy

Embedding policy maps a corpus to allowed embedding providers and records the
embedding epoch used to build derived vectors.

Rules:

- ordinary cloud embeddings are never allowed for secure data; a future
  secure-provider embedding lane would need its own explicit provider approval,
  corpus policy, and audit proof
- cloud embeddings are the default for classified private and public corpora,
  because those corpora are approved for ordinary cloud-model use
- the default cloud-capable embedding provider for private and public corpora
  is Gemini Embedding 2, so text, images, diagrams, video, audio, and documents
  can live in one multimodal semantic space per corpus
- local embeddings may still be used for offline, cost, fallback, or evaluation
  reasons, but they are not the durable default for cloud-approved material
- private and public stores must remain separate even when they use the same
  embedding provider or model family
- local and cloud embeddings must not mix inside the same corpus generation
  epoch
- embeddings are derived data and inherit the corpus handling posture

## Active Shape

Olympus v0.3 activates the sovereignty engine. The default location is
`~/.olympus/sovereignty.json`; `OLYMPUS_SOVEREIGNTY_CONFIG`,
`OLYMPUS_SOVEREIGNTY_CONFIG_PATH`, or plugin config
`sovereignty.configPath` may point elsewhere. The OpenClaw plugin config may
also inline the same object at `sovereignty.policy`.

Secrets are never stored inline. Profiles use `secretRef` values such as
`env:VENICE_API_KEY` or `store:venice.api_key`; the worker resolves those
references at call time.

Minimal schema:

```json
{
  "schemaVersion": 1,
  "modelProfiles": {
    "local-source-answer": {
      "provider": "local-openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "model": "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
      "trust": "local",
      "purpose": "analyst"
    },
    "venice-private": {
      "provider": "venice",
      "baseUrl": "https://api.venice.ai/api/v1",
      "model": "kimi-k3",
      "secretRef": "store:venice.api_key",
      "trust": "encrypted_cloud",
      "purpose": "analyst"
    },
    "cloud-openclaw-infer": {
      "provider": "openclaw-infer",
      "model": "openai/gpt-5.5",
      "trust": "standard_cloud",
      "purpose": "analyst"
    }
  },
  "routes": {
    "secure_local": {
      "pool": {
        "members": ["local-source-answer", "venice-private"]
      }
    },
    "internal": { "analyst": ["cloud-openclaw-infer", "local-source-answer"] },
    "public_safe": { "analyst": ["cloud-openclaw-infer"] }
  },
  "retrieval": {
    "trustDomains": {
      "secure_local": {
        "minimumExecutionTrust": "local",
        "allowedEmbeddingTrust": ["local"],
        "embeddingProfile": null,
        "allowCloudQuery": false,
        "activationMode": "lexical_only",
        "secureHandling": "answerable"
      },
      "internal": {
        "minimumExecutionTrust": "standard_cloud",
        "allowedEmbeddingTrust": ["local", "standard_cloud"],
        "embeddingProfile": "gemini-source-embedding",
        "allowCloudQuery": true,
        "activationMode": "hybrid_shadow"
      },
      "public_safe": {
        "minimumExecutionTrust": "standard_cloud",
        "allowedEmbeddingTrust": ["local", "standard_cloud"],
        "embeddingProfile": "gemini-source-embedding",
        "allowCloudQuery": true,
        "activationMode": "hybrid_shadow"
      }
    }
  }
}
```

Hard invariants remain enforced outside user control:

- Venice S4 routing follows the
  [canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative)
- secure-pool profiles are loopback local or Venice only; standard cloud,
  other self-declared encrypted-cloud providers, Venice Anonymized models, and
  E2EE model ids while the local-key gate stands are refused
- non-final secure-pool leg budgets are sized inside the 60-second interactive
  SLO; under the later 2026-07-24 owner ruling, the final available member gets
  a separately bounded completion budget rather than being interrupted while
  finishing. Timed-out legs receive a shared abort signal through catalog and
  chat fetch, and residual non-cooperative orphans are counted content-free
- consecutive member failures open a worker-local cooldown breaker; skipped
  members are recorded in the analyst-leg trace without source content
- secure data is never cloud-embedded; encrypted-cloud embedding is still
  disallowed in v1
- secrets are hard-denied everywhere
- empty or exhausted fallback chains fail closed

The preset Gemini embedding profile references
`env:OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY`, matching the supervised worker
launcher. The env-derived compatibility bridge and embedding provider also
accept `GEMINI_API_KEY` for existing interactive installs.

With no `sovereignty.json`, Olympus builds an env-derived policy from the
existing `OLYMPUS_*` variables and keeps current runtime behavior. When the
file or inline policy is present, it shadows those policy env vars.

Presets are checked in under `config/sovereignty/presets/` and can be written
with:

```bash
olympus sovereignty init --preset local-first
olympus sovereignty init --preset local-only
olympus sovereignty init --preset private-cloud-only
olympus sovereignty init --preset no-sensitive
```

The bundled presets are:

| Preset | Operator label | Secure content posture |
|---|---|---|
| `local-first` | Local models and private cloud | Secure pool with explicit local → Venice Private order |
| `local-only` | Local models only | Local source-answer only |
| `private-cloud-only` | Private cloud only | Venice Private `kimi-k3` only |
| `no-sensitive` | Do not add secure data to Olympus | Metadata-only gap; secure content is not added |

### Default posture for new users (owner decision, 2026-07-06)

Every install sets its own security posture, but for users without a strong
opinion the recommended default is **private-cloud-only**, using the approved
non-E2EE Venice Private default while the E2EE key-handling gate stands. The
category floor and catalog authority remain defined by the
[canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative). Users who
want a stricter posture can choose `local-only`; users who run local models and
want an explicit local-before-Venice ordering can choose `local-first`.

## Historical Boundary Notes

### v0.1 Boundary

v0.1 did not implement the policy engine.

The first milestone is only the Argus bridge: prove that an OpenClaw agent can
call a configured local/private model lane through Olympus. The trust model and
sovereignty config become active once there are multiple model profiles or
personal-data source tools to route.

### v0.2 Boundary

v0.2 began personal-data source work without implementing the full policy
engine.

The active email posture is:

- raw email is fetched by a Gateway-side private source worker and reasoned
  over through an approved local/private model lane
- OpenClaw receives bounded answers and safe evidence metadata
- raw message body readback is not part of the default Castor-facing tool
  surface
- if the private email lane is unavailable, Olympus should fail closed rather
  than silently using ordinary cloud-visible email access
