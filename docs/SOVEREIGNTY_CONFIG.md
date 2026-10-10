# Sovereignty Configuration

Status: active
Updated: 2026-09-14

## Agent-led model setup for the v0.4 beta

After base activation, open **Setup → Models** in the Olympus dashboard.
Enter the required Gemini/Venice keys there; Connect validates and saves them,
and the managed worker applies them automatically. Models shows whether a key
is missing, applying, ready, or needs attention. The requirements come from the
active privacy policy, so local-only and no-sensitive do not demand Venice.
Source connections stay unavailable until required model setup is ready.

For local models, use **Connect existing local models** to start an
agent-assisted workflow. Olympus connects to servers you already run; it does
not install model software, download models, or maintain servers. Local means
the machine hosting Olympus. After the agent applies the approved existing
server configuration, **Check readiness** performs bounded synthetic chat and
embedding checks against those loopback endpoints, including model IDs and
runtime embedding dimensions. Dashboard polling does not repeat inference.

The terminal credential commands below are a headless fallback, not the
normal browser setup path.

Use this guide with your own agent after the plugin is installed. The
[Quickstart](QUICKSTART.md) covers installation; the
[agent install guide](../INSTALL_FOR_AGENTS.md) owns consent, credential
sourcing, existing-install safety, and restart procedures.

**Shipped model defaults:** the worker uses Olympus's registered dimensions
when no dimension override is supplied: Gemini Embedding 2 uses 3072 and the
registered local `secure-local-qwen3-embed` model uses 2560. The Venice
`text-embedding-qwen3-8b` model uses 4096. A fresh install
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
approved for Private answers is not automatically approved for Private vectors.

Public data and classified **Personal** data may use ordinary cloud models
when you permit that processing. **Private** includes health, finance,
legal, and similarly sensitive material. Secrets are denied to every model.

| Preset | Public and Personal embeddings | Private search | Private answers | You supply |
|---|---|---|---|---|
| Venice (`private-cloud-only`) — recommended after you confirm you do not run local models | Built-in model | Built-in model | Approved Venice Private/TEE model | Venice account, usable API balance and key |
| Local models (`local-only`) | Built-in model | Built-in model | Local answer model | Local answer server and its exact registered model ID |
| Local models with Venice fallback (`local-first`) | Built-in model | Built-in model | Local answer model, with approved Venice escalation | All local-only requirements plus Venice account, API balance and key |
| Don't ingest Private data (`no-sensitive`) | Built-in model | Private content is unavailable to answering | None | Nothing |

### Built-in embeddings

New installs embed every tier with the **built-in model**: Google's
EmbeddingGemma 2 (Apache-2.0), 768 dimensions, in Google's own LiteRT build
(text, image and audio encoders in one file). It runs on the computer through
LiteRT-LM, in a small helper process Olympus starts under Bun, needs no
account, no key and no extra app, and nothing leaves the computer. On first
use Olympus downloads the model (485 MB) and the LiteRT-LM library for this
platform (from Google's `litert-lm-api` 0.18.0 wheel: 21 MB on macOS, 47 MB on
Linux) once into
`<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/models/built-in-embedding`
(override with `OLYMPUS_BUILT_IN_EMBEDDING_DIR`); every file is pinned by size
and checksum and re-verified before it loads. While it downloads, questions
fall back to keyword search. It runs on the GPU where one is usable (Metal on
Apple silicon, Vulkan on Linux) and otherwise on the CPU, with the same
vectors either way; `OLYMPUS_BUILT_IN_EMBEDDING_DEVICE=cpu` keeps it on the
CPU. The first start compiles its GPU programs (up to half a minute; later
starts take seconds). On the CPU it uses at most half the cores, capped at
four (`OLYMPUS_BUILT_IN_EMBEDDING_THREADS` overrides). Supported: macOS on
Apple silicon, Linux x64 and arm64 (glibc 2.27 or newer).

