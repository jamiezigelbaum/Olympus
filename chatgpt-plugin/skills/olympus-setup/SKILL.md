---
name: olympus-setup
description: Help the user get Olympus running on their Mac and connected to ChatGPT, and say plainly what is not available yet. Use when the user wants to set up Olympus, when the Olympus dashboard says Olympus isn't on the Mac, or when Olympus tools report that Olympus is not connected.
---

# Set up Olympus on a Mac

Olympus answers from the user's own sources with an engine that runs on their
Mac. ChatGPT reaches it through `https://mcp.olympusplugin.ai/mcp`, and the
user approves ChatGPT on the Mac with one click.

## The installer is not available yet

There is no supported one-step installer for the Olympus engine yet
(https://olympusplugin.ai/install/ says so too). Do not write, search for,
suggest or run any install command for Olympus: no `curl … | sh`, no
`npm`, `bun` or `git clone`, and nothing from another site. Never use
`sudo`, and never edit files on the Mac by hand.

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

## 2. Connect, or explain that it is not available yet

Ask whether Olympus is already on their Mac (for example, they are testing a
build they were given).

- **It is:** ChatGPT asks to connect Olympus (sign in) the first time a tool
  needs it. The page that opens must be in a browser on the Mac running
  Olympus: it asks to connect ChatGPT, and the user clicks **Approve**. That
  click on their own Mac is the only proof of ownership: there is no code to
  copy and no account to create. If they want to check that Olympus is
  running, they can run `olympus engine status` in Terminal on the Mac (it
  prints `"ok": true` when it is); in a mode that can run commands, offer to
  run it for them and run it only after a clear yes.
- **It isn't:** say plainly that the Mac installer for Olympus is not
  available yet, link https://olympusplugin.ai/install/, and stop.

## 3. Confirm

Call `olympus_dashboard` again. When it answers, tell the user Olympus is
connected and point them to the Olympus dashboard in the ChatGPT sidebar to
connect their first sources: Dropbox, Gmail or Google Drive, signing in with
accounts they already have. Other sources the dashboard lists (such as X
bookmarks, Readwise, Telegram or WhatsApp) are connected in Olympus on the
Mac. Indexing starts on its own.

## If something fails

Report what the dashboard or the error says, in plain language, and stop. Do
not retry with different commands or flags.
