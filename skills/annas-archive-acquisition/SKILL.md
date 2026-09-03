---
name: annas-archive-acquisition
version: 0.1.0
description: Search Anna Archive for candidate books, present approval-gated selections, download approved files to the owner's Xanthos books folder, and optionally route them to an explicit RAG/domain corpus.
triggers:
  - user asks to find books on a topic through Anna Archive
  - user asks for top books, candidate books, EPUBs, PDFs, or reading-list acquisition
  - user asks to download approved Anna Archive items into the owner's books folder
  - user asks to ingest an approved downloaded book into a named RAG corpus or domain library
tools:
  - annas_archive_search
  - annas_archive_import
mutating: true
---

# Anna Archive Acquisition

Use this skill when the owner asks Castor to find candidate books, choose from Anna Archive results, save approved books locally, or optionally ingest them into a named domain/RAG library.

## Workflow

1. Search first with `annas_archive_search`. For topic requests such as "top seven books about evolutionary biology", set `topic`, `top_n`, and `format_preference`. Use `format_preference=text_rag` for ordinary text/RAG reading, `layout` for design/layout-heavy works, and `auto` when unclear.
2. Present candidate metadata and ranking rationale. Treat "top" as search candidates plus scoring rationale, not silent selection. Include title, author, year, format, language, file size, MD5/stable locator, and any gaps the tool reports.
3. Two request modes, ruled by the owner 2026-07-29 — the request's shape decides:
   - **The owner names a specific book** ("get me Sapiens by Harari"): the
     naming message IS the approval. Download and ingest immediately, cite
     that message as the approval reference in the audit record, and report
     what landed. Do not ask a confirmation question first — the owner has
     already chosen, and a confirmation on a local, reversible action is
     friction, not safety.
   - **The owner asks a selection question** ("the best book by Tegmark on
     philosophy"): come back with ranked specific candidate titles and let
     the owner pick. This is the owner choosing, not an approval gate; once
     the owner names one, the first mode applies.
   The audit record is written in both modes, so the trail survives without
   the interruption.
4. Download approved items with `annas_archive_import`. The live sink saves into the configured books library root using `topic/Author - Title (Year)/filename`, refuses overwrites, checks duplicate stable locators/audit records, and writes an audit record. The root is per-installation and comes from configuration, never from this file.
5. Keep RAG ingest separate. Set `ingest=true` only when the owner asks to ingest and provide an explicit `corpus_id` or domain corpus. If no general Castor knowledge corpus is configured or no target is provided, report the tool's `needs_corpus_decision` state rather than inventing a corpus id.

## Format Preference

Prefer EPUB for text-first books and RAG because it usually extracts cleaner text. Prefer PDF for visual, design, page-layout, or typography-heavy books where pagination and layout matter. Preserve original metadata and stable locators in the request when available.

## Stop Lines

Do not expose or request `Annas-Archive-API-Key`; the runtime worker resolves it through the secret mechanism. A download needs either a message naming that specific book or a selection the owner made from presented candidates — never download from a topic-level request without the owner's pick. Do not bulk-download a topic list without item-by-item or batch selection. Every download writes an audit record naming its approval reference. Do not pretend RAG ingest happened if the result says `needs_corpus_decision` or `blocked`.

## Reporting Rule (hard, 2026-07-29 incident)

A success claim about a download, ingest, verification, or retrieval exists
ONLY as a quotation of a tool result from the current session: the audit
reference, the saved path, the corpus delta, the retrieval counts — quoted,
never narrated. If no tool result in this session says it happened, it did
not happen, and the report says exactly what was attempted and what came
back. Never describe checksum verification, extraction, or "verified by live
retrieval" unless a tool result in this session contains those fields. (On
2026-07-29 a complete ingestion success story — three books, checksums,
citations — was narrated with zero corresponding tool activity; the claims
were structurally impossible at the time. This rule is the ingestion twin of
the lane-down rule: no failure OR success recitation without a current
tool result.)

## Failure Behavior

If search returns `annas_archive_not_configured`, report that the Anna search
endpoint and API key must both be configured; do not invent or return a search
plan under `annas_archive_search`. If download returns `skipped_duplicate`,
report the existing path and do not retry with a renamed file. If download
succeeds but RAG ingest is blocked, report both states separately: the file
was saved, and ingest still needs corpus/config/credential resolution.
