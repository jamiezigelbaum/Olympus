# Changelog

## 0.4.0-beta.3 - candidate

- Restore beta 1 setup, native dashboard, messaging pairing and folder-scope
  controls alongside the newer native services and X reconnect fixes.
- Preserve beta 1 schema-12 stores and existing content during upgrade.
- Bind file sync cursors to the current approval and enforce content scope
  before embedding dispatch, including revocation between batches.
- Require exclusive native messaging capture ownership and retain sessions
  when Unpair cannot confirm that native capture stopped.
- This candidate is prepared for the final test; it is not yet published.

## 0.4.0-beta.2 - 2026-09-21

- Add optional native OpenClaw services for the source worker, Telegram and
  paired WhatsApp capture, the embedding drain, provider-credit monitoring,
  and transcription-temp cleanup. Background startup fits the host deadline;
  shutdown retains child-process ownership until cleanup succeeds.
- Restore X ingestion after OAuth renewal without restarting the worker,
  including automatic sync, manual sync, and content recovery.
- Update WhatsApp pairing compatibility and identify the linked device as
  Olympus Plugin. Include the bridge source and build instructions.
- Keep explicit credentials isolated per consumer; refuse unresolved native
  credentials and keep billing reports free of raw exception secrets.
- Retire duplicate WhatsApp sidecar transcription in favor of the shared
  extraction scheduler. Existing audio and transcripts are preserved.
- Preserve standalone MCP support and document optional-service prerequisites.

This remains an early beta. Archive import alone is a snapshot; ongoing chat
updates require a paired live connection. Source and provider limits still
apply, and indexed text is not a claim that every document page was extracted.

## 0.4.0 - 2026-08-30

- Converge Gmail, Google Drive, Dropbox, Telegram, WhatsApp, X bookmarks, and
  Readwise on the shared source connector, store, retrieval, and Analyst spine.
- Add one seven-stage local dashboard journey with bounded reconnect,
  Disconnect, source-health, coverage, and cited-answer readiness controls.
- Add crash-safe worker lifecycle and fail-closed data deletion custody.
- Ship one positive-allowlist npm package for managed OpenClaw installation and
  byte-identical later ClawHub publication.

## 0.3.0-alpha.1 - 2026-07-02

- Start the friend-v1 shippable source-side artifact arc.
- Add a source-available restrictive license posture for private distribution.
- Add a release artifact script that rebuilds `dist/`, checks committed build
  currency, and writes a versioned OpenClaw-installable tarball.
