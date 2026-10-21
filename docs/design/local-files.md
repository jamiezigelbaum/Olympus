# Local files

Status: planned (owner direction 2026-10-21). Not built. Where this page and
the code differ, the code is current.

## Outcome

Olympus users can index and search the files on their own computer (Mac
Finder, and the Linux home on Omarchy) exactly as they do Dropbox and Google
Drive: one Connect click, pick folders in the same folder picker, and changes
show up in search within seconds.

No local files source has existed before. `local_filesystem` is declared as a
credential kind in `src/core/source-family.ts` and nothing uses it. The
"Finder" in the dashboard is the Finder-styled folder picker that Dropbox and
Drive share.

## Owner decisions (2026-10-21)

- **Thin connector on the shared spine.** The connector only lists, reads,
  watches and opens files. Extraction, tiers, index, search and answers are
  the existing shared pipeline. Generic gaps are fixed in the spine, never
  worked around in the connector.
- **Instant updates from the start.** File-change notifications, not polling.
- **No sign-in.** Connect, then pick folders. This is the first source with
  no account.
- **Nothing selected by default**, the same as Dropbox and Drive.
- **Some folders off by default** (list below).
- **Privacy is the same as every source.** Each file is tiered from the
  user's privacy settings plus the judge; no source-level tier.
- **Mac and Linux (Omarchy).** WSL follows `windows-wsl.md` W-5 (rescans on
  `/mnt/c`).

## Shape

| Piece | What it is |
|---|---|
| Connector `local.files` | Factory `createLocalFilesSourceConnector(): SourceConnector` (contracts.ts). Lists files under the selected folders, cursor = watcher snapshot. `classificationSignals` gives path and folder keys only. |
| Bytes | A `FileExtractionSource` that reads from disk. Shares the local-path reading in `dropbox-files/local-file-resolver.ts`, lifted to a shared helper. |
| Folder picker | A `SourceFolderScopeBrowser` over the filesystem, rooted at the home folder, with mounted volumes listed under Locations. |
| Open | Reveal in Finder / the Linux file manager. Reuses `localOpenArguments` from `dropbox-files/open-target.ts`, lifted to shared. |
| Watcher | `@parcel/watcher` (the watcher VS Code uses): FSEvents on Mac, inotify on Linux. |

### Spine work (generic, lands first)

1. **Scope-source registry.** The picker is hard-wired to two sources:
   `OlympusFolderScopeSourceId` (`control-ui-contract.ts`),
   `FILE_SOURCE_SCOPE_IDS` / `FILE_SOURCE_SCOPE_CAPABILITIES`
   (`core/source-scope-approval.ts`) and the Dropbox/Drive ternary in the
   browse route (`email-source/server.ts`). These become one registry that
   sources add themselves to. Dropbox and Drive move onto it unchanged.
2. **Sources without an account.** Scope approval and browse need a
   credential handle and an `accountGeneration`. Add a "this computer"
   basis: a stable per-install machine id, so a reinstall or a different
   computer resets the selection fail-closed, as a changed account does today.
3. **Push wake for the scheduler.** `SourceScheduler` only polls. Add a
   generic way for a source to wake its own sync task when changes arrive,
   with the poll interval kept as the backstop. Any future watched source
   (Apple Notes, Obsidian) uses the same path.

### Instant updates

- Live changes come from `watcher.subscribe`. Catching up after a restart or
  sleep uses `writeSnapshot` / `getEventsSince`. On Mac that replays the
  FSEvents history, so there's no full rescan. On Linux it diffs a snapshot.
- Spike 2026-10-21 (Bun 1.3.14, macOS 26.5): live create events for nested
  files, and a file written while unsubscribed was returned by
  `getEventsSince`.
- Linux: inotify needs a watch per directory. Check `max_user_watches` at
  connect. If the limit is hit, say so in the dashboard (every problem
  findable) and fall back to periodic rescans for that folder.
- Packaging risk: the watcher is a native addon with prebuilt per-platform
  packages. Bun blocks its postinstall by default. The release artifact must
  carry the Mac arm64/x64 and Linux x64/arm64 binaries; prove this on a fresh
  install before relying on it.

### Off by default

The user can turn any of these back on in the picker:

- `~/Library`, caches, `.Trash`
- `.git`, `node_modules`, build output
- app bundles
- The local Dropbox folder, and Google Drive for desktop
  (`~/Library/CloudStorage`). These are already indexed through their own
  sources, so this avoids duplicates.

