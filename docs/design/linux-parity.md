# Linux parity

Status: plan, 2026-10-12, revised after an independent review (Codex, same
day: "needs rework", 11 findings, all taken). Nothing built.

## Outcome

A new user who installs Olympus on Linux gets the same product as a Mac user:
scans and pictures of text are read, photos are searchable by what is in
them, voice notes are transcribed, Private questions are answered on their
own machine, sources open from an answer, the ChatGPT engine installs and
runs as a managed service, and the zkAPI private lane is confined at least as
tightly as on a Mac, or Olympus refuses or states plainly how much weaker it
is. Linux means x86_64 and arm64, glibc, systemd user services, with or
without a desktop session. The primary desktop target is Omarchy (Arch,
Hyprland on Wayland, pacman); Ubuntu 24.04 (Sparta) is the primary headless
target. Owner direction 2026-10-12: Olympus itself must run on Linux;
where the AI client runs does not matter.

The first real user is Sparta. Stage 2 of the approved Sparta fresh install
("Linux photo processing") is W3. Every change is a product capability for
any Linux user, never a Sparta-only fix. Accepted scope is recorded in
`docs/V0_4_RELEASE.md`, whose qualification promise already covers clean
Linux installations (`docs/V0_4_RELEASE.md:503`).

## Code facts (checked against `681b8a2a`)

Shared with the Mac today:

