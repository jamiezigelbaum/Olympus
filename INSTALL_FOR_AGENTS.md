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
# config
ls -la ~/.olympus ~/.config/olympus 2>/dev/null
# data, worker state, caches, and connector stores — the dirs setup never names
ls -la ~/.local/share/olympus ~/.local/state/olympus ~/.cache/olympus \
       ~/.local/share/openclaw/olympus 2>/dev/null
ls -la ~/Library/Logs/Olympus 2>/dev/null   # macOS worker logs
# Linux worker logs live under ~/.local/state/olympus/worker (listed above)
openclaw plugins list | grep -i olympus   # olympus already installed?
# The bare list is a ~200-line table on a populated machine and buries the
# answer. If you prefer a yes/no, `openclaw plugins inspect olympus --json`
# fails with a not-found error when nothing is installed — that error IS the
# clean-machine answer, not a problem to debug.
ls ~/Library/LaunchAgents 2>/dev/null | grep -i olympus   # macOS
# Linux: systemctl --user list-unit-files | grep -i olympus
```

The data and state directories are not padding on that list. A leftover
paired messaging session inside them — a `whatsapp` directory or a
`telegram.session` file under `~/.local/share/olympus` — gets adopted by
a later connect, and the source then reports **connected** although this
operator paired nothing in this flow. A residue check that stops at
`~/.olympus` and the LaunchAgents dir misses it and you will report a
connection the operator never made.

…plus a look through your own memory/bulletin files and any prior
session's summary for Olympus notes, and — on macOS — per-provider
Keychain probes for the providers Olympus connects (venice, gemini,
google and its `gog` helper, plus any Step 5 provider — Dropbox, X,
Readwise — the list is illustrative, not closed), as presence checks
only (never dump or print a secret's value — MUST NOT #2): a
credential named for a provider is residue to surface even though
nothing about it says "olympus". A clean machine is one where EVERY one
of those comes back empty — no config dir, no data, state, cache,
connector-store or log dir, no plugin in the list, no launchd/systemd
item, no provider credential, no note — and then you proceed with no extra
ceremony; the gate fires only on traces. If you find ANY trace — an
existing config dir, a data or state dir with anything in it (a paired
session especially), a worker
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
  operator consent — is exactly the silent restore MUST NOT #7 and #9
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
- **Worker registration** (Step 2, before `olympus setup`) — the
  background-items pre-explanation runs BEFORE the command that
  registers the service, and you wait for the operator's go; narrating
  past it is not consent. `olympus setup` is that command: it installs
  the launchd/systemd item itself, so this gate is cleared alongside the
  posture gate and before setup runs, not later in Step 4.
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

**`bun: command not found` usually means your PATH, not a missing Bun.**
Bun's installer puts the binary in `~/.bun/bin` and adds it to PATH from
the operator's shell rc — which a non-interactive agent shell does not
read. So before you conclude anything is missing, check the install
location directly:

```bash
~/.bun/bin/bun --version
```

If that prints a version, Bun is installed and nothing needs installing.
Prepend it to PATH **for your session only** and continue:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Do NOT re-run the Bun installer and do NOT edit any shell startup file to
fix this — editing `.zshrc`/`.zprofile`/`.bash_profile` and friends is
forbidden (Step 1, MUST NOT #8), and a reinstall over a working Bun is a
state change the operator did not ask for. Only if `~/.bun/bin/bun` is
genuinely absent do you report Bun as missing, with the install command
as the operator's to run.

This matters past Step 0: `bin/olympus` is a Bun script, so every
`"$OLYMPUS_BIN" …` call in this guide needs `bun` on PATH in the shell
that runs it. Export it once per session, in the same shell.

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
openclaw plugins install git:<owner>/<repo> --accept-capabilities --force
# ^ on OpenClaw 2026.7.1: --accept-capabilities does not exist, and --force
#   there means only "overwrite an existing plugin" — re-run with no flags
openclaw plugins enable olympus
```

Two host flags, two different consents — check `openclaw --version`
(Step 0) and pick accordingly:

- **`--accept-capabilities`** is mandatory on OpenClaw `2026.8.1+`. Your
  install is non-TTY by definition, and the host offers the
  capability-consent prompt only to a TTY or to this flag, so without it
  the command exits 1 with `requires capability consent`.
- **`--force`** is mandatory on `2026.8.1+` (confirmed on `2026.9.1`) for
  ANY non-ClawHub source, which a `git:` install is. Without it the host
  refuses non-interactively with `Install cancelled; rerun with --force
  after reviewing the source.` On these versions `--force` carries two
  meanings at once: "yes, I have reviewed this non-ClawHub source" and
  "yes, overwrite an existing plugin".

**On `2026.7.1` the two flags are not symmetrical.**
`--accept-capabilities` does not exist there — the host rejects it as an
unknown option, so drop it and re-run without it. `--force` DOES exist on
`2026.7.1`, but it carries only its original meaning, "overwrite an
existing plugin"; the source-trust confirmation is not a thing on that
version, so a clean-machine install needs neither flag, and passing
`--force` there is a reinstall gated by MUST NOT #5.

**What `--force` does and does not authorize here.** On `2026.8.1+`, on a
machine with no olympus plugin installed, the flag is doing only the
source-trust half:
it confirms you reviewed the git source you were told to install. That is
not the "`--force` reinstall" MUST NOT #5 gates, and you do not need a
separate operator consent for it — but say what you are doing in your
install report ("the host requires `--force` to accept a non-ClawHub
source; nothing is being overwritten").

If Rule zero's checks found olympus already installed, the second meaning
is live: the same command would overwrite that plugin. Then MUST NOT #5
binds in full — stop, surface the existing install, and get the
operator's explicit consent to overwrite before you run anything.

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
gateway YOURSELF now, and do not restart it to "verify" the plugin
loaded.** You still owe exactly one DELIBERATE restart and it comes at the
end (Step 6).

**Be honest about what the install itself already did.** On OpenClaw
`2026.9.1` installing a plugin can make the gateway reload its plugin set
on its own, and its boot line can list `olympus` among the loaded plugins
long before Step 6. So do not tell the operator Olympus "stays dormant
until one restart at the very end" — it is not true on this version, and
they can read the log. What IS true, and is the part that matters to them:
Olympus is registered but has no posture, no credentials and no sources
yet, so it reads nothing and sends nothing. It stays inert until the
operator connects a source in Step 5.

Step 6's restart is still required, and not as ceremony: it is what makes
the gateway load the plugin against the FINAL config — the posture, worker
and credentials setup writes — so the agent-facing tools (`source_answer`
etc.) come up against the configuration the operator actually approved. An
early restart of your own just doubles the disruption (and, if you are
running inside this gateway, strands you — see Step 6). Everything between
here and there — setup, keys, the worker, connecting sources — runs
through the standalone `olympus` CLI, which does not depend on the gateway
having loaded the plugin.

**CLI exposure (canonical — do not improvise):** the standalone CLI is
`bin/olympus` inside the installed plugin directory. The git clone lands
under a URL-hash directory name, so never hardcode the path. Resolve it
from `openclaw plugins inspect olympus --json` → `plugin.rootDir`, which
is the one command that reports the directory in full:

```bash
OLYMPUS_ROOT="$(openclaw plugins inspect olympus --json | jq -r .plugin.rootDir)"
OLYMPUS_BIN="$OLYMPUS_ROOT/bin/olympus"
"$OLYMPUS_BIN" doctor
```

Do not try to read the path off the other two surfaces. On `2026.9.1` the
install command prints only `Installed plugin: olympus` — no directory —
and `openclaw plugins list` renders a table that truncates the path to fit
the column. Both look like they answered you; neither did. If `jq` is not
available, parse the same `--json` output some other way, but keep
`plugins inspect` as the source.

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

> Olympus is installed. Quick proof: the plugin loads, and the `olympus`
> CLI runs (reachable at its plugin path — I haven't touched your PATH or
> shell setup). I haven't restarted anything myself; OpenClaw may have
> reloaded on its own to pick the plugin up, so you might already see
> olympus in its log. That only registers it — it has no posture, no keys
> and no sources yet, so it isn't reading anything of yours and won't
> until we connect a source together. There's one deliberate gateway
> restart at the end of setup, and I'll warn you before it happens.
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
NEVER operator consent (MUST NOT #7). And "restore" is not a bypass: the
posture conversation, per-credential consent, and the worker
pre-explanation before setup still run — restoring fills in remembered
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
> answered on your own machine, answered by a privacy-focused private
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
unless the operator explicitly says **secrets**. The map is written before
`olympus setup` runs, so its directory does not exist yet on a fresh
machine — create it first, or the write fails with `ENOENT`. Create it
**owner-only**: this directory holds the operator's sensitivity map, and a
default umask would leave it world-readable.

```bash
mkdir -p ~/.olympus && chmod 700 ~/.olympus
```

That `chmod` covers the DIRECTORY. The map file inside it is a second
thing, and it matters: nothing in Olympus WRITES this file — you do — so
it lands at your umask, which is 0644 on a clean macOS install. A 0700
directory hides it from other users but not from anything running as the
operator, and the file is a list of what they consider sensitive and what
it looks like. Set the mode yourself right after writing it:

```bash
chmod 600 ~/.olympus/sensitivity-map.json
```

`olympus sensitivity validate` also enforces this: it is the one command
that opens the map by name, so it leaves the file 0600 and reports both
`permissions` (a 4-digit octal string) and `permissionsTightened: true`
when it had to change anything. It refuses to chmod through a symlink or
a non-regular file. Doing it yourself first means `permissionsTightened`
never appears — which is the result you want, not a step you can skip.

`olympus setup` creates the same directory at mode 0700, but it runs after
this step. (If you skip ahead and `olympus sensitivity validate` cannot
find the map, its own remedy names the directory and says setup creates
it.) Then write `~/.olympus/sensitivity-map.json` using schemaVersion 1:

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
this machine for Ollama" lands as a non sequitur.

If you detected a local runtime, it is a conversational observation to
verify aloud HERE — "I noticed this machine is already serving a local
model; do you actually use it?" — never a silent basis for recommending a
posture. But be strict about what counts as detection. **An installed
plugin is not a runtime.** OpenClaw ships a built-in `llama-cpp` provider
plugin, so "there is a llama.cpp plugin" is true on a machine that has
never run a local model, and treating it as a cue recommends
`local-first` to someone with nothing to serve it. The only thing worth
reporting is a running OpenAI-compatible HTTP server actually answering on
the ports Olympus's local lanes are configured to use — the answer
endpoint and the embedding endpoint (`local-first`/`local-only` default to
`http://127.0.0.1:8000/v1` and `http://127.0.0.1:28011/v1`). Probe those,
and if nothing answers, you detected nothing: ask the question above with
no preamble. Use their answer to mark which option below is recommended
for them, then present all four.

The operator has likely never heard of Venice, so introduce it once,
before the options name it:

> Two of these options use Venice (venice.ai) — a privacy-focused AI
> cloud. What it offers is a provider that does not train on your
> conversations or retain them the way an ordinary cloud model does.
> Being straight with you about the limit, because it matters for the
> tier we just discussed: this is Venice's privacy policy and
> infrastructure, not encryption that would make it impossible for them
> to read a question. Olympus does not provide or qualify
> end-to-end-encrypted inference in this version.
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
>    owner-controlled first step, with private-cloud escalation available;
>    speed and first-pass quality depend on your machine.
>
> 2. **Local models only** (`local-only`) — secure questions are answered
>    only on your own machine. Venice is not used. Requires: the same local
>    runtime with lots of fast memory, plus a Gemini API key (free tier
>    available) for search indexing. Trade-off: no sensitive-tier cloud
>    escalation; if the local lane cannot answer, Olympus reports the gap.
>
> 3. **Private cloud only** (`private-cloud-only`) — recommended if you do
>    not run local models. Secure content goes only to Venice, on its
>    Private model path — currently `kimi-k3`. Requires: a
>    Venice API key (pay-as-you-go) and a Gemini API key (free tier
>    available) for search indexing. Trade-off: no local-model requirement
>    or local fallback; you are choosing a privacy-focused cloud provider
>    for secure answers, on that provider's word rather than on
>    encryption.
>
> 4. **Do not add secure data to Olympus** (`no-sensitive`) — Olympus
>    keeps its hands off secure data entirely: it is not imported, not
>    indexed, and no model — local, private cloud, or ordinary cloud —
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
their questions, and record the choice.

**Now clear the second gate, before you run setup.** `olympus setup` does
not only write config: it registers the background worker service
(launchd on macOS, a user systemd unit on Linux) and writes the worker
environment file. That is the Rule one worker-registration gate, and
running setup spends it — so it is asked HERE, not in Step 4. macOS will
show a "Background Items Added" notification the moment setup runs, and an
unexplained notification on the operator's own machine reads as something
being done TO them.

One sentence first (adapt the words), then their yes, then the command:

> Next I'll run setup. Two things happen: it writes your privacy policy
> from the choice you just made, and it registers the sync worker — a
> background service on this machine that keeps your sources indexed.
> macOS will show a "background items added" notification when I do;
> that's this, nothing else. You can see or remove it anytime under
> System Settings → General → Login Items, or with `olympus worker
> uninstall`.

Then, and only then:

```bash
olympus setup --preset <chosen-preset> --cloud-lane subscription --yes
```

**Reading the summary: an honest gap looks like a leak until you know the
shape.** On `no-sensitive` the summary and later `olympus doctor` output
still show the secure corpora as configured with nothing in them, and the
sovereignty policy shows `secure_local` with `"mode": "disabled"` and an
empty pool. That is `no-sensitive` working: the tier exists so Olympus can
answer "that's not indexed" honestly, and it is routed nowhere. Do not
report it to the operator as a problem, and do not try to "fix" it by
adding a lane they did not choose.

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

- Gemini API key (source embeddings, all presets): **ASK THE OPERATOR**
  to obtain a key from https://aistudio.google.com and provide it (or
  source it per the credential-sourcing rule above). Connect it via
  stdin, exactly like the Venice key, so it never reaches shell history,
  a log, or a chat message (you run this; do not show it as a copy
  block):

```bash
printf '%s' "$KEY" | olympus connect gemini --api-key-stdin
```

  `$KEY` must be populated without the value reaching your shell history,
  a log, or chat. Two supported ways, per the credential-sourcing rule
  above: read it out of the operator's password manager with that
  manager's CLI, after their per-credential yes and by the exact item name
  they gave you (`KEY="$(op read '<their reference>')"`, or the Keychain's
  `security find-generic-password … -w`); or have the operator type it
  into a silent read in a shell they control (`read -rs KEY`), which
  echoes nothing. Never `export` it, never echo it back to confirm it, and
  unset it when the connect returns.

  The command itself is the remedy setup prints for this item, verbatim. The
  command validates the key against Gemini before storing anything, writes
  it into the worker environment as
  `OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY` at mode 600, and tells you to
  `olympus worker restart` so the running worker picks it up — do that,
  and re-run doctor afterwards.

  Do NOT hand-edit the worker's env file to add the key: `worker.env` is a
  generated managed file this guide forbids editing (see Step 4), and an
  `export GEMINI_API_KEY=…` in your shell dies with your session and is
  never seen by the background worker. Two refusals you may meet, neither
  of which you may work around by editing the file: the command needs the
  worker environment to exist (`No Olympus worker environment exists at
  …` — that means setup has not run yet), and it refuses a key containing
  a single quote (`… value must not contain a single quote.`), whose
  remedy is the one the error gives — rotate the key at the provider and
  store one without a quote.
- Venice API key (`local-first` or `private-cloud-only`): the operator creates one at
  https://venice.ai, then you connect it via stdin so it never appears in
  shell history or logs (you run this; do not show it as a copy block):

```bash
printf '%s' "$VENICE_API_KEY" | olympus connect venice --api-key-stdin
```

Re-run `olympus doctor` until the `sovereignty_prerequisites` check is
green (or explained and accepted by the operator). Doctor's exit status is
the signal: a red walk exits 1 and writes a summary to **stderr** in this
shape —

```
olympus doctor: N of M checks passed, K failed.
Failed: email_worker, worker_credential_lanes, source_index_status
Fix the failed checks and run olympus doctor again; the JSON above carries each check's detail and hint.
```

— all three lines, every time, while the full JSON stays on stdout
unchanged. Branch on the exit status, never on the counts; exit 0 means
every check is green. `M` is doctor's whole check list — 15 on a current
build, on a fresh install as much as a loaded one — so read the number off
the line rather than quoting one you remember.

**`sovereignty_prerequisites` is the check to watch for the Gemini key,
and it really does evaluate.** Doctor resolves the same policy file every
other path uses — `~/.olympus/sovereignty.json` by default, or
`OLYMPUS_SOVEREIGNTY_CONFIG` / an explicit config path — so once setup has
written the posture, this check runs the same preflight setup ran (minus
the local-model-server probe, which `sovereignty_model_lanes` owns) and
names each unmet prerequisite with the exact remedy in its `hint`. It goes
green with a `Skipped: no sovereignty policy is configured for prerequisite
checks.` detail only when there is genuinely no policy to read; on a fresh
install that has run setup, a `Skipped:` here means something is wrong with
the policy path, not that the prerequisites are met.

Doctor also reads the config the managed worker actually runs with —
`worker.env` layered under the environment, and the config that layered
environment produces — so `source_scheduler_status` and the email and
sovereignty gates no longer report a value `worker.env` has already
overridden.

**One missing key turns three checks red at once. Read that before you
report "broken."** `email_worker`, `worker_credential_lanes` and
`source_index_status` all interrogate the same worker, so a single missing
Gemini embedding key fails all three together. That is ONE problem with
three symptoms — the fix is the one connect command above, not three
investigations. The discriminator is whether the worker answered, and what
it said:

- **One missing key (expected on a fresh install).** The worker answered
  and says what is wrong: `email_worker` reports `Email worker is running
  in degraded mode: …`, `worker_credential_lanes` reports `Worker
  credential lanes are degraded: …`, `source_index_status` lists the same
  credential among its problems, and the status JSON carries an
  `embedding_lane` of `{"state": "embedding_lane_disabled", "reason":
  "embedding_provider_unavailable"}`. All three name the SAME credential.
  Connect the key, run `olympus worker restart`, re-run doctor — the three
  go green together.
- **No email account connected yet (also expected, and NOT breakage).**
  Once no credential is degraded, `email_worker` falls through to
  `Email worker at http://127.0.0.1:8010/v1 answered /health
  (reachable=true configured=false).` with the hint `The worker is running
  but reports configured=false; check its connector configuration.` That is
  a red check whose whole meaning is "no mailbox yet" — the worker's own
  health detail says it plainly: `No email account is connected yet.
  Connect Gmail from the Olympus dashboard to enable email answers.` It
  clears when the operator connects Gmail in Step 5, and it is not a reason
  to touch config. Note the ordering: the degraded-credential line wins
  while a credential is degraded, so this sentence usually appears only
  after the Gemini key is in.
- **Real breakage.** The worker never answered: the details read `… is not
  reachable at http://127.0.0.1:8010/v1: <connection error>` and the hint
  is `Run olympus worker status, then olympus worker start or olympus
  worker install.` No credential is named, because nothing could be asked.
  Go back to Step 4 and get `service.state` to `active` first; the
  credential checks say nothing until the worker answers.

Report this to the operator as what it is — "one key is still missing, and
three checks are reporting the same gap", or "no mailbox is connected yet"
— never as a count of failures.

**Translate doctor output; never leak lane jargon.** "Argus" is Olympus's
internal name for the analyst that serves the secure tier (local models
or Venice, per the posture) — operators have never heard it. If the
operator's posture has no local lane, say nothing about Argus, local
models, or local endpoints: a "note about local models" to someone who
just said they don't use local models reads as an error. Mention local
lanes only for `local-first`/`local-only` postures, in plain words
("your local model isn't reachable yet").

## Step 4 — Verify the worker

**This step verifies; it does not install.** `olympus setup` in Step 2
already registered the background service, wrote `worker.env`, AND started
it. Setup's own output says so, under `worker`: `worker.state` is the state
the service manager reported when setup returned, `worker.next` is the step
that state calls for, and `worker.activation_detail` appears only when the
start did not take. On the healthy path `worker.state` is `active` and
`worker.next` reads `The managed worker is running; open the dashboard with
olympus dashboard.` Read those three fields before you run anything here —
they usually make this step a confirmation.

That is why the background-items consent gate lives before setup and not
here. Do not run `olympus worker install` as a FIRST install: by now there
is nothing to register, and treating this as the registration moment is how
the consent gate ends up asked after the notification has already fired.
The ban is on treating `worker install` as the registration step; as a
repair of the service your own setup wrote, it is idempotent, documented,
and allowed — see the remedies below.

**Residue check first (Rule zero):** if the service or plist on this
machine is NOT the one your own setup just wrote — a pre-existing unit, a
disabled one especially — stop and run Rule zero's gate before starting,
enabling, re-enabling, or restarting anything here.

```bash
olympus worker status
```

**The field you are verifying is `service.state`, and it must say
`active`.** The service facts are nested under `service`, so on a healthy
fresh install `service.state` is `active`, `service.unit_present` is
`true`, `service.env_present` is `true`, `lifecycle_transaction.state` is
`none`, and the top-level `recovery` list is **empty** — a fresh install
has nothing to resume, and a recovery list naming sources nobody has
connected would be the old bug, not a finding.

**Do not read the top-level `ok` as "the worker is up."** `ok` is false
only for `failed` and `unknown`, so a registered-but-stopped worker reports
`ok: true` with `service.state: inactive`. Read the state.

If you get `service.unit_present: true` with `service.state: inactive`, the
service is registered but not running. Do not read that as a failed install
and do not reach for `worker install` first — the remedy is one command:

```bash
olympus worker start
olympus worker status    # confirm service.state: active
```

`olympus worker start` polls the service manager for up to 15 seconds
before it decides, and a worker already answering its own loopback health
route gets the last word — so the state it prints is the settled state, not
a race with `launchctl kickstart`, which returns when the job is submitted
rather than when the worker is serving. When a start genuinely does not
take, it refuses in this shape, carrying the worker's own last log line:

```
olympus worker start completed but status is inactive. The worker's last log line was: <line>
```

with the remedy `Read the worker log at <errorLogPath> and <logPath>, then
run olympus worker status and follow its recovery action.` (on macOS both
paths are under `~/Library/Logs/Olympus`). Read the log before changing
anything — the reason a worker exits at boot is one line away, and a
missing Gemini key is a common one.

Only if `start` still leaves it `inactive` or `failed` do you reach for
`olympus worker install`. It is idempotent, it writes nothing over an
already-active service, it recovers an interrupted managed-file
transaction, and re-running it over the service your own setup registered
is a repair rather than a new background item — so it needs no fresh
background-items consent. It is also what setup's own `worker.next` names
when its start did not take (`Run olympus worker install, then olympus
worker status.`), and `worker.activation_detail` carries the same
`completed but status is …` sentence with the same log line.

Two things that look wrong here and are not: with no sources connected yet
the scheduler is **enabled and idle**, which is the healthy fresh-install
state and leaves doctor green; and the dashboard probe reports reachable,
because it asks the worker root for `/dashboard.json` rather than the
`/v1` API base.

If status names an interrupted transaction, it also names the exact next
action; re-running `olympus worker install` is the documented recovery for
that case too.

Use only the public worker lifecycle: `install`, `start`, `stop`, `restart`,
`status`, `foreground`, `upgrade`, and `uninstall`. Install and upgrade are
idempotent and recover interrupted managed-file transactions when rerun. Do not
pass secrets, environment paths, or executable overrides on the command line,
and do not edit generated service units or `worker.env` directly. Credential,
scope, pairing, Disconnect, partial-sync, and missing source-dependency repair
normally uses the source-specific recovery action without restarting the
worker. `worker uninstall` retains user data; `data delete` is the separate
destructive boundary.

The registered service is a launchd/systemd item with restart-on-failure.
If the operator would rather watch it run in the foreground for a first
session, `olympus worker foreground` runs it in a terminal they control —
stop the background service first so the two do not race.

## Step 5 — Connect sources

Open the dashboard and make it the operator-facing connect surface:

```bash
olympus dashboard
```

Say: "I've opened your Olympus dashboard. Click Connect on the sources you
want; I'll watch status and help with any one-time setup."

`olympus dashboard` prints three fields and no fourth: `url`, `opened`
(whether it managed to open a browser), and `hint`. **Hand the printed
`url` to the operator exactly as printed.** It ends in
`?token=dash_…` — the read-only view token — and that is the URL the
command just opened in the browser. It is also the only URL that works: a
browser cannot send a bearer header from the address bar, so the bare
`/dashboard` path returns 401 and gives the reader no way to tell why.
Copy the URL whole; do not "clean up" the query string.

The `hint` is the sentence that explains the split, and it is worth
reading to the operator almost verbatim:

```
This URL carries the read-only view token, not the worker token; unlocking the controls still needs <rootDir>/bin/olympus dashboard token.
```

(If no worker token exists yet, the hint instead says
`No worker auth token found; run <rootDir>/bin/olympus setup first, then
<rootDir>/bin/olympus dashboard token for the unlock value (rootDir comes
from openclaw plugins inspect olympus --json).` — that means setup has not
run, not that the dashboard is broken.)

**The `dash_` token is not the worker token.** It is derived from the
worker bearer, it is read-only, and the worker admits it on exactly two
routes — `GET /dashboard` and `GET /dashboard.json` — and no others: no
control route, and no method but GET. So it is not the secret MUST NOT #2
governs; treat it as you would the dashboard screen itself. Fine to hand
the operator, not something to drop into a public issue or a shared log,
because it does open their dashboard to whoever holds the link.

**`olympus dashboard token` is the secret — treat it like one.** That
command prints the worker bearer, which authorizes every change
(**Connect**, **Sync now**, **Disconnect**, Unpair), and MUST NOT #2
covers it exactly as it covers an API key: never paste it into chat, a
summary, a note, or a commit. The operator pastes it into the dashboard's
"Worker token" field with their own hands. When they need it, the
dashboard's "Where is my token?" sheet gives them the command as
`<rootDir>/bin/olympus dashboard token`, with `rootDir comes from
openclaw plugins inspect olympus --json` under it — the same path your
`$OLYMPUS_BIN` already resolves to, so what you tell them and what the
page tells them agree. Follow that method, and if you cannot, give them
the command to run themselves rather than running it and relaying the
value.

Both commands resolve the worker token the same way — worker.env first,
then config — so the URL you hand over and the token the operator pastes
always belong to the same worker. If an older build shows you an `auth`
field beside the URL, or prints a `url` with no `dash_` query token at
all, that build predates this guide: do not read the `auth` field as the
token, and do not hand over a tokenless URL as if it worked.

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

**Only `openclaw config validate` is the gate.** It must exit green; if it
does not, stop and fix the config before restarting (MUST NOT #3).

`openclaw doctor --lint` is a report you read, not a gate you must clear.
It lints the operator's whole OpenClaw install and routinely exits 1 on
pre-existing warnings that have nothing to do with Olympus — another
plugin's config, a deprecated key, an unrelated agent. Findings that are
not about Olympus are **reported to the operator and left alone**: do not
fix them (you did not cause them and nobody consented to those changes)
and do not let them block the restart. A lint finding that IS about
Olympus is a different matter — treat it as a real defect and resolve it
before restarting.

After the restart, verify the plugin actually loaded. The honest checks
are:

- the gateway boot line names olympus among the loaded plugins — read it
  where it actually is, see below, and
- `openclaw plugins inspect olympus --json` reports `"status": "loaded"`,
  and
- one real tool call succeeds — `olympus source index status`.

**Where the gateway boot line actually lives.** Do not go looking in
`openclaw logs` or `~/.openclaw/logs/gateway.log`. On `2026.9.1` the
former printed nothing, and the latter is a stale file that can be months
old — believing it will tell you the plugin failed to load on a machine
where it loaded fine. On macOS the live gateway log is a per-day
JSON-lines file under `/tmp/openclaw/`, so grep the newest one:

```bash
grep -h 'http server listening' "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
```

Every line is a JSON object, so the boot record and its loaded-plugin list
sit inside the `message` field rather than reading as plain text; pipe
through `jq -r .message` if you want it legible. On Linux the gateway runs
as a user systemd unit and the same line comes from the journal:

```bash
journalctl --user -u openclaw -n 200 --no-pager | grep 'http server listening'
```

If neither surface shows the line — a machine whose log rotated since the
last restart, for instance — do not manufacture the proof and do not
restart again to produce one. Say the boot line was not observable, and
lean on the other two checks: `"status": "loaded"` plus a successful
`olympus source index status` are conclusive on their own.

**Do not verify by reading `toolNames` from `plugins inspect`.** It is
`[]` for olympus by design: the tools (`source_answer`,
`source_index_status`, `source_index_search`) register at runtime when the
plugin initializes, not in the static manifest inspect reads. An empty
`toolNames` on a healthy install proves nothing is wrong, and chasing it
sends you re-installing a plugin that already works.

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

`olympus doctor` exits 1 while any check is red, naming the failed checks
on stderr (counts and check names only), and leaves the full JSON on
stdout. Its exit status is the pass/fail signal — you do not have to grade
the output yourself. Exit 0 is green.

Confirm in the answer's audit block that `analyst_backend` matches the
chosen posture (e.g. `venice` for private-cloud-only secure answers, `local`
for local-only secure answers).

The private source worker lane is on by default, so a fresh install
should not see `email_not_configured` at all. If it does, the lane was
switched off deliberately — `OLYMPUS_EMAIL_ENABLED=false` is the only
supported opt-out — and the error names its own remedy:

> Run olympus setup, then olympus worker install, to bring up the private
> source worker that owns OAuth and message fetch and reasons over an
> approved local/private model lane.

Run what the error names, nothing else. Do not invent a fix, do not
hand-edit config to flip the lane on, and do not re-run `olympus setup` to
"reset" it (the CLI refuses without `--force`, and `--force` needs the
operator's explicit consent — MUST NOT #5).

What a fresh install DOES see when the worker simply is not running is the
honest version of the same problem: `Email worker is not reachable at
http://127.0.0.1:8010/v1: <detail>`, where the detail after the colon is
the underlying connection error. That is a Step 4 worker question, not a
configuration one — read the detail before doing anything about it.

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
(MUST NOT #5). A refusal like "config already exists" during resume means
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
3. **Never restart the gateway without a green `openclaw config
   validate`.** That is the gate. `openclaw doctor --lint` is a report:
   its findings on things other than Olympus are surfaced to the
   operator, not fixed, and do not block the restart.
4. **Never edit `openclaw.json` by hand** — use `openclaw config set` or
   the documented connect/setup commands only. The same holds for
   Olympus's own generated managed files: never hand-edit `worker.env` or
   a generated service unit.
5. **Never run `olympus data delete`, overwrite an existing
   `~/.olympus/sovereignty.json`, or reinstall over an existing plugin**
   without the operator's explicit, informed consent. Read `--force`
   by what it would do on THIS machine, not by its name: on OpenClaw
   `2026.8.1+` the plugin install requires `--force` merely to accept a
   non-ClawHub source, and on a machine with no olympus installed that
   overwrites nothing and needs no separate consent (Step 1). The moment
   an olympus plugin already exists, the same flag overwrites it and this
   rule binds in full.
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
