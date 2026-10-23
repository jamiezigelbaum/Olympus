# Import an archive

Status: plan, owner direction 2026-10-23. Nothing is built yet. Where this page
and the code differ, the code is current.

## Outcome

A new user can point Olympus at an old export (a mail export, a WhatsApp or
Telegram chat export, a Reflect or Roam export) and search it like any other
source. There
is one way to do it: **Import an archive** in the dashboard. Agents call the
same operation, so "have your AI do it" and "click the button" import the
same way, with the same privacy and the same status.

## Owner decisions (2026-10-23)

- **One entry point.** One "Import an archive" action, not a row per format.
- **Olympus detects the format.** The user picks a file or folder; they never
  say "this is Roam".
- **Mail archives first** (mbox), because old mail is the largest gap and no
  importer exists.
- **Reflect and Roam move onto the public product.** Their connectors exist
  but are on the public-surface allowlist as leftovers.
- **Reviewed** by Astra (Codex, high) on 2026-10-23. Its five findings are
  folded in: per-archive identity and removal, bounded streaming reads,
  file-version-bound cursors, collision-safe mail identity, and the
  Reflect/Roam privacy-default conflict. A second round added WhatsApp
  message identity, bounded parsing of chat exports and zips, and the
  snapshot-beside-live acceptance cases. A third round, with Codex's PR review, made
  tiers follow the shared classifier, moved Reflect and Roam to streaming
  reads, bound resume to every file read, and required user approval for
  agent-started imports.
- **WhatsApp and Telegram exports are in scope** (owner, 2026-10-23), after
  mail.
- **Imported archives stay Private until the private model judges them**
  (owner, 2026-10-23): the local model, or Venice Private where there is no
  local model, as for every source. Personal-first does not apply to them: it assumed a
  wait of minutes, and an import puts years of items in the queue at once.

## Where things stand

| Format | Today |
|---|---|
| Mail (mbox) | Nothing. Gmail items come from the Gmail API's JSON, not raw messages, so there is no MIME parser to reuse. |
| WhatsApp chat export | Parser and connector exist (`workers/whatsapp/connector.ts`, `parseWhatsAppChatExport`) and are tested, but nothing in the product calls them. Live WhatsApp capture is wired separately. |
| Telegram Desktop export | Nothing. Telegram in the product is live capture only (`telegram-messages/capture-spool-connector.ts`). |
| Reflect export | Connector exists (`workers/reflect/connector.ts`), unwired, allowlisted. |
| Roam export | Connector exists (`workers/roam/connector.ts`), unwired, allowlisted. |

`source-family.ts` already models this: ingest mode `archive_import`,
credential kind `archive_path`, custodian `archive_importer`. Reflect and Roam
are declared there as `planned`.

## Shape

An archive is a source with no account and no live updates. Each imported
archive is a snapshot: "Imported 23 Oct 2026, mail from 2004 to 2019".

