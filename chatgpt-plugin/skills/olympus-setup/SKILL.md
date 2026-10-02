---
name: olympus-setup
description: Install the Olympus engine on the user's Mac from the ChatGPT desktop app and link it to ChatGPT. Use when the user wants to set up Olympus, when the Olympus dashboard says "Install on your Mac", or when Olympus tools report that the Mac is not set up.
---

# Set up Olympus on a Mac

Olympus answers from the user's own sources with an engine that runs on their
Mac. ChatGPT reaches it through `https://mcp.olympusplugin.ai/mcp`. Setup puts
the engine on the Mac and approves ChatGPT on the Mac with one click.

This needs the ChatGPT desktop app on macOS, in a mode that can run shell
commands with the user's approval. On the web or on a phone, tell the user to
open the ChatGPT desktop app on their Mac and ask again there.

## 1. Check whether it is already installed

Call `olympus_dashboard`. If it answers with `connection.state` `ready` or
`installing`, the engine is installed and linked: show the dashboard and stop.
If the call fails with "Your Mac is offline", the engine is installed but the
Mac is asleep or Olympus is not running: ask the user to wake the Mac or open
Olympus, then try again. Only continue when the dashboard says Olympus is not
installed or the tools are not linked yet.

## 2. Show the install command, then wait for approval

<!-- TODO(packaging): replace with the signed installer once it ships. The
     command below is a placeholder until install.sh and the .pkg exist. -->

Show the user exactly what will run, and what it does, before running
anything:

```sh
curl -fsSL https://olympusplugin.ai/install.sh | sh
```

Say, in plain words:

- It installs Olympus for this macOS user only. No administrator password and
  no other apps or accounts are needed.
- It starts Olympus in the background (a per-user LaunchAgent) and opens an
  approval page on this Mac.
- Nothing from the user's files leaves the Mac during install.
- It downloads a built-in search model (about 225 MB) and, on a Mac with
  Apple silicon, a private answer model that stays on the Mac (about 1.3 GB
  with 8 GB of memory, about 2.7 GB with 16 GB or more). The private model
  waits while the disk has less than its size plus 2 GB free.

Ask: "Run this now?" Run it only after a clear yes. Never run it without that
answer, and never change the command.

## 3. Approve ChatGPT on the Mac

When the install finishes, Olympus opens a page on the Mac asking to connect
ChatGPT. Tell the user to click **Approve** there. That click, on their own
Mac, is the only proof of ownership: there is no code to copy and no account
to create.

## 4. Confirm

Call `olympus_dashboard` again. When it answers, tell the user Olympus is set
up and point them to the Olympus dashboard in the ChatGPT sidebar to connect
their first sources (local files and notes first, then accounts like Gmail,
Google Drive or Dropbox). Indexing starts on its own.

## If something fails

Report the installer's last few lines of output in plain language and stop.
Do not retry with different flags, do not use `sudo`, and do not edit files on
the Mac by hand.
