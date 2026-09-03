# Olympus: Installation Guide for AI Agents

You are an AI agent installing Olympus for your operator — or updating,
repairing, or otherwise maintaining an existing install, which this guide
governs too (see Rules zero and one, next). Olympus is a privacy-gated
personal-data layer for OpenClaw: it ingests the operator's sources
(email, files, chats), indexes them locally, and answers questions
through model lanes the operator explicitly approves. Follow the steps in
order. Where a step says **ASK THE OPERATOR**, stop and ask — do not pick a
default. The whole install takes about ten minutes plus OAuth clicks.

## Rule zero — the residue gate binds EVERY Olympus-touching action

This rule binds every action that installs, updates, enables, re-enables,
restarts, or reconfigures Olympus or its worker — regardless of how the
operator's request was framed. A fresh install, `openclaw plugins update
olympus`, "fix olympus", "restart the worker", a bulk `openclaw plugins
update` sweep that merely includes olympus, a fix for an
unrelated-sounding symptom ("my email isn't showing up in search") whose
remedy turns out to touch Olympus — all of it. What the ACTION touches is
what counts, not whether Olympus was named in the request. An update or
repair request is NOT a bypass around the decision gates in this guide;
maintenance on an already-installed machine is where the gate matters
most, because the steps look skippable.

Before ANY state-changing action affecting Olympus — `plugins update`;
enabling, re-enabling, or restarting any worker or launchd/systemd item;
writing new config or adopting existing config — check for traces of a
prior Olympus setup. Actually run the checks; "no residue" is a claim you
may make only after they come back empty:

```bash
ls -la ~/.olympus ~/.config/olympus 2>/dev/null
openclaw plugins list      # olympus already installed?
ls ~/Library/LaunchAgents 2>/dev/null | grep -i olympus   # macOS
# Linux: systemctl --user list-unit-files | grep -i olympus
```

…plus a look through your own memory/bulletin files and any prior
session's summary for Olympus notes, and — on macOS — per-provider
Keychain probes for the providers Olympus connects (venice, gemini,
google and its `gog` helper, plus any Step 5 provider — Dropbox, X,
Readwise — the list is illustrative, not closed), as presence checks
only (never dump or print a secret's value — MUST NOT #2): a
credential named for a provider is residue to surface even though
nothing about it says "olympus". On a clean machine everything comes
back empty and you proceed with no extra ceremony — the gate fires only
on traces. If you find ANY trace — an existing config dir, a worker
service or plist (enabled OR disabled), a note saying setup is "done" —
run the Step 2 residue gate now: surface what you found to the operator
and ask restore-vs-fresh before changing anything. One narrowing: if
the ONLY traces are provider credentials — no config dir, no worker,
no notes — there is no setup to restore; surface them, say you will
ask before reusing any of them, and proceed as a fresh install without
the restore-vs-fresh fork. This is not a one-time
pre-flight that expires after your first command: residue discovered at
ANY point in a task halts you the moment you see it, even if other state
changes have already happened. Two traps, spelled out:

- **A disabled service is a message, not a defect.** A worker plist with
  a `.disabled` suffix (or a stopped/disabled unit) was deliberately
  switched off by someone — possibly for a reason you cannot see, such as
  an incident on this machine. Never re-enable it — not as a side effect
  of an update, and not as the apparent goal of one — without surfacing
  the deliberate disable ("the sync worker on this machine was
  deliberately disabled; do you want it back on?") and getting the
  operator's consent first.
- **Green doctor output is not consent.** `olympus doctor` passing on an
  existing config proves the files are coherent, not that THIS operator
  agreed to them. Adopting residue config wholesale — because doctor is
  green, because a note says it was approved, because it "obviously
  matches" what the operator would want, or for any reason short of fresh
  operator consent — is exactly the silent restore MUST NOT #8 and #10
  forbid.

The only path that legitimately skips this gate is resuming your OWN
interrupted install: the same continuous install flow in which the
operator made the Step 2 decisions WITH YOU, interrupted by something
like a gateway restart. Merely being the same long-running session or
resident agent does not qualify, and a disabled worker you did not
disable in that flow is always the disabled-service trap, never a
resume. See "Resuming after an interruption".

## Rule one — consent is per-action, never a blanket

One "ok" authorizes exactly the action the operator was asked about —
nothing more. A yes to the posture question is not a yes to connecting
credentials, launching a background worker, or restarting the gateway.
Each of the following is its own named consent gate, asked and answered
BEFORE the action is performed, every time:

- **Posture** (Step 2) — the walkthrough and the choice.
- **Each credential** (Steps 3 and 5) — one plain-language explanation
  and one ask per credential, with any recorded caveat surfaced; never
  a batched after-the-fact "your keys are set up."
- **Worker registration** (Step 4) — the background-items
  pre-explanation runs BEFORE `olympus worker install`, and you wait
  for the operator's go; narrating past it is not consent.
- **Gateway restart** (Step 6) — its own explicit go, never queued
  silently behind earlier consent.

A "go" is an explicit, affirmative answer given in response to THIS
gate's ask. Silence, an emoji reaction, a stale "sounds good" from
earlier in the conversation, or a yes to a different question is not a
go — re-ask.

Momentum is the failure mode: a cooperative operator saying "ok" once
does not put the rest of setup on rails. Every state-changing action
needs its named gate cleared immediately before it: if you are about
to change state and have not asked — and been answered — since
clearing this action's named gate, you have already spent a consent
twice; stop and ask. Interleaving unrelated questions does not reset anything — only
clearing the named gate for THIS action does.

## Step 0 — Preflight

Check, and tell the operator what is missing with the remedy:

```bash
openclaw --version        # need 2026.7.1+  (https://openclaw.ai)
bun --version             # need 1.2+       (curl -fsSL https://bun.sh/install | bash)
node --version            # OpenClaw requires >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0
```

macOS or Linux. Do not continue until all three resolve.

The Node range is OpenClaw's, enforced by an npm `preinstall` script that exits
non-zero. On Node 23.x, or 24.0–24.14, the operator cannot install the host at
all — say so plainly, because the failure looks like an Olympus problem and is
not one.

## Step 1 — Install the plugin

**Residue check first (Rule zero):** if this machine has ANY trace of a
prior Olympus setup — including an already-installed olympus plugin the
command below would update — and you have not already cleared the residue
gate in this flow, STOP and run Rule zero before the commands below.

**Pilot install — this is the path you use.** Olympus installs from its GitHub
repository. **ASK THE OPERATOR** for the repository (`<owner>/<repo>`) if you
were not given it; do not guess one.

```bash
openclaw plugins install git:<owner>/<repo> --accept-capabilities
# ^ on OpenClaw 2026.7.1 the flag is unknown: re-run without it
openclaw plugins enable olympus
```

`--accept-capabilities` is mandatory on OpenClaw `2026.8.1+`. Your install is
non-TTY by definition, and the host offers the capability-consent prompt only
to a TTY or to this flag, so without it the command exits 1 with
`requires capability consent`. On `2026.7.1` the flag does not exist and the
host rejects it as an unknown option — drop it there. Check
`openclaw --version` (Step 0) and pick accordingly.

The clone runs with terminal prompts disabled. If the repository is private,
the operator's git credentials must already work non-interactively; a
`could not read Username for 'https://github.com'` failure is a credentials
problem on their machine, not an Olympus problem.

**The other two install sources are not the pilot path. Do not substitute
them.**

- `clawhub:olympus` — the one-line public install, **available after the
  pilot**. Until Olympus is published, `openclaw plugins search olympus`
  returns nothing and `openclaw plugins install clawhub:olympus` fails with
  `Package not found on ClawHub.`
- `npm-pack:/path/to/olympus-0.4.0.tgz` — the maintainer's release-proof
  mechanism, run during release qualification, not during a pilot install. It
  creates OpenClaw's per-plugin npm project and verifies the installed
  dependency shape, which a raw archive/path install does not. If a maintainer
  directs you to it, use `--force --accept-capabilities`, and note that npm
  packages use the standard `package/` root when reading files out of the
  archive:

```bash
mkdir olympus-package && tar -xzf /path/to/olympus-0.4.0.tgz -C olympus-package
```

Success looks like `Installed plugin: olympus`. **Do NOT restart the
gateway now, and do not restart it to "verify" the plugin loaded.** This
whole install needs exactly ONE gateway restart, and it comes at the end
(Step 6). Everything between here and there — setup, keys, the worker,
connecting sources — runs through the standalone `olympus` CLI, which does
not depend on the gateway having loaded the plugin. The agent-facing tools
(`source_answer` etc.) are the only thing that needs the restart, so it is
deferred until all config is in place. Restarting early just doubles the
disruption (and, if you are running inside this gateway, strands you — see
Step 6).

**CLI exposure (canonical — do not improvise):** the standalone CLI is
`bin/olympus` inside the installed plugin directory. Resolve that directory
dynamically (the install command prints it; `openclaw plugins list` shows
it — the git clone lands under a URL-hash directory name, so never
hardcode the path) and call the CLI by its full path for every step below,
e.g. via a shell variable you set once:

```bash
OLYMPUS_BIN="<resolved plugin dir>/bin/olympus"
"$OLYMPUS_BIN" doctor
```

Do NOT expose a bare `olympus` command on the operator's machine by ANY
mechanism — no wrapper scripts (in `~/.local/bin`, `workspace/bin`, or
anywhere else), no symlinks into directories already on PATH (like
`/usr/local/bin` or `/opt/homebrew/bin`), no shell aliases or functions,
and no edits to any shell startup file (`.zshrc`, `.zprofile`, `.zshenv`,
`.bash_profile`, `.profile`, fish config, `/etc/paths`, ...). Do NOT
claim or imply the command is globally available — not "works from
PATH", not "you can now just type olympus", not "available globally";
on a fresh machine it is not, and the false fact seeds drift in later
sessions. Honest proof wording names the path and claims nothing more:
"the `olympus` CLI is reachable at `<path>`".

Every bare `olympus ...` command in the rest of this guide is shorthand
for `"$OLYMPUS_BIN" ...` — readability, not a claim that the name
resolves on PATH. When a code block is for the OPERATOR to copy and run
themselves, write the full resolved path into the block you actually
hand them.

**Transition rule (this is where installs go wrong):** when you report the
install result, do NOT name the preset ids and do NOT ask the operator to
pick a posture in that report — "you'll need to choose: local-first,
local-only, …" is exactly the bare menu MUST NOT #1 forbids. Preset ids
appear for the first time inside the four-option walkthrough, never before
it. And never end a message with a dead-end status line; every message
hands the operator an obvious next move. End the install report like this
(adapt the words, keep the shape — short proof, then an invitation that
opens Step 2):

> Olympus is installed. Quick proof: the plugin loads, the `olympus` CLI
> runs (reachable at its plugin path — I haven't touched your PATH or
> shell setup), and I haven't restarted anything — Olympus stays dormant
> until one single gateway restart at the very end of setup, and I'll warn
> you before that happens.
>
> Next comes the part that actually matters: before Olympus touches any of
> your data, you and I make two decisions together — what counts as
> sensitive *for you*, and which models are ever allowed to see it. It's a
> short conversation, not a form. Ready?

## Step 2 — Privacy posture (MANDATORY DECISION GATE)

**Residue gate (run this check FIRST — before any setup command and, per
Rule zero, before ANY state-changing action):** a real
operator's machine is never clean. If you have ANY prior knowledge or
traces of an earlier Olympus setup — notes in your own memory or bulletin
files, an existing `~/.olympus` or `~/.config/olympus`, credential-store
items for any provider Olympus connects (venice, gemini, google and
its `gog` helper, plus any Step 5 provider — Dropbox, X, Readwise —
illustrative, not closed; probe read-only by provider/service name,
e.g. `security find-generic-password -s <ServiceName>` WITHOUT `-w`,
so a secret's value is never printed; nothing there will say
"olympus", which is exactly how a lazy check false-negatives), OAuth
grants from other tools, a
previous session's summary telling you setup is "done" — you must SURFACE what you found to
the operator and ask, before writing anything: restore the previous
setup, or start fresh? (If the only traces are provider credentials
with no Olympus config, worker, or notes, there is no setup to restore
— surface them and proceed fresh; the per-credential gates cover
reuse.) Notes left by a previous agent or session are
NEVER operator consent (MUST NOT #8). And "restore" is not a bypass: the
posture conversation, per-credential consent, and the worker
pre-explanation in Step 4 still run — restoring fills in remembered
*answers*, it does not skip the *questions*. If a credential you are
about to reuse carries a recorded caveat (for example "rotate this key
before treating it as clean"), surface the caveat and let the operator
decide; silently discarding it is a security failure. The gates named
here are examples, not an exhaustive list: EVERY decision gate in Steps
2–6 — the tier explainer, the sensitivity dialogue, the posture choice,
per-credential consent, the worker pre-explanation — runs on the restore
path exactly as on a fresh one. Pre-filled, though: on restore each
gate is a confirm-or-change of the remembered answer — not a
from-scratch re-interview. And this gate is not scoped to Step 2:
per Rule zero, it runs before EVERY state-changing action of ANY
install, update, or maintenance request on a machine with traces —
reaching Step 2 is not what arms it.

This is the one decision that matters and it belongs to the operator. You
must NOT silently accept a default — and you must NOT present the presets
as a bare list of names. A new operator has no idea what a preset id means.
**The walkthrough below is part of the gate**: explain, in plain language,
what each posture means for THEIR data, what it requires, and its trade-off
— then ask. Adapt this script; do not compress it to a menu.

Open with the privacy model. The point of each tier is what happens
*differently* to data in it — never present a tier as a bare list of
category examples. This message both explains the model and opens the
sensitivity conversation:

> Here's how Olympus treats your data — then you'll tell me about your
> preferences.
>
> Olympus sorts everything it indexes into four tiers:
>
> **Public** — things that are public or meant to be: your published
> writing, posts, public links. Any model can work with these.
>
> **Private** — ordinary personal and work life: schedules, newsletters,
> routine email, most projects. Your assistant's regular models can reason
> over this — the same models you'd paste it into today.
>
> **Secure** — the things you'd only tell someone you trust: health, money,
> legal matters, therapy, your family. This tier is the reason Olympus
> exists. It never goes to ordinary cloud models, full stop. What *can*
> happen with it is the one big choice you'll make in a few minutes:
> answered on your own machine, answered by an end-to-end-encrypted private
> cloud, or kept out of Olympus entirely.
>
> **Secrets** — passwords, API keys, recovery codes. No model ever sees
> these, in any lane. Olympus will only ever tell you *where* a secret
> lives, never what it says.
>
> Two rules are hard-wired and not up for configuration: secure data never
> touches ordinary cloud models, and when Olympus isn't allowed to answer
> something, it tells you so instead of quietly downgrading your privacy to
> get an answer.
>
> The tiers are fixed, but what goes *in* them is personal — one person's
> "eh, whatever" is another person's secure. So tell me about your data:
> what do you want your assistant to know about, and what are you
> protective of? Talk normally — I'll turn what you say into your personal
> sensitivity map and read it back to you before anything gets saved.

Iterate on that conversation, voice-friendly, until the operator confirms.
Help the operator untangle two different questions:

- where data is stored today
- which models may read or reason over it through Olympus

Use this example if helpful: Gmail already lives on Google's servers. The
Olympus question is not "does Google store this email?" The question is
"may models reason over the therapy thread inside Gmail, and if so only in
which lane?"

Reflect back a proposed map before writing anything — in sentences, in
the operator's own words, never as a `tier: item, item, item` cram-list:

> Here's what I heard. Your blog and anything you've published stays
> public. Day-to-day email, calendars, and work projects are private —
> your regular assistant keeps working with those like it does now.
> Anything about your health, your finances, and your kids gets the
> secure treatment we just talked about. And passwords or keys — no model
> ever sees those. Did I get that right, and is there anything you'd move?

Keep revising until the operator says yes. Default categories to **secure**
unless the operator explicitly says **secrets**. Then write
`~/.olympus/sensitivity-map.json` using schemaVersion 1:

```json
{
  "schemaVersion": 1,
  "userFacingTiers": {
    "public": { "targetTrustTier": "S0", "targetTrustDomain": "public_safe" },
    "private": { "targetTrustTier": "S3", "targetTrustDomain": "internal" },
    "secure": { "targetTrustTier": "S4", "targetTrustDomain": "secure_local" },
    "secrets": { "targetTrustTier": "S5", "targetTrustDomain": "secure_local" }
  },
  "categories": [
    {
      "id": "therapy",
      "label": "Therapy",
      "targetTierName": "secure",
      "targetTrustTier": "S4",
      "targetTrustDomain": "secure_local",
      "examples": ["therapy emails", "session notes"],
      "notes": "Operator confirmed therapy material should stay secure.",
      "match": {
        "keywords": ["therapy", "therapist"],
        "senderPatterns": [],
        "pathPatterns": []
      }
    }
  ]
}
```

For this phase, do not write public/private categories into the map: Olympus
uses it only as raise-only guidance. It may raise matching items to secure or
secrets, never downgrade them. Validate it before continuing:

```bash
olympus sensitivity validate
```

Only after the map validates, ask the posture question. **Do not lead
with a recommendation.** A recommendation must come from the operator's
own answer, so first ask:

> Do you run local AI models on this machine — or want to set that up?

This moment — not earlier — is when local models enter the conversation.
Do not mention machine checks, detected runtimes, or postures during the
tier explainer or the sensitivity conversation; an unprompted "I checked
this machine for Ollama" lands as a non sequitur. If you detected a local
runtime (a llama.cpp plugin, an Ollama service, an MLX install), it is a
conversational observation to verify aloud HERE — "I noticed this machine
has llama.cpp set up; do you actually use local models?" — never a silent
basis for recommending a posture. Use their answer to mark which option
below is recommended for them, then present all four.

The operator has likely never heard of Venice, so introduce it once,
before the options name it:

> Two of these options use Venice (venice.ai) — a privacy-focused AI
> cloud. Its end-to-end-encrypted models are the point: your questions
> and answers are encrypted so that even Venice can't read them.
>
> How do you want to handle your secure data?
>
> 1. **Local models and private cloud** (`local-first`) — recommended if
>    you run local models. Secure questions are answered on your own
>    machine first; Venice is the approved second step when the local lane
>    cannot answer. Requires: a local runtime with lots of fast memory —
>    MLX, llama.cpp, Ollama, LM Studio and similar expose the local endpoint
>    Olympus uses — plus a Venice API key (pay-as-you-go) and a Gemini API
>    key (free tier available) for search indexing. Trade-off: strongest
>    owner-controlled first step, with encrypted-cloud escalation available;
>    speed and first-pass quality depend on your machine.
>
> 2. **Local models only** (`local-only`) — secure questions are answered
>    only on your own machine. Venice is not used. Requires: the same local
>    runtime with lots of fast memory, plus a Gemini API key (free tier
>    available) for search indexing. Trade-off: no sensitive-tier cloud
>    escalation; if the local lane cannot answer, Olympus reports the gap.
>
> 3. **Private cloud only** (`private-cloud-only`) — recommended if you do
>    not run local models. Secure content goes only to Venice using its
>    end-to-end-encrypted model path, currently e2ee GLM 5.2. Requires: a
>    Venice API key (pay-as-you-go) and a Gemini API key (free tier
>    available) for search indexing. Trade-off: no local-model requirement
>    or local fallback; you are choosing Venice's encrypted-cloud lane for
>    secure answers.
>
> 4. **Do not add secure data to Olympus** (`no-sensitive`) — Olympus
>    keeps its hands off secure data entirely: it is not imported, not
>    indexed, and no model — local, encrypted cloud, or ordinary cloud —
>    sees it. When a question touches health, finances, or legal matters,
>    you get an honest "that's not indexed" instead of an answer. Requires:
>    a Gemini API key (free tier available) for everyday source indexing.
>    Trade-off: a real hole in what your assistant can do, in exchange for
>    maximum caution.
>
> You can change this later — it's a config file, not a commitment
> (`olympus sovereignty init --preset <name>`).

**Lead with the recommendation (adaptive ordering).** The numbered order
above is the neutral default. The moment the operator has told you
something that makes one posture the clear fit — "I can't run local
models" makes it `private-cloud-only`; "nothing sensitive ever leaves this
machine" makes it `local-only` — put THAT option first, opening with why
it is recommended for them, in one sentence, in their own terms. Then
present the remaining options beneath it, framed as alternatives: "here
are the others, in case one fits better or you change your mind later."
Never leave the recommended option buried mid-list with only a
"recommended" tag — the shape of the list is part of the guidance.

Ask which posture fits how they feel about their most private data, answer
their questions, and only then record the choice and run:

```bash
olympus setup --preset <chosen-preset> --cloud-lane subscription --yes
```

## Step 3 — Prerequisites and secrets

**Code-block contract:** a code block in your message means exactly one
thing to the operator — "copy this and run it yourself." Show one only
when that is what you want, and show only that block. Commands YOU will
run (like the stdin connect below) are described in a sentence ("I'll
connect the key so it never touches logs"), never displayed as a copyable
block. Two code blocks where one is the operator's and one is yours is a
guaranteed source of confusion.

Each credential here is its own Rule one gate: explain it in one plain
sentence, ask, connect, then move to the next — never sweep the list and
report "your keys are set up" after the fact.

**Credential sourcing (password-manager-aware).** Before sending the
operator to a website to copy a key — or asking them to paste anything —
ask where they keep secrets, or note what this machine already offers
(the macOS Keychain via `security`, 1Password's `op`, Bitwarden's `bw`,
`pass`). If the credential already lives in their manager, offer to
fetch it yourself via that manager's CLI and pipe it into the stdin
connect flow. Pasting into the dashboard field is an equally private,
operator-run path — fetching just spares them the copy step, so offer,
never steer. Knowing WHERE they keep secrets is not consent to fetch
anything: the manager is the SOURCE of the credential, never the
consent, and the Rule one per-credential gate runs unchanged — explain,
ask, and only then fetch and connect, one credential at a time. Hard
limits:

- The operator supplies the exact item name or reference; if you do not
  have it, ask. Fetch ONLY that named item, after their yes. Never
  enumerate, list, search, or dump a vault's contents — not even to
  "see what's available" — and never probe candidate names until one
  resolves: serial named reads to discover what exists ARE enumeration.
  (This bans content discovery in the operator's vaults; it does not
  touch the Rule zero / Step 2 residue probe, which is a value-less
  presence check of specific provider service names and stays
  required.)
- A fetch reads the value — for the Keychain that means
  `security find-generic-password … -w` — and the value goes STRAIGHT
  into the documented stdin connect flow, never to a terminal, log,
  file, or chat (MUST NOT #2). Do not type or inject a fetched value
  into any UI field yourself, browser control included: dashboard
  fields are for the operator's hands; your only path is stdin. (The
  consented `-w` fetch is distinct from the `-w`-omitted residue probe,
  which never reads values.)
- Caveats: anything you already hold about the credential (a memory
  note, a prior session's "rotate before reuse") is surfaced BEFORE
  the fetch. If the fetched item itself carries a caveat in its notes,
  surface it and re-confirm before connecting — the note is not the
  secret, but the value still never appears in chat.
- "The manager" here means the operator's personal password manager,
  not Olympus's own encrypted secret store — the worker's normal
  secretRef resolution at boot is the product working as designed.
  1Password service accounts have a small DAILY read quota shared by
  everything on the machine: fetch once per credential, and never put
  an `op read` (or any manager read) inside anything that retries or
  restarts; the worker env is written once at setup and workers must
  not re-read the manager at runtime.
- If the operator prefers to paste, that is their call: the dashboard
  field and stdin flow remain the paste paths, and secrets never go
  through chat.

Setup prints `unmet_prerequisites` with an exact remedy per item. Follow
them. Typical items:

- `GEMINI_API_KEY` (source embeddings, all presets): **ASK THE OPERATOR**
  to obtain a key from https://aistudio.google.com and provide it (or
  source it per the credential-sourcing rule above). Put it in the
  worker's env file — the one `olympus worker install` writes and
  manages; the worker reads `OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY` or
  `GEMINI_API_KEY` from it — never into a chat log or a world-readable
  file.
- Venice API key (`local-first` or `private-cloud-only`): the operator creates one at
  https://venice.ai, then you connect it via stdin so it never appears in
  shell history or logs (you run this; do not show it as a copy block):

```bash
printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
```

Re-run `olympus doctor` until the `sovereignty_prerequisites` check is
green (or explained and accepted by the operator).

**Translate doctor output; never leak lane jargon.** "Argus" is Olympus's
internal name for the analyst that serves the secure tier (local models
or Venice, per the posture) — operators have never heard it. If the
operator's posture has no local lane, say nothing about Argus, local
models, or local endpoints: a "note about local models" to someone who
just said they don't use local models reads as an error. Mention local
lanes only for `local-first`/`local-only` postures, in plain words
("your local model isn't reachable yet").

## Step 4 — Start the worker

**Residue check first (Rule zero):** a worker service or plist already on
this machine — ESPECIALLY one that is disabled — means you stop and run
Rule zero's gate before installing, enabling, re-enabling, or restarting
anything here.

```bash
olympus worker install
olympus worker status
```

Use only the public worker lifecycle: `install`, `start`, `stop`, `restart`,
`status`, `foreground`, `upgrade`, and `uninstall`. Install and upgrade are
idempotent and recover interrupted managed-file transactions when rerun. Do not
pass secrets, environment paths, or executable overrides on the command line,
and do not edit generated service units or `worker.env` directly. Credential,
scope, pairing, Disconnect, partial-sync, and missing source-dependency repair
normally uses the source-specific recovery action without restarting the
worker. `worker uninstall` retains user data; `data delete` is the separate
destructive boundary.

`worker install` registers the background service (launchd/systemd) with
restart-on-failure. If the operator prefers a foreground trial first, use
`olympus worker foreground` in a terminal they control.

**The pre-explanation below is a consent gate (Rule one), not a courtesy
heads-up: give it BEFORE you run `worker install`, and wait for the
operator's go.** A posture "ok" back in Step 2 did not authorize a
background service. On macOS the system announces new background items
("Background Items Added: … can run in the background"), and an
unexplained notification on their own machine reads as something being
done TO them. One sentence first, in this shape (adapt the words), then
their yes, then the command:

> Next I'm registering the sync worker — a background service on this
> machine that keeps your sources indexed. macOS will show a "background
> items added" notification when I do; that's this, nothing else. You can
> see or remove it anytime under System Settings → General → Login Items,
> or with `olympus worker uninstall`.

## Step 5 — Connect sources

Open the dashboard and make it the operator-facing connect surface:

```bash
olympus dashboard
```

Say: "I've opened your Olympus dashboard. Click Connect on the sources you
want; I'll watch status and help with any one-time setup."

Ask which sources they want now, but do not bulk-connect anything yourself.
Sources can be started in any order from the dashboard, and OAuth sources can
be in flight in parallel. Your job is to narrate, run one-time setup when a
card asks for it, and diagnose failures by watching `olympus connect status`
and `olympus doctor`. Keep `olympus dashboard` open as the operator-facing
progress view.

Connect-conversation rules:

- MUST explain the credential in one plain sentence before asking for it. For
  normal Google setup: "Olympus includes its public Google app identity; click
  Connect, then Google shows the exact read access you are granting."
- MUST walk a non-technical operator through the provider page step by step.
  For normal Google setup, narrate only sign-in, the unverified-app warning,
  and consent. Do not send them to Google Cloud Console.
- MUST have the operator enter secrets only in the dashboard field, or use the
  documented CLI stdin flow when the dashboard is unavailable. The Step 3
  credential-sourcing rule applies to every source credential here too:
  manager fetch is allowed (named item only, per-credential consent
  unchanged), enumeration never.
- MUST NOT show internal config keys such as
  `gmail.personal.oauth.client_secret` as the task or remedy.
- MUST NOT invent keychain, `security add-generic-password`, 1Password, or
  other storage commands for source-connect credentials. (This bans
  WRITING credentials outside the dashboard/stdin flows; the residue
  check's value-less presence probes and the Step 3 credential-sourcing
  fetch-read that pipes an existing value into stdin are different
  things — both permitted.)
- MUST NOT ask the operator to paste OAuth client secrets, API tokens, or
  pairing codes into chat. The Step 3 code-block contract still applies:
  operator-run commands go in code blocks only when the operator must copy and
  run that exact command.

Dashboard card meanings:

- **Connect** — the dashboard can start the flow. The operator clicks Connect,
  finishes provider consent or enters the API token locally, and the card
  updates after the next poll.
- **Awaiting browser consent** — the provider tab is open or waiting. Let the
  operator finish consent; do not restart the flow unless it expires or fails.
- **Needs setup** — the source needs a one-time OAuth client before the
  dashboard can connect. Help the operator create that client, register any
  redirect URI shown on the card, then they paste the requested values into the
  dashboard card and click Connect.
- **Reauth required** — the source has a handle, but the session or refresh
  credential needs attention. Use the card guidance first, then `olympus
  connect status` and doctor output to diagnose.

### Google / Gmail / Drive

Normal Google setup is one click: the packaged publisher-owned Desktop client
ID is already present. The operator clicks **Connect**, signs in to Google, and
approves the source-specific read scope. Google may show the documented
unverified-app warning during the small pilot; explain it plainly and let the
operator decide whether to continue.

If Gmail or Drive says **Needs setup** on a packaged install, treat that as a
broken or unqualified artifact and run `olympus doctor`; do not send the
operator to Google Cloud Console. Creating a personal Google client is an
advanced BYO fallback only when the operator explicitly chooses it.

**Helper-binary rule (hard-learned):** never install or upgrade a
credential-helper binary (`gogcli`, keychain-touching CLIs, or similar)
mid-onboarding. Upgrading a binary invalidates its macOS Keychain ACLs —
"Always Allow" does not persist for ad-hoc-signed binaries — so the
upgrade converts every later background credential read into a password
modal on the operator's screen. Use whatever version is already present;
if an upgrade is genuinely required, defer it to after setup completes,
tell the operator why, and do it while nothing is retrying in the
background. Corollary: never send the operator to approve a Keychain
dialog while any background process (the worker, a drain, a retry loop)
might be reading the Keychain — stop it first, let them approve in
calm, then start it again.

### Advanced Google BYO fallback

Use this only when the operator explicitly chooses BYO. A Google Desktop
client ID is public application identity and can be entered locally. Olympus
uses S256 PKCE; Google documents `client_secret` as optional for installed-app
authorization-code exchange and refresh, so the BYO path does not ask for or
store one.

Choose the Console mode based on capability detection:

- If browser control works, open Google Cloud Console, help the operator create
  or select an Olympus project, and drive the operator's browser through the
  API, consent, and client pages while narrating what you are doing. Use their
  signed-in Google account; do not ask for passwords.
- If browser control is flaky or unavailable, use the manual fallback below.
  It must stand alone; do not hand-wave the Console pages.

Manual fallback, consent screen page:

1. Open <https://console.cloud.google.com/auth/overview>, select the operator's
   Olympus project, and open the branding/audience setup.
2. Choose **External**.
3. Set app name to **Olympus**.
4. Set support email to the operator's email.
5. Save through the required steps.
6. Go to audience/publishing and **publish to production**. Testing mode breaks
   sync after 7 days because Google expires refresh tokens for testing apps.

Manual fallback, OAuth client page:

1. Open <https://console.cloud.google.com/auth/clients>, select the same
   project, and choose **Create client**.
2. Choose application type **Desktop app**.
3. Name it **Olympus**.
4. Click **Create**.
5. Enable the Gmail API and Google Drive API for the same project:
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com> and
   <https://console.cloud.google.com/apis/library/drive.googleapis.com>. Sync
   returns Google 403 errors until these APIs are enabled.
6. Copy the Client ID into the dashboard form. Do not copy or request the
   client secret.

When the client ID is ready, have the operator paste it into the advanced BYO
dashboard card and click Connect. Google desktop
clients use loopback redirects with random ports, so there is no fixed redirect
URI to register. If Google shows an unverified-app interstitial, explain which
OAuth app is being used and let the operator choose whether to continue. Watch
the dashboard and `olympus connect status`; `connected`
means the handle was stored, `pending` means the browser consent is not
finished, and `failed` or `expired` means start that card again after
explaining the failure.

Never run foreground Google connect from a chat agent. The old foreground flow
keeps the loopback listener in the agent's command process. OpenClaw chat
agents have turn-scoped command execution, so that process is killed when you
end the turn to let the operator finish browser consent. Dashboard-owned OAuth
is safe because the worker is long-lived. The detached CLI flow remains the
headless fallback when the dashboard cannot be opened: run `olympus connect
google --client-id <client-id> --detach` yourself, use
`gmail` or `google-drive` instead of `google` for source-specific consent, give
or open the returned `authorizationUrl`, then poll `olympus connect status
google`.
For detached status, `connected` means the handle was stored, `pending` means
browser consent is not finished, `failed` or `expired` means rerun detached
connect, and `died` means rerun detached connect and inspect the log path in
the status output.

### Other Sources

Dropbox and X also use OAuth. When their cards say **Needs setup**, help the
operator create and own the provider app/client on the provider's developer
site. These providers require an exact redirect URI match; register the exact
`http://127.0.0.1:<port>/oauth/callback/<source>` URI shown on the dashboard
card. Dropbox uses PKCE without a secret. The current supported X fallback is
a user-owned confidential app: the operator enters its client ID and secret
locally, and Olympus uses HTTP Basic for token exchange without exposing the
secret to chat. Do not promise client-ID-only X setup until Olympus's exact
refresh/rotation/restart path is qualified.