Photos are searched by their picture too (2026-10-07,
`docs/design/photo-embeddings.md`). Mac only for now: elsewhere photos stay
names-only. An ingestion policy file you wrote yourself
(`~/.olympus/sources/dropbox.personal.ingestion.json`) is used as written; if
its media rule still lists `image/` and the photo extensions, remove those
entries to have photos read. On a Mac each still image is reduced to a
JPEG of at most 1,024 pixels (with the built-in `sips`) and kept in an
owner-only cache, `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/media-cache`
(or an `olympus-media` folder inside `OLYMPUS_MEDIA_CACHE_DIR`); the built-in model embeds that
picture together with the photo's title and any text read off it, about
1.4 s per photo on an M3's GPU. Its image encoder is on from the start and
leaves text vectors unchanged, so this needs no re-embed. Other embedding
providers embed a photo's text alone. Ordinary photos are Personal like your
other files; only sensitive ones (nudity or intimate images, identity
documents, bank or credit cards, pictures of financial or medical documents)
are Private (owner decision 2026-10-08). The built-in model judges each
picture on the Mac when it embeds it; a photo it cannot judge (no image
encoder, another embedding provider, off macOS) stays Private. Text read off
an ordinary photo is still judged like any other text, and a per-item tier
override still wins. Cloud models only ever receive a photo's text, never
its picture.

The profile is:

```json
"built-in-embedding": {
  "provider": "built-in",
  "trust": "local",
  "model": "embeddinggemma-2-litert-24d962e",
  "purpose": "embedding"
}
```

Installs set up before EmbeddingGemma 2 embed with the previous built-in
model, Snowflake Arctic Embed M v1.5 (`arctic-embed-m-v1.5-int8-e58a8f7`,
110 MB, on ONNX Runtime). Olympus keeps running it for them; moving such an install to
EmbeddingGemma 2 is the re-embed described below. The same holds for an
install configured only by environment: `OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER=built-in`
with no `OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL` keeps running Arctic, so an
upgrade never re-embeds on its own; name the EmbeddingGemma 2 model id to move.

Gemini, a local OpenAI-compatible embedding server, and Venice Private
embeddings stay available as opt-in profiles. Switching an existing corpus to
a different embedding model is a re-embed and needs the owner's approval and
an embedding-ledger entry. Installs set up before the built-in model keep the
policy they were written with, and keep their current embeddings.

Private content never goes to Gemini. No preset requires a GPU or a local
embedding server. An unavailable embedding provider never silently changes the
vector model. Venice E2EE integration remains outside this release. Existing saved
configurations are preserved: a previously lexical-only install needs explicit
activation of its new embedding profile and a bounded backfill.

