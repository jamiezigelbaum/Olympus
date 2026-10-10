# Private answers

Status: structure approved by the owner on 2026-10-07 (approved mockup:
<https://claude.ai/artifact/XViZZCr6zpWcZQhmzXhNNE>). The one-click install of
Tor and zkAPI (below) is built; the rest of this page is approved and not yet
built unless it says so.

## Outcome

When the answer your Mac gives from your private material is missing
something, you decide in one place what Olympus may do about it, and you can
see exactly what left the Mac and who could read it.

## The section: "Private answers"

A dashboard section on the Mac. Your Mac always answers first. One choice
decides what happens when that answer is missing something:

- **Keep it on this Mac** (default). Nothing leaves.
- **Sealed cloud · Venice.** The private material the question needs goes to
  Venice's TEE (sealed-hardware) models. Venice knows the account. True
  end-to-end-encrypted Venice stays gated in Olympus
  (`SecureAnalystPoolE2EEGateError`) until local key handling exists.
- **Anonymous · zkAPI.** A short question goes to a top model, paid through
  zkAPI over Tor with a fresh key per request. The provider reads the
  question but cannot tell who asked.

| | Keep it on this Mac | Sealed cloud · Venice | Anonymous · zkAPI |
|---|---|---|---|
| What leaves the Mac | Nothing | The question and the private material it needs, sealed | A short question, with names and identifying details removed |
| Who can read it | Only your Mac | Only the sealed model | The AI provider |
| Who knows it was you | No one | Venice, through your account | No one: paid anonymously, sent over Tor |
| Main risk | The answer stays as good as the local model | Trust in Venice's sealed hardware and its account records | An unusual situation could still hint at who you are (re-identification) |
| Speed and models | Seconds; the local model | Seconds; strong models | 1–2 minutes today; top models |

Summary line on the page: "Venice hides what you ask; zkAPI hides who is
asking."

## zkAPI: what it may send

Two levels:

- **Standard (recommended)** (`unnamed`, the default everywhere, including a
  settings file with no `level`). "Your question goes out as you choose:
  exactly as written, lightly cleaned, or by your own instruction. The
  provider can read it but can't tell who sent it."
- **Strict** (`general`). "Your model rewrites it into general questions
  first (Vitalik Buterin's approach)." The writer's general questions under
  Vitalik's rules, with the full gate for the built-in writer and the thin
  net for the owner's own (below). For a direct ask (`ask_anonymously`) the
  writer gets the direct form of those rules (`CONSULT_WRITER_SYSTEM_DIRECT`):
  the question is to be sent, so it always rewrites, and "nothing" is only
  for a question with no general form. The escalation lane keeps the
  "decide first" form (found live 2026-10-10: the escalation prompt with an
  empty first answer declined a deposit question).

### Standard is open: the user's choice (owner decision, 2026-10-10)

Standard's content privacy is the user's choice, not Olympus's. A setting on
the card, "How should your model prepare a question before it leaves?",
offers three modes (`standardMode` in consult.json; a file without it reads
as light cleanup):

- **Exactly as written** (`as_written`): no model step; the question goes
  out unchanged (from ChatGPT, the question as ChatGPT sent it).
- **Lightly cleaned** (`light_cleanup`, the default): the writer follows a
  short preset instruction, shown in full on the card and editable
  (`CONSULT_LIGHT_CLEANUP_INSTRUCTION`, text in
  consult-writer-instructions.md). Editing it saves it as the user's own.
- **By your own instruction** (`custom`, `standardInstruction`, at most
  4,000 characters): the user's text is the writer's whole system prompt,
  wrapped only by the fixed JSON reply format.

At Standard the only outbound rule is secrets: the existing detectors
(passwords, keys, tokens) and a labelled snapshot secret repeated in the
request (`ConsultGateOptions.net = 'secrets'`). Names, places, figures and
copied wording go out if the user's mode lets them; the size bound is the
transport's own 8 KiB. The writer's reply is checked for shape only. The
mode and instruction are bound to the job like the level and the writer: a
change before the send refuses it. The owner's own writer also reads the
bounded evidence at Standard (not as written); the built-in writer reads
only the question, within its prompt-token bound. The full gate now runs only
at Strict with the built-in writer.

**Ask anonymously.** The user asks from inside their own agent: the
`ask_anonymously` tool (`src/core/consult-ask.ts`) takes the question (at
most 4,000 characters), prepares it by the chosen level and Standard's mode,
checks it, and sends it through the zkAPI transport with its caps,
acknowledgements and model check. The answer, the model that answered and
exactly what was sent come back in the tool result. It involves no private
evidence. The question is the secrets check's context, so a labelled secret
in it stays refused even when the writer drops the label. The ask binds the
settings revision, writer and Standard mode and instruction when it starts;
the transport's final authorization refuses the send as stale if any changed.
The dashboard's own question box was retired on 2026-10-10 (design step 3):
the card is for setup only.

The rulings below (words of the question ChatGPT sent, copied document
wording and their residuals) governed Standard's full gate and now apply
only where that gate still runs; they are kept as the record.

Words of the question ChatGPT sent (owner ruling, 2026-10-08). At Standard, a
word from the question ChatGPT sent may go out even when the private
documents also contain it: OpenAI already holds that question, so the word
is not private evidence ("fees in Catalonia" when the question named
Catalonia). Only the exact words count, not the document words around them,
and never the question's wording: four words copied from it, in any order,
are refused at both levels, because the zkAPI model's provider also sees the
ChatGPT conversation and could link the two. Hard identifiers stay blocked at
both levels even when the question holds them: mail addresses, phone,
account, IBAN and ID numbers, street addresses, exact dates and years,
secrets and handles. Typing an IBAN into ChatGPT never lets it go out to
zkAPI, not even dressed as an amount. Strict has no exemption. Rule:
`docs/design/consult-writer-instructions.md`, "Level: your situation,
without names".

Copied document wording (owner ruling, 2026-10-08, after the PII bake-off).
At Standard, answerability comes first: a request that copies wording from
the private documents may go out unless it carries a hard identifier. The
gate still reads every copied word with its other rules (names, places
below a country, exact dates and years, amounts, account, phone and ID
numbers, addresses, mail addresses and handles), and inside a copy every
word the documents capitalize counts as a name, even at a sentence start
("Mason signed the inspection report." stays refused beside "the mason").
Copying
the question ChatGPT sent stays refused at both levels, and Strict refuses
every copy as before. Measured: Standard refuses 9 of 30 legitimate
situation questions instead of 14, with no hard-identifier leak on any eval
set. Rule: `CONSULT_GATE_UNNAMED_COPIED_WORDING_MAY_PASS` in
`src/core/consult-gate.ts`.

Accepted residuals of this ruling (2026-10-08 review): a codename or name
the documents write only in lower case can go out inside a copy ("Under the
blue lantern clause may the landlord hold the deposit?", or a person's name
the documents never capitalize); and a recognised name pair split across
sub-questions into words the gate reads as function words ("Will May" sent
as "...with will?" and "Could may attend?") is not matched as a pair. Both
need a writer working against its own rules, and the writer is the owner's
own local model.

Accepted residual (2026-10-08 review): the question is ChatGPT's tool
argument (`question` in `src/workers/chatgpt/mcp-surface.ts`), not a
verified copy of what the owner typed, and an MCP server cannot read the raw
user message. Whatever ChatGPT puts there is already known to OpenAI:
Private-tier content never reaches ChatGPT, and Personal-tier cloud use is by
design. So exempting those words exposes nothing new to OpenAI; to a
different zkAPI provider it exposes at most single Personal-tier words,
never Private ones.

Both are always selectable. Sending needs the six cost-and-risk statements
(acknowledgement version 6) accepted, so while they are not, choosing Standard
shows them inline with one "Accept and save", and outside help stays paused.

Status: approved, not built. It needs a writer prompt for the new level, a
re-identification eval beside the existing leak eval, and the setting on the
card.

## Writer: your own local model

Status: built (2026-10-10). Owner decision, 2026-10-10, modelled on Vitalik
Buterin's published setup: a local model reads the private data, decides when
a remote model is needed and writes the request itself with less identifying
detail; zkAPI separates payment; Tor hides the network ("you need all
three").

Why: on 2026-10-10 the built-in 4B writer saw only "the evidence does not
contain the LOI", copied its prompt's single landlord example, and asked the
outside model whether "the document signed by the landlord" mentions a
notary: a question about a document the outside model can never see.

Decisions:

1. **An option, not a gate.** Anonymous answers work with any model. People
   who run a substantial model at home (Ollama, LM Studio, a llama.cpp server,
   or a home server such as Delphi) can choose it as the writer. Nothing
   checks or locks which model is used; the card only says it works best
   with a substantial one.
2. **Where it is set.** `writer` in `~/.olympus/consult.json`: an
   OpenAI-compatible base URL, a model name, and an optional key reference
   (`env:NAME` or `store:name`, resolved like the sovereignty profiles' keys,
   never stored or logged), plus an optional deadline (default 180 s). Not the
   sovereignty policy, because its local profiles are loopback-only and a home
   server on the LAN or tailnet must be allowed; and this file is read at every
   use, so a change needs no restart. Any HTTP(S) address is accepted. Set on
   the card ("Who writes the question"); without it, the built-in model writes,
   exactly as before. Two existing protections still apply: the zkAPI
   daemon's port is refused, and a model with Ollama's cloud tag is refused,
   because both would send private evidence off the machine.
3. **Vitalik's way.** The chosen model reads bounded excerpts of the evidence
   the answer used (at most 12 excerpts, 1,500 characters each, 12,000 in
   all), the question, the first answer and its gaps. It decides whether a
   frontier model would help and writes the request in its own words. The
   built-in writer keeps its inputs (question, answer, gaps) and token bound.
   Both use the same rewritten rules (consult-writer-instructions.md): Strict
   keeps Vitalik's rules (the skill file in ethereum/zkapi PR #16), Standard
   is the user's own choice (above). Strict was measured with and without the
   evidence on Delphi after the thin-net fix (12 of 16 either way) and keeps
   it.
4. **No automatic escalation** (retired 2026-10-10, design step 3). A
   private answer with gaps no longer sends anything on its own, and the
   private answer panel no longer shows an anonymous answer under it: a
   question goes out only when the user asks through their agent. zkAPI
   never sees the documents, so it cannot fix retrieval or find what the Mac
   missed; it helps when a stronger model's reasoning or outside knowledge is
   wanted. The evidence excerpts in item 3 return with the documents lane
   (`use_documents`, design step 4); until then the writer reads only the
   question.
5. **The answering model is never the provider that holds the conversation.**
   OpenAI also holds a ChatGPT conversation and could link it to the
   anonymous question; Anthropic holds a Claude one. So the model follows who
   hosts the asking agent (owner decision 2026-10-10, extended the same day
   to every agent surface):
   - `chatgptFrontierModel` in consult.json names the zkAPI model for
     questions from ChatGPT (recognised by the relay's pinned client ids) or
     another OpenAI-hosted agent. Default: `anthropic/claude-sonnet-5.5`.
   - `claudeFrontierModel` names it for questions from an Anthropic-hosted
     agent (Claude Code, Claude Desktop: recognised by the MCP client name or
     the connection's name). Default: `openai/gpt-5.5`. Set on the card
     next to the ChatGPT one.
   - An agent whose provider is unknown (OpenClaw, the CLI) takes the ChatGPT
     setting, since ChatGPT is the surface most questions come through.
   - A one-off `model` from the caller's own provider is refused
     (`model_same_provider`); the answering model is named in every result
     (`model`), so the agent can say who read the question.
   There is no fallback to another model: if the live zkAPI listing lacks
   the model, the consult is not sent and the card says "Claude Sonnet isn't
   available through zkAPI right now; choose another model" (the transport's
   `model_unavailable` check). The card warns when ChatGPT questions go to
   an OpenAI model, and when Claude questions go to an Anthropic model.
6. **Capability test, on request only.** `olympus zkapi test-writer` and the
   card's "Test your model" run six invented cases (from the leak and
   re-identification evals, plus the LOI case with and without the letter)
   through the chosen writer and the gate. Nothing goes to zkAPI. It shows the
   questions written, what the gate would send or refuse, any invented name or
   figure that got past, and any question about a document. It never runs on
   its own.
7. **A thin net under the owner's writer** (owner decision, 2026-10-10).
   Vitalik's only content filter is the local model rewriting under his skill
   file: no detectors, no placeholders, no second check. Our full gate went
   further and, under a strong writer, refused most good questions (Strict 1
   of 16 on Delphi, mostly for sharing four words with the evidence). So when
   `writer` is set, at Strict (Standard is secrets-only, above), the gate
   refuses only hard identifiers:
   names written in the private snapshot, exact dates and years, exact
   amounts, account, phone and ID numbers, addresses, mail addresses, handles,
   links and secrets, with the existing detectors
   (`ConsultGateOptions.net = 'thin'`). Dropped for it: the vocabulary list,
   the question-structure limits and every copy rule. Names are judged from
   the snapshot alone, as at the Standard level, however the request writes
   them (a request that lowercases a snapshot name is refused; review of
   PR #209). Every labelled leak of the unnamed eval set stays refused. The
   writer is bound to the job when it is created: that writer runs, gets the
   evidence and selects the net, and a consult.json that names another writer
   (or none, or cannot be read) by the send refuses it. The built-in 4B
   writer keeps the full gate unchanged.
8. **Wording.** "Paid and sent anonymously." ("with identifiers removed" was
   dropped when Standard opened: at Standard that is the user's choice.) Never
   "unlinkable": the provider reads the question, and an unusual situation can
   still hint at who asked.

Residual: the owner's writer receives private evidence over the network when
it runs on another computer; the card says to use a server they control and
https or a private network.

## The user journey

1. **Setup.** The owner opens Private answers and picks one of the three.
2. **Guided zkAPI setup**, three steps:
   1. *Install the parts:* Tor and zkAPI, one click (built in this change,
      below).
   2. *Add money:* one transfer, fee included.
   3. *Confirm:* the six cost and risk statements (version 6), then turn it on:
      questions go out when you ask your agent to; the provider reads each question; a
      question usually costs a few cents with up to $6 held while it runs;
      adding and taking out money each have a network fee; unused money can
      be claimed by the operator after about 30 days (the card shows the
      estimated date when Olympus knows it); zkAPI is new, so add only what you are comfortable losing.
3. **Everyday use.** The user asks their agent to use Olympus zkAPI; the
   answer comes back in the agent's result with the model that answered and
   the exact question that was sent, every time, for trust. (The private
   answer panel's "Anonymous answer · zkAPI" block went with the automatic
   escalation on 2026-10-10.)

Ongoing: weekly use, the balance, the estimated 30-day expiry date on the
card (a reminder before it is not built yet), and one-click off.

## A private question ChatGPT never sees (added 2026-10-10)

The `ask_anonymously` tool keeps the question out of the provider's hands but
not out of ChatGPT's: the user typed it into the conversation. For a question
the user does not want ChatGPT to see either, `open_private_question` opens a
panel in the ChatGPT reply where the question is typed, sealed to the user's
own computer, asked through the same lane (writer, gate, zkAPI, the provider
rule) and answered in the panel. ChatGPT learns that a panel opened and
nothing else. Protocol and proof: docs/design/chatgpt-plugin.md "Private
question panel".

## Known gaps

- **Funding.** Olympus never runs `zkapi-clientd config` (a standing security
  rule), so "add money" needs one Terminal command that the dashboard watches.
  Open for redesign.
- **Settled cost.** The ledger stores each consult's hold (the allowance the
  live model list states for its model, $1 to $6; fixed 2026-10-10, before
  that every consult counted $6), not the settled
  price.
- **Latency.** 70–180 s today; the target is about 45 s after the planned speed
  work.
- **Release gate.** The quiet-machine B2 proof is still a release gate.

## Naming

"Outside help" is retired in user copy. The Mac card is "Anonymous answers"
(renamed 2026-10-10); "zkAPI" stays inside the card, where the route and the
daemon are described. Internal identifiers (`consult`, `outside-help`, the
`/dashboard/consult/*` routes) stay.

## One-click install of Tor and zkAPI (built)

Step 1 of the zkAPI setup. On the Mac dashboard's zkAPI card a button,
**Install Tor and zkAPI**, installs both programs into a folder Olympus owns,
from pinned, verified downloads. The card then lists each as *Installed
(Olympus)* or *Installed (your system)*, and the consult transport uses the
Olympus copy before anything on PATH. Headless and Linux users run the same
installer with `olympus zkapi install-tools`.

Installing turns nothing on, writes no setting, and never touches the wallet
or the API key. The only command Olympus runs on either program is
`--version`.

### Where

- macOS: `~/Library/Application Support/Olympus/tools/<tool>/<version>/`
- Linux: `$XDG_DATA_HOME/olympus/tools/<tool>/<version>/` (default
  `~/.local/share/olympus/tools/…`)

Folders are 0700 and must belong to the user; files are 0600, programs 0700.
Each version folder holds a manifest, `olympus-tool.json` (tool, version,
platform, asset, sha256, installedAt, and `adhocSigned` when Olympus signed
any file).

### How

`src/core/managed-tools.ts`:

1. One install at a time: a file lease on `tools/install`, shared by the
   dashboard and the CLI.
2. Already installed (a manifest naming the pinned version, platform and
   hash) is a no-op: nothing is downloaded.
3. Download into the tool's folder as `.download-<id>`, hashing while writing;
   a size or SHA-256 that differs from the pin is refused **before anything is
   extracted**.
4. The whole archive is parsed and checked before a file is written: no
   absolute paths, no `..`, no hard links, no device or FIFO entries, no path
   written through a link, and every symlink must resolve inside the install
   (checked lexically, then again with `realpath` after the links exist).
   Archives over 512 MB unpacked are refused.
5. Extract into a private `.staging-<id>` folder; check the files each program
   needs; on macOS clear `com.apple.quarantine` on that staging folder only
   (it holds nothing but the verified extraction); on Apple silicon ad-hoc
   sign the unsigned Tor files (below); run `<program> --version`
   and require the pinned version line. A program the system will not run is
   not installed, and the card says so plainly.
6. Write the manifest, then publish with one rename of the staging folder to
   `<tool>/<version>`. A version folder that failed discovery is moved aside
   first and removed after. Leftovers of an interrupted install are removed at
   the next install and are never discoverable, so a partial install never
   shadows a good one.

Layout: the zkAPI bundle keeps both programs at its root; Olympus places them
in `bin/` beside `share/` (the daemon finds its proof files there), as the
upstream installer does. Linux Tor gets a small Olympus-written launcher,
`bin/tor`, that puts the bundled libraries on `LD_LIBRARY_PATH`; the Linux
`debug/` symbols are not extracted.

Discovery (`managedToolExecutable`, used by `resolveZkapiExecutable` in the
consult transport for both the readiness probe and the real session): the
manifest must match the pin; the folders from the Olympus folder down to the
version folder must belong to the user and be writable by no one else; and
every file the program needs to run (the started executable, plus the real
`tor/tor` and its bundled libraries, or `zkapi-walletd` and the
`share/zkapi-clientd` proof files) must resolve inside the version folder,
with that file and every folder between it and the version folder owned by the
user and writable by no one else. One missing or exposed file reads as not
installed, and the next install replaces the folder. An explicit executable
path in the route's settings still wins and is only that path; the card
reports it as such, and a configured path that is missing stays a To fix
line the install button does not claim to fix.

The Linux Tor launcher runs no external command: it takes its folder from
`$0` by parameter expansion (`${0%/*}`) and refuses a `$0` with no slash.
Leftover cleanup and the version-folder rename run under `lease.commit`; the
install checks the lease before extracting and stops the whole batch
(`lease_lost`) the moment another install has taken it over.

### The dashboard

One POST route, `/dashboard/consult/tools/install`, added to the card's
local-grade control routes (`DASHBOARD_CONSULT_CONTROL_PATHS`): local-grade
session, CSRF and same origin required, the Gateway bearer and every
bearer-derived session refused, never forwarded by the relay. It starts the
install in the worker and returns at once. The card re-reads its page every
1.5 s while the install runs and shows "Downloading Tor… 40%", "Checking…",
"Installed", or the plain failure with **Try again**.

### Pins (verified 2026-10-07)

**zkapi-clientd 0.1.6** — upstream release `clientd-v0.1.6` of
`ethereum/zkapi` (published 2026-10-02). Base URL
`https://github.com/ethereum/zkapi/releases/download/clientd-v0.1.6/`.

| Platform | Asset | Bytes | SHA-256 |
|---|---|---|---|
| macOS arm64 | `zkapi-clientd_0.1.6_darwin_arm64.tar.gz` | 22,904,346 | `0e045245332fbe5d832d73f4ec1633bada2a5058032dd137b9e447f83bdc86c4` |
| macOS x86_64 | `zkapi-clientd_0.1.6_darwin_amd64.tar.gz` | 23,547,367 | `ac9bb3f0f64c3f9c5c271291f38065cb1b008b5d8b2eb5e998ea9b615fc54a12` |
| Linux x86_64 | `zkapi-clientd_0.1.6_linux_amd64.tar.gz` | 23,826,995 | `41f9df6c24fd1e1491bc21fcc5be89289525c01f5a850bd64326a85152bbff95` |
| Linux arm64 | `zkapi-clientd_0.1.6_linux_arm64.tar.gz` | 23,612,951 | `41549a752cdffdace74cdabd872ad71190d7509a9b307e54f5ee0e5f863b7cdf` |

How verified: each archive downloaded and hashed locally; each hash matched
the release's `SHA256SUMS` (whose own SHA-256,
`3d0f047b82280506c0a4d7a7cc0df012e1523f5d832f0cbdaff653dff410213e`, matched
GitHub's asset digest) and GitHub's per-asset digest. The release carries no
signature to check. Each archive holds
`zkapi-clientd`, the wallet companion `zkapi-walletd`, and
`share/zkapi-clientd/` (proof-setup keys and manifest, build info,
third-party licences); all three are installed. The macOS binaries are
ad-hoc, linker-signed (no Developer ID, not notarized).

**Tor Expert Bundle 15.0.24** (the current stable Tor Browser release; the
binary carries tor 0.4.9.13). Base URL `https://dist.torproject.org/torbrowser/15.0.24/`.

| Platform | Asset | Bytes | SHA-256 |
|---|---|---|---|
| macOS arm64 | `tor-expert-bundle-macos-aarch64-15.0.24.tar.gz` | 18,724,201 | `d47afd04b6c751129978390ad003d74ac8b88adfbb939350f0f89999e6570644` |
| macOS x86_64 | `tor-expert-bundle-macos-x86_64-15.0.24.tar.gz` | 19,356,806 | `8acb0b590f6be34084dcb6d84009ac0c61cc7c5261b7a19d2ab94845aa9bd5b6` |
| Linux x86_64 | `tor-expert-bundle-linux-x86_64-15.0.24.tar.gz` | 32,348,376 | `8e012ec6815d7899cb64011582e2dade88e74119c6661068a2a3252de0ccd7f2` |
| Linux i686 | `tor-expert-bundle-linux-i686-15.0.24.tar.gz` | 25,964,591 | `7537fea3478d05b8af25d7f8199c031b281f7015c32bb4177bef71f8e5100d9b` |

How verified: each archive downloaded and hashed locally; each hash matched
`sha256sums-signed-build.txt` and `sha256sums-unsigned-build.txt`;
`sha256sums-signed-build.txt.asc` and every archive's own `.asc` verified with
gpg as good signatures from the Tor Browser Developers signing key
`EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290` (signing subkey
`022D A248 432D 2A0E 0F54 E65E 316C 1FAC D62D 07D9`), fetched from
keys.openpgp.org into a throwaway keyring. Tor publishes no Linux arm64 expert
bundle; there the card says to install Tor from the system's package manager.

### Gatekeeper and code signing

- A download made by Olympus (Bun's `fetch`) carries no
  `com.apple.quarantine` attribute, so Gatekeeper does not assess these
  programs at first run; the quarantine clear is a guard for the case where
  something adds it.
- The zkAPI macOS binaries are ad-hoc signed, which Apple silicon accepts.
- **The Tor macOS arm64 bundle's `tor/tor` and `tor/libevent-2.1.7.dylib` are
  not code-signed at all** (`codesign -dv`: "code object is not signed at
  all"), and Apple silicon runs no unsigned arm64 code. Owner decision
  (2026-10-07): do what Homebrew does for relocated arm64 binaries. After the
  archive's SHA-256 matched and it was extracted into the staging folder, and
  before the `--version` check, Olympus runs
  `/usr/bin/codesign --force --sign - <file>` on each of those two files.
  Bounds: codesign only from `/usr/bin`; only files inside the verified
  staging folder (real path checked); only on darwin-arm64; only when
  `/usr/bin/codesign -dv` reports the file unsigned. Nothing already signed
  is ever re-signed, including the zkAPI binaries (which are never passed to
  codesign at all). The manifest records `adhocSigned: [...]`. If codesign is
  missing, cannot read the signature, or fails, the Tor install stops with a
  plain message and nothing is installed. Intel Macs and Linux never sign.
  An ad-hoc signature only lets the kernel run the code; it adds no identity,
  and the trust still comes from the pinned SHA-256 and the Tor signing key.

### Proof

`test/managed-tools.test.ts` (fixture archives under fixture pins, an
injected fetch, no network, no downloaded program run): hash and size
mismatch refused, traversal, absolute, symlink-escape (direct and chained),
write-through-link, hard-link and device entries refused, idempotent rerun,
interrupted install never shadowing a good one, manifest written, lease busy,
discovery's ownership and permission checks, ad-hoc signing (order, bounds,
never re-signing, codesign missing or failing) through an injected command
runner, the transport preferring the
managed copy, the route's local-grade boundary, and the card's progress and
failure states.