Use the detached `--detach` CLI flow only when the dashboard is unavailable.
For Dropbox detached CLI setup, pin a port and register that exact loopback
callback with the provider before starting consent:

```bash
olympus connect dropbox --client-id <client-id> --redirect-port <port> --detach
```

Use the dashboard for the supported X confidential-client flow; the current
detached CLI exposes only the unqualified public-client shape.

Readwise uses an API-token form in the dashboard. The operator enters the token
locally; never ask them to paste the raw token into chat. Venice still uses the
approved API-key secret-entry path for the current environment when needed for
the selected posture.

Telegram/WhatsApp need local pairing helpers. If the dashboard card says to
pair via your agent, use the existing helper for that source. Omit
`--session-ready` until the operator has actually paired the session; Olympus
records the handle as `reauth_required` until then.

**QR delivery (WhatsApp): render the QR as a local PNG image file and show
that image to the operator.** Do not paste terminal QR blocks or ASCII art
into chat — they break across chat surfaces and were the two failed attempts
in the 2026-07-08 live rehearsal; the local PNG was the method that worked.
If the first PNG render does not scan, regenerate once (QR payloads rotate
quickly; a stale payload is the usual cause) before suspecting the bridge.

Rules:
- Keep `olympus dashboard` open as the operator-facing progress view.
- Run only the command for the source currently being connected.
- A dashboard Connect click authorizes only that source. Before YOU run
  any `--detach` connect yourself, ask for that specific source — every
  source, its own ask (Rule one).
