# Olympus Quickstart

From zero to asking your own data questions, in about ten minutes.

**You need:** a machine with [OpenClaw](https://openclaw.ai) `2026.7.1+`
installed, [Bun](https://bun.sh) `1.2+` (`curl -fsSL https://bun.sh/install | bash`),
and the maintainer's qualified Olympus tarball, SHA-256, and byte count. macOS
or Linux.

OpenClaw itself runs only on Node `>=22.22.3 <23`, `>=24.15.0 <25`, or
`>=25.9.0` — its npm `preinstall` script exits non-zero on anything else. Check
`node --version` before blaming an install failure on Olympus.

If `bun --version` says `command not found`, check `~/.bun/bin/bun --version`
before reinstalling anything — Bun's installer puts the binary there and wires
up PATH from your shell rc, which non-interactive shells never read. Adding
`export PATH="$HOME/.bun/bin:$PATH"` to the shell you are working in is enough.
The `olympus` CLI is a Bun script, so it needs `bun` on PATH wherever you run
it.

**Fastest path — let your agent install it.** Paste into any agent with a
terminal: *"Retrieve and follow the instructions in INSTALL_FOR_AGENTS.md"*
(at the repo root and inside the release tarball). The agent runs this
whole guide, asks you for the decisions that are yours, and verifies the
result. The steps below are the same flow, by hand.

Before first setup, follow the
[agent-led model setup guide](SOVEREIGNTY_CONFIG.md#agent-led-model-setup-for-the-v04-beta).
It covers account creation, API spending, exact password-manager references,
local models, and the required embedding dimensions. **Current blocker:** the
CLI cannot yet persist those dimensions. If your installation lacks them,
stop before connecting keys or restarting and report the blocker; do not edit
the generated worker environment. A guide is not a substitute for that fix.

The preset prerequisites are:

| Preset | Required before first source answer |
|---|---|
| `local-first` | Gemini key and dimension for non-secure embeddings; a funded Venice API key; local answer and embedding models with exact IDs and a local embedding dimension. Both shipped local profiles use `http://127.0.0.1:28090/v1`. |
| `local-only` | Gemini key and dimension for non-secure embeddings; local answer and embedding models with exact IDs and a local embedding dimension, using `http://127.0.0.1:28090/v1` in the shipped preset. No Venice account is needed. |
| `private-cloud-only` | Gemini key and dimension for non-secure embeddings; a funded Venice API key for secure answers. Secure search is local keyword search, with no secure embedding model or local server required. |
| `no-sensitive` | Gemini key and dimension for non-secure embeddings. Secure content is unavailable to answering. |

A local runtime means a server actually answering at the effective policy's
endpoints and serving its exact answer and embedding model IDs. An
installed plugin is not a runtime — OpenClaw ships a built-in `llama-cpp`
provider plugin on machines that have never run a local model.

Setup and `olympus doctor` print any missing preset prerequisites with the
exact command or local-server action to take.

Nothing in this guide sends your data anywhere until *you* describe what
counts as public, private, secure, and secrets, then choose a privacy posture
in step 2. That choice is the heart of Olympus.

---

## 1. Install the plugin

The pilot installs the exact qualified tarball supplied by the maintainer.
Before installing, compare its SHA-256 and byte count with the supplied
receipt; stop on a mismatch or a missing receipt. Do not build a replacement
or substitute a Git checkout. Record that identity with your install results.

```bash
shasum -a 256 /absolute/path/to/olympus-0.4.0.tgz
wc -c < /absolute/path/to/olympus-0.4.0.tgz
```

Check for an existing installation with `openclaw plugins inspect olympus
--json` and the residue checks in [INSTALL_FOR_AGENTS.md](../INSTALL_FOR_AGENTS.md).
If Olympus is already installed or has saved state, follow that guide's
existing-install procedure before continuing. On a clean machine:

```bash
openclaw plugins install npm-pack:/absolute/path/to/olympus-0.4.0.tgz --force --accept-capabilities
# ^ on OpenClaw 2026.7.1: --accept-capabilities does not exist, and --force
#   there only overwrites an existing plugin — re-run with no flags
openclaw plugins enable olympus
```

You should see `Installed plugin: olympus`. On `2026.9.1` the gateway may
reload on its own at this point, so olympus can appear in its boot line
before you restart anything. That only registers the plugin: with no
posture, no keys and no sources, Olympus reads nothing and sends nothing
until you connect a source in step 4. The deliberate restart in step 5 is
still required — it is what loads the plugin against your finished config.

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
installed dependency shape; a raw archive path is not equivalent. After the
pilot, ClawHub receives those same bytes without rebuilding the package and
`openclaw plugins install clawhub:olympus --accept-capabilities` becomes the
public install path.

## 2. Run setup

First write your sensitivity map:

```bash
mkdir -p ~/.olympus && chmod 700 ~/.olympus   # setup makes it 0700 too, but runs later
$EDITOR ~/.olympus/sensitivity-map.json
chmod 600 ~/.olympus/sensitivity-map.json     # the map is owner-only; your umask isn't
olympus sensitivity validate
```

The first `chmod` covers the directory, the second covers the map itself.
Nothing in Olympus writes `sensitivity-map.json` — you do — so it lands at
your umask (0644 on a clean macOS install), inside a directory that hides
it from other users but not from anything running as you.
`olympus sensitivity validate` enforces the same thing: it leaves the file
0600 and reports `permissions` and `permissionsTightened` when it had to
change it. Setting it yourself first means it never has to.

The installer-agent flow asks this conversationally: "Tell me about your data
— what do you want your assistant to know about, and what are your privacy
concerns?" For the hand path, write only secure/secrets categories in this
phase. Public/private entries are not accepted yet because the map is
raise-only guidance: it may raise matching items to secure or secrets, never
downgrade them.

```bash
olympus setup --preset private-cloud-only --cloud-lane subscription --yes
```

Setup also registers the background sync worker (a launchd agent on macOS, a
user systemd unit on Linux) and writes its environment file, so macOS shows a
"Background Items Added" notification when you run it. Step 3 checks that
worker rather than installing a second one.

If setup reports unmet prerequisites, follow the printed remedies before your
first indexing or `source_answer` call. Common examples:

```bash
printf '%s' "$GEMINI_API_KEY" | olympus connect gemini --api-key-stdin
printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
```

Connect is how API keys reach the worker: it validates the key, stores it in
the worker environment at mode 600, and tells you to run `olympus worker
restart` so the worker picks it up. Exporting `GEMINI_API_KEY` in your own shell
does not reach the background worker, and `worker.env` is a generated managed
file — do not hand-edit it. A key containing a single quote is refused rather
than stored; rotate it at the provider for one without.

For `local-first` and `local-only`, start your local OpenAI-compatible model
server before relying on secure source answers.

On `no-sensitive`, setup and doctor still list the secure corpora as configured
and empty, with `secure_local` routed `"mode": "disabled"`. That is the honest
gap the preset promises, not a misconfiguration.

For a no-write preview of the same setup surface:

```bash
olympus setup --preset no-sensitive --yes --dry-run
```

Setup is explicit in the current alpha: choose the privacy posture and cloud
lane in flags, then Olympus writes the sovereignty policy and worker auth token.

- **Your privacy posture** — the one decision that matters. Four presets:

  | Preset | Public/private content | Secure content: health, finance, legal, therapy, family |
  |---|---|---|
  | `local-first` | frontier cloud | secure pool explicitly ordered local → Venice Private |
  | `local-only` | frontier cloud | your own local models only |
  | `private-cloud-only` | frontier cloud | Venice Private `kimi-k3` only |
  | `no-sensitive` | frontier cloud | **not ingested** (honest gap until you add a secure lane) |

  In `private-cloud-only`, secure answers are served by the approved Venice
  Private model, with no local-model prerequisite or fallback. `local-first`
  explicitly orders local before Venice; a pool without `order` selects equal
  members from recent health/latency. Olympus does not provide or qualify E2EE
  out of the box in v0.4; custom integrations are user-owned and outside the
  release claim. Secure search remains lexical-only in `private-cloud-only`;
  local presets configure local secure embeddings. Olympus never falls back
  to an ordinary cloud embedding provider for secure data. `local-only` never uses
  Venice. Secrets never leave the local secret store, and ordinary cloud never
  sees secure data.
  Turning secure data off is
  always an explicit preset choice, never a silent default.
- **Your cloud lane** — by default Olympus reasons through your existing
  OpenClaw subscription (no API key needed). API-key providers are the
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
olympus worker upgrade --artifact /absolute/path/to/olympus-0.4.0.tgz
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

## 4. Connect your sources

```bash
olympus connect google --client-id <google-oauth-client-id>
olympus connect dropbox --client-id <dropbox-oauth-client-id>

olympus connect telegram --session-path ~/.local/share/olympus/telegram.session --session-ready
olympus connect whatsapp --session-path ~/.local/share/olympus/whatsapp --session-ready

printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
printf '%s' "$READWISE_TOKEN" | olympus connect readwise --api-key-stdin
```

Connect as few or as many as you like, one source at a time. Connecting records
the credentials and runtime handles Olympus needs. All seven declared sources
use the canonical connector-store runtime; each lane activates when its
credential or paired session, scope, and source-specific prerequisites are
ready. No source requires a legacy read-authority flag or migration utility.

X uses a user-owned developer application so its API usage is not billed to
Olympus. Complete X setup in the dashboard. The current supported fallback is
a confidential client ID and secret entered locally; client-ID-only PKCE is
not promised until its refresh/rotation/restart path is qualified.

Tokens live in an encrypted local secret store by default, or in an explicitly
configured OS/1Password secret store when supported, never in plain text or
logs. Omit `--session-ready` for Telegram or WhatsApp if the
local session still needs the Telethon or WhatsApp pairing helper; Olympus will
record the handle as `reauth_required`.

## 5. Validate and restart the gateway

```bash
openclaw config validate
openclaw doctor --lint
openclaw gateway restart
```

`openclaw config validate` is the one that has to be green before you restart.
`openclaw doctor --lint` is a report on your whole OpenClaw install and often
exits 1 on pre-existing warnings that have nothing to do with Olympus; read
those, but they do not block the restart.

This loads the Olympus tools into your agent: `source_answer`,
`source_index_status`, and `source_index_search`. They register when the plugin
initializes, so `openclaw plugins inspect olympus --json` reports an empty
`toolNames` by design — that is not a failed load. Verify instead that the
gateway boot line lists olympus, that inspect reports `"status": "loaded"`,
and that `olympus source index status` returns.

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

## 6. Watch it ingest

```bash
olympus dashboard
```

The command prints three fields: the dashboard `url`, whether it `opened` a
browser, and a `hint`. The URL ends in `?token=dash_…` — the read-only view
token — and that is the URL that works. A browser cannot send a bearer
header from the address bar, so the bare `/dashboard` path returns 401; copy
the URL whole. Your browser lands on a local, token-protected dashboard:
source freshness, how much is indexed, and where public, private, secure,
and secrets are allowed to go. The hint says the split out loud: *"This URL
carries the read-only view token, not the worker token; unlocking the
controls still needs `<rootDir>/bin/olympus dashboard token`."*

That `dash_` token is derived from the worker token, is read-only, and is
accepted on exactly two routes — `GET /dashboard` and `GET /dashboard.json`
— so it cannot connect, reauthenticate, sync, disconnect, or unpair. Anyone
with the link can read your dashboard, so treat the URL like the screen
itself rather than like a secret to be scrubbed.

Changing anything (connecting, reauthenticating, sync now) asks once for the
**worker token**, which is a different value and is a real secret:
`<rootDir>/bin/olympus dashboard token` prints it — `rootDir` comes from
`openclaw plugins inspect olympus --json`, because `olympus` is not on PATH
after a clean install. It authorizes changes, so keep it out of chat logs
and notes —
or ask your agent for it with the prompt behind the dashboard's "Where is my
token?" button. The setup page follows one journey: security preset → dependencies →
credential or pairing → scope → initial sync → source health → cited-answer
readiness. Every blocked or degraded source names the next supported action.
Each connected source shows its canonical sync and coverage state, and eligible
cards have a **Sync now** button for an immediate run. Dropbox starts from a
neutral account-root metadata listing until you install a narrower
operator-approved ingestion policy.

To repeat the split, because it is the thing people get wrong: the URL
carries the read-only dashboard token and nothing more. The first mutable
action asks for the worker bearer once, exchanges it for a signed HttpOnly
local control session, and discards the pasted value; origin and CSRF checks
protect every control request. The page does not put the worker bearer in
browser storage, and pasting the `dash_` URL token into the unlock field is
refused.

Every OAuth card walks you through registering Olympus's callback on your own
provider app, in numbered steps above the Client ID field: the console page to
open, the app type and permissions it needs, the exact setting the callback goes
in — Google's **Authorized redirect URIs**, Dropbox's **OAuth 2 → Redirect
URIs**, X's **Settings → Callback URI / Redirect URL** — with the exact URL
and a copy button, and what to bring back to the card. Every bring-your-own
client has to do this once. The URL is derived from the address you are reading
the dashboard on, so a dashboard reached over a proxy or tunnel has a different
one from a loopback dashboard and needs its own registration; a loopback
dashboard says there is nothing to register. "Ask your agent to walk you through
it" under the form still hands you the same instructions as a copyable prompt.

Connect opens the provider's authorization page in a **new tab**, so the
dashboard stays where it is and picks the connection up on its own; the
authorization tab tells you when you can close it. While an attempt is pending
the card offers **Cancel**, and its Client ID stays editable — pressing Connect
again starts a fresh attempt with whatever key is in the field, rather than
repeating the one the provider refused. If a provider does refuse, the card
says which code it returned and which URI to register.

Google setup uses the packaged shared pilot client by default, labels it
unverified, and requests Gmail and Drive scopes contextually. The advanced BYO
fallback needs only a Client ID because Olympus uses PKCE — a **Desktop app**
client for a loopback dashboard, a **Web application** client for a dashboard
served over https, since a Desktop app client cannot register an https redirect
URI. The card states which one your dashboard needs. X setup uses your developer
application and makes plan availability, rate ceilings, and possible cost
visible.

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

## 7. Ask your first question

In your OpenClaw chat:

> *"Using my sources, what did I commit to this week across email and
> Telegram?"*

Your agent calls `source_answer` and gets back a cited, privacy-gated answer —
never raw documents, never content from a tier you didn't approve.

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

Non-OpenClaw agents (Claude, etc.) can get the same tools over MCP:
`olympus serve` — see the README's MCP section.

## Anytime

```bash
olympus doctor              # diagnoses anything unhealthy, with fix-it hints
olympus data export --output ~/olympus-export    # your data, out (secrets excluded)
olympus data delete --all   # complete removal: indexes, embeddings, configs, tokens
```

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
worker, so a missing Gemini embedding key reddens all three at once. If the
worker answered, their details say `degraded` and name the same credential —
connect the key, `olympus worker restart`, done. If it did not answer, they
say `not reachable at http://127.0.0.1:8010/v1` and the fix is
`olympus worker start` (step 3), not the credential.

One more expected red on a fresh install: with no mailbox connected,
`email_worker` reports `configured=false`, and the worker's health detail
says why — `No email account is connected yet. Connect Gmail from the
Olympus dashboard to enable email answers.` Connect Gmail in step 4; there
is nothing to configure.
