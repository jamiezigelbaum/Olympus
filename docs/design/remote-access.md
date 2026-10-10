# Open Olympus on your computer when it runs on a server (remote mode)

Owner decisions, 2026-10-10 (design pass of that day, sections 2, 3, 5 and 6):

1. OpenClaw users get the agent route at onboarding, with one approval.
2. The engine declares remote mode; the panel does not infer it from a
   missing `olympus://` answer.
3. Users with only the Mac app (no CLI node, so no exec route) get the
   copy-paste lines, plus an optional `openclaw node install` that unlocks
   the agent route.

Telegram and WhatsApp pairing from a phone is out of scope.

## The problem

Some screens only work in a browser that reaches the engine: entering keys,
the X sign-in, Telegram and WhatsApp pairing. On one computer,
`olympus://open/...` handles this (docs/design/open-on-computer.md). When
Olympus runs on a server, the user's browser is on another machine, and the
dashboard is a port on the server's loopback that nothing outside reaches.

## What every route does

One mechanism for everyone: an SSH tunnel from the user's computer to the
engine's port, then a one-time opening link from the server, opened in the
computer's browser. Only who types the commands differs.

By hand (Hermes, the Mac app without a CLI node, anyone):

```
ssh -N -L PORT:127.0.0.1:PORT you@your-server        # on your computer
olympus dashboard --no-open --target connect/x        # on the server; open the printed link
```

The agent route (OpenClaw with a paired node that runs commands): the owner
asks "open Olympus on my computer"; the assistant calls
`olympus_open_remote {target}` and runs the two commands it returns on the
node (`exec host=node`).

## Why the tunnel must use the engine's own port number

Verified against the code (`core/dashboard-launch.ts`, `workers/http.ts`)
and proved through a real forwarded port (`test/remote-open.test.ts`):

- `olympus dashboard` on the server mints the ticket by POSTing to its own
  worker with `Origin: http://127.0.0.1:PORT`; the ticket is bound to that
  origin (a hash of the full origin, port included).
- The browser redeems it with its own origin. Through `ssh -L PORT:...` the
  browser is at `http://127.0.0.1:PORT`, sends that `Origin` and `Host`, and
  the worker sees exactly what it minted for: the ticket redeems, and the
  control cookie it sets is tagged with the same origin.
