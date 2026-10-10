---
name: olympus-setup
description: Help the user install Olympus on their Mac and connect it to ChatGPT. Use when the user wants to set up or connect Olympus, when the Olympus dashboard says Olympus isn't on the Mac, or when Olympus tools report that Olympus is not connected.
---

# Set up Olympus on a Mac

Olympus answers from the user's own sources with an engine that runs on their
Mac. ChatGPT reaches it through `https://mcp.olympusplugin.ai/openai/mcp`, and the
user approves ChatGPT on the Mac with one click.

## The one install command

Olympus is installed with exactly this command, which the user runs
themselves in Terminal on their Mac:

```
curl -fsSL https://olympusplugin.ai/install.sh | sh
```

It is also on https://olympusplugin.ai/install/. You never run it, or any
other command, yourself: you show it to the user and they run it. Do not
write, search for or suggest any other install command for Olympus: no
`npm`, `bun`, `brew` or `git clone`, no other URL, and nothing from another
site. Never suggest `sudo`, and never ask the user to edit files by hand.

## 1. Check what is already there

Call `olympus_dashboard`.

- `connection.state` `ready` or `installing`: Olympus is installed and
  connected. Show the dashboard and stop.
- The call fails with "Your Mac is offline": Olympus is installed but the Mac
  is asleep or Olympus is not running. Ask the user to wake the Mac, and point
  them to https://olympusplugin.ai/help/mac-offline/. Then try again.
- The dashboard says Olympus isn't on the Mac, or a tool says Olympus is not
  connected: ChatGPT is not connected to an Olympus engine yet. That is also
  what it says when Olympus is installed but not yet connected, so continue
  with step 2.

## 2. Install, then connect

Ask whether Olympus is already installed on their Mac.

- **It isn't, or they are not sure:** check that they have a Mac with Apple
  silicon (M1 or later) and macOS 13 Ventura or later. Intel Macs are not
  supported: say so plainly and stop. Otherwise tell them to open
  **Terminal** (in Applications, then Utilities), paste the install command
  above, and press Return. It needs no administrator password and installs
  for their macOS user only. It takes a minute or two and ends with "Olympus
  is installed and running". If it stops with a message instead, ask them to
  read it to you, explain it plainly, and point them to
  https://olympusplugin.ai/support/; do not suggest other commands. Running
  the same command again is safe. When it has finished, continue below.
- **It is:** continue below.

To connect, ChatGPT asks the user to connect Olympus (sign in) the first time
a tool needs it. The page that opens must be in a browser on the Mac running
Olympus: it asks to connect ChatGPT, and the user clicks **Approve**. That
click on their own Mac is the only proof of ownership: there is no code to
copy and no account to create. If they want to check that Olympus is
running, they can run `olympus engine status` in a new Terminal window (it
prints `"ok": true` when it is).

## 3. Confirm

Call `olympus_dashboard` again. When it answers, tell the user Olympus is
connected and point them to the Olympus dashboard in the ChatGPT sidebar to
connect their first sources: Dropbox, Gmail or Google Drive, signing in with
accounts they already have. Other sources the dashboard lists (such as X
bookmarks, Readwise, Telegram or WhatsApp) are connected in Olympus on the
Mac. Indexing starts on its own. Olympus downloads its built-in models in the
background after install, so the first answers can take a while.

## Uninstall

If the user asks how to remove Olympus, point them to
https://olympusplugin.ai/install/#uninstall: one command in Terminal removes
Olympus and keeps their data unless they delete it first.

## If something fails

Report what the dashboard, the installer or the error says, in plain
language, and stop. Do not retry with different commands or flags.
