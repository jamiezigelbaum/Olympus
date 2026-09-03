# Olympus source capabilities

This is the durable v0.4 capability record. It began at baseline commit
`32f0cefa` and records later repository and observed-runtime changes; it is not
a claim that a clean installation has passed release qualification. Each row
names the remaining release gap explicitly.

## Declared public metadata

This table is rendered from the same positive seven-source catalog used by the
dashboard and `olympus doctor`. It describes connector boundaries only; it
does not create source-specific extraction, retrieval, or answer behavior.

<!-- V0_4_PUBLIC_SOURCE_CAPABILITIES_START -->
| Source | Authentication | Contextual scope | Source-conditioned dependencies | Provider ceiling | Supported formats |
|---|---|---|---|---|---|
| Gmail | oauth2: shared Google pilot client with advanced BYO fallback | mail query; exclude Spam and Trash | Google OAuth client (authorization and refresh) | Provider history traversal and incremental refresh remain bounded by Gmail quota and pagination. | headers; snippet; text/plain; text/html (stripped); attachment metadata |
| Google Drive | oauth2: shared Google pilot client with advanced BYO fallback | inclusion roots; shared drives; exclude trashed items; fail-closed ancestry exclusions | Google OAuth client (authorization and refresh) | Provider history and change traversal remain bounded by Drive quota, pagination, and export limits. | Google Docs text export; text; PDF; common images |
| Dropbox | oauth2: one user-owned Dropbox account | approved path roots; metadata-only or full-extract policy per root | Local document extractors (Office, table, PDF, image, and audio content); Approved local embedding lane (optional semantic retrieval) | Folder-ID scope is unsupported; traversal is bounded by provider pagination and configured work budgets. | text; Office documents; tables; PDF; common images; audio transcription |
| X bookmarks | oauth2: user-owned X developer application and API plan | bookmark folders retained as provenance | X developer application (OAuth and bookmark API access) | Plan availability, cost, rate limits, pagination, and provider windows can prevent complete history. | post text; author; URL; folder memberships; media URLs |
| Telegram | paired_session: one user-owned MTProto session | explicit approved chats | Python with Telethon (pairing and capture) | Only captured approved-chat history is available; attachment bytes are not extracted in v0.4. | message text; replies; forwards; reactions; attachment metadata |
| WhatsApp | paired_session: one linked user device | live linked-device traffic; optional exports; exclude Status broadcasts | Whatsmeow bridge (QR pairing and live capture) | Bridge downtime creates an unrecoverable capture gap; general media-byte extraction is unsupported. | message text; link previews; reactions; media metadata; voice-note transcript sidecars |
| Readwise | api_key: one user-owned Readwise API key | category; location | Readwise API key (Reader and Export API access) | Reader v3 and Export v2 traversal are bounded by provider pagination and the daily request guard. | document text; highlight text; HTML; user annotations; author; tags; URL; category; location |
<!-- V0_4_PUBLIC_SOURCE_CAPABILITIES_END -->

## Current matrix

