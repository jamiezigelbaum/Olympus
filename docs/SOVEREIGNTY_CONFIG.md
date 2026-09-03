# Sovereignty Configuration

Status: active
Updated: 2026-07-26

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
