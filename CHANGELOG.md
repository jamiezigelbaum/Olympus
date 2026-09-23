# Changelog

## Unreleased

- The cloud analyst (`openclaw-infer`) now uses OpenClaw's configured default
  model unless a profile names one; shipped presets no longer pin
  `openai/gpt-5.5`. Its failures carry a bounded, evidence-free reason, and
  setup records the `openclaw` directory on the worker PATH.
- Upgrade note: an existing `~/.olympus/sovereignty.json` keeps the model it
  was written with, and setup does not overwrite it without `--force`. If its
  `cloud-openclaw-infer` profile says `"model": "openai/gpt-5.5"` and this
  OpenClaw has no OpenAI auth, remove that `model` line (or re-run
  `olympus setup --preset <preset> --force` if the policy was never
  customized), then restart the worker. Olympus does not remove it
  automatically because a pinned `openai/gpt-5.5` is also a valid explicit
  choice. Re-run setup once so the worker PATH gains the `openclaw` directory.

## 0.4.0-beta.3 - 2026-09-23

- Restore beta 1 setup, native dashboard, messaging pairing and folder-scope
  controls alongside the newer native services and X reconnect fixes.
- Preserve beta 1 schema-12 stores and existing content during upgrade.
- Wait for the worker to report ready before a managed upgrade completes.
- Bind file sync cursors to the current approval and enforce content scope
  before embedding dispatch, including revocation between batches.
- Require exclusive native messaging capture ownership and retain sessions
  when Unpair cannot confirm that native capture stopped.
- A refresh token the provider has definitively refused (X "token was
  invalid", `invalid_grant`) now marks the source for reconnection and stops
  retrying, instead of retrying every minute behind a misleading "latched"
  status. Temporary provider errors still retry.
- The connect form shows a saved client secret as a filled, masked field and
  explains that a provider error page usually means the callback URL is not
  registered exactly.

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