- Through a tunnel on another local number L, the browser's origin is
  `http://127.0.0.1:L`. The redeem is refused (`403`,
  `dashboard_launch_origin_mismatch`, "This opening link is no longer
  valid"), and the ticket is NOT used up: with the tunnel moved to PORT, the
  same link still opens. A session unlocked on one port number is likewise
  refused on another.

So the instructions always repeat the engine's port on both sides, and the
agent's tunnel uses `-o ExitOnForwardFailure=yes`, so a busy port fails at
once instead of leaving a tunnel that cannot work.

## The declaration (remote mode)

`OLYMPUS_SERVER_MODE` in worker.env: `on`, `off` or `auto` (default).
`auto` treats a Linux or other Unix host with no desktop session (neither
`DISPLAY` nor `WAYLAND_DISPLAY`) as a server, and macOS and Windows as a
computer someone sits at. `OLYMPUS_SERVER_SSH_TARGET` is how the owner's
computer reaches the server (`user@host` or an ssh_config name), when known.
Set both with `olympus server-mode on --ssh-target you@your-server`; the
install guide does this at onboarding for server installs. The worker reads
worker.env on every dashboard read, so no restart is needed (worker.env wins
over the environment the worker started with, which would pin an old value).

The worker surfaces it as `remote: { port, sshTarget?, agent }` on the
dashboard view model (contract v1 addition), allowlisted field by field in
the response builder. `agent` is true when the OpenClaw Gateway supervises
the worker, so "Ask your assistant" is offered only where an assistant can
act on it; Hermes and a hand-run worker get the two lines only.

## The panel

In remote mode, a control that would open an olympusplugin.ai `/open/` page
(Connect for X, Readwise, Telegram and WhatsApp, and every "Fix this on your
computer") opens a box in place instead:

- "Ask your assistant: Open Olympus on my computer" (to connect the source,
  for a Connect), with Copy, when `agent` is true;
- the two lines with the real port (and the SSH name when set), each with
  Copy;
- "Keep PORT on both sides of the tunnel: the link only works on that port."

ChatGPT's sandbox blocks the clipboard API, so Copy selects the line and asks
the browser to copy the selection; where that is refused, the line stays
selected and the button says to press the copy keys. On the computer's own
dashboard (the host page) nothing changes.

The olympusplugin.ai `/open/<target>/` pages carry the same two lines under
"If Olympus runs on a server". A static page cannot know the port, so it
shows the default (8010) and says to use the printed link's number on both
sides.

## The agent tool: `olympus_open_remote {target}`

`src/core/remote-open-tool.ts`. Native OpenClaw surface only.

- **Owner, in a direct chat.** The native tool factory sets
  `ownerAgentSession` for each call from OpenClaw's own tool context
  (`isOwnerDirectTurn`): `senderIsOwner` must be true AND the session key
  must be a direct session, not a cron, sub-agent, ACP, hook, group or
  channel run; no session key is refused. Nothing else sets it and it is
  never read from params. OpenClaw does not tell a plugin tool what
  triggered the turn (its tool context has no trigger or run kind), so a
  heartbeat in the owner's main session cannot be told apart; see the
  residual below.
- **Closed target list.** `target` must be one of `core/open-targets.ts`
  (`dashboard`, `connect/<x|readwise|telegram|whatsapp>`,
  `fix/<connect|reconnect|answers|search|models>`); any other param is
  refused, and so is a `computer` other than `macos`, `linux` or `windows`.
  A prompt-injected call can at most open one of these screens, and the
  node still asks the owner before the tunnel starts.
- **Minted last.** Every refusal (owner, target, params, not a server, engine
  not on loopback) happens before the ticket is minted; nothing logs the link
  or puts it in an error.
- **A remote ticket.** It is minted with `?purpose=remote`: it lives two
  minutes (enough to run the tunnel, then open) instead of the CLI's
  fifteen, and minting one revokes any earlier remote ticket not yet
  redeemed, so at most one is ever live.
- **Returns**, for the one `computer` named, the tunnel and open commands
  (the link appears exactly once, inside `open`; the native result's
  `details` leave it out), the engine port, where it lands
  (`/dashboard?keys` for Keys targets, else `/dashboard`), the SSH name (or
  null, with the placeholder to replace) and the by-hand lines:
  - tunnel: `ssh -f -o ExitOnForwardFailure=yes -L 127.0.0.1:PORT:127.0.0.1:PORT TARGET sleep 1800`
    (bound to 127.0.0.1 only; closes itself once the server-side `sleep`
    ends and the browser's connections close, so there is no kill step to
    forget). Windows' ssh cannot fork with `-f`: the same command without it,
    run as a background exec.
  - open: `open '<link>'` (macOS), `xdg-open '<link>'` (Linux),
    `cmd /c start "" "<link>"` (Windows).
  Every interpolated value is validated (integer port, SSH name pattern, the
  minted link's exact shape) before it reaches a command line.

## Approvals on the node (design section 5)

The onboarding step (INSTALL_FOR_AGENTS.md, "Olympus on a server") asks the
owner once and then adds one allowlist entry on the node: the opener
(`/usr/bin/open` on macOS, `xdg-open` on Linux). `ssh` is deliberately NOT
allowlisted: an allowed ssh with arbitrary arguments can run anything on the
server, so each tunnel asks the owner once ("Allow once"). That needs the
node's ask mode to be `on-miss` (or `always`); the step checks
`openclaw approvals get --node` and tells the owner if it is not, rather
than changing the node's policy. A node already in `full` needs no entries.
The user-facing page is docs/openclaw-node-setup.md.

## Threat model

- **The link is a bearer ticket.** It sits in the exec arguments on the node,
  in the node's approval prompt and logs, and in the agent's transcript on
  the gateway. It is single use, expires in 2 minutes, is revoked by the
  next remote ticket, and grants only the
  control session `olympus dashboard` grants (not the worker token, and never
  the local grade Outside help needs). Its origin binding means it only
  redeems at `http://127.0.0.1:PORT`.
- **Tunnel exposure (corrects the design note).** The tunnel listens on
  127.0.0.1 on the computer, not on all interfaces, so nothing on the network
  reaches it, and no web page can use it: a browser always sends the page's
  own `Origin`, which the dashboard refuses, and a rebinding host name is not
  a loopback origin. But the design note's "they would still need a ticket or
  the token" does not hold for local programs: the dashboard's local-only
  mint (`POST /dashboard/control/session/local`, for Outside help) gives a
  control session, local grade, to any request that arrives from a loopback
  peer with a loopback `Origin`, with no secret. Through a tunnel the
  engine's peer is sshd on loopback, so while a tunnel is up, any program or
  other account on the computer that can open 127.0.0.1:PORT can unlock the
  dashboard, as any program on the server already can. This is true of the
  by-hand `ssh -L` tunnel people already use, not new with this feature; the
  agent's tunnel narrows the window by closing itself (30 minutes after it
  starts, once the browser's connections close). Removing it would mean the
  local mint refusing in remote mode or requiring a secret; that is a
  separate decision (it changes Outside help on servers).

- **Who can trigger it.** Only the owner in a direct session (OpenClaw's
  `senderIsOwner` and a direct session key); the tunnel still needs the
  owner's approval on the node each time.
- **Nothing passes through the relay or ChatGPT.** Keys are typed into the
  dashboard in the owner's own browser. ChatGPT sees the port and, if the
  owner set one, their own SSH name.
- **Residual (independent review, 2026-10-10):** a document the owner asks
  the assistant to read during their own direct turn, or a heartbeat run in
  the owner's main session, could get a ticket minted without the owner
  asking to open anything; OpenClaw exposes no trigger to tell these apart.
  What that buys: one ticket, live two minutes, revoked by the next, which
  redeems only on the engine's loopback port (so only through a tunnel the
  owner approved on their computer, or on the server itself), and opens one
  of the listed screens. It cannot pass anything through the link.