- Worker service as a user systemd unit; terminal secret entry; `xdg-mime`
  link handler (`src/core/open-handler.ts:158`); headless detection for
  remote open (`src/core/remote-open.ts:86`); Linux consult memory probe
  (#270, which ignores cgroup limits: `src/core/consult-writer.ts:538`).
- Pinned downloads: LiteRT for EmbeddingGemma 2 (`built-in-embedding/
  manifest.ts:202`, darwin-arm64, linux-x64, linux-arm64); llama.cpp for the
  private model and transcription (`built-in-reasoning/manifest.ts:128-144`,
  same three); zkapi-clientd linux-x64/arm64; Tor linux-x64 and i686 only,
  **no Linux arm64** (`src/core/managed-tools.ts:163`).
- Secret store: libsecret when `secret-tool` exists, otherwise encrypted
  files (`src/core/secret-store.ts:77`). Not qualified on a headless host: a
  locked or absent Secret Service makes a lookup answer "missing" (`:283`).

Mac-only or different on Linux:

| Capability | Mac | Linux today | Where |
|---|---|---|---|
| Scanned-PDF OCR | Apple Vision via `osascript` | `ocrmypdf`/`tesseract` when installed; without them a PDF settles with `ocr_required` and is never reread (text extractor has no `reread` policy) | `extractors/ocr.ts:148, 382`, `extractors/text.ts:612`, `file-extraction/runner.ts:539` |
| Text in images | Vision in the text lane | none: `createImageOcr()` returns nothing without Vision, even with tesseract installed | `extractors/ocr.ts:289` |
| Photo content | `sips` converts to JPEG, long side ≤1,024 px (it does not strip metadata or normalise orientation) | one boolean gate is false, so every still image stays names-only | `extractors/image-prepare.ts:75-114`, `src/core/media-cache.ts:68`, `file-extraction/registry.ts:149` |
| Audio transcription | on by default (`afconvert`) | runtime pinned, `ffmpeg` path written, default off | `transcription-model.ts:155-163`, `built-in-transcriber.ts:176-200` |
| Built-in private model | on by default (Metal) | runtime pinned, CPU only (max four threads, `server.ts:123`), default off | `src/core/analyst-built-in.ts:58, 102-110` |
| zkAPI confinement | `sandbox-exec` profile, per-session self-test, refuses on failure | level `none` | `consult-transport-zkapi.ts:695, 769-808` |
| Open a source from a private answer, open an unreadable file | wired | not wired | `workers/email-source/server.ts:3536, 4704` |
| Standalone engine (ChatGPT path) | LaunchAgent with install, status, upgrade, uninstall | `assertDarwin` refuses; paths under `~/Library`; doctor skips it; uninstaller refuses | `src/core/engine-service.ts:89, 1426`, `src/core/doctor.ts:134`, `site/uninstall.sh:127` |
| ChatGPT install and copy | `scripts/install-macos.sh` | none; README, relay errors and plugin skills say Mac | `scripts/install-macos.sh:135`, `connect-relay/server/relay-mcp.ts:45`, `chatgpt-plugin/skills/olympus-setup/SKILL.md:52` |

Not in scope and staying Mac-only: live Apple Messages (the adapter reads a
Mac database, `workers/apple-messages/connector.ts:108`). Dropbox's
`~/Library/CloudStorage` fallback is harmless on Linux.

Host observations (2026-10-12, not code facts): Sparta runs Ubuntu 24.04,
kernel 6.8, x86_64, 16 threads, 28 GB RAM, AMD Barcelo iGPU; has `tesseract`,
`ocrmypdf`, `ffmpeg`; lacks `vips`, ImageMagick, `heif-convert`, `bwrap`;
`kernel.apparmor_restrict_unprivileged_userns = 1`. The demo box is Linux and
runs the engine through the worker path, not `olympus engine`.

Omarchy test laptop (2026-10-12, read-only survey): Omarchy 4.0.1, kernel
7.1.9-arch, x86_64, Intel i7-7567U (2 cores, 4 threads), 15 GB RAM, Intel
Iris iGPU. LSMs `capability,landlock,lockdown,yama,bpf` (no AppArmor);
Landlock ABI 9; unprivileged user plus network namespaces work without
admin (`unshare --user --net` succeeds); `bwrap` installed. gnome-keyring
provides the Secret Service; `secret-tool` present. `vipsthumbnail` with
libheif (HEIC load true), `heif-convert`, `magick`, `tesseract` and `ffmpeg`
installed; `ocrmypdf` absent and not in its pacman sync databases. `ufw`
on by default. Lingering off. No Bun; Node via mise. Consequences: W4's
namespace design needs no admin step on Omarchy; W3's preparer works with
stock packages; W1 must cover a host with tesseract but no ocrmypdf; the
laptop is the small-machine data point for W2.

## Principle: gate on capability, not on the OS name

Each `darwin` gate becomes a probe of the machine: the tool exists and a real
fixture passes through it, memory (including cgroup limits) is above the
floor, the measured speed meets a threshold. Mac behavior stays as it is.
A missing capability is reported with one exact remedy, and anything
deferred for it is reread automatically once the capability appears.

## Required test environments

Unsupported-host tests (tool missing, kernel lacking a feature) are separate
from enforcement tests, and enforcement tests may not skip silently.

- Omarchy (current release, real install or VM): W1, W3, W4, W5, including
  opening sources on the Hyprland desktop and the pacman remedy commands.
- Ubuntu 24.04, kernel 6.8, AppArmor userns restriction on: W1, W3, W4, W5.
- Linux arm64: W3 (LiteRT vision), W4 launcher, W5 install.
- Mac regression proof for every gate that changes.
- Real `tesseract`/`ocrmypdf`, real `vips` with libheif (JPEG and HEIC), and
  an assertion that LiteRT vision actually initialised, since the helper can
  fall back to text-only (`built-in-embedding/litert-helper.ts:278`).

CI runs `ubuntu-latest` (`.github/workflows/verify.yml:56`); the tool-backed
jobs pin `ubuntu-24.04` and install the tools; arm64 and the real-tool runs
use a named runner or a recorded Sparta/Delphi run per PR.

## Workstreams

### W1. Reading scans and pictures of text (small to medium)

1. Setup preflight and doctor probe the real OCR command (including the
   `--clean` dependency, `ocr.ts:382`) and report ready or the one distro
   command to fix it.
2. Text in images on Linux: the text lane uses tesseract when the probe
   passes, so a photographed receipt reads on Linux as it does on a Mac.
3. Recovery: PDFs and images settled as `ocr_required` while OCR was missing
   are reread, unchanged, once the probe passes (add the `reread` policy).
4. No bundling of tesseract.

Acceptance: missing tool → install tool → unchanged source reread to text,
for a PDF and an image, on Ubuntu 24.04; Mac unchanged.

### W2. Built-in models on by default on Linux (small code)

Owner decision 2026-10-12: Linux uses the same built-in models as the Mac
(Qwen3.5 for private answers, sized by memory as on the Mac; Qwen3-ASR for
transcription, same llama.cpp runtime), on by default. No speed floor: a
user whose machine is slow can switch to a cloud lane or a smaller model
themselves. The Omarchy laptop is a compatibility check, not a design
target.

1. Replace the `darwin-arm64` defaults with capability rules: private model
   = pinned runtime for the platform and enough memory (cgroup-aware) for
   the memory-sized model; transcription = the same plus a working
   `ffmpeg`. Env `on`/`off` still wins.
2. Measured 2026-10-12 for the record (CPU, production threads, 3,000-token
   prompt plus 300 tokens out): Sparta (Ryzen, 4 threads) 4B ≈ 110 s, 2B ≈
   45 s; Omarchy laptop (i7-7567U, 2 threads) 4B ≈ 3.4 min, 2B ≈ 80 s. A
   Vulkan build on the laptop's Intel iGPU was no faster. GPU builds stay
   out of scope.

Acceptance: unit tests for each rule; on Omarchy and Sparta a Private
question is answered and a voice note transcribed with no env settings.

### W3. Photos searchable on Linux (medium; Sparta stage 2)

1. A still-image preparer interface: `sips` on the Mac, `vipsthumbnail`
   (libvips with libheif) on Linux. Shared output contract: JPEG, long side
   ≤1,024 px, all current settle states kept (`unavailable`, `too_small`,
   `skipped_too_large`, retryable timeout and cache failures,
   `failed_terminal`).
2. New guarantees for both implementations, proven by fixtures: location and
   other metadata stripped; EXIF orientation applied (all eight, mirrored
   included; HEIC transforms); colour profile converted to sRGB;
   transparency flattened; decoder memory and pixel limits.
3. Per-format readiness replaces the boolean: a startup probe prepares one
   fixture per admitted format (jpeg, png, heic/heif, webp, gif, tiff, bmp).
   Admission, extraction and status all read the same per-format answer;
   formats the host cannot decode stay names-only and recoverable, and are
   queued when the capability appears. Owner-written exclusions are kept.
4. Before enabling: LiteRT vision initialises on linux-x64 and linux-arm64,
   fixture vectors match the Mac within tolerance, and the photo judge tiers
   its labelled set the same.
5. No global embedding-space migration. Newly prepared images are embedded
   and judged; images whose prepared bytes change are re-embedded, because
   the digest is part of the embedding input (`photo-embeddings.md:58`).

Acceptance: contract tests on both implementations; Ubuntu 24.04 and arm64
with JPEG and HEIC; Mac regression; Sparta end to end: a Dropbox photo found
by a content query, an iPhone HEIC included, a sensitive fixture tiered
Private.

### W4. zkAPI confinement on Linux (medium-large; security-critical, own PR, independent review)

Required properties, from the Mac profile (`consult-transport-zkapi.ts:695`)
and self-test (`:777-800`): the daemon and every child reach only the
session's own loopback ports; other loopback ports, remote addresses, IPv6,
IPv4-mapped IPv6, UDP, DNS and host Unix sockets fail fast; a per-session
self-test proves it before use; a selected confinement that fails refuses
the session.

Design: **hardened network namespace** as the parity mode. A launcher
creates user and network namespaces holding only loopback, bridges in the
session ports over Unix sockets it owns, and applies Landlock (TCP port
rules on the namespace's loopback, filesystem rules hiding host Unix
sockets) and seccomp (no UDP, no IPv6, no `io_uring`, no new namespaces),
with `no_new_privs`, all capabilities dropped and inherited descriptors
closed, before the daemon starts any thread. Children inherit all of it.

Where the namespace is unavailable (Ubuntu 23.10+ with the AppArmor userns
restriction and no profile allowing the launcher), two choices for the
owner: refuse the lane with a one-time admin step to enable it, or offer a
clearly named weaker mode (Landlock ports plus seccomp, no namespace) whose
statement says "TCP ports restricted; direct connections to remote
addresses on those ports remain possible", never labelled
`loopback_filtered` or `non_loopback_blocked`. systemd `IPAddressDeny=` is
rejected: a user manager cannot enforce it, and even when privileged it
leaves every loopback port and Unix sockets open.

Also in this workstream: port allocation and custody flags for each level
(today only `loopback_filtered` gets them, `:2447, 2482`); bridge ownership,
endpoint identity and crash cleanup, since listener inspection reads
`/proc/net/tcp*` and dispatch checks the listener's process group
(`:1751, 2499`); a Linux self-test using controlled local listeners (Unix
socket, other loopback port, a remote-address stand-in) instead of the Mac
resolver probe, and testing parent and exec'd child, bind restrictions and
bridge failure. The launcher ships from the zkapi fork or as a managed tool
with a pinned hash; query the Landlock ABI at runtime.

Acceptance: the full self-test matrix on Ubuntu 24.04 with the AppArmor
restriction on and off, and on arm64; refusal proven when confinement
fails; Mac unchanged.

### W5. Olympus without OpenClaw on Linux: engine service and install (large)

On Linux today Olympus runs only inside OpenClaw. The standalone engine,
which ChatGPT and other clients reach through the relay, refuses Linux.

1. `olympus engine` on Linux as a user systemd service: install, status,
   stop, restart, upgrade with rollback, process cleanup, uninstall, XDG
   paths, doctor coverage, Linux runtime pins.
2. `install-linux.sh` and a Linux uninstaller, same contract as the Mac
   scripts. "No administrator password" is promised only when dependencies
   are present and the user may enable lingering, so a headless box keeps
   serving after logout; otherwise the installer says exactly what is
   needed.
3. Headless secret backend qualified: no Secret Service or a locked one
   uses the encrypted-file store, never a silent "missing".
4. Opening sources from a private answer and unreadable files on a Linux
   desktop (`xdg-open`, same allowlist rules as the Mac); on a headless host,
   the existing remote-open path.
5. Copy: answer panel, dashboard, relay errors, plugin skills, manifest,
   README, install guide and site say "your computer" or name the host's
   kind.
6. Approval on a headless host through remote open.

Timing: lifecycle design and implementation start now in their own branch;
no change to the demo box (frozen at `de0b32e2`) or the listing's claims
until OpenAI finishes its review. Needs independent review before merge
(`docs/ENGINEERING_PROCESS.md:79`).

Acceptance: clean Ubuntu 24.04 user install; approve from a second
machine; one Private and one Personal answer in ChatGPT; reboot and logout
survival; failed upgrade rolls back; interrupted install recovers;
uninstall leaves nothing.

## Sequencing

Independent work runs in parallel and lands when proven:

- Now: W1; W2 measurement; W3 (Sparta stage 2); W4 namespace prototype on
  Sparta; W5 lifecycle design.
- W4 lands after independent review.
- W5's user-facing copy, listing and demo-box changes after the OpenAI
  review closes.

## Decisions for the owner

Decided 2026-10-12: built-in models on by default on Linux (W2); photos
the host cannot decode are reported, the rest indexed (W3); Omarchy is a
first-class target.

zkAPI on a host that cannot run the namespace (stock Ubuntu without the
admin step): the lane is refused and the one-time admin step offered; no
weaker mode (decided 2026-10-12).

Priority (2026-10-12): Omarchy first. If Ubuntu support proves
disproportionately hard, Ubuntu may be dropped and Sparta moved to Omarchy.
The test machine is the owner's Omarchy laptop.

## Out of scope

Windows (planned separately in `windows-wsl.md`); video content; GPU builds of llama.cpp; bundling OCR or image
libraries; live Apple Messages; any demo-box or listing change during the
OpenAI review.
