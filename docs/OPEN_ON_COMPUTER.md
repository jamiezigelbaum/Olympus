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
3. `olympus open` reads the link against a closed list
   (`src/core/open-targets.ts`): `dashboard`, `connect/{x,readwise,telegram,whatsapp}`,
   `fix/{connect,reconnect,answers,search,models}`. Any other `olympus:` link
   opens the plain dashboard; anything else opens nothing. It then does
   exactly what `olympus dashboard` does: asks this install's own worker for a
   single-use 15-minute ticket and opens `/dashboard/launch#…` in the default
   browser, adding `olympus_open=<token>` for a target.
4. The opening page redeems the ticket for the usual control session, checks
   the token against the same list, and lands on `/dashboard?setup#olympus-open=<token>`.
   The dashboard controller opens that source's Connect panel (or Models)
   and focuses it. It submits nothing.

## Threat model

Any website can fire an `olympus://` link; the browser asks the user first,
but a user may click through. So:

- **A link changes nothing.** The only effects are minting an in-memory,
  single-use ticket and opening a local page; the page opens a panel, never
  submits a form (not even a publisher panel's one-click sign-in, which
  starts only on a real click). No setting, source, key or sign-in changes
  without the user acting in the dashboard.
- **Nothing in a link is passed through.** The handler matches exact
  strings from a closed list; the applet hands the link to the shell only as
  AppleScript's `quoted form of`, and the desktop entry passes it as `%u`.
  Unknown, malformed or hostile links open the plain dashboard or nothing.
- **Another site cannot drive the unlocked dashboard.** The ticket travels
  only in a fragment the opening page clears before any request; the control
  session is the existing HttpOnly, `SameSite=Strict`, origin-bound cookie
  with a CSRF token every control POST must carry, and control routes check
  `Origin`. A link opens the dashboard in the user's own browser on
  127.0.0.1; it hands the website nothing back.
- **Residual:** a hostile page can repeatedly prompt "Open Olympus?" and,
  if accepted, open dashboard tabs (outstanding tickets are capped at 32).
  The open dashboard is the same one `olympus dashboard` opens; the user is
  the one who acts in it.

## Signing

The applet is built on the user's Mac, so it carries no quarantine
attribute and Gatekeeper does not assess it; an ad-hoc signature is enough
for LaunchServices. Shipping a prebuilt handler app instead would need a
Developer ID signature and notarization.
