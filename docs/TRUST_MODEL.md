# Olympus Trust Model

Status: active
Updated: 2026-07-21

## Purpose

This document defines the current trust posture Olympus should preserve while
the plugin is still small.

The full policy system is future work. The product doctrine starts now. The
operational controls around structured evidence, release decisions, hostile
input, and approval boundaries live here and in [CONTRACTS.md](CONTRACTS.md).

## Core Principles

- Tier is about harm and authority, not file location.
- Data kind and sensitivity tier are separate.
- Storage system does not define the tier.
- Approved trusted service providers may custody `S4` and `S5` material when
  their role, authority, telemetry, retention, and recovery posture are explicit.
- Derivatives do not automatically become safe.
- Bundles inherit the highest tier they contain unless cleanly decomposed.
- Aggregation can raise sensitivity.
- No secure lane may silently fall back to a less secure model or transport.

## Sensitivity Tiers

### S0 Public

Information intended for open sharing.

Examples: public website copy, public bio, public contact details meant for
sharing, or a business IBAN printed on invoices.

Default posture: safe for ordinary cloud models and publication.

### S1 Low-Sensitivity Personal

Personal or operational information that is routinely shareable and low-harm if
disclosed.

Examples: a personal IBAN used regularly to receive payment, ordinary
preferences, low-sensitivity travel or workflow preferences, and light business
context.

Default posture: available to Castor and ordinary private-work context.

### S2 Sensitive Personal

Information whose disclosure would be undesirable but not usually seriously
damaging.

Examples: non-public plans, moderate personal context, and identifiers used in
ordinary bureaucracy that are not high-harm on their own.

Default posture: available to Castor inside normal private-work posture, not
public by default.

### S3 Restricted Personal

Personal context whose disclosure could be socially, emotionally,
professionally, or reputationally damaging.

Examples: dating context, mild interpersonal conflict, work dynamics, or
distilled health and life patterns that help reasoning but are not raw records.

Default posture: usable only in accepted private-work posture; not casually
shareable.

### S4 Private

High-harm records, identifiers, evidence, or bounded-capability materials.

Examples include raw health records, tax documents, detailed financial
statements, prescriptions, therapy notes, passport numbers, and full summaries
of raw S4 documents.

Default posture: secure-custody handling unless an explicitly approved secure
lane exists. That lane may be local, self-hosted, or a trusted service provider
such as a vault, evidence store, credential broker, or privacy-approved model
service.

### S5 Secret

High-authority secrets whose possession grants meaningful capability, control,
recovery, authentication, spending, decryption, or account access.

Examples include passwords, private keys, refresh tokens, recovery codes, TOTP
seeds, and bank API credentials.

Default posture: never ordinary prompt or note content. `S5` may live in
approved secure record stores and credential providers that are explicitly
trusted for the relevant authority.

## Classification Heuristics

Use these questions in order:

1. If someone possesses this value alone, can they authenticate, spend,
   withdraw, decrypt, recover, or broadly act as the user?
   If yes, default to `S5`.
2. If not, would exposure still materially harm the user because it is a
   specific high-harm record, identifier, or evidence artifact?
   If yes, default to `S4`.
3. If not, would exposure still be meaningfully damaging socially,
   emotionally, or professionally?
   If yes, default to `S3`.
4. If not, would exposure mainly be undesirable or awkward, but not seriously
   harmful?
   If yes, default to `S2`.
5. If the item is routinely shareable in ordinary operations and low-harm if
   disclosed, default to `S1`.
6. If it is intended for open sharing and should cause no concern if widely
   visible, it is `S0`.

### Capability Heuristic For Credentials

Not every credential is `S5`.

Use this distinction:

- `S5` means high-authority capability. The value lets someone act as the user
  in a broad, root-like, recovery-like, spending, decrypting, or
  hard-to-cap way.
- `S4` may include a bounded credential when the maximum realistic loss is
  explicitly capped and closer to ordinary `S4` harm than to system-level or
  account-level compromise.

Examples:

- capped OpenAI API key with modest explicit exposure: plausibly `S4`
- bank API credential with withdrawal authority: `S5`
- 1Password recovery code: `S5`

If operational blast radius, reset power, lateral movement, or abuse surface is
large, the credential should stay `S5` even if nominal spend is capped.

## Data Kinds

Data kind and tier should stay separate.

Examples of kind tags:

