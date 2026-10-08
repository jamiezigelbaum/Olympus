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
  settings file with no `level`). "Sends your actual question with names,
  places, exact dates, amounts and account numbers removed. Gets real
  answers." The stated risk is re-identification from an unusual combination
  of details.
- **Strict** (`general`). "Sends only general questions; nothing about your
  situation leaves. Safest, but rarely helpful." Today's consult writer
  behaviour, optionally with ask-before-send; this merges with the planned
  strict mode (stage C6).

Both are always selectable. Sending needs the six cost-and-risk statements
(acknowledgement version 5) accepted, so while they are not, choosing Standard
shows them inline with one "Accept and save", and outside help stays paused.

Status: approved, not built. It needs a writer prompt for the new level, a
re-identification eval beside the existing leak eval, and the setting on the
card.

## The user journey

1. **Setup.** The owner opens Private answers and picks one of the three.
2. **Guided zkAPI setup**, three steps:
   1. *Install the parts:* Tor and zkAPI, one click (built in this change,
      below).
   2. *Add money:* one transfer, fee included.
   3. *Confirm:* the six cost and risk statements (version 5), then turn it on:
      questions go out automatically; the provider reads each question; a
      question usually costs a few cents with up to $6 held while it runs;
      adding and taking out money each have a network fee; unused money can
      be claimed by the operator after about 30 days (the card shows the
      date); zkAPI is new, so add only what you are comfortable losing.
3. **Everyday panel behaviour.** The private answer panel shows "Asking
   anonymously…", then "Anonymous answer · zkAPI" with "Sent without names:
   <the exact question>", shown every time, for trust.

Ongoing: weekly use, the balance, the estimated 30-day expiry date on the
card (a reminder before it is not built yet), and one-click off.

## Known gaps

- **Funding.** Olympus never runs `zkapi-clientd config` (a standing security
  rule), so "add money" needs one Terminal command that the dashboard watches.
  Open for redesign.
- **Settled cost.** The ledger stores the $6 hold per consult, not the settled
  price.
- **Latency.** 70–180 s today; the target is about 45 s after the planned speed
  work.
- **Release gate.** The quiet-machine B2 proof is still a release gate.

## Naming

"Outside help" is retired in user copy (the Mac card is "Anonymous answers ·
zkAPI"). Internal identifiers (`consult`, `outside-help`, the
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