### iCloud Drive

Files kept only in iCloud are placeholders on disk (dataless). Reading one
starts a download. Index their names only, and read content only for files
already on the Mac. Never trigger downloads in bulk.

## Mac permissions

macOS (TCC) guards Desktop, Documents, Downloads, iCloud Drive and removable
or network volumes. Everything else in the home folder (for example `~/Code`)
needs no permission.

Facts:

- **Who macOS asks about.** It attributes access to the *responsible* app.
  The engine is a LaunchAgent running
  `/opt/homebrew/Cellar/bun/<version>/bin/bun`, so today any prompt would say
  "bun". If a prompt can't be shown, the read just fails. Apple's guidance
  for agents is to make the app the responsible code: install with
  `SMAppService`, or set `AssociatedBundleIdentifiers` in the launchd plist.
- **Bun is Developer ID signed** (Jarred Sumner, team 7FRXF46ZSN), so a grant
  to bun would survive bun upgrades. Even so, it would cover every bun script
  on the Mac, the Homebrew path changes with each version, and it shows up as
  "bun". Rejected.
- **The existing `Olympus.app`** (`ai.olympusplugin.open`, the `olympus://`
  handler) is ad-hoc signed. Ad-hoc grants are pinned to the exact build hash
  and lost on every rebuild, while System Settings still shows them as on.
  It can't hold the grant as it is.
- **Full Disk Access is tightening.** Apple's 2026-10-02 notice ("Updates to
  Full Disk Access in macOS") says granting it will require "very explicit
  user action", because of AI agents. No date or version is given. Apps can't
  prompt for Full Disk Access. The user adds the app in System Settings.
- **What others do.** Backblaze, Arq, Carbon Copy Cloner and Disk Drill ship
  Developer ID signed apps. They deep-link to the Full Disk Access pane and
  let the user drag the app icon in from their setup screen.

### Recommendation

1. **A small signed Olympus helper app is the engine's responsible process.**
   - It's the LaunchAgent's program, and starts bun as its child.
   - It's signed with a Developer ID and notarized, so grants survive Olympus
     updates.
   - The tiny native launcher is the only signed part; the plugin stays as it
     is.
2. **Ask per folder, not for the whole disk.**
   - When the user ticks Desktop, Documents, Downloads or iCloud Drive in the
     picker, the engine touches that folder, and macOS shows "Olympus would
     like to access files in your Documents folder". That's one click and no
     trip to System Settings.
   - This is narrower than Full Disk Access and fits where Apple is heading.
3. **Full Disk Access only if the user picks the whole disk or a volume.**
   Deep-link to the pane and offer the helper icon to drag in.
4. **The picker shows a guarded folder as "Needs permission"**, with the
   button that asks. A denied folder says how to turn it back on. It's never
   silently empty.

Signing needs the Apple Developer organization account. This is the case the
2026-10-11 signing ruling named for revisiting it ("a signed Mac app").
**Owner decision required.** Until then, unguarded folders work on Mac, and
everything works on Linux.

### Spike before building the helper

1. Signed helper → bun child: does the Documents prompt name Olympus? Does
   the grant survive an Olympus update and a bun upgrade?
2. Do FSEvents deliver events inside a guarded folder before and after the
   grant?
3. A stale Full Disk Access entry is not copied when the bundle changes:
   confirm that removing and re-adding it recovers.

## Delivery sequence

1. **Spine PR:** the scope registry, the "this computer" basis, and push
   wake. Dropbox and Drive behaviour is unchanged (existing tests plus picker
   renders).
2. **Connector PR:** `local.files`, the watcher, the picker, open, and the
   off-by-default list. Unguarded folders on Mac, all folders on Linux.
3. **Helper PR (after signing):** the signed helper, per-folder prompts, the
   Full Disk Access path and the "Needs permission" states.
4. **Copy:** the site, ChatGPT listing and setup order (local files first, per
   `chatgpt-plugin.md`). These come in the legal pass, against final code. The
   reviewer path stays pinned.

## Done when

- The held-out eval passes with local files included.
- On a real Mac and on the Omarchy laptop: connect without signing in, pick
  folders, search finds the content, and an edit or new file is searchable
  within seconds, including after a restart.
- The picker behaves like Dropbox and Drive: nothing selected at first, and
  the same three choices.
- Architecture, public-surface and source-agnostic guards pass with no new
  allowlist entries.
