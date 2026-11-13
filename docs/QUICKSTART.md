# Olympus Quickstart

Install Olympus, connect the sources you want it to answer from, and verify a
cited answer.

This is the OpenClaw path. **Using ChatGPT, Claude or Grok?** Follow
[Get started](../README.md#get-started) instead: it needs only a Mac or an
Omarchy or Ubuntu 24.04 LTS x86_64 computer, with no OpenClaw and no API keys.

**You need:** a machine with [OpenClaw](https://openclaw.ai) `2026.7.1+`
installed, [Bun](https://bun.sh) `1.2+` (`curl -fsSL https://bun.sh/install | bash`),
on macOS or Linux. An agent with terminal access can obtain the pilot package
and guide you through setup automatically; no file or checksum-receipt handoff
is needed. You can also follow the steps below manually.

OpenClaw 2026.9.5 itself runs only on Node `>=24.16.0 <25` or `>=26.1.0` —
its npm `preinstall` script exits non-zero on anything else, and the range
moves between releases (`npm view openclaw engines` shows the current one).
Check `node --version` before blaming an install failure on Olympus.

If `bun --version` says `command not found`, check `~/.bun/bin/bun --version`
before reinstalling anything — Bun's installer puts the binary there and wires
up PATH from your shell rc, which non-interactive shells never read. Adding
`export PATH="$HOME/.bun/bin:$PATH"` to the shell you are working in is enough.
The `olympus` CLI is a Bun script, so it needs `bun` on PATH wherever you run
it.

**Fastest path — let your agent install it.** Paste into OpenClaw, or another
agent with a terminal:

> Install Olympus by reading https://raw.githubusercontent.com/jamiezigelbaum/Olympus/main/INSTALL_FOR_AGENTS.md and following it step by step. Walk me through setup and ask me about my data and privacy preferences.

Before first setup, read the full
[privacy tier explanation](../INSTALL_FOR_AGENTS.md#step-2--privacy-posture-mandatory-decision-gate),
then describe your privacy preferences and choose how to handle Private data.
For the credentials and models that choice requires, follow the
[agent-led model setup guide](SOVEREIGNTY_CONFIG.md#agent-led-model-setup-for-the-v04-beta).
It covers account creation, API spending, exact password-manager references,
local models, and embedding dimensions. Shipped models use their registered
defaults when no dimension override exists: built-in EmbeddingGemma 2 uses 768
and Venice Qwen3 Embedding 8B uses 4096. Unknown/custom models still
require a verified dimension; the complete custom-settings CLI is a follow-up.
Do not edit generated worker files or disguise a custom model as a shipped one.

The built-in reranker is on by default at 16 GB of memory and above (16 GiB
measured RAM), once installed. It downloads with the embedding model: one
extra download of about 136 MB, with a shared ONNX runtime installed if needed.
Scoring runs only on this computer. Answers use the fused keyword and vector
order until the reranker is installed, and continue using that order if
scoring fails. The model is released after 10 idle minutes and loads again
on the next score.

Set `OLYMPUS_SOURCE_RERANKER=off` to disable it, or
`OLYMPUS_SOURCE_RERANKER=built-in` to enable it below 16 GiB. An explicit
`built-in` setting can use `OLYMPUS_SOURCE_RERANKER_MODEL_DIR` for a different
model directory; otherwise it uses
`<built-in embedding root>/reranker/mmarco-mMiniLMv2-L12-H384-v1-int8-1427fd6/`.
Missing model or tokenizer files leave reranking off, with no wait or error.
`OLYMPUS_SOURCE_RERANKER_POOL` overrides the default pool of 24 candidates;
`OLYMPUS_SOURCE_RERANKER_MAX_TOKENS` overrides the default 256 tokens per pair
(up to 512).

The preset prerequisites are:

| Preset | Required before first source answer |
|---|---|
| `local-first` — Local models with Venice fallback | A funded Venice API key; a local answer model with its exact registered ID at `http://127.0.0.1:28090/v1`. |
| `local-only` — Local models | A local answer model with its exact registered ID at `http://127.0.0.1:28090/v1`. No Venice account is needed. |
| `private-cloud-only` — Venice | A funded Venice API key for Private answers; no local server required. |
| `no-sensitive` — Private meaning search on this computer | Nothing. Private items are stored and searched by meaning on this computer with the built-in embedding model, and their search vectors are kept here. Ask privately and the sealed ChatGPT panel can use them; agent answers still say Private sources were not searched. |

Every preset makes content searchable with the built-in embedding model: a
small model (Google's EmbeddingGemma 2) that runs on this computer, downloads
once (checksum pinned) on first use, needs no account or key, and sends
nothing off the computer. The other embedding choice is Venice; existing
Gemini and local-server embeddings are compatibility paths only. See the
[legacy embedding migration guide](SOVEREIGNTY_CONFIG.md#legacy-embedding-migration) and
[SOVEREIGNTY_CONFIG.md](SOVEREIGNTY_CONFIG.md#built-in-embeddings).

A local runtime means a server actually answering at the effective policy's
endpoints and serving its exact answer and embedding model IDs. An
installed plugin is not a runtime — OpenClaw ships a built-in `llama-cpp`
provider plugin on machines that have never run a local model.

Setup and `olympus doctor` print any missing preset prerequisites with the
exact command or local-server action to take.

Nothing in this guide sends your data anywhere until *you* describe what
counts as Personal, Private, and Secrets, then choose a privacy posture
in step 2. That choice is the heart of Olympus.

---

## 1. Install the plugin

Use the [pilot download procedure](../INSTALL_FOR_AGENTS.md#pilot-download)
to obtain the designated package from GitHub. It retrieves the SHA-256 and
byte count automatically from the release asset metadata; there is no separate
receipt to request. For a manual download, open the
[release](https://github.com/jamiezigelbaum/Olympus/releases/tag/v1.4.4)
and choose `olympus-1.4.4.tgz` under Assets, not a source-code archive. Compare
its SHA-256 and byte count with the pin in the linked download procedure and
record the release tag, asset ID, digest, and size with your install results.
Stop if the download is
unavailable or either value differs. Do not build a replacement or substitute
a Git checkout.

```bash
shasum -a 256 /absolute/path/to/olympus-1.4.4.tgz
wc -c < /absolute/path/to/olympus-1.4.4.tgz
```

Check for an existing installation with `openclaw plugins inspect olympus
--json` and the residue checks in [INSTALL_FOR_AGENTS.md](../INSTALL_FOR_AGENTS.md).
If Olympus is already installed or has saved state, follow that guide's
existing-install procedure before continuing. On a clean machine:

```bash
openclaw plugins install npm-pack:/absolute/path/to/olympus-1.4.4.tgz --force --accept-capabilities
# ^ on OpenClaw 2026.7.1: --accept-capabilities does not exist, and --force
#   there only overwrites an existing plugin — re-run with no flags
openclaw plugins enable olympus
```

You should see `Installed plugin: olympus`. On `2026.9.1` the gateway may
reload on its own at this point, so olympus can appear in its boot line
before you restart anything. That only registers the plugin: with no
posture, no keys and no sources, Olympus reads nothing and sends nothing
until you choose and connect a source in step 5. The deliberate restart in
step 4 is still required — it is what loads the plugin against your finished config.

Both flags are required on OpenClaw `2026.8.1+`. `--accept-capabilities`
supplies the capability consent a non-TTY install cannot be prompted for;
without it the command exits 1. `--force` confirms a non-ClawHub install
source, which a `npm-pack:` install is; without it the command refuses with
`Install cancelled; rerun with --force after reviewing the source.` On those
versions `--force` also means "overwrite an existing plugin", so on a machine
that already has olympus installed, be sure that is what you want.

On `2026.7.1`, omit both: `--accept-capabilities` does not exist there, and
`--force` exists but means only "overwrite an existing plugin" — which is not
what a clean install wants.

The install command prints only `Installed plugin: olympus`, and `openclaw
plugins list` truncates the path in its table. To find where the plugin landed
— managed storage uses an internal directory name — read
`openclaw plugins inspect olympus --json` and take `plugin.rootDir`. The
standalone CLI is `bin/olympus` inside it. Define this shell function for the
remaining commands in this guide:

```bash
OLYMPUS_ROOT="$(openclaw plugins inspect olympus --json | jq -r .plugin.rootDir)"
OLYMPUS_BIN="$OLYMPUS_ROOT/bin/olympus"
olympus() { "$OLYMPUS_BIN" "$@"; }
```

If `jq` is unavailable, read `plugin.rootDir` from the JSON and set
`OLYMPUS_BIN` to that directory's `bin/olympus`. No PATH installation is assumed.

The `npm-pack:` prefix creates OpenClaw's managed npm project and proves the
installed dependency shape; a raw archive path is not equivalent. ClawHub
also carries those same release bytes (from 1.3.4), so
`openclaw plugins install clawhub:olympus --accept-capabilities` works too,
though it can trail the newest GitHub release.

## 2. Run setup

Your privacy preferences are not a file you write before setup. The
installer-agent flow asks them conversationally: "Tell me about your data —
what do you want your assistant to know about, and what are your privacy
concerns?" Once Olympus is running, you save the answer in the dashboard's
**Privacy** section (or with ChatGPT's `olympus_privacy_set`): your own words
for "What's private for you?", plus folders, Gmail labels or senders that are
always Private. That privacy profile is the only privacy configuration
Olympus reads. Olympus judges each item's names (Personal unless raised) and
its content (raised to Private or Secrets on evidence); your always-Private
rules raise matching items, and nothing you write can lower content.

In Privacy, **In your own words** shows your full description. **Edit** opens
it inline; Save and Cancel sit together. The note underneath explains that
ChatGPT sees these words, so describe topics rather than private details.
Olympus’s private classifier reads your draft and asks follow-up questions in your
own context, then adds any uncovered common privacy checks. Every answer starts
blank; skipped questions save as Private. Answers stay editable after your own
words. **Check what Olympus understood** summarizes both sides and tries synthetic
item names with the real classifier. **This is wrong** adds a correction to your
draft and checks that sample again. Nothing is saved until Save. When the private
model is unavailable, general questions appear and the read-back check is hidden. **Always private (optional)** shows your rules and an **Add a rule** sheet;
the note beside the rules explains that their names are shown to ChatGPT.
**Details** holds the longer explanations. Changes to the description or
removal of a rule still ask for confirmation; conflicts keep your changes
until you choose Apply or Discard.

The legacy sensitivity map (`~/.olympus/sensitivity-map.json` and
`olympus sensitivity validate`) was retired on 2026-10-03. If an older
install has that file, Olympus no longer reads it: re-add its rules in the
Privacy section.

```bash
olympus setup --preset private-cloud-only --cloud-lane subscription --yes
```

Setup also registers the background sync worker (a launchd agent on macOS, a
user systemd unit on Linux) and writes its environment file, so macOS shows a
"Background Items Added" notification when you run it. Step 3 checks that
worker rather than installing a second one. Setup also creates an owner-only
`~/.local/bin/olympus` launcher unless you already have a launcher owned by a
standalone installer or by you. It follows worker upgrades and rollback.
If `~/.local/bin` is absent from your login PATH, use the full command in
setup's `worker.install.cli_command`, for example
`"$HOME/.local/bin/olympus" dashboard`, on the machine running Olympus.

If setup reports missing model keys, finish base activation and open the
dashboard. Its **Keys** page (under **On this computer**, or through **Change**
under **Models**) accepts the required Venice keys (or a legacy Gemini repair key) and applies them;
source connections unlock when models are ready. Existing local models use the
agent-assisted starting point and Check readiness. No local model software is
installed or maintained by Olympus.

Only for an explicitly chosen headless workflow, run one key command at a time
on the Olympus host, completing its private prompt before the next:

```bash
olympus connect venice --api-key-prompt
```

Each command opens a masked terminal prompt. Paste only when prompted; the key
is not echoed or entered into shell history. Empty Enter waits again. The agent
should provide the resolved executable path if `olympus` is not on PATH.

For an already authenticated password-manager CLI, the existing stdin route
remains available. These variables represent in-memory manager output, never
keys pasted into commands:


```bash
printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
```

Connect is how API keys reach the worker: it validates the key, stores it in
the worker environment at mode 600, and tells you to run `olympus worker
restart` so the worker picks it up. Exporting a provider key in your own shell
does not reach the background worker, and `worker.env` is a generated managed
file — do not hand-edit it. A key containing a single quote is refused rather
than stored; rotate it at the provider for one without.

For `local-first` and `local-only`, start your local OpenAI-compatible model
server before relying on Private source answers.

Choose privacy sorting in the dashboard's **Keys → Sort your archive by privacy**.
The screen estimates time and cost from the items found so far in your connected
sources. The free local judge is the default. Venice is recommended only when
even the measured short-item rate would take more than fourteen 8-hour nights.
These are estimates, not an overnight schedule; this slice adds no idle mode.

Cloud judging stays off until you explicitly choose and approve it on this
computer. It uses an existing Venice model allowed by your Private-answer
policy and your own Venice account/key; Olympus pays for nothing. The cloud
judge reads every item before sorting, including items it marks Private. An
end-to-end encrypted judge is not available yet. The existing model privacy
and exact-model/prompt approval gates still apply.

Set a **total cloud spending limit** in dollars, not a fresh allowance per
restart. Keys shows spent/reserved and remaining amounts. Before sending a
judge request, Olympus durably reserves the estimated maximum input/output
cost at the dated listed price. Successful usage reports release excess
reservation; definite rejected requests release theirs, and unknown outcomes
retain it. An unreadable spending record stops cloud judging, is shown in Keys,
and leaves the rest of Olympus available with the local judge. These estimates can differ from
Venice's bill. A call that cannot fit stops cloud judging. The managed worker
reloads onto the free local judge when available; questions stay pending and
Private until judged, without a failed attempt or a tier change from the stop.

If you already judged on Venice before limits existed, nothing changes when you
upgrade: it keeps running with no limit until you set one here. Olympus doesn't
track cloud spending until then, so check your Venice account.
Cloud judging works newest first. Its dollar cap replaces the default daily
call cap; an explicitly configured daily call limit still applies.

A Venice HTTP 402 stops cloud judging durably and appears in Keys with a link
to check your Venice account/credit. Fix the account, then approve cloud
judging again. Raising the total cap or reapproving never erases prior spend.
A model without a listed price cannot be selected for cloud judging. Managed workers apply the choice through the existing reload support. A
hand-started worker must be restarted to change its active judge or resume judging after a stop; opting out
and lowering an active cloud cap take effect at the dispatch gate immediately.

The judge sends names and, for the content pass, a short excerpt of up to the
first 1,200 characters; Secrets screens run first. Model approval uses the same
classification ledger as `olympus tier classifier approve --why "<reason>"`.
`olympus tier classifier status` reports the active lane. Without its approval,
items needing the judge stay Private and remain available by keyword search.
Use `olympus tier classifier decline` to revoke that model's approval.

On `no-sensitive`, setup and doctor still show `secure_local` routed
`"mode": "disabled"` with an empty pool: Private items are searched by meaning
on this computer, but no Private agent answer lane exists. That is the honest
gap the preset promises, not a misconfiguration.

For a no-write preview of the same setup surface:

```bash
olympus setup --preset no-sensitive --yes --dry-run
```

Setup is explicit in the current alpha: choose the privacy posture and cloud
lane in flags, then Olympus writes the sovereignty policy and worker auth token.

- **Your privacy posture** — the one decision that matters. Four presets:

  | Preset | Personal content | Private content: health, finance, legal, therapy, family |
  |---|---|---|
  | `local-first` | frontier cloud | Private pool explicitly ordered local → Venice Private |
  | `local-only` | frontier cloud | your own local models only |
  | `private-cloud-only` | frontier cloud | Venice Private `kimi-k3` only |
  | `no-sensitive` | frontier cloud | **meaning search on this computer** (no Private agent answer lane until you add one) |

  In `private-cloud-only`, Private answers are served by the approved Venice
  Private model, with no local-model prerequisite or fallback. The Venice
  option handles Private answers. Every shipped preset uses built-in local
  EmbeddingGemma for both Personal and Private search. Venice embeddings need
  a separate explicit choice and approval.
  `local-first` explicitly orders local before Venice; a pool without `order` selects equal
  members from recent health/latency. Olympus does not provide or qualify E2EE
  out of the box in v0.4; custom integrations are user-owned and outside the
  release claim. Existing lexical-only installations require an approved
  embedding activation/backfill; preserve their current vectors and settings.
  All presets configure built-in local embeddings. Olympus never falls back
  to an ordinary cloud embedding provider for Private data. `local-only` never uses
  Venice. Secrets never leave the local secret store, and ordinary cloud never
  sees Private data.
  Turning Private data off is
  always an explicit preset choice, never a silent default.
- **Your cloud lane** — by default Olympus answers Personal
  questions with OpenClaw's own configured default model and auth, through
  `openclaw infer` (no model name or extra key needed); setup adds the
  `openclaw` directory to the worker's PATH. API-key providers are the
  alternative.
- **A worker auth token** — generated for you, stored in
  `~/.config/olympus/worker.env` (owner-only permissions).

Everything it writes is shown in the summary, and `olympus data delete --all`
removes all of it later.

## 3. Check the worker

The worker is the private engine that syncs, indexes, and answers. Step 2
registers it AND starts it, reporting `worker.state`, `worker.next`, and —
only if the start did not take — `worker.activation_detail`. So this is a
check, not a second install:

Setup exits nonzero with `ok: false` and `worker.activation: failed` if it
cannot apply the configuration. When changing an existing privacy preset,
an old process may still report `active`; that alone does not prove the new
policy took effect. Follow `worker.next` and confirm activation before using
the newly selected posture.

```bash
olympus worker status
```

Expect `service.state: active`, `service.unit_present: true`,
`lifecycle_transaction.state: none`, and an empty top-level `recovery` list
— a fresh install has nothing to resume. Do not read the top-level `ok` as
"it is running": `ok` is false only for `failed` and `unknown`, so a
stopped worker still reports `ok: true`.

If you see `service.state: inactive`, the service is registered but not
running, and the remedy is `olympus worker start` — not a reinstall. It
polls the service manager for up to 15 seconds and lets a worker already
answering its health route have the last word, so the state it prints is
settled. If a start genuinely fails it says
`olympus worker start completed but status is inactive.` and quotes the
worker's own last log line; read that before doing anything else. Only then
do you reach for `olympus worker install`, which is idempotent, writes
nothing over an already-active service, and is the repair rather than a
first install.

With no sources connected yet the scheduler is enabled and idle — that is the
healthy fresh-install state, and doctor stays green. To watch it run
in the foreground for a first session instead, stop the background service first
(`olympus worker stop`), then:

```bash
olympus worker foreground   # Ctrl-C stops it
```

The public worker lifecycle is the same on macOS and Linux:

```bash
olympus worker install      # idempotent; also the repair for an interrupted install
olympus worker start
olympus worker stop
olympus worker restart
olympus worker upgrade --artifact /absolute/path/to/olympus-1.4.4.tgz
olympus worker uninstall
```

Install and upgrade are idempotent and use a crash-recoverable transaction for
the generated unit and owner-only worker environment. If either is interrupted,
rerun the same command. `status` names an interrupted transaction and its exact
next action. Uninstall removes the supervised service but retains credentials,
source configuration, and indexed data; the data lifecycle below is the
separate destructive boundary.

Do not restart the worker for ordinary credential, scope, pairing, Disconnect,
partial-sync, or missing source-dependency recovery. Follow the dashboard card
or `olympus doctor` action for that source.

## 4. Validate and restart the gateway

This restart is required on every install, even when olympus already shows
as loaded or its tools already answer: those can come from the host's
automatic reload before setup wrote your configuration. The restart loads the
plugin against the configuration you approved.

Before this restart, select and prepare the dashboard described in Step 5.
If the artifact supports native Control UI, handle its Labs opt-in and Gateway
origin now through the authorized configuration workflow. On OpenClaw 2026.9.5,
setting `gateway.controlUi.experimental.customPlugins` restarts the Gateway
itself: when you turn it on here, set it after `openclaw config validate` is
green, skip the restart command below, and wait for
`openclaw gateway status` to show it running. On the tested Air,
WebKit rejects the Secure plugin cookie over plain loopback HTTP; use Chrome
on loopback or an existing trusted HTTPS route. Do not weaken authentication
or change certificate trust just to make the plugin page load.

```bash
openclaw config validate
openclaw doctor --lint
openclaw gateway restart
```

`openclaw config validate` is the one that has to be green before you restart.
`openclaw doctor --lint` is a report on your whole OpenClaw install and often
exits 1 on pre-existing warnings that have nothing to do with Olympus; read
those, but they do not block the restart.

Olympus registers `source_answer`, `source_index_status`, and
`source_index_search` when the plugin initializes. OpenClaw's tool profile must
also permit them. A working dashboard or CLI does not prove agent access;
`plugins inspect` can report an empty static `toolNames` list on a healthy install.

For a fresh `coding` profile with no existing `tools.allow` or `tools.alsoAllow`:

```bash
openclaw config get tools
openclaw config set tools.alsoAllow '["olympus"]'
openclaw config validate
```

If a list already exists, preserve its entries and add `olympus` to that list;
do not combine `allow` and `alsoAllow` in the same scope. Keep the current
profile and intentional denies. Agent/provider/sandbox restrictions may also
apply. Follow the [native tool-access check](../INSTALL_FOR_AGENTS.md#native-agent-tool-access)
for the installed host's schema and policy diagnostics.

Before declaring setup complete, ask your intended OpenClaw assistant to call
`source_index_status` and verify a successful tool result. No connected source
is needed for this check. A model's assurance or a CLI fallback is insufficient.
The current host can hot-apply the tool-policy change without another restart.

The boot line is not where you would guess. `openclaw logs` printed nothing
on `2026.9.1`, and `~/.openclaw/logs/gateway.log` can be months stale. On
macOS the live log is a per-day JSON-lines file under `/tmp/openclaw/`; on
Linux it is the user systemd journal:

```bash
# macOS — newest daily log; each line is JSON, so pipe through `jq -r .message` to read it
grep -h 'http server listening' "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"

# Linux
journalctl --user -u openclaw -n 200 --no-pager | grep 'http server listening'
```

If the line is not there because the log rotated since the last restart,
the other two checks stand on their own — do not restart again just to
produce it.

## 5. Open your dashboard and connect sources

Installation ends with a working, clickable Olympus dashboard link from your
agent. Sources are what make Olympus useful, and you choose which ones in the
dashboard, so that link is required. The agent
must resolve the address for your browser and verify dashboard access, rather
than giving you a host-only localhost URL or another terminal command.

If the dashboard asks for a model key, add it on **Keys** first (under
**On this computer**, or through **Change** under **Models**). Then connect
sources under **Sources** and choose their scope. **Needs you** lists anything
waiting on you, each source's row shows its readiness, and **Progress** shows
reading and indexing, stage by stage under **Details**. Return to the same agent
chat if you need help connecting a source or understanding its progress.

For native OpenClaw access, the dashboard page is
`/plugin?plugin=olympus&id=dashboard` on the Gateway origin you already use.
The agent should include that full verified link in its final reply.

Base installation is ready when the chosen model prerequisites, worker health,
and plugin/tool activation above are verified. No source connection is needed
for that result. You can stop here and connect a source later.

This candidate artifact includes native Control UI support. On OpenClaw
**2026.9.2**, open **Olympus** in the Control UI sidebar. This requires **Settings → Labs → Custom plugin
UI** and the Gateway activation completed in Step 4, followed by a browser
reload. The native page uses your signed-in permissions and
keeps the worker bearer on the server, so no worker-token paste is needed.
Native OAuth works without configuration when your browser reaches the Gateway
on a localhost/loopback address. Reaching it any other way, such as through an
HTTPS proxy, needs `gateway.publicOrigin` to name that HTTPS origin; follow the
managed change procedure to configure it.
See the [agent guide](../INSTALL_FOR_AGENTS.md#step-6--finish-installation-dashboard-handoff).

If the artifact lacks that integration, or you choose direct access, use the
standalone dashboard. A declared native UI that fails to load needs diagnosis;
backend health alone is not a successful UI handoff:

```bash
olympus dashboard
```

The command opens the standalone dashboard with its controls authorized. If
Olympus runs on another machine, your agent runs `olympus dashboard --no-open`
and gives you the returned opening link for the browser connection you configured. You do not need the plugin's
installation directory or its worker token.

The link expires after fifteen minutes and works once. Open it promptly; if it has
expired or was already used, ask your agent to run `olympus dashboard` again.
The browser clears the link's ticket and keeps an HttpOnly control session;
the durable worker token never enters the URL or browser storage. Treat an
unused opening link as access to your dashboard and keep it out of public logs.

Old `dash_` links remain read-only. Use a fresh opening link when you need the
controls. `olympus dashboard token` is an advanced compatibility command, not a
required setup step; do not copy its secret into chat.

Choose the source you want now; the source roster is not a checklist. Follow its credential or pairing → scope → initial sync → source
health → cited-answer readiness journey. Other sources can be added later.
Every blocked or degraded source names the next supported action.
Each connected source shows its canonical sync and coverage state, and eligible
cards have a **Sync now** button for an immediate run. Every source judges
each new item on its own and stores it in its tier's index; `olympus tier
explain <locator>` shows why an item has its tier, and `olympus tier set` or
`olympus tier rules` change it.

Standalone control requests retain their signed HttpOnly session, same-origin,
and CSRF checks. The opening link authorizes the browser; it does not connect a
source or start ingestion by itself.

Connect only the source you chose, using its dashboard card and the
[per-source guide](../INSTALL_FOR_AGENTS.md#step-6--finish-installation-dashboard-handoff).
Olympus's packaged publisher Google client requests Gmail or Drive scopes only when
you choose that source; Gmail is not required for installation. X uses your own
developer application, with plan availability and possible cost shown before
consent. Olympus supports one connected account per provider.

For Drive and Dropbox, **Connect** only connects the account, and the card
reads Waiting, *waiting for folder selection*, until you save a scope. Open
**Choose folders**, use the Finder-style inspector's **Full ingestion**, **Metadata
only**, and **No ingestion** choices, then explicitly **Save scope and start**.
The folder browser lists names without indexing or reading file contents.
Folder names load automatically when Choose folders opens. Update refreshes
the listing; the loading indicator stays visible while requests are in flight.
Unselected folders stay out. Entire-account ingestion requires an explicit
selection and confirmation; a default configuration is not permission.

Gmail works the same way: **Connect** only connects the mailbox, and the card
reads Waiting, *waiting for mail selection*, until you open **Choose mail** and
press **Save scope and start**. Nothing is read before that, not even
metadata. The picker offers how far back Olympus stores the body of your mail
(the last 2 years by default; for older mail only the subject, sender, date and
labels are stored, never the body), which Gmail categories and labels to skip
(Promotions and Social are skipped by default), and "always Private" and "skip"
sender lists seeded from a header-only sample of your recent mail. New mail from
a skipped sender is never read. New mail from an always-Private sender is
classified Private (S4): it is stored only in Gmail's secure_local store and
embedded only by your private model, never by a cloud model. Mail Olympus
already holds is never removed, re-read or re-tiered by a scope change, so its
existing chunks and embeddings are kept. Before anything runs it shows an
estimate: Gmail's approximate message counts and an upper bound on embedding
cost (there is no sync-time estimate); opening the
picker spends at most 108 Gmail API requests, charged to the picker's own
allowance of 432 requests a day, never to the sync lane's budget. Saving a
changed scope starts a fresh traversal under the new query that skips mail
already held; saving an unchanged scope does nothing. The approval is stored in
`mail-source-scopes.json` beside the connected-handle registry.

A Google Takeout mail export (`.mbox`) of the connected account joins Gmail
when you import it: its messages are the same items as the live ones, so
nothing is stored twice. Takeout names each message by Gmail's id, so this
costs no Gmail requests. Messages without that id are looked up in Gmail, and
imports may spend at most half of the day's Gmail requests
(`OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET`, 1,000,000 by default), so
live mail always keeps the rest. Below 32 a day an import cannot move: its row
and Needs you say so, and setting the budget to 32 or more, then restarting
Olympus, lets it go on.

Operators can still narrow Gmail with the hidden
`OLYMPUS_SOURCE_INDEX_GMAIL_QUERY` setting (Gmail search syntax). It is an
override on top of the approved scope, never a replacement: the lane ANDs it
with the picker's query, so it can only read less.

Every public source uses the canonical connector-store runtime. Each
chosen lane becomes ready when its credential or paired session, scope, and
source-specific prerequisites are satisfied; no legacy read-authority flag or
migration utility is needed. Omit `--session-ready` for Telegram or WhatsApp
until its local pairing helper is ready; otherwise it records `reauth_required`.

On this computer's Keys page, pair Telegram or WhatsApp on its card. After a
first pairing, choose **Pick chats (recommended)** and confirm the selected
chats, or **Everything in this account** (including new chats). Pairing alone
does not register a capture grant or start capture. Returning to Keys resumes
the waiting login prompt, QR or chat choice. Cancelling the first chat choice
leaves capture off but keeps the provider login: remove Olympus in Telegram
active sessions or WhatsApp linked devices to unlink it.
Re-pairing Telegram retains its existing capture scope only when the authenticated
account reference matches the one saved with that grant. Older grants without
that reference, a different or unproven account, and every WhatsApp re-pair ask
for fresh chat choices. Starting a re-pair suspends the old grant on disk before
the login can change. Cancellation or failure leaves capture off, including
after a worker restart, until a successful re-pair publishes proven or newly
approved consent. Choosing chats from the old grant cannot clear that suspension.
The WhatsApp picker lists saved contacts and joined groups and may omit unsaved
chats. Each message is still classified individually; chat selection does not
set its privacy tier.

<details>
<summary>CLI fallback reference for a chosen source</summary>

Use only the command for the source currently being connected. These examples
are alternatives, not an installation checklist. The dashboard is the normal
path, including Google's packaged client; the Google client ID below is an
explicitly chosen advanced BYO fallback.

```bash
olympus connect google --client-id <google-oauth-client-id>
olympus connect dropbox --client-id <dropbox-oauth-client-id>
olympus connect telegram --pair
olympus connect whatsapp --session-path ~/.local/share/olympus/whatsapp --session-ready
printf '%s' "$READWISE_TOKEN" | olympus connect readwise --api-key-stdin
```

Tokens use the supported local secret store. Never paste secrets into chat or
invent storage commands; use the selected password-manager method and the
[documented stdin flow](../INSTALL_FOR_AGENTS.md#headless-credential-fallback--only-when-explicitly-chosen).

</details>

**Disconnect** stops scheduled and manual reads and removes the local account
grant without a worker restart. It retains indexed data and reusable app
registration and does not revoke the provider grant. Use the linked provider
page for revocation. To delete local source data, preview the CLI custody
boundary, Disconnect, then execute it:

```bash
olympus data delete --source dropbox.files --dry-run
olympus data delete --source dropbox.files
```

**Unpair** is the same bounded control for the two paired sessions, Telegram and
WhatsApp: it stops reads and deletes this computer's pairing session only. Stop
the capture service first if it is running, keep in mind that indexed messages
and captured media stay, and remove the linked device yourself in Telegram
active sessions or WhatsApp linked devices.

## 6. Verify a cited answer from your chosen source

Wait until the source you chose reports a successful initial sync and answer
readiness. Ask a normal question whose answer you expect in that source, then
check the returned citations. With no source connected, this proof is pending;
an empty-source answer does not verify retrieval.

In your OpenClaw chat, for example:

> *"Using the source I just connected, what did I commit to this week?"*

Your agent calls `source_answer` and gets back a cited, privacy-gated answer —
never raw documents, never content from a tier you didn't approve. Private
sources are searched by default when your posture approves a private model;
that model answers from them and only its checked answer comes back. On
`no-sensitive` the answer says Private sources were not searched. Answers
report how many items matched per source, not just how many were quoted. If
the ordinary lane fails, the error names why (for example missing auth for
OpenClaw's default model, or `openclaw` not found on the worker PATH).

Or from the terminal:

```bash
olympus source answer "what did I commit to this week?"
```

The private source worker lane is on by default, so `email_not_configured`
should not appear on a fresh install — `OLYMPUS_EMAIL_ENABLED=false` is the
explicit opt-out. If you do see it, run what its remedy names (`olympus setup`,
then `olympus worker install`). A worker that simply is not running says so
instead: `Email worker is not reachable at http://127.0.0.1:8010/v1:`
followed by the underlying connection error.

To let other agents ask Olympus (ChatGPT, Claude, Grok, Grok Bot, or Claude
Code and Codex on this computer), open the dashboard on this computer (`olympus dashboard`), choose
**Open** next to **Agents** under **On this computer**, and press **Connect an
agent** — see the README's "Connect other agents" section. Agents in the cloud
also need remote access: press **Turn on remote access** on the same page, and
Olympus connects through the Olympus relay (`mcp.olympusplugin.ai`) with no
account, tunnel or certificate agreement to set up. The relay connects
ChatGPT, Claude, Grok (grok.com) and Grok Bot; ChatGPT itself uses the
Olympus plugin: see the README's
[Olympus for ChatGPT](../README.md#olympus-for-chatgpt). (Advanced: the Grok
API and other cloud agents need a tunnel of your own in
`remote.publicBaseUrl`, approved with a pairing code or a key.)

For OpenClaw, Hermes or another MCP client under another account, choose
**Agent on another account of this computer**. For an agent on your Tailscale
network, choose **Agent on my tailnet**; the page says if Tailscale is not
running. Name the agent, choose **Create key**, and copy the setup line into
it. No separate sign-in or remote access switch is needed. Copy before
**Done**: the key and setup lines are shown once. **Revoke** stops that agent;
revoking a route's last key stops its listener.

## Anytime

```bash
olympus doctor              # diagnoses anything unhealthy, with fix-it hints
olympus data export --output ~/olympus-export    # your data, out (secrets excluded)
olympus data backup --output /Volumes/T7/Backup --passphrase-stdin   # one encrypted backup file
olympus data restore --input /Volumes/T7/Backup/olympus-backup-2026-11-10-0310.olympusbackup --passphrase-stdin
olympus data delete --all   # complete removal: indexes, embeddings, configs, tokens
```

A backup is one file, `olympus-backup-<date>-<time>.olympusbackup`. With a
passphrase it is encrypted (scrypt and AES-256-GCM); without one, anyone with
the file can read your Private and Secret items. Olympus can't recover a lost
passphrase. Restore onto a fresh install with Olympus stopped, before you
connect sources; afterwards you sign in to each source once. Settings › Back up
and restore in the dashboard does the same, and can back up every night or week.

Olympus owns seven directories, and `data delete --all` covers all of them:
`~/.olympus`, `~/.config/olympus`, `~/.local/share/olympus`,
`~/.local/share/openclaw/olympus`, `~/.local/state/olympus`, `~/.cache/olympus`
(the Venice model-catalog cache), and `~/Library/Logs/Olympus` on macOS. If you
are checking a machine for a previous install, those are the places to look —
not just `~/.olympus`.

---

**Something not working?** `olympus doctor` first. Every failure it knows
about comes with the command that fixes it. A red walk exits 1 and prints a
summary to stderr — `olympus doctor: N of M checks passed, K failed.` and the
names of the failed checks — while the full JSON stays on stdout, so its exit
status is a reliable pass/fail signal in scripts. Branch on the exit status,
not on the counts; `M` is doctor's whole check list, 15 on a current build.

One missing key can show up as several failures. `email_worker`,
`worker_credential_lanes`, and `source_index_status` all question the same
worker, so a missing key for a legacy Gemini embedding policy reddens all three at once. If the
worker answered, their details say `degraded` and name the same credential —
connect the key, `olympus worker restart`, done. If it did not answer, they
say `not reachable at http://127.0.0.1:8010/v1` and the fix is
`olympus worker start` (step 3), not the credential.

Zero connected sources is a normal starting state. Doctor keeps base-worker
health green when the worker is healthy and no credentials are degraded;
mailbox configuration is not a prerequisite. Choose sources in the dashboard
when you are ready. A selected source's connection/sync problems remain visible
as source-readiness problems.