| Source | Authentication | Scope and available history | Indexed content | Sync and storage | Current v0.4 gap |
|---|---|---|---|---|---|
| Gmail | One-account dashboard OAuth supports the unverified shared pilot client when installed and an advanced BYO fallback; the UI names which mode is active | The dashboard names Gmail-specific scope; Spam and Trash are excluded; a bounded provider-wide traversal resumes by page token and promotes an incremental watermark only after reaching the mailbox head | Headers, snippet, text/plain and stripped HTML body; attachment count and declared bytes are recorded, while attachment-byte ingestion remains an explicit gap | The generic scheduler and two trust-separated connector stores are the only write/read runtime; Disconnect parks reads and removes the local grant without deleting data or app registration | Qualify shared-pilot and BYO clean installs against real Gmail history, attachment-gap accounting, citations, reconnect, and deletion custody in Slice 4 |
| Google Drive | The same one-account dashboard path labels the shared pilot client unverified and retains advanced BYO | `trashed=false`, resumable provider-history traversal followed by a modified-time cursor, shared-drive support, and fail-closed ancestry exclusions; Drive scope is presented contextually and inclusion-rule authoring remains local | Google Docs text export, bounded text downloads, PDF and common-image extraction; unsupported/oversized files are metadata-only | The generic scheduler and internal/secure connector stores are the only write/read runtime; Disconnect applies the same bounded local-grant semantics as Gmail | Qualify shared-pilot and BYO clean installs against real Drive history, formats, deletions, citations, reconnect, and deletion custody in Slice 4 |
| Dropbox | One-account dashboard OAuth, reconnect, path-policy setup, and bounded Disconnect are repository-implemented but not yet real-provider-qualified | Each approved path root has an independent opaque connector/cursor; traversal is bounded, resumable, deletion-aware, and protected by digest-bound in-page continuation when a provider page exceeds the work budget. Folder-ID scope is unsupported | Full-extract roots route through the shared bounded text/Office/table/PDF/OCR/VLM/transcription factory. Metadata-only roots and shared exclusions never enter extraction; post-extraction S4/S5 reclassification and unsupported/oversized/unmatched-delete gaps are explicit and fail closed | Direct provider sync, shared extraction, optional local-only embedding, connector-store status, and connector-store retrieval are the only runtime; Disconnect parks reads without purging indexed data | Qualify dashboard OAuth and path scope, provider history/deletions, extraction accounting, citations, reconnect, and clean-install lifecycle in Slice 4 |
| Telegram | The dashboard models one-account pairing state, dependency repair, reconnect, and Disconnect; Telethon remains the local pairing/capture helper | Exact approved-chat scope and append-only capture history exist; chat selection remains configuration-only | Message text, replies/forwards, reactions, and attachment metadata; no shared attachment-byte extraction | Product runtime validates and drains capture spools through two thin trust-separated connectors, resumes independent cursors under the generic scheduler, and reads the canonical stores; retired store writers and replay tooling are absent | Qualify the guided Telethon pairing handoff, chat scope, capture supervision, attachment accounting, reconnect, and clean-install lifecycle in Slice 4 |
| WhatsApp | The dashboard models one linked device, QR-pairing readiness, dependency repair, reconnect, and Disconnect; Whatsmeow remains the local pairing/capture helper | Live linked-device traffic plus optional exports; Status broadcasts excluded; chat-scope authoring remains local; bridge downtime creates an unrecoverable gap | Text, link previews, reactions, media metadata, and voice-note transcript sidecars; the shared extraction worker owns transcript ingestion and preserves transcript derivations across later metadata observations; no general image/video/document extraction is claimed | Product runtime schedules the spool connector against the canonical secure store with restart-safe cursor resume and counts-only gap warnings; the shared transcription path is canonical and retired migration writers are absent | Qualify the guided QR-pairing handoff, chat scope, capture supervision, capture-gap history, reconnect, and clean-install lifecycle in Slice 4 |
| X bookmarks | One-account dashboard OAuth uses a user-owned/BYO X developer application and makes plan availability, rate ceilings, and possible cost explicit; there is no maintainer-funded API path | Folders are retained as provenance; provider windows, pagination behavior, rate limits, availability, and cost can prevent complete history | Post text, author, URL, folder memberships, and media URLs; no media-byte extraction | The generic scheduler, canonical connector store, checkpoints, reconciliation, and budget guards are the only runtime; Disconnect parks reads without provider revocation | Prove the exact OAuth shape and real history without maintainer-funded API use, then qualify coverage, reconnect, and clean-install behavior in Slice 4 |
| Readwise | One-account API-key entry, reconnect, readiness, and bounded Disconnect are available in the dashboard | Resumable Reader v3 and Export v2 traversal with watermarks and daily request guard; category/location capability is explicit and rule authoring remains local | Reader document/highlight text or HTML, notes, author, tags, URL, category, and location; no attachment extraction | The generic scheduler, connector-store pull/reconcile, embedding, and canonical reads are the only runtime; the legacy index and migration tooling are deleted | Qualify real-account category/location coverage, provider deletion behavior, citations, reconnect, and clean-install lifecycle in Slice 4 |

## Cross-source verdict

- The frozen `SourceConnector → shared store → EvidencePack → Analyst → release`
  spine is the only runtime for all seven sources. Source-specific code stops
  at the connector or thin capture boundary.
- All seven sources write and read canonical connector stores. Slice 2 deleted
  the legacy indexes, replay/import mechanisms, authority switches, retired
  writers, and source-specific downstream implementations; the zero-legacy
  architecture guards keep those paths absent.
- All seven rows are repository-qualified and the current deployed runtime is
  observed-runtime-qualified on the canonical spine. The durable receipts are
  recorded in `V0_4_RELEASE.md`; neither result substitutes for a new user's
  clean-install release qualification.
- No source yet has a complete clean-install proof covering dashboard
  authentication, scope, automatic sync, extraction accounting, retrieval,
  citation, and secure answer release.

## Host capability delta

| Host | Supported v0.4 source surface | Deliberate exclusions | Qualification posture |
|---|---|---|---|
| OpenClaw | Native source answer, status, search/locators, and durable watches; CLI lifecycle and dashboard | Repository-only operator and private-deployment tools | All packaged sovereignty presets remain product-supported; v0.4 `private-cloud-only` uses the ordinary Venice API with a live-catalog Private or plain TEE model and keeps secure corpora lexical-only. Olympus does not provide or qualify E2EE out of the box; custom integrations are user-owned. Real-provider qualification is Slice 4. |
| Hermes Agent | MCP-only `source_answer` and `source_index_status`, plus the optional two-tool adapted skill | No search/locators, `source_watch_*`, prompts, resources, lifecycle, or mutation tools | `private-cloud-only` with the same v0.4 Venice and lexical-only limits is the Hermes qualification target; other postures remain usable through Olympus but are not claimed as Hermes-qualified until Slice 4 proves them |

Both hosts call the same Olympus worker, EvidencePack, Analyst, and release
gate. The Hermes row is a narrower allowlist, not a parallel implementation.

## Qualification contract

This contract is the release-qualification bar, owned by Slice 4 of
`V0_4_RELEASE.md`. Slice 1 qualified rows at repository level and Slice 2
closed the canonical observed-runtime cutover on the deployed host; Slice 4 still owns
the clean-install and pilot release proofs.

Each row becomes v0.4-qualified only when the same clean installation proves:

1. dashboard authentication and reconnect without file, environment, service,
   manifest, code, or database edits;
2. explicit supported scope, history, formats, media, exclusions, provider
   ceilings, and deletion behavior;
3. automatic resumable sync into the canonical connector store, with every
   eligible item indexed or assigned a user-visible reason;
4. generic `source_answer` retrieval through `EvidencePack` and `Analyst`, with
   claim provenance and honest gaps;
5. the selected security profile's approved reasoning and embedding routes,
   with fail-closed behavior; and
6. dashboard status that comes from this canonical state rather than a legacy
   index, migration switch, or private deployment report.