| Piece | What it is |
|---|---|
| Format registry | One registry of archive formats (`core/archive-formats.ts`, pure data like `core/file-scope-sources.ts`). Each entry: format id, label, a `detect(path)` probe, the source family, and a connector factory. Adding a format adds one entry and one thin connector. Nothing downstream branches on format. |
| Detection | Cheap probes on names and the first bytes, never a full parse: an mbox starts with a `From ` line; Apple Mail's export is a `Name.mbox` folder holding an `mbox` file; WhatsApp is `_chat.txt` or a zip holding one; Telegram Desktop is `result.json` with its export keys; Reflect and Roam by their JSON shape (the connectors already parse liberally). No match: say so and list what is supported. Two matches: ask. |
| Connectors | Thin `SourceConnector`s (contracts.ts), one per format. Pages honour the `done` / `truncated` rule in contracts.ts. |
| Archive identity | Each import gets a persistent archive id at start, used as the connector instance id and `accountScope`. Checkpoints key on it, so two imports of the same format never share a resume position. Today Reflect uses one constant connector id (`reflect/connector.ts:87`) and the store keys resume on it (`connector-store/local-index.ts:11083`); that changes when Reflect moves onto the registry. |
| Cursor | Position in the archive, bound to the identity (device, inode, size, mtime) of every file the import reads, not only the chosen path. For a folder (Apple Mail's `.mbox`, a folder of WhatsApp exports) that means a manifest of its files, and for a zip its members. A large import resumes after a restart; if any file in an unfinished archive changed or went missing, the import stops and says so instead of resuming against different bytes. |
| Picker | The local-files picker (`workers/local-files/scope-browser.ts`), extended to offer files as well as folders in a "choose one file or folder" mode (today it lists folders only, `scope-browser.ts:121`). |
| Reading | Only the chosen path, through the scope-safe reader (`core/scope-safe-fs.ts`), so no symlink escape. `ScopeRoot.readFile` loads a whole file, so archive reading adds a bounded streaming read on `openRelative`, with a per-message size cap. |
| Storage | Items go into the shared connector store and pipeline unchanged: extraction, per-item tiers from privacy settings plus the judge, index, search, Analyst. No archive-specific code after the connector. Importers set no source-level floor; each item gets its own tier. Until the private model judges an item, its content is held Private (below). |
| Removal | Per archive, not per source. Lifecycle delete today removes a whole source's store (`data-lifecycle.ts:657`) and Reflect has one store for the whole family (`data-lifecycle.ts:404`), so removing one import that way would erase the others. Remove cancels and fences that archive's running work, deletes its items, chunks, vectors and derived data (including private answers built from it, `data-lifecycle.ts:691`), and never touches the user's file. |
| Operation | One operation, `archive_import` (start, status, remove), on the public tool lists, CLI, and MCP. The dashboard calls the same operation. An agent cannot import a path just by naming it: start needs a path the user approved, through the dashboard picker or a confirmation the user answers, the same approval the scope picker gives other sources. A prompt-injected or accidental tool call can at most ask. |
| Dashboard | An "Archives" source showing each import: format, file name, item count, date range, progress, gaps (unreadable messages, skipped attachments), and Remove. Every problem has a route to exactly what failed. |

### Mail (mbox), first

- **Formats covered:** Google Takeout (`.mbox` file), Apple Mail "Export
  Mailbox" (`.mbox` folder), Thunderbird (mbox files, often no extension). They
  share one connector. Maildir and `.eml` folders come later on the same entry.
- **Parsing:** stream the file, split on `From ` lines (handling the
  `>From` quoting variants), and parse each message with a proven MIME library
  rather than our own. Candidate: `postal-mime` (no dependencies, runs in Bun).
  Check its licence and size before adding it.
- **Items:** one `RawItem` per message, `family: 'email'`, `mimeType:
  'message/rfc822'`, metadata shaped like Gmail's (subject, from, to, date,
  thread) so answers treat imported and live mail alike. Gmail labels from
  `X-Gmail-Labels` are kept as labels.
- **Identity:** `Message-ID` plus a hash of the whole message, so two
  different messages that share headers never merge. Re-importing the same
  export is detected by the file's identity and offered as "already imported",
  rather than relying on message ids: store identity includes `accountScope`
  (`connector-store/local-index.ts:13447`), so a second import under a new
  archive id would otherwise duplicate everything.
- **Attachments:** named on the message, bytes not read in the first version,
  shown as an honest gap (the same posture as Gmail today). Reading them
  through the shared extraction machinery is a follow-up.
- **Size:** exports can be tens of GB. Streaming with a byte-offset cursor;
  never load the file.

### Reflect and Roam, promoted

Register both in the format registry, wire them into the scheduler and public
source ids, and remove their five entries from
`config/public-surface-allowlist.json`. Re-check both connectors against a
current export from each app first; they were written before the shared
tier classifier and may need their classification signals updated.

Their privacy defaults disagree today: the family postures say `internal`/S3
(`source-family.ts:241`, Personal), the connectors default to `secure_local`
(`reflect/connector.ts:53`, `roam/connector.ts:62`, Private). Keeping
`secure_local` would leave ordinary notes Private for good, because the
classifier does not judge content already at that tier
(`tier-classifier.ts:858`). The connectors' default becomes `internal`, so
notes are judged per item like every other source instead of resting at
Private.

## Privacy while an import is judged

Every item from an imported archive is held Private until the private model
(the local model, or Venice Private where the preset has no local one) judges
it, then moves to its judged tier. Nothing from an import is Personal, and so
nothing reaches a cloud model or cloud embedding, before its own judgment.
Ordinary cloud models never judge.

- **Shared, not per format.** The import spine marks every item it ingests
  with its ingest mode (`archive_import`, already declared in
  `source-family.ts`). The shared classifier reads that mark: for these
  items, content without a verdict is held as for own-record items today,
  and `content:personal_first` is never set (`tier-classifier.ts:873`,
  `tiered-store-set.ts:409`). No connector or format branches on it.
- **Names** follow the existing rule: cleared names stay Personal while the
  content is held (Gmail and Drive already work this way).
- **Secrets, structured identifiers, owner rules and source floors** keep
  their precedence. An owner override of an item still wins.
