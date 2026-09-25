# Changelog

## 0.4.0-beta.6 - 2026-09-25

Fixes from the beta.5 first-time install on OpenClaw 2026.9.6, Readwise on
hybrid search, and the hosted-agent connection slices.

- **One-click connect inside OpenClaw (#97).** The native Olympus page now
  offers the same one-click Gmail, Google Drive and Dropbox connect as the
  standalone dashboard; bring-your-own apps stay in a disclosure. On a
  Gateway reached over loopback (on the host or through an SSH port forward)
  native OAuth needs no `gateway.publicOrigin`: Olympus uses the loopback
  origin OpenClaw verified for that browser connection, only when OpenClaw
  reports a local client whose origin matches its Host. HTTPS and remote
  access still need `gateway.publicOrigin`.
- **Setup page (#98, #99).** The Models cards use compact rows on both the
  native and standalone pages (key field, Connect and the key link on one row;
  the local-model buttons side by side), and only one setup sheet is open at a
  time.
- **Install handoff (#96).** An operator chatting in the Control UI is pointed
  at the **Olympus** sidebar entry instead of being asked for their browser's
  address; a link is used only from other channels or for the standalone
  fallback.
- **Readwise (#100, #101).** Readwise answers with hybrid search in its
  Personal and Private tiers, using the embeddings it already has (owner
  decision `decision-2026-09-24-readwise-hybrid` in the embedding ledger);
  Private chunks embed and query only through the private lane. Embedding now
  runs outside the sync for every source: a provider timeout after items are
  saved no longer fails the sync, the items are queued for a background
  sweep, and the delay shows as `embedding_provider_unavailable` on the
  Background page, the source page and in `olympus doctor`. Readwise also
  sweeps any chunk still missing a vector, 32 items per store per pass, so
  earlier failed syncs catch up. Gmail and Drive embed only within their
  current approved scope. Each hybrid store shows its embedding backlog and an
  estimated cost. One embedding runs per store at a time across the sync, the
  sweep and the external drain, so nothing is paid for twice.
- **Needs you (#100).** A sync task shows **Needs you** after three failures in
  a row (a missing or refused credential after one), the same on Home, the
  page header, the source page and the Background page; below that it reads
  as retrying. Readwise counts its items as items, and `olympus doctor` shows
  items next to chunks per tier.
- **Connect other agents, preview (#87, #90, #92, #94, #95).** Olympus can now
  answer questions from agents beyond OpenClaw, under the same privacy rules.
  Cloud agents see up to Personal. Private items are read only by Venice or a
  local model, and the agent receives only their derived answers, with each
  item's title, path, source and author. Secrets never leave. Claude Code and
  Codex on the same computer can connect today through the local MCP server;
  the Setup page's new **Agents** section walks through it and lists and
  revokes connections. For cloud agents (Claude on the web and phone, ChatGPT,
  Grok and Muse), this beta adds the building blocks: a remote MCP endpoint and
  an OpenAPI view with revocable connection keys (`olympus connections
  add|list|revoke`), OAuth 2.1 sign-in approved with a one-time pairing code
  (`olympus connections pair`), and an opt-in remote-access setting with its
  own status command (`olympus connections status`). Remote access is off by
  default. The hosted Olympus connect relay isn't live yet, so cloud agents
  currently need your own tunnel via `remote.publicBaseUrl` (advanced).

## 0.4.0-beta.5 - 2026-09-24

Fixes from the beta.4 first-time install on a clean Linux user, plus the first
hosted-agent connection slices.

- **Install guide (#88).** The agent explains the four tiers and walks through
  the posture before offering any pick-list, and the list then shows plain
  descriptions, never preset ids. Bun installs without `unzip` or `sudo`
  through npm into `~/.local` when the official installer cannot run. The
  privacy classifier decision is a required line of the completion receipt,
  read from the new `olympus tier classifier decline` record or an approval,
  so a skipped question shows as `not_asked`. The handoff is delivered as
  written and links the dashboard inside the OpenClaw Control UI; the
  standalone link is the fallback, and its single-use ticket now lasts 15
  minutes instead of 2.
- **Olympus in the Control UI sidebar (#89).** OpenClaw shows an installed
  plugin's pages only when Settings → Labs → Custom plugin UI is on. The
  install asks the operator for it as its own consent step, saying it applies
  to every installed plugin; on OpenClaw 2026.9.5 setting it restarts the
  Gateway. A no keeps the standalone dashboard link.
- **Settings page (#89).** The plugin's Settings page no longer shows
  "Unsupported schema node": the config schema is written out without `$ref`,
  and accepts exactly the same configs.
- **Answers during provider blips (#89).** Embedding requests retry HTTP 429,
  500, 502, 503, 504 and network errors twice within the existing time limit.
  A `Retry-After` that fits the limit replaces the normal wait; one that does
  not ends the retries at once. If the provider is still unavailable, the answer
  continues on keyword search and reports the skipped semantic lane with its
  cause (`embedding_query_unavailable:<status|network|timeout>`). Key and
  permission errors still fail with their own message.
- **Hosted agents, preview (#84, #85, #86).** Every source answer records which
  surface asked (OpenClaw, MCP client, CLI or a remote connection), when the
  caller identifies itself, in its content-free ledger. `olympus connections add|list|revoke` issues revocable
  tokens for a remote MCP endpoint at the worker's `/mcp`, offering
  `source_answer` and `source_index_status` only; `data delete --all` removes
  them too. The worker still listens on loopback by default, so nothing is
  reachable from outside the host unless the owner exposes it.

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
