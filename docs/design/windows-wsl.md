# Olympus on Windows through WSL2

Status: plan, 2026-10-13. Nothing built. Not scheduled: the owner decides
whether it lands before or after launch.

## Outcome

A Windows 10/11 user installs Olympus with one command, connects ChatGPT,
and gets the Linux product: Personal and Private answers, scans and photos
read, voice notes transcribed, sources open in their Windows browser, and
the engine keeps serving while they are signed in to Windows, with no
terminal window open. Olympus runs inside WSL2 (Windows' built-in Linux);
the Windows side gets only a launcher, a keep-alive task and a link
handler. Apple Messages is out of scope, as on Linux.

Native Windows (no WSL) is not planned. It would need Windows builds of
LiteRT, llama.cpp and zkapi-clientd, a Windows answer to zkAPI confinement,
Windows file permissions for secrets, and a Windows service manager:
weeks of work for no difference a user would notice. Revisit only if
WSL proves to be a real barrier for users.

## Depends on Linux parity

WSL2 is Linux, so this plan is a small layer on `linux-parity.md`, and that
plan has to land first:

| Linux workstream | State on main (`f1893c87`) | Needed for Windows |
|---|---|---|
| W1 scans, W2 built-in models, W3 photos | landed (#302, #299, #303) | yes, as is |
| W4 zkAPI confinement | designed (#307), not built | for the zkAPI lane only |
| W5 standalone engine and `install-linux.sh` | designed (#305), not built; `engine-service.ts` still refuses non-Mac | yes: this is the ChatGPT path |

So the real cost of Windows is W5 (large, already planned for Linux) plus
the Windows layer below (about 1–2 weeks including a real-machine test).
Without W5 there is nothing for WSL to run.

## Target distro

W5 qualifies Omarchy first and explicitly skips Ubuntu. On Windows the
default `wsl --install` distro is Ubuntu 24.04, so the Windows path makes
Ubuntu 24.04 (inside WSL) a qualified target. WSL's Ubuntu has no AppArmor
user-namespace restriction, so W4's namespace design should run there
without the admin step it needs on stock Ubuntu; this is a probe, not a
claim (see W-4).

## What is different on WSL (and the work for each)

Detect WSL with a probe that works inside the systemd user service, where
`WSL_DISTRO_NAME` can be absent (microsoft/WSL#9719): the kernel release
names Microsoft and `/proc/sys/fs/binfmt_misc/WSLInterop` exists. The
installer also records the distro name in the engine's install receipt,
since the keep-alive task and link handler call `wsl.exe -d <distro>`.
Test detection under the real user service, not only in a shell. Report
the host as "Windows (through WSL)" in doctor, the dashboard and
copy. Every item below gates on a capability probe, as linux-parity does.

### W-1. One-command Windows install (medium)

`install-windows.ps1`, run from PowerShell as the ordinary user:

1. WSL2 present with a supported distro → continue. Missing → run
   `wsl --install -d Ubuntu-24.04`. **This needs administrator approval
   and usually a restart**; the script says so before it starts and resumes
   after the restart. This breaks the "no installs beyond Venice" promise
   for Windows users who don't already have WSL (decision below).
2. Inside the distro: ensure systemd is on (`/etc/wsl.conf` `[boot]
   systemd=true`; current Ubuntu images default to it), then run
   `install-linux.sh` from W5 unchanged.
3. Install the W-2 keep-alive and the W-3 link handler (both per user, no
   administrator).
4. Finish with the same ChatGPT connect step as the Mac.

Uninstall reverses 3 and runs the Linux uninstaller; it never removes the
user's WSL distro or WSL itself.

### W-2. Keep the engine running (small, must verify)

WSL stops the Linux VM shortly after the last Windows-launched process
exits, even when systemd services are running, so a user service alone
stops serving when the terminal closes. `.wslconfig` idle-timeout settings
are reported unreliable across WSL versions. Plan: a per-user Task
Scheduler task at sign-in that runs a hidden, long-lived process in the
distro (`wsl.exe -d <distro> --exec` a small Olympus keep-alive), which
also starts the engine after a Windows restart. Acceptance must prove:
close every terminal, wait an hour, ask a question from ChatGPT; restart
Windows, sign in, ask again; sleep and wake, ask again.

Limit to state plainly: Olympus serves while the user is signed in to
Windows, not before sign-in (W5's lingering has no WSL equivalent without
an administrator service).

### W-3. Open sources and `olympus://` links in Windows (small)

`xdg-open` inside WSL does not reliably reach the Windows browser (`wslu`
is not guaranteed on Ubuntu 24.04). Add a WSL opener: URLs through
`explorer.exe` / `cmd.exe /c start` via interop, file paths converted with
`wslpath -w` first, keeping the Mac's allowlist rules (`open-on-computer.md`).
Register `olympus://` for the Windows user (HKCU, no administrator) so the
ChatGPT panel's "do this on your computer" links run `olympus open` inside
the distro.

### W-4. zkAPI confinement probe (small, after W4)

Run W4's self-test matrix on the current WSL kernel. Landlock has been in
WSL kernels since 5.15 and user namespaces are enabled, but Microsoft has
trimmed kernel configs since; probe at runtime, and if confinement fails
the lane is refused, as decided for Linux. No weaker mode.

### W-5. Files on the Windows side (small to medium)

Windows folders (Dropbox, OneDrive, Pictures) appear under `/mnt/c`. Reads
across that boundary are slow and file-change notifications do not cross
it. Any source that reads a local folder must fall back to periodic
rescans there, and the folder picker should start at the user's Windows
home. API-based sources (Gmail, Drive, Dropbox API) are unaffected.

### W-6. Smaller items (small)

- Secrets: WSL has no unlocked Secret Service, so W5's encrypted-file store
  is the path; W5 item 3 already requires it be qualified.
- Memory: the WSL VM gets half the PC's memory by default; W2's
  cgroup-aware probe sizes the built-in model from what the VM sees.
  Doctor names `.wslconfig` `memory=` as the remedy when the model is
  sized down.
- Dashboard: WSL forwards `localhost`, so `olympus dashboard` opens in the
  Windows browser; verify on default (NAT) and mirrored networking.
- Clock: WSL's clock can drift after sleep; doctor checks skew because
  sign-in tokens depend on it.
- Copy: setup skill, README, site and relay errors gain a Windows line
  after the OpenAI directory review closes (same freeze as W5 copy).

## Test environment

GitHub's hosted Windows runners cannot run WSL2 (no nested
virtualization), so CI covers only unit tests for WSL detection, the opener
and path conversion. Qualification needs a real Windows 11 PC or a cloud VM
with nested virtualization (e.g. an Azure Dv5), recorded per PR, as the
Linux plan does for Sparta.

Acceptance: on a Windows 11 machine without WSL, the install script
completes (including the restart), ChatGPT connects, one Personal and one
Private answer, a source opens in the Windows browser from an answer, a
photo in a connected Dropbox folder is found by content (a photo in the
Windows `Pictures` folder only once a local-folder source exists, W-5), and the W-2 survival checks pass;
uninstall leaves Windows and the distro as they were apart from the
removed Olympus pieces.

## Sequencing

1. W5 lands for Linux (already planned; the dependency).
2. W-1, W-2, W-3 and W-6 together, as one critical PR (install and
   service-manager behavior), with independent review.
3. W-4 after W4 lands; W-5 alongside whichever local-folder source ships
   first.
4. Copy and listing changes after the OpenAI review closes.

## Decisions for the owner

1. **Before or after launch.** Recommendation: after. The Windows layer is
   small, but it rides on W5, which is not built, and it needs a Windows
   test machine.
2. **Windows users without WSL** must approve an administrator prompt and
   restart once. Accept that for Windows (recommended), or limit Windows
   support to users who already have WSL.
3. **Serving only while signed in to Windows.** Accept (recommended); the
   alternative is an administrator-installed Windows service, which adds an
   admin step for every user.
