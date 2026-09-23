# Changelog

## 0.4.0-beta.4 - 2026-09-23

Every item from every source is now judged on its own into Public, Personal,
Private or Secrets. This release also carries the fixes from the 2026-09-23
first-time install.

- **Per-item tiers (#77, #78, #80).** Each item gets a names tier (Personal
  unless something raises it) and a content tier (raised to Private or Secrets
  on evidence). Every source stores new items in per-tier indexes, and one
  question searches all of them. A Secret is kept only as its location (source,
  path or title, kind), never as text or vectors. The sensitivity map
  schemaVersion 2 can target all four tiers; lowering categories match only a
  path or a sender, never a keyword, and any raise beats them. Version 1 maps
  still load and stay raise-only. `SourceConnector` is now 2.0.0: connectors
  report facts and a shared classifier decides.
- **Privacy classifier (#79).** For items whose names or text look possibly
  private, a local model or Venice Private (never an ordinary cloud model)
  decides Personal or Private, one item at a time. It sees names, labels and
  sender, and sometimes an excerpt of up to 1,200 characters, never anything
  the secret detector caught. **It does nothing until the owner approves the
  exact model with `olympus tier classifier approve`**; until then flagged items
  stay Private and are found only by keyword. Owner rules live in
  `~/.olympus/tier-rules.json`, with `olympus tier set|explain|rules`.
- **Existing installs (#81, #82).** Items stored before this release stay where
  they are until the owner migrates them. `olympus tier migrate plan` is a dry
  run with counts, cost and time. `approve`, `run`, `rollback` and `purge` are
  separate owner steps; nothing migrates by itself. A run is held to each
  destination store's approved chunks and cost, a Secrets row is never rolled
  back, and doctor excuses a stopped migration's lag for 7 days
  (`OLYMPUS_TIER_MIGRATION_STOPPED_GRACE_DAYS`). Status, doctor and the source
  page show pending-classification, superseded-chunk and Secrets-location
  counts.
- **Gmail scope picker (#76).** Gmail waits for **Choose mail** before reading
  anything: the body of the last 2 years by default (older mail keeps headers
  only), Promotions and Social skipped, and "always Private" and "skip" senders,
  with an estimate before it starts.
- **Answers (#73, #74).** Private sources are searched by default when the
  posture approves a private analyst, which answers from them; only its checked
  answer is released. Answers use a larger evidence budget, prefer readable
  content over bare file names, and report how many items matched per source.
- **Cloud analyst (#71).** The cloud analyst (`openclaw-infer`) uses OpenClaw's
  configured default model unless a profile names one; shipped presets no
  longer pin `openai/gpt-5.5`. Its failures carry a bounded, evidence-free
  reason, and setup puts the `openclaw` directory on the worker PATH.
- **Worker token and Readwise (#70).** The plugin reads the worker token on
  each request, so a token written after the plugin loaded no longer causes
  401s. Readwise connected after boot syncs without a worker restart.
- **Dashboard (#69).** Sources waiting for a folder or mail choice read
  Waiting, ready models shrink to one row, and the Google unverified-app note
  sits inside the Gmail and Drive connect sheets.
- **Install guide.** Model keys go into the dashboard's Models cards, never
  through the agent; the gateway restart is required on every install; the
  classifier approval is its own owner-consent step; the Node range follows
  OpenClaw 2026.9.5 (`>=24.16.0 <25` or `>=26.1.0`).

Limits:

- The held-out answer eval was not run for this release. The classification
  eval passes its gates with a stand-in classifier; the real-model run has not
  been done.
- On `private-cloud-only`, Private search stays keyword-only unless the owner
  approves Venice Private embeddings.
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