- `credential`
- `recovery_secret`
- `identifier`
- `financial_identifier`
- `financial_record`
- `health_record`
- `health_summary`
- `relationship_context`
- `personal_context`
- `evidence`
- `summary`

Example pairings:

- `tier: S4`, `kind: identifier`
- `tier: S5`, `kind: credential`
- `tier: S3`, `kind: relationship_context`
- `tier: S4`, `kind: health_record`

## Surface And Storage Defaults

### Obsidian

Obsidian is the unified human-facing reasoning surface.

Default fit:

- `S0-S3`
- deliberately distilled derivatives from `S4`
- links or opaque references back to raw private evidence when needed

Do not treat Obsidian as the default home for raw `S4` evidence just because
the user wants one coherent cognitive workspace.

### Evidence Vaults

Use evidence vaults such as Dropbox for raw `S4` materials and `S4`
derivatives that remain too specific to lower.

Examples:

- raw health documents
- prescriptions
- full translations of private records
- full summaries of private records
- tax documents and financial evidence

### Secure Record Stores

Secure record stores such as 1Password are not `S5`-only. They may hold:

- `S5` secrets
- selected `S4` identifiers
- selected `S4` bounded credentials
- secure lookup values the user wants available without widening them into note
  content

Examples:

- `S4`: SSN, passport number, bounded API key
- `S5`: bank credential, recovery code, private key

The active secret-store and service-account posture lives in
[SOVEREIGNTY_CONFIG.md](SOVEREIGNTY_CONFIG.md). Trust tier does not come from
the vault name alone; it comes from the authority, blast radius, and approved
provider role.

### Trusted Service Providers

Cloud service does not automatically mean low trust. Olympus should classify the
provider role, not just the deployment location.

Approved trusted service providers may hold or mediate `S4` and `S5` material
when the deployment profile says they are approved for that role. Current
examples include:

- 1Password as a cloud secure-record and credential store
- evidence vaults such as Dropbox for raw `S4` documents when the user chooses
  that custody surface
- native provider OAuth, delegated service-account, or local credential lanes
  when approved for the source family, account, scopes, logs, and payload path

Provider approval is role-specific. A service approved to store a refresh token
is not automatically approved to receive source document bodies, embeddings,
query text, or model context.

### Specialized Private Surfaces

Some `S4` domains may deserve a dedicated private tool rather than either
Obsidian or a secure record store.

Examples:

- financial dashboards
- health-management spreadsheets or apps
- structured operational views over raw private evidence

## Domain Defaults

These are working defaults, not immutable law.

### Health

- raw health data is usually `S4`
- full translations and full summaries of raw health data remain `S4`
- distilled health patterns useful for reasoning may be promoted to `S3`

Suggested surface split:

- raw health evidence in an evidence vault or specialized private surface
- distilled actionable health context in Obsidian

### Relationship Information

- mild conflict or ordinary dating context may be `S3`
- therapy notes, deep conflict, or highly exposing interpersonal material may
  be `S4`

### Identifiers

- business IBAN: usually `S0`
- personal IBAN: working default `S1`
- NIE / NIF / NIA-like national identifiers: working default `S2` until
  jurisdiction-specific usage proves a stronger need
- SSN: `S4`

### Financial Information

- bare low-harm operational identifiers such as a personal IBAN may sit in
  `S1-S2` when they are routinely shared and do not grant account authority
- structured or forensic financial evidence, account statements, tax records,
  and detailed banking records tend toward `S4`
- credentials that move money or expose broad account authority are `S5`
- Castor access to a selected identifier should be modeled as an explicit
  classified record or bounded answer, not as broad access to a financial vault
  or banking surface

## Hostile-Input Membrane

Olympus must distinguish:

1. raw inbound content
2. normalized evidence
3. world-model reasoning
4. outward release or action

Email, messages, files, webpages, and documents may contain instructions aimed
at the model. Olympus should treat them as data until a trusted process has
normalized them.

The current OPSEC design names that normalization step Structured Evidence
Extraction, followed by a Release Gate before evidence-derived content crosses
from local/private handling to Castor, user-facing output, logs, memory, or
actions.

## Model Routing Posture

The long-term routing posture is:

- local models may see raw S4 when policy allows
- Venice S4 routing follows the
  [canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative)
- ordinary cloud models may see S0-S3 when policy allows
- S5 should not be exposed as ordinary model context
- sanitized derivatives may be reclassified only when the transformation is
  deliberate and policy-approved
- unavailable secure lanes fail closed