The proposed Venice default is Qwen3 Embedding 8B, 4096 dimensions. Verify its
current Private classification and price in the
[Venice embedding catalog](https://api.venice.ai/api/v1/models?type=embedding).
On 2026-09-10 the catalog quoted $0.0125 per million input tokens (1.25 cents);
query embeddings also consume API usage. State the estimated cost and obtain
approval before activation or backfill, then record the embedding-ledger entry.
Preserve existing Gemini and local vectors. A key accepted for answers is not
proof that the embedding endpoint, account balance, or dimensions work.

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

### Choose your password-manager method

Choose the route before the agent asks for an item reference:

- **Web and manual paste:** open your password manager's website and paste the
  key yourself into a supported local dashboard field or silent terminal input.
  Gemini uses the documented stdin command below. This route requires no
  password-manager desktop app or CLI; never paste the key into chat.
- **Authenticated CLI:** if you want the agent to fetch it, first verify the
  manager CLI is installed and authenticated. For 1Password, an exact
  `op://vault/item/field` reference requires authenticated `op` access. Being
  signed in to the website does not authenticate the CLI. Configure CLI access
  through its supported procedure or use the manual route instead.

Approve each credential separately, with its purpose and any known caveat
explained first. The agent fetches only the exact item and field you name,
once, directly into the documented stdin connect flow. It never lists/searches
the vault or types a fetched secret into the browser. An item reference is not
permission to read it; keep the value out of output, files, notes, and logs.

### Gemini: create and connect your own key

1. Open [Google AI Studio's API Keys page](https://aistudio.google.com/apikey)
   in your own Google account. Create or select the Cloud project for Olympus;
   an existing project may need to be imported into AI Studio first. Follow
   Google's [API-key instructions](https://ai.google.dev/gemini-api/docs/api-key).
2. Review the current [Gemini pricing and data-use terms](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding-2).
   Free and paid tiers have different data-use terms. Do not infer a privacy
   guarantee from a tier label in Olympus, and do not enable billing
   without your own approval. Set appropriate quota/billing alerts; an alert
   alone is not a spending cap.
3. Create a key for this installation, keep it in your password manager, and
   use the method you chose above. For an authorized CLI fetch, give the agent
   its exact item/field reference. For manual input, run the resolved Olympus
   executable with `connect gemini --api-key-prompt` in a terminal on the host
   running Olympus. It opens masked input; no shell snippet or temporary script
   is needed. For an authenticated manager read, continue to pipe directly to
   `connect gemini --api-key-stdin`. The key must never enter a command argument,
   chat, or log.

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
4. For manual entry, run the resolved Olympus executable with
   `connect venice --api-key-prompt` on the Olympus host. For an authorized
   named-item manager read, use
   `printf '%s' "$KEY" | "$OLYMPUS_BIN" connect venice --api-key-stdin`, then
   unset `KEY`. This writes Olympus's `store:venice.api_key` entry. It does not
   purchase credits or silently change your privacy preset.

Verify both the key and one small, consented model request: a valid key may
still be blocked by an empty balance or a per-key limit. Use only a model the
live Venice catalog and Olympus policy accept for Private answers. Do not
respond to an unavailable route by sending Private data to an ordinary cloud
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
For local-model presets, keep Private embedding requests on loopback; local reasoning with optional
Venice escalation does not permit Venice or Gemini to receive Private
embedding inputs.

### Verify readiness, then connect a source

Have the agent check these as separate results: the chosen preset and data
destinations; each required credential, endpoint and dimension; successful
worker activation, plugin/tool activation and `olympus doctor`. That verifies
base installation. Then optionally connect one user-selected source, run a
bounded initial sync, and ask a normal question with checked citations. Report
keyword-only operation honestly. No indexed data means no answer proof yet;
leaving source setup for later is a valid completed base install. Do not choose
Gmail or connect every source merely to make a readiness check green.

The dashboard handles model keys, existing-local-model readiness, source
connections, and progress. Custom endpoint/model configuration remains
agent-assisted; there is no model installer or arbitrary model picker. Keep
existing model identities and vectors intact while connecting existing servers.

## Purpose

Olympus should let each user define what data sovereignty means for them.

The long-term product should not assume that Private always means local. A user
may choose local MLX models for Private data, encrypted web models for Personal
work, ordinary cloud models for Public material, or a mix.

## Configuration Concepts

### Data Classes

A data class describes what kind of information is being handled. User-facing
language is Public, Personal, Private, and Secrets; internally those map to the
existing granular trust scale (`public_safe`, `internal`, `secure_local`, and
S5) through the legacy stored keys shown below. A policy with no `public_safe`
route and no `public_safe` retrieval policy has no Public class: the
`no-sensitive` preset, which `olympus engine install` seeds for every ChatGPT
install, is written that way, and Public verdicts become Personal (see
[TRUST_MODEL.md](TRUST_MODEL.md#product-tier-names)).

| User-facing data class | Legacy stored key | Granular trust scale |
|---|---|---|
| Public | `public` | `public_safe` (S0) |
| Personal | `private` | `internal` (S3) |
| Private | `secure` | `secure_local` (S4) |
| Secrets | `secrets` | S5 |

These are display names over unchanged machine keys: the enum values, the
schema, and `targetTierName` all keep their stored names. The trap is the
collision — the legacy `private` key means Personal, so sensitive Private data
is still written as `secure` (`"targetTierName": "secure"`). Never write
`private` for sensitive Private data; that maps it to Personal.

Examples of the stored keys (`public` = Public, `private` = Personal,
`secure` = Private, `secrets` = Secrets):

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

For Private data, the primary abstraction is the **secure analyst pool**: the
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

The Private-answer E2EE gate is temporarily narrower than Venice's category
floor: any normalized `e2ee-*` model id configured as a secure-pool member gets
a typed policy refusal. Those models need local key handling Olympus has not
built. The gate is enforced in code before worker construction; it is not a
documentation warning. The current Private Venice defaults are `kimi-k3`
(strong) and `inkling` (normal tier).

### Retrieval Trust Domains

A retrieval trust domain describes which search spaces a caller may query and
which embedding backends may be used to build those spaces.

Technical route keys:

- `secure_local`: Private corpora. Local retrieval and local embeddings,
  or separately approved Venice Private embeddings when configured;
  secure-custodian callers only.
- `internal`: Personal corpora approved for ordinary assistant reasoning. Cloud
  embeddings are allowed by default once material is classified Personal.
- `public_safe`: explicitly Public corpora. Cloud embeddings are allowed in
  stores that never mix with Personal or Private material.

Retrieval trust domains govern search, embedding, and model-context routing.
They do not by themselves forbid approved cloud service providers from acting as
vaults, OAuth custodians, evidence stores, or credential brokers for Private or
Secrets material.

Retrieval policy must fail closed just like model routing. A query may only hit
the corpus collections allowed for the current caller, session, task, and trust
domain. A unified search result is produced by policy-aware late fusion over
allowed collections, not by searching one mixed-trust global vector pool.

### Embedding Policy

Embedding policy maps a corpus to allowed embedding providers and records the
embedding epoch used to build derived vectors.

Rules:

- ordinary cloud embeddings are never allowed for Private data; the Venice
  embedding lane requires its own explicit provider approval, corpus policy,
  and audit proof
- cloud embeddings are the default for classified Personal and Public corpora,
  because those corpora are approved for ordinary cloud-model use
- the default cloud-capable embedding provider for Personal and Public corpora
  is Gemini Embedding 2, so text, images, diagrams, video, audio, and documents
  can live in one multimodal semantic space per corpus
- local embeddings may still be used for offline, cost, fallback, or evaluation
  reasons, but they are not the durable default for cloud-approved material
- Personal and Public stores must remain separate even when they use the same
  embedding provider or model family
- local and cloud embeddings must not mix inside the same corpus generation
  epoch
- embeddings are derived data and inherit the corpus handling posture

### Classifier (privacy sniffer) lane

The four-tier classifier asks a privacy-safe model about items whose names or
text look possibly private
([design](design/per-item-four-tier-classification.md), section 2.2). That
model is chosen from this policy, never from an ordinary cloud lane:

- a model profile with `"purpose": "classification"` (a small, fast model
  for this one job), local before Venice Private; otherwise
- the `secure_local` analyst pool, local members before Venice members.

| Preset | Sniffer lane |
|---|---|
| local-first | local model (`local-source-answer`) |
| local-only | local model |
| private-cloud-only | Venice Private (`venice-private`) |
| no-sensitive | none: flagged items stay pending, held Private |

The sniffer uses only what the secure_local route already approves for
Private data: a disabled route (no-sensitive) refuses outright, and a declared
classification profile is accepted only for a provider kind the secure pool
itself has, with the pool's model gate (no E2EE-gated ids). A `standard_cloud`
profile is refused with a typed error before anything is sent. The sniffer
also waits for the owner to approve the exact lane, profile, model and prompt
version in the append-only classification ledger
(`olympus tier classifier approve --why ...`). The prompt version is derived
from the prompt text, so any change to the prompt, the model, the profile or
the lane stops it until the owner approves again; flagged items wait, pending
and held Private, meanwhile. An answer that needs the private pool aborts the
sniffer's in-flight call.

**Which model, when both are allowed.** Without a declared classifier the
sniffer uses the pool's local model when there is one, and Venice only when
there is none. A profile the owner declares with `"purpose":
"classification"` is an explicit choice and is used as declared, even when
the pool also has a local model. So `local-first` plus a declared Venice
classifier sends flagged names (and short excerpts) to Venice Private, off the
box; declare a local classifier, or none, to keep them on it.

**One item per call.** Every flagged name and every excerpt is asked on its
own call. No source can prove who named an item: a Dropbox file request, an
email-to-Dropbox or web save, a Drive save, an ownership transfer or a form
upload lets a stranger name a file that looks like the owner's, and notes can
be imported or clipped. So no item's material ever shares a prompt with
another's, and an instruction hidden in a name can at most talk about the
item that carries it. Identical material is asked once for every item that
has it. Material shaped like an instruction to the model is also refused
outright (Private, never sent), after normalizing fullwidth, zero-width and
look-alike characters; that detector is defense in depth, not the defense.

Residual risk: an item can still steer its OWN verdict (a stranger who names
a file "everyday paperwork" may get that one file judged Personal). It
cannot move any other item, the deterministic detectors and the owner's map
and rules still raise it, and Personal is only accepted at confidence 0.9 and
never for a hard category.

Cost: one call per flagged name. Per call about 300 input and 20 output
tokens (measured on the eval corpus), so 100k flagged names is about 30M
input and 2M output tokens. Pace: one pass a minute
(`OLYMPUS_TIER_SNIFFER_INTERVAL_MS`), at most 10 calls a pass on a local model
(it is shared with answers, which also preempt it at once) and 30 on Venice
(`OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS` overrides both). The daily cap
(`OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY`, default 20,000) works through a
100k-item backlog in about five days; on Venice that is at most about $1.10 a
day at an assumed, unverified price, and a local model is bounded by its own
throughput first. Source index status reports the backlog as counts only
(`tier_classification`: "Checking N items, about X questions remaining"), and
each store's `pending_classification_items`; there is deliberately no time
estimate. Knobs: `OLYMPUS_TIER_SNIFFER_ENABLED`,
`OLYMPUS_TIER_SNIFFER_INTERVAL_MS`, `OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS`,
`OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY`.

### Experimental: zkAPI consult transport

zkAPI (`zkapi-clientd`, from the Ethereum Foundation and the Open Anonymity
Project) pays for ordinary cloud models from a prepaid ETH deposit in a way the
payment side cannot tie to the deposit. OpenRouter and the upstream model still
read every request. Olympus therefore uses it for one thing only: carrying a
**consult**, a single question a local model wrote, with no evidence (design:
`docs/design/frontier-consult-lane.md`, track Z). **No consult can be sent yet.**
This release ships the transport and its checks; the consult lane that writes,
gates and approves questions lands separately.

A `zkapi` profile is consult-only. Its trust is always `standard_cloud`, its
`purpose` must be `consult`, and it is refused, with a `config_error`, in every
role that carries evidence: any analyst route (including the secure pool),
any embedding policy, vision and classification. Any profile with
`purpose: "consult"` is refused in those roles too. A `local` or
`local-openai-compatible` profile pointing at the daemon's port (8787 by
default, or a configured `zkapi` profile's port) is refused, because a
loopback address there forwards to the cloud.

```json
"zkapi-consult": {
  "provider": "zkapi",
  "trust": "standard_cloud",
  "purpose": "consult",
  "baseUrl": "http://127.0.0.1:8787/v1",
  "model": "<a model id from the daemon's model list>",
  "secretRef": "env:OLYMPUS_ZKAPI_LOCAL_API_KEY",
  "zkapi": {
    "tor": "per_consult",
    "torSocksPort": 19050,
    "fundingDate": "2026-10-01",
    "depositUsd": 20,
    "acknowledgements": { "version": 7, "accepted": ["only_when_asked", "provider_reads", "cost", "fees", "expiry", "new_service"] }
  }
}
```

**You install and fund the daemon yourself, in its own tool.** Olympus holds
no credential that can move funds, calls no wallet route, never runs
`zkapi-clientd config`, and never reads the daemon's private configuration.
Funding, the funding address and withdrawal all happen in the daemon's own
terminal session. Configure the daemon once:

```sh
zkapi-clientd config --key-reuse-window-seconds 0 --require-api-key --relay-url socks5://127.0.0.1:19050
zkapi-clientd config --api-key   # store this inference-only key for Olympus
```

Install Tor yourself; Olympus does not bundle it. Do not keep your own
`zkapi-clientd serve` running: for each consult Olympus starts a throwaway Tor
client with a fresh data directory on the relay port, starts the daemon (under
network confinement where the platform allows it), verifies it, sends one
request, waits for the daemon to report that request's key settled, stops Tor
and stops every process it started. If the daemon's relay is the port shown
above, nothing listens there between consults and the daemon cannot reach the
network; Olympus cannot read that setting, so it cannot confirm this. This
sequence follows the reference wrapper scripts in `ethereum/zkapi` pull
request #16.

**The money, plainly.** Turning this on requires accepting six statements
(acknowledgement version 7: the owner's calmer rewrite of 2026-10-08, with
the provider statement corrected on 2026-10-10 and the first statement
rewritten the same day once questions stopped going out on their own; any
earlier acknowledgement must be given again, and nothing is sent until it is):

- A question goes out only when you ask your agent to use Olympus zkAPI.
  Nothing is sent on its own, and you can turn anonymous answers off at any
  time.
- The AI provider reads each question but cannot tell who sent it. At
  Standard, a question goes out the way you choose; at Strict, your model
  removes identifying details first. An unusual situation could still hint at
  who you are.
- Each question usually costs a few cents. While it runs, up to $6 is held
  from your balance; the rest comes back.
- Adding money and taking it out are Ethereum transactions, each with its own
  network fee.
- Money left unused for about 30 days can be claimed by the zkAPI operator.
  The estimated date is shown on this page when Olympus knows it.
- zkAPI is new. Your balance is kept in files on this Mac, and its operator
  can pause deposits and withdrawals. Only add what you're comfortable losing.

The card's "Everything to know first" list keeps the fuller detail: each
question counts against any daily limit you set at the amount zkAPI holds for
its model ($1 to $6), and there is no daily limit unless you set one; there is no top-up (each deposit is a new note with
its own fee and 30-day clock); the expiry date is an estimate from the funding
date you confirm; the fee buffer; the required API key and key reuse off; the
operator's pause power and the single-party proof setup.

**What may be sent.** `~/.olympus/consult.json` carries `level`:
`"unnamed"` (**Standard (recommended)**, the default) lets the local writer
describe the situation and ask for a verdict, with identifying details
removed; `"general"` (**Strict**) sends general questions only. A file without
`level` reads as `"unnamed"`: that is safe because nothing is sent until the
statements above are accepted at the current version, and they say what
Standard sends. Choosing a level is never refused; while the statements are
not accepted, the card shows them beside Standard with one "Accept and save",
and outside help stays paused. Replacing a damaged settings file without a
choice writes `"general"` (and leaves outside help off). The outbound check
runs at both levels (`docs/design/consult-writer-instructions.md`,
`docs/design/consult-gate-false-refusals.md`).

Deposits are in ETH, so their dollar value moves with the ETH price. The
daemon activates a deposit before the chain finalizes it; a rare chain
reorganization after activation can need recovery in the daemon's own tool.
In practice a deposit is prepaid credit you should not expect back: expect to
pay roughly the deposit fee plus whatever you deposit each month you keep this
on, so deposit the smallest amount the service accepts.

**What each consult verifies, and what it cannot.**

- From the daemon Olympus started: a reviewed version (0.1.5 or 0.1.6), a
  fresh key for every request (key reuse 0), local API-key authentication
  enforced (an unauthenticated request must be rejected), SOCKS5 routing on,
  and that the daemon and Tor ports are held by the process groups Olympus
  started, checked again right before anything carries the key. Any failure
  refuses the consult.
- The daemon reads its relay and companion settings only from its private
  configuration, which Olympus does not read, and its wallet companion reaches
  the network through a proxy on a random loopback port. So Olympus cannot
  prove where the daemon and companion connect: it knows that it started a
  fresh Tor client and that the daemon reports SOCKS5 mode, not that the
  daemon's SOCKS endpoint is that Tor client. On macOS it runs the daemon in a
  sandbox meant to refuse every connection except loopback, including the
  system resolver. Each session checks this first: the same probes must fail
  inside the sandbox and succeed outside it, and a failed check refuses the
  session. Loopback ports cannot be filtered for this daemon, so another
  loopback proxy would still be reachable. On other platforms there is no
  confinement. **No platform therefore gets the label "anonymous route" in
  this release**; the label says "a fresh Tor client was started and the
  daemon reports SOCKS5 mode, but the actual route is not verified". With
  `"tor": "off"` the mode is called **payment privacy only**: your network
  address is visible.
- A fresh Tor client is a fresh set of guards and circuits, not a guarantee of
  a different exit, and Tor does not hide the content of the question or the
  timing of requests. A question's wording and when it is sent can still link
  consults.

**Guards.**

- The expiry date is an **estimate** from the funding date you confirm; the
  real expiry is set on-chain by the deposit block. Doctor and status show the
  estimated date, days left, and a notice at 10, 5 and 2 days. A recorded note
  past its estimated expiry refuses consults.
- **No limit unless you set one.** Before each send Olympus records the
  request at the per-request allowance the daemon's live model list states
  for the chosen model (`oa_request_limit_micro_usd`, $1 to $6 by the model's
  price tier; that is the amount the daemon holds), in a ledger that survives
  restarts, and doctor shows today's count and worst-case total. The settled
  price is never recorded: the daemon does not report it and Olympus reads no
  balance. To limit spending, add either or both to the profile's `zkapi`
  block: `"dailyRequestCap": 5` (requests per UTC day) or
  `"dailySpendCapUsd": 30` (worst-case dollars per UTC day; each consult
  counts its model's listed allowance). A set limit is enforced at the send,
  atomically across processes; before a session, when the next model's
  allowance is not yet known, the spend limit blocks only once it is used up.
  A request whose outcome is unknown still counts toward it. Caveat: the
  daemon recomputes a request's allowance from live policy after it is
  queued, so a policy change between the listing and the send can move the
  actual hold, bounded by the reviewed versions' $6 maximum.
- **Unresolved sessions.** Before each send Olympus records a fence, and clears
  it only when the daemon reports that request's key settled. If that is not
  confirmed (a crash, a timeout, a missing log line), no further consult is
  sent until a recovery-only session runs: the same supervised session sending
  one fixed question with no content, so the daemon can settle the earlier
  lease. That earlier lease is then settled under the recovery session's
  network identity, and recovery costs one request. A recovery the daemon
  refuses (for example because the model is unavailable) leaves the fence in
  place. A fence belongs to one wallet, identified by the daemon's
  configuration directory (canonicalized); the daemon executable and port are
  recorded with it but do not change it, so updating the daemon keeps the same
  fence. **Keep one wallet per configuration directory**: Olympus cannot tell
  two wallets in the same directory apart without reading private files. Any
  outstanding fence, for any wallet, blocks every consult and is listed by
  doctor. Recovery runs only against the wallet that holds the fence. Until
  the consult lane offers recovery, run the developer harness from the
  Olympus checkout: `bun scripts/zkapi-consult-recover.ts --yes` (exit 0 only
  when settlement is confirmed and the fence cleared). If that wallet can no
  longer run, the same script's `--abandon <scope> --yes-abandon` marks the
  fence abandoned; it is kept as a record, and the unsettled lease may later
  settle under another session's network identity. Nothing clears a fence
  automatically. Olympus
  waits up to five minutes for settlement, longer than the daemon's own
  four-minute companion timeout.
- One session at a time across every Olympus process. A failed or timed-out
  consult is never resent, on zkAPI or any other route.
- The model check is membership in the daemon's live model list, not a test
  request. The released daemons wait at most one minute for that list; over Tor
  a cold policy can take longer (PR #16 raises the daemon's own timeouts), so
  a consult can fail with "policy unavailable" and costs nothing when it does.
- The balance, fee quotes and the on-chain expiry are not available from the
  daemon without its wallet-management credential, which Olympus will not
  hold. Olympus shows no live fee estimate.
- Any endpoint that reaches this machine on a known zkAPI daemon port is
  refused by the shared model transport that every analyst, embedding, vision
  and setup probe sends through, and by policy validation for every provider,
  whatever trust it declares. Known ports are 8787 and the port of every zkapi
  profile in your sovereignty policy, which the guard reads itself, so the
  guard depends on that file. Every loopback spelling counts (`localhost`
  names, all of 127/8, IPv4-mapped IPv6), and **any host name on a daemon port
  is refused**: a local model on such a port must use a numeric loopback
  address. **A daemon on a port no policy names cannot be recognized by
  port**; the protection covers the ports Olympus knows about. If the policy
  file exists but cannot be read, every local model endpoint is refused, and a
  host name is refused if it resolves to this machine or cannot be resolved,
  until the file can be read again; the refusal names the file to fix.
- If Olympus crashes mid-session, a watchdog stops the session's processes,
  and the next session cleans up what is left only after proving it belonged
  to the crashed session; anything it cannot prove is reported, not signalled.
  A session whose processes cannot be confirmed stopped ends as a failure,
  and doctor lists the leftover process groups. To clear them, find each
  group (`ps -o pid,pgid,command -g <pgid>`) and stop its processes yourself;
  a reboot is the conservative fallback, which the next session recognizes.
  Never delete the zkAPI ledger to clear this.
  The watchdog cannot contain a descendant that starts its own session or
  process group, and it cannot supervise a wallet companion that was already
  running outside Olympus.

`olympus doctor` reports all of this as the `zkapi_consult_transport` check,
content-free.

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

An `openclaw-infer` profile is the only kind whose `model` is optional.
Absent means OpenClaw's configured default model: the worker runs
`openclaw infer model run` without `--model`, so the agent's own model and
credentials own the run, whatever provider that is. The shipped presets leave
it absent. Set `model` (a `provider/model` ref such as `openai/gpt-5.5`), or
`OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL` on an env-bridge install, only to
pin a specific model; OpenClaw must hold auth for it. A failed run reports a
bounded reason (exit code, model, and a fixed cause such as missing auth; any
OpenClaw free text only when redacted and proven not to echo the request), and a
missing CLI reads as "OpenClaw CLI not found on the worker PATH"; setup records
the `openclaw` directory on the worker PATH, and
`OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND` may name the executable instead.
Policies written by earlier releases keep `"model": "openai/gpt-5.5"`; on a
host without OpenAI auth in OpenClaw, remove that line to use the default (see
the changelog upgrade note).

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
- Private embeddings use the built-in model, loopback local providers, or an
  explicitly selected, catalog-approved Venice Private provider; other cloud
  providers are refused
- secrets are hard-denied everywhere
- empty or exhausted fallback chains fail closed
- model transports that carry source content (analyst chat, the built-in
  private model, embeddings, vision extraction, the privacy sniffer, Delphi)
  refuse redirects: any 3xx answer fails with a typed, content-free
  `ModelEndpointRedirectError`, which each caller maps to its usual transport
  failure, and is not retried on the spot
- credential-bearing catalog, connect, key-health and billing checks also
  send `redirect: 'error'`; a redirect there surfaces as the check's existing
  categorical failure or status result, not as the typed error
- a local profile, local embedding model, local vision model, or Argus route
  whose model id carries a reserved cloud-style tag (`:cloud`, or a tag ending
  in `-cloud`, such as `gpt-oss:120b-cloud`, which is how Ollama names models
  its local daemon forwards to its cloud) is refused with a `config_error`;
  only the tag is checked, so a name that merely contains "cloud" is accepted

Loopback locality is asserted by the owner's configuration. Olympus checks the
address, refuses redirects, and refuses reserved cloud-style tags, but it
cannot verify what a loopback process does with a request. The tag check is a
heuristic:

- it refuses a genuinely local custom model whose tag ends in `-cloud`
  (rename the tag to use it);
- it does not catch an alias that points at a cloud model, a digest-form
  model id, or a forwarding proxy on loopback (LM Studio, LiteLLM, an
  OpenRouter-style gateway, or anything similar).

Never point a local profile at a proxy or daemon that forwards to a cloud
model. Redirect refusal also depends on the transport honouring it: Olympus
sends `redirect: 'error'` and treats any 3xx it still receives as a refusal,
but a custom fetch implementation that followed a redirect on its own would
already have re-sent the request.

An opt-in Gemini embedding profile references
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

| Preset | Operator label | Private content posture |
|---|---|---|
| Local models with Venice fallback (`local-first`) | Local models with Venice fallback | Private pool with explicit local → Venice Private order |
| Local models (`local-only`) | Local models | Local source-answer only |
| Venice (`private-cloud-only`) | Venice | Venice Private `kimi-k3` only |
| Don't ingest Private data (`no-sensitive`) | Don't ingest Private data | Metadata-only gap; Private content is not added |

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