- Treat dashboard Connect clicks as the primary path; use CLI `--detach` only
  as the headless fallback.

## Step 6 — Validate, then restart the gateway (in this order)

**Residue check first (Rule zero):** never run this restart to activate a
configuration the operator has not consented to in this flow; on a
machine with prior-setup traces the gate must already have been cleared.

**The restart is its own consent gate (Rule one):** it gets its own
explicit go from the operator, every time — never queued silently behind
earlier yeses, and never bundled into "finishing up."

**If you are an agent running INSIDE this OpenClaw gateway** (an OpenClaw
chat agent rather than an external CLI agent): restarting the gateway
ends your own session mid-turn. Before running the restart, tell the
operator exactly this — "the next command restarts the gateway and this
chat will drop; when it's back, message me: *continue the Olympus install
from Step 7*" — or hand the operator the three commands below to run in
their own terminal. The same applies to any gateway restart during
Step 1's plugin install.

Never restart the gateway without a green validate:

```bash
openclaw config validate
openclaw doctor --lint
openclaw gateway restart
```

This loads the agent tools: `source_answer`, `source_index_status`,
`source_index_search`.

For a Hermes Agent install, use the package's narrower MCP-only lane:

```bash
openclaw plugins inspect olympus --json
hermes mcp add olympus --command /absolute/managed/olympus/bin/olympus --args serve
hermes mcp test olympus
```