For v0.1, there is no policy engine. The trust property is simple: Olympus can
call the local lane, and that local lane can later become the basis for
sensitive work.

For the reference v0.2 email milestone, raw email should be treated as
local/private-lane material. The cloud-facing assistant may ask Argus for an
answer about email, but the raw message body should be fetched and inspected by
Delphi/local models rather than placed directly in ordinary cloud-model
context.

See [SOVEREIGNTY_CONFIG.md](SOVEREIGNTY_CONFIG.md) for the future config shape
that separates data class, sensitivity tier, execution trust posture, model
profile, and routing policy.

This section is about model context. Credential managers, vaults, evidence
stores, and authorization brokers are separate trusted-service-provider
decisions.

## Retrieval And Embedding Posture

Olympus should eventually feel like one searchable digital world, but retrieval
must not be implemented as one mixed-trust global index.

Segregation happens before search:

1. Source content is classified into a trust domain and corpus.
2. Lexical and semantic artifacts are built inside that domain/corpus.
3. Query routers may late-fuse only collections allowed for the current caller,
   session, task, and policy.
4. Answer release still checks policy, but release filtering is not a
   substitute for retrieval segregation.

Default trust domains:

- `secure_local`: raw `S4` and `S4+` corpora. Local-only retrieval and local
  embeddings only. No ordinary cloud embedding or cloud query path. The
  model-context exception is defined only by the
  [canonical Venice S4 policy](CONTRACTS.md#venice-s4-policy-normative); it does
  not widen retrieval or embedding policy.
- `internal`: approved non-secure `S0-S3` corpora. Cloud embeddings are allowed
  by default after classification because this material is approved for
  ordinary cloud-model use.
- `public_safe`: explicitly public-safe corpora. Cloud embeddings are allowed by
  default in stores that never mix with `internal` or `secure_local`.

The `secure_local` trust-domain name describes Olympus retrieval, embeddings,
query routing, and model-context defaults. It does not mean every upstream vault,
OAuth custodian, evidence vault, or provider API involved in custody must be a
physically local service.

Rules:

- There is no shared vector pool across trust domains.
- There is no domain-wide vector pool that bypasses corpus boundaries.
- Embeddings, chunks, FTS rows, summaries, and caches are derived private data;
  they do not automatically declassify the source.
- Do not mix local and cloud embeddings inside the same corpus generation epoch.
- Use Gemini Embedding 2 as the default cloud-capable embedding model for
  classified `internal` and `public_safe` corpora, especially when text,
  diagrams, images, video, audio, or documents should be searchable in one
  semantic space.
- Local embeddings for `internal` or `public_safe` are allowed as an offline,
  cost, fallback, or evaluation path, not as the default product posture.
- `S4` may have full search quality, but only inside `secure_local` search
  spaces and secure-custodian routes.
- Ordinary Castor/cloud-led sessions may receive deliberately distilled `S3`
  derivatives or safe opaque references to `S4` evidence when policy allows;
  they must not query or receive raw `S4` collections by default.

Current email implication: until Olympus has row/chunk sensitivity
classification for the local Gmail index, treat the entire email index as
local/private and cloud-embedding-ineligible.

Current Telegram implication: Telegram classification is primarily per
chat/group. Approved ordinary groups/chats belong in `internal` and should use
the durable corpus direction `internal.telegram.messages`; Castor may receive
their snippets, quotes, summaries, and answers through approved Olympus
surfaces when OPSEC allows. Protected chats belong in `secure_local`, with the
durable corpus direction `secure_local.telegram.protected.messages`: accountant, lawyer,
Secret Chats, S4/S5 material, credential/security material,
legal/medical/financial high-harm records, intimate or high-risk relationship
context, and explicit owner override. Message-level OPSEC remains a secondary
quarantine layer that withholds secrets, instructions, or high-risk snippets
inside otherwise internal chats.

## What Not To Import From The Old Design

Do not bring over heavyweight secure-store, auth-broker, source-sync, or review
ledger implementation machinery before the plugin has the matching OpenClaw
surfaces.

Those designs contain useful contracts. Current Olympus has promoted the
durable policy contracts into [CONTRACTS.md](CONTRACTS.md),
[SOURCE_CAPABILITIES.md](SOURCE_CAPABILITIES.md), and
[SOVEREIGNTY_CONFIG.md](SOVEREIGNTY_CONFIG.md). That promotion does not
mean the old implementation scaffolding should be copied wholesale.
