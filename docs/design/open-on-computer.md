# Open Olympus on the computer from ChatGPT (option C)

Owner decision, 2026-10-09: a "do this on your computer" action in the
ChatGPT panel (Connect for X bookmarks, Readwise, Telegram and WhatsApp, and
every "Fix this on your computer" link) opens Olympus on the computer
directly, with no Terminal step. Keys stay on the computer; the relay stays a
pass-through and is not involved.

## How it works

1. The panel opens `https://olympusplugin.ai/open/<target>/` (it may only open
   olympusplugin.ai links). The page is static (`scripts/build-open-pages.ts`
   writes `site/open/`): it tries `olympus://open/<target>` once with a meta
   refresh, offers the same link as a button, and always shows the two steps
   by hand (run `olympus dashboard`, then the named control) for a phone or a
   computer without the handler. No script, no tracking, nothing third-party.
2. The browser asks whether to open Olympus. The `olympus://` handler runs
   `olympus open <link>` (`src/cli.ts` runOpenCommand):
   - macOS: `~/Library/Application Support/Olympus/Olympus.app`, an
     AppleScript applet built on the Mac by `osacompile`, with
     `CFBundleURLTypes` for `olympus`, re-signed ad hoc and registered with
     LaunchServices (`src/core/open-handler.ts`). `olympus engine install`
     (which the installer runs) builds it; `olympus engine uninstall` and
     `site/uninstall.sh` remove it.
   - Linux: `~/.local/share/applications/ai.olympusplugin.open.desktop` with
     `MimeType=x-scheme-handler/olympus`, made the default by `xdg-mime`.
     `olympus worker install` adds it on a desktop session; `olympus worker
     uninstall` removes it and its `mimeapps.list` entry.
   - Either: `olympus open-handler install|uninstall|status`.
   - Both run Bun with `--no-env-file` from the package's own folder (the
     applet `cd`s there; the desktop entry sets `Path=`), as the engine's
     LaunchAgent does. A browser can start the handler from any folder, and
     Bun would otherwise read that folder's `.env` (which could point the
     worker token at another host) and `bunfig.toml` (whose `preload` runs
     code).
   - Install and uninstall refuse to run as root, or with a home folder that
     belongs to another user (sudo keeps HOME on macOS), and never replace or
     remove an `Olympus.app` or desktop entry Olympus did not write.
3. `olympus open` reads the link against a closed list
   (`src/core/open-targets.ts`): `dashboard`, `connect/{x,readwise,telegram,whatsapp}`,
   `fix/{connect,reconnect,answers,search,models}`. Any other `olympus:` link
   opens the plain dashboard; anything else opens nothing. It then does
   exactly what `olympus dashboard` does: asks this install's own worker for a
   single-use 15-minute ticket and opens `/dashboard/launch#…` in the default
   browser, adding `olympus_open=<token>` for a target.
4. The opening page redeems the ticket for the usual control session, checks
   the token against the same list. A Keys target (Connect for a source set
   up on the computer, or a model fix) lands on `/dashboard?keys#olympus-open=<token>`,
   where the controller opens that source's Connect panel (or Models) and
   focuses it; it submits nothing. Any other target (the dashboard, a
   ChatGPT connect or reconnect fix) lands on `/dashboard`.

## Threat model

Any website can fire an `olympus://` link; the browser asks the user first,
but a user may click through. So:

- **A link changes no data.** An accepted link does exactly what
  `olympus dashboard` does today: it mints an in-memory, single-use,
  15-minute ticket, opens the local dashboard in the default browser, and
  that browser redeems the ticket for the usual control session (HttpOnly,
  `SameSite=Strict`, origin-tagged, 30 days; the same session the manual
  unlock and `olympus dashboard` mint, and no longer). So an accepted link
  can unlock this computer's own browser, as running `olympus dashboard`
  would; the difference is that a website, not the Terminal, asked for it,
  behind the browser's "Open Olympus?" prompt. The page then opens a panel
  and never submits a form (not even a publisher panel's one-click sign-in,
  which starts only on a real click). No setting, source, key or sign-in
  changes without the user acting in the dashboard.
- **Nothing in a link is passed through.** The handler matches exact
  strings from a closed list; the applet hands the link to the shell only as
  AppleScript's `quoted form of`, and the desktop entry passes it as `%u`.
  Unknown, malformed or hostile links open the plain dashboard or nothing.
- **Another site cannot drive the unlocked dashboard.** The ticket travels
  only in a fragment the opening page clears before any request. The control
  session cookie is `SameSite=Strict`, HttpOnly, host-bound to 127.0.0.1 and
  HMAC-tagged with its origin; every control POST must carry the
  `X-Olympus-CSRF` token and pass the `Origin` check; `/dashboard/launch`
  sends `frame-ancestors 'none'`. A rebinding host name gets no cookie. A
  link opens the dashboard in the user's own browser on 127.0.0.1 and hands
  the website nothing back.
- **Nothing from the caller's folder is read.** See the `--no-env-file` and
  fixed-folder note above; `test/open-on-computer.test.ts` launches the
  desktop entry from a folder holding a hostile `.env` and `bunfig.toml`
  preload and checks neither is read (and that, without the fix, both are).

Known residuals:

- A hostile page can repeatedly prompt "Open Olympus?" and, if accepted,
  open dashboard tabs (outstanding tickets are capped at 32, oldest
  evicted). The open dashboard is the same one `olympus dashboard` opens;
  the user is the one who acts in it.
- The ticket URL is visible in the arguments of the short-lived `open` /
  `xdg-open` process. Another local user on a shared computer could read it
  from `ps` or `/proc` and race the browser to redeem it (redeem checks the
  `Origin` header, which a non-browser client can set). This predates
  option C (`olympus dashboard` does the same); option C lets a website
  start it, behind the browser prompt. The window is short and needs a
  hostile local account. Removing it means handing the ticket over a
  loopback POST instead of the command line.
- After opening a source row that has no Connect panel, focus lands on the
  row's first button or link (today the source's name link). If row markup
  changes, a keystroke right after the tab opens could land on a control;
  focusing the row itself would remove that dependence.

## Signing

The applet is built on the user's Mac, so it carries no quarantine
attribute and Gatekeeper does not assess it; an ad-hoc signature is enough
for LaunchServices. Shipping a prebuilt handler app instead would need a
Developer ID signature and notarization.
