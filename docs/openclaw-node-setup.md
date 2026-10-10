# Open Olympus on your computer when it runs on a server (OpenClaw)

If Olympus runs on a server, some screens still have to open in a browser on
your own computer: entering keys, signing in to X, pairing Telegram or
WhatsApp. Olympus does this through a secure tunnel from your computer to the
server, and a one-time link that opens the dashboard already unlocked.

You can let your assistant do it for you, or do it yourself. Both work the
same way; the design and security notes are in
[design/remote-access.md](design/remote-access.md).

## 1. Tell Olympus it runs on a server

On the server:

```
olympus server-mode on --ssh-target you@your-server
```

`you@your-server` is how your computer signs in to the server over SSH (the
same name you use with `ssh`). Olympus usually works this out by itself on a
server with no screen; this makes it certain, and fills in the commands the
dashboard shows you. Check it any time with `olympus server-mode status`.

## 2. Let your assistant open it for you (optional)

Your assistant can run commands on your computer only through a paired
**node** that runs commands. Check in the OpenClaw Control UI under
**Nodes**, or ask your assistant to run `openclaw nodes status`: you need a
node for your computer that offers `system.run`.

**If you only installed the OpenClaw app on your computer**, it may not run
commands. You can add the command-running node with one command on your
computer (it pairs with your server's gateway, and you approve it once):

```
openclaw node install --host <your-gateway-host> --port 18789 --display-name "My computer"
```

This is optional. Without it, Olympus shows you the two lines to copy
instead (step 3), which do the same thing.

**Approvals.** During setup your assistant asks you once, then allows your
computer's opener (`open` on a Mac, `xdg-open` on Linux) for Olympus links:

```
openclaw approvals allowlist add --agent main --node "My computer" "/usr/bin/open"
```

`ssh` is not allowed ahead of time. Each time your assistant starts the
tunnel, your computer asks you to approve that one command. Choose **Allow
once**, not "Always allow": an always-allowed `ssh` could run anything on
your server. This needs your node to ask when a command is not on its list
(`openclaw approvals get --node "My computer"` shows `ask: on-miss`); if it
never asks, your assistant will tell you instead of changing your settings.

**Using it.** Ask your assistant: **Open Olympus on my computer** (or "...to
connect X bookmarks"). It runs two commands on your computer, you approve the
tunnel, and Olympus opens in your browser. You do the typing there: keys and
sign-ins never go through the assistant or the chat. The tunnel closes itself
after about 30 minutes, once you are done.

## 3. Or do it yourself

The dashboard shows these two lines with your real port when Olympus runs on
a server (choose **Connect** or **Fix this on your computer**). On your
computer:

```
ssh -N -L 8010:127.0.0.1:8010 you@your-server
```

Then on the server, run this and open the link it prints in your computer's
browser:

```
olympus dashboard --no-open
```

Add `--target connect/x` (or `connect/readwise`, `connect/telegram`,
`connect/whatsapp`, `fix/models`) to land on that screen. Press Ctrl+C in the
first window to close the tunnel when you are done.

**Use the same port number on both sides.** The link only works on the port
Olympus runs on (8010 unless the printed link says otherwise). A tunnel on a
different local number shows "This opening link is no longer valid"; move the
tunnel to the right number and open the same link again. If ssh says the port
is already in use, something on your computer already uses that number (for
example another Olympus); close it first.

## Hermes and other assistants

Hermes has no way to run commands on your computer, so use step 3. Run step
1 as `olympus server-mode on --ssh-target you@your-server --agent-route off`
so the dashboard shows only the two lines, not "Ask your assistant".