Take `plugin.rootDir` from the inspect response and append `/bin/olympus`; do
not guess OpenClaw's managed storage path and do not assume a global `olympus`
command exists.

Configure the `olympus` server with
`tools: { include: [source_answer, source_index_status] }` (the packaged
`config/hermes/olympus.mcp.yaml` shows the complete YAML), reload MCP, and
verify the only discovered names are `mcp_olympus_source_answer` and
`mcp_olympus_source_index_status`. Exercise a cited answer through the
discovered `mcp_olympus_source_answer`. Do not enable
`source_index_search`, `source_watch_*`, prompts, or resources for v0.4 Hermes.

The optional `integrations/hermes/ask-sources` adaptation may be copied to
`~/.hermes/skills/ask-sources` or loaded through `skills.external_dirs`. No
`hermes://mcp/install` link is published because current Hermes documentation
does not define that handler, and no external catalog submission is authorized.

## Step 7 — Verify end to end

```bash
olympus doctor                                   # every check green or explained
olympus source answer "what's in my sources so far?"
```

Confirm in the answer's audit block that `analyst_backend` matches the
chosen posture (e.g. `venice` for private-cloud-only secure answers, `local`
for local-only secure answers).

Degraded credential lanes are a silent failure you must rule out
explicitly — a worker with a dead embedding credential still syncs and
still answers, while indexing nothing searchable (this was a real
incident). Three checks: `olympus doctor` must not fail
`worker_credential_lanes` (if it does: fix the named credential, then
POST the bearer-only `/v1/source/credentials/recheck` route; restart
the worker only if it reports `resolved_restart_required`);
`olympus worker status` must show the worker reachable with no
`degraded_credentials`; and the first answer's audit block must not
report semantic search skipped for `embedding_provider_unavailable`.
The dashboard shows a credential alert for the same condition — it
should be absent. Then show the operator `olympus dashboard` — a local, token-protected view of source
freshness and where public, private, secure, and secrets are allowed to go.

