---
name: olympus-setup
description: Help the user install Olympus on their Mac and connect it to ChatGPT. Use when the user wants to set up or connect Olympus, when the Olympus dashboard says Olympus isn't on the Mac, or when Olympus tools report that Olympus is not connected.
---

# Set up Olympus on a Mac

Olympus answers from the user's own sources with an engine that runs on their
Mac. ChatGPT reaches it through `https://mcp.olympusplugin.ai/openai/mcp`, and the
user approves ChatGPT on the Mac with one click.

## Where to install it

Olympus is installed from one page: https://olympusplugin.ai/install/. It
shows the single install step and what it does. You never run anything
yourself, and you do not repeat, write or suggest install commands: send the
user to that page. Do not suggest `npm`, `bun`, `brew`, `git clone`, `sudo`,
another site or editing files by hand.

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
  supported: say so plainly and stop. Otherwise send them to
  https://olympusplugin.ai/install/ and ask them to follow it on their Mac.
  It needs no administrator password, installs for their macOS user only,
  takes a minute or two and ends with "Olympus is installed and running". If
  it stops with a message instead, ask them to read it to you, explain it
  plainly, and point them to https://olympusplugin.ai/support/. When it has
  finished, continue below.
- **It is:** continue below.

To connect, ChatGPT asks the user to connect Olympus (sign in) the first time
a tool needs it. The page that opens must be in a browser on the Mac running
Olympus: it asks to connect ChatGPT, and the user clicks **Approve**. That
click on their own Mac is the only proof of ownership: there is no code to
copy and no account to create.

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
https://olympusplugin.ai/install/#uninstall, which explains how to remove
Olympus and keep or delete their data.

## If something fails

Report what the dashboard, the installer or the error says, in plain
language, and stop. Do not suggest commands or workarounds.