- **Queue order.** Held import items join the judging queue behind live
  own-record items, so a large import does not delay judgments for new mail.
  The dashboard shows each archive's judged and still-held counts, so a
  partly judged import is visible rather than silently incomplete.
- **No model ready.** Items stay held until one is; the dashboard says the
  import is waiting for the private model, with a route to set it up.
- **Gate.** This changes classification semantics, so it follows the
  versioned change gate in `docs/ENGINEERING_PROCESS.md`: a new classifier
  version, a `CONTRACTS.md` change-log entry, the held-out eval and an
  independent review. It lands in step 1, before any archive format is
  public.

Both connectors also load a whole export at once (`reflect/connector.ts:139`,
`roam/connector.ts:69`), so a large export could run the engine out of
memory. They change to read incrementally before either is public: a
streaming JSON parser (a proven library, not our own) for a single export
file, one zip member at a time with streaming inflate, and only the current
page of notes held in memory. No size limit: any export a person has must
import.

### WhatsApp and Telegram exports

Both are in scope. They come after mail because they reuse the same spine
(identity, resume, removal), not because they are optional.

- **WhatsApp chat export** (`_chat.txt`, or the zip WhatsApp shares). The
  existing parser (`parseWhatsAppChatExport`) is reused, but the connector
  cannot join as is: it reads every `.txt` and `.zip` in a folder
  (`whatsapp/connector.ts:321`), so pointing it at one chat's parent folder
  would import neighbouring chats, and its plain reads bypass the scope-safe
  reader. It changes to read exactly the selected files through the
  scope-safe reader. Picking a folder of exports imports each chat in it, as
  the user chose.
- **WhatsApp message identity.** Today an id hashes chat, time, sender and
  position only (`whatsapp/connector.ts:298`), so a `.txt` and a `.zip`
  export of the same chat in one folder can overwrite messages whose text
  differs. Ids gain the source file (or zip member) identity and a hash of
  the message text. Test with an overlapping-export fixture.
- **Bounded parsing.** The parser splits the whole text and keeps every
  message (`whatsapp/connector.ts:155`), and zip entries are inflated whole
  (`whatsapp/connector.ts:397`). Both become incremental: line-by-line
  parsing, streaming inflate, with limits on expanded bytes and zip members.
  Hitting a limit fails visibly, naming the file. The same rule applies to
  Telegram's `result.json` (streaming JSON) and to any zip a format accepts.
- **Telegram Desktop export** ("Export chat history", JSON format,
  `result.json` plus media folders). A new thin connector: one item per
  message, chats as threads, media named as gaps at first, like mail
  attachments.
- Both import as snapshots alongside any live capture of the same account.
  The dashboard keeps "imported archive" and "live capture" apart, as the
  release plan requires. Overlap between an export and live capture is the
  same open question as Takeout mail versus live Gmail.

## Order

1. Mail (mbox) as the first format, with the spine it needs: format
   registry, detection, archive identity and checkpoints, per-archive
   removal, `archive_import` operation, Archives source in the dashboard,
   the streaming reader and the file-selecting picker. The
   hold-until-judged rule lands here too, through its classifier gate.
2. Reflect and Roam onto the registry, with streaming reads and the
   `internal` default; all their allowlist entries removed.
3. WhatsApp chat export, with the selected-file, scope-safe reads.
4. Telegram Desktop export.

Each step is one PR with focused tests on synthetic fixtures (never real
exports), plus the held-out eval where the step changes the source pipeline.

## Open questions

- **Imported mail that overlaps live Gmail.** A Takeout export of the same
  account duplicates mail that live Gmail already indexed. Matching on
  `Message-ID` across sources is a spine question; the first version may
  accept duplicates and show both.
- **Copy or reference.** The first version reads the file in place. If the
  user moves or deletes it, the import is already finished and stays; a
  re-import needs the file again.

## Done when

A fresh install on Mac and on Linux can import a synthetic mbox, Reflect,
Roam, WhatsApp and Telegram export through the dashboard and through the agent tool, see each as a
snapshot with counts and gaps, find cited answers from it, and remove it.
No imported item's content is in a Personal store, or embedded by a cloud
model, before the private model judges it; cleared names may be, as above. A test
imports with the private model stopped and checks this.

For WhatsApp and Telegram, also on the same candidate as a supported live
connection (`V0_4_RELEASE.md`, "Qualification action"): the dashboard shows
the connected scope and the history the export covers, tells stale live
capture apart from a successful empty import, and removing the archive leaves
live capture running and its items in place.
