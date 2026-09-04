# Olympus Quickstart

From zero to asking your own data questions, in about ten minutes.

**You need:** a machine with [OpenClaw](https://openclaw.ai) `2026.7.1+`
installed, [Bun](https://bun.sh) `1.2+` (`curl -fsSL https://bun.sh/install | bash`),
and access to the Olympus repository. macOS or Linux.

OpenClaw itself runs only on Node `>=22.22.3 <23`, `>=24.15.0 <25`, or
`>=25.9.0` — its npm `preinstall` script exits non-zero on anything else. Check
`node --version` before blaming an install failure on Olympus.

**Fastest path — let your agent install it.** Paste into any agent with a
terminal: *"Retrieve and follow the instructions in INSTALL_FOR_AGENTS.md"*
(at the repo root and inside the release tarball). The agent runs this
whole guide, asks you for the decisions that are yours, and verifies the
result. The steps below are the same flow, by hand.

Before first setup, have these preset prerequisites ready:

| Preset | Required before first source answer |
|---|---|
| `local-first` | `GEMINI_API_KEY`, a Venice API key connected with `printf '%s' "$VENICE_API_KEY" \| olympus connect venice --api-key-stdin`, a local OpenAI-compatible source-answer server on `http://127.0.0.1:8000/v1`, and a local OpenAI-compatible embedding server on `http://127.0.0.1:28011/v1`. |
| `local-only` | `GEMINI_API_KEY`, a local OpenAI-compatible source-answer server on `http://127.0.0.1:8000/v1`, and a local OpenAI-compatible embedding server on `http://127.0.0.1:28011/v1`. |
| `private-cloud-only` | `GEMINI_API_KEY` and a Venice API key connected with `printf '%s' "$VENICE_API_KEY" \| olympus connect venice --api-key-stdin`. |
| `no-sensitive` | `GEMINI_API_KEY` for source embeddings. |

Setup and `olympus doctor` print any missing preset prerequisites with the
exact command or local-server action to take.

Nothing in this guide sends your data anywhere until *you* describe what
counts as public, private, secure, and secrets, then choose a privacy posture
in step 2. That choice is the heart of Olympus.

---

## 1. Install the plugin

The pilot installs from the Olympus repository. Replace `<owner>/<repo>` with
the repository you were given:

```bash
openclaw plugins install git:<owner>/<repo> --accept-capabilities
# ^ on OpenClaw 2026.7.1 the flag is unknown: re-run without it
openclaw plugins enable olympus
```

You should see `Installed plugin: olympus`. (The gateway picks it up on its
next restart — step 5.)

`--accept-capabilities` is required on OpenClaw `2026.8.1+`, where a non-TTY
install otherwise exits 1 asking for capability consent. Omit it on `2026.7.1`,
which rejects the flag as unknown. The clone runs with terminal prompts
disabled, so git credentials for a private repository must already work.

Two other install sources exist and are **not** the pilot path:

- `openclaw plugins install clawhub:olympus --accept-capabilities` — the
  one-line public path, available only after Olympus is published to ClawHub,
  which happens after the pilot.
- `openclaw plugins install npm-pack:/path/to/olympus-0.4.0.tgz --force --accept-capabilities`
  — the maintainer's release-proof mechanism. It installs the exact qualified
  candidate through OpenClaw's managed npm project, which is what proves the
  installed dependency shape; a raw archive path is not that proof. ClawHub
  later receives those same bytes without rebuilding the package.

## 2. Run setup

First write your sensitivity map:

```bash
$EDITOR ~/.olympus/sensitivity-map.json
olympus sensitivity validate
```

The installer-agent flow asks this conversationally: "Tell me about your data
— what do you want your assistant to know about, and what are your privacy
concerns?" For the hand path, write only secure/secrets categories in this
phase. Public/private entries are not accepted yet because the map is
raise-only guidance: it may raise matching items to secure or secrets, never
downgrade them.

```bash
olympus setup --preset private-cloud-only --cloud-lane subscription --yes
```

If setup reports unmet prerequisites, follow the printed remedies before your
first indexing or `source_answer` call. Common examples:

```bash
export GEMINI_API_KEY=...
printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
```

For `local-first` and `local-only`, start your local OpenAI-compatible model
server before relying on secure source answers.

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
  release claim. Secure corpora remain lexical-only in v0.4; Olympus never
  falls back to an ordinary cloud embedding provider. `local-only` never uses
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

## 3. Start the worker

The worker is the private engine that syncs, indexes, and answers. Pick one:

```bash
olympus worker foreground   # foreground, great for a first session (Ctrl-C stops it)
```

```bash
olympus worker install      # or: enable, start now, restart on failure
olympus worker status
```

The public worker lifecycle is the same on macOS and Linux:

```bash
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

This loads the Olympus tools into your agent: `source_answer`,
`source_index_status`, and `source_index_search`.

## 6. Watch it ingest

```bash
olympus dashboard
```

Your browser opens a local, token-protected dashboard: source freshness, how
much is indexed, and where public, private, secure, and secrets are allowed to
go.
Reading is open on that link; changing anything (connecting, reauthenticating,
sync now) asks once for the worker token — `olympus dashboard token` prints it,
or ask your agent for it with the prompt behind the dashboard's "Where is my
token?" button. The setup page follows one journey: security preset → dependencies →
credential or pairing → scope → initial sync → source health → cited-answer
readiness. Every blocked or degraded source names the next supported action.
Each connected source shows its canonical sync and coverage state, and eligible
cards have a **Sync now** button for an immediate run. Dropbox starts from a
neutral account-root metadata listing until you install a narrower
operator-approved ingestion policy.

The URL carries only a read-only dashboard token. The first mutable action asks
for the worker bearer once, exchanges it for a signed HttpOnly local control
session, and discards the pasted value; origin and CSRF checks protect every
control request. The page does not put the worker bearer in browser storage.

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

Non-OpenClaw agents (Claude, etc.) can get the same tools over MCP:
`olympus serve` — see the README's MCP section.

## Anytime

```bash
olympus doctor              # diagnoses anything unhealthy, with fix-it hints
olympus data export --output ~/olympus-export    # your data, out (secrets excluded)
olympus data delete --all   # complete removal: indexes, embeddings, configs, tokens
```

---

**Something not working?** `olympus doctor` first. Every failure it knows
about comes with the command that fixes it.