Report to the operator: what was installed, the chosen posture, which
sources are connected, which prerequisites remain open, and the doctor
summary. The install is done only when doctor is green or every non-green
check has been explicitly accepted by the operator.

## Resuming after an interruption

This section is for resuming YOUR OWN interrupted install — the same
continuous install flow in which the operator already made the Step 2
decisions with you, interrupted by something like a gateway restart. A
long-lived session or resident agent does not stretch this: if the
decisions were not made with you in THIS flow — however you arrived,
install, update, or maintenance request — that is the residue gate (Rule
zero: surface and ask restore-vs-fresh before any state-changing
action), not a resume. "Skip every step whose outcome already exists"
below applies only to outcomes your operator consented to in this flow;
it never covers adopting another setup's outcomes.

If your session was interrupted (a gateway restart will do this to
resident agents), do NOT replay steps from the top. First observe, then
continue: `openclaw plugins list` (is olympus installed/enabled?),
`ls ~/.olympus/sovereignty.json` (did setup already write the policy?),
`olympus doctor` (what remains unmet?). Skip every step whose outcome
already exists. In particular, never re-run `olympus setup` or
`olympus sovereignty init` when the config file exists — the CLI refuses
without `--force`, and `--force` requires the operator's explicit consent
(MUST NOT #6). A refusal like "config already exists" during resume means
the step is DONE, not broken.

## If something fails

1. `olympus doctor` first — every failure it knows carries a fix-it hint.
2. Report the exact failing command and output to the operator; do not
   retry commands that change state without the operator's explicit
   consent — telling them is not asking. On a machine with prior-setup
   traces, Rule zero binds repairs run from here too.
3. `openclaw gateway stability --bundle latest` explains a failed gateway
   boot; `openclaw doctor --fix` restores last-known-good config.

## What you must NOT do

1. **Never choose the privacy posture yourself — and never present it as
   a bare menu of preset names.** The plain-language walkthrough in Step 2
   is part of the gate; the operator decides only after hearing what each
   posture means for their data.
2. **Never echo, log, or store secrets in plain text.** Keys go through
   stdin connect flows or the worker environment; Olympus keeps them in an
   encrypted local secret store.
3. **Never restart the gateway without a green `openclaw config validate`.**
4. **Never edit `openclaw.json` by hand** — use `openclaw config set` or
   the documented connect/setup commands only.
5. **Never run `olympus data delete`, overwrite an existing
   `~/.olympus/sovereignty.json`, or `--force` reinstall** without the
   operator's explicit, informed consent.
6. **Never restart the gateway you are running inside without warning the
   operator first** and giving them the exact message that resumes you
   ("continue the Olympus install from Step N"). A silent self-restart
   strands the operator mid-install.
7. **Never treat notes left by a previous agent or session as operator
   consent.** A bulletin entry, memory file, or prior-session summary
   saying setup is "done" or "do not rerun setup" triggers the Step 2
   residue gate (surface and ask restore-vs-fresh); it never authorizes
   restoring a posture, reusing a credential, or skipping a decision
   gate on its own.
8. **Never expose a bare `olympus` command or claim it is globally
   available.** No wrappers, symlinks, aliases, functions, or shell
   startup-file edits, by any mechanism (Step 1); call the CLI by its
   resolved plugin path, and report it as "reachable at `<path>`" —
   never as on the operator's PATH.
9. **Never treat an update, repair, or maintenance action as a bypass
    around the decision gates — however the request was framed** (Olympus
    named or not, one plugin or a bulk sweep, an install command or an
    unrelated-sounding symptom fix). On a machine with any trace of a
    prior Olympus setup, the residue gate (Rule zero) runs BEFORE any
    state-changing action that touches Olympus — explicitly including
    re-enabling a disabled worker (a `.disabled` plist or disabled unit
    is someone's deliberate signal; re-arming it needs the operator's
    consent) and adopting an existing `~/.olympus` config without fresh
    operator consent, whatever your reason — doctor's green status
    included.
10. **Never spend one consent on several actions.** A "yes" covers only
    the action it was asked about (Rule one). The worker pre-explanation
    with its own go and the gateway restart with its own go are
    mandatory even when the operator has been agreeing to everything.
    The signature of this failure is a state-changing action whose
    named gate was not cleared immediately before it — and interleaved
    unrelated questions do not count as clearing it.
